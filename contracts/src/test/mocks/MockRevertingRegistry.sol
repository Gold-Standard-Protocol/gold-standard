// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import "../../interfaces/IVaultRegistry.sol";

/// @title MockRevertingRegistry
/// @notice A registry whose hook always reverts, to prove the vault treats the registry as
///         best effort and never lets it block a deposit, a repayment or a liquidation.
contract MockRevertingRegistry is IVaultRegistry {
    /// @notice The vault this mock claims to serve, so GoldVault.setVaultRegistry accepts it.
    address public immutable vault;

    constructor(address vault_) {
        vault = vault_;
    }

    function onVaultChanged(address, bool) external pure {
        revert("registry down");
    }
}
