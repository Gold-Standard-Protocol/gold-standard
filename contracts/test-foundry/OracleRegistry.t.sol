// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import "forge-std/Test.sol";
import {GoldOracle} from "../src/core/GoldOracle.sol";
import {MockAggregatorV3} from "../src/test/mocks/MockAggregatorV3.sol";

/// @notice Coverage for the oracle feed registry: addFeed onboarding, setFeed replacement
///         (lastKnown continuity, independence), the optional XAU/USD gold band and per-token
///         lastKnown isolation. Mirrors the OracleRecovery test style.
contract OracleRegistryTest is Test {
    GoldOracle internal oracle;
    MockAggregatorV3 internal paxgFeed;
    MockAggregatorV3 internal xautFeed;
    MockAggregatorV3 internal kauFeed;
    address internal paxg = address(0xBA76);
    address internal xaut = address(0x7A07);
    address internal kau = address(0xCA0);

    function setUp() public {
        paxgFeed = new MockAggregatorV3(8);
        xautFeed = new MockAggregatorV3(8);
        kauFeed = new MockAggregatorV3(8);
        vm.warp(1_000_000);
        _push(paxgFeed, 2000e8);
        _push(xautFeed, 2000e8);
        _push(kauFeed, 2000e8);
        oracle = new GoldOracle(address(paxgFeed), address(xautFeed), paxg, xaut, 3600);
        oracle.getTokenPrice(paxg); // seed lastKnown = 2000e8
        oracle.getTokenPrice(xaut);
    }

    function _push(MockAggregatorV3 feed, int256 price) internal {
        feed.setLatestRoundData(1, price, block.timestamp, block.timestamp, 1);
    }

    function test_addFeed_registersAndReads() public {
        oracle.addFeed(kau, address(kauFeed));

        (uint256 validated, bool ok) = oracle.getValidatedPrice(kau);
        assertTrue(ok);
        assertEq(validated, 2000e8);

        // The first read records lastKnown.
        assertEq(oracle.getLastKnownPrice(kau), 0);
        uint256 price = oracle.getTokenPrice(kau);
        assertEq(price, 2000e8);
        assertEq(oracle.getLastKnownPrice(kau), 2000e8);

        address[] memory tokens = oracle.getSupportedTokens();
        assertEq(tokens.length, 3);
        assertEq(tokens[2], kau);
    }

    function test_addFeed_duplicateReverts() public {
        vm.expectRevert(bytes("Feed already added"));
        oracle.addFeed(paxg, address(kauFeed));
    }

    function test_addFeed_onlyGovernance() public {
        vm.prank(address(0xBEEF));
        vm.expectRevert();
        oracle.addFeed(kau, address(kauFeed));
    }

    function test_addFeed_rejectsWrongDecimals() public {
        MockAggregatorV3 badFeed = new MockAggregatorV3(18);
        vm.expectRevert(bytes("Must be 8 decimals"));
        oracle.addFeed(kau, address(badFeed));
    }

    function test_setFeed_replacesCAndPreservesLastKnown() public {
        // The replacement sits 20% above the preserved lastKnown of 2000e8. With no step gate
        // the next read simply prices at it; lastKnown is a record, never a gate.
        MockAggregatorV3 replacement = new MockAggregatorV3(8);
        replacement.setLatestRoundData(1, 2400e8, block.timestamp, block.timestamp, 1);
        oracle.setFeed(paxg, address(replacement));
        assertEq(oracle.getLastKnownPrice(paxg), 2000e8);
        assertEq(oracle.getTokenPrice(paxg), 2400e8);
        assertEq(oracle.getLastKnownPrice(paxg), 2400e8);
    }

    function test_setFeed_refusesTheAnchor() public {
        MockAggregatorV3 anchor = new MockAggregatorV3(8);
        oracle.setAnchorFeed(address(anchor));
        vm.expectRevert(bytes("Feed not independent"));
        oracle.setFeed(paxg, address(anchor));
    }

    function test_anchor_staleAnchorStopsBorrowingAndLiquidation() public {
        MockAggregatorV3 anchor = new MockAggregatorV3(8);
        anchor.setLatestRoundData(1, 2000e8, block.timestamp, block.timestamp, 1);
        oracle.setAnchorFeed(address(anchor));

        // The gold reference goes stale while the token feed stays fresh: borrowing and
        // liquidation both stop until gold publishes again.
        vm.warp(block.timestamp + 4000);
        _push(paxgFeed, 1000e8);
        vm.expectRevert(bytes("No reliable price"));
        oracle.getBorrowPrice(paxg);
        vm.expectRevert(bytes("No reliable price"));
        oracle.getTokenPrice(paxg);
    }

    function test_anchor_bandEnforcedAndReplaceable() public {
        MockAggregatorV3 anchor = new MockAggregatorV3(8);
        anchor.setLatestRoundData(1, 2000e8, block.timestamp, block.timestamp, 1);
        oracle.setAnchorFeed(address(anchor));

        // 2% above gold sits on the default band and borrows; 2.5% does not, and liquidation
        // holds it at the clamp's edge.
        _push(paxgFeed, 2040e8);
        assertEq(oracle.getBorrowPrice(paxg), 2000e8);
        assertEq(oracle.getTokenPrice(paxg), 2040e8);
        _push(paxgFeed, 2050e8);
        vm.expectRevert(bytes("Off gold band"));
        oracle.getBorrowPrice(paxg);
        assertEq(oracle.getTokenPrice(paxg), 2040e8);

        // A fresh token 15% above gold: borrowing refused.
        oracle.addFeed(kau, address(kauFeed));
        _push(kauFeed, 2300e8);
        vm.expectRevert(bytes("Off gold band"));
        oracle.getBorrowPrice(kau);

        // A 10% band for that token alone admits 10% (measured against gold); PAXG keeps its
        // own 2%.
        oracle.setGoldBand(kau, 100_000);
        _push(kauFeed, 2200e8);
        assertEq(oracle.getBorrowPrice(kau), 2000e8);
        vm.expectRevert(bytes("Off gold band"));
        oracle.getBorrowPrice(paxg);

        // Once set, the gold reference cannot be cleared; it can only be replaced.
        vm.expectRevert(bytes("Anchor required"));
        oracle.setAnchorFeed(address(0));
        MockAggregatorV3 replacement = new MockAggregatorV3(8);
        replacement.setLatestRoundData(1, 2050e8, block.timestamp, block.timestamp, 1);
        oracle.setAnchorFeed(address(replacement));
        assertEq(oracle.getBorrowPrice(paxg), 2050e8);
    }

    function test_readsOfOneTokenNeverMutateAnother() public {
        oracle.addFeed(kau, address(kauFeed));
        oracle.getTokenPrice(kau); // seed kau lastKnown = 2000e8

        uint256 xautBefore = oracle.getLastKnownPrice(xaut);
        uint256 kauBefore = oracle.getLastKnownPrice(kau);

        _push(paxgFeed, 2100e8);
        oracle.getTokenPrice(paxg);

        assertEq(oracle.getLastKnownPrice(paxg), 2100e8);
        assertEq(oracle.getLastKnownPrice(xaut), xautBefore);
        assertEq(oracle.getLastKnownPrice(kau), kauBefore);

        // Resync of one token leaves every other record untouched.
        _push(paxgFeed, 2600e8);
        oracle.resyncLastKnownPrice(paxg);
        assertEq(oracle.getLastKnownPrice(paxg), 2600e8);
        assertEq(oracle.getLastKnownPrice(xaut), xautBefore);
        assertEq(oracle.getLastKnownPrice(kau), kauBefore);
    }
}
