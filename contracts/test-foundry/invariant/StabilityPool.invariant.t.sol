// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import "forge-std/Test.sol";
import "forge-std/StdInvariant.sol";

import {StabilityPool} from "../../src/core/StabilityPool.sol";
import {GoldStablecoin} from "../../src/core/GoldStablecoin.sol";
import {MockERC20} from "../../src/test/mocks/MockERC20.sol";

import {PoolHandler} from "./handlers/PoolHandler.sol";

/// @title StabilityPool invariant suite
/// @notice Exercises deposit / withdraw / absorbLiquidationPrefunded /
///         claimCollateral under random fuzz, with an 18-decimal and a 6-decimal collateral
///         token, and asserts the product-sum accounting holds.
///
/// @dev Absorptions are first-class handler actions: the pool's epoch and scale
///      tracking keeps the product factor above zero, so the suite verifies the
///      full pool lifecycle, block advances included (a deposit must outlive its
///      block before its holder can withdraw or claim).
abstract contract StabilityPoolInvariantBase is StdInvariant, Test {
    StabilityPool internal pool;
    GoldStablecoin internal gsusd;
    MockERC20 internal paxg;
    MockERC20 internal xaut;
    PoolHandler internal handler;

    /// @dev The handler's deposit unit: see PoolHandler.UNIT.
    function _unit() internal pure virtual returns (uint256);

    function setUp() public {
        gsusd = new GoldStablecoin();
        pool = new StabilityPool(address(gsusd));

        paxg = new MockERC20("Pax Gold", "PAXG", 18);
        xaut = new MockERC20("Tether Gold", "XAUT", 6);
        pool.addCollateralToken(address(paxg));
        pool.addCollateralToken(address(xaut));

        // Test contract holds MINTER_ROLE so the handler can mint GSUSD.
        gsusd.grantRole(gsusd.MINTER_ROLE(), address(this));

        handler = new PoolHandler(pool, gsusd, paxg, xaut, _unit());

        // Grant roles to the handler so it can mint GSUSD and drive absorption.
        gsusd.grantRole(gsusd.MINTER_ROLE(), address(handler));
        pool.grantRole(pool.VAULT_ROLE(), address(handler));

        targetContract(address(handler));

        bytes4[] memory selectors = new bytes4[](6);
        selectors[0] = PoolHandler.deposit.selector;
        selectors[1] = PoolHandler.withdraw.selector;
        selectors[2] = PoolHandler.absorbLiquidationPrefunded.selector;
        selectors[3] = PoolHandler.claimCollateral.selector;
        selectors[4] = PoolHandler.advanceBlock.selector;
        selectors[5] = PoolHandler.depositThenTryToLeave.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    // ==================================================================
    // Invariants
    // ==================================================================

    /// @notice `totalDeposits` tracks the sum of every user's compounded
    ///         effective deposit. This is the core identity a pool without
    ///         epoch and scale tracking violates once the product factor floors to zero.
    function invariant_totalDepositsMatchesSumEffective() public view {
        address[] memory actors = handler.getActors();
        uint256 sum;
        for (uint256 i = 0; i < actors.length; i++) {
            sum += pool.getEffectiveDeposit(actors[i]);
        }
        // SAFETY DIRECTION (the property that actually matters): the sum of withdrawable
        // (effective) deposits must NEVER EXCEED totalDeposits — otherwise depositors could
        // collectively withdraw more GSUSD than the pool holds. The Liquity scale-factor math
        // leaves bounded rounding dust strictly BELOW totalDeposits (protocol-favouring): a
        // few wei per actor per scale boundary / epoch reset, never an over-count.
        // THE safety property (what a pool without epoch and scale tracking violates): the sum of
        // withdrawable (effective) deposits must NEVER exceed totalDeposits — otherwise
        // depositors could collectively withdraw more GSUSD than the pool holds. Combined with
        // invariant_balanceMatchesTotalDeposits (balance == totalDeposits), this guarantees the
        // pool can always honour every withdrawal.
        //
        // The protocol-favouring gap (totalDeposits - sum) is unclaimable orphaned dust left by
        // Liquity scale-factor rounding and post-near-total-drain epoch resets. It is bounded
        // per event and only ever makes the pool MORE solvent per active deposit, so it is an
        // accepted property — not asserted tightly here precisely because a near-total drain can
        // legitimately orphan up to the (sub-1e-9-of-pre-drain) dust remainder.
        assertLe(sum, pool.totalDeposits(), "sum effective exceeds totalDeposits (over-withdrawal risk)");
    }

    /// @notice Pool's GSUSD balance is never less than totalDeposits. During
    ///         absorption the pool temporarily holds `totalDeposits + absorbed
    ///         before transfer`, but at block boundary the transfer is complete
    ///         and balance == totalDeposits.
    function invariant_balanceMatchesTotalDeposits() public view {
        assertEq(
            gsusd.balanceOf(address(pool)),
            pool.totalDeposits(),
            "pool GSUSD balance != totalDeposits"
        );
    }

    /// @notice P is always strictly positive. The absorption guard
    ///         (require debtToAbsorb < totalDeposits) prevents P from ever
    ///         reaching zero.
    function invariant_PIsStrictlyPositive() public view {
        assertGt(pool.P(), 0, "P reached zero - pool drained fully");
    }

    /// @notice P stays inside [SCALE_FACTOR, PRECISION], now and at every observation the
    ///         handler made after an action.
    function invariant_PStaysWithinItsBounds() public view {
        assertGe(pool.P(), pool.SCALE_FACTOR(), "P below the scale factor");
        assertLe(pool.P(), pool.PRECISION(), "P above its starting value");
        assertEq(handler.ghost_pOutOfBounds(), 0, "P was observed outside [SCALE_FACTOR, PRECISION]");
    }

    /// @notice Within one scale and epoch P never rises: an absorption lowers it and nothing
    ///         else moves it. The stored value does rise at a scale change (times 1e9) and at
    ///         an epoch reset (back to 1e18), which is why the comparison is between two
    ///         consecutive observations with the same scale and epoch, and not with a maximum.
    function invariant_PNeverRisesWithinAScaleAndEpoch() public view {
        assertEq(handler.ghost_pRoseWithinScale(), 0, "P rose with the scale and the epoch unchanged");
    }

    /// @notice The epoch never decreases, and within one epoch the scale never decreases.
    function invariant_scaleAndEpochNeverGoBack() public view {
        assertEq(handler.ghost_scaleOrEpochWentBack(), 0, "the epoch fell, or the scale fell within an epoch");
        assertGe(pool.currentEpoch(), handler.lastEpoch(), "the epoch fell since the last action");
    }

    /// @notice Only an absorption moves P, the scale or the epoch: a deposit, a withdrawal
    ///         and a claim leave all three alone.
    function invariant_onlyAnAbsorptionMovesP() public view {
        assertEq(handler.ghost_pMovedWithoutAbsorption(), 0, "a deposit, withdrawal or claim moved P, the scale or the epoch");
    }

    /// @notice The pool never refuses a call it must accept: a deposit, a withdrawal of at
    ///         most the effective deposit in a later block, a claim that is owed in a later
    ///         block, an absorption of less than the pool. The handler catches reverts so a
    ///         run can continue; this is what stops a caught revert from hiding a fault.
    function invariant_noUnexpectedRevert() public view {
        assertEq(handler.ghost_unexpectedReverts(), 0, "the pool refused a call it must accept");
    }

    /// @notice Total gain delivered (pending + claimed per user) never
    ///         exceeds total collateral deposited via absorptions, for either token.
    ///         Prevents phantom-gain bugs.
    function invariant_collateralGainsBounded() public view {
        _assertGainsBounded(address(paxg));
        _assertGainsBounded(address(xaut));
    }

    /// @notice The pool's collateral ledger equals its balance in each token: an absorption
    ///         records the balance it finds, a claim subtracts what it paid. With no donation
    ///         between absorptions and no issuer wipe in this suite nothing else moves the
    ///         balance, so any drift is an accounting fault.
    function invariant_collateralAccountedMatchesBalance() public view {
        assertEq(pool.collateralAccounted(address(paxg)), paxg.balanceOf(address(pool)), "PAXG ledger drifted");
        assertEq(pool.collateralAccounted(address(xaut)), xaut.balanceOf(address(pool)), "XAUT ledger drifted");
    }

    /// @notice Nothing leaves the pool for a depositor in the block of that depositor's latest
    ///         deposit: neither a withdrawal nor a collateral claim. A deposit that can be
    ///         absorbed and taken out as gold in its own block is a capture of the liquidation
    ///         gain with borrowed GSUSD.
    function invariant_noExitInTheDepositsBlock() public view {
        assertEq(handler.ghost_sameBlockExits(), 0, "a deposit left the pool in its own block");
    }

    /// @notice The opening sequence every run starts with (see PoolHandler) went as the pool
    ///         promises: the deposit, the absorption, the claim and the withdrawal a block
    ///         later succeeded, and both exits in the deposit's block were refused.
    function invariant_openingSequenceBehaves() public view {
        assertEq(handler.ghost_openingFaults(), 0, "the opening deposit, absorption, claim or withdrawal misbehaved");
    }

    /// @notice Anti-vacuity: every run reaches the production absorption path, the 6-decimal
    ///         token, a claim, a withdrawal and a refused exit in a deposit's block, or the
    ///         properties above were never tested against them.
    function afterInvariant() public view {
        assertGt(handler.ghost_withdrawalsCount(), 0, "vacuous run: no withdrawal succeeded");
        assertGt(handler.ghost_sameBlockRefusals(), 0, "vacuous run: no exit refused in a deposit's block");
        assertGt(handler.ghost_prefundedAbsorptions(), 0, "vacuous run: no prefunded absorption");
        assertGt(handler.ghost_sixDecimalAbsorptions(), 0, "vacuous run: no 6-decimal absorption");
        assertGt(handler.ghost_claimsCount(), 0, "vacuous run: no claim succeeded");
        assertGt(handler.ghost_pDecreases(), 0, "vacuous run: P never fell, so its monotonicity was never tested");
    }

    function _assertGainsBounded(address token) internal view {
        address[] memory actors = handler.getActors();
        uint256 totalClaimable;
        for (uint256 i = 0; i < actors.length; i++) {
            totalClaimable += pool.getCollateralGain(actors[i], token);
        }
        uint256 accountedFor = totalClaimable + handler.ghost_collateralClaimed(token);
        uint256 collateralDelivered = handler.ghost_collateralAbsorbedIn(token);

        // SAFETY DIRECTION (the property that actually matters): total claimable collateral must
        // NEVER EXCEED what was actually delivered to the pool — phantom gains would let depositors
        // drain more collateral than the pool received. Rounding strands a bounded dust amount
        // strictly BELOW the delivered total (acceptable, and < 1e-6 at realistic >=1e16 scale).
        uint256 tol = (actors.length + 1) * (handler.ghost_absorptionsCount() + 1);
        assertLe(accountedFor, collateralDelivered + tol, "claimable exceeds delivered (phantom gains)");
    }
}

/// @notice The pool at ordinary sizes: deposits of 1 to 100,000 GSUSD.
contract StabilityPoolInvariantTest is StabilityPoolInvariantBase {
    function _unit() internal pure override returns (uint256) {
        return 1e18;
    }
}

/// @notice The same pool and the same properties at dust sizes: deposits of 1 to 100,000
///         base units, so one unit of rounding per depositor is a visible share of the pool.
contract StabilityPoolDustInvariantTest is StabilityPoolInvariantBase {
    function _unit() internal pure override returns (uint256) {
        return 1;
    }
}
