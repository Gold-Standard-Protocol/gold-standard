// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {MockAggregatorV3} from "./MockAggregatorV3.sol";

/// @title MockChainlinkFeed
/// @notice MockAggregatorV3 plus the `description()` a real Chainlink aggregator exposes
///         ("PAXG / USD", "XAU / USD"), which the launch preflight compares against the
///         feed each address is expected to be.
contract MockChainlinkFeed is MockAggregatorV3 {
    string private _description;

    constructor(uint8 decimals_, string memory description_) MockAggregatorV3(decimals_) {
        _description = description_;
    }

    function description() external view returns (string memory) {
        return _description;
    }
}
