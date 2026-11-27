import {
  initPriceUpdateWorker,
  schedulePriceUpdate,
} from './lib/bullmq/queue';
import { ledgerRouter } from './lib/routers/ledger';
import { pricesRouter } from './lib/routers/prices';
import { tokensRouter } from './lib/routers/tokens';
import { vaultsRouter } from './lib/routers/vaults';
import { router } from './lib/trpc';

export const appRouter = router({
  tokensRouter,
  pricesRouter,
  vaultsRouter,
  ledgerRouter,
});

// The reset wipes the queue, so the worker starts only once the schedule is in place:
// a worker that had already picked up a soon-to-be-wiped job logged a missing key.
schedulePriceUpdate().finally(initPriceUpdateWorker);

export type AppRouter = typeof appRouter;
export * from './lib/trpc';
export { runShutdownTasks } from './lib/shutdown';
export { createLedgerRecordHandlers, LEDGER_RECORD_CSV_PATH, LEDGER_RECORD_JSON_PATH } from './lib/ledger/http';
export type { LedgerRecordHandlers } from './lib/ledger/http';
export type { RecordSummary as LedgerRecordSummary } from './lib/ledger/record';
export type {
  AccountResponse as LedgerAccountResponse,
  LedgerTerms,
  StatusResponse as LedgerStatusResponse,
} from './lib/routers/ledger';
