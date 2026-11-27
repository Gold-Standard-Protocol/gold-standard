// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {FullStackHarness} from "./harness/FullStackHarness.sol";
import {StabilityPool} from "../src/core/StabilityPool.sol";
import {GoldVault} from "../src/core/GoldVault.sol";
import {MockPoolWithoutPrefundedAbsorb, MockPoolDenyingPrefundedAbsorb} from "../src/test/mocks/MockPoolWithoutPrefundedAbsorb.sol";

/// @notice The vault liquidates through its pool with absorbLiquidationPrefunded and nothing
///         else, so setStabilityPool accepts only a pool that declares that path
///         (absorbsPrefunded). A pool without it used to pass the setter's probe and then
///         make every pool liquidation revert until governance replaced it again.
contract StabilityPoolReplacementTest is FullStackHarness {
    address internal borrower = address(0xB0);
    address internal depositor = address(0xD0);
    address internal keeper = address(0xEE);

    function _liquidatableVault() internal {
        _open(borrower, paxg, 100e18, 266_000e18);
        _walkPrice(2_900e8);
    }

    function _fill(StabilityPool target) internal {
        _fundGsusd(depositor, 500_000e18);
        vm.startPrank(depositor);
        gsusd.approve(address(target), 500_000e18);
        target.deposit(500_000e18);
        vm.stopPrank();
    }

    function test_realPoolDeclaresThePrefundedPath() public view {
        assertTrue(pool.absorbsPrefunded());
    }

    function test_poolWithoutTheDeclarationIsRefused() public {
        MockPoolWithoutPrefundedAbsorb old = new MockPoolWithoutPrefundedAbsorb();
        // The pool has no such function, so the read itself reverts, with no data.
        vm.expectRevert(bytes(""));
        vault.setStabilityPool(address(old));
        assertEq(address(vault.stabilityPool()), address(pool), "the working pool stays wired");
    }

    function test_poolThatAnswersFalseIsRefused() public {
        MockPoolDenyingPrefundedAbsorb denying = new MockPoolDenyingPrefundedAbsorb();
        vm.expectRevert(GoldVault.PoolLacksPrefundedAbsorb.selector);
        vault.setStabilityPool(address(denying));
        assertEq(address(vault.stabilityPool()), address(pool));
    }

    function test_poolThatHasNotGrantedTheVaultIsStillRefusedFirst() public {
        StabilityPool fresh = new StabilityPool(address(gsusd));
        vm.expectRevert("Pool has not granted VAULT_ROLE");
        vault.setStabilityPool(address(fresh));
    }

    function test_anAddressWithoutCodeIsStillRefused() public {
        vm.expectRevert("Not a contract");
        vault.setStabilityPool(address(0xDEAD));
    }

    function test_unwiringThePoolStillWorks() public {
        vault.setStabilityPool(address(0));
        assertEq(address(vault.stabilityPool()), address(0));
    }

    function test_replacementPoolIsAcceptedAndLiquidatesThroughIt() public {
        StabilityPool replacement = new StabilityPool(address(gsusd));
        replacement.grantRole(replacement.VAULT_ROLE(), address(vault));
        replacement.addCollateralToken(address(paxg));
        vault.setStabilityPool(address(replacement));
        assertEq(address(vault.stabilityPool()), address(replacement));

        _fill(replacement);
        _liquidatableVault();
        uint256 before = replacement.getTotalDeposits();
        vm.prank(keeper);
        vault.liquidateViaPool(borrower, 0);

        (, uint256 coll, uint256 debt) = _vault(borrower);
        assertEq(debt, 0, "the debt is cleared through the replacement pool");
        assertLt(coll, 100e18, "gold was seized");
        assertEq(before - replacement.getTotalDeposits(), 266_000e18, "the replacement absorbed the debt");
        assertGt(replacement.getCollateralGain(depositor, address(paxg)), 0, "its depositor holds the gain");
        assertGt(paxg.balanceOf(keeper), 0, "the caller was paid");
        assertEq(pool.getTotalDeposits(), 0, "the old pool was not touched");
    }
}
