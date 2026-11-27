// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {FullStackHarness} from "./harness/FullStackHarness.sol";
import {GoldGovernance} from "../src/governance/Governance.sol";
import {ExpiringTimelockController} from "../src/governance/ExpiringTimelockController.sol";
import {GoldVault} from "../src/core/GoldVault.sol";
import {MockERC20} from "../src/test/mocks/MockERC20.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";

/// @dev Holds no role anywhere: under the open executor it stands for any address.
contract EpochReplayer {
    function openVault(GoldVault vault, MockERC20 token, uint256 amount) external {
        token.approve(address(vault), amount);
        vault.deposit(address(token), amount);
    }

    /// @dev Runs an old unpause through the wrapper and mints in the same transaction.
    function replayThroughWrapperAndMint(GoldGovernance gov, GoldVault vault, bytes memory call, bytes32 salt, uint256 amount)
        external
    {
        gov.executeProposal(address(vault), call, salt);
        vault.mint(amount);
    }

    /// @dev The same, directly on the timelock.
    function replayAndMint(ExpiringTimelockController tl, GoldVault vault, bytes memory call, bytes32 salt, uint256 amount)
        external
    {
        tl.execute(address(vault), 0, call, bytes32(0), salt);
        vault.mint(amount);
    }

    /// @dev Lifts a lapsed pause, as anyone may, and mints in the same transaction.
    function liftExpiredAndMint(GoldVault vault, uint256 amount) external {
        vault.unpauseExpired();
        vault.mint(amount);
    }
}

/// @dev The vault handed to a GoldGovernance whose timelock has the open executor (anyone may
///      execute a matured operation), with a guardian and a stranger that holds no role.
abstract contract OpenExecutorVaultBase is FullStackHarness {
    GoldGovernance internal gov;
    ExpiringTimelockController internal tl;
    EpochReplayer internal stranger;

    address internal constant PROPOSER = address(0xB0B5AFE);
    address internal constant GUARDIAN = address(0x6A2D);
    uint256 internal constant DELAY = 48 hours;

    function setUp() public virtual override {
        super.setUp();
        address[] memory proposers = new address[](1);
        proposers[0] = PROPOSER;
        address[] memory executors = new address[](1);
        executors[0] = address(0); // the open executor: anyone may execute
        gov = new GoldGovernance(proposers, executors, address(vault), address(oracle), address(module));
        tl = gov.timelock();

        _beforeHandover();
        vault.grantGuardianRole(GUARDIAN);
        vault.transferGovernance(address(tl));
        gov.transferGovernance(address(tl));
        stranger = new EpochReplayer();
    }

    /// @dev Governance settings a suite needs while this contract still holds governance.
    function _beforeHandover() internal virtual {}

    function _unpauseCall(uint256 epoch) internal pure returns (bytes memory) {
        return abi.encodeCall(GoldVault.unpause, (epoch));
    }

    /// @dev The proposer schedules an unpause naming `epoch`, as governance would.
    function _scheduleUnpause(uint256 epoch, bytes32 salt) internal returns (bytes memory call) {
        call = _unpauseCall(epoch);
        vm.prank(PROPOSER);
        tl.schedule(address(vault), 0, call, bytes32(0), salt, DELAY);
    }
}

/// @notice What the timelock grace period alone leaves open. The grace period ends a matured operation seven days after it becomes
///         ready, but inside those seven days an open executor could still run an unpause that
///         had reverted ExpectedPause for one incident, lift a new guardian pause for another
///         and mint in the same transaction. An unpause now names the pause it was approved for
///         (its pause epoch), and every re-assertion of the hold (a new pause or an extension)
///         takes a new number, so an unpause lands only if nothing has re-asserted the hold
///         since it was scheduled.
contract PauseEpochTimelockTest is OpenExecutorVaultBase {
    /// @notice The reproduction. Incident 1: the guardian pauses and governance
    ///         schedules the unpause late in the pause. The pause lapses first and anyone lifts
    ///         it, so the matured unpause reverts ExpectedPause and stays Ready. Incident 2 starts
    ///         two days later, well inside the grace period, and a stranger replays the old
    ///         approval and mints 1,500 GSUSD in the same transaction.
    function test_staleUnpauseInsideTheGracePeriodCannotLiftANewPause() public {
        bytes32 salt = keccak256("unpause-incident-1");
        // vm.getBlockTimestamp: via_ir may reuse a block.timestamp read across vm.warp.
        uint256 t0 = vm.getBlockTimestamp();
        _setPrice(PRICE);
        paxg.mint(address(stranger), 1e18);
        stranger.openVault(vault, paxg, 1e18);

        // Incident 1.
        vm.prank(GUARDIAN);
        vault.emergencyPause();
        uint256 incident1 = vault.pauseEpoch();
        assertEq(incident1, 1);
        vm.warp(t0 + 12 days + 12 hours);
        bytes memory stale = _scheduleUnpause(incident1, salt);
        bytes32 id = tl.hashOperation(address(vault), 0, stale, bytes32(0), salt);

        vm.warp(t0 + 14 days);
        vault.unpauseExpired();
        assertFalse(vault.paused());

        vm.warp(t0 + 14 days + 12 hours + 1);
        vm.expectRevert(Pausable.ExpectedPause.selector);
        gov.executeProposal(address(vault), stale, salt);
        assertTrue(tl.isOperationReady(id), "a reverted execution leaves the operation Ready");

        // Incident 2, inside the grace period of the stale operation.
        vm.warp(t0 + 16 days);
        _setPrice(PRICE);
        vm.prank(GUARDIAN);
        vault.emergencyPause();
        assertEq(vault.pauseEpoch(), 2, "a new pause has a new number");
        assertFalse(tl.isOperationExpired(id), "the grace period alone does not stop this replay");

        vm.expectRevert(bytes("Different pause"));
        stranger.replayThroughWrapperAndMint(gov, vault, stale, salt, 1_500e18);
        vm.expectRevert(bytes("Different pause"));
        stranger.replayAndMint(tl, vault, stale, salt, 1_500e18);

        assertTrue(vault.paused(), "the new guardian pause stands");
        assertEq(gsusd.balanceOf(address(stranger)), 0, "nothing minted through the pause");

        // Governance can still lift incident 2 with an unpause that names it.
        bytes32 freshSalt = keccak256("unpause-incident-2");
        bytes memory fresh = _scheduleUnpause(vault.pauseEpoch(), freshSalt);
        vm.warp(t0 + 18 days + 1);
        gov.executeProposal(address(vault), fresh, freshSalt);
        assertFalse(vault.paused());
    }

    /// @notice The re-assertion case. A new incident arrives inside the window of an
    ///         active pause, while governance's unpause for the first incident is Ready. A new
    ///         pause is refused while paused, so the guardian re-asserts the hold with
    ///         extendPause. That is a fresh decision with a new number: the unpause approved
    ///         before it reverts "Different pause" and a stranger cannot mint through the hold.
    function test_extendingAPauseRefusesAnUnpauseScheduledBeforeIt() public {
        bytes32 salt = keccak256("unpause-incident-1");
        uint256 t0 = vm.getBlockTimestamp();
        paxg.mint(address(stranger), 1e18);
        stranger.openVault(vault, paxg, 1e18);

        vm.prank(GUARDIAN);
        vault.emergencyPause();
        bytes memory call = _scheduleUnpause(vault.pauseEpoch(), salt);

        // Incident 2 on day 3: the operation is Ready and inside its grace period.
        vm.warp(t0 + 3 days);
        vm.prank(GUARDIAN);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        vault.emergencyPause();
        vm.prank(GUARDIAN);
        vault.extendPause();

        _setPrice(PRICE);
        vm.expectRevert(bytes("Different pause"));
        stranger.replayAndMint(tl, vault, call, salt, 1_500e18);
        vm.expectRevert(bytes("Different pause"));
        stranger.replayThroughWrapperAndMint(gov, vault, call, salt, 1_500e18);
        assertTrue(vault.paused(), "the incident 2 hold stands");
        assertEq(gsusd.balanceOf(address(stranger)), 0, "nothing minted through the pause");
        assertEq(vault.pauseEpoch(), 2, "an extension is a fresh decision with a new number");
        assertEq(vault.pausedAt(), t0 + 3 days, "and restarts the window");
    }

    /// @notice Positive control: an unpause scheduled after the last re-assertion, naming its
    ///         number, lifts the pause however many extensions came before it.
    function test_anUnpauseScheduledAfterTheLastExtensionLiftsThePause() public {
        uint256 t0 = vm.getBlockTimestamp();
        vm.prank(GUARDIAN);
        vault.emergencyPause();
        for (uint256 day = 1; day <= 3; ++day) {
            vm.warp(t0 + day * 1 days);
            vm.prank(GUARDIAN);
            vault.extendPause();
        }
        assertEq(vault.pauseEpoch(), 4, "each extension took a new number");

        bytes32 salt = keccak256("unpause-after-the-last-extension");
        bytes memory call = _scheduleUnpause(vault.pauseEpoch(), salt);
        vm.warp(t0 + 3 days + DELAY + 1);
        gov.executeProposal(address(vault), call, salt);
        assertFalse(vault.paused());
        assertEq(vault.pauseEpoch(), 4, "lifting a pause does not number a new one");
    }

    /// @notice A second reproduction. A pause that has lapsed but that nobody has
    ///         lifted still reads paused(), so emergencyPause reverts EnforcedPause and the
    ///         guardian answers a new incident with extendPause. That extension is a new pause
    ///         with a new number, so the unpause scheduled for the first incident cannot lift the
    ///         new hold, and a stranger cannot mint through it in the same transaction.
    function test_extendingALapsedPauseStartsANewPause() public {
        bytes32 salt = keccak256("unpause-incident-1");
        uint256 t0 = vm.getBlockTimestamp();
        _setPrice(PRICE);
        paxg.mint(address(stranger), 1e18);
        stranger.openVault(vault, paxg, 1e18);

        vm.prank(GUARDIAN);
        vault.emergencyPause();
        vm.warp(t0 + 12 days + 12 hours);
        bytes memory stale = _scheduleUnpause(vault.pauseEpoch(), salt);

        // The pause lapses at t0 + 14 days and nobody calls unpauseExpired.
        vm.warp(t0 + 16 days);
        _setPrice(PRICE);
        assertTrue(vault.paused(), "a lapsed pause still reads paused");

        // Incident 2: a fresh pause is refused, so the guardian extends.
        vm.prank(GUARDIAN);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        vault.emergencyPause();
        vm.prank(GUARDIAN);
        vault.extendPause();
        assertEq(vault.pauseEpoch(), 2, "an extension after the lapse is a new pause");
        assertEq(vault.pausedAt(), t0 + 16 days, "the new pause runs from the extension");

        vm.expectRevert(bytes("Different pause"));
        stranger.replayAndMint(tl, vault, stale, salt, 1_500e18);
        vm.expectRevert(bytes("Different pause"));
        stranger.replayThroughWrapperAndMint(gov, vault, stale, salt, 1_500e18);
        assertTrue(vault.paused(), "the incident 2 hold stands");
        assertEq(gsusd.balanceOf(address(stranger)), 0, "nothing minted through the pause");

        // An extension inside the new window is a fresh decision too: lapsed or not, every
        // extension takes a new number.
        vm.warp(t0 + 20 days);
        vm.prank(GUARDIAN);
        vault.extendPause();
        assertEq(vault.pauseEpoch(), 3, "an extension inside the window takes a new number as well");
    }
}

/// @notice The bad-debt breaker against a pause already in force. The breaker used to pause only when the vault was unpaused, so a trip
///         during a pause, active or lapsed, merged into that pause: an unpause approved before
///         the bad debt lifted the breaker's hold, and a lapsed pause could be lifted by anyone
///         straight after the trip. A trip while paused now restarts the window under a new
///         number, exactly as a trip from unpaused starts a new pause.
contract PauseEpochBreakerTest is OpenExecutorVaultBase {
    address internal constant WHALE = address(0xA11CE);

    function _beforeHandover() internal override {
        vault.setBadDebtPauseThreshold(1_000e18);
    }

    /// @dev A pool deep enough to absorb the whale, a whale that goes underwater at $2,500 and
    ///      a stranger vault with headroom to mint 1,500 GSUSD at that price.
    function _stageBadDebt() internal {
        _fundGsusd(address(0xD3B0), 100_000e18);
        vm.startPrank(address(0xD3B0));
        gsusd.approve(address(pool), 100_000e18);
        pool.deposit(100_000e18);
        vm.stopPrank();
        _open(WHALE, paxg, 10e18, 26_000e18);
        paxg.mint(address(stranger), 2e18);
        stranger.openVault(vault, paxg, 2e18);
    }

    /// @dev Gold falls to $2,500 and the pool takes the whale: bad debt over the threshold.
    function _tripTheBreaker() internal {
        _walkPrice(2500e8);
        vault.liquidateViaPool(WHALE, 0);
        assertGt(vault.totalBadDebt(), vault.badDebtPauseThreshold(), "the breaker condition is met");
    }

    /// @notice (A) The breaker trips during an active guardian pause while governance's unpause
    ///         for that pause waits in the timelock. The trip takes a new number, so the approval
    ///         given before the bad debt cannot lift the breaker's hold; an unpause scheduled
    ///         after the trip, naming it, can.
    function test_aTripDuringAnActivePauseRefusesAnEarlierUnpause() public {
        uint256 t0 = vm.getBlockTimestamp();
        _stageBadDebt();
        vm.prank(GUARDIAN);
        vault.emergencyPause();
        uint256 incident = vault.pauseEpoch();
        bytes32 salt = keccak256("unpause-incident-1");
        bytes memory call = _scheduleUnpause(incident, salt);

        // Bad debt while paused, one day into the delay.
        vm.warp(t0 + 1 days);
        _setPrice(PRICE);
        _tripTheBreaker();

        // The approval given before the bad debt matures; a stranger replays it and mints.
        vm.warp(t0 + DELAY + 1);
        _setPrice(2500e8);
        vm.expectRevert(bytes("Different pause"));
        stranger.replayAndMint(tl, vault, call, salt, 1_500e18);
        vm.expectRevert(bytes("Different pause"));
        stranger.replayThroughWrapperAndMint(gov, vault, call, salt, 1_500e18);
        assertTrue(vault.paused(), "the breaker's hold stands");
        assertEq(gsusd.balanceOf(address(stranger)), 0, "nothing minted through the breaker's hold");
        assertEq(vault.pauseEpoch(), incident + 1, "the trip took a new number");
        assertEq(vault.pausedAt(), t0 + 1 days, "and restarted the window");

        // Governance lifts the breaker's hold with an unpause scheduled after the trip.
        bytes32 freshSalt = keccak256("unpause-after-the-trip");
        bytes memory fresh = _scheduleUnpause(vault.pauseEpoch(), freshSalt);
        vm.warp(t0 + 2 * DELAY + 2);
        gov.executeProposal(address(vault), fresh, freshSalt);
        assertFalse(vault.paused());
    }

    /// @notice (B) A guardian pause lapses and nobody lifts it; bad debt over the threshold then
    ///         arrives. The trip restarts the window under a new number, so nobody can lift the
    ///         vault and mint at once; the breaker holds for its own 14 days, as it would have
    ///         from unpaused, and the permissionless lapse still ends it after that.
    function test_aTripInALapsedPauseRestartsTheWindow() public {
        uint256 t0 = vm.getBlockTimestamp();
        _stageBadDebt();
        vm.prank(GUARDIAN);
        vault.emergencyPause();

        vm.warp(t0 + 15 days);
        _setPrice(PRICE);
        assertTrue(vault.paused(), "lapsed but not lifted");
        _tripTheBreaker();

        vm.expectRevert(bytes("Pause not expired"));
        stranger.liftExpiredAndMint(vault, 1_500e18);
        assertTrue(vault.paused(), "the breaker's hold stands");
        assertEq(gsusd.balanceOf(address(stranger)), 0, "nothing minted straight after the trip");
        assertEq(vault.pausedAt(), t0 + 15 days, "the trip restarted the window");
        assertEq(vault.pauseEpoch(), 2, "under a new number");
        assertEq(vault.pauseExpiresAt(), t0 + 29 days);

        // Positive control: once the breaker's own window closes, anyone lifts it, no number needed.
        vm.warp(t0 + 29 days);
        _setPrice(2500e8);
        stranger.liftExpiredAndMint(vault, 1_500e18);
        assertFalse(vault.paused());
        assertEq(gsusd.balanceOf(address(stranger)), 1_500e18);
        assertEq(vault.pauseEpoch(), 2, "the lapse numbers nothing");
    }

    /// @notice (B2) The same lapse, with a governance unpause for the lapsed pause scheduled late
    ///         in it. The trip takes a new number, so the stale approval cannot lift it either.
    function test_aTripInALapsedPauseRefusesAStaleUnpause() public {
        uint256 t0 = vm.getBlockTimestamp();
        _stageBadDebt();
        vm.prank(GUARDIAN);
        vault.emergencyPause();
        bytes32 salt = keccak256("unpause-incident-1");
        vm.warp(t0 + 12 days + 12 hours);
        bytes memory stale = _scheduleUnpause(vault.pauseEpoch(), salt);

        vm.warp(t0 + 15 days);
        _setPrice(PRICE);
        _tripTheBreaker();

        vm.expectRevert(bytes("Different pause"));
        stranger.replayAndMint(tl, vault, stale, salt, 1_500e18);
        assertTrue(vault.paused(), "the breaker's hold stands");
        assertEq(gsusd.balanceOf(address(stranger)), 0, "nothing minted through the breaker's hold");
    }
}

/// @notice The pause numbers themselves, on each contract that carries them, with governance
///         still held by this test contract.
contract PauseEpochTest is FullStackHarness {
    address internal constant GUARDIAN = address(0x6A2D);
    address internal constant STRANGER = address(0x5EED);

    function setUp() public override {
        super.setUp();
        vault.grantGuardianRole(GUARDIAN);
        oracle.grantGuardianRole(GUARDIAN);
        pool.grantGuardianRole(GUARDIAN);
        reserve.grantRole(reserve.GUARDIAN_ROLE(), GUARDIAN);
    }

    function _poolDeposit(address who, uint256 amount) internal {
        _fundGsusd(who, amount);
        vm.startPrank(who);
        gsusd.approve(address(pool), amount);
        pool.deposit(amount);
        vm.stopPrank();
    }

    /// @notice (c) The bad-debt breaker pauses through the same hook, so it starts a new pause
    ///         number and an unpause approved for the pause before it cannot lift it.
    function test_badDebtAutoPauseStartsANewPause() public {
        vm.prank(GUARDIAN);
        vault.emergencyPause();
        assertEq(vault.pauseEpoch(), 1);
        vault.unpause(1);

        vault.setBadDebtPauseThreshold(1_000e18);
        _poolDeposit(address(0xD3B0), 100_000e18);
        address whale = address(0xA11CE);
        _open(whale, paxg, 10e18, 26_000e18);
        _walkPrice(2500e8);
        vault.liquidateViaPool(whale, 0);
        assertTrue(vault.paused(), "the breaker paused the vault");
        assertEq(vault.pauseEpoch(), 2, "the breaker's pause has its own number");

        vm.expectRevert(bytes("Different pause"));
        vault.unpause(1);
        assertTrue(vault.paused());
        vault.unpause(2);
        assertFalse(vault.paused());
    }

    /// @notice The breaker trips when bad debt exceeds the threshold, not when it reaches it:
    ///         the same liquidation leaves the vault open with the threshold at exactly the
    ///         bad debt it books, and pauses it with the threshold one unit lower.
    function test_badDebtEqualToTheThresholdDoesNotTripTheBreaker() public {
        _poolDeposit(address(0xD3B0), 100_000e18);
        address whale = address(0xA11CE);
        _open(whale, paxg, 10e18, 26_000e18);
        _walkPrice(2500e8);

        // 25,000 of gold against 26,000: the pool pays 98% of the gold's value, 24,500, and
        // the 1,500 it does not pay is booked.
        uint256 booked = 1_500e18;
        uint256 snap = vm.snapshotState();
        vault.liquidateViaPool(whale, 0);
        assertEq(vault.totalBadDebt(), booked, "the bad debt this liquidation books");
        vm.revertToState(snap);

        vault.setBadDebtPauseThreshold(booked);
        snap = vm.snapshotState();
        vault.liquidateViaPool(whale, 0);
        assertEq(vault.totalBadDebt(), booked);
        assertFalse(vault.paused(), "bad debt equal to the threshold leaves the vault open");
        assertEq(vault.pauseEpoch(), 0, "and starts no pause");
        vm.revertToState(snap);

        vault.setBadDebtPauseThreshold(booked - 1);
        vault.liquidateViaPool(whale, 0);
        assertTrue(vault.paused(), "one unit over the threshold pauses it");
        assertEq(vault.pauseEpoch(), 1);
    }

    /// @notice (d) The permissionless lapse needs no number and leaves it as it was.
    function test_unpauseExpiredIsUnaffected() public {
        uint256 t0 = vm.getBlockTimestamp();
        vm.startPrank(GUARDIAN);
        vault.emergencyPause();
        oracle.emergencyPause();
        pool.emergencyPause();
        vm.stopPrank();

        vm.warp(t0 + 14 days);
        vm.startPrank(STRANGER);
        vault.unpauseExpired();
        oracle.unpauseExpired();
        pool.unpauseExpired();
        vm.stopPrank();
        assertFalse(vault.paused() || oracle.paused() || pool.paused());
        assertEq(vault.pauseEpoch(), 1);
        assertEq(oracle.pauseEpoch(), 1);
        assertEq(pool.pauseEpoch(), 1);

        vm.startPrank(GUARDIAN);
        vault.emergencyPause();
        oracle.emergencyPause();
        pool.emergencyPause();
        vm.stopPrank();
        assertEq(vault.pauseEpoch(), 2);
        assertEq(oracle.pauseEpoch(), 2);
        assertEq(pool.pauseEpoch(), 2);
    }

    /// @notice A governance pause numbers itself like a guardian pause.
    function test_governancePauseStartsANewPause() public {
        vault.pause();
        assertEq(vault.pauseEpoch(), 1);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        vault.pause();
        assertEq(vault.pauseEpoch(), 1, "a refused pause numbers nothing");
    }

    /// @notice (e) A reserve asset pause: every pauseAsset call takes a new number, whether the
    ///         asset is paused (a re-assertion that extends it) or not (a new pause, a lapse
    ///         included), and an unpause naming an earlier number is refused.
    function test_reserveAssetPauseNumbers() public {
        uint256 t0 = vm.getBlockTimestamp();
        vm.prank(GUARDIAN);
        reserve.pauseAsset(address(paxg));
        assertEq(reserve.assetPauseEpoch(address(paxg)), 1);
        assertEq(reserve.assetPauseEpoch(address(xaut)), 0, "each asset has its own count");

        // A re-assertion while paused: a fresh decision with a new number.
        vm.warp(t0 + 7 days);
        vm.prank(GUARDIAN);
        reserve.pauseAsset(address(paxg));
        assertEq(reserve.assetPauseEpoch(address(paxg)), 2, "a pause while paused takes a new number");
        (, uint64 pausedUntil, , , , ) = reserve.assets(address(paxg));
        assertEq(pausedUntil, t0 + 21 days);
        vm.expectRevert(bytes("Different pause"));
        reserve.unpauseAsset(address(paxg), 1);
        assertTrue(reserve.assetPaused(address(paxg)), "the re-asserted pause stands");

        vm.warp(t0 + 21 days);
        assertFalse(reserve.assetPaused(address(paxg)), "the pause lapsed");
        vm.prank(GUARDIAN);
        reserve.pauseAsset(address(paxg));
        assertEq(reserve.assetPauseEpoch(address(paxg)), 3, "a pause after a lapse is a new one");

        vm.expectRevert(bytes("Different pause"));
        reserve.unpauseAsset(address(paxg), 2);
        assertTrue(reserve.assetPaused(address(paxg)));
        reserve.unpauseAsset(address(paxg), 3);
        assertFalse(reserve.assetPaused(address(paxg)));

        // Lifted by governance, then paused again: a new pause as well.
        vm.prank(GUARDIAN);
        reserve.pauseAsset(address(paxg));
        assertEq(reserve.assetPauseEpoch(address(paxg)), 4);
    }

    /// @notice (g) Every re-assertion takes a new number on every contract: extendPause on the
    ///         vault, the oracle and the pool, pauseAsset on a paused reserve asset. An unpause
    ///         naming any earlier number is refused and the hold stands; one naming the current
    ///         number lifts it however many re-assertions came before. The lapse runs from the
    ///         last re-assertion and still needs no number.
    function test_everyReassertionTakesANewNumberAndTheCurrentOneLifts() public {
        uint256 t0 = vm.getBlockTimestamp();
        vm.startPrank(GUARDIAN);
        vault.emergencyPause();
        oracle.emergencyPause();
        pool.emergencyPause();
        reserve.pauseAsset(address(paxg));
        vm.stopPrank();

        for (uint256 day = 1; day <= 3; ++day) {
            vm.warp(t0 + day * 1 days);
            vm.startPrank(GUARDIAN);
            vault.extendPause();
            oracle.extendPause();
            pool.extendPause();
            reserve.pauseAsset(address(paxg));
            vm.stopPrank();
        }
        assertEq(vault.pauseEpoch(), 4);
        assertEq(oracle.pauseEpoch(), 4);
        assertEq(pool.pauseEpoch(), 4);
        assertEq(reserve.assetPauseEpoch(address(paxg)), 4);
        assertEq(vault.pauseExpiresAt(), t0 + 17 days, "the window runs from the last extension");

        for (uint256 earlier = 1; earlier < 4; ++earlier) {
            vm.expectRevert(bytes("Different pause"));
            vault.unpause(earlier);
            vm.expectRevert(bytes("Different pause"));
            oracle.unpause(earlier);
            vm.expectRevert(bytes("Different pause"));
            pool.unpause(earlier);
            vm.expectRevert(bytes("Different pause"));
            reserve.unpauseAsset(address(paxg), earlier);
        }
        assertTrue(vault.paused() && oracle.paused() && pool.paused() && reserve.assetPaused(address(paxg)));

        vm.warp(t0 + 14 days);
        vm.prank(STRANGER);
        vm.expectRevert(bytes("Pause not expired"));
        pool.unpauseExpired();

        vault.unpause(4);
        oracle.unpause(4);
        reserve.unpauseAsset(address(paxg), 4);
        assertFalse(vault.paused() || oracle.paused() || reserve.assetPaused(address(paxg)));
        assertEq(vault.pauseEpoch(), 4, "lifting a pause does not number a new one");

        vm.warp(t0 + 17 days);
        vm.prank(STRANGER);
        pool.unpauseExpired();
        assertFalse(pool.paused());
        assertEq(pool.pauseEpoch(), 4, "the lapse numbers nothing");
    }

    /// @notice (f) A wrong number is refused on each of the four functions, before and after the
    ///         right one, and the guardian still cannot unpause at all.
    function test_wrongEpochRevertsEverywhere() public {
        vm.startPrank(GUARDIAN);
        vault.emergencyPause();
        oracle.emergencyPause();
        pool.emergencyPause();
        reserve.pauseAsset(address(paxg));
        vm.stopPrank();

        uint256[2] memory wrong = [uint256(0), 2];
        for (uint256 i; i < wrong.length; ++i) {
            vm.expectRevert(bytes("Different pause"));
            vault.unpause(wrong[i]);
            vm.expectRevert(bytes("Different pause"));
            oracle.unpause(wrong[i]);
            vm.expectRevert(bytes("Different pause"));
            pool.unpause(wrong[i]);
            vm.expectRevert(bytes("Different pause"));
            reserve.unpauseAsset(address(paxg), wrong[i]);
        }
        assertTrue(vault.paused() && oracle.paused() && pool.paused() && reserve.assetPaused(address(paxg)));

        vm.startPrank(GUARDIAN);
        bytes32 role = vault.GOVERNANCE_ROLE();
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, GUARDIAN, role));
        vault.unpause(1);
        vm.stopPrank();

        vault.unpause(1);
        oracle.unpause(1);
        pool.unpause(1);
        reserve.unpauseAsset(address(paxg), 1);
        assertFalse(vault.paused() || oracle.paused() || pool.paused() || reserve.assetPaused(address(paxg)));
    }
}
