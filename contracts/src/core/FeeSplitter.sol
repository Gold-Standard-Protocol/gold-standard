// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.38;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";

interface ISplitterSurplusBuffer {
    function depositFee(uint256 amount) external;
    function depositCollateral(address token, uint256 amount) external;
    function absorbBadDebt(uint256 amount) external;
    function gsusdBalance() external view returns (uint256);
    function effectiveMinGsusdReserve() external view returns (uint256);
    function absorptionBurns() external view returns (bool);
}

/// @title FeeSplitter
/// @notice Sits between the fee payers (GoldVault and GoldStabilityReserve) and the SurplusBuffer.
///         Tops the buffer up to its floor before routing a capped share of
///         surplus fee revenue to a beneficiary. The share defaults to zero, so by default
///         every deposit flows through to the buffer unchanged (the fee switch is OFF).
/// @dev Per docs/TOKEN_POLICY.md section 4 this contract is pre-built but NOT
///      deployed by deploy.ts; deployment happens only after the TGE gate fires.
///
///      Activation runbook (executed by governance, not by deploy.ts):
///      1. Deploy FeeSplitter(gsusd, surplusBuffer)
///      2. surplusBuffer.grantRole(VAULT_ROLE, splitter) so the buffer can pull forwarded fees
///      3. splitter.grantRole(VAULT_ROLE, vault) and splitter.grantRole(VAULT_ROLE, reserve)
///      4. Via the timelock: vault.setSurplusBuffer(splitter) and reserve.setSurplusBuffer(splitter)
///      5. splitter.transferGovernance(timelock)
///      The beneficiary share stays at zero until a separate governance proposal raises it.
///
///      Design notes:
///      - The buffer is immutable: GoldVault and GoldStabilityReserve can already repoint past the
///        splitter via setSurplusBuffer, so a settable buffer adds risk without benefit. A
///        buffer redeploy means a splitter redeploy.
///      - The floor is the higher of bufferFloor and the buffer's own effective reserve floor
///        (its automatic 2% of supply), so the fee switch can only ever pay revenue above
///        the floor the buffer itself enforces (TOKEN_POLICY.md section 4).
///      - The floor is compared with buffer.gsusdBalance() (the buffer's accounted state), not
///        the raw token balance, so direct GSUSD donations to the buffer do not count toward it.
///      - There is no rescue or sweep function; tokens sent directly to this contract are
///        stranded by design (mirrors SurplusBuffer). The splitter should hold a zero balance
///        between transactions.
///      - Fee-on-transfer collateral pays the transfer fee twice (payer to splitter, then
///        splitter to buffer); accounting stays exact because both contracts credit measured
///        receipts, but the second hop is a small revenue leak.
contract FeeSplitter is AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant GOVERNANCE_ROLE = keccak256("GOVERNANCE_ROLE");
    bytes32 public constant VAULT_ROLE = keccak256("VAULT_ROLE");

    uint256 public constant BPS = 10000;

    /// @notice Hard cap on the beneficiary share (50%) so even governance cannot route the
    ///         majority of fee revenue away from the buffer.
    uint256 public constant MAX_BENEFICIARY_SHARE_BPS = 5000;

    /// @notice The GSUSD token address
    address public immutable gsusd;

    /// @notice The real SurplusBuffer that fees, collateral and bad debt pass through to
    ISplitterSurplusBuffer public immutable buffer;

    /// @notice Optional governed GSUSD floor (18 decimals) the real buffer must hold before any
    ///         split occurs, on top of the buffer's own automatic floor.
    /// @dev The shortfall below effectiveBufferFloor() is topped up from each deposit before
    ///      the beneficiary share applies. Zero leaves the buffer's automatic floor in force.
    uint256 public bufferFloor;

    /// @notice Share of surplus fee revenue routed to the beneficiary, in basis points.
    /// @dev Defaults to zero (the off switch): everything goes to the buffer.
    uint256 public beneficiaryShareBps;

    /// @notice Recipient of the beneficiary share of surplus fee revenue
    address public beneficiary;

    /// @notice Total GSUSD ever paid out to the beneficiary (transparency counter)
    uint256 public totalPaidToBeneficiary;

    /// @notice GSUSD earned by the beneficiary and not yet claimed.
    uint256 public beneficiaryAccrued;

    /// @notice Fee revenue received per direct caller (the vault, the reserve). Behind this
    ///         splitter the SurplusBuffer sees only the splitter as the source of every fee,
    ///         so per-source attribution lives here and in FeeSplit.
    mapping(address => uint256) public totalFeesReceivedFrom;

    event FeeSplit(address indexed source, uint256 toBuffer, uint256 toBeneficiary);
    event CollateralForwarded(address indexed token, uint256 amount);
    event BadDebtPassedThrough(uint256 requested, uint256 absorbed);
    event BufferFloorUpdated(uint256 newFloor);
    event BeneficiaryShareUpdated(uint256 newShareBps);
    event BeneficiaryUpdated(address newBeneficiary);
    event BeneficiaryClaimed(address indexed beneficiary, uint256 amount);

    constructor(address _gsusd, address _buffer) {
        require(_gsusd != address(0), "Zero address");
        require(_buffer != address(0), "Zero address");
        // Wiring probe: reverts unless the buffer exposes gsusdBalance(), the same probe
        // GoldStabilityReserve.setSurplusBuffer performs against this contract when it is
        // wired, and the automatic reserve floor this contract defers to.
        // Deliberate interface probe: the revert is the signal.
        // slither-disable-next-line unused-return
        ISplitterSurplusBuffer(_buffer).gsusdBalance();
        // slither-disable-next-line unused-return
        ISplitterSurplusBuffer(_buffer).effectiveMinGsusdReserve();
        gsusd = _gsusd;
        buffer = ISplitterSurplusBuffer(_buffer);
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(GOVERNANCE_ROLE, msg.sender);
    }

    /// @notice Pull GSUSD fee revenue from the caller, top the buffer up to its floor, then
    ///         split any surplus between the buffer and the beneficiary.
    /// @dev Callers forceApprove this contract then call depositFee (the SurplusBuffer pull
    ///      pattern); this contract in turn forceApproves the real buffer and forwards, so it
    ///      must hold VAULT_ROLE on the real buffer. The beneficiary transfer is the last
    ///      external call because the beneficiary may be a contract. Floor division on the
    ///      beneficiary share means rounding always favours the buffer.
    function depositFee(uint256 amount) external nonReentrant onlyRole(VAULT_ROLE) {
        IERC20(gsusd).safeTransferFrom(msg.sender, address(this), amount);
        totalFeesReceivedFrom[msg.sender] += amount;
        uint256 toBeneficiary = 0;
        if (beneficiaryShareBps > 0 && beneficiary != address(0)) {
            // The floor reads the buffer's accounted state, live, on every call
            uint256 bufBal = buffer.gsusdBalance();
            uint256 floor = effectiveBufferFloor();
            uint256 surplus;
            if (bufBal >= floor) {
                // Floor already met: the whole deposit is surplus
                surplus = amount;
            } else {
                // Buffer floor first: top up the shortfall before any split
                uint256 shortfall = floor - bufBal;
                surplus = amount > shortfall ? amount - shortfall : 0;
            }
            toBeneficiary = (surplus * beneficiaryShareBps) / BPS;
        }
        uint256 toBuffer = amount - toBeneficiary;
        if (toBuffer > 0) {
            IERC20(gsusd).forceApprove(address(buffer), toBuffer);
            buffer.depositFee(toBuffer);
        }
        if (toBeneficiary > 0) {
            // PULL, never push. This runs inline inside GoldVault.repay and all three
            // liquidation paths, and on the spread of every reserve swap. A beneficiary that
            // reverts on receipt (a proxy pointing at nothing is enough) would otherwise brick
            // repayment and liquidation together; the reserve catches the revert and keeps
            // its spread as inventory. Accrue and let them claim.
            beneficiaryAccrued += toBeneficiary;
        }
        emit FeeSplit(msg.sender, toBuffer, toBeneficiary);
    }

    /// @notice Forward collateral (from liquidation penalties) straight to the buffer.
    /// @dev Pure passthrough with NO split: the floor is GSUSD-denominated and splitting
    ///      volatile collateral is not what TOKEN_POLICY.md section 4 authorises.
    ///      Fee-on-transfer safety: forwards the actual amount received, not the requested
    ///      amount; the buffer then credits its own measured receipt.
    function depositCollateral(address token, uint256 amount) external nonReentrant onlyRole(VAULT_ROLE) {
        uint256 balBefore = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = IERC20(token).balanceOf(address(this)) - balBefore;
        IERC20(token).forceApprove(address(buffer), received);
        buffer.depositCollateral(token, received);
        emit CollateralForwarded(token, received);
    }

    /// @notice Whether absorptions passed through here are burned: the buffer behind this
    ///         splitter answers, so GoldVault's wiring check sees through the splitter.
    function absorptionBurns() external view returns (bool) {
        return buffer.absorptionBurns();
    }

    /// @notice Pass a bad debt absorption request through to the buffer.
    /// @dev The buffer burns the GSUSD it absorbs and pays its caller nothing, so there
    ///      is nothing to forward: GoldVault books the absorption from the fall in GSUSD
    ///      supply. BadDebtPassedThrough reports that same fall, measured around the call.
    ///      Partial absorption (buffer balance below the requested amount) flows through
    ///      correctly because the buffer caps internally.
    // Trusted-callee reentrancy: the buffer is immutable and governance-chosen, and this
    // entry point is nonReentrant. The supply delta is only reported.
    function absorbBadDebt(uint256 amount) external nonReentrant onlyRole(VAULT_ROLE) {
        uint256 supplyBefore = IERC20(gsusd).totalSupply();
        buffer.absorbBadDebt(amount);
        uint256 supplyAfter = IERC20(gsusd).totalSupply();
        emit BadDebtPassedThrough(amount, supplyBefore > supplyAfter ? supplyBefore - supplyAfter : 0);
    }

    /// @notice The real buffer's accounted GSUSD balance.
    /// @dev Satisfies the GoldStabilityReserve.setSurplusBuffer wiring probe and keeps
    ///      monitoring meaningful when this contract is installed in front of the buffer.
    function gsusdBalance() external view returns (uint256) {
        return buffer.gsusdBalance();
    }

    /// @notice The GSUSD balance the buffer must hold before any split: the higher of
    ///         bufferFloor and the buffer's own effective reserve floor.
    function effectiveBufferFloor() public view returns (uint256) {
        return Math.max(bufferFloor, buffer.effectiveMinGsusdReserve());
    }

    /// @notice Set the optional governed GSUSD floor the buffer must hold before any split.
    /// @dev No upper bound: governance judgement, mirroring SurplusBuffer.setMinGsusdReserve.
    function setBufferFloor(uint256 newFloor) external onlyRole(GOVERNANCE_ROLE) {
        bufferFloor = newFloor;
        emit BufferFloorUpdated(newFloor);
    }

    /// @notice Set the beneficiary share of surplus fee revenue, in basis points.
    /// @dev Hard-capped at MAX_BENEFICIARY_SHARE_BPS (50%). A non-zero share requires the
    ///      beneficiary to be set, so an active split can never pay address(0).
    function setBeneficiaryShare(uint256 newShareBps) external onlyRole(GOVERNANCE_ROLE) {
        require(newShareBps <= MAX_BENEFICIARY_SHARE_BPS, "Share exceeds cap");
        require(newShareBps == 0 || beneficiary != address(0), "Beneficiary not set");
        beneficiaryShareBps = newShareBps;
        emit BeneficiaryShareUpdated(newShareBps);
    }

    /// @notice Claim GSUSD accrued to the beneficiary.
    /// @dev Permissionless to call but always pays the recorded beneficiary, so a keeper
    ///      can settle it. Failure here can never affect a user action.
    function claimBeneficiary() external nonReentrant {
        uint256 amount = beneficiaryAccrued;
        require(amount > 0, "Nothing accrued");
        address to = beneficiary;
        require(to != address(0), "Beneficiary not set");
        beneficiaryAccrued = 0;
        totalPaidToBeneficiary += amount;
        IERC20(gsusd).safeTransfer(to, amount);
        emit BeneficiaryClaimed(to, amount);
    }

    /// @notice Set the beneficiary address, after paying the outgoing beneficiary whatever
    ///         it has accrued.
    /// @dev Zero is allowed only while the share is zero, so an active split can never pay
    ///      address(0).
    ///      The splitter itself is refused: a claim paid to itself would clear the accrual
    ///      and count a payment while the tokens stayed here.
    ///      Fees already earned belong to the beneficiary that earned them, so the change
    ///      settles them first, exactly as claimBeneficiary would (same counters, same
    ///      event), and cannot redirect them. Requiring a zero accrual instead made the
    ///      change impossible to schedule while fees were live: any fee-paying transaction
    ///      before execution made it revert, and batching a claim in front of it reverted
    ///      whenever somebody else claimed first. GSUSD has no transfer hook and no block
    ///      list, so the outgoing beneficiary cannot refuse the payment and hold up the
    ///      change. Accrual requires a beneficiary, so an amount owed always has a
    ///      non-zero recipient.
    function setBeneficiary(address newBeneficiary) external nonReentrant onlyRole(GOVERNANCE_ROLE) {
        require(newBeneficiary != address(0) || beneficiaryShareBps == 0, "Share active");
        require(newBeneficiary != address(this), "Self payment");
        uint256 owed = beneficiaryAccrued;
        address outgoing = beneficiary;
        beneficiary = newBeneficiary;
        emit BeneficiaryUpdated(newBeneficiary);
        if (owed > 0) {
            beneficiaryAccrued = 0;
            totalPaidToBeneficiary += owed;
            IERC20(gsusd).safeTransfer(outgoing, owed);
            emit BeneficiaryClaimed(outgoing, owed);
        }
    }

    /// @notice Transfer governance to timelock
    function transferGovernance(address timelockAddr) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(timelockAddr != address(0), "Zero address");
        require(timelockAddr != msg.sender, "Would self-revoke");
        // A handover is one-shot and irreversible; an EOA typo here is a dead protocol.
        require(timelockAddr.code.length > 0, "Timelock must be a contract");
        _grantRole(GOVERNANCE_ROLE, timelockAddr);
        _grantRole(DEFAULT_ADMIN_ROLE, timelockAddr);
        _revokeRole(GOVERNANCE_ROLE, msg.sender);
        _revokeRole(DEFAULT_ADMIN_ROLE, msg.sender);
    }
}
