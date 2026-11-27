// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Test} from "forge-std/Test.sol";

import {StabilityPool} from "../../../src/core/StabilityPool.sol";
import {GoldStablecoin} from "../../../src/core/GoldStablecoin.sol";
import {MockERC20} from "../../../src/test/mocks/MockERC20.sol";

/// @title PoolHandler
/// @notice Fuzz-driven harness for StabilityPool invariants. Exercises
///         deposit / withdraw / absorbLiquidationPrefunded /
///         claimCollateral, with block advances, across a small actor set and two collateral tokens, an
///         18-decimal PAXG and a 6-decimal XAUT. The handler itself holds VAULT_ROLE on the
///         pool so it can simulate liquidation absorption without standing up the full vault.
/// @dev Absorptions go the way GoldVault.liquidateViaPool sends them, the only way the pool
///      absorbs: the silos send the gold straight to the pool, which credits whatever
///      arrived since the last absorption.
contract PoolHandler is Test {
    StabilityPool internal immutable pool;
    GoldStablecoin internal immutable gsusd;
    MockERC20 internal immutable paxg;
    MockERC20 internal immutable xaut;

    uint256 internal constant NUM_ACTORS = 5;
    address[] public actors;

    uint256 public ghost_depositedIn;
    uint256 public ghost_withdrawnOut;
    mapping(address => uint256) public ghost_collateralAbsorbedIn; // per token, paid in during absorptions
    mapping(address => uint256) public ghost_collateralClaimed;    // per token, claimed out by depositors
    uint256 public ghost_absorptionsCount;
    uint256 public ghost_prefundedAbsorptions;
    uint256 public ghost_sixDecimalAbsorptions;
    uint256 public ghost_claimsCount;
    uint256 public ghost_withdrawalsCount;
    /// @dev A withdrawal or a claim that succeeded in the block of the actor's latest deposit.
    ///      The pool refuses both, so this must stay zero.
    uint256 public ghost_sameBlockExits;
    /// @dev Withdrawals and claims the pool refused because of that rule.
    uint256 public ghost_sameBlockRefusals;
    /// @dev What the pool's product was when last observed, with its scale and epoch. Every
    ///      action ends by comparing the pool with this and then replacing it, so each of the
    ///      counters below compares two consecutive states, never a state with a constant.
    uint256 public lastP;
    uint128 public lastScale;
    uint128 public lastEpoch;
    /// @dev P observed outside [SCALE_FACTOR, PRECISION]. Must stay zero.
    uint256 public ghost_pOutOfBounds;
    /// @dev P rose between two observations with the scale and the epoch unchanged. Must stay zero.
    uint256 public ghost_pRoseWithinScale;
    /// @dev The epoch fell, or the scale fell within one epoch. Must stay zero.
    uint256 public ghost_scaleOrEpochWentBack;
    /// @dev A deposit, a withdrawal or a claim changed P, the scale or the epoch: only an
    ///      absorption may. Must stay zero.
    uint256 public ghost_pMovedWithoutAbsorption;
    /// @dev Observations in which P fell, a scale change and an epoch reset: what the three
    ///      counters above were actually tested against.
    uint256 public ghost_pDecreases;
    uint256 public ghost_scaleChanges;
    uint256 public ghost_epochResets;
    /// @dev A call the pool must accept and refused: a deposit, a withdrawal of at most the
    ///      effective deposit in a later block, a claim that was owed in a later block, an
    ///      absorption of less than the pool. Must stay zero: a swallowed revert here would
    ///      turn the run's other properties into statements about a pool nobody could use.
    uint256 public ghost_unexpectedReverts;
    /// @dev Steps of the opening sequence (below) that did not go as the pool promises:
    ///      a deposit, an absorption, a later-block claim or withdrawal that failed, or an
    ///      exit in the deposit's block that succeeded. Must stay zero.
    uint256 public ghost_openingFaults;
    bool internal opened;

    /// @dev The size of one deposit unit. 1e18 runs the pool at ordinary sizes, where the
    ///      product's own rounding leaves far more slack than one unit per depositor. 1 runs
    ///      it at a few thousand base units in all, where each depositor's rounding is as
    ///      large as that slack and a compounded deposit rounded the wrong way shows at once.
    uint256 internal immutable UNIT;

    constructor(StabilityPool _pool, GoldStablecoin _gsusd, MockERC20 _paxg, MockERC20 _xaut, uint256 _unit) {
        UNIT = _unit;
        pool = _pool;
        gsusd = _gsusd;
        paxg = _paxg;
        xaut = _xaut;
        lastP = _pool.P();
        lastScale = _pool.currentScale();
        lastEpoch = _pool.currentEpoch();
        for (uint256 i = 0; i < NUM_ACTORS; i++) {
            actors.push(address(uint160(0xD0001 + i)));
        }
    }

    function getActors() external view returns (address[] memory) {
        return actors;
    }

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    function _token(uint256 seed) internal view returns (MockERC20) {
        return seed % 2 == 0 ? paxg : xaut;
    }

    /// @dev Absorbable debt, or 0 when the pool cannot take any. Caps at `totalDeposits - 1`
    ///      to respect the pool's strict-inequality guard (full drain is forbidden).
    function _debt(uint256 debtSeed) internal view returns (uint256) {
        uint256 total = pool.totalDeposits();
        if (total < 2) return 0; // Need at least 2 wei so we can absorb 1 wei.
        return bound(debtSeed, 1, total - 1);
    }

    /// @dev Collateral for `debt` in the token's own decimals, at most about one ounce per
    ///      GSUSD of debt (the 18-decimal amount scaled down for XAUT) and never zero.
    function _collateral(MockERC20 token, uint256 collateralSeed, uint256 debt) internal view returns (uint256) {
        uint256 scale = 10 ** (18 - token.decimals());
        uint256 max = debt / scale;
        return bound(collateralSeed, 1, max == 0 ? 1 : max);
    }

    /// @dev Whether `actor` deposited in the current block. Read through the cheatcode: with
    ///      the IR pipeline `block.number` can be cached across a `vm.roll`.
    function _depositedThisBlock(address actor) internal view returns (bool) {
        return pool.lastDepositBlock(actor) == vm.getBlockNumber();
    }

    function _recordAbsorption(MockERC20 token, uint256 amount, bool prefunded) internal {
        ghost_collateralAbsorbedIn[address(token)] += amount;
        ghost_absorptionsCount++;
        if (prefunded) ghost_prefundedAbsorptions++;
        if (token.decimals() < 18) ghost_sixDecimalAbsorptions++;
    }

    // ==================================================================
    // Opening sequence
    // ==================================================================

    /// @dev Runs once, before the first action of every run. The suite's coverage checks
    ///      require each run to reach a prefunded absorption, a 6-decimal absorption, a
    ///      refused exit in a deposit's block, a claim and a withdrawal. Left to the random
    ///      sequence alone, an occasional run missed one of them (no withdrawal, say, when
    ///      every withdrawal drawn fell in a depositor's own block) and failed for coverage
    ///      rather than for a fault. This sequence performs each of them through the pool's
    ///      real entry points, so every run exercises all five whatever the fuzzer draws
    ///      next, and the checks stay as strict as they were.
    modifier afterOpening() {
        if (!opened) {
            opened = true;
            _open();
        }
        _;
    }

    function _open() internal {
        address actor = actors[0];
        uint256 amount = 10_000 * UNIT;
        gsusd.mint(actor, amount);
        vm.startPrank(actor);
        gsusd.approve(address(pool), amount);
        try pool.deposit(amount) {
            ghost_depositedIn += amount;
        } catch {
            ghost_openingFaults++;
        }
        vm.stopPrank();

        // The path GoldVault.liquidateViaPool takes, with the 6-decimal token: a tenth of
        // the pool absorbed against one ounce.
        uint256 gold = 1_000_000;
        xaut.mint(address(pool), gold);
        try pool.absorbLiquidationPrefunded(address(xaut), pool.totalDeposits() / 10) {
            _recordAbsorption(xaut, gold, true);
        } catch {
            ghost_openingFaults++;
        }

        // In the deposit's block neither exit is open.
        vm.startPrank(actor);
        try pool.withdraw(UNIT) {
            ghost_openingFaults++;
        } catch {
            ghost_sameBlockRefusals++;
        }
        try pool.claimCollateral(address(xaut)) {
            ghost_openingFaults++;
        } catch {
            ghost_sameBlockRefusals++;
        }
        vm.stopPrank();

        // One block later both are.
        vm.roll(vm.getBlockNumber() + 1);
        uint256 before = xaut.balanceOf(actor);
        vm.startPrank(actor);
        try pool.claimCollateral(address(xaut)) {
            ghost_collateralClaimed[address(xaut)] += xaut.balanceOf(actor) - before;
            ghost_claimsCount++;
        } catch {
            ghost_openingFaults++;
        }
        try pool.withdraw(1_000 * UNIT) {
            ghost_withdrawnOut += 1_000 * UNIT;
            ghost_withdrawalsCount++;
        } catch {
            ghost_openingFaults++;
        }
        vm.stopPrank();
        _observe(true);
    }

    // ==================================================================
    // Handler actions
    // ==================================================================

    function deposit(uint256 actorSeed, uint256 amount) external afterOpening {
        address actor = _actor(actorSeed);
        amount = bound(amount, UNIT, 100_000 * UNIT);

        gsusd.mint(actor, amount);

        vm.startPrank(actor);
        gsusd.approve(address(pool), amount);
        try pool.deposit(amount) {
            ghost_depositedIn += amount;
        } catch {
            ghost_unexpectedReverts++;
        }
        vm.stopPrank();

        _observe(false);
    }

    function withdraw(uint256 actorSeed, uint256 amount) external afterOpening {
        address actor = _actor(actorSeed);
        uint256 effective = pool.getEffectiveDeposit(actor);
        if (effective == 0) return;

        amount = bound(amount, 1, effective);

        bool sameBlock = _depositedThisBlock(actor);
        vm.prank(actor);
        try pool.withdraw(amount) {
            ghost_withdrawnOut += amount;
            ghost_withdrawalsCount++;
            if (sameBlock) ghost_sameBlockExits++;
        } catch {
            if (sameBlock) ghost_sameBlockRefusals++;
            else ghost_unexpectedReverts++;
        }
        _observe(false);
    }

    /// @notice A deposit followed at once, in the same block, by an attempt to leave both
    ///         ways: the shape of a capture with borrowed GSUSD. Both must be refused.
    function depositThenTryToLeave(uint256 actorSeed, uint256 amount, uint256 tokenSeed) external afterOpening {
        address actor = _actor(actorSeed);
        MockERC20 token = _token(tokenSeed);
        amount = bound(amount, UNIT, 100_000 * UNIT);
        gsusd.mint(actor, amount);

        vm.startPrank(actor);
        gsusd.approve(address(pool), amount);
        try pool.deposit(amount) {
            ghost_depositedIn += amount;
        } catch {
            ghost_unexpectedReverts++;
            vm.stopPrank();
            return;
        }
        uint256 before = token.balanceOf(actor);
        try pool.withdraw(amount) {
            ghost_withdrawnOut += amount;
            ghost_withdrawalsCount++;
            ghost_sameBlockExits++;
        } catch {
            ghost_sameBlockRefusals++;
        }
        try pool.claimCollateral(address(token)) {
            ghost_collateralClaimed[address(token)] += token.balanceOf(actor) - before;
            ghost_claimsCount++;
            ghost_sameBlockExits++;
        } catch {
            ghost_sameBlockRefusals++;
        }
        vm.stopPrank();
        _observe(false);
    }

    /// @notice Move to a later block, so deposits age and their holders can leave.
    function advanceBlock(uint256 blocks) external afterOpening {
        vm.roll(vm.getBlockNumber() + bound(blocks, 1, 3));
    }

    /// @notice Simulate GoldVault.liquidateViaPool: the silos send the collateral straight
    ///         to the pool, then the vault asks it to absorb the debt.
    function absorbLiquidationPrefunded(uint256 tokenSeed, uint256 debtSeed, uint256 collateralSeed) external afterOpening {
        uint256 debtToAbsorb = _debt(debtSeed);
        if (debtToAbsorb == 0) return;
        MockERC20 token = _token(tokenSeed);
        uint256 collateralAmount = _collateral(token, collateralSeed, debtToAbsorb);

        token.mint(address(pool), collateralAmount);
        try pool.absorbLiquidationPrefunded(address(token), debtToAbsorb) {
            _recordAbsorption(token, collateralAmount, true);
        } catch {
            // Undo the arrival, as a reverted liquidateViaPool would, so no unaccounted gold
            // is left for the next absorption to credit.
            ghost_unexpectedReverts++;
            vm.prank(address(pool));
            token.transfer(address(0xDEAD), collateralAmount);
        }
        _observe(true);
    }

    /// @notice A depositor claims their gain in one token, measured by what they received.
    function claimCollateral(uint256 actorSeed, uint256 tokenSeed) external afterOpening {
        address actor = _actor(actorSeed);
        MockERC20 token = _token(tokenSeed);
        uint256 before = token.balanceOf(actor);
        bool sameBlock = _depositedThisBlock(actor);
        bool owed = pool.getCollateralGain(actor, address(token)) > 0;
        vm.prank(actor);
        try pool.claimCollateral(address(token)) {
            ghost_collateralClaimed[address(token)] += token.balanceOf(actor) - before;
            ghost_claimsCount++;
            if (sameBlock) ghost_sameBlockExits++;
        } catch {
            if (sameBlock && owed) ghost_sameBlockRefusals++;
            // Owed, in a later block, and the pool holds the gold (no wipe in this suite).
            else if (owed) ghost_unexpectedReverts++;
        }
        _observe(false);
    }

    /// @dev Compares the pool's product, scale and epoch with the last observation, counts
    ///      every way the pair may not move, and replaces the observation. `absorbed` says
    ///      whether the action that just ran was allowed to change them at all.
    function _observe(bool absorbed) internal {
        uint256 p = pool.P();
        uint128 scale = pool.currentScale();
        uint128 epoch = pool.currentEpoch();

        if (p < pool.SCALE_FACTOR() || p > pool.PRECISION()) ghost_pOutOfBounds++;
        if (epoch < lastEpoch || (epoch == lastEpoch && scale < lastScale)) ghost_scaleOrEpochWentBack++;
        if (epoch == lastEpoch && scale == lastScale) {
            if (p > lastP) ghost_pRoseWithinScale++;
            if (p < lastP) ghost_pDecreases++;
        }
        if (epoch > lastEpoch) ghost_epochResets++;
        else if (scale > lastScale) ghost_scaleChanges++;
        if (!absorbed && (p != lastP || scale != lastScale || epoch != lastEpoch)) ghost_pMovedWithoutAbsorption++;

        lastP = p;
        lastScale = scale;
        lastEpoch = epoch;
    }
}
