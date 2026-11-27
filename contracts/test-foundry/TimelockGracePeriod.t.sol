// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {FullStackHarness} from "./harness/FullStackHarness.sol";
import {GoldGovernance} from "../src/governance/Governance.sol";
import {ExpiringTimelockController} from "../src/governance/ExpiringTimelockController.sol";
import {GoldVault} from "../src/core/GoldVault.sol";
import {MockERC20} from "../src/test/mocks/MockERC20.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

/// @dev Holds no role anywhere: under the open executor it stands for any address.
contract StrangerReplayer {
    function openVault(GoldVault vault, MockERC20 token, uint256 amount) external {
        token.approve(address(vault), amount);
        vault.deposit(address(token), amount);
    }

    /// @dev Runs an old unpause (for pause number `epoch`) through the wrapper and mints in the
    ///      same transaction.
    function unpauseThroughWrapperAndMint(GoldGovernance gov, GoldVault vault, uint256 epoch, bytes32 salt, uint256 amount)
        external
    {
        gov.executeProposal(address(vault), abi.encodeCall(GoldVault.unpause, (epoch)), salt);
        vault.mint(amount);
    }

    /// @dev The same, directly on the timelock.
    function unpauseAndMint(TimelockController tl, GoldVault vault, uint256 epoch, bytes32 salt, uint256 amount) external {
        tl.execute(address(vault), 0, abi.encodeCall(GoldVault.unpause, (epoch)), bytes32(0), salt);
        vault.mint(amount);
    }
}

/// @notice Matured timelock operations used never to expire: under the
///         open executor any address could run a matured operation whenever it chose, however
///         old. An unpause approved for one pause, which reverted because that pause lapsed
///         first and so stayed Ready, lifted a later guardian pause months on, and the caller
///         minted in the same transaction. A matured operation now runs only within the grace
///         period, through execute, executeBatch and executeProposal alike.
contract TimelockGracePeriodTest is FullStackHarness {
    GoldGovernance internal gov;
    ExpiringTimelockController internal tl;
    StrangerReplayer internal stranger;

    address internal constant PROPOSER = address(0xB0B5AFE);
    address internal constant GUARDIAN = address(0x6A2D);
    uint256 internal constant DELAY = 48 hours;
    bytes4 internal constant EXPIRED = ExpiringTimelockController.TimelockOperationExpired.selector;

    function setUp() public override {
        super.setUp();
        address[] memory proposers = new address[](1);
        proposers[0] = PROPOSER;
        address[] memory executors = new address[](1);
        executors[0] = address(0); // the open executor: anyone may execute
        gov = new GoldGovernance(proposers, executors, address(vault), address(oracle), address(module));
        tl = gov.timelock();

        vault.grantGuardianRole(GUARDIAN);
        vault.transferGovernance(address(tl));
        gov.transferGovernance(address(tl));
        stranger = new StrangerReplayer();
    }

    /// @dev Every test here schedules its unpause during the vault's first pause, number 1.
    uint256 internal constant FIRST_PAUSE = 1;

    function _unpauseCall() internal pure returns (bytes memory) {
        return abi.encodeCall(GoldVault.unpause, (FIRST_PAUSE));
    }

    /// @dev Pause the vault as the guardian and schedule the unpause; returns the operation id.
    function _pauseAndScheduleUnpause(bytes32 salt) internal returns (bytes32 id) {
        vm.prank(GUARDIAN);
        vault.emergencyPause();
        vm.prank(PROPOSER);
        tl.schedule(address(vault), 0, _unpauseCall(), bytes32(0), salt, DELAY);
        id = tl.hashOperation(address(vault), 0, _unpauseCall(), bytes32(0), salt);
    }

    function _batch() internal view returns (address[] memory targets, uint256[] memory values, bytes[] memory payloads) {
        targets = new address[](1);
        targets[0] = address(vault);
        values = new uint256[](1);
        payloads = new bytes[](1);
        payloads[0] = _unpauseCall();
    }

    function test_executeRunsOnTheLastSecondOfTheGracePeriod() public {
        bytes32 salt = keccak256("unpause-inside-grace");
        bytes32 id = _pauseAndScheduleUnpause(salt);
        vm.warp(tl.getTimestamp(id) + tl.GRACE_PERIOD());
        assertFalse(tl.isOperationExpired(id));

        vm.prank(address(0xDEAD01));
        gov.executeProposal(address(vault), _unpauseCall(), salt);
        assertFalse(vault.paused(), "unpaused inside the grace period");
        assertTrue(tl.isOperationDone(id));
        vm.warp(vm.getBlockTimestamp() + 365 days);
        assertFalse(tl.isOperationExpired(id), "a done operation never expires");
    }

    function test_executeBatchRunsOnTheLastSecondOfTheGracePeriod() public {
        bytes32 salt = keccak256("batch-inside-grace");
        vm.prank(GUARDIAN);
        vault.emergencyPause();
        (address[] memory targets, uint256[] memory values, bytes[] memory payloads) = _batch();
        vm.prank(PROPOSER);
        tl.scheduleBatch(targets, values, payloads, bytes32(0), salt, DELAY);
        bytes32 id = tl.hashOperationBatch(targets, values, payloads, bytes32(0), salt);
        vm.warp(tl.getTimestamp(id) + tl.GRACE_PERIOD());

        vm.prank(address(0xDEAD02));
        tl.executeBatch(targets, values, payloads, bytes32(0), salt);
        assertFalse(vault.paused());
        assertTrue(tl.isOperationDone(id));
    }

    function test_executeAndExecuteProposalRefuseOnceTheGracePeriodHasPassed() public {
        bytes32 salt = keccak256("unpause-after-grace");
        bytes32 id = _pauseAndScheduleUnpause(salt);
        vm.warp(tl.getTimestamp(id) + tl.GRACE_PERIOD() + 1);
        assertTrue(tl.isOperationExpired(id));

        vm.prank(address(0xDEAD03));
        vm.expectRevert(abi.encodeWithSelector(EXPIRED, id));
        tl.execute(address(vault), 0, _unpauseCall(), bytes32(0), salt);

        vm.prank(address(0xDEAD03));
        vm.expectRevert(abi.encodeWithSelector(EXPIRED, id));
        gov.executeProposal(address(vault), _unpauseCall(), salt);

        assertTrue(vault.paused(), "the guardian pause stands");
        // Expired is not cancelled: the proposer can still clear it from the queue.
        assertTrue(tl.isOperationPending(id));
        vm.prank(PROPOSER);
        tl.cancel(id);
        assertFalse(tl.isOperation(id));
        assertFalse(tl.isOperationExpired(id));
    }

    function test_executeBatchRefusesOnceTheGracePeriodHasPassed() public {
        bytes32 salt = keccak256("batch-after-grace");
        vm.prank(GUARDIAN);
        vault.emergencyPause();
        (address[] memory targets, uint256[] memory values, bytes[] memory payloads) = _batch();
        vm.prank(PROPOSER);
        tl.scheduleBatch(targets, values, payloads, bytes32(0), salt, DELAY);
        bytes32 id = tl.hashOperationBatch(targets, values, payloads, bytes32(0), salt);
        vm.warp(tl.getTimestamp(id) + tl.GRACE_PERIOD() + 1);

        vm.prank(address(0xDEAD04));
        vm.expectRevert(abi.encodeWithSelector(EXPIRED, id));
        tl.executeBatch(targets, values, payloads, bytes32(0), salt);
        assertTrue(vault.paused());
    }

    /// @notice The scenario. Governance schedules an unpause late in a guardian pause, the
    ///         pause lapses first and anyone lifts it, so the matured unpause reverts
    ///         ExpectedPause and stays Ready. Months later the guardian pauses again, and a
    ///         stranger tries to replay the old approval and mint in the same transaction.
    function test_staleUnpauseCannotLiftALaterGuardianPause() public {
        bytes32 salt = keccak256("unpause-incident-1");
        // vm.getBlockTimestamp: via_ir may reuse a block.timestamp read across vm.warp.
        uint256 t0 = vm.getBlockTimestamp();

        // Incident 1.
        vm.prank(GUARDIAN);
        vault.emergencyPause();
        vm.warp(t0 + 12 days + 12 hours);
        vm.prank(PROPOSER);
        tl.schedule(address(vault), 0, _unpauseCall(), bytes32(0), salt, DELAY);
        bytes32 id = tl.hashOperation(address(vault), 0, _unpauseCall(), bytes32(0), salt);

        vm.warp(t0 + 14 days);
        vault.unpauseExpired();
        assertFalse(vault.paused());

        vm.warp(t0 + 14 days + 12 hours + 1);
        vm.expectRevert(Pausable.ExpectedPause.selector);
        gov.executeProposal(address(vault), _unpauseCall(), salt);
        assertTrue(tl.isOperationReady(id), "a reverted execution leaves the operation Ready");
        assertFalse(tl.isOperationExpired(id));

        // Incident 2, months later.
        vm.warp(t0 + 200 days);
        _setPrice(PRICE);
        paxg.mint(address(stranger), 1e18);
        stranger.openVault(vault, paxg, 1e18);
        vm.prank(GUARDIAN);
        vault.emergencyPause();
        assertTrue(tl.isOperationExpired(id));

        vm.expectRevert(abi.encodeWithSelector(EXPIRED, id));
        stranger.unpauseThroughWrapperAndMint(gov, vault, FIRST_PAUSE, salt, 1_500e18);
        vm.expectRevert(abi.encodeWithSelector(EXPIRED, id));
        stranger.unpauseAndMint(tl, vault, FIRST_PAUSE, salt, 1_500e18);

        assertTrue(vault.paused(), "the later guardian pause stands");
        assertEq(gsusd.balanceOf(address(stranger)), 0, "nothing minted through the pause");
        vm.prank(address(stranger));
        vm.expectRevert(Pausable.EnforcedPause.selector);
        vault.mint(1_500e18);
    }
}
