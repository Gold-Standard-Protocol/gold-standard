// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {PythMarketFeed} from "../oracle/PythMarketFeed.sol";

/// @title MockPythRelayer
/// @notice A contract relayer whose ability to receive ETH can be switched off, to prove that a
///         refund it rejects cannot revert the update and stays claimable.
contract MockPythRelayer {
    bool public acceptEth = true;
    uint256 public received;

    function setAcceptEth(bool value) external {
        acceptEth = value;
    }

    function relay(PythMarketFeed feed, bytes[] calldata updateData) external payable {
        feed.updatePrice{value: msg.value}(updateData);
    }

    function claim(PythMarketFeed feed) external {
        feed.claimRefund();
    }

    receive() external payable {
        require(acceptEth, "no ETH");
        received += msg.value;
    }
}
