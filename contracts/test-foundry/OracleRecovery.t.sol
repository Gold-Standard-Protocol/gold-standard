// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import "forge-std/Test.sol";
import {GoldOracle} from "../src/core/GoldOracle.sol";
import {MockAggregatorV3} from "../src/test/mocks/MockAggregatorV3.sol";

/// @notice Direct coverage for the oracle recovery surface: getValidatedPrice (used by the
///         emergency floor and the reserve), resyncLastKnownPrice, the manual freeze and the
///         per-token band and clamp setters.
contract OracleRecoveryTest is Test {
    GoldOracle internal oracle;
    MockAggregatorV3 internal paxgFeed;
    MockAggregatorV3 internal xautFeed;
    address internal paxg = address(0xBA76);
    address internal xaut = address(0x7A07);

    function setUp() public {
        paxgFeed = new MockAggregatorV3(8);
        xautFeed = new MockAggregatorV3(8);
        vm.warp(1_000_000);
        _push(paxgFeed, 2000e8);
        _push(xautFeed, 2000e8);
        oracle = new GoldOracle(address(paxgFeed), address(xautFeed), paxg, xaut, 3600);
        oracle.getTokenPrice(paxg); // seed lastKnown = 2000e8
        oracle.getTokenPrice(xaut);
    }

    function _push(MockAggregatorV3 feed, int256 price) internal {
        feed.setLatestRoundData(1, price, block.timestamp, block.timestamp, 1);
    }

    function test_getValidatedPrice_freshValid() public view {
        (uint256 p, bool ok) = oracle.getValidatedPrice(paxg);
        assertTrue(ok);
        assertEq(p, 2000e8);
    }

    function test_getValidatedPrice_staleReturnsFalse() public {
        vm.warp(block.timestamp + 4000); // exceed stalenessThreshold (3600)
        (uint256 p, bool ok) = oracle.getValidatedPrice(paxg);
        assertFalse(ok);
        assertEq(p, 0);
    }

    function test_getValidatedPrice_nonPositiveReturnsFalse() public {
        paxgFeed.setLatestRoundData(2, 0, block.timestamp, block.timestamp, 2);
        (, bool ok) = oracle.getValidatedPrice(paxg);
        assertFalse(ok);
    }

    function test_getValidatedPrice_incompleteRoundReturnsFalse() public {
        paxgFeed.setLatestRoundData(5, 2000e8, block.timestamp, block.timestamp, 4); // answeredInRound < roundId
        (, bool ok) = oracle.getValidatedPrice(paxg);
        assertFalse(ok);
    }

    function test_getValidatedPrice_worksWhilePaused() public {
        // Move the feed >10% and pause the oracle.
        _push(paxgFeed, 2400e8);
        oracle.emergencyPause();
        assertTrue(oracle.paused());
        // getValidatedPrice still returns the live value while paused (unlike getTokenPrice).
        (uint256 p, bool ok) = oracle.getValidatedPrice(paxg);
        assertTrue(ok);
        assertEq(p, 2400e8);
    }

    function test_getValidatedPrice_unsupportedTokenFalse() public view {
        (uint256 p, bool ok) = oracle.getValidatedPrice(address(0xDEAD));
        assertFalse(ok);
        assertEq(p, 0);
    }

    function test_aLargeRealMoveNeverWedges() public {
        // With no step gate, a 20% single-jump move prices at once (no gold reference here);
        // lastKnown follows the read and resync is a refresh, not an unwedging.
        _push(paxgFeed, 2400e8);
        assertEq(oracle.getTokenPrice(paxg), 2400e8);
        assertEq(oracle.lastKnownPaxgPrice(), 2400e8);
        _push(paxgFeed, 2450e8);
        oracle.resyncLastKnownPrice(paxg);
        assertEq(oracle.lastKnownPaxgPrice(), 2450e8);
    }

    /// The guardian (or governance) freezes one token by hand and lifts the freeze once
    ///        a normal read succeeds, with no timelock.
    function test_freezeAndUnfreeze() public {
        _push(paxgFeed, 2400e8);
        oracle.freezeToken(paxg);
        assertTrue(oracle.tokenFrozen(paxg));
        assertFalse(oracle.paused());
        vm.expectRevert(bytes("Token frozen"));
        oracle.getTokenPrice(paxg);
        assertEq(oracle.getTokenPrice(xaut), 2000e8, "the other token is untouched");
        vm.warp(block.timestamp + 4000); // C stale: no normal read, no unfreeze
        uint256 epoch = oracle.freezeEpoch(paxg);
        vm.expectRevert(bytes("No reliable price"));
        oracle.guardianUnfreezeToken(paxg, epoch);
        _push(paxgFeed, 2400e8);
        oracle.guardianUnfreezeToken(paxg, epoch);
        assertEq(oracle.getTokenPrice(paxg), 2400e8);
    }

    function test_resync_onlyGovernance() public {
        vm.prank(address(0xBEEF));
        vm.expectRevert();
        oracle.resyncLastKnownPrice(paxg);
    }

    function test_resync_revertsWithoutANormalPrice() public {
        vm.warp(block.timestamp + 4000); // C stale: no rule applies
        vm.expectRevert(bytes("No reliable price"));
        oracle.resyncLastKnownPrice(paxg);
    }

    function test_bandSetters_bounds() public {
        oracle.setGoldBand(paxg, 5_000);
        oracle.setGoldBand(paxg, 100_000);
        assertEq(oracle.goldBandPpm(paxg), 100_000);
        vm.expectRevert(bytes("Band out of range"));
        oracle.setGoldBand(paxg, 4_999);
        vm.expectRevert(bytes("Band out of range"));
        oracle.setGoldBand(paxg, 100_001);
        oracle.setLiquidationClamp(paxg, 5_000);
        oracle.setLiquidationClamp(paxg, 50_000);
        assertEq(oracle.liquidationClampPpm(paxg), 50_000);
        assertEq(oracle.liquidationClampPpm(xaut), 20_000, "per token");
        vm.expectRevert(bytes("Clamp out of range"));
        oracle.setLiquidationClamp(paxg, 4_999);
        vm.expectRevert(bytes("Clamp out of range"));
        oracle.setLiquidationClamp(paxg, 50_001);
        vm.expectRevert(bytes("Unsupported token"));
        oracle.setGoldBand(address(0xDEAD), 20_000);
        vm.prank(address(0xBEEF));
        vm.expectRevert();
        oracle.setGoldBand(paxg, 20_000);
    }
}
