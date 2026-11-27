// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {FullStackHarness} from "./harness/FullStackHarness.sol";
import {GoldGovernance} from "../src/governance/Governance.sol";
import {ExpiringTimelockController} from "../src/governance/ExpiringTimelockController.sol";
import {GoldOracle} from "../src/core/GoldOracle.sol";
import {GoldVault} from "../src/core/GoldVault.sol";
import {GoldStablecoin} from "../src/core/GoldStablecoin.sol";

/// @dev Holds no role anywhere: under the open executor it stands for any address.
contract FreezeReplayer {
    function approve(GoldStablecoin gsusd, address spender) external {
        gsusd.approve(spender, type(uint256).max);
    }

    /// @dev Runs an old unfreeze on the timelock and liquidates in the same transaction.
    function replayAndLiquidate(
        ExpiringTimelockController tl,
        GoldOracle oracle,
        GoldVault vault,
        bytes memory call,
        bytes32 salt,
        address borrower
    ) external {
        tl.execute(address(oracle), 0, call, bytes32(0), salt);
        vault.liquidate(borrower, 0);
    }
}

/// @notice The token freeze counterpart of the pause epochs. guardianUnfreezeToken accepts
///         governance, so the timelock can schedule it; a freeze lapses by itself after
///         FREEZE_DURATION, so an unfreeze that matured after its freeze had lapsed reverts
///         "Not frozen" and stays executable for the grace period. Without a freeze number an
///         open executor could run it inside that period to lift a later freeze for a different
///         incident and liquidate the token in the same transaction. The unfreeze now names the
///         freeze it was approved for (freezeEpoch), so it lifts that freeze and no other, and
///         every freezeToken call takes a new number, a re-freeze of a frozen token included, so
///         an unfreeze lands only if nobody has re-asserted the freeze since it was scheduled.
contract FreezeEpochTimelockTest is FullStackHarness {
    GoldGovernance internal gov;
    ExpiringTimelockController internal tl;
    FreezeReplayer internal stranger;

    address internal constant PROPOSER = address(0xB0B5AFE);
    address internal constant GUARDIAN = address(0x6A2D);
    address internal constant BORROWER = address(0xB0B);
    uint256 internal constant DELAY = 48 hours;

    function setUp() public override {
        super.setUp();
        address[] memory proposers = new address[](1);
        proposers[0] = PROPOSER;
        address[] memory executors = new address[](1);
        executors[0] = address(0); // the open executor: anyone may execute
        gov = new GoldGovernance(proposers, executors, address(vault), address(oracle), address(module));
        tl = gov.timelock();

        oracle.grantGuardianRole(GUARDIAN);
        oracle.transferGovernance(address(tl));
        gov.transferGovernance(address(tl));

        _open(BORROWER, paxg, 1e18, 2600e18); // 153.8% at $4,000
        stranger = new FreezeReplayer();
        _fundGsusd(address(stranger), 5_000e18);
        stranger.approve(gsusd, address(vault));
    }

    function _unfreezeCall(uint256 epoch) internal view returns (bytes memory) {
        return abi.encodeCall(GoldOracle.guardianUnfreezeToken, (address(paxg), epoch));
    }

    /// @notice (a) Freeze 1: governance schedules the unfreeze late in the freeze, the freeze
    ///         lapses first, so the matured operation reverts "Not frozen" and stays Ready. The
    ///         guardian freezes the token again for a second incident (freeze 2), and a stranger
    ///         replays the old approval inside the seven day grace period to lift it and
    ///         liquidate in the same transaction. The replay is refused and the token stays frozen.
    function test_staleUnfreezeInsideTheGracePeriodCannotLiftANewFreeze() public {
        bytes32 salt = keccak256("unfreeze-freeze-1");
        uint256 t0 = vm.getBlockTimestamp();

        vm.prank(GUARDIAN);
        oracle.freezeToken(address(paxg));
        assertEq(oracle.freezeEpoch(address(paxg)), 1);
        assertEq(oracle.freezeEpoch(address(xaut)), 0, "each token has its own count");
        bytes memory stale = _unfreezeCall(1);
        vm.warp(t0 + 12 days + 12 hours);
        vm.prank(PROPOSER);
        tl.schedule(address(oracle), 0, stale, bytes32(0), salt, DELAY);
        bytes32 id = tl.hashOperation(address(oracle), 0, stale, bytes32(0), salt);

        // The freeze lapses at t0 + 14 days, before the unfreeze matures.
        vm.warp(t0 + 14 days + 12 hours + 1);
        assertFalse(oracle.tokenFrozen(address(paxg)));
        vm.expectRevert(bytes("Not frozen"));
        tl.execute(address(oracle), 0, stale, bytes32(0), salt);
        assertTrue(tl.isOperationReady(id), "a reverted execution leaves the operation Ready");

        // Gold falls while the token is free; the borrower is now under the liquidation ratio.
        _walkPrice(2800e8);

        // Freeze 2, inside the grace period of the stale operation.
        vm.warp(t0 + 16 days);
        _setPrice(2800e8);
        vm.prank(GUARDIAN);
        oracle.freezeToken(address(paxg));
        assertEq(oracle.freezeEpoch(address(paxg)), 2, "a new freeze has a new number");
        assertFalse(tl.isOperationExpired(id), "the grace period alone does not stop this replay");

        vm.expectRevert(bytes("Different freeze"));
        stranger.replayAndLiquidate(tl, oracle, vault, stale, salt, BORROWER);
        assertTrue(oracle.tokenFrozen(address(paxg)), "the new freeze stands");
        (,, uint256 debt) = _vault(BORROWER);
        assertEq(debt, 2600e18, "nothing liquidated through the freeze");
    }

    /// @notice (b) The freeze counterpart of the pause re-assertion case. A new incident
    ///         arrives while the token is still frozen, and governance's unfreeze for the first
    ///         freeze waits in the timelock. The guardian re-asserts the freeze with freezeToken;
    ///         that is a fresh decision with a new number, so the unfreeze approved before it
    ///         reverts "Different freeze" and a stranger cannot liquidate through the freeze. An
    ///         unfreeze scheduled after the last freezeToken, naming its number, still lifts it.
    function test_freezingAgainWhileFrozenRefusesAnUnfreezeScheduledBeforeIt() public {
        bytes32 salt = keccak256("unfreeze-freeze-1");
        uint256 t0 = vm.getBlockTimestamp();
        // Gold has fallen: the borrower is under the liquidation ratio before any freeze.
        _walkPrice(2800e8);

        vm.prank(GUARDIAN);
        oracle.freezeToken(address(paxg));
        bytes memory call = _unfreezeCall(oracle.freezeEpoch(address(paxg)));
        vm.prank(PROPOSER);
        tl.schedule(address(oracle), 0, call, bytes32(0), salt, DELAY);

        // A second incident a day later, while the first freeze is still in force.
        vm.warp(t0 + 1 days);
        vm.prank(GUARDIAN);
        oracle.freezeToken(address(paxg));

        vm.warp(t0 + DELAY + 1);
        _setPrice(2800e8);
        vm.expectRevert(bytes("Different freeze"));
        stranger.replayAndLiquidate(tl, oracle, vault, call, salt, BORROWER);
        assertTrue(oracle.tokenFrozen(address(paxg)), "the second freeze stands");
        (,, uint256 debt) = _vault(BORROWER);
        assertEq(debt, 2600e18, "nothing liquidated through the freeze");
        assertEq(oracle.freezeEpoch(address(paxg)), 2, "freezing again is a fresh decision with a new number");
        assertEq(oracle.frozenUntil(address(paxg)), t0 + 1 days + oracle.FREEZE_DURATION());

        // Positive control: frozen once more, then an unfreeze scheduled after that, naming it.
        vm.prank(GUARDIAN);
        oracle.freezeToken(address(paxg));
        assertEq(oracle.freezeEpoch(address(paxg)), 3);
        bytes32 freshSalt = keccak256("unfreeze-freeze-3");
        bytes memory fresh = _unfreezeCall(3);
        vm.prank(PROPOSER);
        tl.schedule(address(oracle), 0, fresh, bytes32(0), freshSalt, DELAY);
        vm.warp(t0 + 2 * DELAY + 2);
        _setPrice(2800e8);
        tl.execute(address(oracle), 0, fresh, bytes32(0), freshSalt);
        assertFalse(oracle.tokenFrozen(address(paxg)));
        assertEq(oracle.freezeEpoch(address(paxg)), 3, "lifting a freeze does not number a new one");

        // Frozen again after the lift: a new freeze.
        vm.prank(GUARDIAN);
        oracle.freezeToken(address(paxg));
        assertEq(oracle.freezeEpoch(address(paxg)), 4);
    }

    /// @notice (c) A wrong number is refused, for the guardian and the timelock alike, and the
    ///         freeze stands; (d) the guardian lifts it directly with the right number.
    function test_wrongEpochRevertsAndTheGuardianLiftsWithTheRightOne() public {
        vm.prank(GUARDIAN);
        oracle.freezeToken(address(paxg));

        uint256[2] memory wrong = [uint256(0), 2];
        for (uint256 i; i < wrong.length; ++i) {
            vm.prank(GUARDIAN);
            vm.expectRevert(bytes("Different freeze"));
            oracle.guardianUnfreezeToken(address(paxg), wrong[i]);
            vm.prank(address(tl));
            vm.expectRevert(bytes("Different freeze"));
            oracle.guardianUnfreezeToken(address(paxg), wrong[i]);
        }
        assertTrue(oracle.tokenFrozen(address(paxg)));

        // The role check comes first: a stranger is refused whatever the number.
        vm.prank(address(stranger));
        vm.expectRevert(bytes("Not guardian or governance"));
        oracle.guardianUnfreezeToken(address(paxg), 1);

        vm.expectEmit(true, true, false, true, address(oracle));
        emit GoldOracle.TokenUnfrozen(address(paxg), GUARDIAN, uint256(PRICE));
        vm.prank(GUARDIAN);
        oracle.guardianUnfreezeToken(address(paxg), 1);
        assertFalse(oracle.tokenFrozen(address(paxg)));
    }

    /// @notice A freeze after a lapse is a new one even though nobody lifted the old one.
    function test_aFreezeAfterALapseIsANewFreeze() public {
        uint256 t0 = vm.getBlockTimestamp();
        vm.prank(GUARDIAN);
        oracle.freezeToken(address(paxg));
        vm.warp(t0 + oracle.FREEZE_DURATION());
        assertFalse(oracle.tokenFrozen(address(paxg)));
        vm.prank(GUARDIAN);
        oracle.freezeToken(address(paxg));
        assertEq(oracle.freezeEpoch(address(paxg)), 2);

        _setPrice(PRICE);
        vm.prank(GUARDIAN);
        vm.expectRevert(bytes("Different freeze"));
        oracle.guardianUnfreezeToken(address(paxg), 1);
        vm.prank(GUARDIAN);
        oracle.guardianUnfreezeToken(address(paxg), 2);
        assertFalse(oracle.tokenFrozen(address(paxg)));
    }
}
