// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.38;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./ExpiringPausable.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";
import "../interfaces/IGoldOracle.sol";

import "../interfaces/IGoldStablecoin.sol";
import "../interfaces/IStabilityModule.sol";
import "../interfaces/IVaultRegistry.sol";

interface ISurplusBuffer {
    function depositFee(uint256 amount) external;
    function depositCollateral(address token, uint256 amount) external;
    function absorbBadDebt(uint256 amount) external;
    function absorptionBurns() external view returns (bool);
}

interface IStabilityPool {
    function absorbLiquidationPrefunded(address token, uint256 debtToAbsorb) external;
    function getTotalDeposits() external view returns (uint256);
    function absorbsPrefunded() external view returns (bool);
}

interface IStabilityReserve {
    function depositCollateral(address token, uint256 amount) external;
}

/// @dev The one view setVaultRegistry probes: a registry is built for exactly one vault.
interface IVaultRegistryProbe {
    function vault() external view returns (address);
}

interface ISiloFactory {
    function deposit(address token, uint256 amount) external returns (uint256 credited);
    function withdraw(address token, address to, uint256 amount) external;
    function totalCollateral(address token) external view returns (uint256);
    function isEmpty() external view returns (bool);
}

/// @title GoldVault
/// @notice CDP-style vault allowing users to deposit PAXG/XAUT and mint GSUSD stablecoin
/// @dev Manages collateral ratios, minting caps, partial liquidations, and stability fee integration
contract GoldVault is ReentrancyGuard, ExpiringPausable, AccessControl {
    using SafeERC20 for IERC20;

    bytes32 public constant GOVERNANCE_ROLE = keccak256("GOVERNANCE_ROLE");

    /// @dev The VAULT_ROLE hash shared by the silo factory and the surplus buffer, checked when either is wired in.

    bytes32 private constant EXTERNAL_VAULT_ROLE = keccak256("VAULT_ROLE");
    /// @notice Emergency-pause-only role (bypasses governance timelock).
    /// @dev Held by a dedicated multisig. Can pause instantly but CANNOT unpause —
    ///      unpausing requires GOVERNANCE_ROLE (the timelock) to deliberate.
    bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");

    struct CollateralType {
        address token;
        uint256 minRatio;             // Minimum collateralisation ratio (e.g. 1200000 = 120%)
        uint256 liquidationRatio;     // Ratio below which liquidation is allowed (e.g. 1100000 = 110%)
        uint256 liquidationPenalty;   // Penalty on liquidation (e.g. 50000 = 5%)
        uint256 debtCeiling;          // Max total debt for this collateral type
        uint256 totalDebt;            // Current total debt for this collateral type
        bool active;
    }

    struct Vault {
        address collateralToken;
        uint256 collateralAmount;
        uint256 debtAmount;           // Principal debt (excluding accrued fees)
    }

    /// @notice Collateral types keyed by keccak256(abi.encodePacked(token))
    mapping(bytes32 => CollateralType) public collateralTypes;

    /// @notice User vaults — one per address
    mapping(address => Vault) public vaults;

    IGoldOracle public oracle;
    /// @dev Immutable: the GSUSD address is the protocol's identity and must never be
    ///      swappable. Constructor-only, so this also saves an SLOAD on every operation.
    IGoldStablecoin public immutable stablecoin;
    /// @notice Fixed at construction: it holds every vault's normalised debt and nothing could
    ///         migrate that to a replacement, so there is deliberately no setter.
    IStabilityModule public stabilityModule;

    /// @notice Optional SurplusBuffer receiving stability fees and liquidation penalties
    /// @dev When address(0), fees are burned (legacy behaviour) and penalties stay in surplusCollateral
    ISurplusBuffer public surplusBuffer;

    /// @notice The Gold Stability Reserve, which receives a governed share of the
    ///         protocol's liquidation-penalty gold. It is never a redemption source for
    ///         vault collateral; nothing in this contract lets it touch a vault.
    IStabilityReserve public stabilityReserve;
    /// @notice Share (bps) of the protocol's penalty cut routed to the reserve; the rest
    ///         goes to insurance.
    uint256 public reservePenaltyShareBps;

    /// @notice Optional StabilityPool that can absorb liquidations
    IStabilityPool public stabilityPool;

    /// @notice Optional SiloFactory for distributing collateral across censorship-resistant silos
    ISiloFactory public siloFactory;
    /// @dev Set by the first deposit taken with no factory wired: that gold sits in this
    ///      contract, and wiring a factory afterwards would route its withdrawals and
    ///      liquidations to empty silos. One way on purpose.
    bool internal heldUnwired;

    /// @notice Optional VaultRegistry: the on-chain list of open vaults for liquidators and agents
    IVaultRegistry public vaultRegistry;

    /// @notice Bad debt outstanding (debt with no backing collateral awaiting absorption)
    uint256 public totalBadDebt;

    /// @notice If totalBadDebt exceeds this threshold, every bad debt event pauses the vault, or
    ///         re-asserts the pause in force (lapsed or not) by restarting its window under a new
    ///         pauseEpoch (0 = disabled)
    uint256 public badDebtPauseThreshold;

    uint256 public constant PRECISION = 1e6;
    uint256 public constant PRICE_DECIMALS = 1e8;
    /// @notice Upper bound for a collateral type's minimum ratio: 1,000%. Above it a typo in
    ///         a proposal would stop every mint for the type rather than tighten it.
    uint256 public constant MAX_MIN_RATIO = 10_000_000;
    /// @dev Gas handed to the VaultRegistry hook. A first listing creates up to three storage
    ///      slots; under the state-creation pricing live on Sepolia since 2026 (about 100k gas
    ///      per new slot, measured: a plain ERC20 approve costs 112k there) that is roughly
    ///      250k, 340k when the registry is empty. Unused gas is returned, so the budget only
    ///      sets the floor a wallet must send.
    uint256 internal constant REGISTRY_SYNC_GAS = 360_000;
    /// @notice Smallest non-zero debt a vault may carry. Governance sets it so that the
    ///         liquidator's share of the penalty on the smallest vault still covers gas on the
    ///         target chain; a floor too low leaves vaults nobody will ever liquidate.
    uint256 public minDebt = 100e18;

    /// @notice Discount, in ppm of the collateral's value, at which an UNDERWATER vault's
    ///         gold is sold to its liquidator, never more than the shortfall itself. Below 100% collateralisation there is no
    ///         penalty left to pay a liquidator, so without it nobody books the bad debt and
    ///         the hole only grows; the discount is small, bounded, and becomes bad debt the
    ///         buffer absorbs like the rest.
    uint256 public underwaterDiscountPpm = 20_000;

    /// @notice Fraction of liquidation penalty that goes to the liquidator (e.g. 600000 = 60%)
    /// @dev The remaining fraction goes to the protocol surplus. With a 5% total penalty and
    ///      60% liquidator share, the liquidator receives a 3% discount and the protocol keeps 2%.
    uint256 public liquidatorIncentiveShare = 600000; // 60% of penalty -> liquidator

    /// @notice Protocol surplus from liquidation penalties — retained as collateral per token
    mapping(address => uint256) public surplusCollateral;

    /// @notice Maximum GSUSD mintable per block (0 = unlimited).
    /// @dev Bounds the blast radius of a single-block price-manipulation or
    ///      governance-misconfiguration event. Governance can raise / lower
    ///      via the timelock.
    uint256 public perBlockMintCap;

    /// @notice GSUSD minted in a given block number (for the per-block cap), net of what the
    ///         same accounts repaid in that block.
    mapping(uint256 => uint256) public blockMinted;

    /// @dev Per account, the block of its latest capped mint (bits 160 and up) and what it
    ///      minted in that block (low 160 bits). A repayment in the same block retires up to
    ///      that much from blockMinted, so a mint repaid at once never fills the cap for
    ///      everyone else, while another account's repayment never makes room for a borrower.
    mapping(address => uint256) internal ownBlockMint;

    /// @notice One-off fee charged at mint, in basis points of the amount drawn. 0 = off.
    /// @dev Every other lever realises only when the borrower comes back: the stability fee
    ///      is collected on exit, and the reserve spread needs a swap. This is the only
    ///      charge realised in full at t=0, which is why it exists even though it is a small
    ///      line. It is 0 at construction; deploy.ts sets the launch value, 5 bps (owner
    ///      decision 2026-11-02), and governance moves it within MAX_ORIGINATION_FEE_BPS. The
    ///      borrower still owes the full `amount`, so the fee is a discount on what they
    ///      receive, and an originationFeeExempt account pays none.
    uint256 public originationFeeBps;

    /// @notice Hard ceiling on the origination fee.
    /// @dev 100 bps, not higher, for a peg reason rather than a fairness one: free minting
    ///      is what caps GSUSD's upside at $1. A mint fee f raises the arbitrage-free
    ///      ceiling to 1/(1-f), so 100 bps gives $1.0101 — already at the edge of the
    ///      published $0.995-$1.01 band. Above that the fee starts moving the peg.
    uint256 public constant MAX_ORIGINATION_FEE_BPS = 100;

    /// @notice Addresses exempt from the origination fee (protocol-owned vaults).
    /// @dev TOKEN_POLICY's TGE gate is an annualised revenue run-rate. Charging the
    ///      protocol's own vault would inflate exactly the number that must not be
    ///      inflated by self-dealing.
    mapping(address => bool) public originationFeeExempt;

    /// @notice Lifetime origination fees charged, for the revenue series.
    uint256 public totalOriginationFees;

    event PerBlockMintCapUpdated(uint256 newCap);
    event OriginationFeeUpdated(uint256 newBps);
    event OriginationFeeExemptSet(address indexed account, bool exempt);
    event OriginationFeeCharged(address indexed user, uint256 fee, uint256 cumulative);
    /// @notice The SurplusBuffer rejected fee revenue; it was burned instead. Alert on this.
    event FeeRoutingFailed(uint256 amount);

    /// @notice setStabilityPool was given a pool that does not declare absorbsPrefunded().
    error PoolLacksPrefundedAbsorb();
    event PenaltyRoutedToReserve(address indexed token, uint256 amount);
    event ReserveRoutingFailed(address indexed token, uint256 amount);
    event StabilityReserveUpdated(address reserve);
    event ReservePenaltyShareUpdated(uint256 bps);
    /// @notice The SurplusBuffer rejected penalty collateral; it stayed in surplusCollateral.
    event SurplusRoutingFailed(address indexed token, uint256 amount);

    // --- Events ---
    event CollateralDeposited(address indexed user, address indexed token, uint256 amount);
    event CollateralWithdrawn(address indexed user, address indexed token, uint256 amount);
    event DebtMinted(address indexed user, uint256 amount);
    event DebtRepaid(address indexed user, uint256 amount);
    event Liquidated(
        address indexed vaultOwner,
        address indexed liquidator,
        uint256 debtRepaid,
        uint256 collateralSeized
    );
    event CollateralTypeAdded(bytes32 indexed id, address token);
    event CollateralTypeUpdated(bytes32 indexed id);
    event SurplusWithdrawn(address indexed to, address indexed token, uint256 amount);
    event BadDebt(address indexed vaultOwner, uint256 amount);
    event BadDebtAbsorptionFailed(uint256 amount);
    event BadDebtRetried(uint256 absorbed);
    event VaultRegistryUpdated(address indexed registry);
    event MinDebtUpdated(uint256 value);
    /// @notice The protocol's penalty share went to the liquidator because this address could not receive it.
    event ProtocolShareCeded(address indexed token, uint256 amount);
    event UnderwaterDiscountUpdated(uint256 ppm);
    event VaultRegistrySyncFailed(address indexed owner);
    event LiquidatedViaPool(
        address indexed vaultOwner,
        address indexed liquidator,
        uint256 debtRepaid,
        uint256 collateralSeized
    );

    constructor(address _oracle, address _stablecoin, address _stabilityModule) {
        require(_oracle != address(0) && _stablecoin != address(0) && _stabilityModule != address(0), "Zero address");

        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(GOVERNANCE_ROLE, msg.sender);

        oracle = IGoldOracle(_oracle);
        stablecoin = IGoldStablecoin(_stablecoin);
        stabilityModule = IStabilityModule(_stabilityModule);
    }

    // ========== Collateral Type Management ==========

    /// @notice Register a new collateral type. ID is derived from token address.
    function addCollateralType(
        address token,
        uint256 minRatio,
        uint256 liquidationRatio,
        uint256 liquidationPenalty,
        uint256 debtCeiling
    ) external onlyRole(GOVERNANCE_ROLE) {
        bytes32 id = _collateralId(token);
        require(!collateralTypes[id].active, "Already exists");
        _checkCollateralParams(minRatio, liquidationRatio, liquidationPenalty);
        // Decimal normalisation math (`10 ** (18 - decimals)`) underflows if decimals > 18.
        // Below 2 decimals the smallest silo cap (0.01 token) rounds to zero native units, the
        // factory then sees every silo as full and no deposit can land.
        uint8 dec = IERC20Metadata(token).decimals();
        require(dec >= 2 && dec <= 18, "Decimals must be 2 to 18");

        collateralTypes[id] = CollateralType({
            token: token,
            minRatio: minRatio,
            liquidationRatio: liquidationRatio,
            liquidationPenalty: liquidationPenalty,
            debtCeiling: debtCeiling,
            totalDebt: 0,
            active: true
        });

        emit CollateralTypeAdded(id, token);
    }

    /// @dev The bounds a collateral type's parameters must satisfy, added or updated.
    function _checkCollateralParams(uint256 minRatio, uint256 liquidationRatio, uint256 liquidationPenalty) internal pure {
        require(minRatio <= MAX_MIN_RATIO, "Min ratio exceeds maximum");
        require(minRatio > liquidationRatio, "Min ratio must exceed liquidation ratio");
        // At least 100% plus GoldOracle's largest liquidation cap (5%): with less headroom a
        // market price pushed up to the cap could value a vault under water at gold back above
        // its liquidation ratio and keep it from being liquidated.
        require(liquidationRatio >= PRECISION + 50_000, "Liquidation ratio must be >= 105%");
        require(liquidationPenalty <= 200000, "Penalty exceeds 20% max");
    }

    /// @notice Change an active collateral type's ratios and penalty, and nothing else.
    /// @dev The ratios and the debt ceiling have separate setters. One setter for the whole
    ///      record made every proposal re-send the fields it did not mean to change, as read
    ///      when it was printed, and a timelock operation then never expired: a ceiling raise
    ///      executed after a ratio tightening silently restored the old ratios.
    ///      The timelock now refuses an operation 7 days after it becomes ready, and neither
    ///      kind of pending operation can overwrite the other.
    function updateCollateralRatios(
        address token,
        uint256 minRatio,
        uint256 liquidationRatio,
        uint256 liquidationPenalty
    ) external onlyRole(GOVERNANCE_ROLE) {
        (bytes32 id, CollateralType storage colType) = _activeCollateralType(token);
        _checkCollateralParams(minRatio, liquidationRatio, liquidationPenalty);

        colType.minRatio = minRatio;
        colType.liquidationRatio = liquidationRatio;
        colType.liquidationPenalty = liquidationPenalty;

        emit CollateralTypeUpdated(id);
    }

    /// @notice Change an active collateral type's debt ceiling, and nothing else.
    function setDebtCeiling(address token, uint256 debtCeiling) external onlyRole(GOVERNANCE_ROLE) {
        (bytes32 id, CollateralType storage colType) = _activeCollateralType(token);
        colType.debtCeiling = debtCeiling;
        emit CollateralTypeUpdated(id);
    }

    /// @dev The collateral type of `token` and its id, refusing one that is not active.
    function _activeCollateralType(address token) internal view returns (bytes32 id, CollateralType storage colType) {
        id = _collateralId(token);
        colType = collateralTypes[id];
        require(colType.active, "Not active");
    }

    // ========== Vault Operations ==========

    // Reentrancy. Several functions below write state after an external call. What makes
    // that safe is the same throughout, and each annotated line says which call it is:
    //  - every state-changing entry point of this contract is nonReentrant, so nothing
    //    called from inside one can come back into another;
    //  - GSUSD is a plain ERC-20 with no transfer hooks;
    //  - the oracle reads its feeds by static call, so a feed cannot call back;
    //  - the stability module is fixed at construction and makes no outbound call;
    //  - the silo factory, the stability pool, the surplus buffer and the reserve are set
    //    by governance and guard their own entry points;
    //  - the registry hook runs last, with a gas cap, inside try/catch;
    //  - the collateral token's own transfer code runs inside deposits, withdrawals and
    //    seizures, and withdrawn or seized gold is paid to whoever is owed it. PAXG and
    //    XAUT have no transfer callbacks. That is a property of the issuers' tokens, which
    //    this contract cannot enforce: it must be checked before any collateral is listed.

    /// @notice Deposit collateral into your vault
    /// @dev Uses balance-before/after pattern for fee-on-transfer token safety
    // Deliberately NOT whenNotPaused: a deposit needs no oracle, strictly improves the
    // position, and while the vault is paused emergencyLiquidate stays live — blocking
    // top-ups during a pause handed liquidators a window in which borrowers could not
    // defend their own vaults.
    function deposit(address token, uint256 amount) external nonReentrant {
        require(amount > 0, "Zero amount");

        bytes32 colId = _collateralId(token);
        CollateralType storage colType = collateralTypes[colId];
        require(colType.active, "Collateral type not active");

        Vault storage vault = vaults[msg.sender];

        // First deposit sets the collateral token, subsequent deposits must match
        if (vault.collateralAmount == 0 && vault.debtAmount == 0) {
            vault.collateralToken = token;
        } else {
            require(vault.collateralToken == token, "Collateral token mismatch");
        }

        // Fee-on-transfer protection: measure actual received amount
        uint256 balBefore = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = IERC20(token).balanceOf(address(this)) - balBefore;

        // Route collateral to SiloFactory if configured (censorship resistance).
        // The factory pulls from this contract directly to silos (one hop), and
        // returns the actual credited amount post-fee so vault accounting matches
        // what is actually backed.
        uint256 credited = received;
        if (address(siloFactory) != address(0)) {
            IERC20(token).forceApprove(address(siloFactory), received);
            // The collateral credit is written after this call. Inside it run the silo
            // factory (governance-set, nonReentrant) and the collateral token's
            // transferFrom; see the reentrancy note above.
            // slither-disable-next-line reentrancy-no-eth
            credited = siloFactory.deposit(token, received);
        } else {
            heldUnwired = true;
        }

        // A transfer that delivered nothing (a token whose fee takes a dust amount whole)
        // must not bind the vault to the token, mark this contract as holding collateral
        // or report a deposit of zero. `credited` is the amount the silo factory reports it
        // took into custody (or the measured receipt when unwired), not a balance read
        // before the call, and the entry point is nonReentrant.
        // slither-disable-next-line reentrancy-balance
        require(credited > 0, "Nothing credited");
        vault.collateralAmount += credited;

        emit CollateralDeposited(msg.sender, token, credited);
        _syncRegistry(msg.sender);
    }

    /// @notice Withdraw collateral, respecting minimum collateralisation ratio
    // Deliberately NOT whenNotPaused: a vault that carries no debt reads no price and owes
    // nothing, so its owner may always take the gold back, whatever state the keys, the
    // oracle or governance are in. Together with `repay` (also open while paused) this makes
    // repay-in-full-then-withdraw a guaranteed exit. A vault WITH debt still needs a valid
    // price and an unpaused system, exactly as before.
    function withdraw(uint256 amount) external nonReentrant {
        require(amount > 0, "Zero amount");

        Vault storage vault = vaults[msg.sender];
        require(vault.collateralAmount >= amount, "Insufficient collateral");

        uint256 remainingCollateral = vault.collateralAmount - amount;

        if (vault.debtAmount > 0) {
            require(!paused(), "Paused: repay in full to withdraw");
            // Use actual debt including accrued stability fees
            bytes32 colId = _collateralId(vault.collateralToken);
            uint256 currentDebt = stabilityModule.getCurrentDebt(msg.sender, colId);
            // The vault's balances are written after this price read, and the token binding
            // is cleared after the gold has been sent. The read is the oracle (feeds by
            // static call); the send runs the silo factory and the collateral token's
            // transfer to the owner; see the reentrancy note above deposit.
            // slither-disable-next-line reentrancy-no-eth
            uint256 collateralValue = _getCollateralValueRaw(vault.collateralToken, remainingCollateral);
            uint256 ratio = (collateralValue * PRECISION) / currentDebt;
            require(ratio >= collateralTypes[colId].minRatio, "Below min ratio");
        }

        vault.collateralAmount = remainingCollateral;
        address tokenAddr = vault.collateralToken;

        // Transfer before reset so we still have the token address
        _sendCollateral(tokenAddr, msg.sender, amount);

        // Reset vault if fully emptied
        if (vault.collateralAmount == 0 && vault.debtAmount == 0) {
            vault.collateralToken = address(0);
        }

        emit CollateralWithdrawn(msg.sender, tokenAddr, amount);
        _syncRegistry(msg.sender);
    }

    /// @notice Mint stablecoins against deposited collateral
    function mint(uint256 amount) external nonReentrant whenNotPaused {
        require(amount > 0, "Zero amount");

        Vault storage vault = vaults[msg.sender];
        require(vault.collateralAmount > 0, "No collateral");

        bytes32 colId = _collateralId(vault.collateralToken);
        CollateralType storage colType = collateralTypes[colId];

        // Get current debt including accrued fees
        uint256 currentDebt = vault.debtAmount > 0
            ? stabilityModule.getCurrentDebt(msg.sender, colId)
            : 0;

        // An absurd amount would otherwise overflow the sum into a bare panic; the ratio
        // check then rejects anything large enough to threaten the total debt sum.
        require(amount <= type(uint256).max - currentDebt, "Mint amount too large");
        uint256 newTotalDebt = currentDebt + amount;
        // The debt is booked after this price read. The read is the oracle, which reaches
        // its feeds by static call; see the reentrancy note above deposit.
        // slither-disable-next-line reentrancy-no-eth
        uint256 collateralValue = _getCollateralValue(vault);
        uint256 ratio = (collateralValue * PRECISION) / newTotalDebt;

        require(ratio >= colType.minRatio, "Below min collateralisation ratio");
        require(colType.totalDebt + amount <= colType.debtCeiling, "Debt ceiling reached");
        require(vault.debtAmount + amount >= minDebt, "Below minimum debt");

        // Per-block mint cap (0 = disabled)
        if (perBlockMintCap > 0) {
            uint256 minted = blockMinted[block.number] + amount;
            require(minted <= perBlockMintCap, "Per-block mint cap reached");
            blockMinted[block.number] = minted;
            // Bounded by the ratio check far below 2^160, so the sum never reaches the tag.
            uint256 own = ownBlockMint[msg.sender];
            if (own >> 160 != block.number) own = block.number << 160;
            ownBlockMint[msg.sender] = own + amount;
        }

        vault.debtAmount += amount;
        colType.totalDebt += amount;

        // Record normalised debt in stability module for fee accrual
        stabilityModule.recordDebt(msg.sender, colId, amount);

        // The borrower owes `amount` either way; the fee is taken from what they RECEIVE.
        // Debt and supply both rise by `amount`, so `totalSupply == aggregate debt` is
        // preserved — but only because the fee is banked rather than burned, which is why
        // setOriginationFeeBps refuses to arm without a SurplusBuffer wired.
        uint256 fee = (originationFeeBps == 0 || originationFeeExempt[msg.sender])
            ? 0
            : (amount * originationFeeBps) / 10000;

        if (fee > 0) {
            stablecoin.mint(address(this), fee);
            stablecoin.mint(msg.sender, amount - fee);
            totalOriginationFees += fee;
            // principalPortion 0: nothing is retired, so nothing is burned and the whole
            // fee is banked through the same path every other fee uses.
            _settleGsusdPayment(fee, 0);
            emit OriginationFeeCharged(msg.sender, fee, totalOriginationFees);
        } else {
            stablecoin.mint(msg.sender, amount);
        }

        emit DebtMinted(msg.sender, amount);
        _syncRegistry(msg.sender);
    }

    /// @notice Repay debt and reduce minted stablecoin supply
    function repay(uint256 amount) external nonReentrant {
        require(amount > 0, "Zero amount");

        Vault storage vault = vaults[msg.sender];
        require(vault.debtAmount > 0, "No debt");
        bytes32 colId = _collateralId(vault.collateralToken);

        // Get true debt with fees
        uint256 currentDebt = stabilityModule.getCurrentDebt(msg.sender, colId);

        // Cap instead of reverting on overshoot. With a non-zero stability fee,
        // currentDebt grows every second, so an off-chain full-repay quote is already
        // stale at inclusion time. Under the old `require(amount <= currentDebt)` an
        // overshoot reverted and an undershoot left dust below minDebt (also a revert),
        // making a full close practically impossible. Capping gives Maker wipeAll /
        // Aave repay(type(uint256).max) semantics: quote high (or pass max) and only
        // the true current debt is pulled.
        if (amount > currentDebt) {
            amount = currentDebt;
        }

        // Pro-rata principal allocation
        uint256 principalPortion;
        if (amount >= currentDebt) {
            principalPortion = vault.debtAmount;
        } else {
            principalPortion = Math.mulDiv(vault.debtAmount, amount, currentDebt);
        }

        // Enforce minimum debt floor on remaining balance
        uint256 remainingDebt = vault.debtAmount - principalPortion;
        require(remainingDebt == 0 || remainingDebt >= minDebt, "Remaining debt below minimum");

        vault.debtAmount -= principalPortion;
        collateralTypes[colId].totalDebt -= principalPortion;

        // A mint repaid in its own block issued nothing: give its room under the per-block
        // cap back, or mint-then-repay fills the cap for everyone at the cost of gas.
        uint256 own = ownBlockMint[msg.sender];
        // A block-number tag, not a balance: the strict equality is the rule.
        // slither-disable-next-line incorrect-equality
        if (own >> 160 == block.number) {
            uint256 retired = Math.min(uint160(own), principalPortion);
            ownBlockMint[msg.sender] = own - retired;
            blockMinted[block.number] -= retired;
        }

        // Reduce normalised debt in stability module
        stabilityModule.reduceDebt(msg.sender, colId, amount);

        // Transfer stablecoin from user to vault
        IERC20(address(stablecoin)).safeTransferFrom(msg.sender, address(this), amount);

        // Burn principal, bank the fee (shared with every liquidation path).
        _settleGsusdPayment(amount, principalPortion);

        _finaliseVault(msg.sender, colId);

        emit DebtRepaid(msg.sender, amount);
        _syncRegistry(msg.sender);
    }

    /// @notice Re-attempt bad-debt absorption after a failed or missing buffer.
    /// @dev Permissionless: outstanding bad debt is everyone's problem and the retry
    ///      can only reduce it. No-ops are rejected so the call always reports honestly:
    ///      a buffer that reverts or burns nothing reports "Nothing absorbed".
    function retryBadDebtAbsorption() external nonReentrant {
        require(address(surplusBuffer) != address(0), "No buffer");
        uint256 outstanding = totalBadDebt;
        require(outstanding > 0, "No bad debt");
        uint256 absorbed = _absorbBadDebt(outstanding);
        require(absorbed > 0, "Nothing absorbed");
        emit BadDebtRetried(absorbed);
    }

    // ========== Liquidation ==========

    /// @notice Liquidate an undercollateralised vault (partial or full)
    /// @param vaultOwner Address of the vault to liquidate
    /// @param debtToRepay Amount of debt the liquidator wants to repay (0 = full liquidation)
    function liquidate(address vaultOwner, uint256 debtToRepay) external nonReentrant whenNotPaused {
        (bytes32 colId, uint256 currentDebt, uint256 price) = _requireLiquidatable(vaultOwner, false);
        _liquidateDirect(vaultOwner, colId, currentDebt, debtToRepay, price);
    }

    /// @notice The gate every liquidation path shares: the vault owes something and its
    ///         fee-inclusive debt sits below the collateral's liquidation ratio at the price
    ///         the seizure is then sized at.
    /// @param emergency Price through oracle.getEmergencyPrice (emergencyLiquidate, and
    ///        liquidateViaPool while the vault or the oracle is paused) instead of
    ///        oracle.getTokenPrice. Liquidation never reads the borrowing valuation: it values
    ///        collateral at the higher of the market feed and gold, capped above gold.
    function _requireLiquidatable(address vaultOwner, bool emergency)
        internal
        returns (bytes32 colId, uint256 currentDebt, uint256 price)
    {
        Vault storage vault = vaults[vaultOwner];
        address token = vault.collateralToken;
        // The emergency read comes first, as it always has: it is what reports "Not in emergency".
        if (emergency) price = oracle.getEmergencyPrice(token, paused());
        require(vault.debtAmount > 0, "No debt");
        if (!emergency) price = oracle.getTokenPrice(token);
        colId = _collateralId(token);
        currentDebt = stabilityModule.getCurrentDebt(vaultOwner, colId);
        uint256 ratio = (_value(token, vault.collateralAmount, price) * PRECISION) / currentDebt;
        require(ratio < collateralTypes[colId].liquidationRatio, "Not undercollateralised");
    }

    /// @notice The shared tail of liquidate and emergencyLiquidate once their ratio gates
    ///         have passed: size the seizure, settle the debt and pay out of the silos.
    function _liquidateDirect(
        address vaultOwner,
        bytes32 colId,
        uint256 currentDebt,
        uint256 debtToRepay,
        uint256 tokenPrice
    ) internal {
        Vault storage vault = vaults[vaultOwner];
        CollateralType storage colType = collateralTypes[colId];

        // Default to full liquidation if 0 passed
        if (debtToRepay == 0) {
            debtToRepay = currentDebt;
        }
        require(debtToRepay <= currentDebt, "Exceeds vault debt");

        // Size the seizure in the token's native decimals. The penalty is the first thing
        // to give when the collateral is thin; see _sizeSeizure.
        uint256 decimalScale = 10 ** (18 - IERC20Metadata(vault.collateralToken).decimals());
        uint256 collateralToSeize;
        uint256 debtEquivalentCollateral;
        (debtToRepay, collateralToSeize, debtEquivalentCollateral) = _sizeSeizure(
            debtToRepay, currentDebt, vault.collateralAmount, tokenPrice, colType.liquidationPenalty, decimalScale
        , underwaterDiscountPpm);

        // Split penalty between liquidator and protocol
        uint256 totalPenalty = collateralToSeize - debtEquivalentCollateral;
        uint256 liquidatorBonus = Math.mulDiv(totalPenalty, liquidatorIncentiveShare, PRECISION);
        uint256 liquidatorCollateral = debtEquivalentCollateral + liquidatorBonus;

        uint256 principalRepaid = _applySeizure(vault, colType, currentDebt, debtToRepay, collateralToSeize);

        // Reduce normalised debt in stability module
        // Bad debt is booked (in _handleBadDebt) after this call and the ones that follow it:
        // the stability module (fixed at construction, no outbound call), GSUSD pulled from
        // the liquidator and burned (no hooks), the fee and the protocol's share of the
        // gold handed to the governance-set buffer and reserve, and the seized gold paid
        // out of the silos to the liquidator by the collateral token's transfer. Both
        // callers are nonReentrant; see the reentrancy note above deposit.
        // slither-disable-next-line reentrancy-no-eth
        stabilityModule.reduceDebt(vaultOwner, colId, debtToRepay);

        // Take stablecoin from the liquidator, burn the principal and bank the fee.
        IERC20(address(stablecoin)).safeTransferFrom(msg.sender, address(this), debtToRepay);
        _settleGsusdPayment(debtToRepay, principalRepaid);

        // Pay the seizure out of the silos: the liquidator straight from them, the protocol's
        // share routed through here (see _payLiquidation for the frozen-address case).
        _payLiquidation(vault.collateralToken, msg.sender, liquidatorCollateral, collateralToSeize - liquidatorCollateral);

        // Bad debt handling: if collateral is now 0 but debt remains, clear it and socialise
        _handleBadDebt(vaultOwner, colId);

        _finaliseVault(vaultOwner, colId);

        emit Liquidated(vaultOwner, msg.sender, debtToRepay, collateralToSeize);
        _syncRegistry(vaultOwner);
    }

    /// @notice Book a seizure against a vault: the principal retired, the dust floor and the
    ///         three balances every liquidation path updates.
    /// @dev A payment that leaves the vault holding collateral retires principal and accrued
    ///      fee pro rata. A payment short of the debt that takes ALL the collateral retires
    ///      principal first: what is left is written off as bad debt, and a fee must not be
    ///      recognised on a vault whose principal was not recovered. Pro rata there banked a
    ///      fee (paid to the fee beneficiary ahead of the loss, or burned when no buffer
    ///      takes it) and booked bad debt larger than the GSUSD actually left unbacked by
    ///      the same amount.
    /// @return principalRepaid Principal retired by `debtToRepay` of fee-inclusive debt.
    function _applySeizure(
        Vault storage vault,
        CollateralType storage colType,
        uint256 currentDebt,
        uint256 debtToRepay,
        uint256 collateralToSeize
    ) internal returns (uint256 principalRepaid) {
        principalRepaid = vault.debtAmount;
        if (debtToRepay < currentDebt) {
            principalRepaid = collateralToSeize == vault.collateralAmount
                ? Math.min(principalRepaid, debtToRepay)
                : Math.mulDiv(principalRepaid, debtToRepay, currentDebt);
        }

        // A partial may not strand a dust position the protocol forbids everywhere else
        // (repay applies the same floor). A seizure that empties the vault is exempt: any
        // residual there is bad debt, which _handleBadDebt clears on the spot.
        uint256 residual = vault.debtAmount - principalRepaid;
        // Exact comparisons of accounting figures, not of token balances: the strict
        // equalities are the rule itself.
        require(
            residual == 0 || residual >= minDebt || collateralToSeize == vault.collateralAmount,
            "Residual debt below minimum"
        );
        vault.debtAmount -= principalRepaid;
        vault.collateralAmount -= collateralToSeize;
        colType.totalDebt -= principalRepaid;
    }

    /// @notice Emergency liquidation, callable when EITHER the oracle or the vault is paused.
    /// @dev The gate and the price come from `GoldOracle.getEmergencyPrice`: while the vault
    ///      or the oracle is paused, the normal liquidation price, and a refusal ("No price")
    ///      whenever the rules give none, so a stale record or a single feed never prices a
    ///      seizure. A frozen token is refused ("Token frozen"), during a pause as well.
    function emergencyLiquidate(address vaultOwner, uint256 debtToRepay) external nonReentrant {
        // The oracle decides whether this collateral is in an emergency and at what price:
        // while the vault or the oracle is paused, the normal liquidation price, or
        // a refusal when the rules give none. Reverts "Token frozen" for a frozen token,
        // paused or not, and "Not in emergency" outside a pause.
        (bytes32 colId, uint256 currentDebt, uint256 tokenPrice) = _requireLiquidatable(vaultOwner, true);

        _liquidateDirect(vaultOwner, colId, currentDebt, debtToRepay, tokenPrice);
    }

    // ========== View Functions ==========

    /// @notice Get the collateralisation ratio of a vault including accrued fees
    /// @dev Uses last known price (view-compatible)
    function getCollateralisationRatio(address user) external view returns (uint256) {
        Vault storage vault = vaults[user];
        if (vault.debtAmount == 0) return type(uint256).max;

        bytes32 colId = _collateralId(vault.collateralToken);
        uint256 currentDebt = stabilityModule.getCurrentDebt(user, colId);
        if (currentDebt == 0) return type(uint256).max;

        uint256 collateralValue = _getCollateralValueView(vault);
        return (collateralValue * PRECISION) / currentDebt;
    }

    /// @notice Current debt (including accrued stability fees) for a vault
    /// @dev Exposed for off-chain callers (keeper, dapp)
    function getVaultCurrentDebt(address user) external view returns (uint256) {
        Vault storage vault = vaults[user];
        if (vault.debtAmount == 0) return 0;
        return stabilityModule.getCurrentDebt(user, _collateralId(vault.collateralToken));
    }

    /// @notice Get the liquidation price for a vault (price at which it becomes liquidatable)
    function getLiquidationPrice(address user) external view returns (uint256) {
        Vault storage vault = vaults[user];
        if (vault.collateralAmount == 0 || vault.debtAmount == 0) return 0;

        bytes32 colId = _collateralId(vault.collateralToken);
        CollateralType storage colType = collateralTypes[colId];
        uint256 currentDebt = stabilityModule.getCurrentDebt(user, colId);

        uint8 decimals = IERC20Metadata(vault.collateralToken).decimals();
        uint256 normalisedCollateral = vault.collateralAmount * (10 ** (18 - decimals));

        // liquidationPrice = (debt * liquidationRatio * PRICE_DECIMALS) / (normalisedCollateral * PRECISION)
        return Math.mulDiv(currentDebt * colType.liquidationRatio, PRICE_DECIMALS, normalisedCollateral * PRECISION);
    }

    // ========== Internal ==========

    /// @notice Get collateral value using live oracle price (state-changing)
    function _getCollateralValue(Vault storage vault) internal returns (uint256) {
        return _getCollateralValueRaw(vault.collateralToken, vault.collateralAmount);
    }

    /// @notice Get collateral value using last known price (view-compatible)
    function _getCollateralValueView(Vault storage vault) internal view returns (uint256) {
        return _value(vault.collateralToken, vault.collateralAmount, oracle.getLastKnownPrice(vault.collateralToken));
    }

    /// @notice Calculate collateral value in 18-decimal USD (state-changing — updates oracle)
    /// @dev Normalises token amount to 18 decimals before computing value
    /// @dev Mint and indebted withdrawals value collateral at the oracle's conservative
    ///      borrowing price: the lowest of the token's market sources and gold.
    function _getCollateralValueRaw(address token, uint256 amount) internal returns (uint256) {
        return _value(token, amount, oracle.getBorrowPrice(token));
    }

    /// @dev USD value (18 dec) of `amount` native units of `token` at an 8-decimal `price`.
    function _value(address token, uint256 amount, uint256 price) internal view returns (uint256) {
        uint256 normalised = amount * (10 ** (18 - IERC20Metadata(token).decimals()));
        return Math.mulDiv(normalised, price, PRICE_DECIMALS);
    }

    /// @notice Derive collateral ID from token address — single source of truth
    function _collateralId(address token) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(token));
    }

    /// @notice Send collateral to a recipient — routes through SiloFactory if configured
    function _sendCollateral(address token, address to, uint256 amount) internal {
        if (address(siloFactory) != address(0)) {
            siloFactory.withdraw(token, to, amount);
        } else {
            IERC20(token).safeTransfer(to, amount);
        }
    }

    /// @notice Sizes a seizure for every liquidation path.
    /// @dev The penalty is the first thing to give when the collateral is thin. The earlier
    ///      shape scaled the DEBT down to keep the full (1 + penalty) multiple, so a vault
    ///      whose gold still covered its debt (anywhere between 100% and 105%) was booked as
    ///      bad debt and burned from the SurplusBuffer, and on the pool path a borrower could
    ///      be paid by the buffer to walk away. Now:
    ///      - with room for the whole penalty, nothing changes;
    ///      - when the penalty does not fit, all the collateral leaves against all the debt
    ///        and the penalty is whatever remains above the debt's value, possibly nothing;
    ///      - only when the gold is worth less than the debt is the repayment capped at that
    ///        value, and the remainder is genuine bad debt for _handleBadDebt.
    ///      A partial that fits the whole penalty is sized at the full (1 + penalty) multiple.
    ///      Below (100% + penalty) a partial at that multiple would strip more gold than the
    ///      debt it retires; the largest such partial paid the liquidator more than a full
    ///      liquidation and left a vault with no gold against thousands of GSUSD of debt,
    ///      which the next liquidation booked as bad debt. There a partial is
    ///      therefore taken PRO RATA: the same share of the gold as of the debt, so the
    ///      vault's ratio is unchanged and the liquidator earns what the gold holds above the
    ///      debt, as a full liquidation does. A pool smaller than a thin vault can then work
    ///      it down instead of refusing it outright. Underwater, a
    ///      partial is still refused: the shortfall is booked in full, at once.
    /// @return repay          GSUSD the liquidator actually pays.
    /// @return seize          Collateral leaving the vault, native decimals.
    /// @return debtEquivalent Collateral worth exactly `repay` at the price, never above `seize`.
    function _sizeSeizure(
        uint256 debtToRepay,
        uint256 currentDebt,
        uint256 collateralAmount,
        uint256 tokenPrice,
        uint256 penalty,
        uint256 decimalScale,
        uint256 underwaterDiscount
    ) internal pure returns (uint256 repay, uint256 seize, uint256 debtEquivalent) {
        uint256 priceScale = tokenPrice * decimalScale;
        uint256 fullSeize = Math.mulDiv(currentDebt * (PRECISION + penalty), PRICE_DECIMALS, priceScale * PRECISION);
        repay = debtToRepay;
        if (fullSeize > collateralAmount) {
            // Pro rata; the whole of the gold on a full liquidation.
            seize = Math.mulDiv(collateralAmount, debtToRepay, currentDebt);
            uint256 coverable = Math.mulDiv(collateralAmount, priceScale, PRICE_DECIMALS);
            // Underwater: the gold is worth less than the debt. The liquidator pays its
            // value less the discount, so the call is worth making and the bad debt is
            // booked now rather than left to grow; the discount is part of that bad debt.
            // The discount never exceeds the shortfall itself. A flat discount made the
            // price fall off a cliff at 100%: just above it the liquidator's take shrinks
            // to nothing, just below it the buffer paid the whole discount, so a borrower
            // who was the pool's depositor and keeper could liquidate a vault a hair under
            // water, take every gram back, walk away from the debt and keep 2% of the
            // gold's value in GSUSD, all of it paid by the buffer. Capped, the
            // buffer pays at most twice the real hole and nothing near 100%.
            if (coverable < currentDebt) {
                require(debtToRepay == currentDebt, "Thin vault: liquidate in full");
                repay = Math.mulDiv(coverable, PRECISION - underwaterDiscount, PRECISION);
                if (2 * coverable > currentDebt && 2 * coverable - currentDebt > repay) {
                    repay = 2 * coverable - currentDebt;
                }
            }
        } else if (debtToRepay == currentDebt) {
            seize = fullSeize;
        } else {
            seize = Math.mulDiv(debtToRepay * (PRECISION + penalty), PRICE_DECIMALS, priceScale * PRECISION);
        }
        // A repayment too small to move any collateral (a 1 wei pool absorb, say) would pay
        // GSUSD for nothing; refuse it rather than let the pool be drained a wei at a time.
        require(seize > 0, "Liquidation too small");
        debtEquivalent = Math.mulDiv(repay, PRICE_DECIMALS, priceScale);
    }

    /// @notice Pay a direct or emergency liquidation out of the silos.
    /// @dev The liquidator's share goes straight from the silos to the liquidator, so an
    ///      issuer freeze of this vault's own address cannot stop a liquidation: the silos
    ///      exist to make a single-address freeze pointless, and routing every seizure
    ///      through here had quietly made this address that single point. The protocol's
    ///      share is pulled here to be routed to the reserve and the buffer; the one way that
    ///      pull fails is this address being frozen, and then the share goes to the
    ///      liquidator too, so the seizure always settles and nothing is stranded in custody.
    ///      With no factory wired the vault holds the collateral and pays from its balance.
    ///      Fee-on-transfer collateral loses its fee on the leg to each recipient, as a user
    ///      withdrawal does.
    function _payLiquidation(address token, address liquidator, uint256 liquidatorCollateral, uint256 protocolShare) internal {
        if (protocolShare > 0) {
            if (address(siloFactory) == address(0)) {
                _routeSurplus(token, protocolShare);
            } else if (!_pullProtocolShare(token, protocolShare)) {
                liquidatorCollateral += protocolShare;
                emit ProtocolShareCeded(token, protocolShare);
            }
        }
        if (liquidatorCollateral > 0) _sendCollateral(token, liquidator, liquidatorCollateral);
    }

    /// @dev Pull the protocol's share from the silos to this address and route it; false when
    ///      this address cannot receive the token. A frozen recipient makes every funded silo
    ///      refuse, so the factory's pull failed only after walking every silo of the token,
    ///      and from about 837 funded silos the liquidation no longer fitted in a 2^24 gas
    ///      transaction. A zero-value transfer to this address
    ///      first, which PAXG refuses once this address is frozen, makes the frozen case cost
    ///      the same whatever the silo count. The probe gets all but 1/64 of the gas, and the
    ///      cede that follows a refusal (an event and a silo withdrawal) needs far more than
    ///      that 1/64, so a caller who starves the probe reverts the whole liquidation instead
    ///      of having an unfrozen vault cede its share. A collateral token that refuses
    ///      zero-value transfers would always cede: check that before listing one.
    function _pullProtocolShare(address token, uint256 amount) internal returns (bool) {
        if (!_tryTokenCall(token, IERC20.transfer.selector, address(this), 0)) return false;
        uint256 balBefore = IERC20(token).balanceOf(address(this));
        try siloFactory.withdraw(token, address(this), amount) {
            _routeSurplus(token, IERC20(token).balanceOf(address(this)) - balBefore);
            return true;
        } catch {
            return false;
        }
    }

    /// @notice Settle a GSUSD payment against a vault: burn the principal, bank the fee.
    /// @dev Every debt-reducing path receives `amountPaid` GSUSD covering
    ///      `principalPortion` of principal plus accrued stability fee. The principal must
    ///      be burned (it is the retired liability) and the fee is protocol revenue.
    ///
    ///      Liquidation used to burn the WHOLE payment, which destroyed the accrued fee
    ///      rather than banking it. The borrower had already paid that fee out of seized
    ///      collateral, so burning it simply donated protocol revenue to the remaining
    ///      GSUSD holders. Because fees are only collected on a voluntary repay, and every
    ///      other exit destroyed them, realised revenue was a small fraction of accrued.
    ///
    ///      Burning only the principal also RESTORES the supply/debt identity on these
    ///      paths: supply now falls by exactly the principal retired, matching the
    ///      reduction in totalDebt, instead of over-burning by the fee.
    ///
    ///      With no SurplusBuffer configured the fee is burned, preserving the legacy
    ///      behaviour rather than stranding it.
    function _settleGsusdPayment(uint256 amountPaid, uint256 principalPortion) internal {
        if (principalPortion > 0) {
            stablecoin.burn(principalPortion);
        }
        uint256 feePortion = amountPaid > principalPortion ? amountPaid - principalPortion : 0;
        if (feePortion > 0) {
            if (address(surplusBuffer) != address(0)) {
                IERC20(address(stablecoin)).forceApprove(address(surplusBuffer), feePortion);
                // try/catch is load-bearing. depositFee is onlyRole(VAULT_ROLE) on the
                // buffer, and setSurplusBuffer has no guard that the grant exists, so a
                // governance action pointing at an ungranted buffer would otherwise brick
                // repay AND all three liquidation paths — the same shape as the fault that once
                // bricked liquidation of every PAXG vault. Forfeiting a fee is the correct
                // failure direction; refusing to liquidate is not.
                try surplusBuffer.depositFee(feePortion) {
                    // banked
                } catch {
                    IERC20(address(stablecoin)).forceApprove(address(surplusBuffer), 0);
                    stablecoin.burn(feePortion);
                    emit FeeRoutingFailed(feePortion);
                }
            } else {
                stablecoin.burn(feePortion);
            }
        }
    }

    /// @notice Close-out bookkeeping shared by every debt-reducing path.
    /// @dev When the principal reaches zero, clears the normalised-debt dust in the
    ///      StabilityModule (recordDebt rounds up / reduceDebt rounds down, so a
    ///      full close otherwise strands 1+ wei of normalised debt that the user's next
    ///      vault would inherit) and releases the collateral-token binding once the
    ///      collateral is also fully withdrawn.
    function _finaliseVault(address vaultOwner, bytes32 colId) internal {
        Vault storage vault = vaults[vaultOwner];
        if (vault.debtAmount == 0) {
            // The token binding is cleared after this call, and so after every call already
            // made by the function that reached here: repay, and the direct, emergency and
            // pool liquidations. Those calls are the oracle read (feeds by static call), the
            // stability module (fixed at construction, no outbound call), GSUSD pulled and
            // burned (no hooks), the fee, the bad debt and the protocol's gold handed to the
            // governance-set buffer, reserve and pool, and the seized gold paid out of the
            // silos by the collateral token's transfer. Each of those entry points is
            // nonReentrant; see the reentrancy note above deposit. The analyzer reports
            // every one of those callers against this line.
            // slither-disable-next-line reentrancy-no-eth
            stabilityModule.clearDebt(vaultOwner, colId);
            if (vault.collateralAmount == 0) {
                vault.collateralToken = address(0);
            }
        }
    }

    /// @notice Tell the registry whether `owner` still has an open vault, once the vault's
    ///         own state is final. Skipped when no registry is wired.
    /// @dev Best effort, like the fee routing above: the registry is a pure index that moves
    ///      no funds and holds no roles, so a registry that reverts must never block a
    ///      deposit, a repayment or a liquidation (the emergency path least of all) for the
    ///      48 hours it takes governance to unwire it. A failed call is logged and the list
    ///      is repaired by anyone with VaultRegistry.sync.
    function _syncRegistry(address owner) internal {
        if (address(vaultRegistry) == address(0)) return;
        Vault storage vault = vaults[owner];
        // eth_estimateGas counts a caught hook failure as success, so a wallet that sends the
        // exact estimate would starve the hook and the list would drift on every such call.
        // Refusing to run without the hook's budget makes the estimator include it.
        require(gasleft() >= REGISTRY_SYNC_GAS + 15_000, "Registry gas");
        try vaultRegistry.onVaultChanged{gas: REGISTRY_SYNC_GAS}(owner, vault.collateralAmount == 0 && vault.debtAmount == 0) {
            // listed or delisted
        } catch {
            emit VaultRegistrySyncFailed(owner);
        }
    }

    /// @notice Route protocol's share of liquidation penalty to SurplusBuffer or keep in surplusCollateral
    function _routeSurplus(address token, uint256 amount) internal {
        // Nothing to route. `amount` is the protocol's share as computed by the caller, an
        // accounting figure and not a balance an outsider can nudge off zero.
        // slither-disable-next-line incorrect-equality
        if (amount == 0) return;

        // A governed slice of the protocol's penalty gold funds the stability reserve.
        // Same non-blocking rule as below: a reserve that cannot accept the deposit must
        // not be able to block a liquidation, so the slice falls through to insurance.
        if (address(stabilityReserve) != address(0) && reservePenaltyShareBps > 0) {
            uint256 toReserve = Math.mulDiv(amount, reservePenaltyShareBps, 10000);
            if (toReserve > 0) {
                if (_tryDepositCollateral(token, address(stabilityReserve), toReserve)) {
                    amount -= toReserve;
                    emit PenaltyRoutedToReserve(token, toReserve);
                } else {
                    emit ReserveRoutingFailed(token, toReserve);
                }
            }
        }
        // The reserve took the whole share. The same computed figure as above, less the
        // slice just sent, so the comparison with zero is exact by construction.
        // slither-disable-next-line incorrect-equality
        if (amount == 0) return;

        // Same reasoning as _settleGsusdPayment: a buffer that cannot accept the deposit must
        // not be able to block a liquidation. Fall back to the local surplus ledger, which
        // governance can still withdraw.
        if (address(surplusBuffer) == address(0)) {
            surplusCollateral[token] += amount;
        } else if (!_tryDepositCollateral(token, address(surplusBuffer), amount)) {
            surplusCollateral[token] += amount;
            emit SurplusRoutingFailed(token, amount);
        }
    }

    /// @notice Hand `amount` of penalty gold to the reserve or the buffer (both expose the same
    ///         depositCollateral), reporting failure instead of reverting.
    /// @dev The approval is part of what may fail. PAXG's approve reverts "address frozen" when
    ///      the spender is frozen, and forceApprove passes that revert up, so an issuer freeze
    ///      of the reserve or the buffer used to revert every direct and emergency liquidation
    ///      from outside the try/catch meant to absorb it.
    function _tryDepositCollateral(address token, address target, uint256 amount) internal returns (bool) {
        if (!_tryApprove(token, target, amount)) return false;
        try IStabilityReserve(target).depositCollateral(token, amount) {
            return true;
        } catch {
            _tryApprove(token, target, 0);
            return false;
        }
    }

    /// @dev ERC20 approve that never reverts: true only when the call succeeded and returned
    ///      true, or returned nothing from a contract (SafeERC20's own acceptance rule).
    function _tryApprove(address token, address spender, uint256 value) internal returns (bool) {
        return _tryTokenCall(token, IERC20.approve.selector, spender, value);
    }

    /// @dev `selector(account, value)` on an ERC20 (approve or transfer) that never reverts,
    ///      under the acceptance rule above.
    function _tryTokenCall(address token, bytes4 selector, address account, uint256 value) internal returns (bool ok) {
        assembly ("memory-safe") {
            let fmp := mload(0x40)
            mstore(0x00, selector)
            mstore(0x04, and(account, shr(96, not(0))))
            mstore(0x24, value)
            ok := call(gas(), token, 0, 0x00, 0x44, 0x00, 0x20)
            if iszero(and(ok, eq(mload(0x00), 1))) {
                ok := and(ok, and(iszero(returndatasize()), gt(extcodesize(token), 0)))
            }
            mstore(0x40, fmp)
        }
    }

    /// @notice If the vault has debt but no collateral, treat the remaining debt as bad debt
    /// @dev The debt is cleared from the vault and marked as socialised. The SurplusBuffer
    ///      (if configured) may later burn GSUSD from its reserve to offset the unbacked supply.
    function _handleBadDebt(address vaultOwner, bytes32 colId) internal {
        Vault storage vault = vaults[vaultOwner];
        if (vault.collateralAmount == 0 && vault.debtAmount > 0) {
            uint256 badDebt = vault.debtAmount;
            vault.debtAmount = 0;
            collateralTypes[colId].totalDebt -= badDebt;
            // Zero the normalised debt exactly. The previous
            // reduceDebt(getCurrentDebt(...)) round-trip left floor-rounding dust.
            stabilityModule.clearDebt(vaultOwner, colId);
            totalBadDebt += badDebt;

            // If SurplusBuffer is configured, let it absorb the bad debt by burning reserves.
            // Best effort, inside a try/catch: totalBadDebt is already recorded, and
            // retryBadDebtAbsorption lets anyone re-attempt it (see _absorbBadDebt).
            if (address(surplusBuffer) != address(0)) _absorbBadDebt(badDebt);

            // The bad-debt breaker: over the threshold the vault holds, whether or not a pause
            // is already in force. Bad debt arrives through emergencyLiquidate and
            // liquidateViaPool while paused as well, so a trip then extends the pause in force,
            // lapsed or not, rather than calling `_pause()` (which would revert and brick
            // bad-debt handling). Either way the window restarts now under a new pause number:
            // an unpause approved before the bad debt cannot lift the breaker's hold, and a
            // pause that had lapsed cannot be lifted by anyone straight after the trip.
            if (badDebtPauseThreshold > 0 && totalBadDebt > badDebtPauseThreshold) _pauseAnew();

            emit BadDebt(vaultOwner, badDebt);
        }
    }

    /// @notice Ask the buffer to absorb `amount` of bad debt and book what it burned.
    /// @dev The buffer burns the GSUSD itself and pays nothing back, so the absorption
    ///      is the fall in GSUSD supply across the call, capped at the outstanding bad debt so
    ///      a buffer that burns more than asked can never underflow totalBadDebt. No return
    ///      value is decoded. The try/catch is load-bearing: a buffer that reverts (repointed
    ///      without its VAULT_ROLE grant, say) must never revert liquidate, emergencyLiquidate
    ///      or liquidateViaPool, every path out of insolvency, at exactly the insolvency the
    ///      buffer exists to absorb. The bad debt stays booked and retryBadDebtAbsorption lets
    ///      anyone re-attempt it once the wiring is repaired.
    function _absorbBadDebt(uint256 amount) internal returns (uint256 absorbed) {
        uint256 supplyBefore = stablecoin.totalSupply();
        // totalBadDebt is lowered after this call, by the fall in supply the call caused:
        // measuring that fall is the point, so the write has to follow it. The buffer is set
        // by governance and every entry point that reaches here is nonReentrant.
        // slither-disable-next-line reentrancy-benign
        try surplusBuffer.absorbBadDebt(amount) {
            uint256 supplyAfter = stablecoin.totalSupply();
            if (supplyAfter < supplyBefore) {
                absorbed = Math.min(supplyBefore - supplyAfter, totalBadDebt);
                totalBadDebt -= absorbed;
            }
        } catch {
            emit BadDebtAbsorptionFailed(amount);
        }
    }

    // ========== StabilityPool Liquidation ==========

    /// @notice Liquidate using the StabilityPool's pooled GSUSD — no liquidator capital required
    /// @dev Anyone can trigger this. The pool's GSUSD covers the debt and receives the seized
    ///      collateral (minus a small keeper bounty to msg.sender). Requires `stabilityPool` to be set.
    /// @param vaultOwner Vault to liquidate
    /// @param debtToRepay Amount of debt to repay (0 = full liquidation)
    // Deliberately NOT whenNotPaused: a pause, the bad-debt breaker's
    // above all, used to switch the pool off at the very moment it exists for, leaving only
    // emergencyLiquidate and the caller's own GSUSD while the pool's sat idle. While the vault
    // is paused the pool path prices exactly as emergencyLiquidate does.
    function liquidateViaPool(address vaultOwner, uint256 debtToRepay) external nonReentrant {
        require(address(stabilityPool) != address(0), "StabilityPool not set");

        // The emergency price whenever the vault or the oracle is paused: the normal read
        // reverts while the oracle is paused, which left only emergencyLiquidate.
        // The seizure is booked after this price read. The read is the oracle, which reaches
        // its feeds by static call, and this entry point is nonReentrant; see the reentrancy
        // note above deposit. (What follows the later calls is covered in _finaliseVault.)
        // slither-disable-next-line reentrancy-no-eth
        (bytes32 colId, uint256 currentDebt, uint256 tokenPrice) =
            _requireLiquidatable(vaultOwner, paused() || oracle.paused());
        Vault storage vault = vaults[vaultOwner];
        CollateralType storage colType = collateralTypes[colId];

        if (debtToRepay == 0) debtToRepay = currentDebt;
        require(debtToRepay <= currentDebt, "Exceeds vault debt");

        uint8 decimals = IERC20Metadata(vault.collateralToken).decimals();
        uint256 decimalScale3 = 10 ** (18 - decimals);
        uint256 collateralToSeize;
        uint256 debtEquivalent;
        (debtToRepay, collateralToSeize, debtEquivalent) = _sizeSeizure(
            debtToRepay, currentDebt, vault.collateralAmount, tokenPrice, colType.liquidationPenalty, decimalScale3
        , underwaterDiscountPpm);

        // Pool must have strictly more GSUSD than it will actually absorb: the StabilityPool
        // rejects absorptions that would drain it to zero (P would reach 0 and break the
        // product-sum accounting). Checked after sizing, against the repayment the pool will
        // really make: an underwater vault repays less than its nominal debt, and checking
        // the nominal figure refused pools that could cover it.
        require(stabilityPool.getTotalDeposits() > debtToRepay, "Pool insufficient");

        // Keeper bounty: small cut of the penalty goes to the caller as gas compensation
        // Reuses liquidatorIncentiveShare but dampened (half) since keeper has no capital at risk
        uint256 totalPenalty = collateralToSeize - debtEquivalent;
        uint256 keeperBounty = Math.mulDiv(totalPenalty, liquidatorIncentiveShare / 2, PRECISION);

        uint256 principalRepaid = _applySeizure(vault, colType, currentDebt, debtToRepay, collateralToSeize);

        stabilityModule.reduceDebt(vaultOwner, colId, debtToRepay);

        // The seized gold goes straight from the silos to the pool and to the keeper, as the
        // direct path pays its liquidator: routing it through this address made an issuer
        // freeze of the vault stop the pool for good. Each leg pays
        // its own transfer fee and the pool credits what actually arrived, so nothing can be
        // overpaid. Unwired, the vault holds the gold and pays from its balance.
        address token = vault.collateralToken;
        _sendCollateral(token, address(stabilityPool), collateralToSeize - keeperBounty);
        stabilityPool.absorbLiquidationPrefunded(token, debtToRepay);

        // Burn the principal received from the pool and bank the fee.
        _settleGsusdPayment(debtToRepay, principalRepaid);

        // Keeper bounty paid in collateral token
        if (keeperBounty > 0) _sendCollateral(token, msg.sender, keeperBounty);

        _handleBadDebt(vaultOwner, colId);

        _finaliseVault(vaultOwner, colId);

        emit LiquidatedViaPool(vaultOwner, msg.sender, debtToRepay, collateralToSeize);
        _syncRegistry(vaultOwner);
    }

    // ========== Admin ==========

    function setOracle(address _oracle) external onlyRole(GOVERNANCE_ROLE) {
        require(_oracle != address(0), "Zero address");
        oracle = IGoldOracle(_oracle);
    }


    /// @notice Update the liquidator's share of liquidation penalties
    /// @param share Fraction of penalty going to liquidator (e.g. 600000 = 60%)
    function setLiquidatorIncentiveShare(uint256 share) external onlyRole(GOVERNANCE_ROLE) {
        require(share <= PRECISION, "Share exceeds 100%");
        liquidatorIncentiveShare = share;
    }

    /// @notice Set the smallest debt a vault may carry (100 to 10,000 GSUSD).
    /// @dev Raise it until the liquidator's share of the penalty on the smallest vault pays
    ///      for a liquidation at the chain's gas price; otherwise those vaults are never taken.
    function setMinDebt(uint256 value) external onlyRole(GOVERNANCE_ROLE) {
        require(value >= 100e18 && value <= 10_000e18, "Min debt out of range");
        minDebt = value;
        emit MinDebtUpdated(value);
    }

    /// @notice Set the discount at which an underwater vault's gold is sold (at most 5%).
    function setUnderwaterDiscount(uint256 ppm) external onlyRole(GOVERNANCE_ROLE) {
        require(ppm <= 50_000, "Discount exceeds 5%");
        underwaterDiscountPpm = ppm;
        emit UnderwaterDiscountUpdated(ppm);
    }

    /// @notice Set the per-block mint cap (0 disables the limit).
    /// @dev Caps blast radius of one-block exploits / mis-configurations. Expected
    ///      to be a multiple of the debt ceiling divided by a safety factor —
    ///      e.g., 1% of total ceiling per block. Raised via timelock.
    function setPerBlockMintCap(uint256 cap) external onlyRole(GOVERNANCE_ROLE) {
        perBlockMintCap = cap;
        emit PerBlockMintCapUpdated(cap);
    }

    /// @notice Set the origination fee in basis points. 0 disables it.
    /// @dev Requires a SurplusBuffer when non-zero. Without one, _settleGsusdPayment burns
    ///      the fee instead of banking it, and since the borrower's debt still rises by the
    ///      full amount, supply would fall short of debt and break the conservation
    ///      invariant the Foundry suite asserts.
    function setOriginationFeeBps(uint256 bps) external onlyRole(GOVERNANCE_ROLE) {
        require(bps <= MAX_ORIGINATION_FEE_BPS, "Exceeds max origination fee");
        require(bps == 0 || address(surplusBuffer) != address(0), "Buffer required");
        originationFeeBps = bps;
        emit OriginationFeeUpdated(bps);
    }

    /// @notice Exempt an address from the origination fee (protocol-owned vaults).
    function setOriginationFeeExempt(address account, bool exempt)
        external
        onlyRole(GOVERNANCE_ROLE)
    {
        require(account != address(0), "Zero address");
        originationFeeExempt[account] = exempt;
        emit OriginationFeeExemptSet(account, exempt);
    }

    /// @notice Point at the Gold Stability Reserve. address(0) sends all penalty gold to insurance.
    /// @dev An address without code is refused: the high-level call in _routeSurplus checks
    ///      for code before the try/catch can catch anything, so an EOA here made every
    ///      direct liquidation with a reserve share revert without a reason.
    function setStabilityReserve(address _reserve) external onlyRole(GOVERNANCE_ROLE) {
        if (_reserve != address(0)) {
            _requireVaultRoleGranted(_reserve, "Reserve has not granted VAULT_ROLE");
        }
        stabilityReserve = IStabilityReserve(_reserve);
        emit StabilityReserveUpdated(_reserve);
    }

    /// @notice Share of the protocol's penalty gold that funds the reserve, in bps.
    function setReservePenaltyShare(uint256 bps) external onlyRole(GOVERNANCE_ROLE) {
        require(bps <= 10000, "Exceeds 100%");
        reservePenaltyShareBps = bps;
        emit ReservePenaltyShareUpdated(bps);
    }

    /// @notice Configure the SurplusBuffer to receive fees and penalty collateral
    /// @dev Pass address(0) to disable and revert to legacy behaviour. Refused while an
    ///      origination fee is armed, for the conservation reason in setOriginationFeeBps.
    function setSurplusBuffer(address _buffer) external onlyRole(GOVERNANCE_ROLE) {
        require(
            _buffer != address(0) || originationFeeBps == 0,
            "Disable origination fee first"
        );
        // Same probe as setSiloFactory: a buffer that has not granted this vault
        // VAULT_ROLE degrades fee routing silently (try/catch burns the fee) and used
        // to brick bad-debt liquidations loudly. Refuse the miswire at wiring time,
        // when it is a one-line fix, not mid-insolvency behind a 48h timelock.
        if (_buffer != address(0)) {
            _requireVaultRoleGranted(_buffer, "Buffer has not granted VAULT_ROLE");
            // Bad debt absorption is booked from the fall in GSUSD supply, so the buffer must
            // burn what it absorbs. An older buffer that transferred it here would leave the
            // GSUSD stranded in this contract with nothing booked.
            bool burns = false;
            try ISurplusBuffer(_buffer).absorptionBurns() returns (bool b) {
                burns = b;
            } catch {
                burns = false; // no marker: the buffer predates burning what it absorbs
            }
            require(burns, "Buffer must burn absorptions");
        }
        surplusBuffer = ISurplusBuffer(_buffer);
    }

    /// @notice The probe every wiring setter runs: the target has code, so a call to it can
    ///         be caught at all (an EOA reserve made direct liquidations revert without a
    ///         reason), and it has granted this vault VAULT_ROLE.
    function _requireVaultRoleGranted(address target, string memory reason) internal view {
        require(target.code.length > 0, "Not a contract");
        require(IAccessControl(target).hasRole(EXTERNAL_VAULT_ROLE, address(this)), reason);
    }

    /// @notice Configure the StabilityPool used by liquidateViaPool()
    /// @dev Refuses a pool that has not granted this vault VAULT_ROLE, one that does not
    ///      declare the prefunded absorb path (absorbsPrefunded), and one that cannot report
    ///      its deposits (getTotalDeposits). The declaration's refusal is the error
    ///      PoolLacksPrefundedAbsorb when the pool answers false, and a revert without data
    ///      when the pool has no such function; a pool without getTotalDeposits reverts
    ///      without data as well. It is an error and not a reason string because this
    ///      contract is close to the code size limit; the deployment verifier names the
    ///      declaration check (wire:stabilityPool.absorbsPrefunded).
    function setStabilityPool(address _pool) external onlyRole(GOVERNANCE_ROLE) {
        if (_pool != address(0)) {
            _requireVaultRoleGranted(_pool, "Pool has not granted VAULT_ROLE");
            // liquidateViaPool hands the seized gold to the pool and then calls
            // absorbLiquidationPrefunded, with no try/catch. A pool that lacks that function
            // would make every pool liquidation revert until a further timelocked proposal
            // replaced it, so the pool must declare the path here, at wiring time. A pool
            // without the declaration reverts this read; one that answers false is refused.
            if (!IStabilityPool(_pool).absorbsPrefunded()) revert PoolLacksPrefundedAbsorb();
            // liquidateViaPool also reads the pool's total deposits before it sizes anything,
            // again with no try/catch. The read is made here for its revert alone: a pool
            // that cannot answer it is refused now, not at the first pool liquidation.
            // slither-disable-next-line unused-return
            IStabilityPool(_pool).getTotalDeposits();
        }
        stabilityPool = IStabilityPool(_pool);
    }


    /// @notice Point the vault at the VaultRegistry that lists every open vault for
    ///         liquidators and agents. Zero unwires it.
    /// @dev Governance only, behind the timelock. The registry never holds funds, the hook
    ///      that feeds it is best effort, and anyone can repair it from the vault's state with
    ///      VaultRegistry.sync, so a wrong address is an inconvenience, not a loss. A
    ///      non-contract is refused all the same, because it could never be a registry.
    function setVaultRegistry(address _registry) external onlyRole(GOVERNANCE_ROLE) {
        if (_registry != address(0)) {
            require(_registry.code.length > 0, "Registry must be a contract");
            require(IVaultRegistryProbe(_registry).vault() == address(this), "Registry serves another vault");
        }
        vaultRegistry = IVaultRegistry(_registry);
        emit VaultRegistryUpdated(_registry);
    }

    /// @notice Configure the SiloFactory for censorship-resistant collateral storage.
    /// @dev Governance only, behind the timelock. Every withdrawal and liquidation pulls
    ///      from whichever factory is wired at the time, so a factory that still holds
    ///      collateral cannot be replaced: its silos answer only to this vault, and the vault
    ///      would no longer ask them, stranding the gold and bricking every exit. The repoint
    ///      is therefore refused until the current factory is empty (unwiring with zero
    ///      included). The role check refuses the one misconfiguration that would reject
    ///      every deposit and liquidation the moment it took effect.
    function setSiloFactory(address _factory) external onlyRole(GOVERNANCE_ROLE) {
        if (address(siloFactory) != address(0)) {
            require(siloFactory.isEmpty(), "Current factory holds collateral");
        }
        if (_factory != address(0)) {
            // This contract is the custodian once it has taken a deposit unwired.
            require(!heldUnwired, "Current factory holds collateral");
            _requireVaultRoleGranted(_factory, "Factory has not granted VAULT_ROLE");
            // Deliberate interface probe: the revert is the signal.
            // slither-disable-next-line unused-return
            ISiloFactory(_factory).isEmpty();
        }
        siloFactory = ISiloFactory(_factory);
    }

    /// @notice Set the bad debt threshold that triggers an automatic pause (0 = disabled)
    function setBadDebtPauseThreshold(uint256 threshold) external onlyRole(GOVERNANCE_ROLE) {
        badDebtPauseThreshold = threshold;
    }

    /// @notice Withdraw accumulated surplus collateral (liquidation penalties) to a recipient
    /// @dev The vault itself is refused: paying itself would lower the surplus record while the
    ///      tokens stayed in the vault, uncounted.
    function withdrawSurplus(address token, address to, uint256 amount) external onlyRole(GOVERNANCE_ROLE) {
        require(to != address(0), "Zero address");
        require(to != address(this), "Self payment");
        require(amount <= surplusCollateral[token], "Exceeds surplus");
        surplusCollateral[token] -= amount;
        IERC20(token).safeTransfer(to, amount);
        emit SurplusWithdrawn(to, token, amount);
    }

    function pause() external onlyRole(GOVERNANCE_ROLE) {
        _pause();
    }

    /// @dev Shared by the pause family; one copy of the check keeps the bytecode small.
    function _requireGuardianOrGovernance() internal view {
        require(
            hasRole(GUARDIAN_ROLE, msg.sender) || hasRole(GOVERNANCE_ROLE, msg.sender),
            "Not guardian or governance"
        );
    }

    /// @notice Emergency pause — callable by guardian or governance without timelock delay
    function emergencyPause() external {
        _requireGuardianOrGovernance();
        _pause();
    }

    /// @notice Re-assert the pause in force: restart its 14 day window, so a live guardian can
    ///         hold a genuine incident without the pause lapsing to everyone first, or meet a
    ///         new one while paused. Every extension takes a new pauseEpoch, so an unpause
    ///         approved before it reverts "Different pause".
    function extendPause() external {
        _requireGuardianOrGovernance();
        _extendPause();
    }

    /// @notice Lift pause number `epoch` early. Governance only, through the timelock.
    /// @param epoch pauseEpoch() as read when the unpause was scheduled; a later pause,
    ///        extension or bad-debt breaker trip has another number, so an approval given
    ///        before it cannot lift it ("Different pause").
    function unpause(uint256 epoch) external onlyRole(GOVERNANCE_ROLE) {
        _unpauseAt(epoch);
    }

    /// @notice Grant guardian role — used once during deployment to wire the guardian multisig
    function grantGuardianRole(address guardian) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(guardian != address(0), "Zero address");
        _grantRole(GUARDIAN_ROLE, guardian);
    }

    /// @notice Transfer all governance power to the timelock and permanently remove deployer access
    /// @dev Should be called after full system setup. Irreversible.
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
