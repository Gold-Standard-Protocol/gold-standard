// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {FullStackHarness} from "./harness/FullStackHarness.sol";

/// @notice getValidatedPrice is documented as never reverting; a round stamped ahead of the
///         block must read as invalid rather than underflow.
contract OracleFutureStampTest is FullStackHarness {
    function test_futureUpdatedAtIsInvalidNotARevert() public {
        paxgFeed.setLatestRoundData(2, PRICE, block.timestamp + 100, block.timestamp + 100, 2);
        (uint256 price, bool ok) = oracle.getValidatedPrice(address(paxg));
        assertFalse(ok);
        assertEq(price, 0);
    }
}
