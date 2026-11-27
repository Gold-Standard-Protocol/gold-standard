// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {FullStackHarness} from "./harness/FullStackHarness.sol";
import {SiloFactory} from "../src/core/CollateralSilo.sol";

/// @dev Stands in for any route around the constructor's guard, so the lock's own check is
///      exercised: it grants LOCKED_ROLE without asking its admin.
contract SiloFactoryForcedGrant is SiloFactory {
    constructor() SiloFactory(100e18) {}

    function forceGrant(bytes32 role, address account) external {
        _grantRole(role, account);
    }
}

/// @notice The custody lock with an empty LOCKED_ROLE. Before the
///         fix the pre-lock admin could grant LOCKED_ROLE to an address it kept; the lock
///         then made that address the permanent, self-administered admin of VAULT_ROLE, able
///         to grant itself VAULT_ROLE and empty every silo after the governance handover.
contract SiloCustodyLockTest is FullStackHarness {
    SiloFactory internal factory;
    address internal hidden = address(0xB0B0);
    address internal borrower = address(0xC0FFEE);
    address internal newAdmin = address(0x7100);

    bytes32 internal vaultRole;
    bytes32 internal lockedRole;
    bytes32 internal adminRole;

    function setUp() public override {
        super.setUp();
        factory = new SiloFactory(100e18);
        factory.grantRole(factory.VAULT_ROLE(), address(vault));
        vault.setSiloFactory(address(factory));
        vaultRole = factory.VAULT_ROLE();
        lockedRole = factory.LOCKED_ROLE();
        adminRole = factory.DEFAULT_ADMIN_ROLE();
    }

    function _expectUnauthorised(address account, bytes32 neededRole) internal {
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, account, neededRole)
        );
    }

    function test_lockedRoleAdministersItselfFromDeployment() public view {
        assertEq(factory.getRoleAdmin(lockedRole), lockedRole, "LOCKED_ROLE is its own admin before any lock");
        assertEq(factory.getRoleMemberCount(lockedRole), 0, "and has no member");
    }

    function test_preLockGrantOfLockedRoleReverts() public {
        // The admin key, during the deployment window, tries to plant a LOCKED_ROLE member.
        _expectUnauthorised(address(this), lockedRole);
        factory.grantRole(lockedRole, hidden);
        assertEq(factory.getRoleMemberCount(lockedRole), 0);
    }

    function test_normalLockAndHandoverLeaveNoKeyOverCustody() public {
        factory.lockVaultRole(address(vault));
        assertTrue(factory.vaultRoleLocked());
        assertEq(factory.getRoleAdmin(vaultRole), lockedRole);
        assertEq(factory.getRoleAdmin(lockedRole), lockedRole);
        assertEq(factory.getRoleMemberCount(vaultRole), 1);
        assertEq(factory.getRoleMember(vaultRole, 0), address(vault));
        assertEq(factory.getRoleMemberCount(lockedRole), 0);

        // The handover, as transfer-governance.ts performs it.
        factory.grantRole(adminRole, newAdmin);
        factory.renounceRole(adminRole, address(this));

        // Neither the old key nor the new admin can grant LOCKED_ROLE or VAULT_ROLE.
        _expectUnauthorised(address(this), lockedRole);
        factory.grantRole(lockedRole, hidden);
        vm.startPrank(newAdmin);
        _expectUnauthorised(newAdmin, lockedRole);
        factory.grantRole(lockedRole, hidden);
        _expectUnauthorised(newAdmin, lockedRole);
        factory.grantRole(vaultRole, hidden);
        vm.stopPrank();

        // Collateral still leaves the silos only through the vault, for its owner.
        _open(borrower, paxg, 250e18, 0);
        assertEq(factory.getSiloCount(address(paxg)), 3);
        vm.prank(hidden);
        _expectUnauthorised(hidden, vaultRole);
        factory.withdraw(address(paxg), hidden, 250e18);
        vm.prank(borrower);
        vault.withdraw(250e18);
        assertEq(paxg.balanceOf(borrower), 250e18, "the borrower exits in full");
        assertEq(paxg.balanceOf(hidden), 0);
    }

    function test_lockRefusesWhileLockedRoleHasAMember() public {
        SiloFactoryForcedGrant forced = new SiloFactoryForcedGrant();
        forced.grantRole(vaultRole, address(vault));
        forced.forceGrant(lockedRole, hidden);
        vm.expectRevert(bytes("LOCKED_ROLE must be empty"));
        forced.lockVaultRole(address(vault));
        assertFalse(forced.vaultRoleLocked());
    }
}
