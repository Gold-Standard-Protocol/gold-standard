// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import "forge-std/Test.sol";
import "forge-std/StdInvariant.sol";

import {SiloFactory, CollateralSilo} from "../../src/core/CollateralSilo.sol";
import {MockERC20} from "../../src/test/mocks/MockERC20.sol";

import {SiloHandler} from "./handlers/SiloHandler.sol";

/// @title SiloFactory invariant suite
/// @notice Exercises deposit/withdraw across a variable number of EIP-1167
///         silo clones and asserts the factory's bookkeeping tracks the
///         sum of the clones' actual token balances at every step.
contract SiloFactoryInvariantTest is StdInvariant, Test {
    SiloFactory internal factory;
    MockERC20 internal paxg;
    SiloHandler internal handler;

    // 10 oz cap per silo - forces silo rollover under moderate deposits.
    uint256 internal constant SILO_CAP = 10e18;

    function setUp() public {
        paxg = new MockERC20("Pax Gold", "PAXG", 18);
        factory = new SiloFactory(SILO_CAP);
        factory.grantRole(factory.VAULT_ROLE(), address(this));

        handler = new SiloHandler(factory, paxg);
        factory.grantRole(factory.VAULT_ROLE(), address(handler));
        // The handler also moves the deposit cursor, which only the admin may do.
        factory.grantRole(factory.DEFAULT_ADMIN_ROLE(), address(handler));

        targetContract(address(handler));

        bytes4[] memory selectors = new bytes4[](5);
        selectors[0] = SiloHandler.deposit.selector;
        selectors[1] = SiloHandler.withdraw.selector;
        selectors[2] = SiloHandler.moveCursor.selector;
        selectors[3] = SiloHandler.createSilos.selector;
        selectors[4] = SiloHandler.moveCursorThenCreateOne.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    // ==================================================================
    // Invariants
    // ==================================================================

    /// @notice Factory's `totalCollateral[token]` equals the sum of actual
    ///         token balances held by each silo clone. No drift.
    function invariant_totalCollateralMatchesSiloSum() public view {
        uint256 count = factory.getSiloCount(address(paxg));
        uint256 sum;
        for (uint256 i = 0; i < count; i++) {
            sum += CollateralSilo(factory.getSilo(address(paxg), i)).balance();
        }
        assertEq(factory.totalCollateral(address(paxg)), sum, "totalCollateral != sum silo.balance()");
    }

    /// @notice Every silo except the currently-filling one is capped at
    ///         `siloCap`. Filled silos never exceed cap; the "current"
    ///         silo is the only one that can be partially filled.
    function invariant_capRespectedExceptCurrent() public view {
        uint256 count = factory.getSiloCount(address(paxg));
        uint256 current = factory.currentSiloIndex(address(paxg));
        uint256 cap = factory.siloCap();

        for (uint256 i = 0; i < count; i++) {
            if (i == current) continue; // allow partial fill on current
            uint256 bal = CollateralSilo(factory.getSilo(address(paxg), i)).balance();
            assertLe(bal, cap, "non-current silo exceeds cap");
        }
    }

    /// @notice Handler flow conservation: factory holds 0 tokens itself
    ///         (everything forwarded to silos), and the cumulative net flow
    ///         matches the aggregate silo balance.
    function invariant_flowConservation() public view {
        assertEq(
            paxg.balanceOf(address(factory)),
            0,
            "factory holds PAXG directly - should have forwarded to silo"
        );

        uint256 count = factory.getSiloCount(address(paxg));
        uint256 sum;
        for (uint256 i = 0; i < count; i++) {
            sum += CollateralSilo(factory.getSilo(address(paxg), i)).balance();
        }

        assertEq(
            sum,
            handler.ghost_depositedIn() - handler.ghost_withdrawnOut(),
            "silo balance sum != deposited - withdrawn"
        );
    }

    /// @notice Predicted silo addresses match actual clone addresses.
    ///         Critical for operator tooling that references silos by
    ///         pre-computed CREATE2 address.
    function invariant_predictedMatchesActual() public view {
        uint256 count = factory.getSiloCount(address(paxg));
        for (uint256 i = 0; i < count; i++) {
            address actual = factory.getSilo(address(paxg), i);
            address predicted = factory.predictSiloAddress(address(paxg), i);
            assertEq(predicted, actual, "predicted silo address mismatch");
        }
    }

    /// @notice Creating the clones behind a moved cursor ahead of a deposit never creates
    ///         one past the cursor, creates exactly the number it reports, and is refused
    ///         only when nothing is missing. Deposits in this suite revert the run if they
    ///         fail, so they are also shown to work in every state the gap can be in:
    ///         unfilled, part filled and filled.
    function invariant_createSilosStaysBehindTheCursor() public view {
        assertEq(handler.ghost_createSilosFaults(), 0, "createSilos misbehaved");
    }

    /// @notice The cursor never drops below the index governance last set.
    function invariant_cursorStaysAtOrAboveItsFloor() public view {
        assertGe(
            factory.currentSiloIndex(address(paxg)),
            factory.minSiloIndex(address(paxg)),
            "cursor rewound below the floor"
        );
    }

    /// @notice A withdrawal of no more than the factory holds, with no silo frozen, always
    ///         pays. The handler catches the revert so a run can continue; this stops a caught
    ///         revert from hiding a factory that cannot pay out.
    function invariant_withdrawalsWithinCollateralNeverRevert() public view {
        assertEq(handler.ghost_withdrawFaults(), 0, "the factory refused a withdrawal it could cover");
    }

    /// @notice Non-vacuity guard (runs once at the end of each invariant run): the fuzzer must
    ///         have actually completed deposits. Before the SiloHandler pull-pattern fix every
    ///         deposit reverted silently (fail_on_revert=false), so the whole suite asserted
    ///         nothing — this guard makes that regression impossible to reintroduce.
    function afterInvariant() public view {
        assertGt(handler.ghost_depositedIn(), 0, "vacuous run: no deposits succeeded");
        assertGt(handler.ghost_cursorMoves(), 0, "vacuous run: the cursor never moved");
        assertGt(handler.ghost_silosPrecreated(), 0, "vacuous run: no clone was created ahead of a deposit");
    }
}
