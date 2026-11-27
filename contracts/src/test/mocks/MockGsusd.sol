// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import "./MockERC20.sol";

/// @title MockGsusd
/// @notice A plain mintable ERC20 standing in for GSUSD in unit tests. SurplusBuffer reads
///         smoothedSupplyNow() for its automatic reserve floor and cannot pay out against a
///         token without it; this mock has no smoothing and reports the live supply. Tests
///         of the smoothing itself use the real GoldStablecoin.
contract MockGsusd is MockERC20 {
    constructor() MockERC20("Gold USD", "GSUSD", 18) {}

    function smoothedSupplyNow() external view returns (uint256) {
        return totalSupply();
    }
}
