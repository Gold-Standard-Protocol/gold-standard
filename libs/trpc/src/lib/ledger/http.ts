import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import type { LedgerRecord, RecordCache } from './record';
import { summaryOf } from './record';
import { getLedgerRuntime } from './runtime';

/**
 * The whole record over plain HTTP, beside the tRPC surface: a CSV to download and a small
 * JSON that describes it. Both are public, read only and cacheable.
 */
export const LEDGER_RECORD_CSV_PATH = '/usage-ledger.csv';
export const LEDGER_RECORD_JSON_PATH = '/usage-ledger.json';

/** The index writes a state a minute, so a copy older than that may describe an earlier block. */
const CACHE_CONTROL = 'public, max-age=60';
const RETRY_AFTER_SECONDS = '60';

export interface LedgerRecordHandlers {
  csv: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  json: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
}

const sendJson = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void => {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text), ...headers });
  res.end(text);
};

const etagOf = (record: LedgerRecord): string => `"${record.sha256}"`;

const accepts = (req: IncomingMessage, encoding: string): boolean =>
  String(req.headers['accept-encoding'] ?? '')
    .split(',')
    .some((entry) => {
      const [name, ...parameters] = entry.trim().toLowerCase().split(';');
      return name === encoding && !parameters.some((parameter) => /^\s*q=0(\.0+)?\s*$/.test(parameter));
    });

/** True when the client already holds this file: its If-None-Match names the body's hash. */
const holdsIt = (req: IncomingMessage, record: LedgerRecord): boolean =>
  String(req.headers['if-none-match'] ?? '')
    .split(',')
    .map((tag) => tag.trim().replace(/^W\//, ''))
    .some((tag) => tag === etagOf(record) || tag === '*');

/** The Vary value with `name` added to whatever an earlier handler (CORS) already set. */
const varyWith = (res: ServerResponse, name: string): string => {
  const existing = res.getHeader('Vary');
  const names = (Array.isArray(existing) ? existing.join(',') : String(existing ?? '')).split(',').map((entry) => entry.trim()).filter(Boolean);
  return [...new Set([...names, name])].join(', ');
};

const recordHeaders = (record: LedgerRecord): Record<string, string> => ({
  ETag: etagOf(record),
  'Cache-Control': CACHE_CONTROL,
  'X-Ledger-As-Of-Block': record.asOfBlock,
  'X-Ledger-Sha256': record.sha256,
  'X-Ledger-Complete': String(record.complete),
});

/** The file to answer with, or the answer already sent when there is none. */
const recordFor = async (cache: () => RecordCache | undefined, res: ServerResponse): Promise<LedgerRecord | undefined> => {
  const source = cache();
  if (source === undefined) {
    sendJson(res, 404, { error: 'The usage ledger is not running' }, { 'Cache-Control': 'no-store' });
    return undefined;
  }
  const record = await source.current(Date.now());
  if (record === undefined) {
    sendJson(
      res,
      503,
      { error: 'The usage ledger is being recomputed from on-chain events' },
      { 'Retry-After': RETRY_AFTER_SECONDS, 'Cache-Control': 'no-store' }
    );
  }
  return record;
};

const sendCsv = async (req: IncomingMessage, res: ServerResponse, record: LedgerRecord): Promise<void> => {
  const headers = {
    ...recordHeaders(record),
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="gold-standard-usage-ledger-${record.chainId}-${record.asOfBlock}.csv"`,
    Vary: varyWith(res, 'Accept-Encoding'),
  };
  if (holdsIt(req, record)) {
    res.writeHead(304, headers);
    res.end();
    return;
  }
  // The file is kept compressed and sent as it is, piece by piece. A client that cannot take
  // gzip gets it expanded as it is sent, so no request ever holds the whole file in memory.
  const compressed = accepts(req, 'gzip');
  res.writeHead(200, {
    ...headers,
    ...(compressed ? { 'Content-Encoding': 'gzip' } : {}),
    'Content-Length': compressed ? record.gzipBytes : record.bytes,
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  const pieces = Readable.from(record.gzip, { objectMode: false });
  await (compressed ? pipeline(pieces, res) : pipeline(pieces, createGunzip(), res));
};

/**
 * The two handlers. With the ledger off they answer 404; while it is being recomputed, 503
 * with Retry-After. `cache` defaults to the running API's own.
 */
export const createLedgerRecordHandlers = (
  cache: () => RecordCache | undefined = () => getLedgerRuntime()?.record
): LedgerRecordHandlers => ({
  csv: async (req, res) => {
    const record = await recordFor(cache, res);
    if (record !== undefined) await sendCsv(req, res, record);
  },
  json: async (req, res) => {
    const record = await recordFor(cache, res);
    if (record === undefined) return;
    if (holdsIt(req, record)) {
      res.writeHead(304, recordHeaders(record));
      res.end();
      return;
    }
    sendJson(res, 200, { ...summaryOf(record), csv: LEDGER_RECORD_CSV_PATH }, recordHeaders(record));
  },
});
