// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title MockERC20SilentFail
/// @notice An ERC20 whose transferFrom returns `false` instead of reverting.
/// @dev Permitted by the ERC20 standard and the reason SafeERC20 exists. Models the
///      class of token that would silently strand a depositor's collateral if a
///      transfer's return value and balance delta were both left unchecked.
contract MockERC20SilentFail is ERC20 {
    bool public failSilently;

    constructor() ERC20("Silent Fail", "SILENT") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setFailSilently(bool value) external {
        failSilently = value;
    }

    function transferFrom(address from, address to, uint256 amount)
        public
        override
        returns (bool)
    {
        if (failSilently) {
            return false; // No revert, no transfer, no state change.
        }
        return super.transferFrom(from, to, amount);
    }
}
