import { getAddress } from 'viem';
import { describeError } from '../config/redact';
import { settle } from './account';
import { decodeAccount, decodeMeta } from './codec';
import type { LedgerMeta } from './codec';
import type { LedgerConfig } from './env';
import { formatUnitDays } from './figures';
import { LEDGER_STALE_AFTER_MS, LEDGER_SYNC_STAMP_SKEW_MS } from './limits';
import { decodePool, ledgerFingerprint } from './meta';
import { compounded } from './poolMirror';
import type { RecordCache, RecordSummary } from './record';
import type { LedgerStore } from './store';

/** What the ledger records, as the dapp states it; it comes from configuration alone. */
export interface LedgerTerms {
  /** Unix seconds from which usage is recorded. */
  startTimestamp: number;
  /** True while liquidity in the configured pool is recorded as the third dimension. */
  liquidity: boolean;
}

export type StatusResponse =
  | { status: 'disabled' }
  | { status: 'unavailable'; terms: LedgerTerms }
  | {
      status: 'ok';
      terms: LedgerTerms;
      asOfBlock: string;
      asOfTimestamp: number;
      /** Addresses the ledger holds a record for. */
      addresses: number;
      /** True when a tracking cap was reached, so some usage is not recorded. */
      incomplete: boolean;
      /**
       * The whole record as the API serves it for download: the block it is as of and the
       * SHA-256 of its body. Null while the file is being prepared.
       */
      record: RecordSummary | null;
    };

export type AccountResponse =
  | { status: 'disabled' }
  | { status: 'unavailable' }
  | {
      status: 'ok';
      address: string;
      asOfBlock: string;
      asOfTimestamp: number;
      /**
       * Usage held over time, one figure per dimension and never a sum of them: GSUSD-days of
       * vault debt, GSUSD-days of stability pool deposit and dollar-days of in-range
       * liquidity, each with two fraction digits, rounded down. `liquidity` is zero while
       * that dimension is off.
       */
      usage: { debt: string; pool: string; liquidity: string };
      /**
       * Wei, as tracked by the index. `liquidity` is the value at the peg, in dollars with 18
       * decimals, of the wallet's positions that are in range.
       */
      balances: { debt: string; poolDeposit: string; liquidity: string };
    };

export interface ReaderDeps {
  config: LedgerConfig;
  store: LedgerStore;
  /** The download's current file, when the caller serves one. */
  record?: Pick<RecordCache, 'summary'>;
}

export const describeTerms = (config: LedgerConfig): LedgerTerms => ({
  startTimestamp: config.startTimestamp,
  liquidity: config.liquidity !== undefined,
});

/** True when the stamp is a time within LEDGER_STALE_AFTER_MS of `now`, as the owner index judges its own. */
export const isLedgerIndexFresh = (syncedAt: string, now: number): boolean => {
  if (!/^\d+$/.test(syncedAt)) return false;
  const stamp = Number(syncedAt);
  return now - stamp < LEDGER_STALE_AFTER_MS && stamp - now <= LEDGER_SYNC_STAMP_SKEW_MS;
};

export interface UsableMeta {
  meta: LedgerMeta;
  cursor: string;
}

/** A meta that may be answered from: this configuration's, complete and recently checked. */
export const usableMeta = (raw: string | null, config: LedgerConfig, now: number): UsableMeta | undefined => {
  const meta = decodeMeta(raw);
  if (meta === undefined || meta.cursor === null) return undefined;
  if (meta.fingerprint !== ledgerFingerprint(config)) return undefined;
  if (!isLedgerIndexFresh(meta.syncedAt, now)) return undefined;
  return { meta, cursor: meta.cursor };
};

/**
 * The state of the ledger as the last finished run left it. Anything short of a fresh,
 * readable index for the configured chain (a stale stamp, a rebuild in progress, an
 * unparsable value, a Redis failure) answers `unavailable`: never an error and never
 * partial numbers.
 */
export const readStatus = async (deps: ReaderDeps, chainId: number, now: number): Promise<StatusResponse> => {
  const terms = describeTerms(deps.config);
  const unavailable: StatusResponse = { status: 'unavailable', terms };
  if (chainId !== deps.config.chainId) return unavailable;
  try {
    const usable = usableMeta(await deps.store.readMetaRaw(), deps.config, now);
    if (usable === undefined) return unavailable;
    return {
      status: 'ok',
      terms,
      asOfBlock: usable.cursor,
      asOfTimestamp: usable.meta.asOfTimestamp,
      addresses: usable.meta.accounts,
      incomplete: usable.meta.truncated,
      record: (await deps.record?.summary(now)) ?? null,
    };
  } catch (error) {
    console.error('Failed to read the usage ledger status:', describeError(error));
    return unavailable;
  }
};

/** Null when absent, undefined when present but unreadable. */
const optional = <Value>(raw: string | null, decode: (raw: string) => Value | undefined): Value | null | undefined =>
  raw === null ? null : decode(raw);

/**
 * One wallet's record: its stored record settled to the index time with the same function
 * the indexer uses. A wallet with no record has zeros, unless the ledger is incomplete, in
 * which case the record may be one a cap refused and the answer is `unavailable`.
 */
export const readAccount = async (
  deps: ReaderDeps,
  chainId: number,
  address: string,
  now: number
): Promise<AccountResponse> => {
  const unavailable: AccountResponse = { status: 'unavailable' };
  if (chainId !== deps.config.chainId) return unavailable;
  try {
    const raw = await deps.store.readAccountView(address.toLowerCase());
    const usable = usableMeta(raw.meta, deps.config, now);
    const account = optional(raw.account, decodeAccount);
    if (usable === undefined || account === undefined) return unavailable;
    if (account === null && usable.meta.truncated) return unavailable;
    const pool = decodePool(usable.meta.pool);
    const view = account === null ? undefined : settle(account, usable.meta.asOfTimestamp, pool, deps.config.startTimestamp);
    return {
      status: 'ok',
      address: getAddress(address),
      asOfBlock: usable.cursor,
      asOfTimestamp: usable.meta.asOfTimestamp,
      usage: {
        debt: formatUnitDays(view?.debtRaw ?? 0n),
        pool: formatUnitDays(view?.poolRaw ?? 0n),
        liquidity: formatUnitDays(view?.liquidityRaw ?? 0n),
      },
      balances: {
        debt: (view?.debt ?? 0n).toString(),
        poolDeposit: (view === undefined ? 0n : compounded(view, pool)).toString(),
        liquidity: (view?.liquidity ?? 0n).toString(),
      },
    };
  } catch (error) {
    console.error('Failed to read a usage ledger account:', describeError(error));
    return unavailable;
  }
};
