// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import "forge-std/Test.sol";
import {SiloFactory, CollateralSilo} from "../src/core/CollateralSilo.sol";
import {MockERC20NoReturn} from "../src/test/mocks/MockERC20NoReturn.sol";
import {MockERC20} from "../src/test/mocks/MockERC20.sol";
import {MockERC20SilentFail} from "../src/test/mocks/MockERC20SilentFail.sol";
import {MockERC20FeeOnTransfer} from "../src/test/mocks/MockERC20FeeOnTransfer.sol";
import {MockERC20Freezable} from "../src/test/mocks/MockERC20Freezable.sol";

/// @notice A silo deposit accepts a token whose transferFrom returns no value. What decides
///         a leg is unchanged: the call must not fail, and the silo's balance must have
///         risen. Decoding a boolean from the call made every deposit of such a token revert.
contract SiloNoReturnTokenTest is Test {
    SiloFactory internal factory;
    MockERC20NoReturn internal token;
    address internal recipient = address(0xBEEF);

    event Deposited(address indexed token, address indexed silo, uint256 amount);
    event SiloSkipped(address indexed token, address silo);

    function setUp() public {
        factory = new SiloFactory(100e18);
        factory.grantRole(factory.VAULT_ROLE(), address(this));
        token = new MockERC20NoReturn("No Return Gold", "NRG", 18);
        token.mint(address(this), 10_000e18);
        token.approve(address(factory), type(uint256).max);
    }

    function _silo(address t, uint256 i) internal view returns (address) {
        return factory.getSilo(t, i);
    }

    // ------------------------------------------------------------------ the fix

    function test_tokenThatReturnsNothingCanBeDeposited() public {
        uint256 credited = factory.deposit(address(token), 60e18);
        assertEq(credited, 60e18);
        assertEq(factory.totalCollateral(address(token)), 60e18);
        assertEq(token.balanceOf(_silo(address(token), 0)), 60e18);
    }

    function test_tokenThatReturnsNothingSpansSilosAndWithdraws() public {
        uint256 credited = factory.deposit(address(token), 250e18);
        assertEq(credited, 250e18);
        assertEq(factory.getSiloCount(address(token)), 3);
        assertEq(token.balanceOf(_silo(address(token), 0)), 100e18);
        assertEq(token.balanceOf(_silo(address(token), 2)), 50e18);

        factory.withdraw(address(token), recipient, 180e18);
        assertEq(token.balanceOf(recipient), 180e18);
        assertEq(factory.totalCollateral(address(token)), 70e18);
        factory.withdraw(address(token), recipient, 70e18);
        assertTrue(factory.isEmpty());
    }

    // ------------------------------------------------------------------ what must not change

    /// No return value, no revert, nothing moved: the measured delta is zero, so the leg
    /// fails and the deposit reverts once the skip budget is spent. Nothing is credited.
    function test_noReturnTokenThatMovesNothingStillFailsTheLeg() public {
        token.setSwallow(true);
        vm.expectRevert("Too many unusable silos");
        factory.deposit(address(token), 10e18);
        assertEq(factory.totalCollateral(address(token)), 0);
    }

    function test_tokenThatReturnsFalseStillFailsTheLeg() public {
        MockERC20SilentFail silent = new MockERC20SilentFail();
        silent.mint(address(this), 100e18);
        silent.approve(address(factory), type(uint256).max);
        silent.setFailSilently(true);
        vm.expectRevert("Too many unusable silos");
        factory.deposit(address(silent), 10e18);
        assertEq(factory.totalCollateral(address(silent)), 0);
    }

    function test_feeOnTransferTokenIsStillCreditedByWhatArrived() public {
        MockERC20FeeOnTransfer fee = new MockERC20FeeOnTransfer("Fee Gold", "FEE", 100); // 1%
        fee.mint(address(this), 100e18);
        fee.approve(address(factory), type(uint256).max);
        uint256 credited = factory.deposit(address(fee), 50e18);
        assertEq(credited, 49.5e18);
        assertEq(factory.totalCollateral(address(fee)), 49.5e18);
        assertEq(fee.balanceOf(_silo(address(fee), 0)), 49.5e18);
    }

    function test_frozenSiloIsStillSkippedForAnOrdinaryToken() public {
        MockERC20Freezable gold = new MockERC20Freezable("Pax Gold", "PAXG");
        gold.mint(address(this), 100e18);
        gold.approve(address(factory), type(uint256).max);
        factory.deposit(address(gold), 10e18);
        gold.setFrozen(_silo(address(gold), 0), true);

        vm.expectEmit(true, false, false, true, address(factory));
        emit SiloSkipped(address(gold), _silo(address(gold), 0));
        uint256 credited = factory.deposit(address(gold), 10e18);
        assertEq(credited, 10e18);
        assertEq(gold.balanceOf(_silo(address(gold), 1)), 10e18);
        assertEq(factory.totalCollateral(address(gold)), 20e18);
    }

    function test_frozenSiloIsSkippedForATokenThatReturnsNothing() public {
        factory.deposit(address(token), 10e18);
        token.setFrozen(_silo(address(token), 0), true);
        uint256 credited = factory.deposit(address(token), 10e18);
        assertEq(credited, 10e18);
        assertEq(token.balanceOf(_silo(address(token), 1)), 10e18);
        assertEq(factory.currentSiloIndex(address(token)), 1);
    }

    function test_conformingTokenIsUnaffected() public {
        MockERC20 paxg = new MockERC20("Pax Gold", "PAXG", 18);
        paxg.mint(address(this), 1_000e18);
        paxg.approve(address(factory), type(uint256).max);
        assertEq(factory.deposit(address(paxg), 350e18), 350e18);
        assertEq(factory.getSiloCount(address(paxg)), 4);
    }

    function test_missingAllowanceIsAFailedLegNotACredit() public {
        token.approve(address(factory), 0);
        vm.expectRevert("Too many unusable silos");
        factory.deposit(address(token), 10e18);
    }

    function testFuzz_noReturnTokenCreditsExactlyWhatWasDeposited(uint256 amount) public {
        amount = bound(amount, 1, 5_000e18);
        uint256 credited = factory.deposit(address(token), amount);
        assertEq(credited, amount);
        uint256 sum;
        for (uint256 i = 0; i < factory.getSiloCount(address(token)); i++) {
            sum += CollateralSilo(_silo(address(token), i)).balance();
        }
        assertEq(sum, amount);
    }
}
