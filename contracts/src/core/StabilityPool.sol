// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.38;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./ExpiringPausable.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";

/// @title StabilityPool
/// @notice Allows GSUSD holders to deposit GSUSD into a shared pool that absorbs
///         liquidated debt. Depositors receive discounted gold collateral in
///         return. Faithful port of Liquity V1's product-sum algorithm.
///
/// @dev Product-sum accounting (Liquity whitepaper §9):
///
///      A global product factor `P` tracks how much the pool has been drained by
///      absorptions. `P` starts at `PRECISION` and shrinks multiplicatively on every
///      absorption. A depositor who deposited `D` at product snapshot `P_snap` has
///      effective deposit `D * P / P_snap` later. Collateral gains use a running sum
///      `S` (per token) scaled by `P` at the time of each increment; a depositor's gain
///      from one token is `D * (S - S_snap) / P_snap`.
///
///      EPOCH + SCALE tracking (the part the earlier version omitted):
///      Integer floor-division means a naive `P = P * remaining / total` eventually rounds
///      to ZERO (a single near-total drain, or enough cumulative absorptions), which would
///      lock every deposit and strand seized collateral with no claim path. Liquity solves
///      this with:
///        - SCALE_FACTOR: whenever `P` would drop below `SCALE_FACTOR` it is multiplied back
///          up by `SCALE_FACTOR` and `currentScale` is incremented, keeping `P` in
///          `[SCALE_FACTOR, PRECISION]` at all times so it can never reach 0.
///        - EPOCH: a near-total drain (`newProductFactor` below `SCALE_FACTOR`) resets the
///          pool to a fresh epoch with `P = PRECISION`; the dust-remainder depositors are
///          wiped (they absorbed essentially the whole pool, which is economically correct)
///          while their already-accrued collateral gains remain claimable from the old epoch.
///      Sums `S` are bucketed by `(epoch, scale)` and gains span at most one scale boundary.
///
///      COLLATERAL DECIMAL NORMALISATION: collateral amounts are normalised to 18 decimals
///      inside the gain accounting so that 6-decimal collateral (XAUT) cannot round its
///      per-unit gain increment to zero, then denormalised back to native decimals on payout.
contract StabilityPool is AccessControl, ReentrancyGuard, ExpiringPausable {
    using SafeERC20 for IERC20;

    bytes32 public constant VAULT_ROLE = keccak256("VAULT_ROLE");
    bytes32 public constant GOVERNANCE_ROLE = keccak256("GOVERNANCE_ROLE");
    bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");

    uint256 public constant PRECISION = 1e18;
    /// @notice When P would fall below this, it is scaled back up and `currentScale` bumped.
    uint256 public constant SCALE_FACTOR = 1e9;
    uint256 public constant MAX_COLLATERAL_TOKENS = 10;

    /// @notice The GSUSD token
    address public immutable gsusd;

    /// @notice Total GSUSD deposited in the pool (reflects post-absorption actuals)
    uint256 public totalDeposits;

    /// @notice Global product factor. Maintained in [SCALE_FACTOR, PRECISION] — never 0.
    uint256 public P;

    /// @notice Current scale and epoch for the product-sum buckets.
    uint128 public currentScale;
    uint128 public currentEpoch;

    struct Snapshot {
        uint256 P;
        uint128 scale;
        uint128 epoch;
    }

    /// @notice User's stored deposit, anchored to the user's snapshot.
    mapping(address => uint256) public deposits;
    /// @notice Block of each depositor's most recent deposit; a withdrawal or a collateral
    ///         claim in that block is refused.
    mapping(address => uint256) public lastDepositBlock;

    /// @notice Product/scale/epoch snapshot at the user's last deposit change.
    mapping(address => Snapshot) public snapshots;

    /// @notice Cumulative collateral gain sum per (epoch, scale, token).
    /// @dev Carries a PRECISION*P factor (Liquity-style) so increments never underflow.
    mapping(uint128 => mapping(uint128 => mapping(address => uint256))) public epochToScaleToSum;

    /// @notice Snapshot of the sum at the user's (epoch, scale) for each token.
    mapping(address => mapping(address => uint256)) public userGainSnapshot;

    /// @notice Accumulated-but-unclaimed collateral gains per user per token (NATIVE decimals).
    mapping(address => mapping(address => uint256)) public pendingCollateralGain;

    /// @notice Supported collateral tokens (PAXG, XAUT)
    address[] public collateralTokens;
    mapping(address => bool) public isCollateralToken;
    /// @notice 10**(18 - decimals) per token — used to normalise collateral to 18 decimals.
    mapping(address => uint256) public collateralScaleUp;

    /// @notice Collateral per token the pool has credited to depositors and not yet paid out.
    /// @dev What absorbLiquidationPrefunded measures a new arrival against: anything above it
    ///      is gold that reached the pool since the last absorption (a donation included,
    ///      which simply goes to the depositors of that absorption).
    mapping(address => uint256) public collateralAccounted;

    event Deposited(address indexed user, uint256 amount);
    event Withdrawn(address indexed user, uint256 amount);
    event LiquidationAbsorbed(address indexed token, uint256 debtAbsorbed, uint256 collateralGained);
    event CollateralClaimed(address indexed user, address indexed token, uint256 amount);
    event EpochReset(uint128 newEpoch);

    constructor(address _gsusd) {
        require(_gsusd != address(0), "Zero address");
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(GOVERNANCE_ROLE, msg.sender);
        gsusd = _gsusd;
        P = PRECISION;
    }

    /// @notice Register a collateral token that the pool can receive
    function addCollateralToken(address token) external onlyRole(GOVERNANCE_ROLE) {
        require(token != address(0), "Zero address");
        require(!isCollateralToken[token], "Already added");
        require(collateralTokens.length < MAX_COLLATERAL_TOKENS, "Too many collateral tokens");
        uint8 dec = IERC20Metadata(token).decimals();
        require(dec <= 18, "Decimals must be <= 18");
        collateralTokens.push(token);
        isCollateralToken[token] = true;
        collateralScaleUp[token] = 10 ** (18 - dec);
    }

    /// @notice Deposit GSUSD into the stability pool
    /// @dev Settles pending gains and re-anchors the stored deposit to the current product
    ///      epoch before adding the new amount, so post-absorption users never see pre-absorption
    ///      "stored" values.
    function deposit(uint256 amount) external nonReentrant whenNotPaused {
        require(amount > 0, "Zero amount");

        _settleGains(msg.sender);
        uint256 effective = _compoundedDeposit(msg.sender);

        IERC20(gsusd).safeTransferFrom(msg.sender, address(this), amount);

        deposits[msg.sender] = effective + amount;
        totalDeposits += amount;
        lastDepositBlock[msg.sender] = block.number;
        _updateSnapshot(msg.sender);

        emit Deposited(msg.sender, amount);
    }

    /// @notice Withdraw GSUSD from the stability pool
    /// @dev Withdrawable amount is the user's compounded (post-absorption) effective deposit.
    ///      Attempting to withdraw more returns only what's available — no revert.
    function withdraw(uint256 amount) external nonReentrant whenNotPaused {
        require(amount > 0, "Zero amount");
        // A deposit, a liquidation through the pool and a withdrawal in one transaction is a
        // flash-loan capture of the gain that standing depositors underwrite. Gains accrue to
        // whoever is in the pool when a vault is absorbed, so the one risk-free version is
        // the atomic one; a deposit must outlive its block before it can leave.
        require(lastDepositBlock[msg.sender] != block.number, "No same-block withdrawal");

        _settleGains(msg.sender);
        uint256 effective = _compoundedDeposit(msg.sender);
        uint256 toWithdraw = amount > effective ? effective : amount;

        deposits[msg.sender] = effective - toWithdraw;
        totalDeposits -= toWithdraw;
        _updateSnapshot(msg.sender);

        IERC20(gsusd).safeTransfer(msg.sender, toWithdraw);

        emit Withdrawn(msg.sender, toWithdraw);
    }

    /// @notice Absorb a liquidation: hand the caller `debtToAbsorb` of the pool's GSUSD and
    ///         credit depositors with the collateral that has ALREADY been sent here, straight
    ///         from the vault's silos. Credits whatever arrived since the last absorption.
    /// @dev Callable only by `GoldVault` (VAULT_ROLE), and the only way the pool absorbs.
    ///      Rejects a request that would fully drain the pool: the caller must check
    ///      `totalDeposits > debtToAbsorb` (strict) first. The vault's own address never
    ///      holds the seized gold, so an issuer freeze of the vault cannot stop the pool
    ///      absorbing. The pool trusts its caller for the collateral: it measures what
    ///      arrived and pays the GSUSD whatever that is, so the role must only ever be held
    ///      by the vault.
    function absorbLiquidationPrefunded(address token, uint256 debtToAbsorb)
        external
        nonReentrant
        onlyRole(VAULT_ROLE)
    {
        _requireAbsorbable(token, debtToAbsorb);
        uint256 balance = IERC20(token).balanceOf(address(this));
        uint256 accounted = collateralAccounted[token];
        uint256 received = balance > accounted ? balance - accounted : 0;
        collateralAccounted[token] = balance;

        _absorb(token, received, debtToAbsorb);
    }

    /// @notice Declares that this pool absorbs a liquidation whose collateral has already
    ///         been sent to it (absorbLiquidationPrefunded), the only way GoldVault
    ///         liquidates through a pool. GoldVault.setStabilityPool refuses a pool that
    ///         does not declare it: wired in, such a pool would make every pool liquidation
    ///         revert until governance replaced it again.
    function absorbsPrefunded() external pure returns (bool) {
        return true;
    }

    function _requireAbsorbable(address token, uint256 debtToAbsorb) internal view {
        require(isCollateralToken[token], "Unsupported token");
        require(totalDeposits > 0, "Pool empty");
        require(debtToAbsorb < totalDeposits, "Absorption would drain pool");
    }

    function _absorb(address token, uint256 received, uint256 debtToAbsorb) internal {
        _updateRewardSumAndProduct(token, received, debtToAbsorb);

        totalDeposits -= debtToAbsorb;
        IERC20(gsusd).safeTransfer(msg.sender, debtToAbsorb);

        emit LiquidationAbsorbed(token, debtToAbsorb, received);
    }

    /// @notice Claim accumulated collateral gains from liquidations
    /// @dev Deliberately NOT whenNotPaused. Pause semantics for this pool:
    ///      deposit/withdraw are gated (a pause must be able to stop capital movement in
    ///      and out), absorption is NOT gated (the backstop must keep absorbing
    ///      during an incident — that is its purpose), and claiming is NOT gated because
    ///      it only pays out gains that are already earned and fully accounted in
    ///      pendingCollateralGain / the epoch-scale sums. Blocking claims while
    ///      absorptions continue would trap depositor capital with no exit.
    ///
    ///      A claim is refused in the block of the caller's latest deposit, the rule
    ///      `withdraw` applies and for the same reason. A liquidation that absorbs nearly
    ///      the whole pool turns a deposit into gold, so the claim is as much an exit as a
    ///      withdrawal: without the rule, borrowed GSUSD deposited, absorbed and claimed in
    ///      one transaction would take the whole penalty with no capital and no exposure.
    ///      The rule holds during a pause as well. A depositor who tops up waits one block
    ///      for gains earned before the top-up; nothing is lost, the gain stays owed.
    function claimCollateral(address token) external nonReentrant {
        require(lastDepositBlock[msg.sender] != block.number, "No same-block claim");
        _settleGains(msg.sender);
        // Re-anchor the stored deposit (handles epoch/scale wipe) and refresh snapshots.
        deposits[msg.sender] = _compoundedDeposit(msg.sender);
        _updateSnapshot(msg.sender);

        uint256 gain = pendingCollateralGain[msg.sender][token];
        require(gain > 0, "No gains");

        // Paid up to what the pool actually holds. After an issuer wipes the pool's balance a
        // claim above it reverted and trapped whatever gold remained; the unpaid part now stays
        // pending and is paid once the gold is back.
        uint256 held = IERC20(token).balanceOf(address(this));
        uint256 payout = gain > held ? held : gain;
        require(payout > 0, "No collateral held");

        pendingCollateralGain[msg.sender][token] = gain - payout;
        // Saturating: an accounting shortfall (an issuer wiping the pool's balance, say) must
        // never stop a depositor claiming what the pool still holds.
        uint256 accounted = collateralAccounted[token];
        collateralAccounted[token] = accounted > payout ? accounted - payout : 0;
        IERC20(token).safeTransfer(msg.sender, payout);

        emit CollateralClaimed(msg.sender, token, payout);
    }

    /// @notice Current effective (compounded) deposit for a user.
    function getEffectiveDeposit(address user) external view returns (uint256) {
        return _compoundedDeposit(user);
    }

    /// @notice Pending + yet-to-be-settled collateral gain for a user for a token (native decimals)
    function getCollateralGain(address user, address token) external view returns (uint256) {
        return pendingCollateralGain[user][token] + _unsettledGain(user, token);
    }

    /// @notice Get total pool size
    function getTotalDeposits() external view returns (uint256) {
        return totalDeposits;
    }

    // --- Internal ---

    /// @notice Update the collateral-gain sum and the product/scale/epoch on an absorption.
    function _updateRewardSumAndProduct(address token, uint256 received, uint256 debtToAbsorb) internal {
        uint256 totalDep = totalDeposits;
        uint128 epoch = currentEpoch;
        uint128 scale = currentScale;

        // Marginal collateral gain per unit staked, carried at PRECISION*P precision.
        // Normalise collateral to 18 decimals first so 6-decimal tokens don't underflow.
        uint256 received18 = received * collateralScaleUp[token];
        uint256 gainPerUnitStaked = Math.mulDiv(received18, PRECISION, totalDep); // received18 * 1e18 / total
        uint256 marginalGain = gainPerUnitStaked * P;                             // * P  (no /1e18)
        epochToScaleToSum[epoch][scale][token] += marginalGain;

        // Product update. newProductFactor = 1e18 * remaining / total, in [0, 1e18).
        uint256 remaining = totalDep - debtToAbsorb;
        uint256 newProductFactor = Math.mulDiv(remaining, PRECISION, totalDep);

        if (newProductFactor < SCALE_FACTOR) {
            // Near-total drain (>99.9999999% absorbed): reset to a fresh epoch. The dust-remainder
            // depositors are wiped (they absorbed essentially the whole pool); their already-accrued
            // gains stay claimable from the old (epoch, scale) buckets.
            currentEpoch = epoch + 1;
            currentScale = 0;
            P = PRECISION;
            emit EpochReset(epoch + 1);
        } else {
            uint256 newP = Math.mulDiv(P, newProductFactor, PRECISION);
            if (newP < SCALE_FACTOR) {
                // Scale up to keep P in [SCALE_FACTOR, PRECISION] and never let it floor to 0.
                newP = Math.mulDiv(P, newProductFactor * SCALE_FACTOR, PRECISION);
                currentScale = scale + 1;
            }
            P = newP;
        }
    }

    /// @notice User's compounded (post-absorption) deposit.
    /// @dev `stored * P / P_snap`, adjusted for at most one scale change; 0 across an epoch
    ///      boundary or more than one scale change.
    function _compoundedDeposit(address user) internal view returns (uint256) {
        uint256 stored = deposits[user];
        if (stored == 0) return 0;
        Snapshot memory s = snapshots[user];
        if (s.P == 0) return 0;
        if (s.epoch < currentEpoch) return 0;

        uint256 scaleDiff = currentScale - s.scale;
        if (scaleDiff == 0) {
            return Math.mulDiv(stored, P, s.P);
        } else if (scaleDiff == 1) {
            return Math.mulDiv(stored, P, s.P) / SCALE_FACTOR;
        }
        return 0;
    }

    /// @notice Unsettled collateral gain for a user/token (native decimals).
    function _unsettledGain(address user, address token) internal view returns (uint256) {
        uint256 stored = deposits[user];
        // An unregistered token (XAUT while dormant) has no scale and has earned nothing: answer
        // 0 rather than divide by zero below.
        uint256 scaleUp = collateralScaleUp[token];
        if (stored == 0 || scaleUp == 0) return 0;
        Snapshot memory s = snapshots[user];
        if (s.P == 0) return 0;

        // Gains accrue within the snapshot's epoch; span at most one scale boundary.
        uint256 firstPortion = epochToScaleToSum[s.epoch][s.scale][token] - userGainSnapshot[user][token];
        uint256 secondPortion = epochToScaleToSum[s.epoch][s.scale + 1][token] / SCALE_FACTOR;

        // gain18 = stored * (firstPortion + secondPortion) / P_snap / PRECISION
        uint256 gain18 = Math.mulDiv(stored, firstPortion + secondPortion, s.P) / PRECISION;
        return gain18 / scaleUp;
    }

    /// @notice Settle pending collateral gains for a user across all tokens before a deposit change.
    function _settleGains(address user) internal {
        if (deposits[user] == 0) return;
        uint256 len = collateralTokens.length;
        for (uint256 i = 0; i < len; i++) {
            address token = collateralTokens[i];
            uint256 gain = _unsettledGain(user, token);
            if (gain > 0) {
                pendingCollateralGain[user][token] += gain;
            }
        }
    }

    /// @notice Re-anchor the user's product/scale/epoch snapshot and per-token gain snapshots.
    function _updateSnapshot(address user) internal {
        uint256 len = collateralTokens.length;
        if (deposits[user] == 0) {
            delete snapshots[user];
            for (uint256 i = 0; i < len; i++) {
                userGainSnapshot[user][collateralTokens[i]] = 0;
            }
            return;
        }
        snapshots[user] = Snapshot({P: P, scale: currentScale, epoch: currentEpoch});
        for (uint256 i = 0; i < len; i++) {
            address token = collateralTokens[i];
            userGainSnapshot[user][token] = epochToScaleToSum[currentEpoch][currentScale][token];
        }
    }

    /// @notice Emergency pause — callable by guardian or governance without timelock delay
    function emergencyPause() external {
        require(
            hasRole(GUARDIAN_ROLE, msg.sender) || hasRole(GOVERNANCE_ROLE, msg.sender),
            "Not guardian or governance"
        );
        _pause();
    }

    /// @notice Re-assert the pause in force and restart its 14 day window (same authority as
    ///         the pause). Every extension takes a new pauseEpoch, so an unpause approved
    ///         before it reverts "Different pause".
    function extendPause() external {
        require(
            hasRole(GUARDIAN_ROLE, msg.sender) || hasRole(GOVERNANCE_ROLE, msg.sender),
            "Not guardian or governance"
        );
        _extendPause();
    }

    /// @notice Lift pause number `epoch` early. Governance only, through the timelock.
    /// @param epoch pauseEpoch() as read when the unpause was scheduled; a later pause or
    ///        extension has another number, so an approval given before it cannot lift it
    ///        ("Different pause").
    function unpause(uint256 epoch) external onlyRole(GOVERNANCE_ROLE) {
        _unpauseAt(epoch);
    }

    function grantGuardianRole(address guardian) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(guardian != address(0), "Zero address");
        _grantRole(GUARDIAN_ROLE, guardian);
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
