// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Test} from "forge-std/Test.sol";
import {GoldStablecoin} from "../src/core/GoldStablecoin.sol";
import {SurplusBuffer} from "../src/core/SurplusBuffer.sol";
import {FeeSplitter} from "../src/core/FeeSplitter.sol";
import {MockERC20} from "../src/test/mocks/MockERC20.sol";

/// @notice The automatic reserve floor (docs/BUSINESS_MODEL.md section 5): withdrawGsusd keeps
///         at least 2% of max(live supply, one day smoothed supply) in the buffer, with
///         minGsusdReserve as an optional higher governed minimum. absorbBadDebt ignores it.
contract AutoReserveFloorTest is Test {
    GoldStablecoin internal gsusd;
    SurplusBuffer internal buffer;
    address internal holder = address(0xB0B);
    address internal ops = address(0x0B5);

    function setUp() public {
        vm.warp(1_000_000);
        gsusd = new GoldStablecoin();
        gsusd.grantRole(gsusd.MINTER_ROLE(), address(this));
        buffer = new SurplusBuffer(address(gsusd));
        buffer.grantRole(buffer.VAULT_ROLE(), address(this));
        gsusd.approve(address(buffer), type(uint256).max);
    }

    function _fund(uint256 amount) internal {
        gsusd.mint(address(this), amount);
        buffer.depositFee(amount);
    }

    function test_zeroSupplyNeedsNoFloor() public view {
        assertEq(buffer.AUTO_FLOOR_BPS(), 200);
        assertEq(buffer.autoMinGsusdReserve(), 0);
        assertEq(buffer.effectiveMinGsusdReserve(), 0);
    }

    function test_floorGrowsWithSupply() public {
        gsusd.mint(holder, 100_000e18);
        assertEq(buffer.effectiveMinGsusdReserve(), 2_000e18, "2% of supply");
        gsusd.mint(holder, 100_000e18);
        assertEq(buffer.effectiveMinGsusdReserve(), 4_000e18, "a mint raises it at once");
    }

    function test_floorRoundsUp() public {
        gsusd.mint(holder, 51);
        // 2% of 51 wei is 1.02 wei: the buffer keeps 2, never less than the policy.
        assertEq(buffer.autoMinGsusdReserve(), 2);
    }

    function test_burnInsideSmoothingWindowDoesNotLowerFloor() public {
        gsusd.mint(holder, 100_000e18);
        // Absolute stamps: via_ir may cache block.timestamp across warps in one test.
        uint256 burnAt = 1_000_000 + 2 days;
        vm.warp(burnAt);
        assertEq(buffer.effectiveMinGsusdReserve(), 2_000e18);

        vm.prank(holder);
        gsusd.burn(50_000e18);
        assertEq(gsusd.totalSupply(), 50_000e18);
        assertEq(buffer.effectiveMinGsusdReserve(), 2_000e18, "same block: the burn is not credited");

        vm.warp(burnAt + 12 hours);
        assertEq(buffer.effectiveMinGsusdReserve(), 1_500e18, "half a day: half credited");

        vm.warp(burnAt + 1 days);
        assertEq(buffer.effectiveMinGsusdReserve(), 1_000e18, "a day later the floor follows the burn");
    }

    function test_burnCannotUnlockAWithdrawalInTheSameBlock() public {
        gsusd.mint(holder, 100_000e18);
        _fund(4_000e18); // supply 104,000: floor 2,080
        vm.warp(block.timestamp + 2 days);
        vm.prank(holder);
        gsusd.burn(100_000e18); // live supply 4,000: a naive floor would be 80
        vm.expectRevert("Would breach min GSUSD reserve");
        buffer.withdrawGsusd(ops, 3_000e18);
        buffer.withdrawGsusd(ops, 1_920e18); // 4,000 - 2,080
        assertEq(buffer.gsusdBalance(), 2_080e18);
    }

    function test_withdrawExactlyAtFloorAndOneWeiOver() public {
        gsusd.mint(holder, 96_000e18);
        _fund(4_000e18); // supply 100,000: floor 2,000, headroom 2,000
        assertEq(buffer.effectiveMinGsusdReserve(), 2_000e18);
        vm.expectRevert("Would breach min GSUSD reserve");
        buffer.withdrawGsusd(ops, 2_000e18 + 1);
        buffer.withdrawGsusd(ops, 2_000e18);
        assertEq(buffer.gsusdBalance(), 2_000e18);
        assertEq(gsusd.balanceOf(ops), 2_000e18);
        vm.expectRevert("Would breach min GSUSD reserve");
        buffer.withdrawGsusd(ops, 1);
    }

    function test_governedMinimumAboveAutomaticBinds() public {
        gsusd.mint(holder, 96_000e18);
        _fund(4_000e18);
        buffer.setMinGsusdReserve(3_500e18);
        assertEq(buffer.autoMinGsusdReserve(), 2_000e18);
        assertEq(buffer.effectiveMinGsusdReserve(), 3_500e18);
        vm.expectRevert("Would breach min GSUSD reserve");
        buffer.withdrawGsusd(ops, 500e18 + 1);
        buffer.withdrawGsusd(ops, 500e18);
    }

    function test_governedMinimumBelowAutomaticHasNoEffect() public {
        gsusd.mint(holder, 96_000e18);
        _fund(4_000e18);
        buffer.setMinGsusdReserve(1e18);
        assertEq(buffer.effectiveMinGsusdReserve(), 2_000e18);
        vm.expectRevert("Would breach min GSUSD reserve");
        buffer.withdrawGsusd(ops, 2_000e18 + 1);
    }

    function test_absorbBadDebtIgnoresTheFloor() public {
        gsusd.mint(holder, 96_000e18);
        _fund(4_000e18);
        buffer.setMinGsusdReserve(4_000e18);
        uint256 before = gsusd.balanceOf(address(this));
        uint256 supplyBefore = gsusd.totalSupply();
        buffer.absorbBadDebt(10_000e18);
        assertEq(buffer.gsusdBalance(), 0, "the whole balance is first-loss capital");
        assertEq(supplyBefore - gsusd.totalSupply(), 4_000e18, "burned in the buffer");
        assertEq(gsusd.balanceOf(address(this)), before, "and never paid to the caller");
    }

    function test_aTokenWithoutSmoothedSupplyFailsClosed() public {
        MockERC20 plain = new MockERC20("Plain", "P", 18);
        SurplusBuffer bare = new SurplusBuffer(address(plain));
        bare.grantRole(bare.VAULT_ROLE(), address(this));
        plain.mint(address(this), 1_000e18);
        plain.approve(address(bare), type(uint256).max);
        bare.depositFee(1_000e18);
        vm.expectRevert();
        bare.effectiveMinGsusdReserve();
        vm.expectRevert();
        bare.withdrawGsusd(ops, 1);
        bare.absorbBadDebt(1_000e18);
        assertEq(bare.gsusdBalance(), 0, "bad debt absorption never depends on the floor");
    }

    function testFuzz_withdrawalNeverLeavesLessThanTwoPercent(uint96 supply, uint96 fees, uint96 amount) public {
        vm.assume(fees > 0);
        gsusd.mint(holder, supply);
        _fund(fees);
        uint256 total = uint256(supply) + fees;
        uint256 floor = (total * 200 + 9_999) / 10_000;
        if (uint256(amount) > fees || fees - uint256(amount) < floor) {
            vm.expectRevert();
            buffer.withdrawGsusd(ops, amount);
        } else {
            buffer.withdrawGsusd(ops, amount);
            assertGe(buffer.gsusdBalance() * 10_000, total * 200);
        }
    }

    function test_feeSplitterHonoursTheAutomaticFloor() public {
        FeeSplitter splitter = new FeeSplitter(address(gsusd), address(buffer));
        buffer.grantRole(buffer.VAULT_ROLE(), address(splitter));
        splitter.grantRole(splitter.VAULT_ROLE(), address(this));
        splitter.setBeneficiary(ops);
        splitter.setBeneficiaryShare(5_000);
        gsusd.mint(holder, 100_000e18); // floor 2,000 before any fee
        assertEq(splitter.bufferFloor(), 0);
        assertEq(splitter.effectiveBufferFloor(), 2_000e18);

        gsusd.mint(address(this), 2_000e18); // supply 102,000: floor 2,040
        gsusd.approve(address(splitter), type(uint256).max);
        splitter.depositFee(2_000e18);
        assertEq(splitter.beneficiaryAccrued(), 0, "below the floor nothing is split");
        assertEq(buffer.gsusdBalance(), 2_000e18);

        gsusd.mint(address(this), 2_000e18); // supply 104,000: floor 2,080, shortfall 80
        splitter.depositFee(2_000e18);
        assertEq(splitter.beneficiaryAccrued(), 960e18, "half of the 1,920 above the floor");
    }
}
