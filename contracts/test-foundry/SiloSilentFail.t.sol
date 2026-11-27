// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import "forge-std/Test.sol";
import {SiloFactory} from "../src/core/CollateralSilo.sol";
import {MockERC20SilentFail} from "../src/test/mocks/MockERC20SilentFail.sol";

/// @notice A token that returns false rather than reverting must not be able to make a
///         deposit "succeed" while crediting nothing. GoldVault.deposit pulls the user's
///         collateral into itself BEFORE calling the factory, so a silent zero credit
///         would leave those tokens stranded in the vault against an empty position.
contract SiloSilentFailTest is Test {
    SiloFactory internal factory;
    MockERC20SilentFail internal token;
    address internal vault = address(0xBEEF);

    function setUp() public {
        factory = new SiloFactory(100e18);
        factory.grantRole(factory.VAULT_ROLE(), vault);
        token = new MockERC20SilentFail();
        token.mint(vault, 1000e18);
        vm.prank(vault);
        token.approve(address(factory), type(uint256).max);
    }

    function test_silent_false_reverts_rather_than_crediting_zero() public {
        token.setFailSilently(true);
        vm.prank(vault);
        vm.expectRevert("Too many unusable silos");
        factory.deposit(address(token), 10e18);
    }

    function test_honest_token_still_credits_normally() public {
        vm.prank(vault);
        uint256 credited = factory.deposit(address(token), 10e18);
        assertEq(credited, 10e18, "conforming transfer must credit in full");
        assertEq(factory.totalCollateral(address(token)), 10e18);
    }

    function test_no_collateral_is_recorded_when_the_transfer_lies() public {
        token.setFailSilently(true);
        vm.prank(vault);
        try factory.deposit(address(token), 10e18) {
            fail();
        } catch {}
        // The revert rolls everything back: the depositor keeps their tokens.
        assertEq(factory.totalCollateral(address(token)), 0);
        assertEq(token.balanceOf(vault), 1000e18);
    }
}
