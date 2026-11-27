import type { Address } from 'viem';
import { describeError, KEEPER_EVENTS } from '@goldstandard/trpc/keeper';
import type { KeeperLogger } from '@goldstandard/trpc/keeper';
import { replacementFees } from './fees';
import type { FeeCeilings, FeeEstimate } from './fees';

export interface PendingTransactionClient {
  getTransactionCount(args: { address: Address; blockTag: 'latest' | 'pending' }): Promise<number>;
  estimateFeesPerGas(): Promise<FeeEstimate>;
  /** A zero-value transfer from the keeper account to itself at `nonce`. */
  sendSelfTransfer(args: { nonce: number; fees: FeeEstimate }): Promise<`0x${string}`>;
}

export interface PendingTransactionGuardOptions {
  client: PendingTransactionClient;
  account: Address;
  ceilings: FeeCeilings;
  /** KEEPER_STUCK_TX_REPLACE_SECONDS in milliseconds. */
  replaceAfterMs: number;
  log: KeeperLogger;
  /** Injectable clock for specs; Date.now otherwise. */
  now?: () => number;
}

export interface PendingTransactionGuard {
  /**
   * The nonce the next transaction must use. Throws while one is outstanding, after first
   * replacing it when it has been outstanding for longer than allowed.
   */
  nextNonce(): Promise<number>;
  /** Record a broadcast, so its age and fees are known if it sticks. */
  recordSent(nonce: number, fees: FeeEstimate): void;
}

/**
 * Node replies that mean the mempool already holds an offer at least as high as the one
 * just made, so the next attempt must bump over it. Any other send failure (an HTTP error,
 * a timeout, a rate limit, a full transaction pool) never changed what the mempool holds,
 * and the same offer stands for the next attempt.
 */
const REPLACEMENT_REFUSED = /underpriced|already known|already imported|known transaction|replacement transaction/i;

/** The lowest unmined nonce as this process knows it. */
interface OutstandingNonce {
  nonce: number;
  /** When it was sent or last replaced, or first seen outstanding after a restart. */
  since: number;
  /** The fees it was sent or last offered with; undefined when this process never knew them. */
  fees: FeeEstimate | undefined;
}

/**
 * A receipt timeout does not mean a transaction was dropped. The watch's per-tick
 * pool commitments cannot prevent the next tick from signing another transaction
 * for the same vault. Wait for the wallet's outstanding nonce before signing again,
 * including after a process restart. This keeper deliberately submits sequentially.
 *
 * Waiting alone left the keeper idle for as long as a
 * transaction priced under a rising base fee sat in the mempool, which is exactly the
 * moment a crash needs it. Once the lowest unmined nonce has been outstanding for
 * KEEPER_STUCK_TX_REPLACE_SECONDS, the guard replaces it with a zero-value transfer to
 * itself at that nonce, both fees raised by the replacement bump over those it was sent
 * with (a bumped fresh estimate after a restart, when they are unknown) and never above
 * the operator's ceilings. Where the ceilings leave no valid replacement it raises
 * keeper.stuck-tx-replacement-blocked and keeps refusing, as before. A replacement is
 * itself aged and replaced again if it sticks; the send that found the nonce outstanding
 * is still refused, and the next tick runs normally once the nonce mines.
 */
export const createPendingTransactionGuard = (
  options: PendingTransactionGuardOptions
): PendingTransactionGuard => {
  const { client, account, ceilings, replaceAfterMs, log } = options;
  const now = options.now ?? Date.now;
  let tracked: OutstandingNonce | undefined;
  /** The page already raised for a nonce the ceilings leave no replacement for. */
  let blocked: { nonce: number; reason: string } | undefined;

  const replace = async (outstanding: OutstandingNonce, ageMs: number): Promise<void> => {
    const decision = replacementFees(outstanding.fees, await client.estimateFeesPerGas(), ceilings);
    const context = {
      nonce: outstanding.nonce,
      ageSeconds: Math.floor(ageMs / 1000),
      originalFeesKnown: outstanding.fees !== undefined,
      previousMaxFeePerGas: outstanding.fees?.maxFeePerGas,
      previousMaxPriorityFeePerGas: outstanding.fees?.maxPriorityFeePerGas,
    };
    if (!decision.ok) {
      // The page is for the operator, once per nonce and reason: every later send in the
      // same state would otherwise raise it again, twice per vault per tick on the direct path.
      const repeated = blocked?.nonce === outstanding.nonce && blocked.reason === decision.reason;
      blocked = { nonce: outstanding.nonce, reason: decision.reason };
      if (repeated) {
        log.info(KEEPER_EVENTS.stuckTxReplacementBlocked, { ...context, reason: decision.reason, repeated: true });
      } else {
        log.error(KEEPER_EVENTS.stuckTxReplacementBlocked, { ...context, reason: decision.reason });
      }
      return;
    }
    blocked = undefined;
    try {
      const hash = await client.sendSelfTransfer({ nonce: outstanding.nonce, fees: decision.fees });
      tracked = { nonce: outstanding.nonce, since: now(), fees: decision.fees };
      log.warn(KEEPER_EVENTS.stuckTxReplaced, { ...context, ...decision.fees, hash });
    } catch (error) {
      // Only a node that saw the offer and called it underpriced (or already held one at
      // least as high) wants more, so only then does the next attempt bump over it. A send
      // that failed before the mempool saw it is offered again at the same fees; bumping
      // on every failure compounded the offer against fees nobody held and could run the
      // headroom out below the ceilings in one tick. The age stands either way, so the
      // next attempt comes on the next send.
      const reason = describeError(error);
      if (REPLACEMENT_REFUSED.test(reason)) {
        tracked = { ...outstanding, fees: decision.fees };
      }
      log.error(KEEPER_EVENTS.txFailed, {
        functionName: 'replace-stuck-nonce',
        ...context,
        reason,
      });
    }
  };

  return {
    nextNonce: async () => {
      const [confirmed, pending] = await Promise.all([
        client.getTransactionCount({ address: account, blockTag: 'latest' }),
        client.getTransactionCount({ address: account, blockTag: 'pending' }),
      ]);
      if (pending < confirmed) {
        throw new Error('Keeper has inconsistent nonce data (pending below latest); refusing to guess a nonce.');
      }
      if (pending === confirmed) {
        tracked = undefined;
        blocked = undefined;
        return confirmed;
      }
      const outstanding: OutstandingNonce =
        tracked !== undefined && tracked.nonce === confirmed
          ? tracked
          : { nonce: confirmed, since: now(), fees: undefined };
      tracked = outstanding;
      const ageMs = now() - outstanding.since;
      if (ageMs >= replaceAfterMs) {
        await replace(outstanding, ageMs);
      }
      throw new Error(
        `Keeper has a pending transaction at nonce ${confirmed}, outstanding for ${Math.floor(ageMs / 1000)} s; wait for confirmation before sending again.`
      );
    },
    recordSent: (nonce, fees) => {
      tracked = { nonce, since: now(), fees };
    },
  };
};
