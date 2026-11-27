// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {FullStackHarness} from "./harness/FullStackHarness.sol";
import {MockAggregatorV3} from "../src/test/mocks/MockAggregatorV3.sol";

/// @notice The two source rules of docs/ORACLE_IMPLEMENTATION_PLAN.md sections 3 and 4: C is the
///         token's Chainlink market feed, G is Chainlink XAU/USD. The gold band g gates borrowing
///         and reserve swaps; liquidation prices at min(max(C, G), G x (1 + m)) with m the
///         liquidation cap. One test per row of the state matrix, on the borrow, liquidation,
///         reserve and emergency paths, then the scenarios the owner named. Whenever C or G is
///         unhealthy every priced path refuses; nothing stands in for either.
/// A feed that answers latestRoundData with `words` words of return data.
contract ReturnBombFeed {
    uint256 public immutable words;

    constructor(uint256 w) {
        words = w;
    }

    function decimals() external pure returns (uint8) {
        return 8;
    }

    fallback() external {
        uint256 w = words;
        assembly {
            return(0, mul(w, 32))
        }
    }
}

contract OracleClampTest is FullStackHarness {
    MockAggregatorV3 internal anchor;
    address internal borrower = address(0xB0B);
    address internal liquidator = address(0x11);
    address internal buyer = address(0xB1);

    uint256 internal constant G = 4000e8;

    function setUp() public override {
        super.setUp();
        _fundGsusd(liquidator, 20_000e18);
        _fundGsusd(buyer, 20_000e18);
        anchor = new MockAggregatorV3(8);
        _push(anchor, int256(G));
        oracle.setAnchorFeed(address(anchor));
        oracle.grantGuardianRole(address(this));
        vm.prank(liquidator);
        gsusd.approve(address(vault), type(uint256).max);
        vm.prank(buyer);
        gsusd.approve(address(reserve), type(uint256).max);
    }

    // ---------- helpers ----------

    function _stale(MockAggregatorV3 feed, int256 price) internal {
        feed.setLatestRoundData(1, price, block.timestamp - 100_000, block.timestamp - 100_000, 1);
    }

    /// @dev PAXG's C and gold; XAUT follows gold so it stays untouched.
    function _set(uint256 c, uint256 g) internal {
        _push(paxgFeed, int256(c));
        _push(anchor, int256(g));
        _push(xautFeed, int256(g));
    }

    function _at(uint256 price, uint256 ppmBelow) internal pure returns (uint256) {
        return price * (1e6 - ppmBelow) / 1e6;
    }

    function _over(uint256 price, uint256 ppmAbove) internal pure returns (uint256) {
        return price * (1e6 + ppmAbove) / 1e6;
    }

    function _liq(uint256 expected) internal {
        assertEq(oracle.quoteTokenPrice(address(paxg)), expected, "liquidation quote");
        assertEq(oracle.getTokenPrice(address(paxg)), expected, "liquidation read");
        assertEq(oracle.getLastKnownPrice(address(paxg)), expected, "recorded");
    }

    function _liqRefused(string memory reason) internal {
        vm.expectRevert(bytes(reason));
        oracle.quoteTokenPrice(address(paxg));
        vm.expectRevert(bytes(reason));
        oracle.getTokenPrice(address(paxg));
    }

    function _borrow(uint256 expected) internal {
        assertEq(oracle.quoteBorrowPrice(address(paxg)), expected, "borrow quote");
        assertEq(oracle.getBorrowPrice(address(paxg)), expected, "borrow read");
    }

    function _borrowRefused(string memory reason) internal {
        vm.expectRevert(bytes(reason));
        oracle.quoteBorrowPrice(address(paxg));
        vm.expectRevert(bytes(reason));
        oracle.getBorrowPrice(address(paxg));
    }

    function _reserve(uint256 expected) internal {
        assertEq(oracle.quoteReservePrice(address(paxg)), expected, "reserve quote");
        assertEq(oracle.getReservePrice(address(paxg)), expected, "reserve read");
    }

    function _reserveRefused(string memory reason) internal {
        vm.expectRevert(bytes(reason));
        oracle.quoteReservePrice(address(paxg));
        vm.expectRevert(bytes(reason));
        oracle.getReservePrice(address(paxg));
        (uint256 out,) = reserve.quoteGoldOut(address(paxg), 1000e18);
        assertEq(out, 0, "no swap preview");
        vm.prank(buyer);
        vm.expectRevert(bytes(reason));
        reserve.swapGsusdForGold(address(paxg), 1000e18, 0);
    }

    function _emergencyRefused() internal {
        vm.expectRevert(bytes("No price"));
        oracle.getEmergencyPrice(address(paxg), true);
    }

    function _seedReserve(uint256 amount) internal {
        paxg.mint(address(this), amount);
        paxg.approve(address(reserve), amount);
        reserve.seedCollateral(address(paxg), amount);
    }

    // ---------- defaults and setters ----------

    function test_defaults() public view {
        assertEq(oracle.goldBandPpm(address(paxg)), 20_000);
        assertEq(oracle.liquidationClampPpm(address(paxg)), 20_000);
        assertEq(oracle.liquidationClampPpm(address(xaut)), 20_000);
        assertEq(oracle.DEFAULT_LIQUIDATION_CLAMP_PPM(), 20_000);
    }

    /// A liquidation ratio below 100% plus the largest cap (5%) let a market
    /// price pushed up to the cap keep a vault under water at gold from being liquidated.
    function test_liquidationRatioKeepsTheHeadroomTheLargestCapNeeds() public {
        (, uint256 minRatio,, uint256 penalty,,,) = vault.collateralTypes(keccak256(abi.encodePacked(address(paxg))));
        vm.expectRevert(bytes("Liquidation ratio must be >= 105%"));
        vault.updateCollateralRatios(address(paxg), minRatio, 1_049_999, penalty);
        vault.updateCollateralRatios(address(paxg), minRatio, 1_050_000, penalty);
    }

    /// The validated read copied all return data, so a feed answering with
    /// 100,000 words ran getValidatedPrice, documented as never reverting, out of gas. Only the
    /// expected 160 bytes are copied now, and anything else reads as an unhealthy feed.
    function test_returnBombReadsAsUnhealthyWithoutReverting() public {
        ReturnBombFeed bomb = new ReturnBombFeed(100_000);
        oracle.setFeed(address(paxg), address(bomb));
        // A block's worth of gas: enough for the feed to build its answer, not for the oracle
        // to copy it as well.
        (uint256 price, bool ok) = oracle.getValidatedPrice{gas: 30_000_000}(address(paxg));
        assertFalse(ok, "unhealthy");
        assertEq(price, 0);
        vm.expectRevert(bytes("No reliable price"));
        oracle.quoteTokenPrice{gas: 30_000_000}(address(paxg));
    }

    function test_setLiquidationClamp_boundsAndRoles() public {
        vm.expectRevert(bytes("Clamp out of range"));
        oracle.setLiquidationClamp(address(paxg), 4_999);
        vm.expectRevert(bytes("Clamp out of range"));
        oracle.setLiquidationClamp(address(paxg), 50_001);
        vm.expectRevert(bytes("Unsupported token"));
        oracle.setLiquidationClamp(address(0xdead), 30_000);
        oracle.setLiquidationClamp(address(paxg), 5_000);
        oracle.setLiquidationClamp(address(paxg), 50_000);
        assertEq(oracle.liquidationClampPpm(address(paxg)), 50_000);
        assertEq(oracle.liquidationClampPpm(address(xaut)), 20_000, "per token");
        vm.prank(address(0xBAD));
        vm.expectRevert();
        oracle.setLiquidationClamp(address(paxg), 30_000);
    }

    // ---------- borrowing ----------

    function test_borrow_healthyInBand_lowerOfCAndG() public {
        _set(_at(G, 10_000), G);
        _borrow(_at(G, 10_000));
        _set(_over(G, 10_000), G);
        _borrow(G);
    }

    function test_borrow_gatedByTheGoldBand() public {
        _set(_at(G, 20_001), G);
        _borrowRefused("Off gold band");
        _set(_over(G, 20_001), G);
        _borrowRefused("Off gold band");
        _set(_at(G, 20_000), G);
        _borrow(_at(G, 20_000));
        _set(_over(G, 20_000), G);
        _borrow(G);
    }

    /// Both edges of the band round down. With gold at 4,000.00000001 the 2% lower edge is
    /// 3,920.0000000098, which is 3,920.00000000 in price units: a market price on that
    /// figure is inside the band, and one unit lower is outside it.
    function test_band_lowerEdgeRoundsDown() public {
        uint256 g = G + 1;
        uint256 edge = g * 980_000 / 1e6;
        assertTrue(mulmod(g, 980_000, 1e6) != 0, "the edge is not a whole price unit");
        assertEq(edge, 392_000_000_000);
        _set(edge, g);
        _borrow(edge);
        _reserve(g);
        _set(edge - 1, g);
        _borrowRefused("Off gold band");
    }

    function test_borrow_unhealthySourcesRefuse() public {
        _set(G, G);
        _stale(paxgFeed, int256(G));
        _borrowRefused("No reliable price");
        _set(G, G);
        _stale(anchor, int256(G));
        _borrowRefused("No reliable price");
        _stale(paxgFeed, int256(G));
        _borrowRefused("No reliable price");
    }

    // ---------- liquidation, both healthy ----------

    function test_liquidation_cAtOrBelowGoldPricesAtGold() public {
        _set(G, G);
        _liq(G);
        _set(_at(G, 1), G);
        _liq(G);
        _set(_at(G, 15_000), G);
        _liq(G);
        _set(_at(G, 900_000), G);
        _liq(G);
    }

    function test_liquidation_cAboveGoldPricesAtCUpToTheCap() public {
        _set(_over(G, 15_000), G);
        _liq(_over(G, 15_000));
        _set(_over(G, 300_000), G);
        _liq(_over(G, 20_000));
    }

    function test_liquidation_capEdges_twoPercent() public {
        _capEdges(20_000);
    }

    function test_liquidation_capEdges_twoAndAHalfPercent() public {
        _capEdges(25_000);
    }

    function test_liquidation_capEdges_threePercent() public {
        _capEdges(30_000);
    }

    function _capEdges(uint256 m) internal {
        oracle.setLiquidationClamp(address(paxg), m);
        uint256 hi = _over(G, m);
        _set(hi - 1, G);
        _liq(hi - 1);
        _set(hi, G);
        _liq(hi);
        _set(hi + 1, G);
        _liq(hi);
        _set(hi * 2, G);
        _liq(hi);
        // The lower side never depends on m: gold is the floor.
        _set(_at(G, m), G);
        _liq(G);
    }

    // ---------- liquidation, a feed unhealthy ----------

    function test_liquidation_cStale_refusesEveryPricedPath() public {
        _set(G, G);
        oracle.getTokenPrice(address(paxg));
        _stale(paxgFeed, int256(G));
        _liqRefused("No reliable price");
        _borrowRefused("No reliable price");
        _reserveRefused("No reliable price");
        assertEq(oracle.getLastKnownPrice(address(paxg)), G, "the last known price is not used");
    }

    function test_liquidation_cInvalidAnswerCountsAsUnhealthy() public {
        _set(G, G);
        paxgFeed.setLatestRoundData(1, 0, block.timestamp, block.timestamp, 1);
        _liqRefused("No reliable price");
        paxgFeed.setLatestRoundData(2, int256(G), block.timestamp, block.timestamp, 1);
        _liqRefused("No reliable price"); // an incomplete round
    }

    function test_liquidation_gStale_refuses() public {
        _set(G, G);
        _stale(anchor, int256(G));
        _push(paxgFeed, int256(_at(G, 600_000)));
        _liqRefused("No reliable price");
        _push(paxgFeed, int256(G));
        _liqRefused("No reliable price");
        anchor.setLatestRoundData(1, 0, block.timestamp, block.timestamp, 1);
        _liqRefused("No reliable price");
    }

    function test_liquidation_bothStale_refusesAndRepayAndDepositStayOpen() public {
        _open(borrower, paxg, 1e18, 1000e18);
        _set(G, G);
        _stale(paxgFeed, int256(G));
        _stale(anchor, int256(G));
        _liqRefused("No reliable price");
        _borrowRefused("No reliable price");
        _reserveRefused("No reliable price");
        vm.prank(liquidator);
        vm.expectRevert(bytes("No reliable price"));
        vault.liquidate(borrower, 0);
        // Repay and deposit never read a price.
        paxg.mint(borrower, 1e18);
        vm.startPrank(borrower);
        paxg.approve(address(vault), 1e18);
        vault.deposit(address(paxg), 1e18);
        gsusd.approve(address(vault), 500e18);
        vault.repay(500e18);
        vm.stopPrank();
        (, uint256 coll, uint256 debt) = _vault(borrower);
        assertEq(coll, 2e18);
        assertEq(debt, 500e18);
    }

    function test_liquidation_resumesByItselfOnTheFirstHealthyPair() public {
        _open(borrower, paxg, 1e18, 2600e18);
        _set(2800e8, 2800e8);
        _stale(paxgFeed, 2800e8);
        _stale(anchor, 2800e8);
        vm.prank(liquidator);
        vm.expectRevert(bytes("No reliable price"));
        vault.liquidate(borrower, 0);
        // Only one feed back: still refused.
        _push(anchor, 2800e8);
        vm.prank(liquidator);
        vm.expectRevert(bytes("No reliable price"));
        vault.liquidate(borrower, 0);
        // Both publish again: no call, role or keeper step in between.
        _push(paxgFeed, 2800e8);
        vm.prank(liquidator);
        vault.liquidate(borrower, 0);
        assertEq(oracle.getLastKnownPrice(address(paxg)), 2800e8);
    }

    // ---------- reserve ----------

    function test_reserve_healthyInBand_higherOfCAndG() public {
        _set(_at(G, 15_000), G);
        _reserve(G);
        _set(_over(G, 15_000), G);
        _reserve(_over(G, 15_000));
    }

    function test_reserve_offBandRefuses() public {
        _set(_at(G, 25_000), G);
        _reserveRefused("Off gold band");
        _set(_over(G, 25_000), G);
        _reserveRefused("Off gold band");
    }

    function test_reserve_unhealthyRefuses() public {
        _set(G, G);
        _stale(paxgFeed, int256(G));
        _reserveRefused("No reliable price");
        _set(G, G);
        _stale(anchor, int256(G));
        _reserveRefused("No reliable price");
    }

    function test_reserve_cannotBeBoughtBelowGoldWhenCIsPushedDownInsideTheBand() public {
        _seedReserve(10e18);
        _set(_at(G, 19_000), G);
        (uint256 previewed, uint256 spread) = reserve.quoteGoldOut(address(paxg), 4000e18);
        uint256 net = 4000e18 - 4000e18 * spread / 1e6;
        assertEq(previewed, net * 1e8 / G, "preview at gold");
        uint256 before = paxg.balanceOf(buyer);
        vm.prank(buyer);
        uint256 out = reserve.swapGsusdForGold(address(paxg), 4000e18, 0);
        assertEq(out, previewed, "executes at the preview");
        assertEq(paxg.balanceOf(buyer) - before, out);
        assertLt(out, net * 1e8 / _at(G, 19_000), "less than the pushed price would give");
    }

    function test_reserve_swapPricesAtTheReservePriceNotTheLiquidationPrice() public {
        _seedReserve(10e18);
        _set(_over(G, 10_000), G);
        (uint256 previewed, uint256 spread) = reserve.quoteGoldOut(address(paxg), 4000e18);
        uint256 net = 4000e18 - 4000e18 * spread / 1e6;
        assertEq(previewed, net * 1e8 / _over(G, 10_000), "at C above gold");
    }

    // ---------- coverage valuation ----------

    function test_valuation_neverAboveTheLowerOfCAndG() public {
        _set(_over(G, 10_000), G);
        assertEq(oracle.quoteValuationPrice(address(paxg)), G);
        _set(_at(G, 10_000), G);
        assertEq(oracle.quoteValuationPrice(address(paxg)), _at(G, 10_000));
        // Off the band: still the lower of the two, never the liquidation price (gold here).
        _set(_at(G, 300_000), G);
        assertEq(oracle.quoteValuationPrice(address(paxg)), _at(G, 300_000));
        assertEq(oracle.quoteTokenPrice(address(paxg)), G);
        // A stopped source values the token at nothing, never at the last known price.
        _set(G, G);
        oracle.getTokenPrice(address(paxg));
        _stale(paxgFeed, int256(G));
        assertEq(oracle.quoteValuationPrice(address(paxg)), 0);
        _set(G, G);
        _stale(anchor, int256(G));
        assertEq(oracle.quoteValuationPrice(address(paxg)), 0);
        vm.expectRevert(bytes("Unsupported token"));
        oracle.quoteValuationPrice(address(0xdead));
    }

    function test_valuation_worksWhilePaused() public {
        _set(_at(G, 10_000), G);
        oracle.emergencyPause();
        assertEq(oracle.quoteValuationPrice(address(paxg)), _at(G, 10_000));
    }

    function test_reserveCoverage_valuesAStoppedTokenAtNothing() public {
        _seedReserve(10e18);
        _set(G, G);
        assertEq(reserve.reserveValueUsd(), 10 * 4000e18);
        oracle.getTokenPrice(address(paxg)); // a lastKnownPrice that must not be used
        _stale(paxgFeed, int256(G));
        assertEq(reserve.reserveValueUsd(), 0);
    }

    // ---------- emergency ----------

    function test_emergency_rulesPriceWhenBothAreHealthy() public {
        _set(_at(G, 300_000), G);
        oracle.emergencyPause();
        assertEq(oracle.getEmergencyPrice(address(paxg), false), G, "never below gold");
        _set(_over(G, 300_000), G);
        assertEq(oracle.getEmergencyPrice(address(paxg), false), _over(G, 20_000), "capped");
    }

    function test_emergency_neverPricesOnAStaleCOrGoldAlone() public {
        _open(borrower, paxg, 1e18, 2600e18);
        _set(G, G);
        oracle.getTokenPrice(address(paxg));
        _stale(paxgFeed, int256(G));
        _push(anchor, 2000e8); // gold alone says the vault is under water
        oracle.emergencyPause();
        vm.expectRevert(bytes("No price"));
        oracle.getEmergencyPrice(address(paxg), false);
        vault.emergencyPause();
        _emergencyRefused();
        vm.prank(liquidator);
        vm.expectRevert(bytes("No price"));
        vault.emergencyLiquidate(borrower, 0);
        // A live C with gold stopped: refused too; the last known price is never used.
        _push(paxgFeed, 2000e8);
        _stale(anchor, 2000e8);
        _emergencyRefused();
        _stale(paxgFeed, int256(G));
        _emergencyRefused();
    }

    function test_emergency_unknownTokenAnswersZeroAndNotInEmergencyOutsideAPause() public {
        vm.expectRevert(bytes("Not in emergency"));
        oracle.getEmergencyPrice(address(paxg), false);
        assertEq(oracle.getEmergencyPrice(address(0xdead), true), 0, "unknown token answers 0");
    }

    function test_emergency_frozenRefusesInAndOutOfAPause() public {
        _set(G, G);
        oracle.freezeToken(address(paxg));
        vm.expectRevert(bytes("Token frozen"));
        oracle.getEmergencyPrice(address(paxg), false);
        // The freeze holds through a pause.
        vm.expectRevert(bytes("Token frozen"));
        oracle.getEmergencyPrice(address(paxg), true);
        oracle.guardianUnfreezeToken(address(paxg), oracle.freezeEpoch(address(paxg)));
        assertEq(oracle.getEmergencyPrice(address(paxg), true), G, "unfrozen, a pause prices it");
    }

    // ---------- scenarios ----------

    function test_scenario_aPushOfCDownCannotValueCollateralBelowGold() public {
        _open(borrower, paxg, 1e18, 2600e18);
        _set(2900e8, 2900e8); // 111.5% at gold
        _set(1e8, 2900e8); // C pushed to $1
        assertEq(oracle.quoteTokenPrice(address(paxg)), 2900e8);
        vm.prank(liquidator);
        vm.expectRevert(bytes("Not undercollateralised"));
        vault.liquidate(borrower, 0);
        vault.emergencyPause();
        vm.prank(liquidator);
        vm.expectRevert(bytes("Not undercollateralised"));
        vault.emergencyLiquidate(borrower, 0);
    }

    function test_scenario_aPushOfCUpIsCappedAtTwoPercentAboveGold() public {
        _open(borrower, paxg, 1e18, 2600e18);
        // Gold at 2850 (109.6%, liquidatable at gold); C pushed 10% up is capped at 2907
        // (111.8%), so the push rescues the vault only by the cap.
        _set(_over(2850e8, 100_000), 2850e8);
        assertEq(oracle.quoteTokenPrice(address(paxg)), _over(2850e8, 20_000));
        vm.prank(liquidator);
        vm.expectRevert(bytes("Not undercollateralised"));
        vault.liquidate(borrower, 0);
        // At 2800 gold (107.7%) the same push cannot hold it: 2856 is 109.8%.
        _set(_over(2800e8, 100_000), 2800e8);
        assertEq(oracle.quoteTokenPrice(address(paxg)), _over(2800e8, 20_000));
        vm.prank(liquidator);
        vault.liquidate(borrower, 0);
        assertEq(oracle.getLastKnownPrice(address(paxg)), _over(2800e8, 20_000));
    }

    function test_scenario_genuineDepegWithGoldSteadyIsNotLiquidated() public {
        _seedReserve(10e18);
        _open(borrower, paxg, 1e18, 2600e18);
        _set(_at(G, 300_000), G);
        // Borrowing refused.
        _borrowRefused("Off gold band");
        // Liquidation at gold: the 30% depeg alone seizes nothing.
        assertEq(oracle.quoteTokenPrice(address(paxg)), G);
        vm.prank(liquidator);
        vm.expectRevert(bytes("Not undercollateralised"));
        vault.liquidate(borrower, 0);
        // Reserve swap refused.
        _reserveRefused("Off gold band");
        // Coverage valued at no more than C.
        assertLe(reserve.reserveValueUsd(), 10 * _at(G, 300_000) * 1e10);
    }

    function test_scenario_aGoldWideFallLiquidatesAtC() public {
        _open(borrower, paxg, 1e18, 2600e18);
        _set(2840e8, 2840e8); // gold and C fall together: 109.2%
        uint256 debt = vault.getVaultCurrentDebt(borrower);
        vm.prank(liquidator);
        vault.liquidate(borrower, 0);
        assertEq(oracle.getLastKnownPrice(address(paxg)), 2840e8);
        (, uint256 coll, uint256 left) = _vault(borrower);
        assertEq(left, 0);
        assertApproxEqAbs(1e18 - coll, (debt * 1_050_000 / 1e6) * 1e8 / 2840e8, 1, "seized at C");
    }

    function test_scenario_gStaleWithCPushedFarDownIsRefusedNotPriced() public {
        _open(borrower, paxg, 1e18, 2600e18);
        _set(G, G);
        _stale(anchor, int256(G));
        _push(paxgFeed, 1e8);
        _liqRefused("No reliable price");
        vm.prank(liquidator);
        vm.expectRevert(bytes("No reliable price"));
        vault.liquidate(borrower, 0);
    }

    function test_scenario_cStaleWhileGoldFallsThenRises() public {
        _open(borrower, paxg, 1e18, 2600e18);
        _set(G, G);
        _stale(paxgFeed, int256(G));
        _push(anchor, 3600e8);
        _liqRefused("No reliable price");
        _push(anchor, 3960e8);
        _liqRefused("No reliable price");
        _push(anchor, 2700e8); // even a fall that would make the vault seizable
        vm.prank(liquidator);
        vm.expectRevert(bytes("No reliable price"));
        vault.liquidate(borrower, 0);
        vm.startPrank(borrower);
        gsusd.approve(address(vault), 100e18);
        vault.repay(100e18);
        vm.stopPrank();
        // C publishes again: priced and liquidatable on its own (2700 / 2500 = 108%).
        _push(paxgFeed, 2700e8);
        vm.prank(liquidator);
        vault.liquidate(borrower, 0);
    }

    function test_scenario_xautUnaffectedByAPaxgDepeg() public {
        _set(_at(G, 300_000), G);
        assertEq(oracle.quoteBorrowPrice(address(xaut)), G);
        assertEq(oracle.quoteReservePrice(address(xaut)), G);
        assertEq(oracle.quoteTokenPrice(address(xaut)), G);
    }

    // ---------- records ----------

    function test_records_lastKnownIsAlwaysTheLiquidationPrice() public {
        _set(_at(G, 10_000), G);
        assertEq(oracle.getBorrowPrice(address(paxg)), _at(G, 10_000));
        assertEq(oracle.getLastKnownPrice(address(paxg)), G, "the liquidation price, not the borrow price");
        _set(_over(G, 10_000), G);
        oracle.getReservePrice(address(paxg));
        assertEq(oracle.getLastKnownPrice(address(paxg)), _over(G, 10_000), "the liquidation price");
        _set(_at(G, 10_000), G);
        oracle.getTokenPrice(address(paxg));
        assertEq(oracle.getLastKnownPrice(address(paxg)), G, "the liquidation price");
    }

    function test_records_unfreezeAndResyncUseTheRules() public {
        _set(_at(G, 300_000), G);
        oracle.freezeToken(address(paxg));
        _liqRefused("Token frozen");
        oracle.guardianUnfreezeToken(address(paxg), oracle.freezeEpoch(address(paxg)));
        assertEq(oracle.getLastKnownPrice(address(paxg)), G);
        _stale(paxgFeed, int256(G));
        vm.expectRevert(bytes("No reliable price"));
        oracle.guardianResyncLastKnownPrice(address(paxg));
    }
}
