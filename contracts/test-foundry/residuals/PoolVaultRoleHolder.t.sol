// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {FullStackHarness} from "../harness/FullStackHarness.sol";

/// @notice Pins an accepted residual of docs/THREAT_MODEL.md (G12): the stability pool
///         trusts whoever holds its VAULT_ROLE. It pays the GSUSD it is asked to absorb and
///         credits depositors with whatever collateral arrived, nothing included. The
///         pull-style absorb that named a collateral amount is gone, which removes an unused
///         entry point but not this trust: absorbLiquidationPrefunded with no gold sent ahead
///         takes the same GSUSD. The role is granted by the pool's admin (the timelock after
///         the handover), so reaching this needs a timelock operation and its 48 hours.
///         If this test fails, the behaviour changed: update the threat model.
contract PoolVaultRoleHolderResidual is FullStackHarness {
    address internal depositor = address(0xD0);
    address internal holder = address(0xBAD);

    function test_aSecondRoleHolderTakesDepositorsGsusdForNoCollateral() public {
        _fundGsusd(depositor, 100_000e18);
        vm.startPrank(depositor);
        gsusd.approve(address(pool), 100_000e18);
        pool.deposit(100_000e18);
        vm.stopPrank();

        // The admin (this test, the timelock in production) grants the role.
        pool.grantRole(pool.VAULT_ROLE(), holder);

        vm.prank(holder);
        pool.absorbLiquidationPrefunded(address(paxg), 100_000e18 - 1);

        assertEq(gsusd.balanceOf(holder), 100_000e18 - 1, "all but one wei of the pool's GSUSD");
        assertEq(pool.getTotalDeposits(), 1);
        assertEq(pool.getCollateralGain(depositor, address(paxg)), 0, "and the depositor was credited nothing");
    }

    function test_withoutTheRoleTheSameCallIsRefused() public {
        _fundGsusd(depositor, 100_000e18);
        vm.startPrank(depositor);
        gsusd.approve(address(pool), 100_000e18);
        pool.deposit(100_000e18);
        vm.stopPrank();

        vm.prank(holder);
        vm.expectRevert();
        pool.absorbLiquidationPrefunded(address(paxg), 1e18);
    }
}
