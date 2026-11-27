import { getLedgerConfig } from './env';
import { readLedger } from './export';
import type { LedgerExport } from './export';
import { ledgerKeys } from './keys';
import { createLedgerRedis } from './redis';
import { createLedgerStore } from './store';

/**
 * The operator's export run: the API's own environment for the deployment and Redis. It
 * only reads. Undefined when the usage ledger is not configured in this environment, in
 * which case nothing was opened.
 */
export const runLedgerExport = async (): Promise<LedgerExport | undefined> => {
  const config = getLedgerConfig();
  if (config === undefined) return undefined;
  const redis = createLedgerRedis('Usage ledger export Redis');
  try {
    return await readLedger({ config, store: createLedgerStore(redis, ledgerKeys(config.chainId, config.vault)) });
  } finally {
    redis.disconnect();
  }
};

export { ledgerToCsv } from './export';
export type { LedgerExport } from './export';
