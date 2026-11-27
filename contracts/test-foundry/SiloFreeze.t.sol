// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import "forge-std/Test.sol";
import {SiloFactory, CollateralSilo} from "../src/core/CollateralSilo.sol";
import {MockERC20Freezable} from "../src/test/mocks/MockERC20Freezable.sol";

/// @notice Regression: SiloFactory.withdraw routes around issuer-frozen silos instead of
///         bricking all withdrawals/liquidations, and rolls back cleanly if no unfrozen silo can
///         cover the amount.
contract SiloFreezeTest is Test {
    SiloFactory internal factory;
    MockERC20Freezable internal tok;
    address internal recipient = address(0xBEEF);
    uint256 internal constant CAP = 10e18;

    function setUp() public {
        tok = new MockERC20Freezable("Pax Gold", "PAXG");
        factory = new SiloFactory(CAP);
        factory.grantRole(factory.VAULT_ROLE(), address(this));
    }

    function _deposit(uint256 amount) internal {
        tok.mint(address(this), amount);
        tok.approve(address(factory), amount);
        factory.deposit(address(tok), amount);
    }

    function test_withdraw_routes_around_frozen_silo() public {
        // 25 oz at cap 10 -> 3 silos: [10, 10, 5]
        _deposit(25e18);
        assertEq(factory.getSiloCount(address(tok)), 3, "expected 3 silos");

        // Freeze the most-recent silo (the one LIFO withdrawal hits first).
        address silo2 = factory.getSilo(address(tok), 2);
        tok.setFrozen(silo2, true);

        // Withdraw 8: silo2 (frozen, holds 5) is skipped; sourced from silo1 instead.
        factory.withdraw(address(tok), recipient, 8e18);

        assertEq(tok.balanceOf(recipient), 8e18, "recipient should receive full amount via unfrozen silos");
        assertEq(CollateralSilo(silo2).balance(), 5e18, "frozen silo retains its balance");
        assertEq(factory.totalCollateral(address(tok)), 17e18, "totalCollateral decremented by exactly 8");
    }

    function test_withdraw_reverts_and_rolls_back_when_all_silos_frozen() public {
        _deposit(25e18);
        uint256 n = factory.getSiloCount(address(tok));
        for (uint256 i = 0; i < n; i++) {
            tok.setFrozen(factory.getSilo(address(tok), i), true);
        }

        // No unfrozen silo can cover the amount -> revert and full rollback.
        vm.expectRevert();
        factory.withdraw(address(tok), recipient, 1e18);

        assertEq(factory.totalCollateral(address(tok)), 25e18, "totalCollateral must be unchanged after rollback");
        assertEq(tok.balanceOf(recipient), 0, "recipient must receive nothing");
    }

    function test_withdraw_all_from_unfrozen_after_freezing_one() public {
        _deposit(25e18); // [10,10,5]
        tok.setFrozen(factory.getSilo(address(tok), 1), true); // freeze the middle silo (holds 10)

        // 15 oz is available across the two unfrozen silos (10 + 5); withdrawing it must succeed.
        factory.withdraw(address(tok), recipient, 15e18);
        assertEq(tok.balanceOf(recipient), 15e18, "should drain both unfrozen silos");
        assertEq(factory.totalCollateral(address(tok)), 10e18, "only the frozen silo's 10 remains tracked");
    }
}
