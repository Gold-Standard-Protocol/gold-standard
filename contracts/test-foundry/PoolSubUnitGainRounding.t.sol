// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import "forge-std/Test.sol";
import {StabilityPool} from "../src/core/StabilityPool.sol";
import {GoldStablecoin} from "../src/core/GoldStablecoin.sol";
import {MockERC20} from "../src/test/mocks/MockERC20.sol";

/// @notice The pool carries collateral gains at 18 decimals inside its sums, so a 6-decimal
///         token's gain per unit staked does not vanish. When a depositor's position is
///         refreshed (a deposit, a withdrawal or a claim), the gain earned since the last
///         refresh is rounded DOWN to the token's own decimals and the part below one base
///         unit is not carried forward: it stays in the pool, assigned to nobody. The gain
///         per unit staked is also rounded down when a liquidation is absorbed, so the two
///         roundings together drop up to one base unit (0.000001 XAUT) per depositor per
///         refresh, and only ever against the depositor, never against the pool.
contract PoolSubUnitGainRoundingTest is Test {
    StabilityPool internal pool;
    GoldStablecoin internal gsusd;
    MockERC20 internal xaut;

    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0B);
    address internal carol = address(0xCA201);

    /// One base unit of the 6-decimal token, in the pool's 18-decimal gain units.
    uint256 internal constant UNIT18 = 1e12;
    /// Rounding inside the 18-decimal sums themselves, far below a base unit.
    uint256 internal constant SUM_DUST18 = 1e6;

    function setUp() public {
        gsusd = new GoldStablecoin();
        pool = new StabilityPool(address(gsusd));
        xaut = new MockERC20("Tether Gold", "XAUT", 6);
        pool.addCollateralToken(address(xaut));
        gsusd.grantRole(gsusd.MINTER_ROLE(), address(this));
        pool.grantRole(pool.VAULT_ROLE(), address(this));
    }

    function _deposit(address who, uint256 amount) internal {
        gsusd.mint(who, amount);
        vm.startPrank(who);
        gsusd.approve(address(pool), amount);
        pool.deposit(amount);
        vm.stopPrank();
    }

    /// @dev A liquidation as the vault sends it: the gold arrives, then the debt is absorbed.
    function _absorb(uint256 debt, uint256 gold) internal {
        xaut.mint(address(pool), gold);
        pool.absorbLiquidationPrefunded(address(xaut), debt);
    }

    /// @dev Claim in a later block than any deposit. A claim with nothing to pay reverts and
    ///      so refreshes nothing.
    function _claim(address who) internal {
        vm.roll(vm.getBlockNumber() + 1);
        vm.prank(who);
        try pool.claimCollateral(address(xaut)) {} catch {}
    }

    /// @dev Refresh a position whatever it is owed: a one wei top-up settles the gain earned
    ///      so far and re-anchors the position.
    function _refresh(address who) internal {
        _deposit(who, 1);
    }

    function test_oneRefreshDropsLessThanOneBaseUnit() public {
        // Three depositors in thirds; 1.000001 XAUT cannot be split three ways in base units.
        _deposit(alice, 1_000e18);
        _deposit(bob, 1_000e18);
        _deposit(carol, 1_000e18);
        _absorb(300e18, 1_000_001);

        // Each is owed 333,333.666... base units and is credited 333,333.
        uint256 credited = pool.getCollateralGain(alice, address(xaut));
        assertEq(credited, 333_333);
        uint256 owed18 = uint256(1_000_001) * UNIT18 / 3;
        assertLe(credited * UNIT18, owed18, "never more than owed");
        assertLt(owed18 - credited * UNIT18, UNIT18, "less than one base unit dropped");

        _claim(alice);
        _claim(bob);
        _claim(carol);
        assertEq(xaut.balanceOf(alice) + xaut.balanceOf(bob) + xaut.balanceOf(carol), 999_999);
        // The two base units nobody was credited stay in the pool, unassigned.
        assertEq(xaut.balanceOf(address(pool)), 2);
        assertEq(pool.collateralAccounted(address(xaut)), 2);
        assertEq(pool.getCollateralGain(alice, address(xaut)), 0);
    }

    function test_theRemainderIsNotCarriedToTheNextRefresh() public {
        // Alice refreshes after every absorption, Bob once at the end. Each absorption owes
        // each of them about 1.5 base units: Alice is credited 1 each time and the half is
        // dropped, Bob's halves add up before they are rounded once. (Alice's one wei
        // top-ups tilt the split by a hair, so Bob's total is a shade under 15.)
        _deposit(alice, 1_000e18);
        _deposit(bob, 1_000e18);
        for (uint256 i = 0; i < 10; i++) {
            _absorb(1e18, 3);
            _refresh(alice);
        }
        assertEq(pool.getCollateralGain(alice, address(xaut)), 10, "ten refreshes, a half dropped at each");
        assertEq(pool.getCollateralGain(bob, address(xaut)), 14, "one refresh, under one unit dropped in all");
        _claim(alice);
        _claim(bob);
        assertEq(xaut.balanceOf(alice), 10);
        assertEq(xaut.balanceOf(bob), 14);
        // Alice dropped about half a base unit on each of ten refreshes, below one each
        // time. What nobody was credited stays in the pool, assigned to nobody.
        assertEq(xaut.balanceOf(address(pool)), 6);
        assertEq(pool.collateralAccounted(address(xaut)), 6);
    }

    /// For any deposits and any absorption, one refresh credits no more than the exact
    /// share and drops less than one base unit of it.
    function testFuzz_dropPerRefreshIsAtMostOneBaseUnit(uint256 a, uint256 b, uint256 gold, uint256 debtSeed) public {
        a = bound(a, 100e18, 1_000_000e18);
        b = bound(b, 100e18, 1_000_000e18);
        gold = bound(gold, 1, 1_000_000_000); // up to 1,000 XAUT
        _deposit(alice, a);
        _deposit(bob, b);
        uint256 total = a + b;
        uint256 debt = bound(debtSeed, 1e18, total / 2);
        _absorb(debt, gold);

        _assertShare(alice, a, total, gold);
        _assertShare(bob, b, total, gold);
        // What the two are credited never exceeds what arrived.
        assertLe(
            pool.getCollateralGain(alice, address(xaut)) + pool.getCollateralGain(bob, address(xaut)),
            gold,
            "credited above what the pool received"
        );
    }

    /// An exact share that is a whole number of base units still loses one: the per-unit gain
    /// rounds down first, which leaves the share just under the unit the conversion needs.
    // ------------------------------------------------------------------ compounded deposits round down

    /// At sizes of a few units the per-depositor rounding is as large as the pool itself.
    /// Each compounded deposit is rounded down, so together they never claim more GSUSD
    /// than the pool still holds, and every depositor can leave in full.
    function test_compoundedDepositsNeverSumAboveThePool_atDustSizes() public {
        _deposit(alice, 1);
        _deposit(bob, 5);
        _absorb(2, 1e6);
        assertEq(pool.totalDeposits(), 4);
        // Two thirds of each deposit is left: 0.66 of a unit and 3.33 units, rounded down.
        assertEq(pool.getEffectiveDeposit(alice), 0);
        assertEq(pool.getEffectiveDeposit(bob), 3);
        assertLe(pool.getEffectiveDeposit(alice) + pool.getEffectiveDeposit(bob), pool.totalDeposits());

        vm.roll(vm.getBlockNumber() + 1);
        vm.prank(bob);
        pool.withdraw(type(uint256).max);
        vm.prank(alice);
        pool.withdraw(type(uint256).max);
        assertEq(gsusd.balanceOf(bob), 3, "bob left with its whole compounded deposit");
        assertEq(gsusd.balanceOf(alice), 0);
        assertEq(pool.totalDeposits(), 1, "the unit lost to rounding stays in the pool");
    }

    /// The same across one scale change, where the compounded deposit is divided once more:
    /// 3e18 + 1,234,567,890 and 2e18 + 8,765,432,110 with one part in 1e10 of the pool left
    /// are 300,000,000.12 and 200,000,000.88 units, rounded down.
    function test_compoundedDepositAcrossAScaleChangeRoundsDown() public {
        uint256 a = 3e18 + 1_234_567_890;
        uint256 b = 2e18 + 8_765_432_110;
        _deposit(alice, a);
        _deposit(bob, b);
        uint256 total = a + b; // 5e18 + 1e10
        _absorb(total - total / 1e8, 1e6); // the product falls to 1e10
        _absorb(total / 1e8 - total / 1e10, 1e6); // a hundredth of that left: the scale changes
        assertEq(pool.currentScale(), 1);
        assertEq(pool.currentEpoch(), 0);
        assertEq(pool.totalDeposits(), 500_000_001);

        assertEq(pool.getEffectiveDeposit(alice), 300_000_000);
        assertEq(pool.getEffectiveDeposit(bob), 200_000_000);
        assertLe(pool.getEffectiveDeposit(alice) + pool.getEffectiveDeposit(bob), pool.totalDeposits());

        vm.roll(vm.getBlockNumber() + 1);
        vm.prank(alice);
        pool.withdraw(type(uint256).max);
        vm.prank(bob);
        pool.withdraw(type(uint256).max);
        assertEq(gsusd.balanceOf(alice), 300_000_000);
        assertEq(gsusd.balanceOf(bob), 200_000_000);
        assertEq(pool.totalDeposits(), 1);
    }

    function test_equalSplitOfOneTokenDropsExactlyOneBaseUnitEach() public {
        _deposit(alice, 150e18);
        _deposit(bob, 150e18);
        _absorb(100e18, 1e6);

        assertEq(pool.getCollateralGain(alice, address(xaut)), 499_999, "alice is credited 0.499999");
        assertEq(pool.getCollateralGain(bob, address(xaut)), 499_999, "bob is credited 0.499999");
        assertEq(
            xaut.balanceOf(address(pool)) - pool.getCollateralGain(alice, address(xaut)) - pool.getCollateralGain(bob, address(xaut)),
            2,
            "two base units stay in the pool"
        );
    }

    function _assertShare(address who, uint256 stake, uint256 total, uint256 gold) internal view {
        uint256 credited18 = pool.getCollateralGain(who, address(xaut)) * UNIT18;
        uint256 owed18 = gold * UNIT18 * stake / total;
        assertLe(credited18, owed18, "credited above the exact share");
        assertLt(owed18 - credited18, UNIT18 + SUM_DUST18, "dropped more than a base unit");
    }
}
