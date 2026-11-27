// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.38;

import {GoldStablecoin} from "../core/GoldStablecoin.sol";

/// @title GoldStablecoinDeployer
/// @notice Creates the one GoldStablecoin of a deployment at an address fixed in advance.
/// @dev GoldStablecoin gives DEFAULT_ADMIN_ROLE to whoever creates it. CREATE2 makes the
///      address a function of this contract, a salt and the token's creation code, so this
///      contract creates the token, passes the admin role to its own owner and gives up its
///      own in the same transaction. It holds no role afterwards and can create nothing more.
///      Only the owner, the account that created this contract, can call `deploy`: nobody else
///      can take the address first.
contract GoldStablecoinDeployer {
    /// @notice The account that created this contract and receives the token's admin role.
    address public immutable owner;

    /// @notice The token this contract created; the zero address until `deploy` has run.
    address public token;

    /// @notice The block `deploy` ran in; 0 until then.
    uint256 public tokenBlock;

    event TokenDeployed(address indexed token, bytes32 indexed salt, address indexed admin);

    constructor() {
        owner = msg.sender;
    }

    /// @notice keccak256 of the token's creation code: the third input of the address.
    function initCodeHash() public pure returns (bytes32) {
        // The creation code is a bytes constant, not a number someone could misread.
        // slither-disable-next-line too-many-digits
        return keccak256(type(GoldStablecoin).creationCode);
    }

    /// @notice The address `deploy(salt)` creates the token at.
    function predict(bytes32 salt) public view returns (address) {
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, initCodeHash())))));
    }

    /// @notice Creates the token at `predict(salt)` with `owner` as its only admin. Once.
    function deploy(bytes32 salt) external returns (address) {
        require(msg.sender == owner, "Not owner");
        require(token == address(0), "Already deployed");
        GoldStablecoin created = new GoldStablecoin{salt: salt}();
        token = address(created);
        tokenBlock = block.number;
        emit TokenDeployed(address(created), salt, owner);
        // The two calls go to the token this contract created a moment ago, and nowhere else.
        bytes32 adminRole = created.DEFAULT_ADMIN_ROLE();
        created.grantRole(adminRole, owner);
        created.renounceRole(adminRole, address(this));
        return address(created);
    }
}
