import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gunzipSync, gzipSync } from 'node:zlib';
import { createLedgerRecordHandlers, LEDGER_RECORD_CSV_PATH, LEDGER_RECORD_JSON_PATH } from './http';
import { ledgerToCsv, readLedger } from './export';
import { createIndexerMemory, indexLedger } from './indexer';
import { createMemoryLedgerStore } from './memoryStore';
import { createRecordCache } from './record';
import type { LedgerRecord, RecordCache } from './record';
import { createFakeChain, testConfig } from './testSupport';

const BODY = 'address,debtGsusdDays\n0x00000000000000000000000000000000000000A1,1.000000\n';
const SHA = createHash('sha256').update(BODY).digest('hex');
const record: LedgerRecord = {
  chainId: 11155111,
  vault: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
  startTimestamp: 1_800_000_000,
  liquidity: false,
  asOfBlock: '4321',
  asOfTimestamp: 1_800_000_500,
  records: 1,
  complete: true,
  sha256: SHA,
  bytes: Buffer.byteLength(BODY),
  gzip: [gzipSync(BODY).subarray(0, 10), gzipSync(BODY).subarray(10)],
  gzipBytes: gzipSync(BODY).length,
  stateId: '0123456789abcdef',
};

describe('the ledger download over HTTP', () => {
  let server: Server;
  let base: string;
  let cache: RecordCache | undefined;
  let current: LedgerRecord | undefined;

  beforeAll(async () => {
    const handlers = createLedgerRecordHandlers(() => cache);
    server = createServer((req, res) => {
      const handler = req.url === LEDGER_RECORD_CSV_PATH ? handlers.csv : handlers.json;
      void handler(req, res);
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((done) => server.close(() => done()));
  });
  beforeEach(() => {
    current = record;
    cache = { current: async () => current, summary: async () => undefined };
  });

  /** A raw request, so the body arrives as the server sent it: fetch would expand gzip by itself. */
  const get = (path: string, headers: Record<string, string> = {}, method = 'GET'): Promise<{ status: number; headers: Record<string, string>; body: Buffer }> =>
    new Promise((resolve, reject) => {
      const url = new URL(path, base);
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const request = (require('node:http') as typeof import('node:http')).request(
        { host: url.hostname, port: url.port, path: url.pathname, method, headers },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers as Record<string, string>, body: Buffer.concat(chunks) }));
        }
      );
      request.on('error', reject);
      request.end();
    });

  it('has stable paths at the root of the API', () => {
    expect(LEDGER_RECORD_CSV_PATH).toBe('/usage-ledger.csv');
    expect(LEDGER_RECORD_JSON_PATH).toBe('/usage-ledger.json');
  });

  it('sends the file compressed to a client that takes gzip, with the hash as its ETag', async () => {
    const res = await get(LEDGER_RECORD_CSV_PATH, { 'accept-encoding': 'gzip, deflate, br' });
    expect(res.status).toBe(200);
    expect(res.headers['content-encoding']).toBe('gzip');
    expect(gunzipSync(res.body).toString('utf8')).toBe(BODY);
    expect(res.headers['etag']).toBe(`"${SHA}"`);
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(res.headers['content-disposition']).toBe('attachment; filename="gold-standard-usage-ledger-11155111-4321.csv"');
    expect(res.headers['cache-control']).toBe('public, max-age=60');
    expect(res.headers['vary']).toBe('Accept-Encoding');
    expect(res.headers['x-ledger-as-of-block']).toBe('4321');
    expect(res.headers['x-ledger-sha256']).toBe(SHA);
    expect(res.headers['x-ledger-complete']).toBe('true');
    expect(Number(res.headers['content-length'])).toBe(res.body.length);
  });

  it('sends the same bytes expanded to a client that does not take gzip', async () => {
    const without: Record<string, string>[] = [{}, { 'accept-encoding': 'identity' }, { 'accept-encoding': 'gzip;q=0, br' }];
    for (const headers of without) {
      const res = await get(LEDGER_RECORD_CSV_PATH, headers);
      expect(res.status).toBe(200);
      expect(res.headers['content-encoding']).toBeUndefined();
      expect(res.body.toString('utf8')).toBe(BODY);
      expect(createHash('sha256').update(res.body).digest('hex')).toBe(SHA);
    }
  });

  it('answers 304 with no body to a client that already holds the file', async () => {
    for (const tag of [`"${SHA}"`, `W/"${SHA}"`, `"other", "${SHA}"`]) {
      const res = await get(LEDGER_RECORD_CSV_PATH, { 'if-none-match': tag, 'accept-encoding': 'gzip' });
      expect(res.status).toBe(304);
      expect(res.body.length).toBe(0);
      expect(res.headers['etag']).toBe(`"${SHA}"`);
    }
    expect((await get(LEDGER_RECORD_CSV_PATH, { 'if-none-match': '"stale"' })).status).toBe(200);
  });

  it('answers a HEAD with the headers and no body', async () => {
    const res = await get(LEDGER_RECORD_CSV_PATH, { 'accept-encoding': 'gzip' }, 'HEAD');
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(0);
    expect(res.headers['etag']).toBe(`"${SHA}"`);
  });

  it('describes the file in the companion JSON, without its body', async () => {
    const res = await get(LEDGER_RECORD_JSON_PATH);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(res.headers['etag']).toBe(`"${SHA}"`);
    expect(JSON.parse(res.body.toString('utf8'))).toEqual({
      chainId: 11155111,
      vault: record.vault,
      startTimestamp: 1_800_000_000,
      liquidity: false,
      asOfBlock: '4321',
      asOfTimestamp: 1_800_000_500,
      records: 1,
      complete: true,
      sha256: SHA,
      bytes: BODY.length,
      csv: '/usage-ledger.csv',
    });
    expect((await get(LEDGER_RECORD_JSON_PATH, { 'if-none-match': `"${SHA}"` })).status).toBe(304);
  });

  it('says in the headers and in the JSON when the ledger is incomplete', async () => {
    current = { ...record, complete: false };
    expect((await get(LEDGER_RECORD_CSV_PATH)).headers['x-ledger-complete']).toBe('false');
    expect(JSON.parse((await get(LEDGER_RECORD_JSON_PATH)).body.toString('utf8')).complete).toBe(false);
  });

  it('answers 503 with Retry-After, uncached, while the ledger is recomputed', async () => {
    current = undefined;
    for (const path of [LEDGER_RECORD_CSV_PATH, LEDGER_RECORD_JSON_PATH]) {
      const res = await get(path);
      expect(res.status).toBe(503);
      expect(res.headers['retry-after']).toBe('60');
      expect(res.headers['cache-control']).toBe('no-store');
      expect(JSON.parse(res.body.toString('utf8'))).toEqual({ error: 'The usage ledger is being recomputed from on-chain events' });
    }
  });

  it('answers 404 while the ledger is off', async () => {
    cache = undefined;
    for (const path of [LEDGER_RECORD_CSV_PATH, LEDGER_RECORD_JSON_PATH]) {
      const res = await get(path);
      expect(res.status).toBe(404);
      expect(JSON.parse(res.body.toString('utf8'))).toEqual({ error: 'The usage ledger is not running' });
    }
  });

  it('serves, from a real index, exactly the bytes the export tool writes, and the hash it announces', async () => {
    const config = testConfig();
    const store = createMemoryLedgerStore();
    const chain = createFakeChain(config);
    const ONE = 10n ** 18n;
    chain.emit(400n, 'vault', 'DebtMinted', { user: '0x00000000000000000000000000000000000000A1', amount: 1_000n * ONE });
    chain.emit(420n, 'pool', 'Deposited', { user: '0x00000000000000000000000000000000000000B2', amount: 600n * ONE });
    chain.head = 900n;
    const now = Date.now();
    await indexLedger(chain, store, config, createIndexerMemory(), () => now);
    cache = createRecordCache({ config, store });
    const fromTool = Buffer.from(ledgerToCsv(await readLedger({ config, store })), 'utf8');

    const plain = await get(LEDGER_RECORD_CSV_PATH);
    expect(plain.body.equals(fromTool)).toBe(true);
    const compressed = await get(LEDGER_RECORD_CSV_PATH, { 'accept-encoding': 'gzip' });
    expect(gunzipSync(compressed.body).equals(fromTool)).toBe(true);
    const described = JSON.parse((await get(LEDGER_RECORD_JSON_PATH)).body.toString('utf8')) as { sha256: string; records: number; bytes: number };
    expect(described.sha256).toBe(createHash('sha256').update(fromTool).digest('hex'));
    expect(plain.headers['etag']).toBe(`"${described.sha256}"`);
    expect(described.records).toBe(2);
    expect(described.bytes).toBe(fromTool.length);
  });
});
