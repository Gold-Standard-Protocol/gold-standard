// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {FullStackHarness} from "./harness/FullStackHarness.sol";
import {SiloFactory} from "../src/core/CollateralSilo.sol";
import {StabilityPool} from "../src/core/StabilityPool.sol";
import {MockERC20FeeOnTransfer} from "../src/test/mocks/MockERC20FeeOnTransfer.sol";

/// @dev Declares the prefunded path and does not have it.
contract PoolThatOnlyDeclares {
    function hasRole(bytes32, address) external pure returns (bool) {
        return true;
    }

    function getTotalDeposits() external pure returns (uint256) {
        return 1_000_000e18;
    }

    function absorbsPrefunded() external pure returns (bool) {
        return true;
    }
}

/// @dev Declares the prefunded path and cannot report its deposits, the figure the pool
///      liquidation reads before it absorbs anything.
contract PoolThatDeclaresWithoutDeposits {
    function hasRole(bytes32, address) external pure returns (bool) {
        return true;
    }

    function absorbsPrefunded() external pure returns (bool) {
        return true;
    }
}

/// @dev Answers the declaration with a word that is not a boolean.
contract PoolAnsweringTwo {
    function hasRole(bytes32, address) external pure returns (bool) {
        return true;
    }

    function absorbsPrefunded() external pure returns (uint256) {
        return 2;
    }
}

/// @dev The declaration reverts.
contract PoolWhoseDeclarationReverts {
    function hasRole(bytes32, address) external pure returns (bool) {
        return true;
    }

    function absorbsPrefunded() external pure returns (bool) {
        revert("no");
    }
}

/// @dev A token whose transferFrom reports success with a word other than true.
contract TokenReturningTwo {
    mapping(address => uint256) public balanceOf;

    function decimals() external pure returns (uint8) {
        return 18;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (uint256) {
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return 2;
    }
}

/// @dev A token that reports true and moves nothing.
contract TokenClaimingSuccess {
    mapping(address => uint256) public balanceOf;

    function decimals() external pure returns (uint8) {
        return 18;
    }

    function transferFrom(address, address, uint256) external pure returns (bool) {
        return true;
    }
}

/// @dev A token that, while being pulled, calls back into the factory.
contract TokenThatCallsBack {
    mapping(address => uint256) public balanceOf;
    SiloFactory internal factory;
    bool public calledBack;
    bool public callBackSucceeded;

    function decimals() external pure returns (uint8) {
        return 18;
    }

    function arm(SiloFactory factory_) external {
        factory = factory_;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        calledBack = true;
        // The one call on the factory open to anybody; the guard must refuse it mid-deposit.
        try factory.createSilos(address(this), 1) {
            callBackSucceeded = true;
        } catch {}
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

/// @notice What was tried next against three changes: the pool declaration the vault's setter
///         requires, the pool's single absorb function, and the silo deposit leg that accepts
///         a token returning nothing. Each test is a misuse and what the contracts do with it.
contract PoolAndSiloMisuseTest is FullStackHarness {
    address internal borrower = address(0xB0);
    address internal depositor = address(0xD0);
    address internal keeper = address(0xEE);
    SiloFactory internal factory;

    function setUp() public override {
        super.setUp();
        factory = new SiloFactory(100e18);
        factory.grantRole(factory.VAULT_ROLE(), address(this));
    }

    // ------------------------------------------------------------------ the pool declaration

    function test_declarationThatIsNotABooleanIsRefused() public {
        address answeringTwo = address(new PoolAnsweringTwo());
        vm.expectRevert();
        vault.setStabilityPool(answeringTwo);
    }

    /// liquidateViaPool reads the pool's total deposits before it sizes anything, so a pool
    /// that cannot answer that read is refused at wiring time like one without the declaration.
    function test_poolThatDeclaresButCannotReportItsDepositsIsRefused() public {
        address withoutDeposits = address(new PoolThatDeclaresWithoutDeposits());
        vm.expectRevert(bytes(""));
        vault.setStabilityPool(withoutDeposits);
        assertEq(address(vault.stabilityPool()), address(pool), "the working pool stays wired");
    }

    function test_declarationThatRevertsIsRefused() public {
        address reverting = address(new PoolWhoseDeclarationReverts());
        vm.expectRevert();
        vault.setStabilityPool(reverting);
    }

    /// The declaration is a statement by the pool, not a proof. A contract that makes it and
    /// lacks the function is accepted; pool liquidations then revert whole, nothing moves,
    /// and the direct path still liquidates. The check catches a pool of the wrong
    /// generation, which is what it is for; it cannot catch a contract written to lie.
    function test_poolThatDeclaresWithoutTheFunctionIsAcceptedAndOnlyThePoolPathFails() public {
        _open(borrower, paxg, 100e18, 266_000e18);
        _walkPrice(2_900e8);
        vault.setStabilityPool(address(new PoolThatOnlyDeclares()));

        vm.prank(keeper);
        vm.expectRevert();
        vault.liquidateViaPool(borrower, 0);
        (, uint256 coll, uint256 debt) = _vault(borrower);
        assertEq(coll, 100e18, "nothing was seized");
        assertEq(debt, 266_000e18);

        _fundGsusd(keeper, 300_000e18);
        vm.startPrank(keeper);
        gsusd.approve(address(vault), type(uint256).max);
        vault.liquidate(borrower, 0);
        vm.stopPrank();
        (,, debt) = _vault(borrower);
        assertEq(debt, 0, "the direct path is unaffected");
    }

    function test_onlyGovernanceCanReplaceThePool() public {
        StabilityPool replacement = new StabilityPool(address(gsusd));
        replacement.grantRole(replacement.VAULT_ROLE(), address(vault));
        vm.prank(keeper);
        vm.expectRevert();
        vault.setStabilityPool(address(replacement));
    }

    // ------------------------------------------------------------------ the pool's absorb

    function test_absorbingAnUnregisteredTokenIsRefusedEvenWithGoldSentAhead() public {
        _fundGsusd(depositor, 10_000e18);
        vm.startPrank(depositor);
        gsusd.approve(address(pool), 10_000e18);
        pool.deposit(10_000e18);
        vm.stopPrank();
        pool.grantRole(pool.VAULT_ROLE(), address(this));

        MockERC20FeeOnTransfer other = new MockERC20FeeOnTransfer("Other", "OTH", 0);
        other.mint(address(pool), 5e18);
        vm.expectRevert("Unsupported token");
        pool.absorbLiquidationPrefunded(address(other), 1_000e18);
        assertEq(pool.getTotalDeposits(), 10_000e18);
    }

    /// Gold a stranger sends to the pool is not theirs to take back and cannot be used to
    /// take GSUSD: it is credited to the depositors at the next absorption.
    function test_goldSentByAStrangerGoesToDepositorsAtTheNextAbsorption() public {
        _fundGsusd(depositor, 500_000e18);
        vm.startPrank(depositor);
        gsusd.approve(address(pool), 500_000e18);
        pool.deposit(500_000e18);
        vm.stopPrank();
        _open(borrower, paxg, 100e18, 266_000e18);
        _walkPrice(2_900e8);

        paxg.mint(keeper, 7e18);
        vm.prank(keeper);
        paxg.transfer(address(pool), 7e18);
        vm.prank(keeper);
        vm.expectRevert("No gains");
        pool.claimCollateral(address(paxg));

        uint256 keeperBefore = paxg.balanceOf(keeper);
        vm.prank(keeper);
        vault.liquidateViaPool(borrower, 0);
        uint256 bounty = paxg.balanceOf(keeper) - keeperBefore;
        uint256 debtValue = 266_000e18;
        uint256 seized = debtValue * 1e8 / 2_900e8 * 105 / 100;
        assertApproxEqAbs(pool.getCollateralGain(depositor, address(paxg)), seized - bounty + 7e18, 1e6, "the stray gold is the depositors'");
        assertEq(pool.collateralAccounted(address(paxg)), paxg.balanceOf(address(pool)));
    }

    function test_feeOnTransferGoldIsCreditedAtWhatReachedThePool() public {
        MockERC20FeeOnTransfer fee = new MockERC20FeeOnTransfer("Fee Gold", "FEE", 100); // 1%
        pool.addCollateralToken(address(fee));
        pool.grantRole(pool.VAULT_ROLE(), address(this));
        _fundGsusd(depositor, 10_000e18);
        vm.startPrank(depositor);
        gsusd.approve(address(pool), 10_000e18);
        pool.deposit(10_000e18);
        vm.stopPrank();

        fee.mint(address(this), 10e18);
        fee.transfer(address(pool), 10e18); // 9.9 arrive
        pool.absorbLiquidationPrefunded(address(fee), 1_000e18);
        assertEq(pool.collateralAccounted(address(fee)), 9.9e18);
        assertApproxEqAbs(pool.getCollateralGain(depositor, address(fee)), 9.9e18, 1);
    }

    // ------------------------------------------------------------------ the silo deposit leg

    function test_addressWithNoCodeAsTheTokenFailsClosed() public {
        address notAToken = address(0x70CE);
        vm.mockCall(notAToken, abi.encodeWithSignature("decimals()"), abi.encode(uint8(18)));
        vm.mockCall(notAToken, abi.encodeWithSignature("balanceOf(address)"), abi.encode(uint256(0)));
        vm.expectRevert("Too many unusable silos");
        factory.deposit(notAToken, 10e18);
        assertEq(factory.totalCollateral(notAToken), 0);
    }

    /// A word other than true is not success, even though the tokens moved: the leg fails,
    /// the deposit reverts and the movement is rolled back with it.
    function test_tokenReturningAWordOtherThanTrueIsNotAccepted() public {
        TokenReturningTwo odd = new TokenReturningTwo();
        odd.mint(address(this), 100e18);
        vm.expectRevert("Too many unusable silos");
        factory.deposit(address(odd), 10e18);
        assertEq(odd.balanceOf(address(this)), 100e18, "nothing left the depositor");
        assertEq(factory.totalCollateral(address(odd)), 0);
    }

    function test_tokenThatReportsTrueAndMovesNothingCreditsNothing() public {
        TokenClaimingSuccess liar = new TokenClaimingSuccess();
        vm.expectRevert("Too many unusable silos");
        factory.deposit(address(liar), 10e18);
        assertEq(factory.totalCollateral(address(liar)), 0);
    }

    function test_tokenThatCallsBackDuringTheTransferGetsNowhere() public {
        TokenThatCallsBack sly = new TokenThatCallsBack();
        sly.arm(factory);
        sly.mint(address(this), 100e18);
        uint256 credited = factory.deposit(address(sly), 10e18);
        assertTrue(sly.calledBack(), "the token did call back");
        assertFalse(sly.callBackSucceeded(), "and the factory refused it mid-deposit");
        assertEq(credited, 10e18);
        assertEq(factory.getSiloCount(address(sly)), 1, "no silo was created by the callback");
        assertEq(factory.totalCollateral(address(sly)), 10e18);
    }
}
