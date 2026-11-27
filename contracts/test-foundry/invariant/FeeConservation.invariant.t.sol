// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import "forge-std/Test.sol";
import "forge-std/StdInvariant.sol";

import {GoldVault} from "../../src/core/GoldVault.sol";
import {GoldOracle} from "../../src/core/GoldOracle.sol";
import {GoldStablecoin} from "../../src/core/GoldStablecoin.sol";
import {StabilityModule} from "../../src/core/StabilityModule.sol";
import {SurplusBuffer} from "../../src/core/SurplusBuffer.sol";
import {GoldStabilityReserve} from "../../src/core/GoldStabilityReserve.sol";

import {MockAggregatorV3} from "../../src/test/mocks/MockAggregatorV3.sol";
import {MockERC20} from "../../src/test/mocks/MockERC20.sol";
import {RevertingFeeBuffer} from "../harness/RevertingFeeBuffer.sol";

/// @notice Drives the vault with a LIVE stability fee and a time-advancing handler.
/// @dev The existing GoldVault invariant suite deliberately pins the fee at 0 and never
///      warps time, so no fuzzing has ever touched the fee paths. That was precisely the
///      blind spot the revenue work lives in: repay, all three liquidation paths and
///      redemption each split a payment into "burn the principal" and "bank the fee", and
///      none of that logic was reachable under the zero-fee suite.
///
///      The headline result: `totalSupply == aggregate principal debt` now holds WITH FEES
///      LIVE. Banked fee GSUSD was already in circulation before it reached the buffer, so
///      routing it there does not change supply; only the burn does, and the burn is now
///      exactly the principal retired.
///
///      Before the revenue work this was false under fees. liquidation and redemption
///      burned the whole fee-inclusive payment, so supply fell FURTHER than principal and
///      the identity drifted by the destroyed fee on every such exit. The zero-fee suite
///      could never see it, which is why the identity was documented as relying on
///      "zero fee accrual" rather than on correct settlement.
///
///      Getting this wrong once was instructive: asserting
///      `supply == debt + banked` fails by exactly the fee on every repay, because the
///      banked wei is counted twice - once inside supply, once in the buffer tally.
///
///      The suite runs three times, once per state the fee destination can be in: a
///      healthy buffer, no buffer at all, and a buffer that refuses every deposit. The
///      vault and the reserve both promise that a missing or broken buffer changes where a
///      fee goes and nothing else, so every accounting identity below must hold in all
///      three. The handler also crashes the gold price and liquidates, including vaults
///      whose gold is worth less than their principal, so the bad debt booking is fuzzed
///      with fees live: supply must equal principal debt plus bad debt throughout.
abstract contract FeeConservationInvariantBase is StdInvariant, Test {
    enum BufferMode {
        Healthy,
        Unset,
        Reverting
    }

    GoldVault internal vault;
    GoldOracle internal oracle;
    GoldStablecoin internal stablecoin;
    StabilityModule internal stabilityModule;
    SurplusBuffer internal buffer;
    GoldStabilityReserve internal reserve;

    MockERC20 internal paxg;
    MockERC20 internal xaut;
    MockAggregatorV3 internal paxgFeed;
    MockAggregatorV3 internal xautFeed;

    FeeHandler internal handler;
    bytes32 internal paxgId;

    int256 internal constant GOLD_PRICE = 2000 * 1e8;
    /// @dev 3% annual. Non-zero is the entire point of this suite.
    uint256 internal constant FEE_BPS = 300;

    /// @dev Which state the fee destination is in for this run of the suite.
    function _bufferMode() internal pure virtual returns (BufferMode);

    function setUp() public {
        paxg = new MockERC20("Pax Gold", "PAXG", 18);
        xaut = new MockERC20("Tether Gold", "XAUT", 6);

        paxgFeed = new MockAggregatorV3(8);
        xautFeed = new MockAggregatorV3(8);
        _pushPrice(paxgFeed, GOLD_PRICE);
        _pushPrice(xautFeed, GOLD_PRICE);

        oracle = new GoldOracle(
            address(paxgFeed),
            address(xautFeed),
            address(paxg),
            address(xaut),
            90000
        );
        oracle.getTokenPrice(address(paxg));
        oracle.getTokenPrice(address(xaut));

        stablecoin = new GoldStablecoin();
        stabilityModule = new StabilityModule();
        vault = new GoldVault(address(oracle), address(stablecoin), address(stabilityModule));
        buffer = new SurplusBuffer(address(stablecoin));

        stablecoin.grantRole(stablecoin.MINTER_ROLE(), address(vault));
        stabilityModule.grantRole(stabilityModule.VAULT_ROLE(), address(vault));
        buffer.grantRole(buffer.VAULT_ROLE(), address(vault));
        BufferMode mode = _bufferMode();
        address wired = mode == BufferMode.Healthy
            ? address(buffer)
            : mode == BufferMode.Reverting ? address(new RevertingFeeBuffer()) : address(0);
        if (wired != address(0)) vault.setSurplusBuffer(wired);

        // The Gold Stability Reserve: the below-peg floor. It holds assets and owes
        // nothing, so the swap must leave supply == Σ principal exactly as it found it.
        reserve = new GoldStabilityReserve(address(stablecoin), address(oracle));
        buffer.grantRole(buffer.VAULT_ROLE(), address(reserve));
        reserve.grantRole(reserve.VAULT_ROLE(), address(vault));
        reserve.setSurplusBuffer(wired);
        reserve.setAssetConfig(address(paxg), true, 0, 1_000_000);
        GoldStabilityReserve.SpreadStep[] memory steps = new GoldStabilityReserve.SpreadStep[](2);
        steps[0] = GoldStabilityReserve.SpreadStep({coverageAtLeastPpm: 100_000, spreadPpm: 5_000});
        steps[1] = GoldStabilityReserve.SpreadStep({coverageAtLeastPpm: 20_000, spreadPpm: 12_500});
        reserve.setSpreadCurve(steps, 20_000);
        vault.setStabilityReserve(address(reserve));
        vault.setReservePenaltyShare(4000);

        vault.addCollateralType(address(paxg), 1_500_000, 1_100_000, 50_000, 1_000_000_000e18);
        paxgId = keccak256(abi.encodePacked(address(paxg)));
        stabilityModule.initCollateral(paxgId, FEE_BPS);

        handler = new FeeHandler(vault, stablecoin, paxg, paxgFeed, xautFeed, oracle, reserve, buffer);
        // The handler fuzzes originationFeeBps across 0..MAX so the mint-side split is
        // exercised in both regimes rather than pinned at the shipping default of 0.
        vault.grantRole(vault.GOVERNANCE_ROLE(), address(handler));
        targetContract(address(handler));

        bytes4[] memory selectors = new bytes4[](9);
        selectors[0] = FeeHandler.depositAndMint.selector;
        selectors[1] = FeeHandler.repaySome.selector;
        selectors[2] = FeeHandler.advanceTime.selector;
        selectors[3] = FeeHandler.repayAll.selector;
        selectors[4] = FeeHandler.setOriginationFee.selector;
        selectors[5] = FeeHandler.transferGsusd.selector;
        selectors[6] = FeeHandler.seedReserve.selector;
        selectors[7] = FeeHandler.swapGsusdForGold.selector;
        selectors[8] = FeeHandler.crashAndLiquidate.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    /// @notice Supply tracks outstanding principal exactly, even with fees accruing.
    ///         The burn is the principal and nothing but the principal. Bad debt is
    ///         principal that was written off with its GSUSD still in circulation, so it
    ///         is the one other term: booking more than the principal lost, or burning a
    ///         fee on a vault that lost principal, breaks this by that amount.
    ///
    ///         With no buffer, or one that refuses the deposit, the vault burns a fee it
    ///         cannot bank (GoldVault._settleGsusdPayment), so supply sits below the
    ///         identity by the fees forfeited and can never sit above it.
    function invariant_supplyEqualsAggregateDebtUnderFees() public view {
        (, , , , , uint256 totalDebt, ) = vault.collateralTypes(paxgId);
        if (_bufferMode() == BufferMode.Healthy) {
            assertEq(
                stablecoin.totalSupply(),
                totalDebt + vault.totalBadDebt(),
                "supply != principal debt + bad debt (fee was over- or under-burned)"
            );
        } else {
            assertLe(
                stablecoin.totalSupply(),
                totalDebt + vault.totalBadDebt(),
                "supply above principal debt + bad debt (unbacked GSUSD)"
            );
        }
    }

    /// @notice A liquidation that could not recover a vault's principal leaves the
    ///         distance between supply and (principal debt + bad debt) exactly where it
    ///         was, whatever state the buffer is in: the payment is all principal, so
    ///         there is no fee to burn, and the bad debt booked is the principal lost.
    function invariant_principalLossBooksExactlyThePrincipalLost() public view {
        assertEq(handler.gapMovedOnPrincipalLoss(), 0, "a principal-loss liquidation moved supply against debt + bad debt");
    }

    /// @notice A liquidation that could not recover a vault's principal recognises no
    ///         stability fee: nothing reaches the buffer's revenue counter from it.
    function invariant_noFeeBankedOnAPrincipalLoss() public view {
        assertEq(handler.feeBankedOnPrincipalLoss(), 0, "a fee was banked on a vault that lost principal");
    }

    /// @notice Banked revenue is real, withdrawable GSUSD, not an accounting entry.
    function invariant_bankedRevenueIsFullyBacked() public view {
        assertGe(
            stablecoin.balanceOf(address(buffer)),
            buffer.gsusdBalance(),
            "buffer accounting exceeds its actual GSUSD"
        );
    }

    /// @notice Every origination fee charged reached the buffer. Nothing was minted to the
    ///         vault and left stranded there, and nothing was burned instead of banked -
    ///         either would show up as supply != debt, but this localises the failure to
    ///         the mint path rather than leaving it to the aggregate identity.
    function invariant_originationFeesAreBanked() public view {
        // Without a working buffer the vault refuses or forfeits the charge instead.
        if (_bufferMode() != BufferMode.Healthy) return;
        assertGe(
            buffer.totalFeesReceived(),
            vault.totalOriginationFees(),
            "origination fee charged but not banked"
        );
    }

    /// @notice The reserve can never mint. This is the property that keeps gold/USD
    ///         risk with borrowers; if it ever fails, the protocol has become an issuer.
    function invariant_reserveHoldsNoMinterRole() public view {
        assertFalse(stablecoin.hasRole(stablecoin.MINTER_ROLE(), address(reserve)), "reserve can mint GSUSD");
    }

    /// @notice What the reserve says it holds, it holds.
    function invariant_reserveLedgerBacked() public view {
        assertGe(paxg.balanceOf(address(reserve)), reserve.collateralBalance(address(paxg)), "reserve gold ledger exceeds balance");
        assertGe(stablecoin.balanceOf(address(reserve)), reserve.gsusdInventory(), "reserve GSUSD ledger exceeds balance");
    }

    /// @notice The reserve's GSUSD is inside supply and was never burned: every GSUSD it
    ///         took in is either held or was routed to insurance as spread. A spread the
    ///         buffer did not take stays in inventory and is not counted as paid.
    function invariant_swapsNeverBurn() public view {
        assertEq(
            reserve.totalGsusdReceived(),
            reserve.gsusdInventory() + reserve.totalSpreadPaid() + reserve.totalGsusdWithdrawn(),
            "GSUSD received by the reserve is unaccounted for"
        );
    }

    /// @notice The vault never sits on GSUSD between calls. Fee wei is minted to the vault
    ///         and forwarded within the same transaction; a balance here means a settle
    ///         path returned early and left value in limbo.
    function invariant_vaultHoldsNoGsusd() public view {
        assertEq(stablecoin.balanceOf(address(vault)), 0, "vault retained GSUSD between calls");
    }

    /// @notice The opening sequence every run starts with (see FeeHandler) went as the
    ///         contracts promise: both vaults opened, the repayment, the seed and the swap
    ///         settled, and the liquidation at 80% took the vault at a loss of principal.
    function invariant_openingSequenceBehaves() public view {
        assertEq(handler.openingFaults(), 0, "the opening mint, repayment, swap or liquidation misbehaved");
    }

    /// @notice Anti-vacuity. The value of this whole suite is that fees are LIVE, so if a
    ///         run somehow completes without accruing or banking any, the passing result
    ///         above is meaningless and must not be reported as green. The handler's opening
    ///         sequence performs each action counted here, so the outcome does not depend on
    ///         what the random sequence happens to draw.
    function afterInvariant() public view {
        assertGt(handler.mintCount(), 0, "no vault was ever opened - suite is vacuous");
        assertGt(handler.warpCount(), 0, "time never advanced - no fee could accrue");
        if (_bufferMode() == BufferMode.Healthy) {
            assertGt(buffer.totalFeesReceived(), 0, "no fee was ever banked - split untested");
        } else {
            assertEq(buffer.totalFeesReceived(), 0, "a fee reached a buffer that is not wired");
            assertEq(reserve.totalSpreadPaid(), 0, "a spread was counted as paid with no buffer to take it");
        }
        assertGt(handler.swapCount(), 0, "no stability swap ever executed - the floor is untested");
        assertEq(handler.vaultTouchedBySwap(), 0, "a stability swap altered a borrower vault");
        assertGt(handler.liquidationCount(), 0, "no liquidation ever executed - the seizure split is untested");
        assertGt(handler.principalLossCount(), 0, "no liquidation lost principal - the bad debt booking is untested");
    }

    function _pushPrice(MockAggregatorV3 feed, int256 price) internal {
        feed.setLatestRoundData(1, price, block.timestamp, block.timestamp, 1);
    }
}

contract FeeConservationInvariantTest is FeeConservationInvariantBase {
    function _bufferMode() internal pure override returns (BufferMode) {
        return BufferMode.Healthy;
    }
}

contract FeeConservationNoBufferInvariantTest is FeeConservationInvariantBase {
    function _bufferMode() internal pure override returns (BufferMode) {
        return BufferMode.Unset;
    }
}

contract FeeConservationRevertingBufferInvariantTest is FeeConservationInvariantBase {
    function _bufferMode() internal pure override returns (BufferMode) {
        return BufferMode.Reverting;
    }
}

/// @notice Minimal fee-aware handler. Unlike VaultHandler it DOES advance time, which is
///         the only way stability fees accrue and therefore the only way the burn/bank
///         split is exercised at all.
contract FeeHandler is Test {
    GoldVault internal immutable vault;
    GoldStablecoin internal immutable stablecoin;
    MockERC20 internal immutable paxg;
    MockAggregatorV3 internal immutable paxgFeed;
    MockAggregatorV3 internal immutable xautFeed;
    GoldOracle internal immutable oracle;
    GoldStabilityReserve internal immutable reserve;
    SurplusBuffer internal immutable buffer;

    address[] internal actors;
    /// @dev Pays for every liquidation out of its own, heavily collateralised vault, so
    ///      the GSUSD it spends is inside the supply identity like everyone else's.
    address internal constant LIQUIDATOR = address(0x11CC);
    int256 internal constant NORMAL_PRICE = 2000 * 1e8;

    /// @dev Ghosts backing afterInvariant's anti-vacuity assertions.
    uint256 public mintCount;
    uint256 public warpCount;
    uint256 public swapCount;
    /// @dev Incremented if any swap changes any actor's vault. Must stay zero.
    uint256 public vaultTouchedBySwap;
    uint256 public liquidationCount;
    /// @dev Liquidations of a vault whose gold was worth less than its principal.
    uint256 public principalLossCount;
    /// @dev Fee revenue the buffer recorded during such a liquidation. Must stay zero.
    uint256 public feeBankedOnPrincipalLoss;
    /// @dev How far such liquidations moved supply against principal debt plus bad debt,
    ///      net of what the buffer burned to absorb. Must stay zero.
    uint256 public gapMovedOnPrincipalLoss;

    /// @dev Steps of the opening sequence (below) that did not go as the contracts promise.
    ///      Must stay zero.
    uint256 public openingFaults;
    bool internal opened;

    constructor(
        GoldVault _vault,
        GoldStablecoin _stablecoin,
        MockERC20 _paxg,
        MockAggregatorV3 _paxgFeed,
        MockAggregatorV3 _xautFeed,
        GoldOracle _oracle,
        GoldStabilityReserve _reserve,
        SurplusBuffer _buffer
    ) {
        buffer = _buffer;
        vault = _vault;
        stablecoin = _stablecoin;
        paxg = _paxg;
        paxgFeed = _paxgFeed;
        xautFeed = _xautFeed;
        oracle = _oracle;
        reserve = _reserve;
        for (uint256 i = 0; i < 3; i++) {
            actors.push(address(uint160(uint256(keccak256(abi.encodePacked("fee-actor", i))))));
        }
    }

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    /// @dev Keeps the feeds fresh so the 25h staleness bound never trips mid-run.
    function _refreshFeeds() internal {
        paxgFeed.setLatestRoundData(1, 2000 * 1e8, block.timestamp, block.timestamp, 1);
        xautFeed.setLatestRoundData(1, 2000 * 1e8, block.timestamp, block.timestamp, 1);
    }

    // ------------------------------------------------------------------ opening sequence

    /// @dev Runs once, before the first action of every run. The suite's coverage checks
    ///      (afterInvariant) require each run to open a vault, advance time, bank a fee,
    ///      swap against the reserve, liquidate, and liquidate at a loss of principal. Left
    ///      to the random sequence alone, roughly one run in thirty thousand drew no
    ///      liquidation that lost principal, or none at all, in its 200 calls, and the suite
    ///      failed for coverage, under whichever invariant was being run, with no fault in
    ///      the contracts. This sequence performs each required action through the same
    ///      entry points the random actions use, so every run exercises all of them whatever
    ///      the fuzzer draws next, and the checks stay as strict as they were.
    modifier afterOpening() {
        if (!opened) {
            opened = true;
            _open();
        }
        _;
    }

    function _open() internal {
        address borrower = actors[0];
        address doomed = actors[1];
        _refreshFeeds();

        // Two vaults at the normal price: 200% and a little over the 150% minimum.
        _openVault(borrower, 100e18, 100_000e18);
        _openVault(doomed, 10e18, 13_000e18);

        // A month passes, so both owe a stability fee.
        vm.warp(block.timestamp + 30 days);
        warpCount++;
        _refreshFeeds();

        // A partial repayment realises part of that fee: banked with a working buffer,
        // burned without one.
        vm.startPrank(borrower);
        stablecoin.approve(address(vault), type(uint256).max);
        try vault.repay(10_000e18) {} catch {
            openingFaults++;
        }
        vm.stopPrank();

        // The reserve is funded and sells gold for GSUSD.
        paxg.mint(borrower, 50e18);
        vm.startPrank(borrower);
        paxg.approve(address(reserve), type(uint256).max);
        try reserve.seedCollateral(address(paxg), 50e18) {} catch {
            openingFaults++;
        }
        vm.stopPrank();
        uint256 swapsBefore = swapCount;
        _swap(borrower, 1_000e18);
        if (swapCount == swapsBefore) openingFaults++;

        // Gold falls until the second vault's gold is worth 80% of its debt, less than its
        // principal: the liquidation takes all the gold and books the principal lost.
        uint256 lossesBefore = principalLossCount;
        _crashAndLiquidate(doomed, 800_000);
        if (principalLossCount == lossesBefore) openingFaults++;
    }

    function _openVault(address actor, uint256 collateral, uint256 debt) internal {
        paxg.mint(actor, collateral);
        vm.startPrank(actor);
        paxg.approve(address(vault), type(uint256).max);
        try vault.deposit(address(paxg), collateral) {
            try vault.mint(debt) {
                mintCount++;
            } catch {
                openingFaults++;
            }
        } catch {
            openingFaults++;
        }
        vm.stopPrank();
    }

    // ------------------------------------------------------------------ random actions

    function depositAndMint(uint256 seed, uint256 collateral, uint256 debt) external afterOpening {
        address actor = _actor(seed);
        collateral = bound(collateral, 1e18, 500e18);
        // 2000/oz and a 150% floor: cap the mint well inside the ratio.
        debt = bound(debt, 100e18, (collateral * 2000) / 2);

        _refreshFeeds();
        paxg.mint(actor, collateral);
        vm.startPrank(actor);
        paxg.approve(address(vault), type(uint256).max);
        try vault.deposit(address(paxg), collateral) {
            try vault.mint(debt) {
                mintCount++;
            } catch {}
        } catch {}
        vm.stopPrank();
    }

    function repaySome(uint256 seed, uint256 amount) external afterOpening {
        address actor = _actor(seed);
        uint256 owed = vault.getVaultCurrentDebt(actor);
        if (owed == 0) return;
        amount = bound(amount, 1, owed);

        _refreshFeeds();
        vm.startPrank(actor);
        stablecoin.approve(address(vault), type(uint256).max);
        try vault.repay(amount) {} catch {}
        vm.stopPrank();
    }

    /// @dev Overshoots deliberately: the vault caps at the true debt, and this is
    ///      the only way to fully close a position whose debt accrues every second.
    function repayAll(uint256 seed) external afterOpening {
        address actor = _actor(seed);
        uint256 owed = vault.getVaultCurrentDebt(actor);
        if (owed == 0) return;
        uint256 quote = (owed * 1001) / 1000;
        if (stablecoin.balanceOf(actor) < quote) return;

        _refreshFeeds();
        vm.startPrank(actor);
        stablecoin.approve(address(vault), type(uint256).max);
        try vault.repay(quote) {} catch {}
        vm.stopPrank();
    }

    /// @dev The whole point: without this no fee ever accrues and the split is dead code.
    function advanceTime(uint256 secondsToAdvance) external afterOpening {
        secondsToAdvance = bound(secondsToAdvance, 1 hours, 30 days);
        vm.warp(block.timestamp + secondsToAdvance);
        warpCount++;
        _refreshFeeds();
    }

    /// @dev Fuzzes the mint-side charge across its entire legal range, zero included, so
    ///      the identity is proven under a changing fee rather than one fixed setting.
    function setOriginationFee(uint256 bps) external afterOpening {
        bps = bound(bps, 0, vault.MAX_ORIGINATION_FEE_BPS());
        try vault.setOriginationFeeBps(bps) {} catch {}
    }

    /// @dev With an origination fee live a borrower receives less GSUSD than they owe, so
    ///      no actor can close alone. Real borrowers buy the shortfall on the secondary
    ///      market; without modelling that, repayAll would go permanently unreachable and
    ///      silently drop the full-close path out of the run.
    function transferGsusd(uint256 fromSeed, uint256 toSeed, uint256 amount) external afterOpening {
        address from = _actor(fromSeed);
        address to = _actor(toSeed);
        uint256 bal = stablecoin.balanceOf(from);
        if (from == to || bal == 0) return;
        amount = bound(amount, 1, bal);
        vm.prank(from);
        stablecoin.transfer(to, amount);
    }

    /// @dev Fund the floor. Permissionless on the real contract; here any actor may seed.
    function seedReserve(uint256 seed, uint256 amount) external afterOpening {
        address actor = _actor(seed);
        amount = bound(amount, 1e18, 200e18);
        _refreshFeeds();
        paxg.mint(actor, amount);
        vm.startPrank(actor);
        paxg.approve(address(reserve), type(uint256).max);
        try reserve.seedCollateral(address(paxg), amount) {} catch {}
        vm.stopPrank();
    }

    /// @dev The swap. Snapshots every actor's vault first and counts any change: the
    ///      product guarantee is that a stranger's swap cannot alter a borrower's position,
    ///      and this is where that guarantee is fuzzed rather than asserted.
    function swapGsusdForGold(uint256 seed, uint256 amount) external afterOpening {
        address actor = _actor(seed);
        uint256 bal = stablecoin.balanceOf(actor);
        if (bal == 0) return;
        _swap(actor, bound(amount, 1, bal));
    }

    function _swap(address actor, uint256 amount) internal {
        bytes32[] memory before = new bytes32[](actors.length);
        for (uint256 i = 0; i < actors.length; i++) before[i] = _vaultHash(actors[i]);

        _refreshFeeds();
        vm.startPrank(actor);
        stablecoin.approve(address(reserve), type(uint256).max);
        try reserve.swapGsusdForGold(address(paxg), amount, 0) returns (uint256 goldOut) {
            if (goldOut > 0) swapCount++;
        } catch {}
        vm.stopPrank();

        for (uint256 i = 0; i < actors.length; i++) {
            if (_vaultHash(actors[i]) != before[i]) vaultTouchedBySwap++;
        }
    }

    /// @dev Gold falls until `actor`'s vault is between 30% and 115% collateralised, the
    ///      vault is liquidated in full by a funded liquidator, and gold recovers. Below
    ///      100% the seizure takes all the gold against part of the debt; where the gold is
    ///      worth less than the principal, principal is lost and bad debt is booked.
    function crashAndLiquidate(uint256 seed, uint256 ratioSeed) external afterOpening {
        _crashAndLiquidate(_actor(seed), bound(ratioSeed, 300_000, 1_150_000));
    }

    function _crashAndLiquidate(address actor, uint256 ratioPpm) internal {
        (, uint256 collateral, uint256 principal) = vault.vaults(actor);
        uint256 owed = vault.getVaultCurrentDebt(actor);
        if (owed == 0 || collateral == 0) return;

        _refreshFeeds();
        if (!_fundLiquidator(owed)) return;

        // Price (8 decimals) at which the gold is worth `ratio` of the debt.
        int256 target = int256((owed * ratioPpm / 1e6) * 1e8 / collateral);
        if (target <= 0 || target >= NORMAL_PRICE) return;
        _walk(target);

        bool losesPrincipal = collateral * uint256(target) / 1e8 < principal;
        uint256 feesBefore = buffer.totalFeesReceived();
        int256 gapBefore = _supplyGap();
        vm.startPrank(LIQUIDATOR);
        stablecoin.approve(address(vault), type(uint256).max);
        try vault.liquidate(actor, 0) {
            liquidationCount++;
            if (losesPrincipal) {
                principalLossCount++;
                feeBankedOnPrincipalLoss += buffer.totalFeesReceived() - feesBefore;
                int256 moved = _supplyGap() - gapBefore;
                gapMovedOnPrincipalLoss += uint256(moved < 0 ? -moved : moved);
            }
        } catch {}
        vm.stopPrank();

        _walk(NORMAL_PRICE);
    }

    /// @dev Supply less (principal debt + bad debt). An absorption burns supply and lowers
    ///      bad debt by the same amount, so it does not move this.
    function _supplyGap() internal view returns (int256) {
        (, , , , , uint256 totalDebt, ) = vault.collateralTypes(keccak256(abi.encodePacked(address(paxg))));
        return int256(stablecoin.totalSupply()) - int256(totalDebt + vault.totalBadDebt());
    }

    /// @dev Top the liquidator up to `amount` GSUSD from its own vault at the normal price.
    function _fundLiquidator(uint256 amount) internal returns (bool) {
        uint256 held = stablecoin.balanceOf(LIQUIDATOR);
        if (held >= amount) return true;
        // Twice the shortfall covers any origination fee; 100 ounces per GSUSD of debt keeps
        // this vault far above every price the crash can reach.
        uint256 toMint = (amount - held) * 2 + 100e18;
        uint256 gold = toMint / 10;
        paxg.mint(LIQUIDATOR, gold);
        vm.startPrank(LIQUIDATOR);
        paxg.approve(address(vault), type(uint256).max);
        bool ok;
        try vault.deposit(address(paxg), gold) {
            try vault.mint(toMint) {
                ok = true;
            } catch {}
        } catch {}
        vm.stopPrank();
        return ok && stablecoin.balanceOf(LIQUIDATOR) >= amount;
    }

    /// @dev Move both feeds to `target` in steps under the oracle's deviation bound.
    function _walk(int256 target) internal {
        int256 cur = int256(oracle.getLastKnownPrice(address(paxg)));
        while (cur != target) {
            int256 next = target < cur ? cur * 91 / 100 : cur * 109 / 100;
            if ((target < cur && next < target) || (target > cur && next > target)) next = target;
            if (next == cur) next = target;
            paxgFeed.setLatestRoundData(1, next, block.timestamp, block.timestamp, 1);
            xautFeed.setLatestRoundData(1, next, block.timestamp, block.timestamp, 1);
            oracle.getTokenPrice(address(paxg));
            cur = next;
        }
    }

    function _vaultHash(address owner) internal view returns (bytes32) {
        (address token, uint256 collateral, uint256 debt) = vault.vaults(owner);
        return keccak256(abi.encode(token, collateral, debt));
    }
}
