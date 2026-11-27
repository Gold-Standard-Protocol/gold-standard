// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

/// @title MockPoolWithoutPrefundedAbsorb
/// @notice A stability pool of an older shape: it grants every role and reports its
///         deposits, but has no absorbLiquidationPrefunded and does not declare the
///         prefunded path. Wired into the vault, every pool liquidation would revert.
contract MockPoolWithoutPrefundedAbsorb {
    function hasRole(bytes32, address) external pure returns (bool) {
        return true;
    }

    function getTotalDeposits() external pure returns (uint256) {
        return 1_000_000e18;
    }

    /// @notice The pull-style call an older pool offered; the vault does not use it.
    function absorbLiquidation(address, uint256, uint256) external pure {}
}

/// @title MockPoolDenyingPrefundedAbsorb
/// @notice Answers the declaration, with false.
contract MockPoolDenyingPrefundedAbsorb {
    function hasRole(bytes32, address) external pure returns (bool) {
        return true;
    }

    function getTotalDeposits() external pure returns (uint256) {
        return 1_000_000e18;
    }

    function absorbsPrefunded() external pure returns (bool) {
        return false;
    }
}
