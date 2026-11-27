import { createHash } from 'node:crypto';
import { createGzip } from 'node:zlib';
import { getAddress } from 'viem';
import { describeError } from '../config/redact';
import { decodeAccount } from './codec';
import type { LedgerConfig } from './env';
import { CSV_HEADER, csvLine, rowOf } from './export';
import { decodePool } from './meta';
import { usableMeta } from './reader';
import type { UsableMeta } from './reader';
import type { LedgerStore } from './store';

/**
 * The whole record as one file: the published form of the ledger (docs/TOKEN_POLICY.md
 * section 2). The API serves it for download, and the export tool writes the same bytes
 * from the same index. The body is CSV in address order; what describes it (the block it is
 * as of, how many records, whether the ledger is complete and the SHA-256 of the body)
 * travels beside it, so the hash covers exactly the bytes a reader downloads.
 */
export interface RecordSummary {
  chainId: number;
  /** Checksummed. */
  vault: string;
  startTimestamp: number;
  /** True while the liquidity dimension is recorded. */
  liquidity: boolean;
  asOfBlock: string;
  asOfTimestamp: number;
  /** Address records in the file: its line count less the header. */
  records: number;
  /** False when a cap was reached, so some usage is missing from the ledger. */
  complete: boolean;
  /** SHA-256 of the CSV body, lowercase hex. */
  sha256: string;
  /** Length of the CSV body in bytes. */
  bytes: number;
}

export interface LedgerRecord extends RecordSummary {
  /**
   * The CSV body, gzip compressed, as the pieces the compressor produced: what is kept and
   * what most clients are sent, piece by piece, so the file is never copied into one block.
   */
  gzip: readonly Buffer[];
  /** Length of the compressed body in bytes. */
  gzipBytes: number;
  /** The index state the file was built from. */
  stateId: string;
}

export interface RecordDeps {
  config: LedgerConfig;
  store: Pick<LedgerStore, 'readMetaRaw' | 'listAddresses' | 'readAccountsRaw'>;
}

/** Records read, formatted and compressed per step; between steps the event loop serves other requests. */
const ROWS_PER_STEP = 500;
/** The index commits once a minute, so a build that loses a race with it starts over a few times at most. */
const BUILD_ATTEMPTS = 3;

const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Collects a gzip stream's output while the body is written through it, hashing the plain bytes. */
const createSink = () => {
  const gzip = createGzip();
  const hash = createHash('sha256');
  const chunks: Buffer[] = [];
  let bytes = 0;
  gzip.on('data', (chunk: Buffer) => chunks.push(chunk));
  const finished = new Promise<void>((resolve, reject) => {
    gzip.on('end', resolve);
    gzip.on('error', reject);
  });
  return {
    write: async (text: string): Promise<void> => {
      const plain = Buffer.from(text, 'utf8');
      hash.update(plain);
      bytes += plain.length;
      if (!gzip.write(plain)) await new Promise<void>((resolve) => gzip.once('drain', resolve));
    },
    finish: async (): Promise<{ gzip: Buffer[]; gzipBytes: number; sha256: string; bytes: number }> => {
      gzip.end();
      await finished;
      return { gzip: chunks, gzipBytes: chunks.reduce((total, chunk) => total + chunk.length, 0), sha256: hash.digest('hex'), bytes };
    },
  };
};

type Attempt = { outcome: 'built'; record: LedgerRecord } | { outcome: 'moved' };

const stateIdNow = async (deps: RecordDeps, now: number): Promise<string | undefined> =>
  usableMeta(await deps.store.readMetaRaw(), deps.config, now)?.meta.stateId;

/**
 * One pass over the store: the addresses in order, their records a step at a time, each
 * settled and written as its CSV line. What is held is the sorted addresses and the
 * compressed output; no row is kept once it is written.
 */
const attemptBuild = async (deps: RecordDeps, usable: UsableMeta, now: number): Promise<Attempt> => {
  const { meta, cursor } = usable;
  const addresses = (await deps.store.listAddresses()).sort();
  if (addresses.length !== meta.accounts) return { outcome: 'moved' };
  const context = { asOfTimestamp: meta.asOfTimestamp, pool: decodePool(meta.pool), start: deps.config.startTimestamp };
  const sink = createSink();
  await sink.write(CSV_HEADER);
  for (let start = 0; start < addresses.length; start += ROWS_PER_STEP) {
    const step = addresses.slice(start, start + ROWS_PER_STEP);
    const stored = await deps.store.readAccountsRaw(step);
    let lines = '';
    for (let index = 0; index < step.length; index += 1) {
      const account = decodeAccount(stored[index]);
      // A record that is gone or unreadable means the state moved under the read, or is being rebuilt.
      if (account === undefined) return { outcome: 'moved' };
      lines += csvLine(rowOf(step[index], account, context), cursor, meta.asOfTimestamp);
    }
    await sink.write(lines);
    await yieldToEventLoop();
  }
  const body = await sink.finish();
  if ((await stateIdNow(deps, now)) !== meta.stateId) return { outcome: 'moved' };
  return {
    outcome: 'built',
    record: {
      chainId: deps.config.chainId,
      vault: getAddress(deps.config.vault),
      startTimestamp: deps.config.startTimestamp,
      liquidity: deps.config.liquidity !== undefined,
      asOfBlock: cursor,
      asOfTimestamp: meta.asOfTimestamp,
      records: addresses.length,
      complete: !meta.truncated,
      ...body,
      stateId: meta.stateId,
    },
  };
};

/**
 * Builds the file from the store as it is now. Undefined when the ledger cannot be answered
 * from (no fresh, checked state of this configuration) or kept moving under every attempt:
 * a file is whole and of one block, or there is none.
 */
export const buildRecord = async (deps: RecordDeps, now: number): Promise<LedgerRecord | undefined> => {
  for (let attempt = 0; attempt < BUILD_ATTEMPTS; attempt += 1) {
    const usable = usableMeta(await deps.store.readMetaRaw(), deps.config, now);
    if (usable === undefined) return undefined;
    const result = await attemptBuild(deps, usable, now);
    if (result.outcome === 'built') return result.record;
  }
  return undefined;
};

export interface RecordCache {
  /** The file for the index as it is now, built at most once per indexed state. Undefined when there is none to serve. */
  current(now: number): Promise<LedgerRecord | undefined>;
  /** What describes the current file, without its body. */
  summary(now: number): Promise<RecordSummary | undefined>;
}

export const summaryOf = (record: LedgerRecord): RecordSummary => {
  const { gzip: _gzip, gzipBytes: _gzipBytes, stateId: _stateId, ...summary } = record;
  return summary;
};

/**
 * Keeps one file per process. The index writes a new state once a minute, and the file is
 * rebuilt only when someone asks for it after that: at most once a minute however many ask,
 * and never while nobody does. Concurrent callers share one build. A request costs one
 * Redis read while the file is current. The download and the status answer therefore always
 * describe the same block as the index, which is what lets anyone compare the hash with the
 * export tool's output for that block.
 */
export const createRecordCache = (deps: RecordDeps): RecordCache => {
  let cached: LedgerRecord | undefined;
  let building: Promise<LedgerRecord | undefined> | undefined;

  const current = async (now: number): Promise<LedgerRecord | undefined> => {
    try {
      const stateId = await stateIdNow(deps, now);
      if (stateId === undefined) return undefined;
      if (cached?.stateId === stateId) return cached;
      building ??= buildRecord(deps, now).finally(() => {
        building = undefined;
      });
      const built = await building;
      if (built !== undefined) cached = built;
      return built;
    } catch (error) {
      console.error('Failed to build the usage ledger download:', describeError(error));
      return undefined;
    }
  };

  return {
    current,
    summary: async (now) => {
      const record = await current(now);
      return record === undefined ? undefined : summaryOf(record);
    },
  };
};
