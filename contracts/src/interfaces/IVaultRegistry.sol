// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.38;

/// @notice The hook GoldVault calls after any change to a vault's collateral or debt.
interface IVaultRegistry {
    /// @param owner The vault owner whose position changed
    /// @param empty True when the vault now holds neither collateral nor debt
    function onVaultChanged(address owner, bool empty) external;
}
