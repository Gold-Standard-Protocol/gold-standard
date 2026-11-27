import { newAccount } from './account';
import type { LedgerAccount } from './account';
import type { LiquidityLimits, LiquidityPosition } from './liquidity';
import type { PoolState } from './poolMirror';

export interface ReplayLimits {
  /** LEDGER_START_TIMESTAMP. */
  start: number;
  /** LEDGER_MAX_ADDRESSES: the most address records the ledger opens. */
  maxAccounts: number;
  minTrackedDeposit: bigint;
  /** Set while the liquidity dimension is on. */
  liquidity?: LiquidityLimits;
}

/** The copy of the state one replay works on. */
export interface Working {
  pool: PoolState;
  accounts: Map<string, LedgerAccount>;
  truncated: boolean;
  dirty: Set<string>;
  tick: number | null;
  positions: Map<string, LiquidityPosition>;
  positionsDirty: Set<string>;
  positionsRemoved: Set<string>;
}

/**
 * A new record as of `t`, or undefined when the cap refuses it. The ledger
 * never deletes a record, so a slot is never freed: at the cap no new record is opened,
 * every existing record keeps counting and the ledger is marked incomplete until the
 * operator raises the cap, which recomputes it in full. The caller stores the record.
 */
export const openAccount = (working: Working, t: number, limits: ReplayLimits): LedgerAccount | undefined => {
  if (working.accounts.size < limits.maxAccounts) return newAccount(t);
  working.truncated = true;
  return undefined;
};
