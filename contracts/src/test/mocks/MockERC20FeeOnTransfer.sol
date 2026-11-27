// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title MockERC20FeeOnTransfer
/// @notice ERC20 that charges a fee on every transfer (simulates fee-on-transfer tokens)
contract MockERC20FeeOnTransfer is ERC20 {
    uint256 public feeBps; // e.g. 100 = 1%

    constructor(string memory name_, string memory symbol_, uint256 _feeBps) ERC20(name_, symbol_) {
        feeBps = _feeBps;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 amount) internal override {
        if (from != address(0) && to != address(0)) {
            // Charge fee by burning a portion
            uint256 fee = (amount * feeBps) / 10000;
            super._update(from, address(0), fee); // burn fee
            super._update(from, to, amount - fee); // transfer remainder
        } else {
            super._update(from, to, amount);
        }
    }
}
