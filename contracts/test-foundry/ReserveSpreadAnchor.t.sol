// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {FullStackHarness} from "./harness/FullStackHarness.sol";

/// @notice The spread is priced against the higher of the live and day-lagged
///         circulating supply, so a same-day burn cannot buy the cheaper tier while a mint
///         steps up at once and gold entering the reserve counts immediately.
contract ReserveSpreadAnchorTest is FullStackHarness {
    address internal whale = address(0xA11);
    address internal other = address(0xA22);

    /// @dev Warp while keeping the feeds fresh at an unchanged price.
    function _warp(uint256 seconds_) internal {
        vm.warp(block.timestamp + seconds_);
        _setPrice(PRICE);
        oracle.getTokenPrice(address(paxg));
        oracle.getTokenPrice(address(xaut));
    }

    function setUp() public override {
        super.setUp();
        // Reserve holds 25 PAXG ($100k). Other borrowers owe 800k; the whale owes 400k and
        // holds 100k GSUSD to convert: coverage 100k / 1.3M = 7.69%, the 1.25% tier.
        paxg.mint(address(this), 25e18);
        paxg.approve(address(reserve), 25e18);
        reserve.seedCollateral(address(paxg), 25e18);
        _open(other, paxg, 1_000e18, 800_000e18);
        _open(whale, paxg, 500e18, 400_000e18);
        _fundGsusd(whale, 100_000e18);
        // Settle the smoothed supply on this honest state: a day passes.
        _warp(1 days);
    }

    function test_sameDayRepayDoesNotBuyTheCheaperTier() public {
        assertEq(reserve.currentSpreadPpm(), 12_500, "honest tier");
        vm.startPrank(whale);
        gsusd.approve(address(vault), type(uint256).max);
        vault.repay(400_000e18); // coverage now 100k / 900k = 11.1% live
        assertEq(reserve.currentSpreadPpm(), 12_500, "the anchor still prices the old tier");
        gsusd.approve(address(reserve), 100_000e18);
        // A small swap pays the anchored tier; this one empties the reserve, so it pays the
        // restricted tier of the coverage it leaves behind.
        (, uint256 small) = reserve.quoteGoldOut(address(paxg), 1_000e18);
        assertEq(small, 12_500, "a small swap pays the anchored tier");
        (, uint256 quoted) = reserve.quoteGoldOut(address(paxg), 100_000e18);
        assertEq(quoted, 20_000, "draining the reserve pays the restricted tier");
        uint256 out = reserve.swapGsusdForGold(address(paxg), 100_000e18, 0);
        assertEq(out, (100_000e18 - 2_000e18) * 1e8 / uint256(PRICE), "the swap pays what was quoted");
        vm.stopPrank();
    }

    /// The coverage a swap leaves behind is rounded down before the tier is looked up: a
    /// swap that leaves a fraction of a millionth under a threshold pays the dearer tier,
    /// and one unit less of input, leaving exactly the threshold, pays the cheaper one.
    function test_coverageAFractionBelowATierPaysTheDearerTier() public {
        uint256 value = reserve.reserveValueUsd();
        uint256 circulating = reserve.dampedCirculatingSupply();
        // The reserve value that is exactly 2% of the supply, the lowest step of the curve.
        assertEq(circulating * 20_000 % 1e6, 0, "the threshold is a whole figure in this setup");
        uint256 atThreshold = circulating * 20_000 / 1e6;
        uint256 toThreshold = value - atThreshold;

        (, uint256 onIt) = reserve.quoteGoldOut(address(paxg), toThreshold);
        assertEq(onIt, 12_500, "leaving exactly 2% pays that step");
        (, uint256 justUnder) = reserve.quoteGoldOut(address(paxg), toThreshold + 1);
        assertEq(justUnder, 20_000, "leaving a fraction under 2% pays the restricted spread");

        uint256 amount = toThreshold + 1;
        vm.startPrank(whale);
        gsusd.approve(address(reserve), amount);
        uint256 out = reserve.swapGsusdForGold(address(paxg), amount, 0);
        vm.stopPrank();
        assertEq(out, (amount - amount * 20_000 / 1e6) * 1e8 / uint256(PRICE), "and the swap charges it");
    }

    function test_aRiseInCoverageEarnsTheTierAfterADay() public {
        vm.startPrank(whale);
        gsusd.approve(address(vault), type(uint256).max);
        vault.repay(400_000e18);
        vm.stopPrank();
        _warp(12 hours);
        emit log_named_uint("live coverage ppm", reserve.coveragePpm());
        emit log_named_uint("damped coverage ppm at 12h", reserve.dampedCoveragePpm());
        assertEq(reserve.currentSpreadPpm(), 12_500, "half way there, still the old tier");
        _warp(12 hours);
        emit log_named_uint("damped coverage ppm at 24h", reserve.dampedCoveragePpm());
        assertEq(reserve.currentSpreadPpm(), 5_000, "a day later the live coverage applies");
    }

    function test_aDropInCoverageStepsUpAtOnce() public {
        // Start at the cheap tier: a 100k circulating supply against $100k of gold.
        vm.startPrank(other);
        gsusd.approve(address(vault), type(uint256).max);
        vault.repay(800_000e18);
        vm.stopPrank();
        vm.startPrank(whale);
        gsusd.approve(address(vault), type(uint256).max);
        vault.repay(300_000e18);
        vm.stopPrank();
        _warp(1 days);
        assertEq(reserve.currentSpreadPpm(), 5_000);
        // Minting 1.2M more drops coverage to under 8%: the spread rises immediately.
        vm.prank(other);
        vault.mint(1_200_000e18);
        assertEq(reserve.currentSpreadPpm(), 12_500, "a drop is never damped");
    }

    function test_goldEnteringTheReserveCountsAtOnce() public {
        assertEq(reserve.currentSpreadPpm(), 12_500);
        // Another 25 PAXG doubles coverage to 15.4%: the cheaper tier applies immediately.
        paxg.mint(address(this), 25e18);
        paxg.approve(address(reserve), 25e18);
        reserve.seedCollateral(address(paxg), 25e18);
        assertEq(reserve.currentSpreadPpm(), 5_000, "funding the reserve is never damped");
    }
}
