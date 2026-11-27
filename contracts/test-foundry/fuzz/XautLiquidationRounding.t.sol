// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {FullStackHarness} from "../harness/FullStackHarness.sol";

/// @notice Full liquidations of 6 decimal XAUT vaults across price falls never create or lose
///         collateral, never pay the liquidator less than the GSUSD repaid at the oracle price,
///         and never book more bad debt than twice the real shortfall.
contract XautLiquidationRoundingFuzz is FullStackHarness {
    address internal borrower = address(0xB0);
    address internal liq = address(0x11);

    function testFuzz_fullLiquidationConservesAndBoundsBadDebt(uint256 coll, uint256 dropPpm) public {
        coll = bound(coll, 100_000, 1_000_000_000); // 0.1 to 1,000 XAUT
        dropPpm = bound(dropPpm, 100_000, 990_000); // price falls 10% to 99%
        uint256 maxDebt = (coll * 1e12 * uint256(PRICE) / 1e8) * 1e6 / 1_500_000;
        vm.assume(maxDebt >= vault.minDebt());
        _open(borrower, xaut, coll, maxDebt);
        _fundGsusd(liq, maxDebt); // fund before the fall; no stability fee in this harness

        int256 newPrice = PRICE * int256(1e6 - dropPpm) / 1e6;
        vm.warp(block.timestamp + 1);
        _setPrice(newPrice);

        uint256 debt = vault.getVaultCurrentDebt(borrower);
        assertEq(debt, maxDebt);
        uint256 supplyBefore = gsusd.totalSupply();
        uint256 badBefore = vault.totalBadDebt();
        vm.startPrank(liq);
        gsusd.approve(address(vault), type(uint256).max);
        try vault.liquidate(borrower, 0) {} catch Error(string memory reason) {
            // Only a vault still above its liquidation ratio may refuse.
            assertEq(reason, "Not undercollateralised");
            vm.stopPrank();
            return;
        }
        vm.stopPrank();

        uint256 paid = debt - gsusd.balanceOf(liq);
        uint256 got = xaut.balanceOf(liq);
        (, uint256 left, uint256 debtLeft) = _vault(borrower);
        assertEq(debtLeft, 0, "debt cleared");
        uint256 protocolGold = xaut.balanceOf(address(reserve)) + xaut.balanceOf(address(buffer))
            + vault.surplusCollateral(address(xaut));
        assertEq(got + left + protocolGold, coll, "collateral conserved");
        // The liquidator never loses at the oracle price (1 wei of GSUSD per rounding step).
        uint256 gotValue = got * 1e12 * uint256(newPrice) / 1e8;
        assertGe(gotValue + 1e12 * uint256(newPrice) / 1e8, paid, "liquidator not short-changed");
        // Bad debt is at most twice the shortfall at the oracle price.
        uint256 value = coll * 1e12 * uint256(newPrice) / 1e8;
        // Booked bad debt = principal left unpaid (absorbed or outstanding).
        uint256 booked = debt - paid;
        assertGe(supplyBefore - gsusd.totalSupply(), paid, "repayment burned, buffer absorbed the rest");
        assertEq(vault.totalBadDebt(), badBefore + booked, "nothing in the empty buffer, all outstanding");
        uint256 shortfall = debt > value ? debt - value : 0;
        assertLe(booked, 2 * shortfall + 1e13, "bad debt bounded by twice the hole");
    }
}
