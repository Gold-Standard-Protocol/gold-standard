// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import "forge-std/Test.sol";

import {StabilityModule} from "../../src/core/StabilityModule.sol";

/// @title StabilityModule fuzz tests
/// @notice Exercises the per-second compounding math under a wide range of
///         annual rates, elapsed times, and principal amounts. Guards against
///         the two classes of bug that hurt most in a fee accrual module:
///         (1) monotonicity violations, (2) overflow / `_rpow` instability.
contract StabilityModuleFuzzTest is Test {
    StabilityModule internal module;
    bytes32 internal constant CID = keccak256("PAXG");
    address internal constant VAULT = address(0xBEEF);

    function setUp() public {
        module = new StabilityModule();
        module.grantRole(module.VAULT_ROLE(), VAULT);
    }

    // ==================================================================
    // 1. Debt never decreases over time once principal is recorded.
    // ==================================================================
    function testFuzz_debtIsMonotonic(
        uint256 annualBps,
        uint256 principal,
        uint256 elapsed
    ) public {
        annualBps = bound(annualBps, 0, 5000); // 0-50%
        principal = bound(principal, 1e18, 1e30);
        elapsed = bound(elapsed, 0, 365 days * 5);

        module.initCollateral(CID, annualBps);

        vm.prank(VAULT);
        module.recordDebt(VAULT, CID, principal);

        uint256 before = module.getCurrentDebt(VAULT, CID);

        vm.warp(block.timestamp + elapsed);

        uint256 afterDebt = module.getCurrentDebt(VAULT, CID);
        assertGe(afterDebt, before, "debt decreased over time");
    }

    // ==================================================================
    // 2. Zero annual rate means debt never changes.
    // ==================================================================
    function testFuzz_zeroRateNoFees(uint256 principal, uint256 elapsed) public {
        principal = bound(principal, 1e18, 1e30);
        elapsed = bound(elapsed, 0, 365 days * 10);

        module.initCollateral(CID, 0);

        vm.prank(VAULT);
        module.recordDebt(VAULT, CID, principal);

        vm.warp(block.timestamp + elapsed);

        assertEq(module.getCurrentDebt(VAULT, CID), principal, "zero-rate debt changed");
    }

    // ==================================================================
    // 3. Fee accrual stays within the correct COMPOUND upper bound.
    //    The per-second rate is `1 + r/Y`, which compounds over t years to
    //    approximately e^(r*t) (NOT the linear `1 + r*t`). That faster-than-
    //    linear growth is the documented effective-rate behaviour and is
    //    intentional. For the fuzzed range r <= 0.5 and t <= 10 we have
    //    r*t <= 5, so the growth factor is bounded above by e^5 < 149. We use
    //    150x as the explosion ceiling: anything above it would indicate an
    //    _rpow overflow / runaway, not legitimate compounding.
    // ==================================================================
    function testFuzz_feeAccrualBounded(
        uint256 annualBps,
        uint256 principal,
        uint256 years_
    ) public {
        annualBps = bound(annualBps, 1, 5000); // 0.01-50%
        principal = bound(principal, 100e18, 1e27);
        years_ = bound(years_, 1, 10);

        module.initCollateral(CID, annualBps);

        vm.prank(VAULT);
        module.recordDebt(VAULT, CID, principal);

        vm.warp(block.timestamp + years_ * 365 days);
        uint256 current = module.getCurrentDebt(VAULT, CID);

        // Compound ceiling: e^(r*t) <= e^5 < 149 for the fuzzed bounds; 150x leaves headroom
        // for rpow half-up rounding without admitting runaway growth.
        assertLe(current, principal * 150, "fee accrual exploded beyond compound bound");
        assertGe(current, principal, "fee accrual shrunk principal");
    }

    // ==================================================================
    // 4. Partial repay of full current debt zeroes out normalised debt.
    // ==================================================================
    function testFuzz_repayZeroesDebt(
        uint256 annualBps,
        uint256 principal,
        uint256 elapsed
    ) public {
        annualBps = bound(annualBps, 0, 5000);
        principal = bound(principal, 1e18, 1e27);
        elapsed = bound(elapsed, 0, 365 days);

        module.initCollateral(CID, annualBps);

        vm.startPrank(VAULT);
        module.recordDebt(VAULT, CID, principal);

        vm.warp(block.timestamp + elapsed);

        uint256 current = module.getCurrentDebt(VAULT, CID);
        module.reduceDebt(VAULT, CID, current);
        vm.stopPrank();

        // After fully repaying, the user's normalised debt should round to zero
        // (the round-down reduction pattern can leave at most 1 wei of dust).
        uint256 residual = module.getCurrentDebt(VAULT, CID);
        assertLe(residual, 1, "residual debt after full repay > 1 wei");
    }
}
