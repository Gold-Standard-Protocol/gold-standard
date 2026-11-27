import { contractKeyOf } from './deployment';
import type { Deployment } from './deployment';
import { formatEvent } from './format';
import type { WatchedLog } from './format';
import { findEventRule } from './rules';
import type { Sender } from './telegram';
import { describeError } from './text';
import type { Logger } from './text';

/** Blocks per eth_getLogs request. */
export const MAX_BLOCK_RANGE = 2_000;
/** Requests per tick, so a long outage is caught up over a few ticks and never in one burst. */
export const MAX_CHUNKS_PER_TICK = 25;

export interface EventCursor {
  nextBlock: number;
  delivered: readonly string[];
}

export interface ScanResult extends EventCursor {
  sent: number;
  /** A notification could not be delivered; the cursor stands at its block. */
  deliveryFailed: boolean;
  /** A log request failed; the cursor stands at the first block of that request. */
  readFailed: boolean;
}

export interface ScanContext {
  deployment: Deployment;
  explorerUrl: string;
  /** Logs of the watched contracts in the inclusive range, decoded. */
  getLogs: (fromBlock: number, toBlock: number) => Promise<readonly WatchedLog[]>;
  send: Sender;
  log: Logger;
}

const logId = (log: WatchedLog): string => `${log.transactionHash}:${log.logIndex}`;

/**
 * Reports every watched event from the cursor to `head`, oldest first. The cursor moves past
 * a block only when every event in it was delivered, and remembers what it delivered inside
 * the block it stopped in, so a failed send is retried on the next tick with no event lost
 * and none repeated.
 */
export const scanEvents = async (cursor: EventCursor, head: number, context: ScanContext): Promise<ScanResult> => {
  let nextBlock = cursor.nextBlock;
  let delivered = [...cursor.delivered];
  let sent = 0;

  for (let chunk = 0; chunk < MAX_CHUNKS_PER_TICK && nextBlock <= head; chunk++) {
    const toBlock = Math.min(head, nextBlock + MAX_BLOCK_RANGE - 1);
    let logs: readonly WatchedLog[];
    try {
      logs = await context.getLogs(nextBlock, toBlock);
    } catch (error) {
      context.log.warn('watcher.logs-unread', { fromBlock: nextBlock, toBlock, reason: describeError(error) });
      return { nextBlock, delivered, sent, deliveryFailed: false, readFailed: true };
    }

    const ordered = [...logs].sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
    for (const entry of ordered) {
      const contract = contractKeyOf(context.deployment, entry.address);
      const rule = contract === undefined ? undefined : findEventRule(contract, entry.eventName);
      if (contract === undefined || rule === undefined) continue;
      if (entry.blockNumber > nextBlock) {
        nextBlock = entry.blockNumber;
        delivered = [];
      }
      const id = logId(entry);
      if (delivered.includes(id)) continue;
      try {
        await context.send(formatEvent(context.deployment, context.explorerUrl, contract, rule, entry));
      } catch (error) {
        context.log.error('watcher.delivery-failed', {
          rule: rule.id,
          eventName: entry.eventName,
          block: entry.blockNumber,
          reason: describeError(error),
        });
        return { nextBlock, delivered, sent, deliveryFailed: true, readFailed: false };
      }
      delivered.push(id);
      sent += 1;
      context.log.info('watcher.event-reported', {
        rule: rule.id,
        severity: rule.severity,
        eventName: entry.eventName,
        block: entry.blockNumber,
        transactionHash: entry.transactionHash,
      });
    }
    nextBlock = toBlock + 1;
    delivered = [];
  }
  return { nextBlock, delivered, sent, deliveryFailed: false, readFailed: false };
};
