// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import "forge-std/Test.sol";
import {Vm, VmSafe} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {FullStackHarness} from "./harness/FullStackHarness.sol";
import {GoldVault} from "../src/core/GoldVault.sol";
import {SiloFactory} from "../src/core/CollateralSilo.sol";
import {VaultRegistry} from "../src/core/VaultRegistry.sol";
import {MockERC20Freezable} from "../src/test/mocks/MockERC20Freezable.sol";

/// @notice PAXG with the issuer's freeze, collateral in silos and, where a test asks for it,
///         the VaultRegistry wired: the deploy.ts shape a frozen-vault liquidation runs in.
abstract contract FrozenVaultFixture is FullStackHarness {
    SiloFactory internal factory;
    address internal borrower = address(0xB0B);
    address internal poolDepositor = address(0xD0D0);

    /// @dev The per-transaction gas cap (EIP-7825) every liquidation must fit in.
    uint256 internal constant TX_GAS_CAP = 16_777_216;

    bytes32 internal constant T_CEDED = keccak256("ProtocolShareCeded(address,uint256)");
    bytes32 internal constant T_FEE = keccak256("FeeRoutingFailed(uint256)");
    bytes32 internal constant T_RES = keccak256("ReserveRoutingFailed(address,uint256)");
    bytes32 internal constant T_SUR = keccak256("SurplusRoutingFailed(address,uint256)");
    bytes32 internal constant T_BAD = keccak256("BadDebtAbsorptionFailed(uint256)");
    bytes32 internal constant T_TO_RESERVE = keccak256("PenaltyRoutedToReserve(address,uint256)");

    function setUp() public virtual override {
        super.setUp();
        vm.etch(address(paxg), address(new MockERC20Freezable("Pax Gold", "PAXG")).code);
        factory = new SiloFactory(100e18);
        factory.grantRole(factory.VAULT_ROLE(), address(vault));
        vault.setSiloFactory(address(factory));
    }

    function _wireRegistry() internal {
        vault.setVaultRegistry(address(new VaultRegistry(address(vault))));
    }

    function _freezeVault() internal {
        MockERC20Freezable(address(paxg)).setFrozen(address(vault), true);
    }

    function _has(Vm.Log[] memory logs, bytes32 topic) internal view returns (bool) {
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].emitter == address(vault) && logs[i].topics.length > 0 && logs[i].topics[0] == topic) {
                return true;
            }
        }
        return false;
    }

    function _liquidateCall() internal view returns (bytes memory) {
        return abi.encodeCall(GoldVault.liquidate, (borrower, 0));
    }

    function _emergencyCall() internal view returns (bytes memory) {
        return abi.encodeCall(GoldVault.emergencyLiquidate, (borrower, 0));
    }
}

/// @notice The frozen-vault fallback settles at a cost that does not grow with the token's
///         silo count. Before the fix the pull of the
///         protocol share to a frozen vault failed only after every funded silo of the token
///         had refused it, about 19,000 gas a silo, so from about 837 funded silos a direct or
///         emergency liquidation no longer fitted in a 2^24 gas transaction.
contract FrozenVaultLiquidationTest is FrozenVaultFixture {
    function setUp() public override {
        super.setUp();
        _wireRegistry();
    }

    /// @dev `count` silos filled to the 100 oz cap by debt-free depositors, five silos each.
    function _fillSilos(uint256 count) internal {
        uint256 left = count;
        uint256 depositorIndex;
        while (left > 0) {
            uint256 silosNow = left >= 5 ? 5 : left;
            _open(address(uint160(0x20000 + depositorIndex)), paxg, silosNow * 100e18, 0);
            left -= silosNow;
            depositorIndex++;
        }
    }

    /// @dev A borrower at 10 oz against 26,000 GSUSD, a funded liquidator (this contract) and a
    ///      30,000 GSUSD pool, then gold at $2,800 (about 107.7%, under the 110% line).
    function _openBorrowerAndPool() internal {
        _open(borrower, paxg, 10e18, 26_000e18);
        _fundGsusd(address(this), 26_000e18);
        gsusd.approve(address(vault), type(uint256).max);
        _fundGsusd(poolDepositor, 30_000e18);
        vm.startPrank(poolDepositor);
        gsusd.approve(address(pool), type(uint256).max);
        pool.deposit(30_000e18);
        vm.stopPrank();
        _walkPrice(2800e8);
    }

    /// @dev Run `data` with `gas` and roll it back: whether it settled, whether the protocol
    ///      share was ceded and the gas it used.
    function _attempt(bytes memory data, uint256 gas) internal returns (bool ok, bool ceded, uint256 used) {
        uint256 snap = vm.snapshotState();
        vm.recordLogs();
        uint256 before = gasleft();
        (ok,) = address(vault).call{gas: gas}(data);
        used = before - gasleft();
        ceded = _has(vm.getRecordedLogs(), T_CEDED);
        vm.revertToStateAndDelete(snap);
    }

    function test_frozenVaultLiquidationCostIsFlatInTheFundedSiloCount() public {
        _openBorrowerAndPool();
        uint256 snap = vm.snapshotState();
        _freezeVault();
        (bool okFew, bool cededFew, uint256 usedFew) = _attempt(_liquidateCall(), TX_GAS_CAP);
        assertTrue(okFew && cededFew, "one funded silo: the share is ceded and the seizure settles");
        vm.revertToStateAndDelete(snap);

        _fillSilos(840);
        _freezeVault();
        (bool okMany, bool cededMany, uint256 usedMany) = _attempt(_liquidateCall(), TX_GAS_CAP);
        assertTrue(okMany && cededMany, "841 funded silos: the share is ceded and the seizure settles");
        emit log_named_uint("frozen liquidate gas, 1 funded silo", usedFew);
        emit log_named_uint("frozen liquidate gas, 841 funded silos", usedMany);
        // A few accounts may be cold in one run and warm in the other; a walk over the silos
        // would add millions.
        assertLe(usedMany, usedFew + 50_000, "the frozen fallback must not walk the silos");
    }

    function test_frozenVaultLiquidateAndEmergencyLiquidateSettleUnderTheCapWith841FundedSilos() public {
        _fillSilos(840);
        _openBorrowerAndPool();
        _freezeVault();
        uint256 snap = vm.snapshotState();

        (bool ok, bool ceded, uint256 used) = _attempt(_liquidateCall(), TX_GAS_CAP);
        assertTrue(ok, "liquidate settles under 2^24 gas");
        assertTrue(ceded, "liquidate cedes the protocol share");
        assertLt(used, 1_500_000, "liquidate costs no more than an ordinary liquidation");

        vault.pause();
        (ok, ceded, used) = _attempt(_emergencyCall(), TX_GAS_CAP);
        assertTrue(ok, "emergencyLiquidate settles under 2^24 gas");
        assertTrue(ceded, "emergencyLiquidate cedes the protocol share");
        assertLt(used, 1_500_000, "emergencyLiquidate costs no more than an ordinary liquidation");
        vm.revertToStateAndDelete(snap);

        // Settled for real: the liquidator holds the whole seizure and the vault holds no gold.
        uint256 goldBefore = paxg.balanceOf(address(this));
        (ok,) = address(vault).call{gas: TX_GAS_CAP}(_liquidateCall());
        assertTrue(ok);
        (, uint256 collateralLeft, uint256 debtLeft) = _vault(borrower);
        assertEq(debtLeft, 0, "the debt is cleared");
        assertEq(paxg.balanceOf(address(this)) - goldBefore, 10e18 - collateralLeft, "the liquidator receives every seized ounce");
        assertEq(paxg.balanceOf(address(vault)), 0, "nothing is stranded in the frozen vault");
    }

    function test_unfrozenVaultStillRoutesTheProtocolShare() public {
        _fillSilos(10);
        _openBorrowerAndPool();
        uint256 reserveBefore = reserve.collateralBalance(address(paxg));
        vm.recordLogs();
        vault.liquidate(borrower, 0);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertFalse(_has(logs, T_CEDED), "nothing is ceded when the vault can receive");
        assertTrue(_has(logs, T_TO_RESERVE), "the reserve slice is routed");
        assertGt(reserve.collateralBalance(address(paxg)), reserveBefore);
    }
}

/// @notice No gas limit makes a direct or emergency liquidation of an UNFROZEN vault succeed
///         through a degrade path: the protocol share ceded, the fee burned, a routing fallback
///         or bad debt left unabsorbed. Each guarded call is safe only while the work after it
///         needs more gas than the 1/64 the caller keeps when the callee runs out; this sweep
///         holds that for the probe of whether the vault can receive the token, which runs
///         before the protocol-share pull. A probe starved by a chosen gas limit would hand the
///         protocol's share to the liquidator on a vault nobody froze.
contract ProtocolShareProbeGasSweepTest is FrozenVaultFixture {
    address internal depositor = address(0xD1);

    function _feeBps() internal pure override returns (uint256) {
        return 500; // 5% a year, so every repayment carries a fee portion to bank
    }

    function setUp() public override {
        super.setUp();
        // 10 oz at $4,000 against 26,000 GSUSD (153.8%).
        _open(borrower, paxg, 10e18, 26_000e18);
        _fundGsusd(address(this), 40_000e18);
        gsusd.approve(address(vault), type(uint256).max);
        _fundGsusd(depositor, 60_000e18);
        vm.startPrank(depositor);
        gsusd.approve(address(pool), type(uint256).max);
        pool.deposit(60_000e18);
        vm.stopPrank();
        // A funded buffer, so an underwater liquidation has something to absorb with.
        _fundGsusd(address(this), 5_000e18);
        buffer.grantRole(buffer.VAULT_ROLE(), address(this));
        gsusd.approve(address(buffer), 5_000e18);
        buffer.depositFee(5_000e18);

        vm.warp(block.timestamp + 30 days);
        vm.roll(block.number + 10);
        _setPrice(PRICE);
        oracle.getTokenPrice(address(paxg));
        oracle.getTokenPrice(address(xaut));
    }

    function _degraded(Vm.Log[] memory logs) internal view returns (bool) {
        return _has(logs, T_CEDED) || _has(logs, T_FEE) || _has(logs, T_RES) || _has(logs, T_SUR) || _has(logs, T_BAD);
    }

    function _sweep(bytes memory data, uint256 lo, uint256 hi, uint256 step)
        internal
        returns (uint256 settled, uint256 degraded, uint256 firstSettled)
    {
        uint256 freeMemory;
        assembly ("memory-safe") {
            freeMemory := mload(0x40)
        }
        for (uint256 g = lo; g <= hi; g += step) {
            // Reuse the same memory every iteration: the recorded logs would otherwise grow
            // the test frame's memory without bound.
            assembly ("memory-safe") {
                mstore(0x40, freeMemory)
            }
            // Thousands of calls would exhaust the test's own gas limit; each iteration starts
            // from a full allowance instead. The call below still gets exactly `g`.
            vm.resetGasMetering();
            uint256 snap = vm.snapshotState();
            vm.recordLogs();
            (bool ok,) = address(vault).call{gas: g}(data);
            Vm.Log[] memory logs = vm.getRecordedLogs();
            if (ok) {
                settled++;
                if (firstSettled == 0) firstSettled = g;
                if (_degraded(logs)) {
                    degraded++;
                    emit log_named_uint("degraded success at gas", g);
                }
            }
            vm.revertToStateAndDelete(snap);
        }
    }

    /// @param headroom Gas above the measured use up to which the coarse sweep runs: the
    ///        registry hook's budget must be present although the hook returns most of it.
    function _run(string memory label, bytes memory data, uint256 headroom) internal {
        // Positive control: with ample gas the call settles and nothing degrades.
        uint256 snap = vm.snapshotState();
        vm.recordLogs();
        uint256 before = gasleft();
        (bool okFull,) = address(vault).call{gas: 10_000_000}(data);
        uint256 used = before - gasleft();
        assertTrue(okFull, "the liquidation settles with ample gas");
        assertFalse(_degraded(vm.getRecordedLogs()), "nothing degrades with ample gas");
        vm.revertToStateAndDelete(snap);
        emit log_named_string("scenario", label);
        emit log_named_uint("gas used with ample gas", used);

        (uint256 settledCoarse, uint256 degradedCoarse, uint256 firstCoarse) = _sweep(data, 60_000, used + headroom, 211);
        emit log_named_uint("coarse sweep: settled", settledCoarse);
        emit log_named_uint("coarse sweep: first settling gas", firstCoarse);
        assertGt(settledCoarse, 0, "the coarse sweep reaches a settling gas limit");
        assertEq(degradedCoarse, 0, "coarse: a liquidation settled through a degrade path");
        uint256 lo = firstCoarse > 30_000 ? firstCoarse - 30_000 : 1;
        (uint256 settledFine, uint256 degradedFine, uint256 firstFine) = _sweep(data, lo, firstCoarse + 30_000, 7);
        emit log_named_uint("fine sweep: settled", settledFine);
        emit log_named_uint("fine sweep: first settling gas", firstFine);
        assertEq(degradedFine, 0, "fine: a liquidation settled through a degrade path");
    }

    function test_liquidate_noDegradedSuccessAtAnyGasLimit() public {
        _walkPrice(2800e8); // about 107%: the penalty fits and the protocol share is routed
        _run("liquidate", _liquidateCall(), 150_000);
    }

    function test_liquidateUnderwater_noDegradedSuccessAtAnyGasLimit() public {
        _walkPrice(2550e8); // gold worth less than the debt: the buffer absorbs the bad debt
        _run("liquidate underwater", _liquidateCall(), 150_000);
    }

    function test_emergencyLiquidate_noDegradedSuccessAtAnyGasLimit() public {
        _walkPrice(2800e8);
        vault.pause();
        _run("emergencyLiquidate", _emergencyCall(), 150_000);
    }

    function test_liquidateWithRegistry_noDegradedSuccessAtAnyGasLimit() public {
        _wireRegistry();
        _walkPrice(2800e8);
        _run("liquidate with the registry wired", _liquidateCall(), 600_000);
    }

    /// @dev The storage slots the probe touched in `accesses`, or `found` false when the vault
    ///      never reached it.
    function _probeSlots(Vm.AccountAccess[] memory accesses) internal view returns (bool found, uint256 slots) {
        bytes32 probe = keccak256(abi.encodeCall(IERC20.transfer, (address(vault), 0)));
        for (uint256 i; i < accesses.length; i++) {
            Vm.AccountAccess memory access = accesses[i];
            if (
                access.accessor == address(vault) && access.account == address(paxg)
                    && access.kind == VmSafe.AccountAccessKind.Call && keccak256(access.data) == probe
            ) {
                return (true, access.storageAccesses.length);
            }
        }
    }

    /// The coarse sweeps above pass through the gas limits at which the probe itself runs out
    /// of gas. This test pins those limits down, by the probe stopping before it has touched
    /// every slot a full run touches, and shows that each of them reverts the whole liquidation.
    function test_starvedProbeRevertsTheLiquidation() public {
        _walkPrice(2800e8);
        bytes memory data = _liquidateCall();
        uint256 fullSnap = vm.snapshotState();
        vm.startStateDiffRecording();
        (bool okFull,) = address(vault).call{gas: 10_000_000}(data);
        (bool reached, uint256 fullSlots) = _probeSlots(vm.stopAndReturnStateDiff());
        assertTrue(okFull && reached, "the probe runs on an ample-gas liquidation");
        vm.revertToStateAndDelete(fullSnap);

        uint256 freeMemory;
        assembly ("memory-safe") {
            freeMemory := mload(0x40)
        }
        uint256 starved;
        for (uint256 g = 60_000; g <= 700_000; g += 97) {
            assembly ("memory-safe") {
                mstore(0x40, freeMemory)
            }
            vm.resetGasMetering();
            uint256 snap = vm.snapshotState();
            vm.startStateDiffRecording();
            (bool ok,) = address(vault).call{gas: g}(data);
            (bool found, uint256 slots) = _probeSlots(vm.stopAndReturnStateDiff());
            if (found && slots < fullSlots) {
                if (starved == 0) emit log_named_uint("first gas limit that starves the probe", g);
                starved++;
                assertFalse(ok, "a starved probe must revert the whole liquidation");
            }
            vm.revertToStateAndDelete(snap);
        }
        emit log_named_uint("gas limits that starve the probe", starved);
        assertGt(starved, 0, "the sweep reaches the gas limits that starve the probe");
    }

    /// Detector control: a frozen vault cedes the share, and the detector sees it.
    function test_detectorControl_frozenVaultCedes() public {
        _walkPrice(2800e8);
        _freezeVault();
        vm.recordLogs();
        vault.liquidate(borrower, 0);
        assertTrue(_has(vm.getRecordedLogs(), T_CEDED), "the detector sees ProtocolShareCeded");
    }
}
