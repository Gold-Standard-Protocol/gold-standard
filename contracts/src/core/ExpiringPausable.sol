// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.38;

import "@openzeppelin/contracts/utils/Pausable.sol";

/// @title ExpiringPausable
/// @notice A Pausable whose pauses lapse. Once MAX_PAUSE_DURATION has passed since the
///         most recent pause or extension, anyone may lift it.
/// @dev Liveness backstop against a lost or absent governance. A guardian, governance or
///      the bad-debt breaker can still pause at once, and governance can still unpause
///      early through the timelock; but no key is needed to end a pause once the window
///      closes, so a frozen protocol cannot stay frozen forever. A live guardian keeps a
///      genuine incident paused by extending the window before it lapses (`extendPause` on
///      each contract, same authority as its pause); pausing again while paused is refused
///      by Pausable itself, so the extension is also how the guardian meets a new incident
///      while a pause is in force, lapsed or not.
///
///      One rule numbers every hold: each re-assertion of a pause is a fresh decision and
///      takes a new `pauseEpoch`. That covers a new pause, every extension and every trip of
///      the bad-debt breaker, whether the contract was paused already or not. A governance
///      unpause names the number it was approved for, so it lands only if nothing has
///      re-asserted the hold since it was scheduled; otherwise it reverts "Different pause"
///      and the hold stands. A compromised guardian can delay recovery by at most one more
///      timelock delay: it can void an unpause scheduled before its revocation executes, so
///      governance schedules the revocation on its own and the unpause once it has executed.
///      It could already re-pause at once until revoked.
abstract contract ExpiringPausable is Pausable {
    /// @notice Longest a single pause can last without a fresh pause.
    uint256 public constant MAX_PAUSE_DURATION = 14 days;

    /// @notice Timestamp of the most recent pause or extension: the window runs from it.
    uint256 public pausedAt;

    /// @notice The number of the hold in force while paused, of the most recent one otherwise;
    ///         0 before the first. Every re-assertion adds one, whoever makes it: a new pause
    ///         (the guardian, governance or the bad-debt breaker), an extension (inside the
    ///         window or after it has closed) or a breaker trip while already paused.
    ///         Lifting a pause, by governance or by the lapse, leaves it unchanged. Governance
    ///         reads it when it schedules an unpause and passes it on.
    /// @dev A scheduled unpause names the hold it was approved for, so it cannot lift a later
    ///      re-assertion. An unpause that matured after its pause had lapsed reverts
    ///      ExpectedPause and stays executable for the timelock grace period; without the
    ///      number, an open executor could run it inside that period to lift a new guardian
    ///      pause for a different incident and act in the same transaction.
    ///      The same holds while a pause is in force: the guardian meets a new incident with
    ///      extendPause, or the breaker trips again. An unpause approved before that must not
    ///      lift the new hold, so the extension and the trip number it afresh.
    uint256 public pauseEpoch;

    event PauseExpired(address indexed by, uint256 pausedAt);
    event PauseExtended(address indexed by, uint256 pausedAt);

    /// @notice When the current pause may be lifted by anyone; 0 while not paused.
    function pauseExpiresAt() external view returns (uint256) {
        return paused() ? pausedAt + MAX_PAUSE_DURATION : 0;
    }

    /// @notice Lift a pause whose window has closed. Permissionless, and it needs no pause
    ///         number: whichever pause is in force has lapsed.
    function unpauseExpired() external {
        require(paused(), "Not paused");
        require(block.timestamp >= pausedAt + MAX_PAUSE_DURATION, "Pause not expired");
        emit PauseExpired(msg.sender, pausedAt);
        _unpause();
    }

    /// @dev Re-assert a pause in force: restart its window from now and give it a new number.
    ///      Callers gate it with their pause authority. Inside the window or after it has
    ///      closed, an extension is a fresh decision to hold, so any unpause approved before
    ///      it reverts "Different pause" and governance schedules a new one naming the current
    ///      number. A compromised guardian can therefore void an unpause batched with its own
    ///      revocation, which is why the revocation is scheduled on its own first.
    function _extendPause() internal {
        require(paused(), "Not paused");
        ++pauseEpoch;
        pausedAt = block.timestamp;
        emit PauseExtended(msg.sender, pausedAt);
    }

    /// @dev Impose a hold whatever the current state: a new pause when unpaused, an extension
    ///      when paused, lapsed or not. Either way the window starts now under a new number, so
    ///      an unpause approved before the hold cannot lift it. Used by a hold the protocol
    ///      imposes by itself (the bad-debt breaker), which must not depend on whether a pause
    ///      was already in force.
    function _pauseAnew() internal {
        if (paused()) _extendPause();
        else _pause();
    }

    /// @dev Lift hold number `epoch` and no other: a later pause, extension or breaker trip has
    ///      a higher number and reverts "Different pause". Callers gate it with their unpause
    ///      authority.
    function _unpauseAt(uint256 epoch) internal {
        require(epoch == pauseEpoch, "Different pause");
        _unpause();
    }

    /// @dev Records the pause time and starts a new pause number; `super._pause()` keeps
    ///      Pausable's whenNotPaused guard, so a call while paused reverts and numbers nothing.
    function _pause() internal virtual override {
        pausedAt = block.timestamp;
        ++pauseEpoch;
        super._pause();
    }
}
