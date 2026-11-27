// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import "forge-std/Test.sol";
import "forge-std/StdInvariant.sol";

import {GoldVault} from "../../src/core/GoldVault.sol";
import {GoldOracle} from "../../src/core/GoldOracle.sol";
import {GoldStablecoin} from "../../src/core/GoldStablecoin.sol";
import {StabilityModule} from "../../src/core/StabilityModule.sol";
import {VaultRegistry} from "../../src/core/VaultRegistry.sol";

import {MockAggregatorV3} from "../../src/test/mocks/MockAggregatorV3.sol";
import {MockERC20} from "../../src/test/mocks/MockERC20.sol";

import {VaultHandler} from "./handlers/VaultHandler.sol";

/// @title GoldVault invariant suite
/// @notice Drives the vault through random deposit/mint/repay/withdraw/liquidate
///         sequences and asserts core CDP invariants hold at every step.
///
/// @dev The handler intentionally does NOT advance time, so stability fees do
///      not accrue during this run. That lets us assert the strict identity
///      `sum(vault.debtAmount) == collateralType.totalDebt`. Time-advancing
///      invariants live in a separate test (see fuzz/ StabilityModule tests)
///      because fee accrual introduces a tolerance in the identity.
contract GoldVaultInvariantTest is StdInvariant, Test {
    GoldVault internal vault;
    VaultRegistry internal registry;
    GoldOracle internal oracle;
    GoldStablecoin internal stablecoin;
    StabilityModule internal stabilityModule;

    MockERC20 internal paxg;
    MockAggregatorV3 internal paxgFeed;
    MockAggregatorV3 internal xautFeed;
    MockERC20 internal xaut;

    VaultHandler internal handler;

    bytes32 internal paxgId;

    // $2000/oz gold, 8 decimals
    int256 internal constant GOLD_PRICE = 2000 * 1e8;
    uint256 internal constant MINT_CAP = 2_000_000e18;

    function setUp() public {
        // --- Tokens ---
        paxg = new MockERC20("Pax Gold", "PAXG", 18);
        xaut = new MockERC20("Tether Gold", "XAUT", 6);

        // --- Chainlink feeds ---
        paxgFeed = new MockAggregatorV3(8);
        xautFeed = new MockAggregatorV3(8);
        _pushPrice(paxgFeed, GOLD_PRICE);
        _pushPrice(xautFeed, GOLD_PRICE);

        // --- Oracle ---
        oracle = new GoldOracle(
            address(paxgFeed),
            address(xautFeed),
            address(paxg),
            address(xaut),
            3600 // 1 hour staleness
        );
        // Seed lastKnown prices so circuit breaker has a reference
        oracle.getTokenPrice(address(paxg));
        oracle.getTokenPrice(address(xaut));

        // --- Core ---
        stablecoin = new GoldStablecoin();
        stabilityModule = new StabilityModule();
        vault = new GoldVault(address(oracle), address(stablecoin), address(stabilityModule));

        // Wire roles
        stablecoin.grantRole(stablecoin.MINTER_ROLE(), address(vault));
        stabilityModule.grantRole(stabilityModule.VAULT_ROLE(), address(vault));

        // Register PAXG as collateral (150% min, 110% liq, 5% penalty, huge ceiling)
        vault.addCollateralType(
            address(paxg),
            1_500_000,
            1_100_000,
            50_000,
            1_000_000_000e18
        );

        // Zero annual fee for invariant stability
        paxgId = keccak256(abi.encodePacked(address(paxg)));
        stabilityModule.initCollateral(paxgId, 0);

        // --- Registry: the on-chain list of open vaults, fed by the vault's hook ---
        registry = new VaultRegistry(address(vault));
        vault.setVaultRegistry(address(registry));
        // --- Handler ---
        handler = new VaultHandler(vault, stablecoin, paxg, paxgFeed, xautFeed);

        // Only call handler functions during invariant fuzzing
        targetContract(address(handler));

        // A per-block mint cap that binds: one actor can draw up to 1,000,000 GSUSD in a
        // call, so a block fills after a few mints and frees room only as they are repaid.
        vault.setPerBlockMintCap(MINT_CAP);

        bytes4[] memory selectors = new bytes4[](6);
        selectors[0] = VaultHandler.deposit.selector;
        selectors[1] = VaultHandler.withdraw.selector;
        selectors[2] = VaultHandler.mint.selector;
        selectors[3] = VaultHandler.repay.selector;
        selectors[4] = VaultHandler.liquidate.selector;
        selectors[5] = VaultHandler.nextBlock.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    // ==================================================================
    // Invariants
    // ==================================================================

    /// @notice The registry lists exactly the actors whose vaults hold collateral or debt,
    ///         whatever sequence of deposits, withdrawals, mints, repayments and
    ///         liquidations produced that state.
    function invariant_registryListsExactlyOpenVaults() public view {
        address[] memory actors = handler.getActors();
        uint256 open = 0;
        for (uint256 i = 0; i < actors.length; i++) {
            (, uint256 collateral, uint256 debt) = vault.vaults(actors[i]);
            bool isOpen = collateral > 0 || debt > 0;
            if (isOpen) open++;
            assertEq(registry.isVaultOwner(actors[i]), isOpen, "registry membership differs from the vault");
        }
        assertEq(registry.vaultOwnerCount(), open, "registry lists an owner outside the actor set");
    }

    /// @notice Per-collateral-type accounting: sum of vault debts equals
    ///         the aggregate stored on the collateral type.
    function invariant_debtAccountingMatchesAggregate() public view {
        uint256 sumOfVaultDebts;
        address[] memory actors = handler.getActors();
        for (uint256 i = 0; i < actors.length; i++) {
            (, , uint256 debt) = vault.vaults(actors[i]);
            sumOfVaultDebts += debt;
        }

        (, , , , , uint256 totalDebt,) = vault.collateralTypes(paxgId);
        assertEq(sumOfVaultDebts, totalDebt, "sum(vault.debt) != collateralType.totalDebt");
    }

    /// @notice Debt ceiling is never breached.
    function invariant_debtCeilingRespected() public view {
        (, , , , uint256 debtCeiling, uint256 totalDebt,) = vault.collateralTypes(paxgId);
        assertLe(totalDebt, debtCeiling, "totalDebt exceeded debtCeiling");
    }

    /// @notice Every vault is either empty or holds at least MIN_DEBT principal.
    function invariant_minDebtFloorRespected() public view {
        uint256 minDebt = vault.minDebt();
        address[] memory actors = handler.getActors();
        for (uint256 i = 0; i < actors.length; i++) {
            (, , uint256 debt) = vault.vaults(actors[i]);
            if (debt != 0) {
                assertGe(debt, minDebt, "non-zero vault below MIN_DEBT");
            }
        }
    }

    /// @notice With zero stability fee, total GSUSD supply equals the aggregate
    ///         of outstanding principal debt. Fees would break this identity,
    ///         which is why we isolate this check to the fee-less scenario.
    function invariant_supplyEqualsAggregateDebt() public view {
        (, , , , , uint256 totalDebt,) = vault.collateralTypes(paxgId);
        assertEq(stablecoin.totalSupply(), totalDebt, "totalSupply != aggregate debt");
    }

    // ==================================================================
    // Conservation invariants - catch any leak where state and balances
    // disagree, or where a flow bypasses the expected bookkeeping path.
    // ==================================================================

    /// @notice State conservation: every unit of collateral held by the vault
    ///         contract is either credited to a user's vault or sitting in the
    ///         internal surplus bucket. No SurplusBuffer is configured in
    ///         this test, so protocol-share of liquidation penalties lives in
    ///         `surplusCollateral[token]` on the vault itself.
    function invariant_collateralStateConservation() public view {
        uint256 sumOfCollateral;
        address[] memory actors = handler.getActors();
        for (uint256 i = 0; i < actors.length; i++) {
            (, uint256 collateralAmount,) = vault.vaults(actors[i]);
            sumOfCollateral += collateralAmount;
        }

        uint256 surplus = vault.surplusCollateral(address(paxg));
        uint256 vaultBalance = paxg.balanceOf(address(vault));
        assertEq(
            vaultBalance,
            sumOfCollateral + surplus,
            "vault PAXG balance != sum(collateral) + surplus"
        );
    }

    /// @notice Flow conservation: the vault's current PAXG balance equals
    ///         cumulative inflows minus cumulative outflows tracked by the
    ///         handler. Guards against any future code path that moves
    ///         collateral without a corresponding user-visible action.
    function invariant_collateralFlowConservation() public view {
        uint256 vaultBalance = paxg.balanceOf(address(vault));
        uint256 expected = handler.ghost_paxgDepositedIn()
            - handler.ghost_paxgWithdrawnOut()
            - handler.ghost_paxgLiquidatorPayout();
        assertEq(vaultBalance, expected, "vault PAXG balance != ghost inflow - outflow");
    }

    /// @notice GSUSD supply equals total minted minus total burned through
    ///         vault-side paths. No other code path in this test can mint
    ///         or burn GSUSD.
    function invariant_gsusdFlowConservation() public view {
        uint256 expected = handler.ghost_gsusdMinted() - handler.ghost_gsusdBurned();
        assertEq(stablecoin.totalSupply(), expected, "GSUSD totalSupply != minted - burned");
    }

    /// @notice The per-block mint cap's ledger is what was minted in the block less what the
    ///         same accounts repaid of it in the block, and never above the cap. A repayment
    ///         of older debt frees nothing, and repaying twice frees a mint's room once.
    function invariant_blockMintedIsMintsNetOfTheirOwnSameBlockRepayments() public view {
        uint256 blockNow = vm.getBlockNumber();
        uint256 minted = vault.blockMinted(blockNow);
        assertEq(minted, handler.ghost_blockMinted(blockNow), "blockMinted != mints net of same-block repayments");
        assertLe(minted, MINT_CAP, "more than the cap is out from one block");
    }

    /// @notice The vault never refuses a deposit in this suite. The handler catches reverts so
    ///         a run can continue; without this a vault that refused every deposit would pass
    ///         every other invariant with nothing in it.
    function invariant_noDepositRefused() public view {
        assertEq(handler.ghost_depositFaults(), 0, "the vault refused a deposit");
    }

    /// @notice Anti-vacuity (runs once at the end of each run): collateral was deposited and
    ///         GSUSD was minted, or the conservation properties above compared zero with zero.
    function afterInvariant() public view {
        assertGt(handler.ghost_paxgDepositedIn(), 0, "vacuous run: no deposit succeeded");
        assertGt(handler.ghost_gsusdMinted(), 0, "vacuous run: no mint succeeded");
    }

    // ==================================================================
    // Helpers
    // ==================================================================

    function _pushPrice(MockAggregatorV3 feed, int256 price) internal {
        feed.setLatestRoundData(
            uint80(1),
            price,
            block.timestamp,
            block.timestamp,
            uint80(1)
        );
    }
}
