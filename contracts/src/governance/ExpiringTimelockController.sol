// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.38;

import "@openzeppelin/contracts/governance/TimelockController.sol";

/// @title ExpiringTimelockController
/// @notice The OpenZeppelin TimelockController with one change: a matured operation can be
///         executed only within GRACE_PERIOD of the moment it became ready. After that it is
///         expired and execute and executeBatch refuse it for good; to act, a proposer
///         schedules the decision again and it waits out the delay again.
/// @dev The stock controller keeps an operation Ready until it is executed or cancelled, and
///      an execution whose call reverts unwinds without marking it Done. Under an open
///      executor any address could therefore choose, without limit in time, when an old
///      approval took effect: an unpause scheduled for one guardian pause, which reverted
///      because that pause had already lapsed, lifted a later guardian pause months on. Scheduling,
///      cancellation, roles and the delay are unchanged. getOperationState still reports an
///      expired operation as Ready, so the proposers can cancel it to clear the queue.
contract ExpiringTimelockController is TimelockController {
    /// @notice How long after it becomes ready an operation can still be executed.
    uint256 public constant GRACE_PERIOD = 7 days;

    /// @notice The operation became ready more than GRACE_PERIOD ago.
    error TimelockOperationExpired(bytes32 id);

    constructor(uint256 minDelay, address[] memory proposers, address[] memory executors, address admin)
        TimelockController(minDelay, proposers, executors, admin)
    {}

    /// @notice True when `id` is pending and became ready more than GRACE_PERIOD ago. An unset,
    ///         waiting or done operation is never expired.
    function isOperationExpired(bytes32 id) public view returns (bool) {
        uint256 readyAt = getTimestamp(id);
        // 0 is unset and DONE_TIMESTAMP is done. Subtracting keeps a far-future ready time
        // from overflowing the sum.
        return readyAt > DONE_TIMESTAMP && block.timestamp > readyAt && block.timestamp - readyAt > GRACE_PERIOD;
    }

    /// @inheritdoc TimelockController
    function execute(
        address target,
        uint256 value,
        bytes calldata payload,
        bytes32 predecessor,
        bytes32 salt
    ) public payable override {
        _requireNotExpired(hashOperation(target, value, payload, predecessor, salt));
        super.execute(target, value, payload, predecessor, salt);
    }

    /// @inheritdoc TimelockController
    function executeBatch(
        address[] calldata targets,
        uint256[] calldata values,
        bytes[] calldata payloads,
        bytes32 predecessor,
        bytes32 salt
    ) public payable override {
        _requireNotExpired(hashOperationBatch(targets, values, payloads, predecessor, salt));
        super.executeBatch(targets, values, payloads, predecessor, salt);
    }

    function _requireNotExpired(bytes32 id) private view {
        if (isOperationExpired(id)) revert TimelockOperationExpired(id);
    }
}
