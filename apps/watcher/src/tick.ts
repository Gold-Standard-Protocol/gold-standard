import { scanEvents } from './eventScan';
import type { ScanContext } from './eventScan';
import type { StateStore, ThresholdState, WatcherState } from './state';
import { evaluateThreshold } from './thresholds';
import type { ThresholdCheck } from './thresholds';
import { describeError } from './text';

export interface TickDependencies extends ScanContext {
  getHeadBlock: () => Promise<number>;
  nowSeconds: () => number;
  store: StateStore;
  checks: readonly ThresholdCheck[];
  repeatSeconds: number;
  /** Called after a tick that read the chain and delivered everything it had to. */
  heartbeat?: () => Promise<void>;
}

export interface TickResult {
  state: WatcherState;
  /** The head was read, every log request answered and every due notification was delivered. */
  clean: boolean;
}

/**
 * One pass: report new events, then judge each threshold, then save. A first run has no
 * state and starts after the current head, so nothing from before the watcher existed is
 * replayed. The state is saved even after a partial pass, because whatever was delivered
 * must not be sent again.
 */
export const runTick = async (previous: WatcherState | undefined, deps: TickDependencies): Promise<TickResult | undefined> => {
  let head: number;
  try {
    head = await deps.getHeadBlock();
  } catch (error) {
    deps.log.warn('watcher.head-unread', { reason: describeError(error) });
    return previous === undefined ? undefined : { state: previous, clean: false };
  }

  const before: WatcherState = previous ?? { nextBlock: head + 1, delivered: [], thresholds: {} };
  const scan = await scanEvents(before, head, deps);

  const thresholds: Record<string, ThresholdState> = {};
  let thresholdDeliveryFailed = false;
  for (const check of deps.checks) {
    const outcome = await evaluateThreshold(
      check,
      before.thresholds[check.key],
      deps.nowSeconds(),
      deps.repeatSeconds,
      deps.send,
      deps.log
    );
    thresholds[check.key] = outcome.state;
    thresholdDeliveryFailed ||= outcome.deliveryFailed;
  }

  const state: WatcherState = { nextBlock: scan.nextBlock, delivered: scan.delivered, thresholds };
  await deps.store.save(state);

  const clean = !scan.readFailed && !scan.deliveryFailed && !thresholdDeliveryFailed;
  deps.log.info('watcher.tick', { head, nextBlock: state.nextBlock, sent: scan.sent, clean });
  if (clean && deps.heartbeat !== undefined) await deps.heartbeat();
  return { state, clean };
};
