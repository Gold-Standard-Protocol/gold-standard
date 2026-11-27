// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IPoolForJit {
    function deposit(uint256 amount) external;
    function withdraw(uint256 amount) external;
}

/// @title MockPoolJit
/// @notice Deposits into the stability pool and withdraws again in the same transaction,
///         the shape of a flash-loan just-in-time capture of a liquidation's gains.
contract MockPoolJit {
    IPoolForJit public immutable pool;
    IERC20 public immutable gsusd;

    constructor(address pool_, address gsusd_) {
        pool = IPoolForJit(pool_);
        gsusd = IERC20(gsusd_);
    }

    function run(uint256 amount) external {
        gsusd.approve(address(pool), amount);
        pool.deposit(amount);
        pool.withdraw(amount);
    }
}
