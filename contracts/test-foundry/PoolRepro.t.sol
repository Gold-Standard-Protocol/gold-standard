// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import "forge-std/Test.sol";
import {StabilityPool} from "../src/core/StabilityPool.sol";
import {GoldStablecoin} from "../src/core/GoldStablecoin.sol";
import {MockERC20} from "../src/test/mocks/MockERC20.sol";

contract PoolReproTest is Test {
    StabilityPool pool;
    GoldStablecoin gsusd;
    MockERC20 paxg;
    address alice = address(0xA11CE);
    address vault = address(0xDEAD);

    function setUp() public {
        gsusd = new GoldStablecoin();
        pool = new StabilityPool(address(gsusd));
        paxg = new MockERC20("Pax Gold", "PAXG", 18);
        pool.addCollateralToken(address(paxg));
        gsusd.grantRole(gsusd.MINTER_ROLE(), address(this));
        pool.grantRole(pool.VAULT_ROLE(), vault);
    }

    function _deposit(address who, uint256 amt) internal {
        gsusd.mint(who, amt);
        vm.startPrank(who);
        gsusd.approve(address(pool), amt);
        pool.deposit(amt);
        vm.stopPrank();
    }

    function _absorb(uint256 debt, uint256 collat) internal {
        // As the vault does it: the gold reaches the pool, then the debt is absorbed.
        paxg.mint(address(pool), collat);
        vm.prank(vault);
        pool.absorbLiquidationPrefunded(address(paxg), debt);
    }

    // Reproduces the shrunk invariant_collateralGainsBounded sequence.
    function test_smallAbsorbGainAccounted() public {
        _deposit(alice, 1e18 + 2623250506);
        _absorb(3336, 1577);
        uint256 gain = pool.getCollateralGain(alice, address(paxg));
        emit log_named_uint("alice gain", gain);
        emit log_named_uint("P", pool.P());
        assertApproxEqAbs(gain, 1577, 5, "sole depositor should be credited the absorbed collateral");
    }

    // A realistic-scale sanity check: large deposit, several absorptions, no stranding.
    function test_realisticScaleGains() public {
        _deposit(alice, 100_000e18);
        _absorb(10_000e18, 1e18);   // ~$2000 worth of 18-dec gold
        _absorb(10_000e18, 1e18);
        uint256 gain = pool.getCollateralGain(alice, address(paxg));
        emit log_named_uint("alice gain (want ~2e18)", gain);
        assertApproxEqAbs(gain, 2e18, 1e6, "sole depositor should get ~all 2 gold");
    }

    // An absorption that leaves exactly one billionth of the pool is the last one that keeps
    // the epoch: the product falls to SCALE_FACTOR, the depositor keeps a billionth of the
    // deposit, and nothing is wiped.
    function test_absorbingAllButOneBillionthKeepsTheEpoch() public {
        _deposit(alice, 1e18);
        _absorb(1e18 - 1e9, 1e18);
        assertEq(pool.currentEpoch(), 0, "the epoch is kept");
        assertEq(pool.currentScale(), 0, "the scale is kept");
        assertEq(pool.P(), 1e9, "the product sits exactly on the scale factor");
        assertEq(pool.getEffectiveDeposit(alice), 1e9, "the depositor keeps a billionth");
        assertEq(pool.totalDeposits(), 1e9);

        vm.roll(block.number + 1);
        vm.prank(alice);
        pool.withdraw(1e9);
        assertEq(gsusd.balanceOf(alice), 1e9, "and can withdraw it");
        assertEq(pool.totalDeposits(), 0);
    }

    // One unit less left in the pool and the epoch resets: the remaining depositor is wiped.
    function test_absorbingOneUnitMoreThanThatResetsTheEpoch() public {
        _deposit(alice, 1e18);
        _absorb(1e18 - 1e9 + 1, 1e18);
        assertEq(pool.currentEpoch(), 1);
        assertEq(pool.getEffectiveDeposit(alice), 0);
    }

    // A new epoch starts from a whole product and scale zero, whatever the old epoch ended on.
    function test_epochResetRestoresPAndScaleAfterEarlierAbsorptions() public {
        _deposit(alice, 1e18);
        _absorb(1e18 - 1e10, 1e18); // one part in 1e8 left: the product is 1e10
        _absorb(1e10 - 1e8, 1e18); // a hundredth of that left: the scale changes
        assertEq(pool.currentScale(), 1, "the pool has changed scale once");
        assertEq(pool.P(), 1e17, "and the product is away from its starting value");
        assertEq(pool.currentEpoch(), 0);

        address bob = address(0xB0B);
        _deposit(bob, 1e18);
        _absorb(1e18, 1e18); // leaves 1e8 of 1e18 + 1e8: under a billionth, a reset
        assertEq(pool.currentEpoch(), 1, "the epoch advanced by one");
        assertEq(pool.currentScale(), 0, "the new epoch starts at scale zero");
        assertEq(pool.P(), 1e18, "and from a whole product");

        // A deposit made in the new epoch compounds from that whole product: half absorbed
        // leaves exactly half.
        address carol = address(0xCA201);
        _deposit(carol, 2e18);
        uint256 total = pool.getTotalDeposits();
        _absorb(total / 2, 1e18);
        assertEq(pool.P(), 5e17);
        assertEq(pool.getEffectiveDeposit(carol), 1e18);
    }

    // Drive P down hard and confirm it never reaches zero and deposits remain usable.
    function test_deepDrainKeepsPpositive() public {
        for (uint256 i = 0; i < 40; i++) {
            _deposit(alice, 1000e18);
            uint256 total = pool.getTotalDeposits();
            _absorb(total - 1e18, 1e18); // absorb almost everything each round
            assertGt(pool.P(), 0, "P must stay positive");
        }
        // A fresh depositor after deep draining must be able to withdraw.
        address bob = address(0xB0B);
        _deposit(bob, 500e18);
        vm.prank(bob);
        vm.roll(block.number + 1); // a deposit cannot leave in its own block (JIT guard)
        pool.withdraw(500e18);
        assertApproxEqAbs(gsusd.balanceOf(bob), 500e18, 1e6, "fresh depositor must withdraw after deep drain");
    }
}
