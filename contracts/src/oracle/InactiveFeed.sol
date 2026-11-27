// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.38;

/// @title InactiveFeed
/// @notice A placeholder AggregatorV3 source for a token that is registered but not active. It
///         reports 8 decimals, so the oracle accepts it at registration, and an all-zero round,
///         which every validated read treats as a stopped source. A token on it has no market
///         feed: it prices nothing ("No reliable price") until governance replaces the feed
///         through the timelock. The PAXG-first deployment registers XAUT on one.
contract InactiveFeed {
    /// @notice Matches the oracle's 8 decimal requirement.
    function decimals() external pure returns (uint8) {
        return 8;
    }

    function description() external pure returns (string memory) {
        return "Inactive";
    }

    function version() external pure returns (uint256) {
        return 1;
    }

    /// @notice An empty round: answer 0 and updatedAt 0, invalid on every check.
    function latestRoundData()
        external
        pure
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
    {
        return (0, 0, 0, 0, 0);
    }
}
