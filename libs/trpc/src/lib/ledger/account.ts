import { compounded } from './poolMirror';
import type { PoolState } from './poolMirror';

export interface LedgerAccount {
  /** Tracked vault debt principal, wei. */
  debt: bigint;
  /** The pool mirror's record of this depositor. */
  stored: bigint;
  snapP: bigint;
  snapScale: bigint;
  snapEpoch: bigint;
  /**
   * The value at the peg of the account's liquidity positions that are in range, dollars
   * with 18 decimals. Zero while the liquidity dimension is off.
   */
  liquidity: bigint;
  /** Vault debt held over time up to `ts`: wei times seconds. */
  debtRaw: bigint;
  /** Stability pool deposit held over time up to `ts`: wei times seconds. */
  poolRaw: bigint;
  /** In-range liquidity provided over time up to `ts`: dollar wei times seconds. */
  liquidityRaw: bigint;
  /** Unix seconds the three figures are settled to. */
  ts: number;
}

export const newAccount = (ts: number): LedgerAccount => ({
  debt: 0n,
  stored: 0n,
  snapP: 0n,
  snapScale: 0n,
  snapEpoch: 0n,
  liquidity: 0n,
  debtRaw: 0n,
  poolRaw: 0n,
  liquidityRaw: 0n,
  ts,
});

/** The seconds between two times that lie at or after the start of the record. */
const recordedSeconds = (from: number, to: number, start: number): bigint =>
  BigInt(Math.max(0, to - Math.max(from, start)));

/**
 * Brings an account's three figures up to `t` at its current balances: every second adds
 * the balance held during it, and nothing else. Pure: it returns a new record, or the same
 * one when `t` is not after the record's own time. The indexer calls it before every change
 * of a balance (the account's own events, every pool absorption and every move of the
 * liquidity pool's tick into or out of one of its ranges), and the API reader calls it to
 * bring a stored record up to the index time, so the two cannot disagree. `start` is
 * LEDGER_START_TIMESTAMP: time before it is not recorded.
 */
export const settle = (account: LedgerAccount, t: number, pool: PoolState, start: number): LedgerAccount => {
  if (t <= account.ts) return account;
  const seconds = recordedSeconds(account.ts, t, start);
  return {
    ...account,
    debtRaw: account.debtRaw + account.debt * seconds,
    poolRaw: account.poolRaw + compounded(account, pool) * seconds,
    liquidityRaw: account.liquidityRaw + account.liquidity * seconds,
    ts: t,
  };
};
