// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "../../interfaces/IGoldStablecoin.sol";

/// @title MockBadDebtBuffer
/// @notice A misbehaving surplus buffer, to prove GoldVault books bad debt absorption from the
///         fall in GSUSD supply alone and that no buffer can revert a liquidation or underflow
///         totalBadDebt. Revert fails every absorption; BurnNothing returns without burning;
///         BurnEverything burns its whole GSUSD balance, whatever it was asked for.
contract MockBadDebtBuffer {
    enum Mode {
        Revert,
        BurnNothing,
        BurnEverything
    }

    IGoldStablecoin public immutable gsusd;
    Mode public mode;

    constructor(address gsusd_, Mode mode_) {
        gsusd = IGoldStablecoin(gsusd_);
        mode = mode_;
    }

    function setMode(Mode mode_) external {
        mode = mode_;
    }

    /// @notice Claims every role, so GoldVault.setSurplusBuffer accepts it.
    function hasRole(bytes32, address) external pure returns (bool) {
        return true;
    }

    /// @notice Declares burning, as SurplusBuffer does; the modes then misbehave.
    function absorptionBurns() external pure returns (bool) {
        return true;
    }

    function depositFee(uint256 amount) external {
        require(gsusd.transferFrom(msg.sender, address(this), amount), "Fee transfer failed");
    }

    function depositCollateral(address token, uint256 amount) external {
        require(IERC20(token).transferFrom(msg.sender, address(this), amount), "Collateral transfer failed");
    }

    function absorbBadDebt(uint256) external {
        if (mode == Mode.Revert) revert("Buffer broken");
        if (mode == Mode.BurnEverything) gsusd.burn(gsusd.balanceOf(address(this)));
    }
}
