// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

/// @title MockERC20NoReturn
/// @notice A token of the older shape whose transfer, transferFrom and approve return no
///         value at all (USDT on mainnet is the best known). A caller that decodes a boolean
///         from them reverts on every call. Addresses can be frozen as an issuer would, and
///         `swallow` makes transferFrom return without moving anything, to model a token that
///         fails without reverting and without a return value.
contract MockERC20NoReturn {
    string public name;
    string public symbol;
    uint8 public immutable decimals;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => bool) public frozen;
    bool public swallow;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(string memory name_, string memory symbol_, uint8 decimals_) {
        name = name_;
        symbol = symbol_;
        decimals = decimals_;
    }

    function mint(address to, uint256 amount) external {
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function setFrozen(address account, bool isFrozen) external {
        frozen[account] = isFrozen;
    }

    function setSwallow(bool on) external {
        swallow = on;
    }

    function approve(address spender, uint256 amount) external {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
    }

    function transfer(address to, uint256 amount) external {
        _move(msg.sender, to, amount);
    }

    function transferFrom(address from, address to, uint256 amount) external {
        if (swallow) return;
        uint256 allowed = allowance[from][msg.sender];
        require(allowed >= amount, "allowance");
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - amount;
        _move(from, to, amount);
    }

    function _move(address from, address to, uint256 amount) internal {
        require(!frozen[from] && !frozen[to] && !frozen[msg.sender], "address frozen");
        require(balanceOf[from] >= amount, "balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}
