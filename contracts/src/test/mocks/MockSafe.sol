// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

/// @title MockSafe
/// @notice The two views the launch preflight reads from a Gnosis Safe: its signing
///         threshold and its owner set. Nothing else of a Safe is modelled.
contract MockSafe {
    uint256 private _threshold;
    address[] private _owners;

    constructor(address[] memory owners_, uint256 threshold_) {
        _owners = owners_;
        _threshold = threshold_;
    }

    function getThreshold() external view returns (uint256) {
        return _threshold;
    }

    function getOwners() external view returns (address[] memory) {
        return _owners;
    }
}
