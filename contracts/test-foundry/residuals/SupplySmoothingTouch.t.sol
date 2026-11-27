// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import "forge-std/Test.sol";
import {GoldStablecoin} from "../../src/core/GoldStablecoin.sol";

/// @notice Pins a documented property of the one-day supply smoothing: every mint or burn
///         banks the average where it stands and restarts the day, so touching the supply
///         slows the average's approach to the live supply and can never speed it up. A burn
///         of zero does it for no GSUSD, and a burn of one wei does the same, so refusing
///         zero-value burns would change nothing. The only effect is that the reserve's spread
///         and the buffer's floor stay on the cautious side for longer after a contraction.
///         If this test fails, the behaviour changed: update docs/SPECIFICATION.md.
contract SupplySmoothingTouchResidual is Test {
    GoldStablecoin internal gsusd;
    address internal holder = address(0xA1);
    address internal stranger = address(0xB2);

    function setUp() public {
        vm.warp(1_700_000_000);
        gsusd = new GoldStablecoin();
        gsusd.grantRole(gsusd.MINTER_ROLE(), address(this));
        gsusd.mint(holder, 1_000_000e18);
        vm.warp(vm.getBlockTimestamp() + 2 days);
        // Settle the average at the live supply, then contract the supply by half.
        vm.prank(holder);
        gsusd.burn(1);
        vm.warp(vm.getBlockTimestamp() + 2 days);
        vm.prank(holder);
        gsusd.burn(500_000e18);
    }

    function test_untouchedTheAverageReachesTheLiveSupplyInOneDay() public {
        uint256 live = gsusd.totalSupply();
        assertGt(gsusd.smoothedSupplyNow(), live);
        vm.warp(vm.getBlockTimestamp() + 12 hours);
        assertApproxEqAbs(gsusd.smoothedSupplyNow(), live + 250_000e18, 1e18, "half way after half a day");
        vm.warp(vm.getBlockTimestamp() + 12 hours);
        assertEq(gsusd.smoothedSupplyNow(), live, "there after one day");
    }

    function test_zeroValueBurnsByAStrangerSlowTheDecayAndNeverSpeedIt() public {
        uint256 live = gsusd.totalSupply();
        uint256 start = vm.getBlockTimestamp();
        for (uint256 i = 1; i <= 24; i++) {
            vm.warp(start + i * 1 hours);
            uint256 untouchedPath = live + 500_000e18 * (24 - i) / 24;
            vm.prank(stranger);
            gsusd.burn(0);
            assertGe(gsusd.smoothedSupplyNow() + 1e18, untouchedPath, "never below the untouched path");
        }
        // After a day of hourly touches the average is still well above the live supply
        // (about (23/24)^24, some 36% of the gap, remains).
        uint256 gapLeft = gsusd.smoothedSupplyNow() - live;
        assertGt(gapLeft, 150_000e18);
        assertLt(gapLeft, 200_000e18);
        assertEq(gsusd.totalSupply(), live, "no GSUSD was burned");
    }

    function test_oneWeiBurnsDoTheSame() public {
        uint256 start = vm.getBlockTimestamp();
        uint256 snap = vm.snapshotState();
        for (uint256 i = 1; i <= 24; i++) {
            vm.warp(start + i * 1 hours);
            vm.prank(stranger);
            gsusd.burn(0);
        }
        uint256 withZero = gsusd.smoothedSupplyNow();
        vm.revertToState(snap);
        for (uint256 i = 1; i <= 24; i++) {
            vm.warp(start + i * 1 hours);
            vm.prank(holder);
            gsusd.burn(1);
        }
        assertApproxEqAbs(gsusd.smoothedSupplyNow(), withZero, 1e6, "a one wei burn slows the decay just as much");
    }
}
