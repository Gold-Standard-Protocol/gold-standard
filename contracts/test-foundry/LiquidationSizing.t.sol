// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {FullStackHarness} from "./harness/FullStackHarness.sol";
import {StabilityPool} from "../src/core/StabilityPool.sol";

/// @notice The penalty gives way before the debt. A vault whose gold still covers its
///         debt is never booked as bad debt; a partial may neither empty the vault nor strand
///         a position below MIN_DEBT; a repayment that moves no collateral is refused.
contract LiquidationSizingTest is FullStackHarness {
    address internal borrower = address(0xB0B);
    address internal liquidator = address(0x11);
    address internal depositor = address(0xD1);

    function _fundBuffer(uint256 amount) internal {
        _fundGsusd(address(this), amount);
        gsusd.approve(address(buffer), amount);
        buffer.grantRole(buffer.VAULT_ROLE(), address(this));
        buffer.depositFee(amount);
    }

    /// 0.75 XAUT against 2000 GSUSD, gold walked to $2746.67: worth $2060, ratio 103%.
    function _thinSolventVault() internal {
        _open(borrower, xaut, 750_000, 2000e18);
        _fundBuffer(1000e18);
        _walkPrice(274667e6);
    }

    function test_solventVaultBetween100And105PercentBooksNoBadDebt() public {
        _thinSolventVault();
        uint256 bufferBefore = buffer.gsusdBalance();

        _fundGsusd(liquidator, 3000e18);
        vm.startPrank(liquidator);
        gsusd.approve(address(vault), type(uint256).max);
        uint256 gsusdBefore = gsusd.balanceOf(liquidator);
        vault.liquidate(borrower, 0);
        vm.stopPrank();

        (, uint256 coll, uint256 debt) = _vault(borrower);
        assertEq(coll, 0, "all collateral leaves");
        assertEq(debt, 0, "all debt is repaid");
        assertEq(vault.totalBadDebt(), 0, "a solvent vault books no bad debt");
        assertEq(buffer.gsusdBalance(), bufferBefore, "the buffer burns nothing");
        assertEq(gsusdBefore - gsusd.balanceOf(liquidator), 2000e18, "the liquidator pays the whole debt");
        // The liquidator's bonus comes only from what is left above the debt's value.
        uint256 price = 274667e6;
        uint256 debtEquivalent = (uint256(2000e18) * 1e8) / (price * 1e12);
        uint256 penalty = 750_000 - debtEquivalent;
        uint256 bonus = (penalty * vault.liquidatorIncentiveShare()) / 1_000_000;
        assertEq(xaut.balanceOf(liquidator), debtEquivalent + bonus, "bonus is the reduced penalty's share");
        assertLt(penalty, (debtEquivalent * 50_000) / 1_000_000, "the penalty was cut, not the debt");
    }

    function test_insolventVaultBooksExactlyTheMissingValue() public {
        _open(borrower, xaut, 750_000, 2000e18);
        _fundBuffer(1000e18);
        // $2533.33: 0.75 XAUT is worth $1900, 100 GSUSD short of the debt.
        _walkPrice(253333e6);
        uint256 bufferBefore = buffer.gsusdBalance();

        _fundGsusd(liquidator, 3000e18);
        vm.startPrank(liquidator);
        gsusd.approve(address(vault), type(uint256).max);
        uint256 gsusdBefore = gsusd.balanceOf(liquidator);
        vault.liquidate(borrower, 0);
        vm.stopPrank();

        uint256 price = 253333e6;
        uint256 coverable = (uint256(750_000) * price * 1e12) / 1e8;
        // Underwater gold sells at the governed discount (2% at deploy), so the call pays.
        uint256 paid = (coverable * (1e6 - vault.underwaterDiscountPpm())) / 1e6;
        assertEq(gsusdBefore - gsusd.balanceOf(liquidator), paid, "pays what the gold is worth less the discount");
        // The discount is split like a penalty: the liquidator gets the debt's worth of gold plus
        // its incentive share of the rest, the protocol the remainder.
        uint256 debtEq = (paid * 1e8) / (price * 1e12);
        uint256 expectedGold = debtEq + ((750_000 - debtEq) * vault.liquidatorIncentiveShare()) / 1e6;
        assertEq(xaut.balanceOf(liquidator), expectedGold, "receives the debt's worth plus its share of the discount");
        assertApproxEqAbs(bufferBefore - buffer.gsusdBalance(), 2000e18 - paid, 1e12, "bad debt is the shortfall plus the discount");
        (, uint256 coll, uint256 debt) = _vault(borrower);
        assertEq(coll, 0);
        assertEq(debt, 0);
    }

    function test_borrowerCannotBePaidByTheBufferToWalkAway() public {
        _thinSolventVault();
        uint256 bufferBefore = buffer.gsusdBalance();
        _fundGsusd(borrower, 100e18);
        vm.startPrank(borrower);
        gsusd.approve(address(pool), 2100e18);
        pool.deposit(2100e18);
        vault.liquidateViaPool(borrower, 0);
        vm.roll(block.number + 1); // a deposit cannot leave in its own block (JIT guard)
        pool.withdraw(type(uint256).max);
        pool.claimCollateral(address(xaut));
        vm.stopPrank();
        assertEq(buffer.gsusdBalance(), bufferBefore, "the buffer pays nothing");
        // The pool paid the full 2000 debt out of the borrower's own deposit.
        assertLe(gsusd.balanceOf(borrower), 100e18, "no debt is forgiven");
    }

    /// A thin partial is pro rata, so one that would all but empty
    ///      the vault now meets the MIN_DEBT floor instead of the old blanket refusal.
    function test_partialThatWouldEmptyTheVaultIsRefused() public {
        _thinSolventVault();
        uint256 currentDebt = vault.getVaultCurrentDebt(borrower);
        _fundGsusd(liquidator, 3000e18);
        vm.startPrank(liquidator);
        gsusd.approve(address(vault), type(uint256).max);
        vm.expectRevert(bytes("Residual debt below minimum"));
        vault.liquidate(borrower, currentDebt - 1e18);
        vm.stopPrank();
    }

    function test_partialLeavingDustIsRefusedAndAHealthyResidualIsNot() public {
        _open(borrower, xaut, 750_000, 2000e18);
        _walkPrice(292000e6); // $2190 of gold, ratio 109.5%
        uint256 currentDebt = vault.getVaultCurrentDebt(borrower);
        _fundGsusd(liquidator, 3000e18);
        vm.startPrank(liquidator);
        gsusd.approve(address(vault), type(uint256).max);
        vm.expectRevert(bytes("Residual debt below minimum"));
        vault.liquidate(borrower, currentDebt - 1e15);
        vault.liquidate(borrower, currentDebt - 500e18);
        vm.stopPrank();
        (, , uint256 debt) = _vault(borrower);
        assertEq(debt, 500e18, "a residual at or above MIN_DEBT is allowed");
    }

    /// The residual rule is "at least the minimum debt": a partial that leaves exactly the
    /// minimum is accepted, and one unit more repaid, leaving one unit less, is refused.
    function test_partialLeavingExactlyTheMinimumDebtIsAccepted() public {
        _open(borrower, xaut, 750_000, 2000e18);
        _walkPrice(292000e6); // $2190 of gold, ratio 109.5%
        uint256 currentDebt = vault.getVaultCurrentDebt(borrower);
        assertEq(currentDebt, 2000e18, "no fee in this suite, so debt and principal agree");
        uint256 minDebt = vault.minDebt();
        _fundGsusd(liquidator, 3000e18);
        vm.startPrank(liquidator);
        gsusd.approve(address(vault), type(uint256).max);
        vm.expectRevert(bytes("Residual debt below minimum"));
        vault.liquidate(borrower, currentDebt - minDebt + 1);
        vault.liquidate(borrower, currentDebt - minDebt);
        vm.stopPrank();
        (, uint256 coll, uint256 debt) = _vault(borrower);
        assertEq(debt, minDebt, "exactly the minimum debt is left");
        assertGt(coll, 0);
    }

    /// A vault whose gold is worth exactly its debt is not under water: a partial is taken
    /// pro rata, as it is anywhere inside the penalty band, and books no bad debt.
    function test_partialAtExactlyOneHundredPercentIsProRata() public {
        _open(borrower, paxg, 1e18, 2000e18);
        _walkPrice(2000e8); // 1 PAXG is worth exactly the 2,000 owed
        assertEq(vault.getVaultCurrentDebt(borrower), 2000e18);
        _fundGsusd(liquidator, 3000e18);
        vm.startPrank(liquidator);
        gsusd.approve(address(vault), type(uint256).max);
        uint256 goldBefore = paxg.balanceOf(liquidator);
        uint256 paidBefore = gsusd.balanceOf(liquidator);
        vault.liquidate(borrower, 1000e18);
        vm.stopPrank();

        (, uint256 coll, uint256 debt) = _vault(borrower);
        assertEq(debt, 1000e18, "half the debt is left");
        assertEq(coll, 0.5e18, "and half the gold");
        assertEq(paidBefore - gsusd.balanceOf(liquidator), 1000e18);
        assertEq(paxg.balanceOf(liquidator) - goldBefore, 0.5e18, "the liquidator is paid at par, with no penalty to take");
        assertEq(vault.totalBadDebt(), 0);
    }

    /// One unit under 100% the vault is under water and only a full liquidation is taken.
    function test_partialOneUnitUnderOneHundredPercentIsRefused() public {
        _open(borrower, paxg, 1e18, 2000e18);
        _walkPrice(2000e8 - 1);
        _fundGsusd(liquidator, 3000e18);
        vm.startPrank(liquidator);
        gsusd.approve(address(vault), type(uint256).max);
        vm.expectRevert(bytes("Thin vault: liquidate in full"));
        vault.liquidate(borrower, 1000e18);
        vm.stopPrank();
    }

    function test_oneWeiPoolAbsorbIsRefused() public {
        _open(borrower, xaut, 750_000, 2000e18);
        _walkPrice(292000e6);
        _fundGsusd(depositor, 200e18);
        vm.startPrank(depositor);
        gsusd.approve(address(pool), 2e18);
        pool.deposit(2e18);
        vm.stopPrank();
        vm.expectRevert(bytes("Liquidation too small"));
        vault.liquidateViaPool(borrower, 1);
    }

    function test_emergencyPathSizesTheSameWay() public {
        _thinSolventVault();
        _fundGsusd(liquidator, 3000e18);
        vault.emergencyPause();
        vm.startPrank(liquidator);
        gsusd.approve(address(vault), type(uint256).max);
        vault.emergencyLiquidate(borrower, 0);
        vm.stopPrank();
        assertEq(vault.totalBadDebt(), 0, "no phantom bad debt on the emergency path either");
    }

    /// Below 100% plus the penalty a partial is
    ///        taken pro rata. The shape that stranded a vault (the largest partial that fitted
    ///        at the full penalty multiple) now meets the MIN_DEBT floor on all three paths; a
    ///        partial with a real residual takes the same share of the gold as of the debt and
    ///        leaves the ratio where it was; the full liquidation takes everything and books no
    ///        bad debt.
    function test_partialBelowPenaltyBandIsProRataOnEveryPath() public {
        _thinSolventVault(); // 103%
        uint256 currentDebt = vault.getVaultCurrentDebt(borrower);
        // The largest partial whose own seizure would fit at the full penalty multiple.
        uint256 price = 274667e6;
        uint256 fits = (uint256(750_000) * price * 1e12 * 1e6) / (1e8 * 1_050_000);
        while ((fits * 1_050_000 * 1e8) / (price * 1e12 * 1e6) > 750_000) fits -= 1;
        assertLt(fits, currentDebt, "it is a partial");

        _fundGsusd(liquidator, 3000e18);
        vm.startPrank(liquidator);
        gsusd.approve(address(vault), type(uint256).max);
        vm.expectRevert(bytes("Residual debt below minimum"));
        vault.liquidate(borrower, fits);
        vm.stopPrank();

        _fundGsusd(depositor, 3000e18);
        vm.startPrank(depositor);
        gsusd.approve(address(pool), 3000e18);
        pool.deposit(3000e18);
        vm.stopPrank();
        vm.expectRevert(bytes("Residual debt below minimum"));
        vault.liquidateViaPool(borrower, fits);

        vault.emergencyPause();
        uint256 ratioBefore = vault.getCollateralisationRatio(borrower);
        vm.startPrank(liquidator);
        vm.expectRevert(bytes("Residual debt below minimum"));
        vault.emergencyLiquidate(borrower, fits);
        vault.emergencyLiquidate(borrower, currentDebt / 2);
        (, uint256 coll, uint256 debt) = _vault(borrower);
        assertEq(coll, 375_000, "half the debt takes half the gold");
        assertEq(debt, currentDebt - currentDebt / 2);
        assertGe(vault.getCollateralisationRatio(borrower), ratioBefore, "the ratio is not worsened");
        vault.emergencyLiquidate(borrower, 0);
        vm.stopPrank();
        (, coll, debt) = _vault(borrower);
        assertEq(coll, 0, "the full liquidation takes everything");
        assertEq(debt, 0, "and retires everything");
        assertEq(vault.totalBadDebt(), 0, "without bad debt");
    }

    function test_partialJustAbovePenaltyBandIsAccepted() public {
        _open(borrower, xaut, 750_000, 2000e18);
        _walkPrice(284000e6); // $2130 of gold, 106.5%
        uint256 currentDebt = vault.getVaultCurrentDebt(borrower);
        _fundGsusd(liquidator, 3000e18);
        vm.startPrank(liquidator);
        gsusd.approve(address(vault), type(uint256).max);
        vault.liquidate(borrower, currentDebt - 500e18);
        vm.stopPrank();
        (, uint256 coll, uint256 debt) = _vault(borrower);
        assertEq(debt, 500e18, "a partial above the line retires what was asked");
        assertGt(coll, 0, "and leaves gold behind");
        assertEq(vault.totalBadDebt(), 0);
    }

    /// A borrower who is the pool's only depositor and the keeper liquidates their own
    ///        vault a hair under water. With a flat 2% discount they took every gram back,
    ///        cleared the debt and kept 28.58 GSUSD paid by the buffer. Capped at the
    ///        shortfall, the buffer pays at most twice the hole.
    function test_selfLiquidationJustUnderwaterGetsNoBufferBonus() public {
        _open(borrower, xaut, ONE_XAUT, 1428.57e18);
        _fundBuffer(1000e18);
        _walkPrice(1428.56e8); // gold worth 1428.56 against 1428.57 of debt
        uint256 hole = 0.01e18;
        uint256 bufferBefore = buffer.gsusdBalance();

        _fundGsusd(borrower, 100e18);
        vm.startPrank(borrower);
        gsusd.approve(address(pool), type(uint256).max);
        pool.deposit(1528.57e18);
        vault.liquidateViaPool(borrower, 0);
        vm.roll(block.number + 1);
        pool.withdraw(type(uint256).max);
        pool.claimCollateral(address(xaut));
        vm.stopPrank();

        uint256 bufferPaid = bufferBefore - buffer.gsusdBalance();
        assertLe(bufferPaid, 2 * hole + 1e15, "the buffer pays at most twice the shortfall");
        assertLe(gsusd.balanceOf(borrower), 100e18 + 2 * hole, "the borrower keeps no bonus");
    }

    /// Deep under water the governed discount still applies in full.
    function test_deepUnderwaterKeepsTheFullDiscount() public {
        _open(borrower, xaut, ONE_XAUT, 2000e18);
        _walkPrice(1800e8); // 90%
        _fundGsusd(liquidator, 3000e18);
        vm.startPrank(liquidator);
        gsusd.approve(address(vault), type(uint256).max);
        uint256 before = gsusd.balanceOf(liquidator);
        vault.liquidate(borrower, 0);
        vm.stopPrank();
        assertEq(before - gsusd.balanceOf(liquidator), 1764e18, "1800 less the 2% discount");
    }

    /// The discounted repayment is rounded down. 1.000000000010000001 PAXG at
    /// 1,800.00000013 is worth 1,800.000000148000001801 USD, and 98% of that is not a whole
    /// number of units: the liquidator pays the figure below it.
    function test_underwaterRepaymentIsTheDiscountedValueRoundedDown() public {
        _open(borrower, paxg, 1e18 + 10_000_001, 2000e18);
        _walkPrice(180_000_000_013);
        uint256 worth = 1_800_000_000_148_000_001_801;
        assertTrue(mulmod(worth, 980_000, 1e6) != 0, "98% of the gold's value is not whole");
        _fundGsusd(liquidator, 3000e18);
        vm.startPrank(liquidator);
        gsusd.approve(address(vault), type(uint256).max);
        uint256 before = gsusd.balanceOf(liquidator);
        vault.liquidate(borrower, 0);
        vm.stopPrank();
        assertEq(before - gsusd.balanceOf(liquidator), 1_764_000_000_145_040_001_764, "98% of the value, rounded down");
        assertEq(vault.totalBadDebt(), 2000e18 - 1_764_000_000_145_040_001_764, "the rest of the debt is booked");
    }

    /// Gold worth under half the debt still liquidates at the governed discount.
    function test_vaultBelowHalfItsDebtLiquidates() public {
        _open(borrower, xaut, ONE_XAUT, 2000e18);
        _walkPrice(900e8); // 45%
        _fundGsusd(liquidator, 3000e18);
        vm.startPrank(liquidator);
        gsusd.approve(address(vault), type(uint256).max);
        uint256 before = gsusd.balanceOf(liquidator);
        vault.liquidate(borrower, 0);
        vm.stopPrank();
        assertEq(before - gsusd.balanceOf(liquidator), 882e18, "900 less the 2% discount");
    }

    /// The discount is the shortfall when the shortfall is smaller.
    function test_shallowUnderwaterDiscountIsTheShortfall() public {
        _open(borrower, xaut, ONE_XAUT, 2000e18);
        _walkPrice(1980e8); // 99%: shortfall 1%, under the 2% discount
        _fundGsusd(liquidator, 3000e18);
        vm.startPrank(liquidator);
        gsusd.approve(address(vault), type(uint256).max);
        uint256 before = gsusd.balanceOf(liquidator);
        vault.liquidate(borrower, 0);
        vm.stopPrank();
        assertEq(before - gsusd.balanceOf(liquidator), 1960e18, "1980 less the 20 shortfall");
    }

    /// The pool needs to cover what it will absorb, not the nominal debt.
    function test_underwaterPoolCoveringTheDiscountedRepaymentLiquidates() public {
        _open(borrower, xaut, ONE_XAUT, 2000e18);
        _fundBuffer(1000e18);
        _walkPrice(1800e8);
        uint256 repay = 1764e18;

        _fundGsusd(depositor, repay + 1);
        vm.startPrank(depositor);
        gsusd.approve(address(pool), type(uint256).max);
        pool.deposit(repay);
        vm.stopPrank();
        vm.expectRevert(bytes("Pool insufficient"));
        vault.liquidateViaPool(borrower, 0);

        vm.prank(depositor);
        pool.deposit(1);
        vault.liquidateViaPool(borrower, 0);
        (, uint256 coll, uint256 debt) = _vault(borrower);
        assertEq(coll, 0);
        assertEq(debt, 0);
        assertEq(pool.getTotalDeposits(), 1, "the pool paid the discounted repayment only");
    }

    function test_setStabilityPoolRefusesAPoolThatHasNotGrantedTheVault() public {
        StabilityPool fresh = new StabilityPool(address(gsusd));
        vm.expectRevert(bytes("Pool has not granted VAULT_ROLE"));
        vault.setStabilityPool(address(fresh));
        fresh.grantRole(fresh.VAULT_ROLE(), address(vault));
        vault.setStabilityPool(address(fresh));
        assertEq(address(vault.stabilityPool()), address(fresh));
    }
}
