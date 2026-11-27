// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {FullStackHarness} from "./harness/FullStackHarness.sol";
import {SiloFactory} from "../src/core/CollateralSilo.sol";
import {FeeSplitter} from "../src/core/FeeSplitter.sol";
import {MockBadDebtBuffer} from "../src/test/mocks/MockBadDebtBuffer.sol";
import {RevertingFeeBuffer} from "./harness/RevertingFeeBuffer.sol";

/// @notice A liquidation that takes all of a vault's gold and still leaves debt has lost
///         principal. Its payment retires principal first: no stability fee is recognised
///         on a vault whose principal was not recovered, and the bad debt booked is exactly
///         the principal lost. Splitting such a payment pro rata between principal and fee
///         banked (or burned) a fee and overstated the bad debt by the same amount.
contract UnderwaterLiquidationAccountingTest is FullStackHarness {
    address internal borrower = address(0xB0B);
    address internal liquidator = address(0x11);
    address internal depositor = address(0xD1);
    address internal keeper = address(0xBEEF);
    address internal beneficiary = address(0xBE);

    uint256 internal constant PRINCIPAL = 3_000e18;

    event BadDebt(address indexed vaultOwner, uint256 amount);

    /// 10% a year, so a year adds roughly 300 GSUSD of fee to 3,000 of principal.
    function _feeBps() internal pure override returns (uint256) {
        return 1000;
    }

    function setUp() public override {
        super.setUp();
        SiloFactory factory = new SiloFactory(100e18);
        factory.grantRole(factory.VAULT_ROLE(), address(vault));
        vault.setSiloFactory(address(factory));
        // The test banks fees into the buffer directly, as the vault would.
        buffer.grantRole(buffer.VAULT_ROLE(), address(this));
    }

    // ------------------------------------------------------------------ helpers

    function _supplyGap() internal view returns (int256) {
        (,,,,, uint256 paxgDebt,) = vault.collateralTypes(paxgId);
        (,,,,, uint256 xautDebt,) = vault.collateralTypes(xautId);
        return int256(gsusd.totalSupply()) - int256(paxgDebt + xautDebt + vault.totalBadDebt());
    }

    /// @dev 1.125 PAXG against 3,000 GSUSD, a year of fee, then gold walked down until the
    ///      collateral is worth 2,000 USD: under water against about 3,315 GSUSD of debt.
    function _underwaterVault() internal returns (uint256 currentDebt) {
        _open(borrower, paxg, 1.125e18, PRINCIPAL);
        vm.warp(block.timestamp + 365 days);
        _setPrice(PRICE);
        oracle.getTokenPrice(address(paxg));
        oracle.getTokenPrice(address(xaut));
        // 1.125 PAXG * 1,777.77777778 = 2,000.00 USD
        _walkPrice(177_777_777_778);
        currentDebt = vault.getVaultCurrentDebt(borrower);
        assertGt(currentDebt, PRINCIPAL + 300e18, "a year of fee has accrued");
    }

    /// @dev What _sizeSeizure makes the liquidator pay on this vault: 98% of the gold's
    ///      value, to the unit. 1.125 PAXG at 1,777.77777778 is 2,000.0000000025 USD, and 98%
    ///      of that is a whole number of units, so nothing is rounded.
    uint256 internal constant REPAY = 1_960_000_000_002_450_000_000;

    function _fundBuffer(uint256 amount) internal {
        _fundGsusd(address(this), amount);
        gsusd.approve(address(buffer), amount);
        buffer.depositFee(amount);
    }

    function _liquidateDirect() internal {
        _fundGsusd(liquidator, 5_000e18);
        vm.startPrank(liquidator);
        gsusd.approve(address(vault), type(uint256).max);
        vault.liquidate(borrower, 0);
        vm.stopPrank();
    }

    function _assertPrincipalLossBooked(uint256 badDebtBefore, uint256 supplyBefore, uint256 absorbed) internal view {
        (, uint256 coll, uint256 debt) = _vault(borrower);
        assertEq(coll, 0, "all the gold left");
        assertEq(debt, 0, "the vault is closed");
        assertEq(module.getCurrentDebt(borrower, paxgId), 0, "no normalised debt left");
        uint256 lost = PRINCIPAL - REPAY;
        assertEq(vault.totalBadDebt() - badDebtBefore, lost - absorbed, "bad debt is the principal lost");
        // The whole payment was principal, so the whole payment was burned, plus what the
        // buffer burned to absorb.
        assertEq(supplyBefore - gsusd.totalSupply(), REPAY + absorbed, "supply fell by the payment");
    }

    // ------------------------------------------------------------------ direct path

    function test_directUnderwaterLiquidationBanksNoFeeAndBooksThePrincipalLost() public {
        _underwaterVault();
        _fundBuffer(10_000e18);
        _fundGsusd(liquidator, 5_000e18);
        int256 gapBefore = _supplyGap();
        uint256 feesBefore = buffer.totalFeesReceived();
        uint256 absorbedBefore = buffer.totalBadDebtAbsorbed();
        uint256 supplyBefore = gsusd.totalSupply();

        vm.prank(liquidator);
        gsusd.approve(address(vault), type(uint256).max);
        // The amount is checked below, to the unit.
        vm.expectEmit(true, false, false, false, address(vault));
        emit BadDebt(borrower, 0);
        vm.prank(liquidator);
        vault.liquidate(borrower, 0);

        assertEq(buffer.totalFeesReceived(), feesBefore, "no fee is banked on a vault that lost principal");
        uint256 lost = PRINCIPAL - REPAY;
        assertEq(buffer.totalBadDebtAbsorbed() - absorbedBefore, lost, "the buffer absorbs the principal lost");
        assertEq(vault.totalBadDebt(), 0, "a healthy buffer absorbs it all");
        _assertPrincipalLossBooked(0, supplyBefore, lost);
        assertEq(_supplyGap(), gapBefore, "supply still equals debt plus bad debt");
    }

    function test_directUnderwaterLiquidationWithNoBufferKeepsSupplyEqualToDebtPlusBadDebt() public {
        _underwaterVault();
        _fundGsusd(liquidator, 5_000e18);
        vault.setSurplusBuffer(address(0));
        int256 gapBefore = _supplyGap();
        uint256 supplyBefore = gsusd.totalSupply();

        vm.startPrank(liquidator);
        gsusd.approve(address(vault), type(uint256).max);
        vault.liquidate(borrower, 0);
        vm.stopPrank();

        _assertPrincipalLossBooked(0, supplyBefore, 0);
        assertEq(_supplyGap(), gapBefore, "nothing was burned beyond the principal retired");
    }

    function test_directUnderwaterLiquidationWithARevertingBufferKeepsTheIdentity() public {
        _underwaterVault();
        _fundGsusd(liquidator, 5_000e18);
        vault.setSurplusBuffer(address(new RevertingFeeBuffer()));
        int256 gapBefore = _supplyGap();
        uint256 supplyBefore = gsusd.totalSupply();

        vm.startPrank(liquidator);
        gsusd.approve(address(vault), type(uint256).max);
        vault.liquidate(borrower, 0);
        vm.stopPrank();

        _assertPrincipalLossBooked(0, supplyBefore, 0);
        assertEq(_supplyGap(), gapBefore, "a buffer that refuses fees cannot open a gap");
    }

    function test_badDebtBufferThatAbsorbsNothingLeavesExactlyThePrincipalLost() public {
        _underwaterVault();
        _fundGsusd(liquidator, 5_000e18);
        vault.setSurplusBuffer(address(new MockBadDebtBuffer(address(gsusd), MockBadDebtBuffer.Mode.Revert)));
        int256 gapBefore = _supplyGap();

        vm.startPrank(liquidator);
        gsusd.approve(address(vault), type(uint256).max);
        vault.liquidate(borrower, 0);
        vm.stopPrank();

        assertEq(vault.totalBadDebt(), PRINCIPAL - REPAY, "bad debt is the principal lost, fee excluded");
        assertEq(_supplyGap(), gapBefore);
    }

    // ------------------------------------------------------------------ emergency path

    function test_emergencyUnderwaterLiquidationBanksNoFee() public {
        _underwaterVault();
        _fundBuffer(10_000e18);
        _fundGsusd(liquidator, 5_000e18);
        vault.emergencyPause();
        int256 gapBefore = _supplyGap();
        uint256 feesBefore = buffer.totalFeesReceived();
        uint256 supplyBefore = gsusd.totalSupply();

        vm.startPrank(liquidator);
        gsusd.approve(address(vault), type(uint256).max);
        vault.emergencyLiquidate(borrower, 0);
        vm.stopPrank();

        assertEq(buffer.totalFeesReceived(), feesBefore, "no fee banked");
        _assertPrincipalLossBooked(0, supplyBefore, PRINCIPAL - REPAY);
        assertEq(_supplyGap(), gapBefore);
    }

    // ------------------------------------------------------------------ pool path

    function test_poolUnderwaterLiquidationBanksNoFee() public {
        _underwaterVault();
        _fundBuffer(10_000e18);
        _fundGsusd(depositor, 50_000e18);
        vm.startPrank(depositor);
        gsusd.approve(address(pool), 50_000e18);
        pool.deposit(50_000e18);
        vm.stopPrank();
        int256 gapBefore = _supplyGap();
        uint256 feesBefore = buffer.totalFeesReceived();
        uint256 supplyBefore = gsusd.totalSupply();
        uint256 poolBefore = pool.getTotalDeposits();

        vm.prank(keeper);
        vault.liquidateViaPool(borrower, 0);

        assertEq(poolBefore - pool.getTotalDeposits(), REPAY, "the pool paid the discounted value");
        assertEq(buffer.totalFeesReceived(), feesBefore, "no fee banked");
        _assertPrincipalLossBooked(0, supplyBefore, PRINCIPAL - REPAY);
        assertEq(_supplyGap(), gapBefore);
    }

    function test_poolUnderwaterLiquidationWithNoBufferKeepsTheIdentity() public {
        _underwaterVault();
        _fundGsusd(depositor, 50_000e18);
        vm.startPrank(depositor);
        gsusd.approve(address(pool), 50_000e18);
        pool.deposit(50_000e18);
        vm.stopPrank();
        vault.setSurplusBuffer(address(0));
        int256 gapBefore = _supplyGap();
        uint256 supplyBefore = gsusd.totalSupply();

        vm.prank(keeper);
        vault.liquidateViaPool(borrower, 0);

        _assertPrincipalLossBooked(0, supplyBefore, 0);
        assertEq(_supplyGap(), gapBefore);
    }

    // ------------------------------------------------------------------ fee splitter

    function test_feeSplitterAccruesNothingToTheBeneficiaryWhenPrincipalIsLost() public {
        _underwaterVault();
        _fundBuffer(10_000e18); // well above the floor, so a fee would be split
        FeeSplitter splitter = new FeeSplitter(address(gsusd), address(buffer));
        buffer.grantRole(buffer.VAULT_ROLE(), address(splitter));
        splitter.grantRole(splitter.VAULT_ROLE(), address(vault));
        splitter.setBeneficiary(beneficiary);
        splitter.setBeneficiaryShare(5000);
        vault.setSurplusBuffer(address(splitter));
        assertGe(buffer.gsusdBalance(), splitter.effectiveBufferFloor(), "the split is live");

        _fundGsusd(liquidator, 5_000e18);
        int256 gapBefore = _supplyGap();
        uint256 feesBefore = buffer.totalFeesReceived();

        vm.startPrank(liquidator);
        gsusd.approve(address(vault), type(uint256).max);
        vault.liquidate(borrower, 0);
        vm.stopPrank();

        assertEq(splitter.beneficiaryAccrued(), 0, "the beneficiary earns nothing from a loss");
        assertEq(splitter.totalFeesReceivedFrom(address(vault)), 0, "no fee reached the splitter");
        assertEq(buffer.totalFeesReceived(), feesBefore);
        assertEq(vault.totalBadDebt(), 0, "the buffer absorbed the principal lost");
        assertEq(_supplyGap(), gapBefore);
    }

    // ------------------------------------------------------------------ boundaries

    /// The gold covers the principal but not all of the fee: the principal is retired in
    /// full, the fee actually recovered is banked, the rest of the fee is forgone and no
    /// bad debt is booked, because no GSUSD is left unbacked.
    function test_goldCoveringPrincipalButNotTheWholeFeeBanksOnlyTheFeeRecovered() public {
        _open(borrower, paxg, 1.125e18, PRINCIPAL);
        vm.warp(block.timestamp + 365 days);
        _setPrice(PRICE);
        oracle.getTokenPrice(address(paxg));
        oracle.getTokenPrice(address(xaut));
        // 1.125 PAXG * 2,844.44444444 = 3,200 USD: above the 3,000 principal, below the debt.
        _walkPrice(284_444_444_444);
        uint256 currentDebt = vault.getVaultCurrentDebt(borrower);
        assertGt(currentDebt, 3_200e18);

        _fundBuffer(10_000e18);
        _fundGsusd(liquidator, 5_000e18);
        int256 gapBefore = _supplyGap();
        uint256 feesBefore = buffer.totalFeesReceived();
        uint256 liquidatorBefore = gsusd.balanceOf(liquidator);

        vm.startPrank(liquidator);
        gsusd.approve(address(vault), type(uint256).max);
        vault.liquidate(borrower, 0);
        vm.stopPrank();

        uint256 paid = liquidatorBefore - gsusd.balanceOf(liquidator);
        assertGt(paid, PRINCIPAL, "the payment exceeds the principal");
        assertLt(paid, currentDebt, "and falls short of the fee-inclusive debt");
        assertEq(buffer.totalFeesReceived() - feesBefore, paid - PRINCIPAL, "only the fee recovered is banked");
        assertEq(vault.totalBadDebt(), 0, "no principal was lost, so no bad debt");
        assertEq(buffer.totalBadDebtAbsorbed(), 0);
        (, uint256 coll, uint256 debt) = _vault(borrower);
        assertEq(coll, 0);
        assertEq(debt, 0);
        assertEq(module.getCurrentDebt(borrower, paxgId), 0, "the unrecovered fee is cleared");
        assertEq(_supplyGap(), gapBefore);
    }

    /// A solvent liquidation is untouched: the payment still splits pro rata.
    function test_solventPartialLiquidationStillSplitsProRata() public {
        _open(borrower, paxg, 1.125e18, PRINCIPAL);
        vm.warp(block.timestamp + 365 days);
        _setPrice(PRICE);
        oracle.getTokenPrice(address(paxg));
        oracle.getTokenPrice(address(xaut));
        // 1.125 PAXG * 3,200 = 3,600 USD against about 3,315 of debt: 108.6%.
        _walkPrice(3_200e8);
        uint256 currentDebt = vault.getVaultCurrentDebt(borrower);

        _fundGsusd(liquidator, 5_000e18);
        int256 gapBefore = _supplyGap();
        uint256 feesBefore = buffer.totalFeesReceived();
        uint256 repay = 1_000e18;

        vm.startPrank(liquidator);
        gsusd.approve(address(vault), type(uint256).max);
        vault.liquidate(borrower, repay);
        vm.stopPrank();

        uint256 principalShare = Math.mulDiv(PRINCIPAL, repay, currentDebt);
        (,, uint256 debt) = _vault(borrower);
        assertEq(PRINCIPAL - debt, principalShare, "principal retired pro rata");
        assertEq(buffer.totalFeesReceived() - feesBefore, repay - principalShare, "fee banked pro rata");
        assertEq(vault.totalBadDebt(), 0);
        assertEq(_supplyGap(), gapBefore);
    }

    /// With no fee accrued the two allocations coincide; the booking is unchanged.
    function test_underwaterVaultWithoutAccruedFeeBooksTheSameBadDebtAsBefore() public {
        _open(borrower, paxg, 1.125e18, PRINCIPAL);
        _walkPrice(177_777_777_778);
        assertEq(vault.getVaultCurrentDebt(borrower), PRINCIPAL, "no fee yet");
        vault.setSurplusBuffer(address(0));
        _fundGsusd(liquidator, 5_000e18);
        int256 gapBefore = _supplyGap();

        vm.startPrank(liquidator);
        gsusd.approve(address(vault), type(uint256).max);
        vault.liquidate(borrower, 0);
        vm.stopPrank();

        assertEq(vault.totalBadDebt(), PRINCIPAL - REPAY);
        assertEq(_supplyGap(), gapBefore);
    }

    /// Any underwater vault, any fee: supply equals debt plus bad debt afterwards, and the
    /// buffer's fee counter moves only when the payment exceeded the principal.
    function testFuzz_underwaterLiquidationConservesSupply(uint256 elapsed, uint256 priceSeed, bool viaPool) public {
        elapsed = bound(elapsed, 0, 5 * 365 days);
        // From 20% to 99% of the principal's value per 1.125 PAXG.
        uint256 value = bound(priceSeed, 600e18, 2_970e18);
        int256 price = int256(value * 1e8 / 1.125e18);

        _open(borrower, paxg, 1.125e18, PRINCIPAL);
        if (elapsed > 0) {
            vm.warp(block.timestamp + elapsed);
            _setPrice(PRICE);
            oracle.getTokenPrice(address(paxg));
            oracle.getTokenPrice(address(xaut));
        }
        _walkPrice(price);
        _fundBuffer(10_000e18);
        _fundGsusd(liquidator, 60_000e18);
        if (viaPool) {
            vm.startPrank(liquidator);
            gsusd.approve(address(pool), 50_000e18);
            pool.deposit(50_000e18);
            vm.stopPrank();
        }
        int256 gapBefore = _supplyGap();
        uint256 feesBefore = buffer.totalFeesReceived();

        vm.startPrank(liquidator);
        gsusd.approve(address(vault), type(uint256).max);
        if (viaPool) vault.liquidateViaPool(borrower, 0);
        else vault.liquidate(borrower, 0);
        vm.stopPrank();

        assertEq(_supplyGap(), gapBefore, "supply == debt + bad debt");
        assertEq(buffer.totalFeesReceived(), feesBefore, "principal was lost, so no fee is banked");
        (, uint256 coll, uint256 debt) = _vault(borrower);
        assertEq(coll + debt, 0, "vault closed");
    }
    /// A liquidator cannot choose an amount that turns a solvent vault's payment into
    /// principal only (dodging the fee) or that books bad debt: while the gold covers the
    /// debt, every partial that is accepted leaves gold in the vault and splits pro rata.
    function testFuzz_solventVaultAlwaysSplitsProRataAndBooksNoBadDebt(uint256 ratioSeed, uint256 repaySeed) public {
        _open(borrower, paxg, 1.125e18, PRINCIPAL);
        vm.warp(vm.getBlockTimestamp() + 365 days);
        _setPrice(PRICE);
        oracle.getTokenPrice(address(paxg));
        oracle.getTokenPrice(address(xaut));
        uint256 currentDebt = vault.getVaultCurrentDebt(borrower);
        // Between 100.1% and 109.9% of the fee-inclusive debt: liquidatable and solvent.
        uint256 value = currentDebt * bound(ratioSeed, 1_001, 1_099) / 1_000;
        _walkPrice(int256(value * 1e8 / 1.125e18));
        uint256 repay = bound(repaySeed, 1e18, currentDebt);

        _fundGsusd(liquidator, 5_000e18);
        int256 gapBefore = _supplyGap();
        uint256 feesBefore = buffer.totalFeesReceived();
        vm.startPrank(liquidator);
        gsusd.approve(address(vault), type(uint256).max);
        try vault.liquidate(borrower, repay) {
            (, uint256 coll, uint256 debt) = _vault(borrower);
            uint256 principalShare = repay == currentDebt ? PRINCIPAL : Math.mulDiv(PRINCIPAL, repay, currentDebt);
            assertEq(PRINCIPAL - debt, principalShare, "principal retired pro rata");
            assertEq(buffer.totalFeesReceived() - feesBefore, repay - principalShare, "fee banked pro rata");
            if (repay < currentDebt) assertGt(coll, 0, "a partial leaves gold in the vault");
        } catch {
            // Refused (a residual below the minimum debt, say): nothing changed.
            assertEq(buffer.totalFeesReceived(), feesBefore);
        }
        vm.stopPrank();
        assertEq(vault.totalBadDebt(), 0, "a solvent vault books no bad debt");
        assertEq(buffer.totalBadDebtAbsorbed(), 0);
        assertEq(_supplyGap(), gapBefore);
    }

    /// Walking away from an underwater vault through one's own liquidation costs the
    /// protocol no more than before: the buffer's net position (fees banked less bad debt
    /// absorbed) falls by exactly the principal the gold did not cover.
    function test_selfLiquidationUnderWaterCostsTheBufferOnlyThePrincipalLost() public {
        _underwaterVault();
        _fundBuffer(10_000e18);
        _fundGsusd(borrower, 5_000e18);
        uint256 netBefore = buffer.gsusdBalance();

        vm.startPrank(borrower);
        gsusd.approve(address(vault), type(uint256).max);
        vault.liquidate(borrower, 0);
        vm.stopPrank();

        assertEq(netBefore - buffer.gsusdBalance(), PRINCIPAL - REPAY);
    }
}
