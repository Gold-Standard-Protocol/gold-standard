// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

interface IStabilityModule {
    function recordDebt(address user, bytes32 collateralId, uint256 debtAmount) external;
    function reduceDebt(address user, bytes32 collateralId, uint256 debtAmount) external;
    function clearDebt(address user, bytes32 collateralId) external;
    function getCurrentDebt(address user, bytes32 collateralId) external view returns (uint256);
    function accrueInterest(bytes32 collateralId) external;
}
