import { getAddress } from 'viem';
import { settle } from './account';
import type { LedgerAccount } from './account';
import { SYNCING } from './codec';
import type { LedgerConfig } from './env';
import { EXPORT_DIGITS, formatUnitDays, formatUnits18 } from './figures';
import { decodePool, ledgerFingerprint } from './meta';
import { compounded } from './poolMirror';
import type { PoolState } from './poolMirror';
import type { LedgerStore } from './store';

/**
 * The whole ledger: every address the index holds a record for, with its three figures and
 * its three balances as of one block. This is the record that is published
 * (docs/USAGE_LEDGER.md section 7). The figures are computed exactly as the API computes
 * them, from the same stored records. Rows are in address order: the ledger ranks nobody.
 */

export interface LedgerRow {
  /** Checksummed. */
  address: string;
  /** Vault debt held over time, GSUSD-days. */
  debtGsusdDays: string;
  /** Stability pool deposit held over time, GSUSD-days. */
  poolGsusdDays: string;
  /** In-range liquidity provided over time, dollar-days at the peg. Zero while that dimension is off. */
  liquidityDollarDays: string;
  /** The balances the three figures were growing by at the as-of block. */
  debtGsusd: string;
  poolGsusd: string;
  liquidityDollars: string;
}

export interface LedgerExport {
  chainId: number;
  /** Checksummed. */
  vault: string;
  startTimestamp: number;
  /** True while the liquidity dimension is recorded. */
  liquidity: boolean;
  asOfBlock: string;
  asOfTimestamp: number;
  /** True when a tracking cap was reached, so some usage is missing. */
  incomplete: boolean;
  addresses: number;
  rows: LedgerRow[];
}

export interface ExportDeps {
  config: LedgerConfig;
  store: Pick<LedgerStore, 'readMeta' | 'loadAccounts'>;
}

const NOT_READY = 'The usage ledger holds no finished state for this configuration; let the API finish its run first.';
const MOVED = 'The usage ledger changed while it was read; run the export again.';

/**
 * Reads the whole index and settles every record to the index time. Throws, with a message
 * for the operator, when the index is absent, belongs to another configuration, is being
 * recomputed or moved during the read: an export is never partial.
 */
export const readLedger = async ({ config, store }: ExportDeps): Promise<LedgerExport> => {
  const meta = await store.readMeta();
  if (
    meta === undefined ||
    meta.cursor === null ||
    meta.syncedAt === SYNCING ||
    meta.fingerprint !== ledgerFingerprint(config)
  ) {
    throw new Error(NOT_READY);
  }
  const accounts = await store.loadAccounts();
  if ((await store.readMeta())?.stateId !== meta.stateId || accounts.size !== meta.accounts) throw new Error(MOVED);
  const pool = decodePool(meta.pool);
  const rows = [...accounts.keys()]
    .sort()
    .map((address) => rowOf(address, accounts.get(address) ?? fail(address), { asOfTimestamp: meta.asOfTimestamp, pool, start: config.startTimestamp }));
  return {
    chainId: config.chainId,
    vault: getAddress(config.vault),
    startTimestamp: config.startTimestamp,
    liquidity: config.liquidity !== undefined,
    asOfBlock: meta.cursor,
    asOfTimestamp: meta.asOfTimestamp,
    incomplete: meta.truncated,
    addresses: rows.length,
    rows,
  };
};

const fail = (address: string): never => {
  throw new Error(`the record of ${address} vanished while it was read`);
};

/** What a row is settled against: the time the ledger is as of, the pool mirror and the start of the record. */
export interface RowContext {
  asOfTimestamp: number;
  pool: PoolState;
  start: number;
}

/** One address's row: its stored record settled to the as-of time, as the API settles it. */
export const rowOf = (address: string, account: LedgerAccount, context: RowContext): LedgerRow => {
  const view = settle(account, context.asOfTimestamp, context.pool, context.start);
  return {
    address: getAddress(address),
    debtGsusdDays: formatUnitDays(view.debtRaw, EXPORT_DIGITS),
    poolGsusdDays: formatUnitDays(view.poolRaw, EXPORT_DIGITS),
    liquidityDollarDays: formatUnitDays(view.liquidityRaw, EXPORT_DIGITS),
    debtGsusd: formatUnits18(view.debt),
    poolGsusd: formatUnits18(compounded(view, context.pool)),
    liquidityDollars: formatUnits18(view.liquidity),
  };
};

const ROW_COLUMNS = [
  'address',
  'debtGsusdDays',
  'poolGsusdDays',
  'liquidityDollarDays',
  'debtGsusd',
  'poolGsusd',
  'liquidityDollars',
] as const;

/** The first line of the CSV, with its line end. */
export const CSV_HEADER = `${[...ROW_COLUMNS, 'asOfBlock', 'asOfTimestamp'].join(',')}\n`;

/**
 * One line of the CSV, with its line end. It is closed by the as-of block and time, so a
 * line taken alone still says what it describes. Every value is a number or a hex address,
 * so nothing needs quoting.
 */
export const csvLine = (row: LedgerRow, asOfBlock: string, asOfTimestamp: number): string =>
  `${[...ROW_COLUMNS.map((column) => row[column]), asOfBlock, asOfTimestamp].join(',')}\n`;

/**
 * The whole ledger as CSV: one header line and one line per address, in address order. The
 * API's download is built from the same two functions, line by line, so the two are the
 * same bytes for the same index.
 */
export const ledgerToCsv = (ledger: LedgerExport): string =>
  CSV_HEADER + ledger.rows.map((row) => csvLine(row, ledger.asOfBlock, ledger.asOfTimestamp)).join('');
