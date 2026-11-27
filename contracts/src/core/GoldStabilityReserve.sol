// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.38;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";
import "../interfaces/IGoldOracle.sol";
import "../interfaces/IGoldStablecoin.sol";

interface IReserveSurplusBuffer {
    function depositFee(uint256 amount) external;
    function gsusdBalance() external view returns (uint256);
}

/// @title GoldStabilityReserve
/// @notice Protocol-owned gold that GSUSD converts into at a guaranteed, oracle-derived
///         quote. The below-peg floor.
///
/// @dev The defining property of GSUSD is that gold/USD risk stays with the borrowers
///      who create it (docs/PEG_ARCHITECTURE.md §1). This contract therefore holds
///      assets and owes nothing: it never mints GSUSD, never holds MINTER_ROLE, and can
///      only ever be empty, not insolvent. Every GSUSD it receives on a swap is HELD as
///      inventory, never burned — the GSUSD was created by a borrower whose debt still
///      stands, and burning it would break `totalSupply == Σ borrowerPrincipal`.
///
///      No borrower's vault is touched on any path through this contract. That is the
///      product guarantee; it is not a parameter.
///
///      Pricing: oracle price minus a utilisation spread that rises as reserve coverage
///      (redeemable value ÷ circulating GSUSD) falls, so gold gets progressively more
///      expensive to remove as the defensive inventory thins. Outflow is bounded per asset
///      per day and in aggregate per day, and each asset can be paused independently by
///      the guardian, because an oracle problem on PAXG is not a reason to stop XAUT. An
///      asset pause lapses on its own after ASSET_PAUSE_DURATION unless the guardian extends
///      it, like the vault, oracle and pool pauses and the oracle's token freeze.
contract GoldStabilityReserve is AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant GOVERNANCE_ROLE = keccak256("GOVERNANCE_ROLE");
    bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");
    /// @notice Held by GoldVault so its share of liquidation penalties can be deposited.
    bytes32 public constant VAULT_ROLE = keccak256("VAULT_ROLE");

    uint256 public constant PPM = 1e6;
    uint256 public constant PRICE_DECIMALS = 1e8;
    /// @notice The spread can never be set below this. It must stay above the oracle's
    ///         deviation threshold so a stale-low feed cannot be arbitraged profitably.
    uint256 public constant MIN_SPREAD_PPM = 5_000; // 0.5%: never below the PAXG/XAUT feeds' 0.5% deviation triggers, or a lawfully lagging feed is a riskless arbitrage against the reserve
    uint256 public constant MAX_SPREAD_PPM = 50_000; // 5%
    uint256 public constant MAX_SPREAD_STEPS = 8;
    /// @notice How long an asset pause lasts unless the guardian extends it. Mirrors
    ///         ExpiringPausable.MAX_PAUSE_DURATION and GoldOracle.FREEZE_DURATION: a lost or
    ///         absent governance cannot leave one asset's swaps stopped for ever.
    uint256 public constant ASSET_PAUSE_DURATION = 14 days;

    struct AssetConfig {
        bool supported;
        /// @notice When the asset's pause lapses; swaps stop while block.timestamp is below
        ///         it (see assetPaused). 0 when never paused or unpaused by governance.
        uint64 pausedUntil;
        uint8 decimals;
        /// @notice Gold below this never leaves through a swap. Governance may withdraw it.
        uint256 minReserve;
        /// @notice Share of the asset's day-start balance that may leave in one UTC day.
        uint256 dailyCapPpm;
        /// @notice True once the token has entered supportedTokens; it is never pushed twice.
        bool listed;
    }

    struct SpreadStep {
        /// @notice This step applies when coverage (ppm) is at least this value.
        uint256 coverageAtLeastPpm;
        uint256 spreadPpm;
    }

    IERC20 public immutable gsusd;
    IGoldOracle public oracle;
    /// @notice Fee sink for the spread. May be address(0), in which case the spread is
    ///         retained as inventory rather than burned.
    IReserveSurplusBuffer public surplusBuffer;

    mapping(address => AssetConfig) public assets;
    address[] public supportedTokens;

    /// @notice Each asset's pause number: that of its pause in force while paused, of its most
    ///         recent pause otherwise; 0 before the first. Every pauseAsset call adds one,
    ///         whether the asset is paused (a re-assertion that extends the pause) or not (a new
    ///         pause, a lapsed one included); lifting a pause leaves it unchanged. Governance
    ///         reads it when it schedules unpauseAsset and passes it on.
    /// @dev A scheduled unpauseAsset names the pause it was approved for, so an old approval
    ///      still executable within the timelock grace period cannot lift a later pause of the
    ///      same asset. A pauseAsset call while paused is the guardian's answer
    ///      to a new incident and a fresh decision to hold, so it numbers the pause afresh too:
    ///      an unpauseAsset lands only if nobody has re-asserted the pause since it was
    ///      scheduled. A compromised guardian can delay recovery by at most one more timelock
    ///      delay: it can void an unpauseAsset scheduled before its revocation executes, so
    ///      governance schedules the revocation on its own and the unpauseAsset once it has
    ///      executed. It could already pause again at once until revoked. Kept outside AssetConfig so the assets()
    ///      getter keeps its shape.
    mapping(address => uint256) public assetPauseEpoch;

    /// @notice Accounted gold per token. Tokens sent directly are not counted until seeded.
    mapping(address => uint256) public collateralBalance;
    /// @notice GSUSD received on swaps and held. Inside totalSupply; never burned here.
    uint256 public gsusdInventory;

    /// @notice Spread steps, sorted by coverageAtLeastPpm descending.
    SpreadStep[] public spreadCurve;
    /// @notice Applies when coverage is below every step's threshold.
    uint256 public restrictedSpreadPpm;

    /// @notice The circulating supply the spread is priced against forgets a burn slowly.
    /// @dev Coverage is redeemable gold over circulating GSUSD, and a borrower can shrink
    ///      the denominator for free inside one transaction: repay their own debt, swap at
    ///      the cheaper tier the higher coverage buys, mint the debt back. The spread is
    ///      therefore priced against the HIGHER of the live circulating supply and the
    ///      stablecoin's one-day smoothed supply (GoldStablecoin.smoothedSupplyNow), which is
    ///      advanced on every mint and burn with the supply that held until that moment. A
    ///      mint (more supply, less coverage) steps the spread up at once; a burn takes a day
    ///      to earn the cheaper tier, however long the reserve has been quiet, and nothing off
    ///      chain has to keep it warm. Gold entering the reserve counts at once.

    /// @notice Aggregate USD (18 dec) that may leave across all assets in one UTC day. 0 = off.
    uint256 public aggregateDailyCapUsd;
    mapping(address => mapping(uint256 => uint256)) public dayOutflow;
    mapping(uint256 => uint256) public dayOutflowUsd;

    // Lifetime counters, never decremented. Seeds and penalties are kept apart so the
    // reserves page can show what was earned versus what was put in.
    mapping(address => uint256) public totalGoldSeeded;
    mapping(address => uint256) public totalGoldFromPenalties;
    mapping(address => uint256) public totalGoldSwappedOut;
    mapping(address => uint256) public totalGoldWithdrawn;
    uint256 public totalGsusdReceived;
    /// @notice Spread the surplus buffer has taken. A spread it could not take is kept in
    ///         gsusdInventory and is not counted here.
    uint256 public totalSpreadPaid;
    uint256 public totalGsusdWithdrawn;

    event Swapped(address indexed redeemer, address indexed token, uint256 gsusdIn, uint256 goldOut, uint256 spreadPpm, uint256 fee);
    event CollateralSeeded(address indexed token, address indexed from, uint256 amount, uint256 cumulative);
    event CollateralDeposited(address indexed token, uint256 amount, uint256 cumulative);
    event CollateralWithdrawn(address indexed token, address indexed to, uint256 amount);
    event GsusdWithdrawn(address indexed to, uint256 amount);
    event AssetConfigured(address indexed token, bool supported, uint256 minReserve, uint256 dailyCapPpm);
    event AssetPaused(address indexed token, address indexed by);
    event AssetUnpaused(address indexed token);
    event SpreadCurveUpdated(uint256 steps, uint256 restrictedSpreadPpm);
    event AggregateDailyCapUpdated(uint256 capUsd);
    event OracleUpdated(address oracle);
    event SurplusBufferUpdated(address buffer);
    event FeeRoutingFailed(uint256 amount);

    constructor(address _gsusd, address _oracle) {
        require(_gsusd != address(0) && _oracle != address(0), "Zero address");
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(GOVERNANCE_ROLE, msg.sender);
        gsusd = IERC20(_gsusd);
        oracle = IGoldOracle(_oracle);
        restrictedSpreadPpm = MAX_SPREAD_PPM;
    }

    // ========== The swap ==========

    /// @notice Convert GSUSD into protocol-owned gold at the oracle price minus the
    ///         current spread. No borrower's vault is involved.
    /// @param token      PAXG or XAUT.
    /// @param gsusdIn    GSUSD to convert.
    /// @param minGoldOut Slippage bound on the gold received, in the token's decimals.
    function swapGsusdForGold(address token, uint256 gsusdIn, uint256 minGoldOut)
        external
        nonReentrant
        returns (uint256 goldOut)
    {
        require(gsusdIn > 0, "Zero amount");
        AssetConfig storage cfg = assets[token];
        require(cfg.supported, "Unsupported token");
        require(!_isPaused(cfg), "Asset paused");

        // The reserve price, never the liquidation price: the higher of the token's market
        // feed and gold, only while both are healthy and the market sits inside its gold band.
        // It reverts otherwise ("Off gold band" during a depeg specific to the token, "No
        // reliable price" when a feed has stopped), which is the intended behaviour: reserve
        // gold is never sold below gold, below the market or at an unvalidated price.
        // The swap's ledger entries are written after this price read and before any token
        // moves. The read is the governance-set oracle, which reaches its feeds by static
        // call, and this entry point is nonReentrant.
        // slither-disable-next-line reentrancy-benign
        uint256 price = oracle.getReservePrice(token);
        require(price > 0, "Invalid price");

        // Anchor first, from the supply BEFORE this swap's inventory moves, so a same-day
        // burn cannot buy the cheaper tier, and price at the coverage the swap leaves
        // behind, so one large swap cannot drain the reserve across a tier at the cheaper
        // spread it started on.
        uint256 spread = _swapSpreadPpm(gsusdIn);
        uint256 fee = Math.mulDiv(gsusdIn, spread, PPM);
        uint256 net = gsusdIn - fee;

        // goldOut = net (18) / price (8), in the token's native decimals.
        goldOut = Math.mulDiv(net, 10 ** cfg.decimals, price * (10 ** (18 - 8)));
        require(goldOut > 0, "Swap too small");
        require(goldOut >= minGoldOut, "Slippage");

        _enforceCapacity(token, cfg, goldOut, price);

        // Effects before interactions.
        collateralBalance[token] -= goldOut;
        totalGoldSwappedOut[token] += goldOut;
        gsusdInventory += net;
        totalGsusdReceived += gsusdIn;

        gsusd.safeTransferFrom(msg.sender, address(this), gsusdIn);
        _routeSpread(fee);
        uint256 recipientBefore = IERC20(token).balanceOf(msg.sender);
        IERC20(token).safeTransfer(msg.sender, goldOut);
        // Issuers can enable transfer fees. The slippage promise is about what the
        // redeemer receives, while the inventory and caps above track what we send. So the
        // Swapped event reports the amount received, and with a fee switched on it sums to
        // less than totalGoldSwappedOut and the daily outflow, which count the amount sent;
        // quoteGoldOut quotes the amount sent.
        goldOut = IERC20(token).balanceOf(msg.sender) - recipientBefore;
        require(goldOut >= minGoldOut, "Slippage");

        emit Swapped(msg.sender, token, gsusdIn, goldOut, spread, fee);
    }

    function _enforceCapacity(address token, AssetConfig storage cfg, uint256 goldOut, uint256 price) internal {
        uint256 balance = collateralBalance[token];
        require(balance > cfg.minReserve && balance - cfg.minReserve >= goldOut, "Reserve insufficient");

        uint256 day = block.timestamp / 1 days;
        // The day's cap is a share of where the balance stood at the start of the day,
        // which is today's outflow added back onto the current balance.
        uint256 dayCap = Math.mulDiv(balance + dayOutflow[token][day], cfg.dailyCapPpm, PPM);
        uint256 newOutflow = dayOutflow[token][day] + goldOut;
        require(newOutflow <= dayCap, "Daily cap reached");
        dayOutflow[token][day] = newOutflow;

        // The day's USD outflow is recorded on every swap, at the price it executed at, whether
        // or not the aggregate cap is on. Only the comparison is conditional. It used to be
        // recorded only while the cap was positive, so a cap switched on part way through a
        // day started from zero and allowed a second full allowance on top of what had already
        // left.
        uint256 newUsd = dayOutflowUsd[day] + _usdValue(goldOut, cfg.decimals, price);
        require(aggregateDailyCapUsd == 0 || newUsd <= aggregateDailyCapUsd, "Aggregate daily cap reached");
        dayOutflowUsd[day] = newUsd;
    }

    /// @dev The spread is revenue and goes to insurance. If the buffer cannot take it,
    ///      it is RETAINED as inventory, never burned: burning here would destroy GSUSD a
    ///      borrower still owes and break supply == debt. totalSpreadPaid counts a spread
    ///      only once the buffer has taken it; a retained spread is inventory and nothing
    ///      else, so totalGsusdReceived == gsusdInventory + totalSpreadPaid +
    ///      totalGsusdWithdrawn holds with no buffer and with one that reverts.
    function _routeSpread(uint256 fee) internal {
        if (fee == 0) return;
        if (address(surplusBuffer) != address(0)) {
            gsusd.forceApprove(address(surplusBuffer), fee);
            try surplusBuffer.depositFee(fee) {
                totalSpreadPaid += fee;
                return;
            } catch {
                gsusd.forceApprove(address(surplusBuffer), 0);
            }
        }
        gsusdInventory += fee;
        emit FeeRoutingFailed(fee);
    }

    // ========== Funding ==========

    /// @notice Add gold to the reserve. Permissionless: it can only increase holdings.
    /// @dev Measured delta, so a fee-on-transfer token is credited with what arrived.
    function seedCollateral(address token, uint256 amount) external nonReentrant {
        require(assets[token].supported, "Unsupported token");
        require(amount > 0, "Zero amount");
        uint256 received = _pull(token, amount);
        collateralBalance[token] += received;
        totalGoldSeeded[token] += received;
        emit CollateralSeeded(token, msg.sender, received, totalGoldSeeded[token]);
    }

    /// @notice The vault's share of a liquidation penalty.
    function depositCollateral(address token, uint256 amount) external nonReentrant onlyRole(VAULT_ROLE) {
        require(assets[token].supported, "Unsupported token");
        uint256 received = _pull(token, amount);
        collateralBalance[token] += received;
        totalGoldFromPenalties[token] += received;
        emit CollateralDeposited(token, received, totalGoldFromPenalties[token]);
    }

    function _pull(address token, uint256 amount) internal returns (uint256 received) {
        uint256 before = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        received = IERC20(token).balanceOf(address(this)) - before;
    }

    // ========== Views ==========

    /// @notice Gold above the floor, i.e. what swaps may draw on before daily caps.
    function redeemableCollateral(address token) public view returns (uint256) {
        uint256 balance = collateralBalance[token];
        uint256 floor = assets[token].minReserve;
        return balance > floor ? balance - floor : 0;
    }

    /// @notice USD value (18 dec) of redeemable gold across every supported, unpaused asset.
    /// @dev A view, so it never moves the oracle. Each token is valued at the oracle's
    ///      valuation price: the lower of its market feed and gold while both are healthy,
    ///      inside the gold band or not, so gold is never valued above either and a depegged
    ///      token is valued at its market price, never at the clamped liquidation price. A
    ///      token whose market feed or gold reference has stopped is left out (valued at
    ///      zero) rather than at its last known price: nothing current bounds that price, and
    ///      leaving it out can only raise the spread, never lower it.
    ///      Gold no swap can draw is not coverage: a de-supported or paused asset is
    ///      skipped, or the remaining asset was sold at a spread the real inventory did not
    ///      justify exactly when the reserve was thinner than it looked. A token
    ///      the oracle cannot price adds nothing instead of reverting every swap.
    function reserveValueUsd() public view returns (uint256 value) {
        uint256 n = supportedTokens.length;
        for (uint256 i = 0; i < n; i++) {
            address token = supportedTokens[i];
            // A token frozen by the guardian cannot be swapped either.
            if (!assets[token].supported || _isPaused(assets[token]) || oracle.tokenFrozen(token)) continue;
            try oracle.quoteValuationPrice(token) returns (uint256 price) {
                value += _usdValue(redeemableCollateral(token), assets[token].decimals, price);
            } catch {
                continue;
            }
        }
    }

    /// @notice GSUSD in circulation, excluding what this reserve itself holds.
    function circulatingSupply() public view returns (uint256) {
        uint256 supply = IERC20Metadata(address(gsusd)).totalSupply();
        return supply > gsusdInventory ? supply - gsusdInventory : 0;
    }

    /// @notice Redeemable reserve value ÷ circulating supply, in ppm.
    function coveragePpm() public view returns (uint256) {
        uint256 circulating = circulatingSupply();
        if (circulating == 0) return PPM * 1000;
        return Math.mulDiv(reserveValueUsd(), PPM, circulating);
    }

    /// @notice The spread a vanishingly small swap would pay right now, from the damped
    ///         coverage. A real swap pays the tier of the coverage it leaves behind.
    function currentSpreadPpm() public view returns (uint256) {
        return _spreadFor(dampedCoveragePpm());
    }

    /// @notice The circulating supply the spread is priced against: the higher of live
    ///         and the one-day smoothed supply, so a burn is only credited as it ages.
    function dampedCirculatingSupply() public view returns (uint256) {
        uint256 live = circulatingSupply();
        uint256 smoothedTotal = IGoldStablecoin(address(gsusd)).smoothedSupplyNow();
        uint256 smoothed = smoothedTotal > gsusdInventory ? smoothedTotal - gsusdInventory : 0;
        return live > smoothed ? live : smoothed;
    }

    /// @notice Coverage priced against the damped supply; what the spread reads.
    function dampedCoveragePpm() public view returns (uint256) {
        uint256 circulating = dampedCirculatingSupply();
        // Same sentinel as coveragePpm: nothing in circulation means unlimited coverage.
        if (circulating == 0) return PPM * 1000;
        return Math.mulDiv(reserveValueUsd(), PPM, circulating);
    }

    /// @notice The spread a swap of `gsusdIn` pays: the tier of the coverage it leaves
    ///         behind. Conservative on purpose: the gold leaving is valued at the whole
    ///         `gsusdIn` and the supply is left where it stands, so the post-swap coverage is
    ///         never overstated and a swap can only pay the same tier or a dearer one.
    function _swapSpreadPpm(uint256 gsusdIn) internal view returns (uint256) {
        uint256 circulating = dampedCirculatingSupply();
        if (circulating == 0) return _spreadFor(PPM * 1000);
        uint256 value = reserveValueUsd();
        uint256 remaining = value > gsusdIn ? value - gsusdIn : 0;
        return _spreadFor(Math.mulDiv(remaining, PPM, circulating));
    }

    function _spreadFor(uint256 coverage) internal view returns (uint256) {
        uint256 n = spreadCurve.length;
        for (uint256 i = 0; i < n; i++) {
            if (coverage >= spreadCurve[i].coverageAtLeastPpm) return spreadCurve[i].spreadPpm;
        }
        return restrictedSpreadPpm;
    }

    /// @notice Gold still allowed out of `token` today, honouring the floor, the per-asset
    ///         cap and, when it is on, the aggregate USD cap. Zero whenever a swap in this
    ///         block would be refused: an unsupported or paused asset, or no reserve price
    ///         (the token frozen, the oracle paused, a feed stale or off its gold band).
    /// @dev The aggregate cap is converted to gold at quoteReservePrice, the price a swap in
    ///      this block executes at, rounded down so a swap sized from this view never trips
    ///      "Aggregate daily cap reached". The price is read whether or not that cap is on:
    ///      with no reserve price no swap can run, so the answer is 0 either way.
    function remainingDailyCapacity(address token) public view returns (uint256) {
        AssetConfig storage cfg = assets[token];
        if (!cfg.supported || _isPaused(cfg)) return 0;
        uint256 aboveFloor = redeemableCollateral(token);
        uint256 day = block.timestamp / 1 days;
        uint256 dayCap = Math.mulDiv(collateralBalance[token] + dayOutflow[token][day], cfg.dailyCapPpm, PPM);
        uint256 dayRemaining = dayCap > dayOutflow[token][day] ? dayCap - dayOutflow[token][day] : 0;
        uint256 remaining = aboveFloor < dayRemaining ? aboveFloor : dayRemaining;
        // A zero sentinel, not a manipulable balance: no room left needs no oracle read.
        // slither-disable-next-line incorrect-equality
        if (remaining == 0) return 0;
        try oracle.quoteReservePrice(token) returns (uint256 price) {
            if (price == 0) return 0;
            // A cap of 0 means the aggregate cap is off.
            if (aggregateDailyCapUsd == 0) return remaining;
            uint256 usdLeft = aggregateDailyCapUsd > dayOutflowUsd[day] ? aggregateDailyCapUsd - dayOutflowUsd[day] : 0;
            uint256 byAggregate = Math.mulDiv(usdLeft, PRICE_DECIMALS, price * (10 ** (18 - cfg.decimals)));
            return remaining < byAggregate ? remaining : byAggregate;
        } catch {
            return 0;
        }
    }

    /// @notice Preview a swap at the oracle's current reserve price (quoteReservePrice), the
    ///         price swapGsusdForGold executes at in this block; (0, 0) when the asset is
    ///         unsupported or paused or the oracle would refuse the swap. The floor and the
    ///         daily caps are not applied: bound the size with remainingDailyCapacity.
    ///         Prices move between blocks; pass a minGoldOut accordingly.
    function quoteGoldOut(address token, uint256 gsusdIn) external view returns (uint256 goldOut, uint256 spreadPpm) {
        AssetConfig storage cfg = assets[token];
        if (!cfg.supported || _isPaused(cfg)) return (0, 0);
        // The price a swap would execute at (getReservePrice), so the preview matches
        // execution; no preview when the oracle would refuse the swap.
        try oracle.quoteReservePrice(token) returns (uint256 price) {
            if (price == 0) return (0, 0);
            spreadPpm = _swapSpreadPpm(gsusdIn);
            uint256 net = gsusdIn - Math.mulDiv(gsusdIn, spreadPpm, PPM);
            goldOut = Math.mulDiv(net, 10 ** cfg.decimals, price * (10 ** (18 - 8)));
        } catch {
            return (0, 0);
        }
    }

    function spreadCurveLength() external view returns (uint256) {
        return spreadCurve.length;
    }

    function supportedTokenCount() external view returns (uint256) {
        return supportedTokens.length;
    }

    function _usdValue(uint256 amount, uint8 decimals, uint256 price) internal pure returns (uint256) {
        return Math.mulDiv(amount * (10 ** (18 - decimals)), price, PRICE_DECIMALS);
    }

    /// @notice True while swaps in `token` are paused: until the pause lapses
    ///         ASSET_PAUSE_DURATION after it was last applied or extended, or governance lifts it.
    function assetPaused(address token) external view returns (bool) {
        return _isPaused(assets[token]);
    }

    function _isPaused(AssetConfig storage cfg) internal view returns (bool) {
        return block.timestamp < cfg.pausedUntil;
    }

    // ========== Guardian ==========

    /// @notice Stop swaps in one asset without touching the other, for ASSET_PAUSE_DURATION.
    ///         Guardian or governance. Calling it again while paused extends the pause to
    ///         ASSET_PAUSE_DURATION from now, so a live guardian keeps a genuine incident
    ///         stopped and a lost one cannot stop the asset for ever.
    ///         Every call takes a new assetPauseEpoch, an extension included, so an unpauseAsset
    ///         approved before it reverts "Different pause".
    function pauseAsset(address token) external {
        require(hasRole(GUARDIAN_ROLE, msg.sender) || hasRole(GOVERNANCE_ROLE, msg.sender), "Not guardian or governance");
        AssetConfig storage cfg = assets[token];
        require(cfg.supported, "Unsupported token");
        ++assetPauseEpoch[token];
        cfg.pausedUntil = uint64(block.timestamp + ASSET_PAUSE_DURATION);
        emit AssetPaused(token, msg.sender);
    }

    /// @notice Governance only: a pause is cheap to apply and should be deliberate to lift
    ///         early. Nobody needs to act for it to lapse.
    /// @param epoch assetPauseEpoch(token) as read when the unpause was scheduled; a later
    ///        pauseAsset call on the asset, an extension included, has another number, so an
    ///        approval given before it cannot lift it ("Different pause").
    function unpauseAsset(address token, uint256 epoch) external onlyRole(GOVERNANCE_ROLE) {
        require(assets[token].supported, "Unsupported token");
        require(epoch == assetPauseEpoch[token], "Different pause");
        assets[token].pausedUntil = 0;
        emit AssetUnpaused(token);
    }

    // ========== Governance ==========

    function setAssetConfig(address token, bool supported, uint256 minReserve, uint256 dailyCapPpm)
        external
        onlyRole(GOVERNANCE_ROLE)
    {
        require(token != address(0) && token != address(gsusd), "Not a collateral token");
        require(dailyCapPpm <= PPM, "Cap exceeds 100%");
        AssetConfig storage cfg = assets[token];
        // A token enters the array once. Unsupporting keeps it there (its balance stays
        // withdrawable by governance and lifetime counters readable), so re-supporting must
        // not push it again: a duplicate would count its gold twice in reserveValueUsd and
        // hand every swap a cheaper spread than the real coverage allows.
        if (supported && !cfg.listed) {
            uint8 dec = IERC20Metadata(token).decimals();
            require(dec <= 18, "Decimals must be <= 18");
            // A listed token stays in the array for good, so one the oracle has no entry for
            // must never enter it: register the feed first, or in the same batch. The read
            // proves registration only (it reverts for a token the oracle does not list).
            // It does not prove the oracle can price the token now: a registered token whose
            // feed is stale, frozen or never yet read passes, and is then left out of the
            // coverage figure until it has a price. Only the revert matters, so the value
            // returned is ignored.
            // slither-disable-next-line unused-return
            try oracle.getLastKnownPrice(token) {} catch {
                revert("No oracle feed");
            }
            cfg.decimals = dec;
            cfg.listed = true;
            supportedTokens.push(token);
        }
        cfg.supported = supported;
        cfg.minReserve = minReserve;
        cfg.dailyCapPpm = dailyCapPpm;
        emit AssetConfigured(token, supported, minReserve, dailyCapPpm);
    }

    /// @notice Replace the whole spread curve. Steps must be sorted by coverage
    ///         descending with spreads ascending, every spread inside [MIN, MAX].
    function setSpreadCurve(SpreadStep[] calldata steps, uint256 restricted) external onlyRole(GOVERNANCE_ROLE) {
        require(steps.length <= MAX_SPREAD_STEPS, "Too many steps");
        require(restricted >= MIN_SPREAD_PPM && restricted <= MAX_SPREAD_PPM, "Restricted spread out of range");
        delete spreadCurve;
        uint256 lastCoverage = type(uint256).max;
        uint256 lastSpread = 0;
        for (uint256 i = 0; i < steps.length; i++) {
            require(steps[i].coverageAtLeastPpm < lastCoverage, "Steps must descend in coverage");
            require(steps[i].spreadPpm >= MIN_SPREAD_PPM && steps[i].spreadPpm <= MAX_SPREAD_PPM, "Spread out of range");
            require(steps[i].spreadPpm >= lastSpread, "Spreads must ascend");
            require(steps[i].spreadPpm <= restricted, "Step exceeds restricted spread");
            spreadCurve.push(steps[i]);
            lastCoverage = steps[i].coverageAtLeastPpm;
            lastSpread = steps[i].spreadPpm;
        }
        restrictedSpreadPpm = restricted;
        emit SpreadCurveUpdated(steps.length, restricted);
    }

    function setAggregateDailyCap(uint256 capUsd) external onlyRole(GOVERNANCE_ROLE) {
        aggregateDailyCapUsd = capUsd;
        emit AggregateDailyCapUpdated(capUsd);
    }

    function setOracle(address _oracle) external onlyRole(GOVERNANCE_ROLE) {
        require(_oracle != address(0), "Zero address");
        oracle = IGoldOracle(_oracle);
        emit OracleUpdated(_oracle);
    }

    /// @notice Pass address(0) to retain the spread as inventory instead of routing it.
    function setSurplusBuffer(address _buffer) external onlyRole(GOVERNANCE_ROLE) {
        if (_buffer != address(0)) {
            // Interface probe: a wrong address reverts here, not on the first swap.
            // slither-disable-next-line unused-return
            IReserveSurplusBuffer(_buffer).gsusdBalance();
        }
        surplusBuffer = IReserveSurplusBuffer(_buffer);
        emit SurplusBufferUpdated(_buffer);
    }

    /// @notice Move GSUSD inventory out, e.g. to sell it for gold when GSUSD is at peg.
    /// @dev The reserve itself is refused as the recipient: a transfer to the sender moves no
    ///      tokens, so the inventory would fall while the balance stayed, overstating the
    ///      circulating supply.
    function withdrawGsusd(address to, uint256 amount) external onlyRole(GOVERNANCE_ROLE) nonReentrant {
        require(to != address(0), "Zero address");
        require(to != address(this), "Self payment");
        require(amount <= gsusdInventory, "Exceeds inventory");
        gsusdInventory -= amount;
        totalGsusdWithdrawn += amount;
        gsusd.safeTransfer(to, amount);
        emit GsusdWithdrawn(to, amount);
    }

    /// @notice Governance may go below the swap floor; swaps may not.
    function withdrawCollateral(address token, address to, uint256 amount) external onlyRole(GOVERNANCE_ROLE) nonReentrant {
        require(to != address(0), "Zero address");
        require(to != address(this), "Self payment");
        require(amount <= collateralBalance[token], "Exceeds balance");
        collateralBalance[token] -= amount;
        totalGoldWithdrawn[token] += amount;
        IERC20(token).safeTransfer(to, amount);
        emit CollateralWithdrawn(token, to, amount);
    }

    function grantGuardianRole(address guardian) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(guardian != address(0), "Zero address");
        _grantRole(GUARDIAN_ROLE, guardian);
    }

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
}
