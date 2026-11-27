import { LEDGER_MEMO_MS } from '../ledger/limits';
import { initLedgerIndexWorker, scheduleLedgerIndex } from '../ledger/queue';
import { readAccount, readStatus } from '../ledger/reader';
import type { AccountResponse, StatusResponse } from '../ledger/reader';
import { getLedgerRuntime } from '../ledger/runtime';
import { publicProcedure, router } from '../trpc';
import { ledgerAccountSchema, ledgerStatusSchema } from '../validators/ledger';

export type { AccountResponse, LedgerTerms, StatusResponse } from '../ledger/reader';

/** Status answers shared per chain for LEDGER_MEMO_MS; the schema admits two chain ids. */
const recentStatus = new Map<number, { expiresAt: number; answer: Promise<StatusResponse> }>();

const status = (chainId: number): Promise<StatusResponse> => {
  const runtime = getLedgerRuntime();
  if (runtime === undefined) return Promise.resolve({ status: 'disabled' });
  const now = Date.now();
  const recent = recentStatus.get(chainId);
  if (recent !== undefined && recent.expiresAt > now) {
    return recent.answer;
  }
  // readStatus never rejects, so concurrent callers can share the pending read.
  const answer = readStatus(runtime, chainId, now);
  recentStatus.set(chainId, { expiresAt: now + LEDGER_MEMO_MS, answer });
  return answer;
};

/**
 * The usage ledger's surface: two queries and no mutation. The procedures always exist, so
 * the dapp's types are stable, and both answer `disabled` while the ledger is off without
 * touching Redis or the RPC endpoint.
 */
export const ledgerRouter = router({
  status: publicProcedure.input(ledgerStatusSchema).query(async ({ input }): Promise<StatusResponse> => status(input.chainId)),

  account: publicProcedure.input(ledgerAccountSchema).query(async ({ input }): Promise<AccountResponse> => {
    const runtime = getLedgerRuntime();
    if (runtime === undefined) return { status: 'disabled' };
    return readAccount(runtime, input.chainId, input.address, Date.now());
  }),
});

// Bootstrapped beside the router it feeds, as the vault owner index is. Both calls are
// no-ops that construct nothing while the ledger is off. Schedule first, worker second:
// the reset wipes the queue, and a worker that had already picked up a job logged a
// missing key at boot.
scheduleLedgerIndex()
  .catch((error) => {
    console.error(
      'Failed to schedule the usage ledger index job:',
      error instanceof Error ? error.message : String(error)
    );
  })
  .finally(() => {
    initLedgerIndexWorker();
  });
