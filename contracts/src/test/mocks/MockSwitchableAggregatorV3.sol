// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

/// @title MockSwitchableAggregatorV3
/// @notice Chainlink style aggregator with settable decimals and round data that can also be told to
///         revert on latestRoundData, to prove a caller survives a failing feed.
contract MockSwitchableAggregatorV3 {
    uint8 public decimals;
    bool public reverting;
    uint80 private _roundId;
    int256 private _answer;
    uint256 private _startedAt;
    uint256 private _updatedAt;
    uint80 private _answeredInRound;

    constructor(uint8 decimals_) {
        decimals = decimals_;
    }

    function setRound(uint80 roundId, int256 answer, uint256 updatedAt, uint80 answeredInRound) external {
        _roundId = roundId;
        _answer = answer;
        _startedAt = updatedAt;
        _updatedAt = updatedAt;
        _answeredInRound = answeredInRound;
    }

    function setReverting(bool reverting_) external {
        reverting = reverting_;
    }

    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
    {
        require(!reverting, "feed down");
        return (_roundId, _answer, _startedAt, _updatedAt, _answeredInRound);
    }
}
