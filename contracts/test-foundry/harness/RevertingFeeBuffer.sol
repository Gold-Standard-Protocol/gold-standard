// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

/// @notice A surplus buffer that passes the wiring probes of the vault and the reserve and
///         then refuses every deposit: the shape of a buffer repointed without its role
///         grant. Absorption does nothing.
contract RevertingFeeBuffer {
    function hasRole(bytes32, address) external pure returns (bool) {
        return true;
    }

    function absorptionBurns() external pure returns (bool) {
        return true;
    }

    function gsusdBalance() external pure returns (uint256) {
        return 0;
    }

    function depositFee(uint256) external pure {
        revert("Fee refused");
    }

    function depositCollateral(address, uint256) external pure {
        revert("Collateral refused");
    }

    function absorbBadDebt(uint256) external pure {}
}
