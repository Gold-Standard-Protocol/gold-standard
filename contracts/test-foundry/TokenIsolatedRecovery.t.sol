// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {FullStackHarness} from "./harness/FullStackHarness.sol";
import {MockAggregatorV3} from "../src/test/mocks/MockAggregatorV3.sol";
import {GoldOracle} from "../src/core/GoldOracle.sol";
import {InactiveFeed} from "../src/oracle/InactiveFeed.sol";

/// @notice Sections 3 and 4 of the oracle plan: token isolation, the guardian's manual
///         freeze and the emergency path. An XAUT depeg needs no guardian step: borrowing and
///         reserve swaps stop off the gold band and liquidation values XAUT at gold, so the depeg
///         alone seizes nothing. PAXG runs on throughout. A frozen token is stopped in every
///         case, emergency liquidation and a pause included; in a
///         pause an unfrozen token prices where a normal read would, and nowhere else.
contract TokenIsolatedRecoveryTest is FullStackHarness {
    address internal borrower = address(0xB0B);
    address internal paxgBorrower = address(0xB0C);
    address internal liquidator = address(0x11);
    address internal guardian = address(0x6A);
    MockAggregatorV3 internal anchor;

    function setUp() public override {
        super.setUp();
        anchor = new MockAggregatorV3(8);
        _push(anchor, PRICE);
        oracle.setAnchorFeed(address(anchor));
        oracle.grantGuardianRole(guardian);
        reserve.grantGuardianRole(guardian);

        _open(borrower, xaut, ONE_XAUT, 2600e18); // 153.8% at $4000
        _open(paxgBorrower, paxg, 1e18, 2000e18);
        _fundGsusd(liquidator, 10_000e18);
        vm.prank(liquidator);
        gsusd.approve(address(vault), type(uint256).max);
    }

    // ---------- helpers ----------

    function _stale(MockAggregatorV3 feed, int256 price) internal {
        feed.setLatestRoundData(1, price, block.timestamp - 100_000, block.timestamp - 100_000, 1);
    }

    /// @dev XAUT's market feed; PAXG and gold stay at $4000.
    function _xaut(int256 c) internal {
        _push(xautFeed, c);
        _push(anchor, PRICE);
        _push(paxgFeed, PRICE);
    }

    /// @dev Gold itself moves, with every market feed following it.
    function _gold(int256 price) internal {
        _push(anchor, price);
        _push(xautFeed, price);
        _push(paxgFeed, price);
    }

    function _freezeXaut() internal {
        vm.prank(guardian);
        oracle.freezeToken(address(xaut));
    }

    // ---------- the manual freeze ----------

    function test_onlyTheGuardianOrGovernanceFreezes() public {
        vm.prank(liquidator);
        vm.expectRevert(bytes("Not guardian or governance"));
        oracle.freezeToken(address(xaut));
        vm.prank(guardian);
        vm.expectRevert(bytes("Unsupported token"));
        oracle.freezeToken(address(0xDEAD));
        vm.expectEmit(true, true, false, true, address(oracle));
        emit GoldOracle.TokenFrozen(address(xaut), guardian, block.timestamp + 14 days);
        _freezeXaut();
        // vm.getBlockTimestamp: via_ir may reuse a block.timestamp read across vm.warp.
        uint256 t0 = vm.getBlockTimestamp();
        vm.warp(t0 + 1 days);
        _freezeXaut(); // calling again extends the freeze
        assertEq(oracle.frozenUntil(address(xaut)), t0 + 15 days);
        oracle.freezeToken(address(paxg)); // governance may as well
        assertTrue(oracle.tokenFrozen(address(paxg)));
    }

    function test_freezeStopsXautOnlyAndRepaymentCarriesOn() public {
        _freezeXaut();
        assertFalse(oracle.tokenFrozen(address(paxg)));
        assertFalse(oracle.paused(), "no global pause");

        vm.startPrank(borrower);
        vm.expectRevert(bytes("Token frozen"));
        vault.mint(100e18);
        vm.expectRevert(bytes("Token frozen"));
        vault.withdraw(1);
        vm.stopPrank();
        vm.prank(liquidator);
        vm.expectRevert(bytes("Token frozen"));
        vault.liquidate(borrower, 0);
        vm.expectRevert(bytes("Token frozen"));
        oracle.quoteTokenPrice(address(xaut));
        vm.expectRevert(bytes("Token frozen"));
        oracle.quoteBorrowPrice(address(xaut));

        xaut.mint(borrower, 1000);
        vm.startPrank(borrower);
        xaut.approve(address(vault), 1000);
        vault.deposit(address(xaut), 1000);
        gsusd.approve(address(vault), 100e18);
        vault.repay(100e18);
        vm.stopPrank();

        vm.prank(paxgBorrower);
        vault.mint(100e18);
        assertEq(oracle.getTokenPrice(address(paxg)), uint256(PRICE));
    }

    function test_reserveStopsCountingAndSellingFrozenGold() public {
        paxg.mint(address(this), 10e18);
        paxg.approve(address(reserve), 10e18);
        reserve.seedCollateral(address(paxg), 10e18);
        xaut.mint(address(this), 10 * ONE_XAUT);
        xaut.approve(address(reserve), 10 * ONE_XAUT);
        reserve.seedCollateral(address(xaut), 10 * ONE_XAUT);
        uint256 before = reserve.reserveValueUsd();
        _freezeXaut();
        assertLt(reserve.reserveValueUsd(), before / 2 + 1, "frozen XAUT gold no longer counts");
        _fundGsusd(address(this), 1000e18);
        gsusd.approve(address(reserve), type(uint256).max);
        vm.expectRevert(bytes("Token frozen"));
        reserve.swapGsusdForGold(address(xaut), 100e18, 0);
        reserve.swapGsusdForGold(address(paxg), 100e18, 0);
    }

    // ---------- a depeg needs no guardian step ----------

    function test_xautDepegIsNotLiquidatedWhileGoldHoldsAndNeedsNoGuardianStep() public {
        _xaut(2800e8); // XAUT's market 30% under gold
        assertEq(oracle.quoteTokenPrice(address(xaut)), 4000e8, "valued at gold");
        vm.prank(liquidator);
        vm.expectRevert(bytes("Not undercollateralised"));
        vault.liquidate(borrower, 0);
        vm.prank(borrower);
        vm.expectRevert(bytes("Off gold band"));
        vault.mint(1e18);
        vm.prank(paxgBorrower);
        vault.mint(100e18); // PAXG is untouched

        // Gold itself falls to 2,800 with XAUT still depegged: valued at gold, 107.7%.
        _push(anchor, 2800e8);
        _push(paxgFeed, 2800e8);
        _push(xautFeed, 1700e8);
        assertEq(oracle.quoteTokenPrice(address(xaut)), 2800e8);
        uint256 debt = vault.getVaultCurrentDebt(borrower);
        vm.prank(liquidator);
        vault.liquidate(borrower, 0);
        uint256 expected = (debt * 1_050_000 / 1e6) * 1e8 / (2800e8 * 1e12);
        (, uint256 coll, uint256 left) = _vault(borrower);
        assertEq(left, 0);
        assertApproxEqAbs(ONE_XAUT - coll, expected, 1);
        assertFalse(oracle.tokenFrozen(address(xaut)), "no freeze was needed");
    }

    function test_sharedGoldFailureStopsBorrowingAndLiquidationForBoth() public {
        vm.warp(block.timestamp + 1 hours);
        _xaut(PRICE);
        _stale(anchor, PRICE);
        vm.prank(paxgBorrower);
        vm.expectRevert(bytes("No reliable price"));
        vault.mint(1e18);
        vm.prank(borrower);
        vm.expectRevert(bytes("No reliable price"));
        vault.mint(1e18);
        vm.expectRevert(bytes("No reliable price"));
        oracle.getTokenPrice(address(paxg));
        vm.expectRevert(bytes("No reliable price"));
        oracle.getTokenPrice(address(xaut));
        // Gold publishes again: both price at once, with no step in between.
        _push(anchor, PRICE);
        assertEq(oracle.getTokenPrice(address(paxg)), uint256(PRICE));
        assertEq(oracle.getTokenPrice(address(xaut)), uint256(PRICE));
    }

    // ---------- the emergency price ----------

    function test_notInEmergencyWithoutAPauseOrAFreeze() public {
        vm.expectRevert(bytes("Not in emergency"));
        oracle.getEmergencyPrice(address(xaut), false);
        vm.prank(liquidator);
        vm.expectRevert(bytes("Not in emergency"));
        vault.emergencyLiquidate(borrower, 0);
    }

    function test_aFreezeStopsEmergencyLiquidationThroughAPause() public {
        _freezeXaut();
        _gold(2850e8); // gold falls; every source follows
        vm.expectRevert(bytes("Token frozen"));
        oracle.getEmergencyPrice(address(xaut), false);
        vm.prank(liquidator);
        vm.expectRevert(bytes("Token frozen"));
        vault.liquidate(borrower, 0);
        vm.prank(liquidator);
        vm.expectRevert(bytes("Token frozen"));
        vault.emergencyLiquidate(borrower, 0);
        // A pause does not lift the guardian's freeze.
        vault.emergencyPause();
        vm.expectRevert(bytes("Token frozen"));
        oracle.getEmergencyPrice(address(xaut), true);
        vm.prank(liquidator);
        vm.expectRevert(bytes("Token frozen"));
        vault.emergencyLiquidate(borrower, 0);
        // The guardian lifts it while paused; the pause then uses the normal price.
        uint256 epoch = oracle.freezeEpoch(address(xaut));
        vm.prank(guardian);
        oracle.guardianUnfreezeToken(address(xaut), epoch);
        assertEq(oracle.getEmergencyPrice(address(xaut), true), 2850e8);
        vm.prank(liquidator);
        vault.emergencyLiquidate(borrower, 0);
        (,, uint256 left) = _vault(borrower);
        assertEq(left, 0);
    }

    function test_frozenTokenWithoutANormalPriceIsNotLiquidatable() public {
        _freezeXaut();
        _gold(2800e8);
        _stale(xautFeed, 2800e8);
        _stale(anchor, 2800e8); // both stopped: no rule applies
        vm.expectRevert(bytes("Token frozen"));
        oracle.getEmergencyPrice(address(xaut), false);
        vm.prank(liquidator);
        vm.expectRevert(bytes("Token frozen"));
        vault.emergencyLiquidate(borrower, 0);
        // A pause does not lift the freeze, and the guardian cannot
        // lift it without a normal price.
        vault.emergencyPause();
        vm.prank(liquidator);
        vm.expectRevert(bytes("Token frozen"));
        vault.emergencyLiquidate(borrower, 0);
        uint256 epoch = oracle.freezeEpoch(address(xaut));
        vm.prank(guardian);
        vm.expectRevert(bytes("No reliable price"));
        oracle.guardianUnfreezeToken(address(xaut), epoch);
        // Once the freeze lapses the pause still does not price it: no seizure on a stale or
        // gold only valuation.
        vm.warp(block.timestamp + oracle.FREEZE_DURATION());
        assertFalse(oracle.tokenFrozen(address(xaut)));
        vm.prank(liquidator);
        vm.expectRevert(bytes("No price"));
        vault.emergencyLiquidate(borrower, 0);
    }

    function test_pauseNeverPricesAStaleMarketFeed() public {
        _stale(xautFeed, 2800e8);
        _push(anchor, 2000e8); // gold alone would make the vault seizable
        vault.emergencyPause();
        vm.expectRevert(bytes("No price"));
        oracle.getEmergencyPrice(address(xaut), true);
        vm.prank(liquidator);
        vm.expectRevert(bytes("No price"));
        vault.emergencyLiquidate(borrower, 0);
        // A frozen token in a pause is refused before any price is read;
        // once the freeze lapses the stale C is refused as before.
        _freezeXaut();
        vm.expectRevert(bytes("Token frozen"));
        oracle.getEmergencyPrice(address(xaut), true);
        vm.warp(block.timestamp + oracle.FREEZE_DURATION());
        _stale(xautFeed, 2800e8);
        _push(anchor, 2000e8);
        vm.expectRevert(bytes("No price"));
        oracle.getEmergencyPrice(address(xaut), true);
        // A live C with gold stopped: refused as well.
        _push(xautFeed, 4600e8);
        _stale(anchor, PRICE);
        vm.expectRevert(bytes("No price"));
        oracle.getEmergencyPrice(address(xaut), true);
        // With both healthy the pause uses the normal price: gold, for a C below it.
        _xaut(3950e8);
        assertEq(oracle.getEmergencyPrice(address(xaut), true), uint256(PRICE));
    }

    function test_oraclePauseUsesTheNormalPriceWhenAvailable() public {
        _gold(2850e8);
        oracle.emergencyPause();
        vm.expectRevert();
        oracle.getTokenPrice(address(xaut));
        assertEq(oracle.getEmergencyPrice(address(xaut), false), 2850e8);
        vm.prank(liquidator);
        vault.emergencyLiquidate(borrower, 0);
        (,, uint256 left) = _vault(borrower);
        assertEq(left, 0);
    }

    // ---------- leaving the freeze ----------

    function test_unfreezeNeedsANormalReadAndReanchors() public {
        vm.prank(guardian);
        vm.expectRevert(bytes("Not frozen"));
        oracle.guardianUnfreezeToken(address(xaut), 0);
        _freezeXaut();
        uint256 epoch = oracle.freezeEpoch(address(xaut));
        vm.prank(liquidator);
        vm.expectRevert(bytes("Not guardian or governance"));
        oracle.guardianUnfreezeToken(address(xaut), epoch);

        _stale(xautFeed, PRICE);
        _stale(anchor, PRICE);
        vm.prank(guardian);
        vm.expectRevert(bytes("No reliable price"));
        oracle.guardianUnfreezeToken(address(xaut), epoch);

        _xaut(3950e8); // XAUT inside the band, valued at gold
        vm.expectEmit(true, true, false, true, address(oracle));
        emit GoldOracle.TokenUnfrozen(address(xaut), guardian, uint256(PRICE));
        vm.prank(guardian);
        oracle.guardianUnfreezeToken(address(xaut), epoch);
        assertFalse(oracle.tokenFrozen(address(xaut)));
        assertEq(oracle.getLastKnownPrice(address(xaut)), uint256(PRICE));
        vm.prank(borrower);
        vault.mint(1e18);
    }

    function test_unfreezeAtADepeg() public {
        _freezeXaut();
        _xaut(2800e8);
        uint256 epoch = oracle.freezeEpoch(address(xaut));
        vm.prank(guardian);
        oracle.guardianUnfreezeToken(address(xaut), epoch);
        assertEq(oracle.getLastKnownPrice(address(xaut)), uint256(PRICE), "valued at gold");
        vm.prank(borrower);
        vm.expectRevert(bytes("Off gold band"));
        vault.mint(1e18); // borrowing stays off the band
    }

    function test_guardianResyncNeedsANormalRead() public {
        _stale(xautFeed, PRICE);
        vm.prank(guardian);
        vm.expectRevert(bytes("No reliable price"));
        oracle.guardianResyncLastKnownPrice(address(xaut)); // C stopped, gold healthy
        _push(xautFeed, 3980e8);
        _stale(anchor, PRICE); // C back, gold stopped: still refused
        vm.prank(guardian);
        vm.expectRevert(bytes("No reliable price"));
        oracle.guardianResyncLastKnownPrice(address(xaut));
        _push(anchor, PRICE); // both healthy: C below gold is valued at gold
        vm.prank(guardian);
        oracle.guardianResyncLastKnownPrice(address(xaut));
        assertEq(oracle.getLastKnownPrice(address(xaut)), uint256(PRICE));
        _push(xautFeed, 4300e8); // above gold: capped at 2%
        vm.prank(guardian);
        oracle.guardianResyncLastKnownPrice(address(xaut));
        assertEq(oracle.getLastKnownPrice(address(xaut)), 4080e8);
        vm.prank(liquidator);
        vm.expectRevert(bytes("Not guardian or governance"));
        oracle.guardianResyncLastKnownPrice(address(xaut));
        vm.prank(guardian);
        vm.expectRevert(bytes("Unsupported token"));
        oracle.guardianResyncLastKnownPrice(address(0xDEAD));
    }

    function test_theFreezeLapsesAfterFourteenDaysAndCanBeExtended() public {
        uint256 t0 = vm.getBlockTimestamp();
        vm.prank(guardian);
        oracle.freezeToken(address(paxg));
        assertEq(oracle.frozenUntil(address(paxg)), t0 + 14 days);
        vm.warp(t0 + 10 days);
        vm.prank(guardian);
        oracle.freezeToken(address(paxg)); // the extension
        assertEq(oracle.freezeEpoch(address(paxg)), 2, "an extension is a fresh decision with a new number");
        vm.warp(t0 + 24 days - 1);
        assertTrue(oracle.tokenFrozen(address(paxg)));
        _push(paxgFeed, PRICE);
        _push(anchor, PRICE);
        vm.expectRevert(bytes("Token frozen"));
        oracle.getTokenPrice(address(paxg));
        vm.warp(t0 + 24 days);
        assertFalse(oracle.tokenFrozen(address(paxg)), "lapsed");
        _push(paxgFeed, PRICE);
        _push(anchor, PRICE);
        assertEq(oracle.getTokenPrice(address(paxg)), uint256(PRICE));
        vm.prank(guardian);
        vm.expectRevert(bytes("Not frozen"));
        oracle.guardianUnfreezeToken(address(paxg), 2);
    }

    // ---------- the gold reference stays apart from every market feed ----------

    function test_anchorEqualToAMarketFeedIsRefused() public {
        MockAggregatorV3 xau = new MockAggregatorV3(8);
        _push(xau, PRICE);
        GoldOracle o = new GoldOracle(address(paxgFeed), address(xau), address(paxg), address(xaut), 90000);
        vm.expectRevert(bytes("Feed not independent"));
        o.setAnchorFeed(address(xau));
        vm.expectRevert(bytes("Feed not independent"));
        o.setAnchorFeed(address(paxgFeed));
        o.setAnchorFeed(address(0)); // no anchor yet: a no-op
        o.setAnchorFeed(address(anchor));
        vm.expectRevert(bytes("Anchor required"));
        o.setAnchorFeed(address(0));
        vm.expectRevert(bytes("Feed not independent"));
        o.addFeed(address(0xCA0), address(anchor));
        vm.expectRevert(bytes("Feed not independent"));
        o.setPaxgFeed(address(anchor));
        vm.expectRevert(bytes("Feed not independent"));
        o.setXautFeed(address(anchor));
    }

    function test_xautOnAnInactiveFeedIsUnpriceableUntilActivated() public {
        InactiveFeed inactive = new InactiveFeed();
        assertEq(inactive.decimals(), 8);
        assertEq(inactive.description(), "Inactive");
        GoldOracle o = new GoldOracle(address(paxgFeed), address(inactive), address(paxg), address(xaut), 90000);
        o.setAnchorFeed(address(anchor));
        vm.expectRevert(bytes("No reliable price"));
        o.getTokenPrice(address(xaut));
        vm.expectRevert(bytes("No reliable price"));
        o.getBorrowPrice(address(xaut));
        vm.expectRevert(bytes("No reliable price"));
        o.getReservePrice(address(xaut));
        assertEq(o.quoteValuationPrice(address(xaut)), 0);
        (, bool ok) = o.getValidatedPrice(address(xaut));
        assertFalse(ok);
        o.emergencyPause();
        vm.expectRevert(bytes("No price"));
        o.getEmergencyPrice(address(xaut), false);
        o.unpause(o.pauseEpoch());
        assertEq(o.getTokenPrice(address(paxg)), uint256(PRICE), "PAXG prices");
        o.setXautFeed(address(xautFeed)); // activation through governance
        assertEq(o.getTokenPrice(address(xaut)), uint256(PRICE));
    }

    // ---------- property: a frozen token never prices normally ----------

    function testFuzz_frozenTokenNeverPricesNormally(uint256 c) public {
        _freezeXaut();
        _xaut(int256(bound(c, 1, 8000e8)));
        vm.expectRevert(bytes("Token frozen"));
        oracle.getTokenPrice(address(xaut));
        vm.expectRevert(bytes("Token frozen"));
        oracle.getBorrowPrice(address(xaut));
        vm.expectRevert(bytes("Token frozen"));
        oracle.getReservePrice(address(xaut));
        assertEq(oracle.getTokenPrice(address(paxg)), uint256(PRICE));
    }
}
