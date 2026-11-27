// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.38;

import "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import "../interfaces/IVaultRegistry.sol";

/// @dev The slice of GoldVault this registry reads. Declared here rather than importing the
///      vault so the registry stays small and independent of the vault's bytecode.
interface IGoldVaultView {
    function vaults(address owner)
        external
        view
        returns (address collateralToken, uint256 collateralAmount, uint256 debtAmount);
    function collateralTypes(bytes32 id)
        external
        view
        returns (address token, uint256 minRatio, uint256 liquidationRatio, uint256 liquidationPenalty, uint256 debtCeiling, uint256 totalDebt, bool active);
    function getCollateralisationRatio(address owner) external view returns (uint256);
    function getVaultCurrentDebt(address owner) external view returns (uint256);
    function getLiquidationPrice(address owner) external view returns (uint256);
}

/**
 * @title VaultRegistry
 * @notice The on-chain list of open vaults and the views an agent needs to find, judge and
 *         act on them with nothing but the verified contracts: no indexer, no API, no dapp.
 * @dev Membership rule: an owner is listed exactly while its vault holds collateral or debt.
 *      GoldVault reports every change through `onVaultChanged`; `sync` lets anyone backfill a
 *      vault opened before the registry was wired, or repair drift, from the vault's own
 *      state, so the registry is never wrong for longer than one permissionless call. It
 *      holds no funds and no roles. The views price at the oracle's last known price, the
 *      same hint the dapp and the keeper use; `GoldVault.liquidate` prices off the live
 *      validated feed and remains the judge.
 */
contract VaultRegistry is IVaultRegistry {
    using EnumerableSet for EnumerableSet.AddressSet;

    /// @notice One collateral type as GoldVault stores it, looked up here by token address.
    struct CollateralType {
        address token;
        uint256 minRatio;            // parts per million: 1_300_000 is 130%
        uint256 liquidationRatio;    // parts per million
        uint256 liquidationPenalty;  // parts per million of the debt repaid
        uint256 debtCeiling;         // GSUSD, 18 decimals
        uint256 totalDebt;           // GSUSD principal outstanding against this collateral
        bool active;
    }

    /// @notice Everything an agent needs to know about one vault, in one call.
    struct VaultSummary {
        address token;             // collateral token; zero for a vault that is not open
        uint256 collateral;        // in the token's own decimals (PAXG 18, XAUT 6)
        uint256 debt;              // GSUSD owed including accrued fees, 18 decimals
        uint256 ratio;             // parts per million at the last known price; max uint when debt-free
        uint256 liquidationPrice;  // token price, 8 decimals, rounded down: liquidatable below it, and at it unless exact; 0 if debt-free
        bool liquidatable;         // ratio below the collateral's liquidation ratio
    }

    /// @notice The vault this registry mirrors
    IGoldVaultView public immutable vault;

    EnumerableSet.AddressSet private _owners;

    event VaultListed(address indexed owner);
    event VaultDelisted(address indexed owner);

    constructor(address vault_) {
        require(vault_.code.length > 0, "Vault must be a contract");
        vault = IGoldVaultView(vault_);
    }

    // ========== Written by the vault ==========

    /// @inheritdoc IVaultRegistry
    function onVaultChanged(address owner, bool empty) external {
        require(msg.sender == address(vault), "Only vault");
        _set(owner, !empty);
    }

    // ========== Permissionless repair ==========

    /// @notice Re-read one vault from GoldVault and list or delist its owner accordingly.
    /// @dev Backfills vaults opened before the registry was wired and repairs any drift.
    ///      Anyone may call it; it can only make the registry agree with the vault.
    function sync(address owner) public {
        (, uint256 collateral, uint256 debt) = _position(owner);
        _set(owner, collateral > 0 || debt > 0);
    }

    /// @notice `sync` for a batch of owners, for a backfill from the vault's deposit events.
    function syncMany(address[] calldata owners) external {
        for (uint256 i = 0; i < owners.length; i++) {
            sync(owners[i]);
        }
    }

    /// @dev The vault's position tuple passed through whole, so callers may take the fields
    ///      they need without an external call whose return is partly dropped.
    function _position(address owner) internal view returns (address token, uint256 collateral, uint256 debt) {
        (token, collateral, debt) = vault.vaults(owner);
    }

    /// @dev The vault's collateral type for a token, rebuilt as a struct.
    function _collateralType(address token) internal view returns (CollateralType memory colType) {
        (
            colType.token,
            colType.minRatio,
            colType.liquidationRatio,
            colType.liquidationPenalty,
            colType.debtCeiling,
            colType.totalDebt,
            colType.active
        ) = vault.collateralTypes(collateralIdOf(token));
    }

    /// @dev Lists or delists `owner`, emitting only on an actual change.
    function _set(address owner, bool listed) internal {
        if (listed) {
            if (_owners.add(owner)) emit VaultListed(owner);
        } else if (_owners.remove(owner)) {
            emit VaultDelisted(owner);
        }
    }

    // ========== Views for liquidators and agents ==========

    /// @notice Number of open vaults
    function vaultOwnerCount() external view returns (uint256) {
        return _owners.length();
    }

    /// @notice Owner of the open vault at `index`, in listing order (reverts past the end)
    function vaultOwnerAt(uint256 index) external view returns (address) {
        return _owners.at(index);
    }

    /// @notice Whether `owner` currently has an open vault
    function isVaultOwner(address owner) external view returns (bool) {
        return _owners.contains(owner);
    }

    /// @notice One page of open-vault owners, so a caller can walk a large set in bounded calls.
    /// @param offset Position to start from; an offset past the end returns an empty page
    /// @param limit Maximum number of owners to return
    function vaultOwners(uint256 offset, uint256 limit) public view returns (address[] memory page) {
        uint256 total = _owners.length();
        if (offset >= total) return new address[](0);
        // Saturating: offset + limit overflowed for a huge limit and a non-zero offset.
        uint256 room = total - offset;
        uint256 count = limit < room ? limit : room;
        page = new address[](count);
        for (uint256 i = 0; i < page.length; i++) {
            page[i] = _owners.at(offset + i);
        }
    }

    /// @notice The vault's collateral id for a token (keccak256 of the packed address)
    function collateralIdOf(address token) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(token));
    }

    /// @notice The vault's collateral type for a token, without computing the id by hand
    function collateralTypeOf(address token) external view returns (CollateralType memory) {
        return _collateralType(token);
    }

    /// @notice Whether `owner`'s vault is below its liquidation ratio at the last known price.
    /// @dev A hint, not a guarantee: `GoldVault.liquidate` prices off the live validated feed
    ///      and refuses a stale oracle or a paused vault.
    function isLiquidatable(address owner) public view returns (bool) {
        (address token, , uint256 debt) = _position(owner);
        if (debt == 0) return false;
        return vault.getCollateralisationRatio(owner) < _collateralType(token).liquidationRatio;
    }

    /// @notice The owners within one page of the listing whose vaults are liquidatable now.
    /// @dev Walk the listing with the same offset and limit as `vaultOwners`.
    function liquidatableVaults(uint256 offset, uint256 limit) external view returns (address[] memory found) {
        address[] memory page = vaultOwners(offset, limit);
        uint256 count = 0;
        for (uint256 i = 0; i < page.length; i++) {
            if (isLiquidatable(page[i])) {
                page[count++] = page[i];
            }
        }
        found = new address[](count);
        for (uint256 i = 0; i < count; i++) {
            found[i] = page[i];
        }
    }

    /// @notice One vault's position, debt, ratio and liquidation line in a single call
    function vaultSummary(address owner) external view returns (VaultSummary memory s) {
        (s.token, s.collateral, ) = _position(owner);
        s.debt = vault.getVaultCurrentDebt(owner);
        s.ratio = vault.getCollateralisationRatio(owner);
        s.liquidationPrice = vault.getLiquidationPrice(owner);
        s.liquidatable = s.debt > 0 && s.ratio < _collateralType(s.token).liquidationRatio;
    }
}
