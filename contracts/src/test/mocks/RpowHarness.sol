// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {StabilityModule} from "../../core/StabilityModule.sol";

/// @notice Test-only harness that exposes `StabilityModule._rpow` for
///         differential testing against a high-precision reference.
/// @dev Testing the real `_rpow` (not a copy) is important — if we copy-pasted
///      the function the test would only prove that two copies of the same
///      assembly agree with each other. By inheriting, this harness calls into
///      the exact bytecode that ships.
contract RpowHarness is StabilityModule {
    function rpow(uint256 x, uint256 n) external pure returns (uint256) {
        return _rpow(x, n);
    }
}
