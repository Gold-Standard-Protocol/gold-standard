// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {FullStackHarness} from "./harness/FullStackHarness.sol";

/// @notice The reserve's two sizing views answer what a swap in the same block would do:
///         `remainingDailyCapacity` is zero whenever the oracle would refuse the token
///         (frozen, oracle paused, no reliable price), with or without the aggregate cap,
///         and `quoteGoldOut` is (0, 0) for a paused asset as it is for a refused price.
contract ReserveViewsMatchSwapTest is FullStackHarness {
    address internal swapper = address(0x5A);

    function setUp() public override {
        super.setUp();
        paxg.mint(address(this), 100e18);
        paxg.approve(address(reserve), 100e18);
        reserve.seedCollateral(address(paxg), 100e18);
        _fundGsusd(swapper, 50_000e18);
        vm.prank(swapper);
        gsusd.approve(address(reserve), type(uint256).max);
        assertEq(reserve.aggregateDailyCapUsd(), 0, "the aggregate cap is off, as at launch");
    }

    function _swapReverts(uint256 amount) internal returns (bool reverted) {
        vm.prank(swapper);
        try reserve.swapGsusdForGold(address(paxg), amount, 0) {
            reverted = false;
        } catch {
            reverted = true;
        }
    }

    function _assertRefused() internal {
        assertEq(reserve.remainingDailyCapacity(address(paxg)), 0, "no capacity while a swap is refused");
        (uint256 goldOut, uint256 spread) = reserve.quoteGoldOut(address(paxg), 1_000e18);
        assertEq(goldOut, 0, "no quote while a swap is refused");
        assertEq(spread, 0);
        assertTrue(_swapReverts(1_000e18), "and the swap itself is refused");
    }

    // ------------------------------------------------------------------ capacity

    function test_healthyTokenReportsItsCapacityWithTheAggregateCapOff() public view {
        uint256 capacity = reserve.remainingDailyCapacity(address(paxg));
        // The lower of the gold above the floor and the day's per-asset cap.
        uint256 dayCap = 100e18 * 1_000_000 / 1e6;
        uint256 expected = reserve.redeemableCollateral(address(paxg));
        if (dayCap < expected) expected = dayCap;
        assertEq(capacity, expected);
        assertGt(capacity, 0);
    }

    function test_frozenTokenHasNoCapacityWithTheAggregateCapOff() public {
        oracle.freezeToken(address(paxg));
        _assertRefused();
    }

    function test_pausedOracleHasNoCapacityWithTheAggregateCapOff() public {
        oracle.emergencyPause();
        _assertRefused();
    }

    function test_staleFeedHasNoCapacityWithTheAggregateCapOff() public {
        vm.warp(block.timestamp + 2 days);
        _assertRefused();
    }

    function test_refusalsAlsoZeroTheCapacityWithTheAggregateCapOn() public {
        reserve.setAggregateDailyCap(1_000_000e18);
        assertGt(reserve.remainingDailyCapacity(address(paxg)), 0);
        oracle.freezeToken(address(paxg));
        _assertRefused();
    }

    function test_capacityReturnsWhenTheFreezeLapses() public {
        oracle.freezeToken(address(paxg));
        assertEq(reserve.remainingDailyCapacity(address(paxg)), 0);
        vm.warp(oracle.frozenUntil(address(paxg)));
        _setPrice(PRICE);
        assertGt(reserve.remainingDailyCapacity(address(paxg)), 0);
        assertFalse(_swapReverts(1_000e18));
    }

    function test_anotherTokensFreezeLeavesThisTokensCapacityAlone() public {
        uint256 before = reserve.remainingDailyCapacity(address(paxg));
        oracle.freezeToken(address(xaut));
        assertEq(reserve.remainingDailyCapacity(address(paxg)), before);
    }

    // ------------------------------------------------------------------ quote

    function test_pausedAssetQuotesNothing() public {
        (uint256 before,) = reserve.quoteGoldOut(address(paxg), 1_000e18);
        assertGt(before, 0);
        reserve.pauseAsset(address(paxg));
        _assertRefused();
    }

    function test_quoteReturnsWhenTheAssetPauseLapses() public {
        reserve.pauseAsset(address(paxg));
        vm.warp(block.timestamp + 14 days);
        _setPrice(PRICE);
        (uint256 goldOut, uint256 spread) = reserve.quoteGoldOut(address(paxg), 1_000e18);
        assertGt(goldOut, 0);
        assertGt(spread, 0);
    }

    function test_unpausedQuoteStillMatchesTheSwap() public {
        (uint256 quoted,) = reserve.quoteGoldOut(address(paxg), 1_000e18);
        vm.prank(swapper);
        uint256 got = reserve.swapGsusdForGold(address(paxg), 1_000e18, quoted);
        assertEq(got, quoted);
    }

    // ------------------------------------------------------------------ the quote is what the swap pays

    /// @dev The GSUSD input whose amount after the spread buys exactly `gold` PAXG at `price`,
    ///      and the spread it pays. The amount after the spread lands on the first figure that
    ///      buys `gold` or within two units above it, far inside one unit of gold.
    function _inputForExactGold(uint256 gold, int256 price) internal view returns (uint256 amount, uint256 spread) {
        uint256 netNeeded = Math.mulDiv(gold, uint256(price) * 1e10, 1e18, Math.Rounding.Ceil);
        (, spread) = reserve.quoteGoldOut(address(paxg), Math.mulDiv(netNeeded, 1e6, 1e6 - 20_000));
        amount = Math.mulDiv(netNeeded, 1e6, 1e6 - spread, Math.Rounding.Ceil);
    }

    /// The preview and the swap deduct the spread the same way, to the unit. The input is
    /// sized so the amount after the spread sits exactly on a whole number of gold units while
    /// the spread itself is not whole: one unit of difference in how the spread is rounded
    /// then shows as one unit of gold.
    function testFuzz_quoteEqualsTheGoldTheSwapPays(uint256 gold) public {
        gold = bound(gold, 1e9, 8e18);
        (uint256 amount, uint256 spread) = _inputForExactGold(gold, PRICE);
        // Step back to the smallest input that still buys `gold`: its amount after the spread
        // is then exactly the price of `gold`, with nothing to spare.
        uint256 netNeeded = gold * uint256(PRICE) * 1e10 / 1e18;
        while (amount - Math.mulDiv(amount, spread, 1e6) > netNeeded) amount--;
        vm.assume(amount - Math.mulDiv(amount, spread, 1e6) == netNeeded);
        vm.assume(mulmod(amount, spread, 1e6) != 0);

        (uint256 quoted, uint256 quotedSpread) = reserve.quoteGoldOut(address(paxg), amount);
        vm.assume(quotedSpread == spread);
        uint256 before = paxg.balanceOf(swapper);
        vm.prank(swapper);
        uint256 got = reserve.swapGsusdForGold(address(paxg), amount, 0);
        assertEq(got, quoted, "the swap pays the quoted gold");
        assertEq(paxg.balanceOf(swapper) - before, quoted, "and the swapper holds it");
        assertEq(quoted, gold, "which is the gold the input was sized for");
    }

    /// The quote can be passed straight back as the minimum received, whatever the amount.
    function testFuzz_swapBoundedByItsOwnQuoteSettles(uint256 amount) public {
        amount = bound(amount, 1e15, 40_000e18);
        (uint256 quoted,) = reserve.quoteGoldOut(address(paxg), amount);
        vm.prank(swapper);
        uint256 got = reserve.swapGsusdForGold(address(paxg), amount, quoted);
        assertEq(got, quoted);
    }

    // ------------------------------------------------------------------ capacity against the caps

    function test_capacityAfterAPartialUseIsTheDayStartShareLessTheOutflow() public {
        reserve.setAssetConfig(address(paxg), true, 0, 100_000); // 10% of the day-start balance
        assertEq(reserve.remainingDailyCapacity(address(paxg)), 10e18);
        vm.prank(swapper);
        uint256 got = reserve.swapGsusdForGold(address(paxg), 12_345e18 + 67, 0);
        assertGt(got, 0);
        assertLt(got, 10e18);
        // Still 10% of the 100 PAXG the day began with, less what has left.
        assertEq(reserve.remainingDailyCapacity(address(paxg)), 10e18 - got);

        (uint256 amount,) = _inputForExactGold(10e18 - got, PRICE);
        vm.prank(swapper);
        assertEq(reserve.swapGsusdForGold(address(paxg), amount, 0), 10e18 - got, "the rest of the day's share leaves");
        assertEq(reserve.remainingDailyCapacity(address(paxg)), 0);
        assertEq(reserve.collateralBalance(address(paxg)), 90e18);
    }

    /// The aggregate USD room is converted to gold rounding down, so a swap for exactly the
    /// reported capacity fits under the cap at any cap and any price, to the unit.
    function testFuzz_swapForTheReportedCapacityNeverTripsTheAggregateCap(uint256 capUsd, int256 price) public {
        price = bound(price, 3_700e8, 4_300e8);
        capUsd = bound(capUsd, 1_000e18, 30_000e18);
        _setPrice(price);
        reserve.setAggregateDailyCap(capUsd);

        uint256 capacity = reserve.remainingDailyCapacity(address(paxg));
        assertLt(capacity, reserve.redeemableCollateral(address(paxg)), "the aggregate cap is the binding limit");
        (uint256 amount, uint256 spread) = _inputForExactGold(capacity, price);
        (uint256 quoted, uint256 quotedSpread) = reserve.quoteGoldOut(address(paxg), amount);
        vm.assume(quotedSpread == spread);
        assertEq(quoted, capacity, "the input buys exactly the reported capacity");

        vm.prank(swapper);
        uint256 got = reserve.swapGsusdForGold(address(paxg), amount, 0);
        assertEq(got, capacity);
        assertLe(reserve.dayOutflowUsd(block.timestamp / 1 days), capUsd, "the day's USD outflow is inside the cap");
        // What is left is less than one more unit of gold is worth, or the view understated.
        uint256 left = capUsd - reserve.dayOutflowUsd(block.timestamp / 1 days);
        assertLt(left, Math.mulDiv(2, uint256(price) * 1e10, 1e8, Math.Rounding.Ceil), "the view left room unused");
    }

    // ------------------------------------------------------------------ agreement

    /// A swap sized inside both views goes through; with no capacity, none does.
    function testFuzz_viewsAgreeWithTheSwap(uint256 amount, uint8 state) public {
        amount = bound(amount, 1e18, 40_000e18);
        state = state % 5;
        if (state == 1) oracle.freezeToken(address(paxg));
        if (state == 2) oracle.emergencyPause();
        if (state == 3) reserve.pauseAsset(address(paxg));
        if (state == 4) reserve.setAggregateDailyCap(20_000e18);

        uint256 capacity = reserve.remainingDailyCapacity(address(paxg));
        (uint256 quoted,) = reserve.quoteGoldOut(address(paxg), amount);
        bool reverted = _swapReverts(amount);
        if (state >= 1 && state <= 3) {
            assertEq(capacity, 0);
            assertEq(quoted, 0);
            assertTrue(reverted);
        } else if (quoted > 0 && quoted <= capacity) {
            assertFalse(reverted, "a swap inside the quoted capacity succeeds");
        } else if (quoted > capacity) {
            assertTrue(reverted, "a swap above the capacity is refused");
        }
    }
}
