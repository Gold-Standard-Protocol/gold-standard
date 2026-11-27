// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.38;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import "@openzeppelin/contracts/access/extensions/AccessControlEnumerable.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";

/// @title GoldStablecoin (GSUSD)
/// @notice USD-pegged stablecoin backed by gold tokens (PAXG, XAUT)
/// @dev Minting restricted to MINTER_ROLE (the vault contract).
///      Burning uses OZ ERC20Burnable: burn(uint256) burns from msg.sender,
///      burnFrom(address, uint256) burns with allowance check.
///      Role membership is enumerable so lockMinters can prove the minter set it freezes.
contract GoldStablecoin is ERC20, ERC20Permit, ERC20Burnable, AccessControlEnumerable {
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");

    /// @notice Once true, MINTER_ROLE can never be granted again, by anyone, including the timelock.
    bool public mintersLocked;

    /// @notice Time constant of the smoothed supply.
    uint256 public constant SUPPLY_TAU = 1 days;

    /// @notice Exponential moving average of totalSupply, advanced on every mint and burn with
    ///         the supply that held until that moment. GoldStabilityReserve prices its spread
    ///         against it, so a burn is only credited to coverage as it ages: a
    ///         repay-swap-mint in one transaction, or after any quiet spell, sees the supply
    ///         that stood before the burn. Nothing off chain has to keep it warm.
    uint256 public smoothedSupply;

    /// @notice When `smoothedSupply` was last stored; 0 until the first mint.
    uint256 public smoothedSupplyAt;

    /// @notice The live supply before the first mint or burn at `smoothedSupplyAt`: the
    ///         supply that stood when the current block began, as far as this token can see.
    uint256 public supplyAtStampStart;

    event MintersLocked(address indexed by);

    constructor() ERC20("Gold Standard Dollar", "GSUSD") ERC20Permit("Gold Standard Dollar") {
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
    }

    /// @notice Mint stablecoins. Only callable by vault contract.
    function mint(address to, uint256 amount) external onlyRole(MINTER_ROLE) {
        _mint(to, amount);
    }

    /// @notice The smoothed supply as of now: the stored average drifted towards the live
    ///         supply by the share of SUPPLY_TAU that has passed since it was stored.
    function smoothedSupplyNow() public view returns (uint256) {
        uint256 live = totalSupply();
        uint256 storedAt = smoothedSupplyAt;
        // Zero is "never stored", a sentinel no real block timestamp can be.
        if (storedAt == 0) return live;
        uint256 elapsed = block.timestamp - storedAt;
        if (elapsed >= SUPPLY_TAU) return live;
        uint256 avg = smoothedSupply;
        if (live >= avg) return avg + Math.mulDiv(live - avg, elapsed, SUPPLY_TAU);
        return avg - Math.mulDiv(avg - live, elapsed, SUPPLY_TAU);
    }

    /// @dev Every mint and burn first banks the average as it stands, measured with the
    ///      supply BEFORE the change, then applies the change. Transfers leave it alone.
    ///      A burn banks at least the supply that stood when the block began, so it is damped
    ///      from that supply however far the average was lagging. Without the floor, after a
    ///      day of growth the average sat below the live supply and a burn up to the gap was
    ///      credited at once, which reopened repay, swap at the cheaper tier, mint back.
    ///      The floor is the supply at the start of the block, not
    ///      the live supply: a mint and repay of the same amount in one transaction would
    ///      otherwise bank the inflated supply and hold the reserve at its widest spread for a
    ///      day for the cost of gas, which no ceiling or per-block cap now limits.
    function _update(address from, address to, uint256 value) internal virtual override {
        if (from == address(0) || to == address(0)) {
            uint256 live = totalSupply();
            // A timestamp, not a balance: the first supply change of a block records the
            // supply it found.
            if (smoothedSupplyAt != block.timestamp) supplyAtStampStart = live;
            uint256 banked = smoothedSupplyNow();
            if (to == address(0)) {
                uint256 floor = Math.min(live, supplyAtStampStart);
                if (floor > banked) banked = floor;
            }
            smoothedSupply = banked;
            smoothedSupplyAt = block.timestamp;
        }
        super._update(from, to, value);
    }

    /// @notice Freeze the minter set for good, and only when it is exactly `vault`. One-way and
    ///         admin-only (the timelock after handover); it succeeds only while the caller is the
    ///         sole admin.
    /// @dev The single most dangerous governance power is granting MINTER_ROLE to a new address:
    ///      it is an unlimited mint. Locking removes that power from every key that will ever
    ///      exist, at the cost that a replacement vault needs a new GSUSD. Revocation stays
    ///      possible so governance can still retire a compromised minter. Intended for the end of
    ///      the guarded ramp, once the launch vault has proven itself (docs/LAUNCH.md step 5).
    ///      Mirrors SiloFactory.lockVaultRole: the lock freezes every current minter, so a key
    ///      granted MINTER_ROLE before the handover would sit inside it for good, and a second
    ///      admin could revoke the vault or keep the power the handover was meant to remove.
    function lockMinters(address vault) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(!mintersLocked, "Already locked");
        require(hasRole(MINTER_ROLE, vault), "Vault lacks MINTER_ROLE");
        require(getRoleMemberCount(MINTER_ROLE) == 1, "MINTER_ROLE must have a sole holder");
        require(getRoleMemberCount(DEFAULT_ADMIN_ROLE) == 1, "DEFAULT_ADMIN_ROLE must have a sole holder");
        mintersLocked = true;
        emit MintersLocked(msg.sender);
    }

    /// @dev Every grant path in AccessControl funnels through here, so the lock cannot be bypassed.
    function _grantRole(bytes32 role, address account) internal virtual override returns (bool) {
        require(role != MINTER_ROLE || !mintersLocked, "Minters locked");
        return super._grantRole(role, account);
    }

    /// @notice Transfer admin power to the timelock and permanently remove deployer access.
    /// @dev Must be called as part of the post-deployment governance handover. Without it,
    ///      the deployer keeps DEFAULT_ADMIN_ROLE and could grant MINTER_ROLE to any
    ///      address — an unlimited-mint backdoor.
    function transferGovernance(address timelockAddr) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(timelockAddr != address(0), "Zero address");
        require(timelockAddr != msg.sender, "Would self-revoke");
        // A handover is one-shot and irreversible; an EOA typo here is a dead protocol.
        require(timelockAddr.code.length > 0, "Timelock must be a contract");
        _grantRole(DEFAULT_ADMIN_ROLE, timelockAddr);
        _revokeRole(DEFAULT_ADMIN_ROLE, msg.sender);
    }
}
