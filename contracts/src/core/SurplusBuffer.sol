// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.38;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";
import "../interfaces/IGoldStablecoin.sol";

/// @title SurplusBuffer
/// @notice Accumulates protocol revenue from stability fees and liquidation penalties.
///         Serves as a first-loss reserve for bad debt, and surplus above the reserve floor
///         can be withdrawn by governance. The floor follows supply on chain by itself: at
///         least AUTO_FLOOR_BPS (2%) of outstanding GSUSD always stays (BUSINESS_MODEL.md
///         section 5), with minGsusdReserve as an optional higher governed minimum.
/// @dev Revenue sources:
///      1. Stability fees: the fee portion of repayments is transferred here instead of being burned
///      2. Liquidation penalties: protocol's share of liquidation collateral is stored here
///      The buffer holds GSUSD (from fees) and gold tokens (from liquidation penalties).
contract SurplusBuffer is AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant GOVERNANCE_ROLE = keccak256("GOVERNANCE_ROLE");
    bytes32 public constant VAULT_ROLE = keccak256("VAULT_ROLE");

    uint256 public constant BPS = 10_000;

    /// @notice The automatic reserve floor: 2% of outstanding GSUSD supply, in basis points.
    ///         A constant, so no governance action, routine or otherwise, can lower it.
    uint256 public constant AUTO_FLOOR_BPS = 200;

    /// @notice GSUSD balance held as bad-debt reserve
    uint256 public gsusdBalance;

    /// @notice Gold collateral balances held from liquidation penalties
    mapping(address => uint256) public collateralBalance;

    /// @notice The GSUSD token address
    address public immutable gsusd;

    /// @notice Total bad debt absorbed by the buffer
    uint256 public totalBadDebtAbsorbed;

    // --- Lifetime revenue accounting ---
    // gsusdBalance is a NET RESERVE: it falls on withdrawGsusd and absorbBadDebt. After the
    // first withdrawal or bad-debt event, lifetime revenue could not be reconstructed from
    // chain state at all. TOKEN_POLICY.md makes an annualised run-rate a hard TGE trigger,
    // and a gate that cannot be measured is a gate that never opens. These counters are
    // monotonic and never decremented.

    /// @notice Lifetime GSUSD fee revenue received, gross of anything later spent.
    uint256 public totalFeesReceived;

    /// @notice Lifetime GSUSD fee revenue per source. The vault and the GoldStabilityReserve
    ///         are distinct addresses that both hold VAULT_ROLE, so this separates the
    ///         stability-fee line from the stability-swap spread line for free. The source
    ///         is the direct caller: once a FeeSplitter sits in front of this buffer every
    ///         fee arrives from the splitter, and the per-source split is kept by the
    ///         splitter's own totalFeesReceivedFrom and FeeSplit event instead.
    mapping(address => uint256) public totalFeesReceivedFrom;

    /// @notice Lifetime collateral received per token (liquidation penalty share).
    mapping(address => uint256) public totalCollateralReceived;

    /// @notice Lifetime GSUSD withdrawn by governance. Revenue retained today is
    ///         totalFeesReceived - totalGsusdWithdrawn - totalBadDebtAbsorbed.
    uint256 public totalGsusdWithdrawn;

    /// @notice Optional governed minimum GSUSD balance that must remain post-withdraw.
    /// @dev Only binds when it is above the automatic floor; see effectiveMinGsusdReserve.
    ///      Zero (the launch value) leaves the automatic 2% floor alone in force. Raised or
    ///      lowered through the timelock; lowering it can never take the floor below 2%.
    uint256 public minGsusdReserve;

    /// @notice Per-token minimum collateral reserve required post-withdraw.
    mapping(address => uint256) public minCollateralReserve;

    /// @param source The depositing contract (vault vs stability reserve), so the two
    ///        revenue lines the business model reports separately can be told apart.
    /// @param cumulative Lifetime total after this deposit.
    event FeeDeposited(address indexed source, uint256 amount, uint256 cumulative);
    event CollateralDeposited(address indexed token, uint256 amount, uint256 cumulative);
    event BadDebtAbsorbed(uint256 amount);
    event GsusdWithdrawn(address indexed to, uint256 amount);
    event CollateralWithdrawn(address indexed token, address indexed to, uint256 amount);
    event MinGsusdReserveUpdated(uint256 newMin);
    event MinCollateralReserveUpdated(address indexed token, uint256 newMin);

    constructor(address _gsusd) {
        require(_gsusd != address(0), "Zero address");
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(GOVERNANCE_ROLE, msg.sender);
        gsusd = _gsusd;
    }

    /// @notice Deposit GSUSD fee revenue into the buffer
    /// @dev Called by GoldVault during repayments. The fee portion is sent here.
    function depositFee(uint256 amount) external nonReentrant onlyRole(VAULT_ROLE) {
        IERC20(gsusd).safeTransferFrom(msg.sender, address(this), amount);
        gsusdBalance += amount;
        totalFeesReceived += amount;
        totalFeesReceivedFrom[msg.sender] += amount;
        emit FeeDeposited(msg.sender, amount, totalFeesReceived);
    }

    /// @notice Deposit collateral (from liquidation penalties) into the buffer
    /// @dev Fee-on-transfer safety: credits actual amount received, not requested amount.
    function depositCollateral(address token, uint256 amount) external nonReentrant onlyRole(VAULT_ROLE) {
        uint256 balBefore = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = IERC20(token).balanceOf(address(this)) - balBefore;
        collateralBalance[token] += received;
        totalCollateralReceived[token] += received;
        emit CollateralDeposited(token, received, totalCollateralReceived[token]);
    }

    /// @notice True: this buffer burns what it absorbs and pays its caller nothing.
    ///         GoldVault refuses to wire a buffer that does not declare it, because an older
    ///         buffer that transferred absorptions to the vault would leave the GSUSD stranded
    ///         there and book nothing.
    function absorptionBurns() external pure returns (bool) {
        return true;
    }

    /// @notice Absorb bad debt by burning GSUSD from the buffer
    /// @dev Called when a vault has debt but zero collateral (bad debt event). Deliberately
    ///      not bound by the reserve floor: the whole balance is first-loss capital.
    ///      The buffer burns the GSUSD itself and pays the caller nothing: a transfer
    ///      to msg.sender let any VAULT_ROLE holder, one granted through the timelock
    ///      included, pull the whole balance past the automatic floor. Now a role holder can
    ///      at most destroy buffer GSUSD, never take it. GoldVault books the absorption
    ///      from the fall in GSUSD supply.
    function absorbBadDebt(uint256 amount) external nonReentrant onlyRole(VAULT_ROLE) {
        uint256 toAbsorb = amount > gsusdBalance ? gsusdBalance : amount;
        if (toAbsorb > 0) {
            gsusdBalance -= toAbsorb;
            totalBadDebtAbsorbed += toAbsorb;
            IGoldStablecoin(gsusd).burn(toAbsorb);
            emit BadDebtAbsorbed(toAbsorb);
        }
    }

    /// @notice Withdraw excess GSUSD surplus (revenue extraction by governance)
    /// @dev The buffer itself is refused as the recipient: a transfer to the sender moves no
    ///      tokens, so the counted balance would fall while the tokens stayed, uncounted for
    ///      good, and less would be left to absorb bad debt.
    /// @param to Recipient address
    /// @param amount Amount to withdraw
    function withdrawGsusd(address to, uint256 amount) external onlyRole(GOVERNANCE_ROLE) nonReentrant {
        require(to != address(0), "Zero address");
        require(to != address(this), "Self payment");
        require(amount <= gsusdBalance, "Exceeds balance");
        require(gsusdBalance - amount >= effectiveMinGsusdReserve(), "Would breach min GSUSD reserve");
        gsusdBalance -= amount;
        totalGsusdWithdrawn += amount;
        IERC20(gsusd).safeTransfer(to, amount);
        emit GsusdWithdrawn(to, amount);
    }

    /// @notice Withdraw collateral surplus (revenue extraction by governance)
    function withdrawCollateral(address token, address to, uint256 amount) external onlyRole(GOVERNANCE_ROLE) nonReentrant {
        require(to != address(0), "Zero address");
        require(to != address(this), "Self payment");
        require(amount <= collateralBalance[token], "Exceeds balance");
        require(
            collateralBalance[token] - amount >= minCollateralReserve[token],
            "Would breach min collateral reserve"
        );
        collateralBalance[token] -= amount;
        IERC20(token).safeTransfer(to, amount);
        emit CollateralWithdrawn(token, to, amount);
    }

    /// @notice The automatic floor: AUTO_FLOOR_BPS of the larger of the live supply and the
    ///         token's one day smoothed supply, rounded up.
    /// @dev The smoothed term means a burn only lowers the floor as it ages over a day, so
    ///      nobody, governance included, can repay debt for a moment to shrink the floor and
    ///      withdraw more. A mint raises it at once. GSUSD held here counts towards supply.
    ///      Called directly, not through try/catch: a fallback to the live supply could be
    ///      forced by an executor who starves the inner call of gas. A token without
    ///      smoothedSupplyNow therefore fails closed: withdrawGsusd reverts, absorbBadDebt
    ///      and deposits still work. There is no constructor probe, because the mainnet
    ///      preflight estimates this creation against a stand-in address before GSUSD exists;
    ///      verify-deployment asserts the floor instead.
    function autoMinGsusdReserve() public view returns (uint256) {
        IGoldStablecoin token = IGoldStablecoin(gsusd);
        uint256 supply = Math.max(token.totalSupply(), token.smoothedSupplyNow());
        return Math.mulDiv(supply, AUTO_FLOOR_BPS, BPS, Math.Rounding.Ceil);
    }

    /// @notice The GSUSD balance withdrawGsusd must leave behind: the higher of the automatic
    ///         floor and the governed minimum. absorbBadDebt is not bound by it.
    function effectiveMinGsusdReserve() public view returns (uint256) {
        return Math.max(minGsusdReserve, autoMinGsusdReserve());
    }

    /// @notice Set the optional governed minimum GSUSD reserve required after any withdraw.
    /// @dev Only a value above the automatic floor changes anything; zero returns the buffer
    ///      to the automatic floor alone.
    function setMinGsusdReserve(uint256 minReserve) external onlyRole(GOVERNANCE_ROLE) {
        minGsusdReserve = minReserve;
        emit MinGsusdReserveUpdated(minReserve);
    }

    /// @notice Set the minimum collateral reserve required after any withdraw.
    function setMinCollateralReserve(address token, uint256 minReserve) external onlyRole(GOVERNANCE_ROLE) {
        require(token != address(0), "Zero address");
        minCollateralReserve[token] = minReserve;
        emit MinCollateralReserveUpdated(token, minReserve);
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
