// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {FullStackHarness} from "../harness/FullStackHarness.sol";
import {MockAggregatorV3} from "../../src/test/mocks/MockAggregatorV3.sol";

/// @notice Pins accepted residual 8 of docs/THREAT_MODEL.md: during a
///         PAXG-specific depeg the settlement price is floored at gold, so a permissionless keeper
///         can make the stability pool buy depegged PAXG at the gold price. The keeper's bounty is
///         a share of the nominal penalty, so the call pays the keeper even when the pool loses at
///         market. If this test fails, the behaviour changed: update the threat model and the docs.
contract DepegPoolOverpaysResidual is FullStackHarness {
    MockAggregatorV3 internal gold;
    address internal borrower = address(0xB0);
    address internal depositor = address(0xD0);
    address internal keeper = address(0xEE);

    function setUp() public override {
        super.setUp();
        gold = new MockAggregatorV3(8);
        _push(gold, PRICE);
        oracle.setAnchorFeed(address(gold));
        _open(borrower, paxg, 100e18, 266_000e18);
        _fundGsusd(depositor, 500_000e18);
        vm.startPrank(depositor);
        gsusd.approve(address(pool), 500_000e18);
        pool.deposit(500_000e18);
        vm.stopPrank();
        vm.roll(block.number + 1);
    }

    function test_keeperMakesThePoolBuyDepeggedGoldAtTheGoldPrice() public {
        // Gold falls to $2,900; PAXG trades 10% under gold at $2,610 (off the 2% band).
        vm.warp(block.timestamp + 1 hours);
        _push(gold, 2_900e8);
        _push(paxgFeed, 2_610e8);
        assertEq(oracle.quoteTokenPrice(address(paxg)), 2_900e8, "seizures priced at gold");

        uint256 poolBefore = pool.getTotalDeposits();
        vm.prank(keeper);
        vault.liquidateViaPool(borrower, 0);

        uint256 paid = poolBefore - pool.getTotalDeposits();
        uint256 goldIn = pool.getCollateralGain(depositor, address(paxg));
        uint256 marketValue = goldIn * 2_610e8 / 1e8; // 18 dec USD
        emit log_named_decimal_uint("pool paid (GSUSD)", paid, 18);
        emit log_named_decimal_uint("pool received (PAXG)", goldIn, 18);
        emit log_named_decimal_uint("market value received (USD)", marketValue, 18);
        emit log_named_decimal_uint("keeper bounty (PAXG)", paxg.balanceOf(keeper), 18);
        assertGt(paxg.balanceOf(keeper), 0, "keeper is paid");
        assertLt(marketValue, paid * 94 / 100, "pool depositors lose over 6% at market");
    }
}
