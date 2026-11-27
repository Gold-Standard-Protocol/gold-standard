// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IGoldStablecoin is IERC20 {
    /// @notice Exponential moving average of the supply over one day, see GoldStablecoin.
    function smoothedSupplyNow() external view returns (uint256);

    function mint(address to, uint256 amount) external;
    function burn(uint256 amount) external;
    function burnFrom(address account, uint256 amount) external;
}
