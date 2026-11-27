// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {FullStackHarness} from "./harness/FullStackHarness.sol";
import {SiloFactory} from "../src/core/CollateralSilo.sol";
import {GoldVault} from "../src/core/GoldVault.sol";
import {StabilityPool} from "../src/core/StabilityPool.sol";
import {GoldStabilityReserve} from "../src/core/GoldStabilityReserve.sol";
import {IGoldOracle} from "../src/interfaces/IGoldOracle.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

/// @notice Liquidation and supply accounting under adverse conditions: one test group per
///         rule, each a proof of concept turned round, with the unchanged behaviour kept
///         beside it.
///         - an issuer freeze of the reserve or the buffer does not stop liquidation
///         - the pool path survives a freeze of the vault's own address
///         - the pool path keeps working while the vault or the oracle is paused
///         - a thin but solvent vault takes a pro rata partial
///         - a mint repaid in its own block gives its per-block room back
///         - every burn is damped from the supply that stood before it
///         - getCollateralGain answers 0 for a token the pool does not list
contract LiquidationAndSupplyAccountingTest is FullStackHarness {
    address internal borrower = address(0xB0B);
    address internal liquidator = address(0x11);
    address internal depositor = address(0xD1);
    address internal keeper = address(0xBEEF);
    SiloFactory internal factory;
    uint256 internal bn;

    event ReserveRoutingFailed(address indexed token, uint256 amount);
    event SurplusRoutingFailed(address indexed token, uint256 amount);

    function setUp() public override {
        super.setUp();
        // Mainnet wiring: collateral sits in silos.
        factory = new SiloFactory(100e18);
        factory.grantRole(factory.VAULT_ROLE(), address(vault));
        vault.setSiloFactory(address(factory));
        bn = block.number;
    }

    // ------------------------------------------------------------------ helpers

    /// @dev via-IR may cache block.number inside one test, so blocks are counted locally.
    function _nextBlock() internal {
        vm.roll(++bn);
    }

    function _refreshFeeds() internal {
        _setPrice(int256(oracle.getLastKnownPrice(address(paxg))));
        oracle.getTokenPrice(address(paxg));
        oracle.getTokenPrice(address(xaut));
    }

    function _poolDeposit(address who, uint256 amount) internal {
        _fundGsusd(who, amount);
        vm.startPrank(who);
        gsusd.approve(address(pool), amount);
        pool.deposit(amount);
        vm.stopPrank();
        _nextBlock();
    }

    /// 1 PAXG against 2600 GSUSD, walked to $2800: 107.7%, liquidatable with the full penalty.
    function _liquidatableVault() internal {
        _fundGsusd(liquidator, 5000e18);
        _open(borrower, paxg, 1e18, 2600e18);
        _walkPrice(2800e8);
        vm.prank(liquidator);
        gsusd.approve(address(vault), type(uint256).max);
    }

    /// PAXG's approve reverts for a frozen spender (V1 "address frozen", PaxosTokenV2
    /// AddressFrozen()); modelled with a mocked revert on approve(spender, ...).
    function _freezeSpender(address spender) internal {
        vm.mockCallRevert(
            address(paxg),
            abi.encodeWithSelector(IERC20.approve.selector, spender),
            abi.encodeWithSignature("AddressFrozen()")
        );
    }

    /// @return seized Collateral that left the vault; protocolShare what the liquidator did not get.
    function _liquidateDirect(bool emergency) internal returns (uint256 seized, uint256 protocolShare) {
        (, uint256 collBefore,) = _vault(borrower);
        vm.prank(liquidator);
        if (emergency) vault.emergencyLiquidate(borrower, 0);
        else vault.liquidate(borrower, 0);
        (, uint256 collAfter, uint256 debt) = _vault(borrower);
        assertEq(debt, 0, "the debt is cleared");
        seized = collBefore - collAfter;
        protocolShare = seized - paxg.balanceOf(liquidator);
        assertGt(protocolShare, 0, "a protocol share exists to route");
    }

    // ------------------------------------------------------------------ frozen reserve or buffer

    function test_control_unfrozenRoutesReserveSliceAndBufferRest() public {
        _liquidatableVault();
        (, uint256 share) = _liquidateDirect(false);
        uint256 toReserve = (share * 4000) / 10000;
        assertEq(reserve.collateralBalance(address(paxg)), toReserve);
        assertEq(buffer.collateralBalance(address(paxg)), share - toReserve);
        assertEq(vault.surplusCollateral(address(paxg)), 0);
    }

    function test_frozenReserve_liquidateSettles_sliceFallsToBuffer() public {
        _liquidatableVault();
        _freezeSpender(address(reserve));
        vm.expectEmit(true, false, false, false, address(vault));
        emit ReserveRoutingFailed(address(paxg), 0);
        (, uint256 share) = _liquidateDirect(false);
        assertEq(reserve.collateralBalance(address(paxg)), 0, "the frozen reserve gets nothing");
        assertEq(buffer.collateralBalance(address(paxg)), share, "insurance takes the whole share");
        assertEq(vault.surplusCollateral(address(paxg)), 0);
    }

    function test_frozenBuffer_liquidateSettles_restCreditedToSurplusCollateral() public {
        _liquidatableVault();
        _freezeSpender(address(buffer));
        vm.expectEmit(true, false, false, false, address(vault));
        emit SurplusRoutingFailed(address(paxg), 0);
        (, uint256 share) = _liquidateDirect(false);
        uint256 toReserve = (share * 4000) / 10000;
        assertEq(reserve.collateralBalance(address(paxg)), toReserve, "the reserve still takes its slice");
        assertEq(buffer.collateralBalance(address(paxg)), 0);
        assertEq(vault.surplusCollateral(address(paxg)), share - toReserve, "the rest stays withdrawable here");
        assertEq(paxg.balanceOf(address(vault)), share - toReserve, "and is actually held");
    }

    function test_bothFrozen_pausedVault_emergencyLiquidateSettles() public {
        _liquidatableVault();
        _freezeSpender(address(reserve));
        _freezeSpender(address(buffer));
        vault.emergencyPause();
        (, uint256 share) = _liquidateDirect(true);
        assertEq(vault.surplusCollateral(address(paxg)), share, "every gram of the share is kept");
        // Governance can still move it out.
        vault.withdrawSurplus(address(paxg), address(this), share);
        assertEq(paxg.balanceOf(address(this)), share);
    }

    function test_approveReturningFalseCountsAsFailure() public {
        _liquidatableVault();
        vm.mockCall(address(paxg), abi.encodeWithSelector(IERC20.approve.selector, address(reserve)), abi.encode(false));
        (, uint256 share) = _liquidateDirect(false);
        assertEq(reserve.collateralBalance(address(paxg)), 0);
        assertEq(buffer.collateralBalance(address(paxg)), share);
    }

    function test_depositRevertAfterApprove_resetsAllowance() public {
        _liquidatableVault();
        vm.mockCallRevert(
            address(reserve), abi.encodeWithSelector(GoldStabilityReserve.depositCollateral.selector), "refused"
        );
        (, uint256 share) = _liquidateDirect(false);
        assertEq(paxg.allowance(address(vault), address(reserve)), 0, "no allowance left behind");
        assertEq(buffer.collateralBalance(address(paxg)), share);
    }

    // ------------------------------------------------------------------ frozen vault address

    function test_vaultFrozen_poolPathSettles() public {
        _poolDeposit(depositor, 50_000e18);
        _liquidatableVault();
        // Paxos freezes the GoldVault address: every PAXG transfer TO it reverts.
        vm.mockCallRevert(
            address(paxg),
            abi.encodeWithSelector(IERC20.transfer.selector, address(vault)),
            abi.encodeWithSignature("AddressFrozen()")
        );
        (, uint256 collBefore,) = _vault(borrower);
        vm.prank(keeper);
        vault.liquidateViaPool(borrower, 0);
        (, uint256 collAfter, uint256 debt) = _vault(borrower);
        assertEq(debt, 0);
        uint256 seized = collBefore - collAfter;
        uint256 bounty = paxg.balanceOf(keeper);
        assertGt(bounty, 0, "the keeper is paid straight from the silos");
        assertEq(paxg.balanceOf(address(pool)), seized - bounty, "the pool holds the rest");
        assertEq(pool.collateralAccounted(address(paxg)), seized - bounty, "and credits exactly that");
        assertEq(paxg.balanceOf(address(vault)), 0, "the vault never held the gold");
    }

    function test_poolCreditsWhatArrivedAndClaimsRetireIt() public {
        _poolDeposit(depositor, 50_000e18);
        _liquidatableVault();
        vm.prank(keeper);
        vault.liquidateViaPool(borrower, 0);
        uint256 held = paxg.balanceOf(address(pool));
        assertEq(pool.collateralAccounted(address(paxg)), held);
        uint256 gain = pool.getCollateralGain(depositor, address(paxg));
        assertLe(gain, held);
        assertApproxEqRel(gain, held, 1e9, "the sole depositor is credited all of it, bar product-sum rounding");
        vm.prank(depositor);
        pool.claimCollateral(address(paxg));
        assertEq(paxg.balanceOf(depositor), gain);
        assertEq(pool.collateralAccounted(address(paxg)), held - gain);
    }

    function test_prefundedAbsorbIsVaultOnlyAndKeepsTheDrainGuard() public {
        _poolDeposit(depositor, 1_000e18);
        vm.expectRevert();
        pool.absorbLiquidationPrefunded(address(paxg), 1e18);

        pool.grantRole(pool.VAULT_ROLE(), address(this));
        vm.expectRevert(bytes("Unsupported token"));
        pool.absorbLiquidationPrefunded(address(0xdead), 1e18);
        vm.expectRevert(bytes("Absorption would drain pool"));
        pool.absorbLiquidationPrefunded(address(paxg), 1_000e18);

        // Gold sent before the call (a donation included) is what the absorption credits.
        paxg.mint(address(pool), 3e17);
        pool.absorbLiquidationPrefunded(address(paxg), 100e18);
        assertEq(pool.collateralAccounted(address(paxg)), 3e17);
        assertEq(pool.getEffectiveDeposit(depositor), 900e18);
        assertApproxEqAbs(pool.getCollateralGain(depositor, address(paxg)), 3e17, 1);
        // A second absorption with nothing new credits nothing.
        pool.absorbLiquidationPrefunded(address(paxg), 100e18);
        assertEq(pool.collateralAccounted(address(paxg)), 3e17);
        assertApproxEqAbs(pool.getCollateralGain(depositor, address(paxg)), 3e17, 1);
    }

    function test_thePoolAbsorbsOnlyWhatWasSentAheadAndHasNoPullCall() public {
        _poolDeposit(depositor, 1_000e18);
        pool.grantRole(pool.VAULT_ROLE(), address(this));
        paxg.mint(address(this), 2e17);
        paxg.approve(address(pool), 2e17);
        // The call that pulled the gold from the caller no longer exists, approval or not.
        (bool ok,) = address(pool).call(
            abi.encodeWithSignature("absorbLiquidation(address,uint256,uint256)", address(paxg), 100e18, 2e17)
        );
        assertFalse(ok, "the pull-style absorb is gone");
        assertEq(paxg.balanceOf(address(pool)), 0);
        assertEq(pool.getTotalDeposits(), 1_000e18);
        // Sent ahead, the same gold is accounted for and credited.
        paxg.transfer(address(pool), 2e17);
        pool.absorbLiquidationPrefunded(address(paxg), 100e18);
        assertEq(pool.collateralAccounted(address(paxg)), 2e17);
        assertApproxEqAbs(pool.getCollateralGain(depositor, address(paxg)), 2e17, 1);
    }

    // ------------------------------------------------------------------ pool path while paused

    /// A 10 PAXG / 26k vault at $2500 is underwater; pooling it books 1,500 of bad debt and
    /// trips a 1,000 breaker. A second vault then falls to 107.5%.
    function _breakerTripped() internal {
        vault.setBadDebtPauseThreshold(1_000e18);
        _poolDeposit(depositor, 100_000e18);
        address whale = address(0xA11CE);
        _open(whale, paxg, 10e18, 26_000e18);
        _open(borrower, paxg, 1e18, 2_000e18);
        _walkPrice(2500e8);
        vm.prank(keeper);
        vault.liquidateViaPool(whale, 0);
        assertTrue(vault.paused(), "the breaker paused the vault");
        _walkPrice(2150e8);
    }

    function test_poolPathLiquidatesWhilePausedByTheBreaker() public {
        _breakerTripped();
        uint256 poolBefore = pool.getTotalDeposits();
        vm.expectCall(
            address(oracle), abi.encodeWithSelector(IGoldOracle.getEmergencyPrice.selector, address(paxg), true)
        );
        vm.prank(keeper);
        vault.liquidateViaPool(borrower, 0);
        (, , uint256 debt) = _vault(borrower);
        assertEq(debt, 0, "liquidated through the pool while paused");
        assertEq(poolBefore - pool.getTotalDeposits(), 2_000e18, "the pool paid the debt");
        assertGt(paxg.balanceOf(keeper), 0, "the keeper is paid");
        assertTrue(vault.paused(), "still paused");
    }

    function test_pausedPoolPathStillRefusesAHealthyVault() public {
        _breakerTripped();
        address healthy = address(0x4EA1);
        _open(healthy, paxg, 2e18, 0);
        vm.prank(healthy);
        vm.expectRevert(Pausable.EnforcedPause.selector); // mint stays paused
        vault.mint(1_000e18);
        vm.prank(keeper);
        vm.expectRevert(bytes("No debt"));
        vault.liquidateViaPool(healthy, 0);
    }

    function test_control_unpausedPoolPathReadsTheNormalPrice() public {
        _poolDeposit(depositor, 50_000e18);
        _liquidatableVault();
        vm.expectCall(address(oracle), abi.encodeWithSelector(IGoldOracle.getTokenPrice.selector, address(paxg)));
        vm.prank(keeper);
        vault.liquidateViaPool(borrower, 0);
        (, , uint256 debt) = _vault(borrower);
        assertEq(debt, 0);
    }

    function test_control_liquidateAndMintStayPaused() public {
        _breakerTripped();
        vm.prank(liquidator);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        vault.liquidate(borrower, 0);
    }

    function test_pausedPoolPathRefusesAnUnwiredPool() public {
        _breakerTripped();
        vault.setStabilityPool(address(0));
        vm.expectRevert(bytes("StabilityPool not set"));
        vault.liquidateViaPool(borrower, 0);
    }

    // ------------------------------------------------------------------ thin vault, pro rata partial

    /// 40 PAXG against 100k, walked to $2600: 104%, solvent but below 100% plus the penalty.
    function _thinWhale(uint256 poolSize) internal returns (address whale) {
        _poolDeposit(depositor, poolSize);
        whale = address(0xA11CE);
        _open(whale, paxg, 40e18, 100_000e18);
        _walkPrice(2600e8);
    }

    function test_thinVaultLargerThanThePoolIsWorkedDownProRata() public {
        address whale = _thinWhale(60_000e18);
        uint256 ratioBefore = vault.getCollateralisationRatio(whale);

        vm.expectRevert(bytes("Pool insufficient"));
        vault.liquidateViaPool(whale, 0);

        vm.prank(keeper);
        vault.liquidateViaPool(whale, 50_000e18);
        (, uint256 coll, uint256 debt) = _vault(whale);
        assertEq(debt, 50_000e18, "half the debt retired");
        assertEq(coll, 20e18, "half the gold left: pro rata");
        assertGe(vault.getCollateralisationRatio(whale), ratioBefore, "the ratio is not worsened");
        assertEq(vault.totalBadDebt(), 0);

        // The liquidator's take is what the gold holds above the debt, as on a full liquidation.
        uint256 debtEq = (uint256(50_000e18) * 1e8) / 2600e8;
        uint256 keeperBounty = ((20e18 - debtEq) * (vault.liquidatorIncentiveShare() / 2)) / 1e6;
        assertEq(paxg.balanceOf(keeper), keeperBounty);
        assertEq(paxg.balanceOf(address(pool)), 20e18 - keeperBounty);
    }

    function test_directThinPartialAndThenFullBookNoBadDebt() public {
        address whale = _thinWhale(1_000e18);
        _fundGsusd(liquidator, 100_000e18);
        vm.startPrank(liquidator);
        gsusd.approve(address(vault), type(uint256).max);
        vault.liquidate(whale, 30_000e18);
        (, uint256 coll, uint256 debt) = _vault(whale);
        assertEq(debt, 70_000e18);
        assertEq(coll, 28e18);
        vault.liquidate(whale, 0);
        vm.stopPrank();
        (, coll, debt) = _vault(whale);
        assertEq(coll, 0);
        assertEq(debt, 0);
        assertEq(vault.totalBadDebt(), 0, "solvent all the way down");
    }

    function test_thinPartialStillHonoursMinDebt() public {
        address whale = _thinWhale(200_000e18);
        vm.expectRevert(bytes("Residual debt below minimum"));
        vault.liquidateViaPool(whale, 100_000e18 - 50e18);
    }

    function test_underwaterPartialIsStillRefused() public {
        address whale = _thinWhale(200_000e18);
        _walkPrice(2400e8); // 96%
        vm.expectRevert(bytes("Thin vault: liquidate in full"));
        vault.liquidateViaPool(whale, 50_000e18);
        vault.liquidateViaPool(whale, 0);
        (, uint256 coll, uint256 debt) = _vault(whale);
        assertEq(coll, 0);
        assertEq(debt, 0);
        assertGt(vault.totalBadDebt(), 0, "the shortfall is booked at once");
    }

    function test_control_fullThinLiquidationTakesAllTheGoldForAllTheDebt() public {
        address whale = _thinWhale(200_000e18);
        vault.liquidateViaPool(whale, 0);
        (, uint256 coll, uint256 debt) = _vault(whale);
        assertEq(coll, 0);
        assertEq(debt, 0);
        assertEq(vault.totalBadDebt(), 0);
        assertEq(200_000e18 - pool.getTotalDeposits(), 100_000e18);
    }

    // ------------------------------------------------------------------ same-block repayment

    function _capOn() internal {
        vault.setPerBlockMintCap(50_000e18);
        // Mainnet stability fee, with the accumulator already above 1e18.
        module.setStabilityFee(paxgId, 200);
        vm.warp(block.timestamp + 30 days);
        _refreshFeeds();
    }

    function test_mintRepaidInItsBlockGivesTheRoomBack() public {
        _capOn();
        address griefer = address(0x6E1F);
        _open(griefer, paxg, 30e18, 0);
        _fundGsusd(griefer, 100e18);
        _open(borrower, paxg, 1e18, 0);
        _nextBlock();

        vm.startPrank(griefer);
        vault.mint(50_000e18);
        gsusd.approve(address(vault), type(uint256).max);
        vault.repay(type(uint256).max);
        vm.stopPrank();
        assertEq(vault.blockMinted(bn), 0, "nothing net was issued");

        vm.prank(borrower);
        vault.mint(1_000e18);
        assertEq(vault.blockMinted(bn), 1_000e18);
    }

    function test_partialSameBlockRepayRetiresOnlyItsPrincipal() public {
        _capOn();
        address a = address(0xAAA1);
        _open(a, paxg, 30e18, 0);
        _nextBlock();
        vm.startPrank(a);
        vault.mint(50_000e18);
        gsusd.approve(address(vault), type(uint256).max);
        vault.repay(20_000e18);
        vm.stopPrank();
        (, , uint256 principal) = _vault(a);
        assertEq(vault.blockMinted(bn), principal, "the cap counts what is still out");
        assertApproxEqAbs(vault.blockMinted(bn), 30_000e18, 1);
    }

    function test_anotherAccountsRepaymentDoesNotMakeRoom() public {
        _capOn();
        address old = address(0x01D);
        _open(old, paxg, 30e18, 10_000e18);
        address a = address(0xAAA1);
        _open(a, paxg, 30e18, 0);
        _open(borrower, paxg, 1e18, 0);
        _nextBlock();

        vm.prank(a);
        vault.mint(50_000e18);
        vm.startPrank(old);
        gsusd.approve(address(vault), type(uint256).max);
        vault.repay(type(uint256).max);
        vm.stopPrank();
        assertEq(vault.blockMinted(bn), 50_000e18, "old debt repaid frees nobody's room");

        vm.prank(borrower);
        vm.expectRevert(bytes("Per-block mint cap reached"));
        vault.mint(1_000e18);
    }

    function test_repayingMoreThanTheBlocksMintRetiresOnlyTheMint() public {
        _capOn();
        address a = address(0xAAA1);
        _open(a, paxg, 30e18, 10_000e18);
        _fundGsusd(a, 1_000e18); // covers the fee on the old debt
        _nextBlock();
        vm.startPrank(a);
        vault.mint(5_000e18);
        gsusd.approve(address(vault), type(uint256).max);
        vault.repay(type(uint256).max);
        vm.stopPrank();
        assertEq(vault.blockMinted(bn), 0, "retired 5k, not 15k");
        address b = address(0xBBB1);
        _open(b, paxg, 30e18, 0);
        vm.prank(b);
        vault.mint(50_000e18); // the whole cap is there again, and no more
        assertEq(vault.blockMinted(bn), 50_000e18);
    }

    function test_control_repayInALaterBlockRetiresNothing() public {
        _capOn();
        address a = address(0xAAA1);
        _open(a, paxg, 30e18, 0);
        _nextBlock();
        uint256 mintBlock = bn;
        vm.prank(a);
        vault.mint(50_000e18);
        _nextBlock();
        vm.startPrank(a);
        gsusd.approve(address(vault), type(uint256).max);
        vault.repay(10_000e18);
        vm.stopPrank();
        assertEq(vault.blockMinted(mintBlock), 50_000e18);
        assertEq(vault.blockMinted(bn), 0);
    }

    // ------------------------------------------------------------------ burn damping

    function _seedReserve(uint256 paxgAmount) internal {
        paxg.mint(address(this), paxgAmount);
        paxg.approve(address(reserve), paxgAmount);
        reserve.seedCollateral(address(paxg), paxgAmount);
    }

    /// Supply 1M for two days, $140k of gold seeded, then 500k minted by others an hour ago.
    function _recentGrowth() internal returns (address whale) {
        whale = address(0xA11CE);
        _open(whale, paxg, 150e18, 300_000e18);
        _open(address(0x0111), paxg, 350e18, 700_000e18);
        vm.warp(block.timestamp + 2 days);
        _refreshFeeds();
        _seedReserve(35e18);
        _open(address(0x0222), paxg, 375e18, 500_000e18);
        vm.warp(block.timestamp + 1 hours);
        _refreshFeeds();
        _fundGsusd(whale, 5_000e18);
        assertLt(gsusd.smoothedSupplyNow(), gsusd.totalSupply(), "the average lags the growth");
    }

    function test_repaySwapMintAfterRecentGrowthBuysNothing() public {
        address whale = _recentGrowth();
        (, uint256 before) = reserve.quoteGoldOut(address(paxg), 5_000e18);
        assertEq(before, 12_500);
        uint256 supplyBefore = gsusd.totalSupply();

        vm.startPrank(whale);
        gsusd.approve(address(vault), type(uint256).max);
        vault.repay(300_000e18);
        // _recentGrowth funds the whale with 5,000 GSUSD in this same block, so the supply
        // at the start of the block is 5,000 below supplyBefore (a burn is floored there).
        assertGe(gsusd.smoothedSupplyNow(), supplyBefore - 5_000e18, "the burn is damped from the supply at the start of the block");
        (, uint256 during) = reserve.quoteGoldOut(address(paxg), 5_000e18);
        assertEq(during, 12_500, "no cheaper tier inside repay-swap-mint");
        gsusd.approve(address(reserve), 5_000e18);
        reserve.swapGsusdForGold(address(paxg), 5_000e18, 0);
        vault.mint(300_000e18);
        vm.stopPrank();
    }

    function test_control_aBurnStillEarnsTheTierAfterADay() public {
        address whale = _recentGrowth();
        vm.startPrank(whale);
        gsusd.approve(address(vault), type(uint256).max);
        vault.repay(300_000e18);
        vm.stopPrank();
        vm.warp(block.timestamp + 1 days);
        _refreshFeeds();
        (, uint256 later) = reserve.quoteGoldOut(address(paxg), 5_000e18);
        assertEq(later, 5_000, "a day on, the lower supply counts");
    }

    function test_control_aMintStillStepsTheSpreadUpAtOnce() public {
        _recentGrowth();
        _open(address(0x0333), paxg, 500e18, 600_000e18);
        assertEq(reserve.currentSpreadPpm(), 12_500);
        assertEq(gsusd.totalSupply(), reserve.dampedCirculatingSupply() + reserve.gsusdInventory());
    }

    /// With no ceiling, a deposit, mint, repay and
    /// withdraw in one transaction used to bank the burn at the inflated pre-burn supply and
    /// push the reserve to its widest spread for a day for the cost of gas.
    function test_flashMintAndRepayLeavesTheSmoothedSupplyAlone() public {
        _open(address(0xA11CE), paxg, 100e18, 100_000e18);
        _seedReserve(10e18);
        vm.warp(block.timestamp + 3 days);
        _refreshFeeds();
        uint256 spreadBefore = reserve.currentSpreadPpm();
        uint256 supply = gsusd.totalSupply();

        address atk = address(0xA77);
        paxg.mint(atk, 2_000e18);
        vm.startPrank(atk);
        paxg.approve(address(vault), 2_000e18);
        vault.deposit(address(paxg), 2_000e18);
        vault.mint(2_000_000e18);
        gsusd.approve(address(vault), type(uint256).max);
        vault.repay(2_000_000e18);
        vault.withdraw(2_000e18);
        vm.stopPrank();

        assertEq(gsusd.totalSupply(), supply, "the supply is back where it started");
        assertLe(gsusd.smoothedSupplyNow(), supply, "the burn banks no more than the supply at the start of the block");
        assertEq(reserve.currentSpreadPpm(), spreadBefore, "the spread is unchanged");
    }

    // ------------------------------------------------------------------ oracle paused alone

    /// The pool path used to read the normal price whenever the vault itself
    /// was not paused, so a guardian pause of the oracle alone stopped every pool liquidation.
    function test_poolPathLiquidatesWhileOnlyTheOracleIsPaused() public {
        _poolDeposit(depositor, 50_000e18);
        _liquidatableVault();
        oracle.emergencyPause();
        assertFalse(vault.paused(), "the vault itself runs");
        vm.expectCall(
            address(oracle), abi.encodeWithSelector(IGoldOracle.getEmergencyPrice.selector, address(paxg), false)
        );
        vm.prank(keeper);
        vault.liquidateViaPool(borrower, 0);
        (, , uint256 debt) = _vault(borrower);
        assertEq(debt, 0, "liquidated through the pool while the oracle is paused");
    }

    // ------------------------------------------------------------------ unlisted token gain

    function test_unlistedTokenGainIsZero() public {
        StabilityPool p2 = new StabilityPool(address(gsusd));
        p2.addCollateralToken(address(paxg));
        _fundGsusd(depositor, 1_000e18);
        vm.startPrank(depositor);
        gsusd.approve(address(p2), 1_000e18);
        p2.deposit(1_000e18);
        vm.stopPrank();
        assertEq(p2.getCollateralGain(depositor, address(xaut)), 0);
        assertEq(p2.getCollateralGain(depositor, address(paxg)), 0);
    }
}
