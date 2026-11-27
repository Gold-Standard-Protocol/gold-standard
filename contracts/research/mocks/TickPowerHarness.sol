// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {TickPower} from "../oracle/TickPower.sol";

/// @title TickPowerHarness
/// @notice Exposes the internal TickPower routines to the test suites.
contract TickPowerHarness {
    function pow(int256 tick) external pure returns (uint256 mantissa, int256 exponent) {
        return TickPower.pow(tick);
    }

    function multiply(uint256 m1, int256 e1, uint256 m2, int256 e2) external pure returns (uint256, int256) {
        return TickPower.multiply(m1, e1, m2, e2);
    }

    function reciprocal(uint256 m, int256 e) external pure returns (uint256, int256) {
        return TickPower.reciprocal(m, e);
    }
}
