// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.38;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";

/// @title StabilityModule
/// @notice Manages stability fees (interest) accrued on vault debt positions
/// @dev Fees are expressed as annualised rates and compounded per-second
contract StabilityModule is AccessControl, ReentrancyGuard {
    bytes32 public constant GOVERNANCE_ROLE = keccak256("GOVERNANCE_ROLE");
    bytes32 public constant VAULT_ROLE = keccak256("VAULT_ROLE");

    uint256 public constant PRECISION = 1e18;
    uint256 public constant SECONDS_PER_YEAR = 365 days;
    uint256 public constant MAX_ANNUAL_RATE_BPS = 5000; // 50% max

    /// @notice Per-second stability fee rate per collateral type
    /// @dev Stored as a per-second multiplier with 18 decimals (1e18 = no fee)
    mapping(bytes32 => uint256) public stabilityFeeRate;

    /// @notice Cumulative rate accumulator per collateral type
    mapping(bytes32 => uint256) public rateAccumulator;

    /// @notice Last time the accumulator was updated
    mapping(bytes32 => uint256) public lastAccrualTimestamp;

    /// @notice Normalised debt per vault (user => collateralId => normalisedDebt)
    mapping(address => mapping(bytes32 => uint256)) public normalisedDebt;

    event StabilityFeeUpdated(bytes32 indexed collateralId, uint256 annualRate, uint256 perSecondRate);
    event FeesAccrued(bytes32 indexed collateralId, uint256 newAccumulator);

    constructor() {
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(GOVERNANCE_ROLE, msg.sender);
    }

    /// @notice Initialise a collateral type's fee parameters
    function initCollateral(bytes32 collateralId, uint256 annualRateBps) external onlyRole(GOVERNANCE_ROLE) {
        require(rateAccumulator[collateralId] == 0, "Already initialised");
        require(annualRateBps <= MAX_ANNUAL_RATE_BPS, "Rate exceeds 50% max");

        uint256 perSecondRate = _annualToPerSecond(annualRateBps);
        stabilityFeeRate[collateralId] = perSecondRate;
        rateAccumulator[collateralId] = PRECISION;
        lastAccrualTimestamp[collateralId] = block.timestamp;

        emit StabilityFeeUpdated(collateralId, annualRateBps, perSecondRate);
    }

    /// @notice Update the stability fee for a collateral type
    /// @param annualRateBps Annual rate in basis points (e.g. 200 = 2%)
    function setStabilityFee(bytes32 collateralId, uint256 annualRateBps) external onlyRole(GOVERNANCE_ROLE) {
        require(rateAccumulator[collateralId] > 0, "Not initialised");
        require(annualRateBps <= MAX_ANNUAL_RATE_BPS, "Rate exceeds 50% max");

        // Accrue before changing rate
        _accrueInterest(collateralId);

        uint256 perSecondRate = _annualToPerSecond(annualRateBps);
        stabilityFeeRate[collateralId] = perSecondRate;

        emit StabilityFeeUpdated(collateralId, annualRateBps, perSecondRate);
    }

    /// @notice Accrue interest for a collateral type. Called by keepers or before any vault operation.
    function accrueInterest(bytes32 collateralId) external {
        _accrueInterest(collateralId);
    }

    /// @notice Record normalised debt when a user mints
    /// @dev Rounds UP to favour the protocol (user owes slightly more)
    function recordDebt(
        address user,
        bytes32 collateralId,
        uint256 debtAmount
    ) external onlyRole(VAULT_ROLE) {
        // A collateral registered on the vault but never initialised here would
        // otherwise panic with division-by-zero below. Fail with a clear message.
        require(rateAccumulator[collateralId] > 0, "Collateral not initialised");
        _accrueInterest(collateralId);
        uint256 normDebt = Math.mulDiv(debtAmount, PRECISION, rateAccumulator[collateralId], Math.Rounding.Ceil);
        normalisedDebt[user][collateralId] += normDebt;
    }

    /// @notice Reduce normalised debt when a user repays
    /// @dev Rounds DOWN so user retains slightly more debt (favours protocol)
    function reduceDebt(
        address user,
        bytes32 collateralId,
        uint256 debtAmount
    ) external onlyRole(VAULT_ROLE) {
        require(rateAccumulator[collateralId] > 0, "Collateral not initialised");
        _accrueInterest(collateralId);
        uint256 normDebt = Math.mulDiv(debtAmount, PRECISION, rateAccumulator[collateralId]);
        normalisedDebt[user][collateralId] -= normDebt;
    }

    /// @notice Zero a user's normalised debt on full close.
    /// @dev `recordDebt` rounds up and `reduceDebt` rounds down (both protocol-favouring),
    ///      so a full repayment leaves 1+ wei of normalised-debt dust that would be carried
    ///      into the user's next vault and accrue fees they never originated. The vault
    ///      calls this whenever a position's principal reaches zero (full repay, full
    ///      liquidation, full redemption or bad-debt socialisation).
    function clearDebt(address user, bytes32 collateralId) external onlyRole(VAULT_ROLE) {
        normalisedDebt[user][collateralId] = 0;
    }

    /// @notice Get the current actual debt for a user including accrued fees
    function getCurrentDebt(address user, bytes32 collateralId) external view returns (uint256) {
        uint256 accumulator = _projectAccumulator(collateralId);
        return (normalisedDebt[user][collateralId] * accumulator) / PRECISION;
    }

    /// @notice Outstanding accrued fee for one vault: current debt minus the principal
    ///         the vault still records.
    /// @dev The counterpart to SurplusBuffer.totalFeesReceived. Comparing accrued against
    ///      realised is what surfaces a collection shortfall; with no such view, fees that
    ///      were being destroyed on exit paths rather than banked were invisible.
    function getOutstandingAccruedFee(
        address user,
        bytes32 collateralId,
        uint256 principal
    ) external view returns (uint256) {
        uint256 currentDebt =
            (normalisedDebt[user][collateralId] * _projectAccumulator(collateralId)) / PRECISION;
        return currentDebt > principal ? currentDebt - principal : 0;
    }

    /// @notice Get accrued fees for a user (current debt minus principal)
    function getAccruedFees(address user, bytes32 collateralId, uint256 principal) external view returns (uint256) {
        uint256 accumulator = _projectAccumulator(collateralId);
        uint256 currentDebt = (normalisedDebt[user][collateralId] * accumulator) / PRECISION;
        return currentDebt > principal ? currentDebt - principal : 0;
    }

    // ========== Internal ==========

    function _accrueInterest(bytes32 collateralId) internal {
        // No-op for uninitialised collateral: accruing on a zero accumulator would
        // only pollute lastAccrualTimestamp while leaving the accumulator at zero.
        if (rateAccumulator[collateralId] == 0) return;
        uint256 elapsed = block.timestamp - lastAccrualTimestamp[collateralId];
        // Already accrued in this block. A difference of two timestamps, zero exactly when
        // the last accrual was this block: not a balance anyone can move off zero.
        // slither-disable-next-line incorrect-equality
        if (elapsed == 0) return;

        uint256 rate = stabilityFeeRate[collateralId];
        uint256 accumulated = _rpow(rate, elapsed);
        rateAccumulator[collateralId] = (rateAccumulator[collateralId] * accumulated) / PRECISION;
        lastAccrualTimestamp[collateralId] = block.timestamp;

        emit FeesAccrued(collateralId, rateAccumulator[collateralId]);
    }

    function _projectAccumulator(bytes32 collateralId) internal view returns (uint256) {
        uint256 elapsed = block.timestamp - lastAccrualTimestamp[collateralId];
        // Nothing to project within the block of the last accrual: the same exact
        // comparison of timestamps as in accrueInterest.
        // slither-disable-next-line incorrect-equality
        if (elapsed == 0) return rateAccumulator[collateralId];

        uint256 rate = stabilityFeeRate[collateralId];
        uint256 accumulated = _rpow(rate, elapsed);
        return (rateAccumulator[collateralId] * accumulated) / PRECISION;
    }

    /// @notice Convert annual basis points to per-second rate
    /// @dev 200 bps = 2% annual ≈ 1.0000000006341958 per second.
    ///      Note: this is `1 + r/N` compounded N times per year, so the
    ///      REALISED annual rate is e^r - 1, slightly ABOVE the nominal figure
    ///      (2% nominal -> ~2.02% realised; the 50% cap -> ~64.9% realised). The
    ///      error is protocol-favouring and bounded by the MAX_ANNUAL_RATE_BPS cap.
    ///      Governance proposals quoting a rate MUST quote the realised e^r - 1
    ///      figure alongside the nominal bps. (MakerDAO instead stores a true
    ///      per-second nth-root rate computed off-chain; adopting that here would
    ///      push root-finding into proposal tooling for little gain at gold-vault
    ///      fee levels.)
    function _annualToPerSecond(uint256 annualBps) internal pure returns (uint256) {
        return PRECISION + (annualBps * PRECISION) / (10000 * SECONDS_PER_YEAR);
    }

    /// @notice Transfer all governance power to the timelock and permanently remove deployer access
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

    /// @notice Exponentiation by squaring for per-second compounding
    /// @dev MakerDAO-style rpow with half-up rounding and overflow protection
    // Slither false positives on the rpow algorithm: the n % 2 parity test is
    // exponentiation by squaring (not randomness), the divide-then-multiply is
    // the intended fixed-point rounding and the == 0 switches are exact guards.
    // slither-disable-start weak-prng,divide-before-multiply,incorrect-equality
    function _rpow(uint256 x, uint256 n) internal pure returns (uint256 z) {
        assembly {
            switch x
            case 0 {
                switch n
                case 0 { z := PRECISION }
                default { z := 0 }
            }
            default {
                switch mod(n, 2)
                case 0 { z := PRECISION }
                default { z := x }
                let half := div(PRECISION, 2)
                for { n := div(n, 2) } n { n := div(n, 2) } {
                    let xx := mul(x, x)
                    if iszero(eq(div(xx, x), x)) { revert(0, 0) }
                    let xxRound := add(xx, half)
                    if lt(xxRound, xx) { revert(0, 0) }
                    x := div(xxRound, PRECISION)
                    if mod(n, 2) {
                        let zx := mul(z, x)
                        if and(iszero(iszero(x)), iszero(eq(div(zx, x), z))) { revert(0, 0) }
                        let zxRound := add(zx, half)
                        if lt(zxRound, zx) { revert(0, 0) }
                        z := div(zxRound, PRECISION)
                    }
                }
            }
        }
    }
    // slither-disable-end weak-prng,divide-before-multiply,incorrect-equality
}
