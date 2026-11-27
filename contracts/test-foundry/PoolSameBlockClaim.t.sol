// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {FullStackHarness} from "./harness/FullStackHarness.sol";
import {GoldVault} from "../src/core/GoldVault.sol";
import {StabilityPool} from "../src/core/StabilityPool.sol";
import {GoldStablecoin} from "../src/core/GoldStablecoin.sol";
import {MockERC20} from "../src/test/mocks/MockERC20.sol";

/// @dev Lends GSUSD for the length of one call and requires it back before returning.
contract GsusdFlashLender {
    GoldStablecoin internal immutable gsusd;

    constructor(GoldStablecoin gsusd_) {
        gsusd = gsusd_;
    }

    function flash(uint256 amount, bytes calldata data) external {
        uint256 before = gsusd.balanceOf(address(this));
        gsusd.transfer(msg.sender, amount);
        PoolCaptureAttacker(msg.sender).onFlash(amount, data);
        require(gsusd.balanceOf(address(this)) >= before, "Flash loan not repaid");
    }
}

/// @dev Buys gold for GSUSD at a fixed price (8 decimals), standing in for any market.
contract GoldBuyer {
    GoldStablecoin internal immutable gsusd;
    MockERC20 internal immutable gold;
    uint256 internal immutable price;

    constructor(GoldStablecoin gsusd_, MockERC20 gold_, uint256 price_) {
        gsusd = gsusd_;
        gold = gold_;
        price = price_;
    }

    function sell(uint256 goldIn) external returns (uint256 gsusdOut) {
        gold.transferFrom(msg.sender, address(this), goldIn);
        gsusdOut = goldIn * price / 1e8;
        gsusd.transfer(msg.sender, gsusdOut);
    }
}

/// @dev Holds nothing of its own. Borrows GSUSD, deposits it in the pool, liquidates a vault
///      through the pool, tries to leave with the gold and repays the loan, in one transaction.
contract PoolCaptureAttacker {
    GoldVault internal immutable vault;
    StabilityPool internal immutable pool;
    GoldStablecoin internal immutable gsusd;
    MockERC20 internal immutable gold;
    GsusdFlashLender internal immutable lender;
    GoldBuyer internal immutable market;

    constructor(
        GoldVault vault_,
        StabilityPool pool_,
        GoldStablecoin gsusd_,
        MockERC20 gold_,
        GsusdFlashLender lender_,
        GoldBuyer market_
    ) {
        vault = vault_;
        pool = pool_;
        gsusd = gsusd_;
        gold = gold_;
        lender = lender_;
        market = market_;
    }

    function attack(address victim, uint256 borrow) external {
        lender.flash(borrow, abi.encode(victim));
    }

    function onFlash(uint256 amount, bytes calldata data) external {
        address victim = abi.decode(data, (address));
        gsusd.approve(address(pool), amount);
        pool.deposit(amount);
        vault.liquidateViaPool(victim, 0);
        pool.claimCollateral(address(gold));
        uint256 owed = amount - gsusd.balanceOf(address(this));
        // Sell just enough gold to repay; the rest is the captured penalty.
        uint256 goldToSell = owed * 1e8 / 2_900e8 + 1;
        gold.approve(address(market), goldToSell);
        market.sell(goldToSell);
        gsusd.transfer(address(lender), amount);
    }

    /// @dev The other pool exit, for the test that tries it.
    function depositThenWithdraw(uint256 amount) external {
        gsusd.approve(address(pool), amount);
        pool.deposit(amount);
        pool.withdraw(amount);
    }
}

/// @notice A stability pool deposit must outlive its block before anything leaves the pool
///         for the depositor. Without that, borrowed GSUSD deposited, used to absorb a
///         liquidation and turned into the seized gold in one transaction takes the whole
///         penalty with no capital and no exposure.
contract PoolSameBlockClaimTest is FullStackHarness {
    address internal borrower = address(0xB0);
    address internal standing = address(0xD0);
    address internal keeper = address(0xEE);

    GsusdFlashLender internal lender;
    GoldBuyer internal market;
    PoolCaptureAttacker internal attacker;

    uint256 internal constant DEBT = 266_000e18;

    function setUp() public override {
        super.setUp();
        // 100 PAXG at $4,000 against 266,000 GSUSD: 150.4%.
        _open(borrower, paxg, 100e18, DEBT);

        lender = new GsusdFlashLender(gsusd);
        market = new GoldBuyer(gsusd, paxg, 2_900e8);
        attacker = new PoolCaptureAttacker(vault, pool, gsusd, paxg, lender, market);
        _fundGsusd(address(lender), 1_000_000e18);
        _fundGsusd(address(market), 1_000_000e18);

        // Gold falls to $2,900: the vault sits at 109%, liquidatable with the full 5% penalty.
        _walkPrice(2_900e8);
        vm.roll(vm.getBlockNumber() + 1);
    }

    function _deposit(address who, uint256 amount) internal {
        _fundGsusd(who, amount);
        vm.startPrank(who);
        gsusd.approve(address(pool), amount);
        pool.deposit(amount);
        vm.stopPrank();
    }

    // ------------------------------------------------------------------
    // The atomic capture
    // ------------------------------------------------------------------

    function test_borrowedDepositCannotLiquidateAndClaimInOneTransaction() public {
        assertEq(pool.getTotalDeposits(), 0, "the pool starts empty");
        assertEq(paxg.balanceOf(address(attacker)), 0);
        assertEq(gsusd.balanceOf(address(attacker)), 0);

        vm.expectRevert("No same-block claim");
        attacker.attack(borrower, DEBT + 1);

        // Nothing moved: the vault is intact and still liquidatable by an honest caller.
        (, uint256 coll, uint256 debt) = _vault(borrower);
        assertEq(coll, 100e18);
        assertEq(debt, DEBT);
        assertEq(paxg.balanceOf(address(attacker)), 0, "no gold captured");
    }

    function test_borrowedDepositCannotCaptureAgainstAStandingPoolEither() public {
        // A standing pool smaller than the debt: the attacker tops it up for one transaction.
        _deposit(standing, 100_000e18);
        vm.roll(vm.getBlockNumber() + 1);

        vm.expectRevert("No same-block claim");
        attacker.attack(borrower, DEBT);
    }

    function test_standingDustDepositDoesNotExemptALaterBorrowedTopUp() public {
        // The attacker parks one wei in the pool in an earlier block, hoping the older
        // deposit carries the claim. The borrowed top-up is a deposit: it restarts the wait.
        _fundGsusd(address(attacker), 1_000e18);
        vm.startPrank(address(attacker));
        gsusd.approve(address(pool), 1);
        pool.deposit(1);
        vm.stopPrank();
        vm.roll(vm.getBlockNumber() + 5);

        vm.expectRevert("No same-block claim");
        attacker.attack(borrower, DEBT + 1);
    }

    function test_claimInALaterTransactionOfTheSameBlockIsRefusedToo() public {
        // Splitting the steps over two transactions that a builder places in one block
        // changes nothing: the rule is about the block, not the transaction.
        _deposit(keeper, DEBT + 1e18);
        vm.prank(keeper);
        vault.liquidateViaPool(borrower, 0);
        vm.warp(vm.getBlockTimestamp() + 1); // a later transaction, same block number
        vm.prank(keeper);
        vm.expectRevert("No same-block claim");
        pool.claimCollateral(address(paxg));
        vm.prank(keeper);
        vm.expectRevert("No same-block claim");
        pool.claimCollateral(address(xaut));
    }

    function test_depositThenWithdrawInOneTransactionStaysRefused() public {
        _fundGsusd(address(attacker), 1_000e18);
        vm.expectRevert("No same-block withdrawal");
        attacker.depositThenWithdraw(1_000e18);
    }

    // ------------------------------------------------------------------
    // What the rule leaves open, by design
    // ------------------------------------------------------------------

    function test_depositHeldForABlockLiquidatesThroughThePoolAndClaims() public {
        // Real GSUSD, held across a block boundary: ordinary participation in the pool.
        _deposit(keeper, DEBT + 1e18);
        vm.prank(keeper);
        vault.liquidateViaPool(borrower, 0);

        vm.prank(keeper);
        vm.expectRevert("No same-block claim");
        pool.claimCollateral(address(paxg));

        vm.roll(vm.getBlockNumber() + 1);
        uint256 owed = pool.getCollateralGain(keeper, address(paxg));
        uint256 bounty = paxg.balanceOf(keeper);
        vm.prank(keeper);
        pool.claimCollateral(address(paxg));
        assertEq(paxg.balanceOf(keeper), bounty + owed, "the whole gain is paid a block later");
        // Debt-equivalent gold plus the whole 5% penalty: bounty to the caller, rest via the pool.
        uint256 expected = DEBT * 1e8 / 2_900e8 * 105 / 100;
        assertApproxEqAbs(bounty + owed, expected, 1e6, "seizure reaches the depositor in full");
    }

    // ------------------------------------------------------------------
    // Honest depositors
    // ------------------------------------------------------------------

    function test_standingDepositorClaimsWithoutWaiting() public {
        _deposit(standing, 500_000e18);
        vm.roll(vm.getBlockNumber() + 1);

        vm.prank(keeper);
        vault.liquidateViaPool(borrower, 0);

        // Deposited in an earlier block: the claim works in the liquidation's own block.
        uint256 owed = pool.getCollateralGain(standing, address(paxg));
        assertGt(owed, 0);
        vm.prank(standing);
        pool.claimCollateral(address(paxg));
        assertEq(paxg.balanceOf(standing), owed);
        assertEq(pool.getCollateralGain(standing, address(paxg)), 0);
    }

    function test_topUpDelaysAnOlderGainByOneBlockAndLosesNothing() public {
        _deposit(standing, 500_000e18);
        vm.roll(vm.getBlockNumber() + 1);
        vm.prank(keeper);
        vault.liquidateViaPool(borrower, 0);
        vm.roll(vm.getBlockNumber() + 1);

        uint256 owed = pool.getCollateralGain(standing, address(paxg));
        assertGt(owed, 0);

        // A top-up is a deposit: the older gain now waits for the next block as well.
        _deposit(standing, 1_000e18);
        assertEq(pool.getCollateralGain(standing, address(paxg)), owed, "the gain is still owed in full");
        vm.prank(standing);
        vm.expectRevert("No same-block claim");
        pool.claimCollateral(address(paxg));

        vm.roll(vm.getBlockNumber() + 1);
        vm.prank(standing);
        pool.claimCollateral(address(paxg));
        assertEq(paxg.balanceOf(standing), owed, "paid in full one block later");
    }

    function test_oneDepositorsBlockDoesNotHoldUpAnother() public {
        _deposit(standing, 500_000e18);
        vm.roll(vm.getBlockNumber() + 1);
        vm.prank(keeper);
        vault.liquidateViaPool(borrower, 0);

        // Somebody else deposits in this block; the standing depositor is unaffected.
        _deposit(address(0xD1), 10_000e18);
        vm.prank(standing);
        pool.claimCollateral(address(paxg));
        assertGt(paxg.balanceOf(standing), 0);
    }

    function test_gainsCannotBeCollectedByAnotherAddress() public {
        _deposit(keeper, DEBT + 1e18);
        vm.prank(keeper);
        vault.liquidateViaPool(borrower, 0);

        // The gain belongs to the depositing address; a second address has nothing to claim.
        address accomplice = address(0xAC);
        assertEq(pool.getCollateralGain(accomplice, address(paxg)), 0);
        vm.prank(accomplice);
        vm.expectRevert("No gains");
        pool.claimCollateral(address(paxg));
    }

    // ------------------------------------------------------------------
    // Pause, epoch reset and scale change
    // ------------------------------------------------------------------

    function test_claimStaysOpenWhileThePoolIsPausedAndKeepsTheBlockRule() public {
        _deposit(keeper, DEBT + 1e18);
        vm.prank(keeper);
        vault.liquidateViaPool(borrower, 0);

        pool.emergencyPause();
        assertTrue(pool.paused());

        // The pause does not gate a claim; the block rule still applies in the deposit's block.
        vm.prank(keeper);
        vm.expectRevert("No same-block claim");
        pool.claimCollateral(address(paxg));

        vm.roll(vm.getBlockNumber() + 1);
        vm.prank(keeper);
        pool.claimCollateral(address(paxg));
        assertGt(paxg.balanceOf(keeper), 0, "claims are paid during a pause");
    }

    function test_epochResetDoesNotOpenASameBlockClaim() public {
        // One wei more than the debt: the absorption leaves a remainder small enough to reset
        // the pool's epoch, which wipes the deposit and leaves the gain in the old epoch.
        _deposit(keeper, DEBT + 1);
        uint128 epochBefore = pool.currentEpoch();
        vm.prank(keeper);
        vault.liquidateViaPool(borrower, 0);
        assertEq(pool.currentEpoch(), epochBefore + 1, "epoch reset");
        assertEq(pool.getEffectiveDeposit(keeper), 0, "the remainder is wiped");

        vm.prank(keeper);
        vm.expectRevert("No same-block claim");
        pool.claimCollateral(address(paxg));

        vm.roll(vm.getBlockNumber() + 1);
        uint256 owed = pool.getCollateralGain(keeper, address(paxg));
        uint256 before = paxg.balanceOf(keeper);
        vm.prank(keeper);
        pool.claimCollateral(address(paxg));
        assertEq(paxg.balanceOf(keeper) - before, owed, "old-epoch gain paid a block later");
    }

    function test_scaleChangeDoesNotOpenASameBlockClaim() public {
        // Two absorptions that each leave a hundred-thousandth of the pool push the product
        // factor through a scale change. Driven on the pool directly, as the vault would.
        pool.grantRole(pool.VAULT_ROLE(), address(this));
        _deposit(keeper, 100_000e18);
        uint128 scaleBefore = pool.currentScale();
        for (uint256 i = 0; i < 2; i++) {
            uint256 total = pool.getTotalDeposits();
            paxg.mint(address(pool), 1e18);
            pool.absorbLiquidationPrefunded(address(paxg), total - total / 100_000);
        }
        assertEq(pool.currentScale(), scaleBefore + 1, "scale changed");

        vm.prank(keeper);
        vm.expectRevert("No same-block claim");
        pool.claimCollateral(address(paxg));

        vm.roll(vm.getBlockNumber() + 1);
        vm.prank(keeper);
        pool.claimCollateral(address(paxg));
        assertApproxEqAbs(paxg.balanceOf(keeper), 2e18, 1e6, "both gains paid across the scale change");
    }
}
