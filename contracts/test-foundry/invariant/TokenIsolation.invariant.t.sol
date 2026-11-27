// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import "forge-std/Test.sol";
import "forge-std/StdInvariant.sol";

import {GoldOracle} from "../../src/core/GoldOracle.sol";
import {MockAggregatorV3} from "../../src/test/mocks/MockAggregatorV3.sol";

/// @notice Drives XAUT's market feed anywhere (including stopped), gold up and down (and
///         stopped), PAXG only inside its gold band, lets time pass, and fires freezes,
///         unfreezes, normal reads and emergency reads in any order. Every price XAUT is served
///         is checked against the rules of the plan's sections 3 and 4, transcribed here.
contract IsolationHandler is Test {
    GoldOracle internal oracle;
    MockAggregatorV3 internal paxgFeed;
    MockAggregatorV3 internal xautFeed;
    MockAggregatorV3 internal anchorFeed;
    address internal paxg;
    address internal xaut;

    /// @notice Gold's level; the anchor publishes it unless stopped.
    int256 public gold = 4000e8;
    bool public goldStopped;

    /// @notice Prices served that the rules would not have given.
    uint256 public ruleViolations;
    /// @notice Borrow prices above the liquidation price or above gold, or reserve prices below
    ///         gold or below C.
    uint256 public borrowViolations;
    /// @notice Normal prices served for a frozen token.
    uint256 public frozenServed;
    /// @notice Any liquidation price served (normal or emergency) while C or G was unhealthy.
    uint256 public staleServed;
    uint256 public pricesServed;

    constructor(
        GoldOracle _oracle,
        MockAggregatorV3 _paxgFeed,
        MockAggregatorV3 _xautFeed,
        MockAggregatorV3 _anchorFeed,
        address _paxg,
        address _xaut
    ) {
        oracle = _oracle;
        paxgFeed = _paxgFeed;
        xautFeed = _xautFeed;
        anchorFeed = _anchorFeed;
        paxg = _paxg;
        xaut = _xaut;
    }

    function _push(MockAggregatorV3 feed, int256 price) internal {
        feed.setLatestRoundData(1, price, block.timestamp, block.timestamp, 1);
    }

    function _publishGoldAndPaxg() internal {
        if (!goldStopped) _push(anchorFeed, gold);
        _push(paxgFeed, gold);
    }

    // ---------- actions ----------

    function moveXaut(uint256 seed) external {
        // Half the moves land near the band and clamp edges (where the rules change), half
        // anywhere.
        if (seed % 2 == 0) {
            int256 offsetPpm = int256(bound(seed >> 1, 0, 120_000)) - 60_000;
            _push(xautFeed, gold + (gold * offsetPpm) / 1e6);
        } else {
            _push(xautFeed, int256(bound(seed, 1e8, 8000e8)));
        }
    }

    function stopXaut() external {
        xautFeed.setLatestRoundData(1, gold, block.timestamp - 100_000, block.timestamp - 100_000, 1);
    }

    /// @dev Gold moves up to 10% either way and publishes again; PAXG follows it.
    function moveGold(uint256 seed) external {
        int256 offsetPpm = int256(bound(seed, 0, 200_000)) - 100_000;
        gold = gold + (gold * offsetPpm) / 1e6;
        if (gold < 1000e8) gold = 1000e8;
        goldStopped = false;
        _publishGoldAndPaxg();
    }

    /// @dev Gold stops: its last answer ages past the staleness threshold.
    function stopGold() external {
        goldStopped = true;
        anchorFeed.setLatestRoundData(1, gold, block.timestamp - 100_000, block.timestamp - 100_000, 1);
    }

    function movePaxgInsideItsBand(uint256 seed) external {
        // Within 1.5% of gold: always inside the 2% band.
        int256 offsetPpm = int256(bound(seed, 0, 30_000)) - 15_000;
        _push(paxgFeed, gold + (gold * offsetPpm) / 1e6);
        if (!goldStopped) oracle.getTokenPrice(paxg);
    }

    /// @dev Time passes; gold and PAXG keep publishing, XAUT's feed ages where it is.
    function wait(uint256 seed) external {
        vm.warp(vm.getBlockTimestamp() + bound(seed, 1 minutes, 30 hours));
        _publishGoldAndPaxg();
    }

    /// @dev Rare: a freeze lasts 14 days of simulated time and would otherwise starve the
    ///      pricing rows of calls.
    function freeze(uint256 seed) external {
        if (seed % 16 != 0) return;
        try oracle.freezeToken(xaut) {} catch {}
    }

    function unfreeze() external {
        try oracle.guardianUnfreezeToken(xaut, oracle.freezeEpoch(xaut)) {
            _checkLiquidation(oracle.getLastKnownPrice(xaut));
        } catch {}
    }

    function readXaut() external {
        bool frozen = oracle.tokenFrozen(xaut);
        try oracle.getTokenPrice(xaut) returns (uint256 price) {
            pricesServed++;
            if (frozen) frozenServed++;
            _checkLiquidation(price);
        } catch {}
        try oracle.getBorrowPrice(xaut) returns (uint256 price) {
            if (frozen) frozenServed++;
            _checkBorrow(price);
        } catch {}
        try oracle.getReservePrice(xaut) returns (uint256 price) {
            if (frozen) frozenServed++;
            _checkReserve(price);
        } catch {}
    }

    function emergencyRead(bool vaultPaused) external {
        bool frozen = oracle.tokenFrozen(xaut);
        try oracle.getEmergencyPrice(xaut, vaultPaused) returns (uint256) {
            // Frozen, paused or not: the freeze stops every seizure.
            if (frozen) frozenServed++;
            (, bool cOk) = _read(xautFeed);
            (, bool gOk) = _read(anchorFeed);
            if (!cOk || !gOk) staleServed++;
        } catch {}
    }

    // ---------- the rules, transcribed ----------

    function _read(MockAggregatorV3 feed) internal view returns (uint256 price, bool ok) {
        (, int256 answer,, uint256 updatedAt,) = feed.latestRoundData();
        if (answer <= 0 || updatedAt == 0 || updatedAt > block.timestamp) return (0, false);
        if (block.timestamp - updatedAt >= oracle.stalenessThreshold()) return (0, false);
        return (uint256(answer), true);
    }

    function _clampTo(uint256 x, uint256 ref, uint256 w) internal pure returns (uint256) {
        uint256 lo = ref * (1e6 - w) / 1e6;
        uint256 hi = ref * (1e6 + w) / 1e6;
        return x < lo ? lo : (x > hi ? hi : x);
    }

    function _checkLiquidation(uint256 price) internal {
        (uint256 c, bool cOk) = _read(xautFeed);
        (uint256 g, bool gOk) = _read(anchorFeed);
        if (!cOk || !gOk) {
            staleServed++;
            return;
        }
        // min(max(C, G), G x (1 + m)): never below gold, at most m above it.
        uint256 cap = g * (1e6 + oracle.liquidationClampPpm(xaut)) / 1e6;
        uint256 expected = c <= g ? g : (c > cap ? cap : c);
        if (price != expected) ruleViolations++;
        if (price < g) ruleViolations++;
    }

    /// @dev C and G healthy, C inside the band.
    function _banded() internal view returns (uint256 c, uint256 g, bool ok) {
        bool cOk;
        bool gOk;
        (c, cOk) = _read(xautFeed);
        (g, gOk) = _read(anchorFeed);
        ok = cOk && gOk && _clampTo(c, g, oracle.goldBandPpm(xaut)) == c;
    }

    function _checkBorrow(uint256 price) internal {
        (uint256 c, uint256 g, bool ok) = _banded();
        if (!ok || price != (c < g ? c : g)) {
            ruleViolations++;
            return;
        }
        uint256 liq;
        try oracle.quoteTokenPrice(xaut) returns (uint256 l) {
            liq = l;
        } catch {
            borrowViolations++; // a borrow price without a liquidation price
            return;
        }
        if (price > liq || price > g) borrowViolations++;
    }

    function _checkReserve(uint256 price) internal {
        (uint256 c, uint256 g, bool ok) = _banded();
        if (!ok || price != (c > g ? c : g)) ruleViolations++;
        if (price < g || price < c) borrowViolations++;
    }
}

/// @title Token-isolated pricing invariants (oracle plan sections 3 and 4)
contract TokenIsolationInvariantTest is StdInvariant, Test {
    GoldOracle internal oracle;
    MockAggregatorV3 internal paxgFeed;
    MockAggregatorV3 internal xautFeed;
    MockAggregatorV3 internal anchor;
    IsolationHandler internal handler;
    address internal paxg = address(0xBA76);
    address internal xaut = address(0x7A07);

    function setUp() public {
        vm.warp(1_700_000_000);
        paxgFeed = new MockAggregatorV3(8);
        xautFeed = new MockAggregatorV3(8);
        anchor = new MockAggregatorV3(8);
        _push(paxgFeed);
        _push(xautFeed);
        _push(anchor);
        oracle = new GoldOracle(address(paxgFeed), address(xautFeed), paxg, xaut, 90000);
        oracle.setAnchorFeed(address(anchor));
        oracle.getTokenPrice(paxg);
        oracle.getTokenPrice(xaut);

        handler = new IsolationHandler(oracle, paxgFeed, xautFeed, anchor, paxg, xaut);
        oracle.grantGuardianRole(address(handler));
        targetContract(address(handler));
    }

    function _push(MockAggregatorV3 feed) internal {
        feed.setLatestRoundData(1, 4000e8, block.timestamp, block.timestamp, 1);
    }

    /// @notice Whatever XAUT does, PAXG never freezes, and prices and borrows whenever gold is
    ///         healthy.
    function invariant_paxgIsIsolatedFromXaut() public {
        assertFalse(oracle.tokenFrozen(paxg), "PAXG frozen");
        assertFalse(oracle.paused(), "global pause");
        if (handler.goldStopped()) return;
        oracle.getTokenPrice(paxg);
        oracle.getBorrowPrice(paxg);
    }

    /// @notice A frozen token never prices through the normal path.
    function invariant_frozenTokenNeverPricesNormally() public {
        assertEq(handler.frozenServed(), 0);
        if (!oracle.tokenFrozen(xaut)) return;
        vm.expectRevert(bytes("Token frozen"));
        oracle.getTokenPrice(xaut);
        vm.expectRevert(bytes("Token frozen"));
        oracle.getBorrowPrice(xaut);
        vm.expectRevert(bytes("Token frozen"));
        oracle.getReservePrice(xaut);
    }

    /// @notice Every liquidation, borrow and reserve price served follows its rule, and no
    ///         liquidation price is ever below gold.
    function invariant_pricesFollowTheRules() public view {
        assertEq(handler.ruleViolations(), 0);
    }

    /// @notice No liquidation, emergency path included, ever prices XAUT while its market feed
    ///         or gold is unhealthy.
    function invariant_noPriceOnAStaleMarketFeed() public view {
        assertEq(handler.staleServed(), 0);
    }

    /// @notice The borrow price never exceeds the liquidation price or gold, and the reserve
    ///         price is never below either source.
    function invariant_borrowAndReserveBounds() public view {
        assertEq(handler.borrowViolations(), 0);
        try oracle.quoteBorrowPrice(xaut) returns (uint256 borrowPrice) {
            uint256 liq = oracle.quoteTokenPrice(xaut);
            assertLe(borrowPrice, liq);
            assertLe(borrowPrice, uint256(handler.gold()));
            assertGe(oracle.quoteReservePrice(xaut), uint256(handler.gold()));
        } catch {}
    }
}
