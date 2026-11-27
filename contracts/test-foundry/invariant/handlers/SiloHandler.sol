// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Test} from "forge-std/Test.sol";

import {SiloFactory} from "../../../src/core/CollateralSilo.sol";
import {MockERC20} from "../../../src/test/mocks/MockERC20.sol";

/// @title SiloHandler
/// @notice Fuzz-driven harness for SiloFactory invariant tests.
///
/// @dev The handler itself holds the VAULT_ROLE on the factory - it mints
///      tokens, pays them to the factory, and calls `deposit` / `withdraw`
///      directly. This mirrors how GoldVault interacts with the factory
///      in production without needing to stand up the full vault.
contract SiloHandler is Test {
    SiloFactory internal immutable factory;
    MockERC20 internal immutable paxg;

    uint256 public ghost_depositedIn;
    uint256 public ghost_withdrawnOut;
    uint256 public ghost_cursorMoves;
    uint256 public ghost_silosPrecreated;
    /// @dev Times createSilos left the list longer than the cursor needs, created a number
    ///      other than the one it reported, or refused while clones were missing. Must stay zero.
    uint256 public ghost_createSilosFaults;
    /// @dev Withdrawals of at most the factory's collateral that reverted. Must stay zero.
    uint256 public ghost_withdrawFaults;

    address internal constant SINK = address(0xDEAD);

    constructor(SiloFactory _factory, MockERC20 _paxg) {
        factory = _factory;
        paxg = _paxg;
    }

    function deposit(uint256 amount) external {
        // 0.001 - 100 oz per call
        amount = bound(amount, 0.001e18, 100e18);

        // The patched SiloFactory.deposit pulls from msg.sender (pull pattern), so the handler
        // must hold the tokens and approve the factory — mirroring how GoldVault funds it.
        paxg.mint(address(this), amount);
        paxg.approve(address(factory), amount);
        // `factory.deposit` is deterministic for in-range amounts; any revert
        // here is itself a bug worth surfacing (no try/catch).
        uint256 credited = factory.deposit(address(paxg), amount);
        ghost_depositedIn += credited;
    }

    /// @notice Governance moves the deposit cursor forward, as it does past a frozen run,
    ///         to a few indices beyond the last silo that exists, so the move leaves a gap.
    /// @dev The handler holds the admin role. Withdrawals rewind the cursor below silos
    ///      that already exist, so a move measured from the cursor alone would mostly land
    ///      on existing silos and leave nothing to create. Short steps and a ceiling keep a
    ///      run to a few hundred silos, so the invariants that read every silo stay fast.
    ///      The 64-silo step and a 200-silo gap are covered in SiloCursorGap.test.ts.
    function moveCursor(uint256 by) external {
        uint256 cursor = factory.currentSiloIndex(address(paxg));
        uint256 count = factory.getSiloCount(address(paxg));
        uint256 target = (count > cursor ? count : cursor) + bound(by, 1, 6);
        if (count > 250 || target - cursor > 64) return;
        factory.setCurrentSiloIndex(address(paxg), target);
        ghost_cursorMoves++;
    }

    /// @notice Governance moves the cursor a few indices past the last silo and somebody
    ///         creates the first of the missing clones in the same step, leaving the rest:
    ///         a part-filled gap, met in every run however the other actions fall.
    function moveCursorThenCreateOne(uint256 by) external {
        uint256 cursor = factory.currentSiloIndex(address(paxg));
        uint256 count = factory.getSiloCount(address(paxg));
        uint256 target = (count > cursor ? count : cursor) + bound(by, 1, 3);
        if (target - cursor > 64) return;
        factory.setCurrentSiloIndex(address(paxg), target);
        ghost_cursorMoves++;
        uint256 missing = factory.missingSilos(address(paxg));
        if (missing != target + 1 - count) ghost_createSilosFaults++;
        vm.prank(address(0xC0FFEE));
        uint256 created = factory.createSilos(address(paxg), 1);
        if (created != 1 || factory.getSiloCount(address(paxg)) != count + 1) ghost_createSilosFaults++;
        ghost_silosPrecreated += created;
    }

    /// @notice Anyone creates some of the clones missing behind the cursor.
    function createSilos(uint256 callerSeed, uint256 count) external {
        count = bound(count, 1, factory.MAX_CREATE_BATCH());
        uint256 cursor = factory.currentSiloIndex(address(paxg));
        uint256 before = factory.getSiloCount(address(paxg));
        uint256 missing = factory.missingSilos(address(paxg));
        // Nothing is reported, and nothing can be created, for a token with no silo whose
        // cursor governance has not moved: its first deposit creates its first silo.
        bool known = before > 0 || factory.minSiloIndex(address(paxg)) > 0;
        uint256 expectedMissing = known && cursor + 1 > before ? cursor + 1 - before : 0;
        if (missing != expectedMissing) ghost_createSilosFaults++;

        vm.prank(address(uint160(bound(callerSeed, 0x1000, 0xFFFF))));
        try factory.createSilos(address(paxg), count) returns (uint256 created) {
            uint256 expected = count < missing ? count : missing;
            uint256 nowCount = factory.getSiloCount(address(paxg));
            if (created != expected || nowCount != before + expected || nowCount > cursor + 1) {
                ghost_createSilosFaults++;
            }
            ghost_silosPrecreated += created;
        } catch {
            if (missing != 0) ghost_createSilosFaults++;
        }
    }

    function withdraw(uint256 amount) external {
        uint256 available = factory.totalCollateral(address(paxg));
        if (available == 0) return;

        amount = bound(amount, 1, available);

        try factory.withdraw(address(paxg), SINK, amount) {
            ghost_withdrawnOut += amount;
        } catch {
            // At most the collateral the factory holds, with no silo frozen: it must pay.
            ghost_withdrawFaults++;
        }
    }
}
