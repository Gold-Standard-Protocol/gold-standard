// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {FullStackHarness} from "./harness/FullStackHarness.sol";
import {FeeSplitter} from "../src/core/FeeSplitter.sol";
import {MockBadDebtBuffer} from "../src/test/mocks/MockBadDebtBuffer.sol";

/// @notice The SurplusBuffer burns the GSUSD it
///         absorbs instead of transferring it to the caller, so a VAULT_ROLE holder can at most
///         destroy buffer GSUSD and never take it past the automatic 3% floor. GoldVault books
///         the absorption from the fall in GSUSD supply, capped at the outstanding bad debt.
///         The harness charges no stability fee and mints every GSUSD through a vault, so
///         supply equals outstanding principal plus unabsorbed bad debt throughout.
/// A buffer built before absorptions were burned: it grants every role and transfers absorptions to the caller,
/// and it does not declare `absorptionBurns`. Paired with the new vault it would strand GSUSD.
contract LegacyTransferringBuffer {
    function hasRole(bytes32, address) external pure returns (bool) {
        return true;
    }

    function absorbBadDebt(uint256) external {}
}

contract BufferBurnsAbsorptionTest is FullStackHarness {
    address internal borrower = address(0xB0B);
    address internal liquidator = address(0x11);
    address internal depositor = address(0xD1);
    address internal intruder = address(0xBAD);

    /// $2533.33: 0.75 XAUT is worth $1900 against a 2000 GSUSD debt, so liquidation books bad debt.
    int256 internal constant UNDERWATER = 253333e6;
    uint256 internal constant DEBT = 2000e18;

    event BadDebtRetried(uint256 absorbed);
    event BadDebtAbsorptionFailed(uint256 amount);
    event BadDebtPassedThrough(uint256 requested, uint256 absorbed);

    /// @dev Mints at least the vault minimum debt through a throwaway vault, then deposits
    ///      `amount`; any remainder stays with this contract, still backed by that vault.
    function _fundBuffer(uint256 amount) internal {
        _fundGsusd(address(this), amount < vault.minDebt() ? vault.minDebt() : amount);
        gsusd.approve(address(buffer), amount);
        buffer.grantRole(buffer.VAULT_ROLE(), address(this));
        buffer.depositFee(amount);
    }

    function _principal() internal view returns (uint256 total) {
        (, , , , , uint256 paxgDebt,) = vault.collateralTypes(paxgId);
        (, , , , , uint256 xautDebt,) = vault.collateralTypes(xautId);
        total = paxgDebt + xautDebt;
    }

    function _assertIdentity() internal view {
        assertEq(gsusd.totalSupply(), _principal() + vault.totalBadDebt(), "supply == principal + bad debt");
        assertEq(gsusd.balanceOf(address(vault)), 0, "the vault holds no GSUSD");
    }

    function _underwaterVault() internal {
        _open(borrower, xaut, 750_000, DEBT);
        _fundGsusd(liquidator, 3000e18);
        _walkPrice(UNDERWATER);
    }

    /// @return booked The bad debt the liquidation booked: the debt less what the liquidator paid.
    function _liquidate() internal returns (uint256 booked) {
        vm.startPrank(liquidator);
        gsusd.approve(address(vault), type(uint256).max);
        uint256 before = gsusd.balanceOf(liquidator);
        vault.liquidate(borrower, 0);
        vm.stopPrank();
        booked = DEBT - (before - gsusd.balanceOf(liquidator));
        (, uint256 coll, uint256 debt) = _vault(borrower);
        assertEq(coll, 0);
        assertEq(debt, 0);
    }

    // ------------------------------------------------------------ the buffer cannot be drained

    function test_roleHolderOtherThanTheVaultReceivesNothing() public {
        _fundBuffer(1000e18);
        buffer.grantRole(buffer.VAULT_ROLE(), intruder);
        uint256 supplyBefore = gsusd.totalSupply();

        vm.prank(intruder);
        buffer.absorbBadDebt(type(uint256).max);

        assertEq(gsusd.balanceOf(intruder), 0, "the caller is paid nothing");
        assertEq(gsusd.balanceOf(address(buffer)), 0, "the GSUSD is gone");
        assertEq(supplyBefore - gsusd.totalSupply(), 1000e18, "supply falls by the absorbed amount");
        assertEq(buffer.gsusdBalance(), 0);
        assertEq(buffer.totalBadDebtAbsorbed(), 1000e18);
    }

    // ------------------------------------------------------------ through liquidation

    function test_fullAbsorptionBurnsExactlyTheBadDebt() public {
        _underwaterVault();
        _fundBuffer(1000e18);
        uint256 bufferBefore = buffer.gsusdBalance();

        uint256 booked = _liquidate();

        assertGt(booked, 0);
        assertEq(vault.totalBadDebt(), 0, "fully absorbed");
        assertEq(bufferBefore - buffer.gsusdBalance(), booked, "the buffer burns exactly the bad debt");
        assertEq(gsusd.balanceOf(address(buffer)), buffer.gsusdBalance(), "burned, not moved");
        _assertIdentity();
    }

    function test_partialAbsorptionBurnsTheWholeBufferAndBooksTheRest() public {
        _underwaterVault();
        _fundBuffer(50e18);

        uint256 booked = _liquidate();

        assertGt(booked, 50e18);
        assertEq(vault.totalBadDebt(), booked - 50e18, "reduced by exactly the burned amount");
        assertEq(buffer.gsusdBalance(), 0);
        assertEq(gsusd.balanceOf(address(buffer)), 0);
        _assertIdentity();
    }

    function test_retryAfterRefillingTheBuffer() public {
        _underwaterVault();
        uint256 booked = _liquidate();
        assertEq(vault.totalBadDebt(), booked, "an empty buffer absorbs nothing");
        vm.expectRevert(bytes("Nothing absorbed"));
        vault.retryBadDebtAbsorption();

        _fundBuffer(60e18);
        vm.expectEmit(address(vault));
        emit BadDebtRetried(60e18);
        vault.retryBadDebtAbsorption();
        assertEq(vault.totalBadDebt(), booked - 60e18);
        _assertIdentity();

        _fundBuffer(1000e18);
        vault.retryBadDebtAbsorption();
        assertEq(vault.totalBadDebt(), 0);
        assertEq(buffer.gsusdBalance(), 1060e18 - booked);
        _assertIdentity();
    }

    // ------------------------------------------------------------ pairing

    function test_realBufferAndSplitterDeclareThatTheyBurn() public {
        assertTrue(buffer.absorptionBurns(), "buffer");
        FeeSplitter splitter = new FeeSplitter(address(gsusd), address(buffer));
        assertTrue(splitter.absorptionBurns(), "splitter, through its buffer");
    }

    /// An old transferring buffer wired to the new vault would leave absorbed GSUSD stranded
    /// in the vault and book nothing; the vault now refuses it at wiring time.
    function test_aBufferThatDoesNotBurnIsRefusedAtWiring() public {
        LegacyTransferringBuffer legacy = new LegacyTransferringBuffer();
        vm.expectRevert(bytes("Buffer must burn absorptions"));
        vault.setSurplusBuffer(address(legacy));
    }

    // ------------------------------------------------------------ misbehaving buffers

    function _wireMock(MockBadDebtBuffer.Mode mode) internal returns (MockBadDebtBuffer mock) {
        mock = new MockBadDebtBuffer(address(gsusd), mode);
        vault.setSurplusBuffer(address(mock));
    }

    function test_revertingBufferNeverRevertsALiquidation() public {
        _underwaterVault();
        _wireMock(MockBadDebtBuffer.Mode.Revert);
        uint256 booked = _liquidate();
        assertEq(vault.totalBadDebt(), booked, "booked, not absorbed");
        _assertIdentity();
        vm.expectRevert(bytes("Nothing absorbed"));
        vault.retryBadDebtAbsorption();
    }

    function test_revertingBufferNeverRevertsAPoolLiquidation() public {
        _open(borrower, xaut, 750_000, DEBT);
        _fundGsusd(depositor, 3000e18);
        vm.startPrank(depositor);
        gsusd.approve(address(pool), 3000e18);
        pool.deposit(3000e18);
        vm.stopPrank();
        vm.roll(block.number + 1);
        _walkPrice(UNDERWATER);
        _wireMock(MockBadDebtBuffer.Mode.Revert);

        vault.liquidateViaPool(borrower, 0);
        assertGt(vault.totalBadDebt(), 0);
        _assertIdentity();
    }

    function test_revertingBufferNeverRevertsAnEmergencyLiquidation() public {
        _underwaterVault();
        _wireMock(MockBadDebtBuffer.Mode.Revert);
        vault.emergencyPause();
        vm.startPrank(liquidator);
        gsusd.approve(address(vault), type(uint256).max);
        vault.emergencyLiquidate(borrower, 0);
        vm.stopPrank();
        assertGt(vault.totalBadDebt(), 0);
        _assertIdentity();
    }

    function test_bufferThatBurnsNothingAbsorbsNothing() public {
        _underwaterVault();
        MockBadDebtBuffer mock = _wireMock(MockBadDebtBuffer.Mode.BurnNothing);
        _fundGsusd(address(mock), 500e18);
        uint256 booked = _liquidate();
        assertEq(vault.totalBadDebt(), booked);
        assertEq(gsusd.balanceOf(address(mock)), 500e18);
        _assertIdentity();
    }

    function test_bufferThatBurnsMoreThanAskedCannotUnderflow() public {
        _underwaterVault();
        MockBadDebtBuffer mock = _wireMock(MockBadDebtBuffer.Mode.BurnEverything);
        _fundGsusd(address(mock), 5000e18);
        uint256 supplyBefore = gsusd.totalSupply();
        uint256 booked = _liquidate();
        assertLt(booked, 5000e18);
        assertEq(vault.totalBadDebt(), 0, "capped at the outstanding bad debt");
        assertEq(gsusd.balanceOf(address(mock)), 0);
        assertGt(supplyBefore - gsusd.totalSupply(), booked, "it really burned more");
    }

    function test_retryAgainstAnOverBurningBufferIsCapped() public {
        _underwaterVault();
        MockBadDebtBuffer mock = _wireMock(MockBadDebtBuffer.Mode.BurnNothing);
        uint256 booked = _liquidate();
        _fundGsusd(address(mock), 5000e18);
        mock.setMode(MockBadDebtBuffer.Mode.BurnEverything);
        vm.expectEmit(address(vault));
        emit BadDebtRetried(booked);
        vault.retryBadDebtAbsorption();
        assertEq(vault.totalBadDebt(), 0);
    }

    // ------------------------------------------------------------ FeeSplitter in front

    function test_feeSplitterInFrontOfTheBufferForwardsNothing() public {
        _underwaterVault();
        _fundBuffer(1000e18);
        FeeSplitter splitter = new FeeSplitter(address(gsusd), address(buffer));
        buffer.grantRole(buffer.VAULT_ROLE(), address(splitter));
        splitter.grantRole(splitter.VAULT_ROLE(), address(vault));
        vault.setSurplusBuffer(address(splitter));

        uint256 booked = _liquidate();

        assertEq(vault.totalBadDebt(), 0);
        assertEq(buffer.gsusdBalance(), 1000e18 - booked);
        assertEq(gsusd.balanceOf(address(splitter)), 0, "the splitter holds nothing");
        _assertIdentity();
    }

    function test_feeSplitterReportsTheSupplyDrop() public {
        _fundBuffer(1000e18);
        FeeSplitter splitter = new FeeSplitter(address(gsusd), address(buffer));
        buffer.grantRole(buffer.VAULT_ROLE(), address(splitter));
        splitter.grantRole(splitter.VAULT_ROLE(), intruder);
        uint256 supplyBefore = gsusd.totalSupply();

        vm.expectEmit(address(splitter));
        emit BadDebtPassedThrough(4000e18, 1000e18);
        vm.prank(intruder);
        splitter.absorbBadDebt(4000e18);

        assertEq(gsusd.balanceOf(intruder), 0, "nothing reaches the caller");
        assertEq(supplyBefore - gsusd.totalSupply(), 1000e18);
    }
}
