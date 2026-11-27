// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.38;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";
import "./ExpiringPausable.sol";
import "../interfaces/IGoldOracle.sol";

/// @notice Minimal Chainlink aggregator interface
interface AggregatorV3Interface {
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);

    function decimals() external view returns (uint8);
}

/// @title GoldOracle
/// @notice USD prices for gold-backed collateral tokens from two Chainlink sources per token,
///         isolated per token: C, the token's market feed (`feeds[token].feed`, PAXG/USD), and
///         G, the gold reference (`anchorFeed`, XAU/USD). docs/ORACLE_IMPLEMENTATION_PLAN.md
///         sections 3 and 4 are the specification.
/// @dev A source is healthy when its read passes the validated read: a positive answer from a
///      complete round, stamped no later than this block and younger than
///      `stalenessThreshold`. Two per-token widths apply, both measured against G: the gold
///      band g (`goldBandPpm`) gates borrowing and reserve swaps, and the liquidation cap m
///      (`liquidationClampPpm`) bounds the liquidation price above gold. A price `x` sits
///      inside the band when G x (1 - g) <= x <= G x (1 + g), both edges rounded down.
///
///      Borrowing: C and G healthy and C inside the band, at the lower of C and G; otherwise
///      refused. Reserve swaps: the same gate, at the higher of C and G, so reserve gold is never
///      sold below gold or below the market. Liquidation, trigger and settlement alike: with C
///      and G healthy, min(max(C, G), G x (1 + m)). A push of C down values collateral at gold
///      at worst, never below, and a push up gains at most m. The trade-off, accepted by the
///      owner: a depeg specific to the token is not liquidated while gold holds. With either
///      feed unhealthy liquidation is refused, so no seizure is ever priced on a stale or gold
///      only valuation; it resumes by itself on the first healthy pair, with no call, role or
///      keeper step. Repayment and deposits never read a price and stay open. There is no
///      time-based override of any kind.
///
///      The liquidation price is one rule (`_settlement`). A separate trigger rule can be added
///      later as a sibling over the same `Reading` without touching it.
///
///      An unset anchor counts every price as inside the band and prices liquidation at C
///      (local deployments only; the launch preflight refuses it on mainnet). PAXG and XAUT keep
///      immutable convenience accessors so the original two-token ABI is preserved.
contract GoldOracle is IGoldOracle, AccessControl, ExpiringPausable {
    bytes32 public constant GOVERNANCE_ROLE = keccak256("GOVERNANCE_ROLE");
    /// @notice Emergency role (bypasses the governance timelock).
    /// @dev Held by a dedicated multisig. Can pause the oracle and freeze or unfreeze one token
    ///      at once, but cannot unpause: unpausing requires GOVERNANCE_ROLE (the timelock).
    bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");

    /// @notice Per-token feed configuration
    /// @param feed Source C, Chainlink-compatible, 8 decimals enforced on registration
    /// @param lastKnownPrice The liquidation price of the last successful state-changing read
    ///        (0 = never read); a record for the vault's views, never a price a seizure uses
    /// @param supported Registry membership flag
    struct TokenFeed {
        AggregatorV3Interface feed;
        uint256 lastKnownPrice;
        bool supported;
    }

    /// @dev The outcome of a price rule, without reverting; `_require` turns it into a reason.
    enum Quote {
        Ok,
        NoPrice,
        OffBand
    }

    /// @dev Both sources as one read sees them. `g` is 0 when G is unset (inside every band) or
    ///      unhealthy.
    struct Reading {
        uint256 c;
        uint256 g;
        bool cOk;
        bool gOk;
    }

    /// @notice token => feed configuration
    mapping(address => TokenFeed) public feeds;

    /// @notice Enumeration of registered tokens for off-chain tooling. Append-only by design:
    ///         removing a token with live vault debt would brick its liquidations, so delisting
    ///         happens at the GoldVault layer, never at the oracle.
    address[] public supportedTokens;

    /// @notice Source G, the XAU/USD gold reference. address(0) counts every price as inside
    ///         the gold band and prices liquidation at C, for local deployments only; production sets it in
    ///         the deployment session and the launch preflight refuses a mainnet deployment
    ///         without it.
    AggregatorV3Interface public anchorFeed;

    /// @notice PAXG token address, kept immutable to back the legacy convenience surface
    ///         (getPaxgPrice, setPaxgFeed and the lastKnownPaxgPrice/paxgUsdFeed view shims).
    address public immutable paxgToken;
    /// @notice XAUT token address, kept immutable for the same legacy convenience surface.
    address public immutable xautToken;

    /// @notice Maximum age of feed data before it is considered stale
    /// @dev Applies to C and G alike, so it must cover the slowest registered feed's heartbeat
    ///      plus a grace period. The Ethereum mainnet PAXG/USD and XAU/USD feeds have a 24h
    ///      heartbeat, so the bound is 25h (90000s). A stale source has stopped: it closes the
    ///      paths that need it and nothing else.
    uint256 public stalenessThreshold;

    /// @notice When each token's manual emergency stop lapses (see `tokenFrozen`). Set by the
    ///         guardian or governance through `freezeToken` to `FREEZE_DURATION` ahead and
    ///         cleared by `guardianUnfreezeToken`. Nobody else can freeze a token: a
    ///         permissionless trip would be a way to stall liquidations.
    mapping(address => uint256) public frozenUntil;

    /// @notice The number of each token's freeze in force while it is frozen, of its most recent
    ///         one otherwise; 0 before the first. Every freezeToken call adds one, whether the
    ///         token is frozen (a re-assertion that extends the freeze) or not (a new freeze, a
    ///         lapsed one included); lifting a freeze leaves it unchanged. Governance reads it
    ///         when it schedules an unfreeze and passes it on.
    /// @dev guardianUnfreezeToken accepts governance, so the timelock can schedule it, while a
    ///      freeze lapses by itself after FREEZE_DURATION. An unfreeze that matured after its
    ///      freeze had lapsed reverts "Not frozen" and stays executable for the timelock grace
    ///      period; without the number an open executor could run it inside that period to lift
    ///      a later freeze for a different incident and liquidate the token in the same
    ///      transaction (the freeze counterpart of `pauseEpoch`). A freezeToken call while frozen
    ///      is the guardian's answer to a new incident and a fresh decision to hold, so it
    ///      numbers the freeze afresh too: an unfreeze lands only if nobody has re-asserted the
    ///      freeze since it was scheduled. A compromised guardian can delay recovery by at most
    ///      one more timelock delay: it can void an unfreeze scheduled before its revocation
    ///      executes, so governance schedules the revocation on its own and the unfreeze once
    ///      it has executed. It could already freeze again at once until revoked.
    mapping(address => uint256) public freezeEpoch;

    /// @notice The gold band g: how far C may sit from G, in ppm of G, and still borrow or
    ///         trade with the reserve.
    mapping(address => uint256) public goldBandPpm;

    /// @notice The liquidation cap m: the liquidation price never exceeds G x (1 + m).
    mapping(address => uint256) public liquidationClampPpm;

    /// @notice How long a manual freeze lasts unless the guardian extends it.
    uint256 public constant FREEZE_DURATION = 14 days;

    /// @notice Gold band seeded at registration (2%).
    uint256 public constant DEFAULT_GOLD_BAND_PPM = 20_000;
    /// @notice Liquidation cap seeded at registration (2%). Changed only through the
    ///         timelocked setter; nothing adjusts it in response to monitoring or on a routine.
    uint256 public constant DEFAULT_LIQUIDATION_CLAMP_PPM = 20_000;

    uint256 public constant PRECISION = 1e6;
    uint256 public constant PRICE_DECIMALS = 1e8;

    event StalenessThresholdUpdated(uint256 newThreshold);
    event TokenFrozen(address indexed token, address indexed by, uint256 until);
    event TokenUnfrozen(address indexed token, address indexed by, uint256 price);
    event GoldBandUpdated(address indexed token, uint256 ppm);
    event LiquidationClampUpdated(address indexed token, uint256 ppm);
    event LastKnownPriceResynced(address indexed token, uint256 oldPrice, uint256 newPrice);
    event FeedAdded(address indexed token, address feed);
    event FeedUpdated(address indexed token, address newFeed);
    event AnchorFeedUpdated(address newAnchorFeed);

    constructor(
        address _paxgUsdFeed,
        address _xautUsdFeed,
        address _paxgToken,
        address _xautToken,
        uint256 _stalenessThreshold
    ) {
        require(_stalenessThreshold > 0 && _stalenessThreshold <= 90000, "Invalid staleness threshold");

        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(GOVERNANCE_ROLE, msg.sender);

        require(_paxgUsdFeed != address(0) && _xautUsdFeed != address(0), "Zero feed address");
        require(_paxgToken != address(0) && _xautToken != address(0), "Zero token address");
        require(_paxgToken != _xautToken, "Duplicate token");

        paxgToken = _paxgToken;
        xautToken = _xautToken;
        stalenessThreshold = _stalenessThreshold;

        // Registers both feeds; enforces the PRICE_DECIMALS (1e8) assumption baked into
        // downstream math. anchorFeed starts unset.
        _addFeed(_paxgToken, _paxgUsdFeed);
        _addFeed(_xautToken, _xautUsdFeed);
    }

    // --- Reads ---

    /// @inheritdoc IGoldOracle
    function getPaxgPrice() external view returns (uint256 price, uint256 updatedAt) {
        return _getPrice(feeds[paxgToken].feed);
    }

    /// @inheritdoc IGoldOracle
    function getXautPrice() external view returns (uint256 price, uint256 updatedAt) {
        return _getPrice(feeds[xautToken].feed);
    }

    /// @inheritdoc IGoldOracle
    /// @dev The liquidation price (see the contract notes); records it as `lastKnownPrice`.
    ///      Reverts "No reliable price" when C or G is unhealthy.
    function getTokenPrice(address token) external returns (uint256 price) {
        _requireOpen(token);
        Reading memory r = _sources(token);
        price = _liquidationPrice(token, r);
        feeds[token].lastKnownPrice = price;
    }

    /// @inheritdoc IGoldOracle
    /// @dev Records the liquidation price the same reading gives as `lastKnownPrice`, so the
    ///      vault's view ratio stays current through mint traffic.
    function getBorrowPrice(address token) external returns (uint256 price) {
        _requireOpen(token);
        Reading memory r = _sources(token);
        price = _bandedPrice(token, r, false);
        (feeds[token].lastKnownPrice,) = _settlement(token, r);
    }

    /// @inheritdoc IGoldOracle
    /// @dev Records the liquidation price as `lastKnownPrice`, as getBorrowPrice does.
    function getReservePrice(address token) external returns (uint256 price) {
        _requireOpen(token);
        Reading memory r = _sources(token);
        price = _bandedPrice(token, r, true);
        (feeds[token].lastKnownPrice,) = _settlement(token, r);
    }

    /// @inheritdoc IGoldOracle
    function quoteTokenPrice(address token) external view returns (uint256) {
        _requireOpen(token);
        return _liquidationPrice(token, _sources(token));
    }

    /// @inheritdoc IGoldOracle
    function quoteBorrowPrice(address token) external view returns (uint256) {
        _requireOpen(token);
        return _bandedPrice(token, _sources(token), false);
    }

    /// @inheritdoc IGoldOracle
    function quoteReservePrice(address token) external view returns (uint256) {
        _requireOpen(token);
        return _bandedPrice(token, _sources(token), true);
    }

    /// @inheritdoc IGoldOracle
    /// @dev The lower of C and G whenever both are healthy, inside the band or not: the honest
    ///      market value, never above gold and never the liquidation price, which may sit at gold or above it. 0 when either
    ///      has stopped: nothing current bounds the value then, and a stale record could only
    ///      overstate it, so the reserve leaves that token out of its coverage (which can only
    ///      raise the swap spread, never lower it). Works while paused and while frozen.
    function quoteValuationPrice(address token) external view returns (uint256) {
        require(feeds[token].supported, "Unsupported token");
        Reading memory r = _sources(token);
        if (!r.cOk || !r.gOk) return 0;
        return r.g != 0 && r.g < r.c ? r.g : r.c;
    }

    /// @inheritdoc IGoldOracle
    function tokenFrozen(address token) public view returns (bool) {
        return block.timestamp < frozenUntil[token];
    }

    /// @inheritdoc IGoldOracle
    /// @notice Returns last known price even when paused (for emergency liquidations)
    function getLastKnownPrice(address token) external view returns (uint256) {
        require(feeds[token].supported, "Unsupported token");
        return feeds[token].lastKnownPrice;
    }

    /// @inheritdoc IGoldOracle
    /// @notice Validated read of source C that works even while the oracle is paused.
    /// @dev Never reverts and is not gated by the pause: `ok = false` instead.
    function getValidatedPrice(address token) public view returns (uint256 price, bool ok) {
        TokenFeed storage cfg = feeds[token];
        if (!cfg.supported) return (0, false);
        return _validatedRead(cfg.feed);
    }

    /// @inheritdoc IGoldOracle
    /// @dev Only while the vault or the oracle is paused. A frozen token is stopped ("Token
    ///      frozen") in every case, a pause included: the freeze is the guardian's emergency
    ///      stop for every seizure of that token, and a pause, which the bad-debt breaker can
    ///      trip on another token, must not lift it. Otherwise, in a
    ///      pause, the normal liquidation price and nothing else: whenever the rules refuse (C
    ///      or G unhealthy) it reverts "No price". A pause therefore never liquidates on a
    ///      stale record, a stale C or gold alone, and `lastKnownPrice` never prices a seizure.
    function getEmergencyPrice(address token, bool vaultPaused) external view returns (uint256 price) {
        require(!tokenFrozen(token), "Token frozen");
        require(vaultPaused || paused(), "Not in emergency");
        // An unknown token answers 0 so the vault's own "No debt" check reports first.
        if (!feeds[token].supported) return 0;
        Quote q;
        (price, q) = _settlement(token, _sources(token));
        // An enum compared with its own member, not a balance.
        // slither-disable-next-line incorrect-equality
        require(q == Quote.Ok, "No price");
    }

    // --- The pricing rules ---

    function _requireOpen(address token) internal view {
        require(feeds[token].supported, "Unsupported token");
        require(!tokenFrozen(token), "Token frozen");
        _requireNotPaused();
    }

    /// @dev The price, or the reason a rule refused it. The same reasons on every path.
    function _settle(uint256 price, Quote q) internal pure returns (uint256) {
        require(q != Quote.OffBand, "Off gold band");
        // An enum compared with its own member, not a balance.
        // slither-disable-next-line incorrect-equality
        require(q == Quote.Ok, "No reliable price");
        return price;
    }

    function _liquidationPrice(address token, Reading memory r) internal view returns (uint256) {
        (uint256 price, Quote q) = _settlement(token, r);
        return _settle(price, q);
    }

    function _bandedPrice(address token, Reading memory r, bool high) internal view returns (uint256) {
        (uint256 price, Quote q) = _banded(token, r, high);
        return _settle(price, q);
    }

    /// @dev The settlement rule, the price a liquidation is sized at and the price the vault
    ///      triggers on, without reverting: min(max(C, G), G x (1 + m)) with both healthy (C
    ///      with no gold reference set), refused otherwise.
    function _settlement(address token, Reading memory r) internal view returns (uint256, Quote) {
        if (!r.cOk || !r.gOk) return (0, Quote.NoPrice);
        if (r.c <= r.g) return (r.g, Quote.Ok);
        return (_clamp(r.c, r.g, liquidationClampPpm[token]), Quote.Ok);
    }

    /// @dev Borrowing (`high` false, the lower of C and G) and reserve swaps (`high` true, the
    ///      higher), both gated by C and G healthy and C inside the gold band. Without reverting.
    function _banded(address token, Reading memory r, bool high) internal view returns (uint256, Quote) {
        if (!r.cOk || !r.gOk) return (0, Quote.NoPrice);
        // Zero is the "no gold reference set" sentinel and the last line compares two
        // booleans; neither is a balance.
        // slither-disable-next-line incorrect-equality
        if (r.g == 0) return (r.c, Quote.Ok);
        if (_clamp(r.c, r.g, goldBandPpm[token]) != r.c) return (0, Quote.OffBand);
        // slither-disable-next-line incorrect-equality
        return ((r.g > r.c) == high ? r.g : r.c, Quote.Ok);
    }

    /// @dev `x` held within [ref x (1 - w), ref x (1 + w)], both edges rounded down; `x`
    ///      itself when no reference is set. `x` is inside width w exactly when this returns it.
    function _clamp(uint256 x, uint256 ref, uint256 w) internal pure returns (uint256) {
        // Zero is the "no gold reference set" sentinel, not a balance.
        // slither-disable-next-line incorrect-equality
        if (ref == 0) return x;
        uint256 lo = Math.mulDiv(ref, PRECISION - w, PRECISION);
        if (x < lo) return lo;
        uint256 hi = Math.mulDiv(ref, PRECISION + w, PRECISION);
        return x > hi ? hi : x;
    }

    /// @dev Both sources as one read sees them, without reverting.
    function _sources(address token) internal view returns (Reading memory r) {
        (r.c, r.cOk) = _validatedRead(feeds[token].feed);
        AggregatorV3Interface anchor = anchorFeed;
        if (address(anchor) == address(0)) {
            r.gOk = true;
            return r;
        }
        (r.g, r.gOk) = _validatedRead(anchor);
    }

    /// @dev The validated read of one source: healthy or `ok = false`, never a revert.
    function _validatedRead(AggregatorV3Interface feed) internal view returns (uint256 price, bool ok) {
        (uint256 value, uint256 age, bool sound) = _read(feed);
        if (!sound || age >= stalenessThreshold) return (0, false);
        return (value, true);
    }

    /// @dev The integrity half of the validated read: a positive answer from a complete round
    ///      stamped no later than this block, and its age. Never reverts.
    function _read(AggregatorV3Interface feed) internal view returns (uint256 price, uint256 age, bool sound) {
        // An outage includes a revert, missing bytecode and malformed return data. A typed
        // try/catch decodes the return data in this frame, so a short answer, a missing
        // contract or a round id wider than uint80 would revert here instead of reading as
        // stopped. Check the size, decode full width, then range check the round fields.
        // Only the five expected words are ever copied: a feed answering with a huge return
        // payload would otherwise cost this frame its memory expansion and revert a read
        // documented as never reverting.
        bytes memory request = abi.encodeCall(AggregatorV3Interface.latestRoundData, ());
        bool success;
        uint256 size;
        uint256 roundId;
        int256 answer;
        uint256 updatedAt;
        uint256 answeredInRound;
        assembly ("memory-safe") {
            let out := mload(0x40)
            success := staticcall(gas(), feed, add(request, 0x20), mload(request), out, 0xa0)
            size := returndatasize()
            roundId := mload(out)
            answer := mload(add(out, 0x20))
            // startedAt (out + 0x40) is deliberately unused; the other four are validated.
            updatedAt := mload(add(out, 0x60))
            answeredInRound := mload(add(out, 0x80))
        }
        if (!success || size != 160) return (0, 0, false);
        if (roundId > type(uint80).max || answeredInRound > type(uint80).max) return (0, 0, false);
        if (answer <= 0) return (0, 0, false);
        if (updatedAt == 0) return (0, 0, false);
        if (answeredInRound < roundId) return (0, 0, false);
        // A stamp ahead of the block would underflow the subtraction; treat it as an
        // invalid round instead.
        if (updatedAt > block.timestamp) return (0, 0, false);
        return (uint256(answer), block.timestamp - updatedAt, true);
    }

    /// @dev The legacy reverting read behind getPaxgPrice and getXautPrice.
    function _getPrice(AggregatorV3Interface feed) internal view whenNotPaused returns (uint256, uint256) {
        // startedAt is deliberately unused; the other four fields are validated.
        // slither-disable-next-line unused-return
        (uint80 roundId, int256 answer,, uint256 updatedAt, uint80 answeredInRound) = feed.latestRoundData();
        require(answer > 0, "Invalid price");
        require(updatedAt > 0, "Round not complete");
        require(answeredInRound >= roundId, "Stale round");
        require(updatedAt <= block.timestamp, "Future oracle timestamp");
        require(block.timestamp - updatedAt < stalenessThreshold, "Stale oracle");
        return (uint256(answer), updatedAt);
    }

    // --- Freeze and re-anchoring ---

    /// @notice Freeze one token for `FREEZE_DURATION`: the manual emergency stop for its normal
    ///         reads and its emergency liquidations, during a pause as well.
    ///         Guardian or governance only, no timelock. Calling it again while
    ///         frozen extends the freeze to `FREEZE_DURATION` from now, so a live guardian keeps
    ///         a genuine incident stopped and a lost one cannot strand the token. Every call
    ///         takes a new `freezeEpoch`, an extension included, so an unfreeze approved before
    ///         it reverts "Different freeze".
    function freezeToken(address token) external {
        _requireGuardianOrGovernance();
        require(feeds[token].supported, "Unsupported token");
        ++freezeEpoch[token];
        uint256 until = block.timestamp + FREEZE_DURATION;
        frozenUntil[token] = until;
        emit TokenFrozen(token, msg.sender, until);
    }

    /// @notice Lift freeze number `epoch` of one token once a normal liquidation read would
    ///         succeed, recording that price as `lastKnownPrice`. Guardian or governance, no
    ///         timelock of its own; pass `freezeEpoch(token)` as read when calling or scheduling.
    /// @dev The guardian chooses the timing, never the value: the price is what the rules give.
    ///      A later freezeToken call, a re-freeze of the frozen token included, has a higher
    ///      number and reverts "Different freeze", so an unfreeze governance scheduled for one
    ///      incident cannot lift a freeze re-asserted for another.
    function guardianUnfreezeToken(address token, uint256 epoch) external {
        _requireGuardianOrGovernance();
        require(tokenFrozen(token), "Not frozen");
        require(epoch == freezeEpoch[token], "Different freeze");
        uint256 price = _reanchor(token);
        frozenUntil[token] = 0;
        emit TokenUnfrozen(token, msg.sender, price);
    }

    /// @notice Record the price a normal liquidation read would give now as `lastKnownPrice`.
    /// @dev Bounded to the rules (it cannot set an arbitrary value). Works while paused and
    ///      while frozen. `lastKnownPrice` is a record for views; it never prices a seizure.
    function resyncLastKnownPrice(address token) external onlyRole(GOVERNANCE_ROLE) {
        _resync(token);
    }

    /// @notice The same re-anchoring for the guardian, without the timelock, on identical terms.
    function guardianResyncLastKnownPrice(address token) external {
        _requireGuardianOrGovernance();
        _resync(token);
    }

    function _resync(address token) internal {
        uint256 old = feeds[token].lastKnownPrice;
        uint256 price = _reanchor(token);
        emit LastKnownPriceResynced(token, old, price);
    }

    /// @dev The liquidation rules, the pause and the freeze aside; records the price.
    function _reanchor(address token) internal returns (uint256 price) {
        require(feeds[token].supported, "Unsupported token");
        Reading memory r = _sources(token);
        price = _liquidationPrice(token, r);
        feeds[token].lastKnownPrice = price;
    }

    function _requireGuardianOrGovernance() internal view {
        require(
            hasRole(GUARDIAN_ROLE, msg.sender) || hasRole(GOVERNANCE_ROLE, msg.sender),
            "Not guardian or governance"
        );
    }

    // --- Registry ---

    /// @notice Register source C for a new collateral token. Append-only: there is no
    ///         removeFeed (see `supportedTokens`); delist at the vault layer instead.
    /// @dev lastKnownPrice starts at 0. The gold band and the liquidation cap start at their
    ///      defaults.
    function addFeed(address token, address feed) external onlyRole(GOVERNANCE_ROLE) {
        _addFeed(token, feed);
    }

    function _addFeed(address token, address feed) internal {
        require(token != address(0), "Zero token address");
        require(feed != address(0), "Zero feed address");
        require(!feeds[token].supported, "Feed already added");
        require(feed != address(anchorFeed), "Feed not independent");
        require(AggregatorV3Interface(feed).decimals() == 8, "Must be 8 decimals");
        feeds[token] = TokenFeed({feed: AggregatorV3Interface(feed), lastKnownPrice: 0, supported: true});
        goldBandPpm[token] = DEFAULT_GOLD_BAND_PPM;
        liquidationClampPpm[token] = DEFAULT_LIQUIDATION_CLAMP_PPM;
        supportedTokens.push(token);
        emit FeedAdded(token, feed);
    }

    /// @notice Replace source C for an already registered token. Preserves lastKnownPrice.
    function setFeed(address token, address feed) external onlyRole(GOVERNANCE_ROLE) {
        _setFeed(token, feed);
    }

    function _setFeed(address token, address feed) internal {
        // Denomination is not validated on chain: an 8-decimal feed quoting in the wrong unit
        // passes the decimals check, so operators must verify it is USD-denominated. Pointing C
        // at the gold reference would make the band meaningless, so it is refused.
        require(feeds[token].supported, "Unsupported token");
        require(feed != address(0), "Zero address");
        require(feed != address(anchorFeed), "Feed not independent");
        require(AggregatorV3Interface(feed).decimals() == 8, "Must be 8 decimals");
        feeds[token].feed = AggregatorV3Interface(feed);
        emit FeedUpdated(token, feed);
    }

    /// @notice Set the gold band g that gates borrowing and reserve swaps.
    /// @param ppm Range: 5000 (0.5%) to 100000 (10%).
    function setGoldBand(address token, uint256 ppm) external onlyRole(GOVERNANCE_ROLE) {
        require(feeds[token].supported, "Unsupported token");
        require(ppm >= 5000 && ppm <= 100000, "Band out of range");
        goldBandPpm[token] = ppm;
        emit GoldBandUpdated(token, ppm);
    }

    /// @notice Set the liquidation cap m: how far above gold a market price may value collateral.
    ///         Narrower limits what a push of C up can rescue from liquidation.
    /// @param ppm Range: 5000 (0.5%) to 50000 (5%). GoldVault refuses any liquidation ratio
    ///        below 105%, so the cap never exceeds the headroom a ratio leaves above par and a
    ///        vault under water at gold is always liquidatable however far C is pushed up.
    function setLiquidationClamp(address token, uint256 ppm) external onlyRole(GOVERNANCE_ROLE) {
        require(feeds[token].supported, "Unsupported token");
        require(ppm >= 5000 && ppm <= 50000, "Clamp out of range");
        liquidationClampPpm[token] = ppm;
        emit LiquidationClampUpdated(token, ppm);
    }

    /// @notice Set or replace the XAU/USD gold reference. It may never be a registered market
    ///         feed of any token, and once set it cannot be cleared: an unset reference counts
    ///         every price as inside the band and prices liquidation at C, which only a local
    ///         deployment that never set one may rely on.
    function setAnchorFeed(address feed) external onlyRole(GOVERNANCE_ROLE) {
        if (feed == address(0)) {
            require(address(anchorFeed) == address(0), "Anchor required");
        } else {
            require(AggregatorV3Interface(feed).decimals() == 8, "Must be 8 decimals");
            uint256 count = supportedTokens.length;
            for (uint256 i = 0; i < count; i++) {
                require(feed != address(feeds[supportedTokens[i]].feed), "Feed not independent");
            }
        }
        anchorFeed = AggregatorV3Interface(feed);
        emit AnchorFeedUpdated(feed);
    }

    /// @notice Enumerate every registered token (convenience for deployment verification
    ///         and off-chain tooling).
    function getSupportedTokens() external view returns (address[] memory) {
        return supportedTokens;
    }

    // --- Governance ---

    function setPaxgFeed(address _feed) external onlyRole(GOVERNANCE_ROLE) {
        _setFeed(paxgToken, _feed);
    }

    function setXautFeed(address _feed) external onlyRole(GOVERNANCE_ROLE) {
        _setFeed(xautToken, _feed);
    }

    /// @notice Set the staleness threshold (seconds). Range: 300 (5m) to 90000 (25h).
    /// @dev The threshold applies to C and G alike, so it must be calibrated to the slowest
    ///      registered feed: tightening it below the gold reference's heartbeat stops every
    ///      token's prices on quiet days.
    function setStalenessThreshold(uint256 _threshold) external onlyRole(GOVERNANCE_ROLE) {
        require(_threshold >= 300 && _threshold <= 90000, "Threshold out of range");
        stalenessThreshold = _threshold;
        emit StalenessThresholdUpdated(_threshold);
    }

    /// @notice Emergency pause, callable by guardian or governance without timelock delay
    function emergencyPause() external {
        _requireGuardianOrGovernance();
        _pause();
    }

    /// @notice Re-assert the pause in force and restart its 14 day window (same authority as
    ///         the pause). Every extension takes a new pauseEpoch, so an unpause approved
    ///         before it reverts "Different pause".
    function extendPause() external {
        _requireGuardianOrGovernance();
        _extendPause();
    }

    /// @notice Lift pause number `epoch` early. Governance only, through the timelock.
    /// @param epoch pauseEpoch() as read when the unpause was scheduled; a later pause or
    ///        extension has another number, so an approval given before it cannot lift it
    ///        ("Different pause").
    function unpause(uint256 epoch) external onlyRole(GOVERNANCE_ROLE) {
        _unpauseAt(epoch);
    }

    /// @dev Explicit override required because both IGoldOracle and Pausable declare
    ///      paused(). Pure passthrough; behaviour is unchanged from Pausable.
    function paused() public view override(IGoldOracle, Pausable) returns (bool) {
        return super.paused();
    }

    /// @notice Grant guardian role, used once during deployment to wire the guardian multisig
    function grantGuardianRole(address guardian) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(guardian != address(0), "Zero address");
        _grantRole(GUARDIAN_ROLE, guardian);
    }

    /// @notice Transfer all governance power to the timelock and permanently remove deployer access
    function transferGovernance(address timelockAddr) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(timelockAddr != address(0), "Zero address");
        require(timelockAddr != msg.sender, "Would self-revoke");
        // A handover is one-shot and irreversible; an EOA typo here is a dead protocol.
        require(timelockAddr.code.length > 0, "Timelock must be a contract");
        _grantRole(GOVERNANCE_ROLE, timelockAddr);
        _grantRole(DEFAULT_ADMIN_ROLE, timelockAddr);
        _revokeRole(GOVERNANCE_ROLE, msg.sender);
        _revokeRole(DEFAULT_ADMIN_ROLE, msg.sender);
    }

    // --- Legacy conveniences ---
    // ABI-identical view shims for the public state variables removed by the registry
    // refactor. Tests, verify-deployment.ts and external integrations keep working.

    /// @notice Legacy accessor: the registered PAXG feed.
    function paxgUsdFeed() external view returns (AggregatorV3Interface) {
        return feeds[paxgToken].feed;
    }

    /// @notice Legacy accessor: the registered XAUT feed.
    function xautUsdFeed() external view returns (AggregatorV3Interface) {
        return feeds[xautToken].feed;
    }

    /// @notice Legacy accessor: PAXG's last known price.
    function lastKnownPaxgPrice() external view returns (uint256) {
        return feeds[paxgToken].lastKnownPrice;
    }

    /// @notice Legacy accessor: XAUT's last known price.
    function lastKnownXautPrice() external view returns (uint256) {
        return feeds[xautToken].lastKnownPrice;
    }
}
