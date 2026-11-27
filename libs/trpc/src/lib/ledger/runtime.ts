import { onShutdown } from '../shutdown';
import { getLedgerConfig } from './env';
import type { LedgerConfig } from './env';
import { ledgerKeys } from './keys';
import { createRecordCache } from './record';
import type { RecordCache } from './record';
import { createLedgerRedis } from './redis';
import { createLedgerStore } from './store';
import type { LedgerStore } from './store';

/** What the router needs once the ledger is on. */
export interface LedgerRuntime {
  config: LedgerConfig;
  store: LedgerStore;
  /** The whole record as a file, built on demand and kept for the download and the status answer. */
  record: RecordCache;
}

let runtime: LedgerRuntime | undefined;

/**
 * The router's store, built on first use and only when the ledger is on: while it is off
 * this returns undefined and opens nothing. The router only reads, and only Redis. The
 * Redis client here is the router's own; the indexer worker holds another.
 */
export const getLedgerRuntime = (): LedgerRuntime | undefined => {
  if (runtime !== undefined) return runtime;
  const config = getLedgerConfig();
  if (config === undefined) return undefined;
  const redis = createLedgerRedis('Usage ledger router Redis');
  onShutdown(async () => {
    redis.disconnect();
  });
  const store = createLedgerStore(redis, ledgerKeys(config.chainId, config.vault));
  runtime = { config, store, record: createRecordCache({ config, store }) };
  return runtime;
};
