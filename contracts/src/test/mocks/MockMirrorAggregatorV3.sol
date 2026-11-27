// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

interface IMirrorSource {
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80);
}

/// @notice Test-only confirmation feed that reports exactly what another feed reports. Tests
///         that move one mock feed and are not about source agreement use it so the two-source
///         rule is always satisfied without mirroring every price push by hand.
contract MockMirrorAggregatorV3 {
    IMirrorSource public immutable source;

    constructor(address _source) {
        source = IMirrorSource(_source);
    }

    function decimals() external pure returns (uint8) {
        return 8;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return source.latestRoundData();
    }
}
