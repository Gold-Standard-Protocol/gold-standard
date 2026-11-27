// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";

import {GoldVault} from "../../../src/core/GoldVault.sol";
import {GoldStablecoin} from "../../../src/core/GoldStablecoin.sol";
import {MockERC20} from "../../../src/test/mocks/MockERC20.sol";
import {MockAggregatorV3} from "../../../src/test/mocks/MockAggregatorV3.sol";

/// @title VaultHandler
/// @notice Fuzz-driven harness for GoldVault invariant tests.
///
/// @dev Keeps a small set of actors so state is bounded and shrinkable. Uses
///      `bound()` to force fuzz inputs into legal ranges before calling into
///      the vault - wrong-input reverts aren't useful for surfacing invariant
///      violations, so we filter them out upstream.
///
///      Does NOT advance block.timestamp; the invariant suite asserts the
///      strict identity `totalSupply == aggregate debt`, which relies on
///      zero fee accrual. Time-advancing fuzz belongs in the unit-level
///      StabilityModule tests.
///
///      **Ghost accounting** - the handler records cumulative flows across
///      every successful action (deposited, withdrawn, liquidator payouts,
///      GSUSD minted, GSUSD burned). The invariant suite asserts that the
///      vault's on-chain balance matches these flows exactly. This catches
///      any code path that moves collateral or GSUSD without the expected
///      bookkeeping - a class of bug that pure state-based invariants
///      cannot detect.
contract VaultHandler is Test {
    GoldVault internal immutable vault;
    GoldStablecoin internal immutable stablecoin;
    MockERC20 internal immutable paxg;
    MockAggregatorV3 internal immutable paxgFeed;
    MockAggregatorV3 internal immutable xautFeed;

    int256 internal constant GOLD_PRICE = 2000 * 1e8;

    uint256 internal constant NUM_ACTORS = 5;
    address[] public actors;

    // -- Ghost flow accounting (incremented on every successful action) --
    uint256 public ghost_paxgDepositedIn;        // total PAXG transferred into the vault
    uint256 public ghost_paxgWithdrawnOut;       // via vault.withdraw()
    uint256 public ghost_paxgLiquidatorPayout;   // collateral paid to liquidators
    uint256 public ghost_gsusdMinted;             // via vault.mint()
    uint256 public ghost_gsusdBurned;             // via repay()/liquidate() -> stablecoin.burn()

    constructor(
        GoldVault _vault,
        GoldStablecoin _stablecoin,
        MockERC20 _paxg,
        MockAggregatorV3 _paxgFeed,
        MockAggregatorV3 _xautFeed
    ) {
        vault = _vault;
        stablecoin = _stablecoin;
        paxg = _paxg;
        paxgFeed = _paxgFeed;
        xautFeed = _xautFeed;

        for (uint256 i = 0; i < NUM_ACTORS; i++) {
            actors.push(address(uint160(0xA11CE + i)));
        }
    }

    /// @dev Deposits the vault refused. A deposit needs no price and no ratio, so in this suite
    ///      (no pause, no factory, a plain token) none may fail. Must stay zero.
    uint256 public ghost_depositFaults;

    // -- The per-block mint cap's ledger, rebuilt from what each successful call did --
    /// @dev GSUSD minted in a block, less what the same accounts repaid of it in that block.
    mapping(uint256 => uint256) public ghost_blockMinted;
    /// @dev Per actor: the block of its latest mint and how much of that mint is still out.
    mapping(address => uint256) internal ghost_ownBlock;
    mapping(address => uint256) internal ghost_ownMinted;

    function getActors() external view returns (address[] memory) {
        return actors;
    }

    // ==================================================================
    // Price freshness helper - called at the start of every handler
    // function since the oracle staleness check rejects prices older
    // than one hour.
    // ==================================================================
    function _refreshPrices() internal {
        paxgFeed.setLatestRoundData(uint80(1), GOLD_PRICE, block.timestamp, block.timestamp, uint80(1));
        xautFeed.setLatestRoundData(uint80(1), GOLD_PRICE, block.timestamp, block.timestamp, uint80(1));
    }

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    // ==================================================================
    // Handler functions - each snapshots relevant balances before the
    // call and updates ghost totals only if the call succeeded.
    // ==================================================================

    function deposit(uint256 actorSeed, uint256 amount) external {
        _refreshPrices();
        address actor = _actor(actorSeed);
        // Reasonable ounce range: 0.01 - 1000 PAXG
        amount = bound(amount, 0.01e18, 1000e18);

        paxg.mint(actor, amount);

        uint256 vaultBefore = paxg.balanceOf(address(vault));

        vm.startPrank(actor);
        paxg.approve(address(vault), amount);
        try vault.deposit(address(paxg), amount) {
            // Success - measure what actually arrived (MockERC20 has no
            // transfer fee, but the pattern guards against future changes).
            ghost_paxgDepositedIn += paxg.balanceOf(address(vault)) - vaultBefore;
        } catch {
            // A deposit of fresh PAXG into an unpaused vault reads no price and must succeed.
            ghost_depositFaults++;
        }
        vm.stopPrank();
    }

    function withdraw(uint256 actorSeed, uint256 amount) external {
        _refreshPrices();
        address actor = _actor(actorSeed);
        (, uint256 collateralAmount,) = vault.vaults(actor);
        if (collateralAmount == 0) return;

        amount = bound(amount, 1, collateralAmount);

        uint256 vaultBefore = paxg.balanceOf(address(vault));

        vm.prank(actor);
        try vault.withdraw(amount) {
            ghost_paxgWithdrawnOut += vaultBefore - paxg.balanceOf(address(vault));
        } catch {}
    }

    function mint(uint256 actorSeed, uint256 amount) external {
        _refreshPrices();
        address actor = _actor(actorSeed);
        (, uint256 collateralAmount,) = vault.vaults(actor);
        if (collateralAmount == 0) return;

        // PAXG is 18-dec at $2000/oz, so collateralValue (18-dec GSUSD) = amount * 2000.
        // Use a 200% cap (/ 2) to leave headroom above the 150% min ratio.
        uint256 maxMint = (collateralAmount * 2000) / 2;
        uint256 minDebt = vault.minDebt();

        // Skip if the actor's position can't support even a minimum mint.
        (, , uint256 existingDebt) = vault.vaults(actor);
        uint256 headroom = maxMint > existingDebt ? maxMint - existingDebt : 0;
        if (headroom < minDebt) return;

        amount = bound(amount, minDebt, headroom);

        uint256 supplyBefore = stablecoin.totalSupply();

        vm.prank(actor);
        try vault.mint(amount) {
            ghost_gsusdMinted += stablecoin.totalSupply() - supplyBefore;
            if (vault.perBlockMintCap() > 0) {
                uint256 blockNow = vm.getBlockNumber();
                if (ghost_ownBlock[actor] != blockNow) {
                    ghost_ownBlock[actor] = blockNow;
                    ghost_ownMinted[actor] = 0;
                }
                ghost_ownMinted[actor] += amount;
                ghost_blockMinted[blockNow] += amount;
            }
        } catch {}
    }

    /// @dev Moves to the next block and leaves the clock alone, so no fee accrues. Mints and
    ///      repayments then fall in the same block or in different ones, which is what the
    ///      per-block mint cap's ledger distinguishes.
    function nextBlock() external {
        vm.roll(vm.getBlockNumber() + 1);
    }

    function repay(uint256 actorSeed, uint256 amount) external {
        _refreshPrices();
        address actor = _actor(actorSeed);
        (, , uint256 debt) = vault.vaults(actor);
        if (debt == 0) return;

        uint256 balance = stablecoin.balanceOf(actor);
        if (balance == 0) return;

        uint256 cap = balance < debt ? balance : debt;
        amount = bound(amount, 1, cap);

        uint256 supplyBefore = stablecoin.totalSupply();

        vm.startPrank(actor);
        stablecoin.approve(address(vault), amount);
        try vault.repay(amount) {
            // Repay burns principal + (zero-fee) any feePortion. Supply only
            // falls for burned portions; transferred-to-buffer GSUSD leaves
            // supply unchanged. With no buffer configured and zero fee, the
            // full `amount` is burned.
            ghost_gsusdBurned += supplyBefore - stablecoin.totalSupply();
            // A repayment gives back cap room only for what this account minted in this
            // block and has not already repaid: never more, however often it repays.
            uint256 blockNow = vm.getBlockNumber();
            if (ghost_ownBlock[actor] == blockNow) {
                (, , uint256 debtAfter) = vault.vaults(actor);
                uint256 principalRepaid = debt - debtAfter;
                uint256 retired = principalRepaid < ghost_ownMinted[actor] ? principalRepaid : ghost_ownMinted[actor];
                ghost_ownMinted[actor] -= retired;
                ghost_blockMinted[blockNow] -= retired;
            }
        } catch {}
        vm.stopPrank();
    }

    function liquidate(uint256 actorSeed, uint256 liquidatorSeed, uint256 amount) external {
        _refreshPrices();
        address target = _actor(actorSeed);
        address liquidator = _actor(liquidatorSeed);
        if (target == liquidator) return;

        (, , uint256 debt) = vault.vaults(target);
        if (debt == 0) return;

        uint256 balance = stablecoin.balanceOf(liquidator);
        if (balance == 0) return;

        uint256 cap = balance < debt ? balance : debt;
        amount = bound(amount, 1, cap);

        uint256 vaultPaxgBefore = paxg.balanceOf(address(vault));
        uint256 supplyBefore = stablecoin.totalSupply();

        vm.startPrank(liquidator);
        stablecoin.approve(address(vault), amount);
        try vault.liquidate(target, amount) {
            // Collateral drop in vault balance == liquidator payout. Any
            // protocol-share stays in vault balance as surplusCollateral
            // so it doesn't count as "out".
            ghost_paxgLiquidatorPayout += vaultPaxgBefore - paxg.balanceOf(address(vault));
            ghost_gsusdBurned += supplyBefore - stablecoin.totalSupply();
        } catch {}
        vm.stopPrank();
    }
}
