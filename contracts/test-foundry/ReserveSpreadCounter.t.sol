// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {FullStackHarness} from "./harness/FullStackHarness.sol";
import {RevertingFeeBuffer} from "./harness/RevertingFeeBuffer.sol";

/// @notice `totalSpreadPaid` counts the spread the surplus buffer actually took. A spread
///         the buffer could not take stays in the reserve's GSUSD inventory, and counting
///         it as paid as well put the same GSUSD in two terms of
///         totalGsusdReceived == gsusdInventory + totalSpreadPaid + totalGsusdWithdrawn.
contract ReserveSpreadCounterTest is FullStackHarness {
    address internal swapper = address(0x5A);

    event FeeRoutingFailed(uint256 amount);

    function setUp() public override {
        super.setUp();
        // 100 PAXG of reserve gold; a 1,000 GSUSD swap pays the 0.5% tier.
        paxg.mint(address(this), 100e18);
        paxg.approve(address(reserve), 100e18);
        reserve.seedCollateral(address(paxg), 100e18);
        _fundGsusd(swapper, 10_000e18);
        vm.prank(swapper);
        gsusd.approve(address(reserve), type(uint256).max);
    }

    function _assertLedger() internal view {
        assertEq(
            reserve.totalGsusdReceived(),
            reserve.gsusdInventory() + reserve.totalSpreadPaid() + reserve.totalGsusdWithdrawn(),
            "received == inventory + spread paid + withdrawn"
        );
        assertEq(gsusd.balanceOf(address(reserve)), reserve.gsusdInventory(), "inventory is what the reserve holds");
    }

    function _swap(uint256 amount) internal returns (uint256 fee) {
        fee = amount * reserve.currentSpreadPpm() / 1e6;
        vm.prank(swapper);
        reserve.swapGsusdForGold(address(paxg), amount, 0);
    }

    function test_spreadTheBufferTookIsCountedAsPaid() public {
        uint256 fee = _swap(1_000e18);
        assertGt(fee, 0);
        assertEq(reserve.totalSpreadPaid(), fee);
        assertEq(reserve.gsusdInventory(), 1_000e18 - fee);
        assertEq(buffer.totalFeesReceivedFrom(address(reserve)), fee);
        _assertLedger();
    }

    function test_spreadKeptWithNoBufferIsInventoryAndNotCountedAsPaid() public {
        reserve.setSurplusBuffer(address(0));
        vm.expectEmit(false, false, false, true, address(reserve));
        emit FeeRoutingFailed(5e18);
        uint256 fee = _swap(1_000e18);
        assertEq(fee, 5e18);
        assertEq(reserve.totalSpreadPaid(), 0, "nothing was paid to a buffer");
        assertEq(reserve.gsusdInventory(), 1_000e18, "the whole payment is inventory");
        _assertLedger();
    }

    function test_spreadARevertingBufferRefusedIsInventoryAndNotCountedAsPaid() public {
        RevertingFeeBuffer broken = new RevertingFeeBuffer();
        reserve.setSurplusBuffer(address(broken));
        _swap(1_000e18);
        assertEq(reserve.totalSpreadPaid(), 0);
        assertEq(reserve.gsusdInventory(), 1_000e18);
        assertEq(gsusd.allowance(address(reserve), address(broken)), 0, "no allowance left behind");
        _assertLedger();
    }

    function test_counterResumesOnceTheBufferTakesTheSpreadAgain() public {
        reserve.setSurplusBuffer(address(0));
        _swap(1_000e18);
        reserve.setSurplusBuffer(address(buffer));
        uint256 fee = _swap(2_000e18);
        assertEq(reserve.totalSpreadPaid(), fee, "only the second spread was paid");
        assertEq(reserve.gsusdInventory(), 3_000e18 - fee);
        _assertLedger();

        // Withdrawing inventory, the retained spread included, keeps the ledger whole.
        reserve.withdrawGsusd(address(0xCAFE), 1_500e18);
        _assertLedger();
    }

    function testFuzz_ledgerHoldsWhateverTheBufferDoes(uint256 amount, uint8 mode) public {
        amount = bound(amount, 1e18, 9_000e18);
        mode = mode % 3;
        if (mode == 1) reserve.setSurplusBuffer(address(0));
        if (mode == 2) reserve.setSurplusBuffer(address(new RevertingFeeBuffer()));
        uint256 fee = _swap(amount);
        assertEq(reserve.totalSpreadPaid(), mode == 0 ? fee : 0);
        _assertLedger();
    }
}
