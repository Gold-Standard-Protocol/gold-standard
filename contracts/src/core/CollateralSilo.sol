// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.38;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin/contracts/access/extensions/AccessControlEnumerable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/proxy/Clones.sol";

/// @title CollateralSilo
/// @notice Minimal proxy that holds a capped portion of gold collateral
/// @dev Deployed via CREATE2 by SiloFactory. Only the vault contract can
///      deposit/withdraw. This distributes collateral across many addresses,
///      making it impractical for a token issuer (Paxos/Tether) to freeze
///      all holdings with a single address freeze.
///
///      This is NOT a privacy tool — all silo addresses are publicly trackable.
///      It's a defense-in-depth measure that raises the cost of censorship
///      from "freeze 1 address" to "freeze N addresses".
contract CollateralSilo {
    using SafeERC20 for IERC20;

    address public factory;
    address public token;
    bool public initialised;

    /// @notice Initialise the silo (called once after clone deployment)
    function initialise(address _token) external {
        require(!initialised, "Already initialised");
        factory = msg.sender;
        token = _token;
        initialised = true;
    }

    /// @notice Transfer tokens out of the silo. Only callable by factory.
    function withdraw(address to, uint256 amount) external {
        require(msg.sender == factory, "Only factory");
        IERC20(token).safeTransfer(to, amount);
    }

    /// @notice Get current balance held by this silo
    function balance() external view returns (uint256) {
        return IERC20(token).balanceOf(address(this));
    }
}

/// @title SiloFactory
/// @notice Manages creation and routing of collateral across multiple silo proxies
/// @dev Uses EIP-1167 minimal proxies (clones) deployed via CREATE2 for deterministic addresses.
///      The vault contract interacts with this factory instead of holding collateral directly.
contract SiloFactory is AccessControlEnumerable, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using Clones for address;

    bytes32 public constant VAULT_ROLE = keccak256("VAULT_ROLE");

    /// @notice Administers VAULT_ROLE once locked. It is its own admin from deployment, so
    ///         nobody can ever be granted it, and after lockVaultRole() no key, DEFAULT_ADMIN_ROLE
    ///         included, can ever grant or revoke VAULT_ROLE again. Collateral can then only
    ///         leave a silo through the vault. Without this, the admin key could grant itself
    ///         VAULT_ROLE and call withdraw() on every silo while the vault's ledger still
    ///         showed the gold as deposited.
    bytes32 public constant LOCKED_ROLE = keccak256("LOCKED_ROLE");

    /// @notice True once VAULT_ROLE can never change again.
    bool public vaultRoleLocked;

    /// @notice Number of tokens with a non-zero totalCollateral. Exposed through isEmpty(),
    ///         which GoldVault.setSiloFactory requires before it replaces or unwires this
    ///         factory. An issuer-frozen silo never drains, so a factory holding frozen gold
    ///         cannot be rotated away until the issuer releases it; the live levers meanwhile
    ///         are setCurrentSiloIndex and the withdrawal route around frozen silos
    ///         (THREAT_MODEL C2).
    uint256 public tokensHeld;

    /// @notice The CollateralSilo implementation contract to clone
    address public immutable siloImplementation;

    /// @notice Maximum balance per silo in 18-decimal units (100 oz = 100e18), scaled to each
    ///         token's own decimals when it is applied (100e6 for a 6-decimal XAUT). One cap in
    ///         raw units would let a 6-decimal token sit in a single silo forever.
    uint256 public siloCap;

    /// @notice Upper bound for silo cap (~1000 oz of gold)
    uint256 public constant MAX_SILO_CAP = 1000e18;

    /// @notice Lower bound for silo cap (0.01 oz of gold). The cap is scaled down to each
    ///         token's decimals, so a cap below 1e12 floored to zero for a 6-decimal XAUT and
    ///         made every silo look full: deposits then stopped after MAX_SKIPS_PER_DEPOSIT
    ///         fresh clones.
    uint256 public constant MIN_SILO_CAP = 1e16;

    /// @notice Maximum silos a single deposit may skip past (full, frozen or otherwise
    ///         unusable) before giving up. Bounds the gas an attacker can impose on a
    ///         depositor by pre-funding or freezing a run of future silo addresses. A silo
    ///         this deposit filled itself is not a skip, so a large deposit may span as many
    ///         silos as its gas allows. Operators clear a stuck run with `setCurrentSiloIndex`
    ///         followed by `createSilos`.
    uint256 public constant MAX_SKIPS_PER_DEPOSIT = 8;

    /// @notice Most clones one `createSilos` call may create. A clone costs about 110,000
    ///         gas (a CREATE2, the clone's two storage slots, one array slot and an event),
    ///         so a full batch is under 2,000,000 gas. On a network that prices new state
    ///         at several times that, a full batch still fits well inside the 2^24 gas a
    ///         transaction may carry.
    uint256 public constant MAX_CREATE_BATCH = 16;

    /// @notice All silos per token
    // Mappings cannot be initialised in Solidity; populated lazily per token.
    // slither-disable-next-line uninitialized-state
    mapping(address => address[]) public silos;

    /// @notice Index of the current (not-yet-full) silo per token
    mapping(address => uint256) public currentSiloIndex;

    /// @notice Lowest index the deposit cursor may return to per token: the last index
    ///         governance moved it to with `setCurrentSiloIndex`. The cursor rewind after a
    ///         withdrawal stops here, so emptying the silo above a skipped run can no longer
    ///         walk the cursor back over the run governance stepped past.
    mapping(address => uint256) public minSiloIndex;

    /// @notice Total collateral across all silos per token
    mapping(address => uint256) public totalCollateral;

    event SiloCreated(address indexed token, address silo, uint256 index);
    event SiloSkipped(address indexed token, address silo);
    event CurrentSiloIndexSet(address indexed token, uint256 index);
    event Deposited(address indexed token, address indexed silo, uint256 amount);
    event Withdrawn(address indexed token, uint256 amount);
    event SiloCapUpdated(uint256 newCap);
    event VaultRoleLocked(address indexed vault);

    constructor(uint256 _siloCap) {
        require(_siloCap >= MIN_SILO_CAP && _siloCap <= MAX_SILO_CAP, "Invalid cap");
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        // LOCKED_ROLE administers itself from birth and is never granted. Left under
        // DEFAULT_ADMIN_ROLE until the lock, the pre-lock admin could grant it to a key it kept,
        // and the lock then made that key the permanent admin of VAULT_ROLE, a drain key the
        // timelock could not revoke.
        _setRoleAdmin(LOCKED_ROLE, LOCKED_ROLE);

        siloCap = _siloCap;

        // Deploy the implementation contract and lock it
        siloImplementation = address(new CollateralSilo());
        CollateralSilo(siloImplementation).initialise(address(1));
    }

    /// @notice Deposit collateral — pulls from caller and routes to current silo,
    ///         creating new silos as needed.
    /// @dev Pull pattern (safeTransferFrom from caller directly to each silo) eliminates
    ///      the intermediate vault→factory→silo hop that caused fee-on-transfer drift.
    ///      Each silo's actual balance delta is credited (post-fee), so the returned
    ///      `credited` value reflects what is actually backed in silos.
    /// @return credited Total amount actually deposited into silos (may be less than
    ///                  `amount` for fee-on-transfer tokens).
    function deposit(address token, uint256 amount) external onlyRole(VAULT_ROLE) nonReentrant returns (uint256 credited) {
        uint256 remaining = amount;
        uint256 skips = 0;

        uint256 cap = _capFor(token);
        // A cap that rounds to zero native units (a token with fewer than two decimals at the
        // smallest cap) would make every silo look full; say so instead of walking the skip
        // loop to the same revert. The vault refuses to list such a token.
        require(cap > 0, "Silo cap rounds to zero");
        while (remaining > 0) {
            // The cursor moves after this call and after the transfer below. This call only
            // creates and initialises the factory's own clones. The transfer (made through
            // SafeERC20 further down) runs the collateral token's transferFrom, which is not
            // a protocol contract: PAXG and XAUT have no transfer callbacks (an issuer
            // property that must be checked before a token is listed), and this entry point
            // is VAULT_ROLE only and nonReentrant, as is the vault that holds the role.
            // slither-disable-next-line reentrancy-no-eth
            address silo = _getCurrentSilo(token);
            uint256 siloBalanceBefore = CollateralSilo(silo).balance();
            uint256 capacity = cap > siloBalanceBefore ? cap - siloBalanceBefore : 0;

            if (capacity == 0) {
                // Current silo is full: advance and re-derive the next silo's REAL balance
                // on the next iteration. Hard-coding siloBalanceBefore = 0 here (the earlier
                // shape) let a donation parked at the predictable next-silo address inflate
                // `credited` above the amount actually transferred and breach siloCap.
                //
                // This branch consumes none of `remaining`, so it MUST be bounded: silo
                // addresses are publicly derivable via predictSiloAddress for any index, so
                // a donor can pre-fund a long run of future silos and every skip costs the
                // DEPOSITOR ~114k gas (clone deploy + initialise + SSTORE + balance call).
                // Unbounded, that prices ordinary deposits out of the gas limit permanently.
                skips++;
                require(skips <= MAX_SKIPS_PER_DEPOSIT, "Too many unusable silos");
                currentSiloIndex[token]++;
                continue;
            }

            uint256 toDeposit = remaining > capacity ? capacity : remaining;
            // Pull directly from caller to silo, eliminating an intermediate hop.
            // A failed transfer skips the silo, as the withdraw side skips a frozen one: real
            // PAXG asset protection blocks transfers TO a frozen address, so without this a
            // single frozen silo reverts EVERY deposit for that token. The skip is persisted
            // by advancing currentSiloIndex before continuing.
            // A leg counts only if the call did not fail AND the silo's balance rose. The
            // call is OpenZeppelin's trySafeTransferFrom: false when the token reverts
            // (a frozen silo, a missing allowance) or returns false, true when it returns
            // true or, as some older tokens do, returns nothing at all. Decoding a boolean
            // from the call directly made every deposit of such a token revert. The
            // answer alone is still not trusted: a token that reports success, or says
            // nothing, while moving nothing would otherwise consume `remaining` and credit
            // nothing, and because GoldVault.deposit has ALREADY pulled the user's tokens
            // into itself before calling here, a zero credit would strand those tokens in
            // the vault. A zero balance change is therefore a failed leg like any other, and
            // a deposit whose every leg fails reverts, so the user keeps their collateral.
            // PAXG and XAUT both return a conforming bool (verified against mainnet); this
            // guards the tokens governance may add later.
            bool ok = IERC20(token).trySafeTransferFrom(msg.sender, silo, toDeposit);
            uint256 received = ok ? CollateralSilo(silo).balance() - siloBalanceBefore : 0;
            if (received == 0) {
                skips++;
                require(skips <= MAX_SKIPS_PER_DEPOSIT, "Too many unusable silos");
                currentSiloIndex[token]++;
                emit SiloSkipped(token, silo);
                continue;
            }
            credited += received;
            remaining -= toDeposit;
            emit Deposited(token, silo, received);
            // This silo is now full. Move on without counting a skip: the skip budget is
            // for silos that refuse funds, and counting a silo this deposit filled made a
            // single deposit above about nine silos revert.
            if (remaining > 0) currentSiloIndex[token]++;
        }

        if (credited > 0 && totalCollateral[token] == 0) tokensHeld++;
        totalCollateral[token] += credited;
    }

    /// @notice Withdraw collateral from silos (pulls from latest first)
    /// @dev CEI pattern: totalCollateral updated BEFORE external calls. The cursor rewind
    ///      after the walk is the one write that follows them: it needs what the walk learnt,
    ///      the silos are this factory's own clones, the entry point is VAULT_ROLE only and
    ///      nonReentrant, and the vault that holds the role is nonReentrant too. The walk
    ///      also runs the collateral token's transfer to the recipient; PAXG and XAUT have
    ///      no transfer callbacks, an issuer property checked before a token is listed.
    function withdraw(address token, address to, uint256 amount) external onlyRole(VAULT_ROLE) nonReentrant {
        require(totalCollateral[token] >= amount, "Insufficient collateral");

        // Effects first (CEI)
        totalCollateral[token] -= amount;
        if (amount > 0 && totalCollateral[token] == 0) tokensHeld--;

        address[] storage tokenSilos = silos[token];
        uint256 n = tokenSilos.length;

        // Every silo above the deposit cursor is empty: deposits write at the cursor and
        // move it up, and the rewind below parks it on the highest funded silo. The LIFO
        // walk therefore starts at the cursor, not the array end. Starting at the end made
        // every silo left empty after a peak in total collateral cost about 10k gas on every
        // later withdrawal and liquidation of the token, for ever.
        uint256 top = currentSiloIndex[token] + 1;
        if (top > n) top = n;
        // The cursor rewind is written after this walk; see the note above.
        // slither-disable-next-line reentrancy-no-eth
        Walk memory walk = _drain(tokenSilos, top, 0, to, amount);
        if (walk.remaining > 0 && top < n) {
            // Belt and braces: a withdrawal never depends on the cursor invariant above.
            Walk memory sweep = _drain(tokenSilos, n, top, to, walk.remaining);
            walk.remaining = sweep.remaining;
            if (sweep.found) {
                walk.found = true;
                walk.holder = sweep.holder;
            }
        }

        require(walk.remaining == 0, "Withdrawal failed: insufficient unfrozen silo balance");
        _rewindCursor(token, tokenSilos, top, walk);

        emit Withdrawn(token, amount);
    }

    /// @dev What one LIFO walk learnt, so the cursor rewind need not read balances again.
    struct Walk {
        uint256 remaining; // still owed after the walk
        uint256 lowest;    // lowest index visited; `from` when nothing was visited
        uint256 holder;    // highest visited silo that still holds a balance
        bool found;        // whether such a silo was seen
    }

    /// @dev Walk silos `from - 1` down to `downTo`, most recent first, paying `to` until the
    ///      amount is met. Silos whose transfer reverts (an issuer-frozen address, say) are
    ///      skipped: one frozen silo must not brick every withdrawal and liquidation for the
    ///      token. A frozen silo's balance stays counted in totalCollateral and becomes
    ///      withdrawable again once unfrozen; if the amount cannot be sourced from the
    ///      unfrozen silos the caller's final require rolls the whole call back.
    function _drain(address[] storage tokenSilos, uint256 from, uint256 downTo, address to, uint256 amount)
        internal
        returns (Walk memory walk)
    {
        walk.remaining = amount;
        walk.lowest = from;
        for (uint256 i = from; i > downTo && walk.remaining > 0; i--) {
            walk.lowest = i - 1;
            address silo = tokenSilos[i - 1];
            uint256 siloBalance = CollateralSilo(silo).balance();
            if (siloBalance == 0) continue;

            uint256 toWithdraw = walk.remaining > siloBalance ? siloBalance : walk.remaining;
            // A silo that refuses the transfer (frozen) counts as not drained.
            bool drained = false;
            try CollateralSilo(silo).withdraw(to, toWithdraw) {
                walk.remaining -= toWithdraw;
                drained = toWithdraw == siloBalance;
            } catch {}
            if (!drained && !walk.found) {
                walk.found = true;
                walk.holder = i - 1;
            }
        }
    }

    /// @dev Move the deposit cursor back over silos this withdrawal emptied, so the next
    ///      deposit refills an existing clone instead of creating a new one. Without it a
    ///      deposit-and-withdraw loop on a debt-free vault left one empty silo per cycle,
    ///      and the LIFO walk above had to visit every one of them, a gas-griefing lever
    ///      against every later withdrawal and liquidation of the token. A frozen silo keeps
    ///      its balance, so the cursor stops on it as before. The walk already knows the
    ///      highest silo still holding a balance, or that everything down to `walk.lowest`
    ///      is empty, so only silos below that are read here.
    ///      The rewind never goes below `minSiloIndex`. An empty silo is not necessarily a
    ///      usable one: an issuer can freeze silo addresses before they are funded (they are
    ///      derivable through predictSiloAddress), and walking back over such a run undid
    ///      governance's `setCurrentSiloIndex` the moment one withdrawal emptied the silo
    ///      above it, stopping deposits for another timelock cycle.
    function _rewindCursor(address token, address[] storage tokenSilos, uint256 top, Walk memory walk) internal {
        uint256 n = tokenSilos.length;
        if (n == 0) return;
        uint256 floor = minSiloIndex[token];
        uint256 idx;
        if (walk.found) {
            idx = walk.holder;
        } else {
            // Nothing visited: start at the cursor itself. Otherwise continue below the
            // lowest silo visited, which is known to be empty.
            uint256 below = walk.lowest == top ? top : walk.lowest;
            idx = below == 0 ? 0 : below - 1;
            while (idx > floor && CollateralSilo(tokenSilos[idx]).balance() == 0) {
                idx--;
            }
        }
        // A holder below the floor still drains through the LIFO walk, which starts above
        // the cursor and reaches every silo beneath it.
        if (idx < floor) idx = floor;
        currentSiloIndex[token] = idx;
    }

    /// @notice The per-silo cap for `token`: `siloCap` is denominated in 18 decimals and
    ///         scaled down to the token's decimals, so every token sees the same cap in ounces.
    function _capFor(address token) internal view returns (uint256) {
        uint8 dec = IERC20Metadata(token).decimals();
        require(dec <= 18, "Decimals must be <= 18");
        return siloCap / (10 ** (18 - dec));
    }

    /// @notice Get or create the current silo for a token
    /// @dev Creates every clone missing up to the cursor. After `setCurrentSiloIndex` that
    ///      can be many; `createSilos` creates them ahead of the deposit, in batches.
    function _getCurrentSilo(address token) internal returns (address) {
        address[] storage tokenSilos = silos[token];
        uint256 idx = currentSiloIndex[token];

        // Create new silos as needed
        while (tokenSilos.length <= idx) {
            _createSilo(token, tokenSilos);
        }

        return tokenSilos[idx];
    }

    /// @dev Create the next clone for `token`, at index `tokenSilos.length`.
    function _createSilo(address token, address[] storage tokenSilos) internal {
        uint256 index = tokenSilos.length;
        address silo = siloImplementation.cloneDeterministic(keccak256(abi.encodePacked(token, index)));
        CollateralSilo(silo).initialise(token);
        tokenSilos.push(silo);
        emit SiloCreated(token, silo, index);
    }

    /// @notice Create up to `count` of the clones still missing below and at the deposit
    ///         cursor of `token`, lowest index first.
    /// @dev A deposit creates every clone up to the cursor itself. After governance has
    ///      moved the cursor past a long run (`setCurrentSiloIndex`, up to 64 a call and
    ///      forward only) that is one clone per skipped index, and a few such moves put
    ///      more creations in the next deposit than a transaction's gas can carry, with no
    ///      way to move the cursor back. This call spreads the same creations over as many
    ///      transactions as it takes; the deposit then finds the clones in place.
    ///
    ///      Anyone may call it. It creates exactly the clones the next deposit would
    ///      create, at the same deterministic addresses and in the same order, and never
    ///      one past the cursor, so it cannot grow the list a withdrawal walks beyond what
    ///      governance already chose. It moves no funds and changes no cursor.
    ///
    ///      Only for a token this factory already knows: one that has a silo, or whose
    ///      cursor governance has moved. For any other address it reverts, so nobody can
    ///      create a clone or emit SiloCreated for an address that is not a collateral
    ///      token, and a token's first silo is always created by its first deposit.
    ///      It reverts "Nothing to create" when a deposit or another caller filled the gap
    ///      first, so read missingSilos just before each call and never place the call in
    ///      a batch that must not revert.
    /// @param count How many to create at most, between 1 and MAX_CREATE_BATCH.
    /// @return created Clones created by this call; `missingSilos(token)` reports what is left.
    function createSilos(address token, uint256 count) external nonReentrant returns (uint256 created) {
        require(count > 0 && count <= MAX_CREATE_BATCH, "Invalid count");
        address[] storage tokenSilos = silos[token];
        require(tokenSilos.length > 0 || minSiloIndex[token] > 0, "Unknown token");
        uint256 missing = _missingSilos(token, tokenSilos.length);
        require(missing > 0, "Nothing to create");
        created = count < missing ? count : missing;
        for (uint256 i = 0; i < created; i++) {
            _createSilo(token, tokenSilos);
        }
    }

    /// @notice Clones `createSilos` can still create for `token`: those missing below and
    ///         at the deposit cursor. Zero in ordinary running, where a deposit creates the
    ///         one clone it needs as it goes; above zero only after `setCurrentSiloIndex`,
    ///         until `createSilos` or a deposit has filled the gap. Zero for an address the
    ///         factory does not know, a token before its first deposit included.
    function missingSilos(address token) external view returns (uint256) {
        return _missingSilos(token, silos[token].length);
    }

    function _missingSilos(address token, uint256 existing) internal view returns (uint256) {
        // Zero sentinels on counters, not balances: no silo and no governed cursor means the
        // factory has never dealt with this address.
        if (existing == 0 && minSiloIndex[token] == 0) return 0;
        uint256 needed = currentSiloIndex[token] + 1;
        return needed > existing ? needed - existing : 0;
    }

    /// @notice Get the number of silos for a token
    function getSiloCount(address token) external view returns (uint256) {
        return silos[token].length;
    }

    /// @notice Get a specific silo address
    function getSilo(address token, uint256 index) external view returns (address) {
        return silos[token][index];
    }

    /// @notice Predict the address of a silo before deployment
    function predictSiloAddress(address token, uint256 index) external view returns (address) {
        bytes32 salt = keccak256(abi.encodePacked(token, index));
        return siloImplementation.predictDeterministicAddress(salt);
    }

    /// @notice Make VAULT_ROLE permanent. One way, admin only, and it requires the vault to
    ///         already hold the role so a lock can never leave the silos unreachable.
    function lockVaultRole(address vault) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(!vaultRoleLocked, "Already locked");
        require(hasRole(VAULT_ROLE, vault), "Vault lacks VAULT_ROLE");
        // Enumerable so this is PROVABLE: locking freezes every current holder forever,
        // and a stray pre-lock grant would have been a permanent, unrevocable drain key.
        require(getRoleMemberCount(VAULT_ROLE) == 1, "VAULT_ROLE must have a sole holder");
        // The constructor already makes LOCKED_ROLE ungrantable; proving it empty here keeps
        // the lock sound whatever route a member might have arrived by.
        require(getRoleMemberCount(LOCKED_ROLE) == 0, "LOCKED_ROLE must be empty");
        _setRoleAdmin(VAULT_ROLE, LOCKED_ROLE);
        vaultRoleLocked = true;
        emit VaultRoleLocked(vault);
    }

    /// @notice True when no token has collateral in any silo.
    function isEmpty() external view returns (bool) {
        return tokensHeld == 0;
    }

    /// @notice Move the deposit cursor past a run of unusable silos (governance only).
    /// @dev The explicit operator lever for the MAX_SKIPS_PER_DEPOSIT bound: if a donor
    ///      stuffs, or an issuer freezes, a long run of consecutive silos, deposits stop
    ///      with "Too many unusable silos" until the cursor is moved beyond them. Only
    ///      moves forward, and records the new index as `minSiloIndex` so the cursor rewind
    ///      after a withdrawal cannot take it back either: rewinding would re-route deposits
    ///      into silos already skipped. Balances in skipped silos
    ///      stay counted in totalCollateral and remain withdrawable (withdraw scans every
    ///      silo LIFO and routes around frozen ones).
    function setCurrentSiloIndex(address token, uint256 index) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(index > currentSiloIndex[token], "Index must advance");
        // Bounded per call so a fat-fingered jump cannot park the cursor astronomically
        // far ahead (the cursor only moves forward, so an overshoot is not undone, and
        // every skipped index is a clone to create and a silo for withdrawals to walk).
        // Call repeatedly for genuinely long frozen runs; each step stays reviewable.
        // The clones the move leaves missing are created with createSilos, in batches,
        // before the next deposit: a deposit that had to create them all itself could
        // need more gas than one transaction may carry.
        require(index - currentSiloIndex[token] <= 64, "Advance exceeds bound");
        currentSiloIndex[token] = index;
        minSiloIndex[token] = index;
        emit CurrentSiloIndexSet(token, index);
    }

    /// @notice Update the silo cap (governance only)
    function setSiloCap(uint256 _cap) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(_cap >= MIN_SILO_CAP && _cap <= MAX_SILO_CAP, "Invalid cap");
        siloCap = _cap;
        emit SiloCapUpdated(_cap);
    }
}
