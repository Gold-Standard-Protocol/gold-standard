import { formatPpm } from './format';
import type { Severity } from './rules';
import { NEW_THRESHOLD_STATE } from './state';
import type { ThresholdState } from './state';
import type { Sender } from './telegram';
import { describeError } from './text';
import type { Logger } from './text';

/** Consecutive failed reads before a reading is reported as unreadable. */
export const UNREADABLE_AFTER_FAILURES = 5;

export interface ThresholdCheck {
  /** Stable across restarts: the key of this check's record in the state file. */
  key: string;
  ruleId: number;
  severity: Severity;
  /** What is measured, as the message names it. */
  subject: string;
  /** Parts per million. */
  floor: bigint;
  read: () => Promise<bigint>;
}

export interface ThresholdOutcome {
  state: ThresholdState;
  deliveryFailed: boolean;
}

const heading = (severity: Severity): string => (severity === 'page' ? 'PAGE' : 'NOTE');

/**
 * One check, one tick. A reading below the floor is reported when it crosses and then at
 * most once per `repeatSeconds` while it stays there; its return above the floor is reported
 * once. A read that fails is never taken for a low reading: after five failures in a row it
 * is reported as unreadable, on the same repeat. The record changes only when the message
 * that would justify the change was delivered, so a failed send is tried again next tick.
 */
export const evaluateThreshold = async (
  check: ThresholdCheck,
  previous: ThresholdState | undefined,
  nowSeconds: number,
  repeatSeconds: number,
  send: Sender,
  log: Logger
): Promise<ThresholdOutcome> => {
  const before = previous ?? NEW_THRESHOLD_STATE;
  const due = nowSeconds - before.lastSentAt >= repeatSeconds;

  const deliver = async (severity: Severity, lines: string[], after: ThresholdState): Promise<ThresholdOutcome> => {
    try {
      await send({ severity, text: lines.join('\n') });
    } catch (error) {
      log.error('watcher.delivery-failed', { rule: check.ruleId, key: check.key, reason: describeError(error) });
      return { state: { ...before, failures: after.failures }, deliveryFailed: true };
    }
    log.info('watcher.threshold-reported', { rule: check.ruleId, key: check.key, breached: after.breached, unreadable: after.unreadable });
    return { state: after, deliveryFailed: false };
  };

  let value: bigint;
  try {
    value = await check.read();
  } catch (error) {
    const failures = before.failures + 1;
    log.warn('watcher.threshold-unread', { rule: check.ruleId, key: check.key, failures, reason: describeError(error) });
    if (failures >= UNREADABLE_AFTER_FAILURES && (!before.unreadable || due))
      return deliver(
        check.severity,
        [
          `${heading(check.severity)}: ${check.subject} cannot be read`,
          `${failures} reads in a row have failed, so the watcher does not know whether it is below ${formatPpm(check.floor)}.`,
        ],
        { ...before, unreadable: true, failures, lastSentAt: nowSeconds }
      );
    return { state: { ...before, failures }, deliveryFailed: false };
  }

  const reading = `${formatPpm(value)} (${value})`;
  if (value < check.floor) {
    if (before.breached && !due) return { state: { ...before, unreadable: false, failures: 0 }, deliveryFailed: false };
    return deliver(
      check.severity,
      [
        `${heading(check.severity)}: ${check.subject} is below ${formatPpm(check.floor)}`,
        `Now ${reading}.${before.breached ? ' It has stayed below since the last message.' : ''}`,
      ],
      { breached: true, unreadable: false, failures: 0, lastSentAt: nowSeconds }
    );
  }
  if (before.breached || before.unreadable)
    return deliver(
      'note',
      [`NOTE: ${check.subject} is back at or above ${formatPpm(check.floor)}`, `Now ${reading}.`],
      { breached: false, unreadable: false, failures: 0, lastSentAt: nowSeconds }
    );
  return { state: { ...before, failures: 0 }, deliveryFailed: false };
};
