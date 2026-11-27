// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title MockERC20Freezable
/// @notice ERC20 that lets an "issuer" freeze specific addresses, after which any transfer TO OR
///         FROM a frozen address reverts. Models PAXG (Paxos) / XAUT (Tether) address-freeze
///         powers, used to test the SiloFactory frozen-silo skips on both the withdraw leg
///         and the deposit leg. balanceOf keeps working when frozen.
/// @dev Real PAXG asset protection is
///      `require(!frozen[_to] && !frozen[_from] && !frozen[msg.sender])`, i.e. it blocks INBOUND
///      transfers too. Modelling only the outbound half hid the deposit-side freeze entirely.
contract MockERC20Freezable is ERC20 {
    mapping(address => bool) public frozen;

    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setFrozen(address account, bool isFrozen) external {
        frozen[account] = isFrozen;
    }

    /// @notice Models PAXG's `wipeFrozenAddress`: the issuer burns a frozen address's whole
    ///         balance. Used to test the stability pool after an issuer wipe.
    function wipeFrozenAddress(address account) external {
        require(frozen[account], "Not frozen");
        // The base _update, past the freeze check above, as the issuer's own burn is.
        ERC20._update(account, address(0), balanceOf(account));
    }

    function _update(address from, address to, uint256 amount) internal override {
        require(!frozen[from], "Account frozen");
        // Minting (from == 0) is exempt so fixtures can still fund a frozen address.
        require(from == address(0) || !frozen[to], "Recipient frozen");
        super._update(from, to, amount);
    }
}
