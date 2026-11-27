// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.38;

import "./ExpiringTimelockController.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";

/// @title GoldGovernance
/// @notice Timelocked governance for gold stablecoin system parameter changes
/// @dev Wraps an ExpiringTimelockController (the OZ TimelockController with a grace period on
///      matured operations) with convenience methods for common operations
contract GoldGovernance is AccessControl {
    bytes32 public constant PROPOSER_ROLE = keccak256("PROPOSER_ROLE");
    bytes32 public constant EXECUTOR_ROLE = keccak256("EXECUTOR_ROLE");

    /// @dev Immutable: the timelock is deployed by this constructor and is the sole
    ///      holder of governance authority. Repointing it would be a silent takeover.
    ExpiringTimelockController public immutable timelock;

    /// @notice Minimum delay for parameter changes (default 48 hours)
    uint256 public constant MIN_DELAY = 48 hours;
    /// @notice Mirrors GoldVault.MAX_MIN_RATIO (1,000%) so a typo is refused at proposal time.
    uint256 public constant MAX_MIN_RATIO = 10_000_000;

    /// @notice Governed contract addresses
    address public vault;
    address public oracle;
    address public stabilityModule;

    /// @notice Incrementing nonce for unique proposal salts
    uint256 public proposalNonce;

    event ProposalCreated(bytes32 indexed id, address target, bytes data, uint256 eta);
    event GovernedContractUpdated(string contractName, address newAddress);

    constructor(
        address[] memory proposers,
        address[] memory executors,
        address _vault,
        address _oracle,
        address _stabilityModule
    ) {
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);

        // Create the timelock with address(0) as admin so no one gets a permanent admin role.
        // It refuses an operation more than GRACE_PERIOD after it matured, so no executor,
        // open or not, can run an old approval long after the moment it was made for.
        // Register this wrapper as BOTH a timelock proposer (so propose* can schedule) and a
        // timelock executor (so executeProposal can forward to timelock.execute). Without the
        // executor registration, executeProposal only works under the open-executor (address(0))
        // config and reverts TimelockUnauthorizedCaller under a restricted executor multisig.
        // The wrapper's own EXECUTOR_ROLE gate (executeProposal) still governs who may trigger it.
        address[] memory allProposers = new address[](proposers.length + 1);
        for (uint256 i = 0; i < proposers.length; i++) {
            allProposers[i] = proposers[i];
        }
        allProposers[proposers.length] = address(this);

        address[] memory allExecutors = new address[](executors.length + 1);
        for (uint256 i = 0; i < executors.length; i++) {
            allExecutors[i] = executors[i];
        }
        allExecutors[executors.length] = address(this);

        timelock = new ExpiringTimelockController(MIN_DELAY, allProposers, allExecutors, address(0));

        // Grant the wrapper's OWN PROPOSER_ROLE / EXECUTOR_ROLE to the configured signers so the
        // propose*/executeProposal helpers are usable in production. Previously these roles were
        // never granted, so the only way to use the wrapper was for the deployer to grant them
        // post-deploy — which required the deployer to retain DEFAULT_ADMIN_ROLE on the wrapper
        // (a standing backdoor) and made the LAUNCH.md runbook revert.
        for (uint256 i = 0; i < proposers.length; i++) {
            _grantRole(PROPOSER_ROLE, proposers[i]);
        }
        for (uint256 i = 0; i < executors.length; i++) {
            _grantRole(EXECUTOR_ROLE, executors[i]);
        }

        vault = _vault;
        oracle = _oracle;
        stabilityModule = _stabilityModule;
    }

    /// @notice Hand over admin of THIS wrapper to the timelock and permanently remove deployer admin.
    /// @dev Without this the deployer keeps DEFAULT_ADMIN_ROLE on the wrapper and can,
    ///      at any time after the "irreversible" handover, self-grant PROPOSER_ROLE and drive the
    ///      timelock (the wrapper is a registered timelock proposer). After this call the timelock
    ///      administers the wrapper's roles, so any future proposer change is itself timelocked.
    ///      Must be included in the governance handover (scripts/transfer-governance.ts) and
    ///      asserted by verify-deployment.ts.
    function transferGovernance(address timelockAddr) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(timelockAddr != address(0), "Zero address");
        require(timelockAddr != msg.sender, "Would self-revoke");
        // A handover is one-shot and irreversible; an EOA typo here is a dead protocol.
        require(timelockAddr.code.length > 0, "Timelock must be a contract");
        _grantRole(DEFAULT_ADMIN_ROLE, timelockAddr);
        _revokeRole(DEFAULT_ADMIN_ROLE, msg.sender);
    }

    /// @notice Schedule a collateral ratio update through the timelock. It carries the ratios
    ///         and the penalty only: the debt ceiling has its own proposal, so neither kind of
    ///         pending operation can restore what the other changed while it waited.
    /// @param collateralToken The token address (matches GoldVault.updateCollateralRatios signature)
    function proposeCollateralRatioUpdate(
        address collateralToken,
        uint256 minRatio,
        uint256 liquidationRatio,
        uint256 liquidationPenalty
    ) external onlyRole(PROPOSER_ROLE) {
        require(minRatio <= MAX_MIN_RATIO, "Min ratio exceeds maximum");
        require(minRatio > liquidationRatio, "Min > liquidation required");
        require(liquidationRatio >= 1050000, "Must be >= 105%"); // GoldVault's own floor
        require(liquidationPenalty <= 200000, "Penalty exceeds 20%");

        bytes memory data = abi.encodeWithSignature(
            "updateCollateralRatios(address,uint256,uint256,uint256)",
            collateralToken,
            minRatio,
            liquidationRatio,
            liquidationPenalty
        );

        _schedule(vault, data);
    }

    /// @notice Schedule a debt ceiling change, and nothing else, through the timelock.
    /// @param collateralToken The token address (matches GoldVault.setDebtCeiling signature)
    function proposeDebtCeilingUpdate(address collateralToken, uint256 debtCeiling) external onlyRole(PROPOSER_ROLE) {
        require(collateralToken != address(0), "Zero address");
        _schedule(vault, abi.encodeWithSignature("setDebtCeiling(address,uint256)", collateralToken, debtCeiling));
    }

    /// @notice Schedule a stability fee update through the timelock
    function proposeStabilityFeeUpdate(
        bytes32 collateralId,
        uint256 annualRateBps
    ) external onlyRole(PROPOSER_ROLE) {
        require(annualRateBps <= 5000, "Rate exceeds 50% max");

        bytes memory data = abi.encodeWithSignature(
            "setStabilityFee(bytes32,uint256)",
            collateralId,
            annualRateBps
        );

        _schedule(stabilityModule, data);
    }

    /// @notice Schedule an update to the vault's SurplusBuffer address
    function proposeSurplusBufferUpdate(address newBuffer) external onlyRole(PROPOSER_ROLE) {
        bytes memory data = abi.encodeWithSignature("setSurplusBuffer(address)", newBuffer);
        _schedule(vault, data);
    }

    /// @notice Schedule an update to the vault's StabilityPool address
    function proposeStabilityPoolUpdate(address newPool) external onlyRole(PROPOSER_ROLE) {
        bytes memory data = abi.encodeWithSignature("setStabilityPool(address)", newPool);
        _schedule(vault, data);
    }

    /// @notice Schedule pointing the vault at a Gold Stability Reserve
    function proposeStabilityReserveUpdate(address newReserve) external onlyRole(PROPOSER_ROLE) {
        bytes memory data = abi.encodeWithSignature("setStabilityReserve(address)", newReserve);
        _schedule(vault, data);
    }

    /// @notice Schedule a change to the share of penalty gold that funds the reserve
    function proposeReservePenaltyShare(uint256 bps) external onlyRole(PROPOSER_ROLE) {
        require(bps <= 10000, "Exceeds 100%");
        bytes memory data = abi.encodeWithSignature("setReservePenaltyShare(uint256)", bps);
        _schedule(vault, data);
    }

    /// @notice Schedule an update to the vault's liquidator incentive share
    function proposeLiquidatorIncentiveShareUpdate(uint256 share) external onlyRole(PROPOSER_ROLE) {
        require(share <= 1000000, "Share exceeds 100%");
        bytes memory data = abi.encodeWithSignature("setLiquidatorIncentiveShare(uint256)", share);
        _schedule(vault, data);
    }

    /// @notice Schedule an oracle feed update through the timelock
    function proposeOracleFeedUpdate(
        string calldata feedName,
        address newFeed
    ) external onlyRole(PROPOSER_ROLE) {
        require(newFeed != address(0), "Zero address");

        // Every branch assigns data or reverts; never read uninitialised.
        // slither-disable-next-line uninitialized-local
        bytes memory data;
        if (keccak256(bytes(feedName)) == keccak256("PAXG")) {
            data = abi.encodeWithSignature("setPaxgFeed(address)", newFeed);
        } else if (keccak256(bytes(feedName)) == keccak256("XAUT")) {
            data = abi.encodeWithSignature("setXautFeed(address)", newFeed);
        } else {
            revert("Unknown feed");
        }

        _schedule(oracle, data);
    }

    /// @notice Execute a previously scheduled proposal that has matured and not yet expired
    /// @dev Honours the OZ "open executor" pattern: if EXECUTOR_ROLE was granted to address(0),
    ///      anyone may execute. Otherwise the caller must hold EXECUTOR_ROLE. Without this,
    ///      granting the role to address(0) would brick this helper for everyone. An
    ///      open executor lets anyone choose when a matured operation runs within the timelock
    ///      grace period (ExpiringTimelockController.GRACE_PERIOD, 7 days after it becomes
    ///      ready); after that the timelock reverts TimelockOperationExpired here as well.
    /// @param salt The salt used when scheduling (matches proposalNonce at schedule time)
    function executeProposal(
        address target,
        bytes calldata data,
        bytes32 salt
    ) external {
        require(
            hasRole(EXECUTOR_ROLE, msg.sender) || hasRole(EXECUTOR_ROLE, address(0)),
            "Not executor"
        );
        timelock.execute(target, 0, data, bytes32(0), salt);
    }

    /// @dev One read that only the named kind of contract answers, used to check a replacement
    ///      target: GoldVault.minDebt(), GoldOracle.stalenessThreshold() and
    ///      StabilityModule.MAX_ANNUAL_RATE_BPS().
    bytes4 private constant VAULT_PROBE = bytes4(keccak256("minDebt()"));
    bytes4 private constant ORACLE_PROBE = bytes4(keccak256("stalenessThreshold()"));
    bytes4 private constant STABILITY_MODULE_PROBE = bytes4(keccak256("MAX_ANNUAL_RATE_BPS()"));

    /// @dev A replacement target must hold code and answer its kind's read with one word. The
    ///      timelock makes a low-level call and accepts success, and a call to an address with
    ///      no code succeeds with empty return data: every later helper proposal aimed at such
    ///      a target would execute, be recorded as done and change nothing.
    ///      The constructor is not probed, because the launch preflight estimates this
    ///      creation against stand-in addresses before the three contracts exist;
    ///      verify-deployment.ts asserts the three targets after the deploy instead.
    function _requireGoverned(address target, bytes4 probe) internal view {
        require(target.code.length > 0, "Not a contract");
        // A static read of a known selector; the answer is checked by its length alone.
        (bool ok, bytes memory answer) = target.staticcall(abi.encodeWithSelector(probe));
        require(ok && answer.length == 32, "Wrong contract");
    }

    /// @notice Update governed contract references — only callable via timelock
    function setGovernedContract(
        string calldata contractName,
        address newAddress
    ) external {
        require(msg.sender == address(timelock), "Only timelock");
        require(newAddress != address(0), "Zero address");

        if (keccak256(bytes(contractName)) == keccak256("vault")) {
            _requireGoverned(newAddress, VAULT_PROBE);
            vault = newAddress;
        } else if (keccak256(bytes(contractName)) == keccak256("oracle")) {
            _requireGoverned(newAddress, ORACLE_PROBE);
            oracle = newAddress;
        } else if (keccak256(bytes(contractName)) == keccak256("stabilityModule")) {
            _requireGoverned(newAddress, STABILITY_MODULE_PROBE);
            stabilityModule = newAddress;
        } else {
            revert("Unknown contract");
        }

        emit GovernedContractUpdated(contractName, newAddress);
    }

    /// @notice Propose a governed contract address update through the timelock
    function proposeGovernedContractUpdate(
        string calldata contractName,
        address newAddress
    ) external onlyRole(PROPOSER_ROLE) {
        require(newAddress != address(0), "Zero address");

        bytes memory data = abi.encodeWithSignature(
            "setGovernedContract(string,address)",
            contractName,
            newAddress
        );

        _schedule(address(this), data);
    }

    /// @notice Schedule a SiloFactory update on the vault
    function proposeSiloFactoryUpdate(address newFactory) external onlyRole(PROPOSER_ROLE) {
        bytes memory data = abi.encodeWithSignature("setSiloFactory(address)", newFactory);
        _schedule(vault, data);
    }

    /// @notice Schedule a VaultRegistry update on the vault (zero unwires it)
    function proposeVaultRegistryUpdate(address newRegistry) external onlyRole(PROPOSER_ROLE) {
        bytes memory data = abi.encodeWithSignature("setVaultRegistry(address)", newRegistry);
        _schedule(vault, data);
    }

    /// @notice Schedule a minimum debt update on the vault
    /// @param value Range: 100e18 to 10_000e18, GoldVault.setMinDebt's own bounds, so a typo is
    ///        refused at proposal time rather than after the delay.
    function proposeMinDebtUpdate(uint256 value) external onlyRole(PROPOSER_ROLE) {
        require(value >= 100e18 && value <= 10_000e18, "Min debt out of range");
        bytes memory data = abi.encodeWithSignature("setMinDebt(uint256)", value);
        _schedule(vault, data);
    }

    /// @notice Schedule an underwater liquidation discount update on the vault
    /// @param ppm At most 50_000 (5%), GoldVault.setUnderwaterDiscount's own bound.
    function proposeUnderwaterDiscountUpdate(uint256 ppm) external onlyRole(PROPOSER_ROLE) {
        require(ppm <= 50_000, "Discount exceeds 5%");
        bytes memory data = abi.encodeWithSignature("setUnderwaterDiscount(uint256)", ppm);
        _schedule(vault, data);
    }

    /// @notice Schedule a bad debt pause threshold update on the vault
    function proposeBadDebtPauseThreshold(uint256 threshold) external onlyRole(PROPOSER_ROLE) {
        bytes memory data = abi.encodeWithSignature("setBadDebtPauseThreshold(uint256)", threshold);
        _schedule(vault, data);
    }

    /// @notice Schedule a token's gold band on the oracle (GoldOracle.setGoldBand).
    /// @param ppm Range: 5000 (0.5%) to 100000 (10%), the oracle's own bounds.
    function proposeGoldBandUpdate(address token, uint256 ppm) external onlyRole(PROPOSER_ROLE) {
        require(token != address(0), "Zero address");
        require(ppm >= 5000 && ppm <= 100000, "Band out of range");
        bytes memory data = abi.encodeWithSignature("setGoldBand(address,uint256)", token, ppm);
        _schedule(oracle, data);
    }

    /// @notice Schedule a token's liquidation clamp on the oracle
    ///         (GoldOracle.setLiquidationClamp).
    /// @param ppm Range: 5000 (0.5%) to 50000 (5%), the oracle's own bounds.
    function proposeLiquidationClampUpdate(address token, uint256 ppm) external onlyRole(PROPOSER_ROLE) {
        require(token != address(0), "Zero address");
        require(ppm >= 5000 && ppm <= 50000, "Clamp out of range");
        bytes memory data = abi.encodeWithSignature("setLiquidationClamp(address,uint256)", token, ppm);
        _schedule(oracle, data);
    }

    // NOTE: `proposeTransferGovernance` was REMOVED, not merely restricted.
    //
    // It scheduled `transferGovernance(dest)` on a target through the timelock, so the
    // target saw `msg.sender == address(timelock)`. Every `transferGovernance`
    // implementation grants the roles to `timelockAddr` and then revokes them from
    // `msg.sender`. Pinning `dest == address(timelock)` (an earlier fix) therefore
    // made the grants no-ops on an existing holder and the revokes total: the target
    // was left with ZERO holders of GOVERNANCE_ROLE and DEFAULT_ADMIN_ROLE, and because
    // GOVERNANCE_ROLE's admin is DEFAULT_ADMIN_ROLE, neither could ever be re-granted.
    // A single guardian pause or bad-debt auto-pause after that is permanent: every
    // user-facing entry point stays dead and all collateral is stranded.
    //
    // The pin turned a footgun into the ONLY reachable call, so the function is gone.
    // The initial handover is performed once by the deployer EOA in
    // scripts/transfer-governance.ts; a genuine timelock migration must be scheduled
    // directly on the TimelockController, where the destination is explicit and
    // reviewable. Each `transferGovernance` additionally now rejects
    // `timelockAddr == msg.sender` as a defence in depth.

    /// @dev Schedule `data` on `target` with a fresh salt (the proposal nonce) at the delay
    ///      the timelock requires now: MIN_DELAY, or more if governance has since raised the
    ///      timelock's minimum delay through updateDelay. Scheduling below it reverts
    ///      TimelockInsufficientDelay, so a hard-coded MIN_DELAY broke every helper the
    ///      moment the delay went up.
    function _schedule(address target, bytes memory data) internal {
        uint256 delay = Math.max(MIN_DELAY, timelock.getMinDelay());
        bytes32 salt = bytes32(proposalNonce++);
        bytes32 id = timelock.hashOperation(target, 0, data, bytes32(0), salt);
        timelock.schedule(target, 0, data, bytes32(0), salt, delay);
        emit ProposalCreated(id, target, data, block.timestamp + delay);
    }

    /// @notice Get the timelock address for granting roles on governed contracts
    function getTimelockAddress() external view returns (address) {
        return address(timelock);
    }
}
