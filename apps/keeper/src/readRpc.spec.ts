import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createPublicClient, http } from 'viem';
import { sepolia } from 'viem/chains';
import type { KeeperLogger } from '@goldstandard/trpc/keeper';
import { checkReadRpcUrls, createReadPublicClient } from './readRpc';

type Reply = { status: number; body?: unknown };

interface FakeNode {
  /** Carries a path segment standing in for a provider key, which must never reach a log. */
  url: string;
  methods: string[];
  close(): Promise<void>;
}

/** A JSON-RPC endpoint on localhost that records each method it is asked and answers as told. */
const startNode = async (answer: (method: string) => Reply): Promise<FakeNode> => {
  const methods: string[] = [];
  const server: Server = createServer((request, response) => {
    let raw = '';
    request.on('data', (chunk: Buffer) => {
      raw += chunk.toString();
    });
    request.on('end', () => {
      const { id, method } = JSON.parse(raw) as { id: number; method: string };
      methods.push(method);
      const reply = answer(method);
      response.writeHead(reply.status, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ jsonrpc: '2.0', id, ...(reply.body as object) }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/v2/provider-key-${port}`,
    methods,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
};

const healthy = (method: string): Reply =>
  method === 'eth_chainId'
    ? { status: 200, body: { result: '0xaa36a7' } }
    : { status: 200, body: { result: '0x10' } };

const rateLimited = (): Reply => ({ status: 429, body: { error: { code: -32005, message: 'rate limited' } } });

const reverting = (): Reply => ({
  status: 200,
  body: { error: { code: 3, message: 'execution reverted: Not liquidatable', data: '0x' } },
});

const createStubLogger = (): { log: KeeperLogger; events: Array<{ event: string; fields?: Record<string, unknown> }> } => {
  const events: Array<{ event: string; fields?: Record<string, unknown> }> = [];
  const push = (event: string, fields?: Record<string, unknown>): void => {
    events.push({ event, fields });
  };
  return { log: { info: push, warn: push, error: push }, events };
};

describe('createReadPublicClient', () => {
  const nodes: FakeNode[] = [];
  const node = async (answer: (method: string) => Reply): Promise<FakeNode> => {
    const started = await startNode(answer);
    nodes.push(started);
    return started;
  };

  afterEach(async () => {
    await Promise.all(nodes.splice(0).map((started) => started.close()));
  });

  it('reads through a working read endpoint and leaves the send endpoint alone', async () => {
    const read = await node(healthy);
    const send = await node(healthy);

    const client = createReadPublicClient(sepolia, [read.url], send.url);

    expect(await client.getBlockNumber({ cacheTime: 0 })).toBe(16n);
    expect(read.methods).toEqual(['eth_blockNumber']);
    expect(send.methods).toEqual([]);
  });

  it('moves past a rate-limited read endpoint to the next, and to the send endpoint last', async () => {
    const limited = await node(rateLimited);
    const down = await node(rateLimited);
    const send = await node(healthy);

    const client = createReadPublicClient(sepolia, [limited.url, down.url], send.url);

    expect(await client.getBlockNumber({ cacheTime: 0 })).toBe(16n);
    expect(limited.methods[0]).toBe('eth_blockNumber');
    expect(down.methods[0]).toBe('eth_blockNumber');
    expect(send.methods).toEqual(['eth_blockNumber']);
  });

  it('does not ask another endpoint when the contract reverts, since each would answer alike', async () => {
    const read = await node(reverting);
    const send = await node(healthy);

    const client = createReadPublicClient(sepolia, [read.url], send.url);

    await expect(
      client.call({ to: '0x5fbdb2315678afecb367f032d93f642f64180aa3', data: '0x12345678' })
    ).rejects.toThrow(/Not liquidatable/);
    expect(read.methods).toEqual(['eth_call']);
    expect(send.methods).toEqual([]);
  });

  it('reads from the send endpoint alone when no read endpoint is configured, as before', async () => {
    const send = await node(healthy);

    const client = createReadPublicClient(sepolia, [], send.url);

    expect(await client.getBlockNumber({ cacheTime: 0 })).toBe(16n);
    expect(send.methods).toEqual(['eth_blockNumber']);
  });
});

describe('checkReadRpcUrls', () => {
  const nodes: FakeNode[] = [];
  afterEach(async () => {
    await Promise.all(nodes.splice(0).map((started) => started.close()));
  });

  const getChainId = (url: string): Promise<number> =>
    createPublicClient({ transport: http(url, { retryCount: 0 }) }).getChainId();
  /** The endpoints as parseKeeperConfig hands them over, with nothing dropped from the variable. */
  const numbered = (urls: readonly string[]) => urls.map((url, index) => ({ url, entry: index + 1 }));

  it('keeps every endpoint that answers the configured chain, in order', async () => {
    const first = await startNode(healthy);
    const second = await startNode(healthy);
    nodes.push(first, second);
    const { log, events } = createStubLogger();

    const check = await checkReadRpcUrls(numbered([first.url, second.url]), 11155111, getChainId, log);

    expect(check).toEqual({ ok: true, urls: [first.url, second.url] });
    expect(events).toEqual([]);
  });

  it('refuses to start on an endpoint for another chain, naming its position and not its URL', async () => {
    const good = await startNode(healthy);
    const mainnet = await startNode(() => ({ status: 200, body: { result: '0x1' } }));
    nodes.push(good, mainnet);
    const { log } = createStubLogger();

    const check = await checkReadRpcUrls(numbered([good.url, mainnet.url]), 11155111, getChainId, log);

    expect(check.ok).toBe(false);
    expect(!check.ok && check.reason).toBe(
      'KEEPER_READ_RPC_URLS entry 2 answers eth_chainId 1 but KEEPER_CHAIN_ID is 11155111; refusing to start.'
    );
  });

  it('leaves out an endpoint that does not answer, with a warning that never carries the URL', async () => {
    const good = await startNode(healthy);
    const gone = await startNode(healthy);
    nodes.push(good);
    await gone.close();
    const { log, events } = createStubLogger();

    const check = await checkReadRpcUrls(numbered([gone.url, good.url]), 11155111, getChainId, log);

    expect(check).toEqual({ ok: true, urls: [good.url] });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ event: 'keeper.read-rpc-unavailable', fields: { entry: 1 } });
    // describeError keeps the scheme and host and redacts the path and query, where
    // providers put their keys, as for every other keeper log line.
    expect(JSON.stringify(events)).not.toContain('provider-key');
    expect(JSON.stringify(events)).toContain('/<redacted>');
  });

  it('names an endpoint by its position in KEEPER_READ_RPC_URLS, not in the list left after parsing', async () => {
    // KEEPER_READ_RPC_URLS="<KEEPER_RPC_URL>,,<mainnet>": the parser drops the send URL and
    // the blank, so the mainnet endpoint is the first one checked but the third in the variable.
    const mainnet = await startNode(() => ({ status: 200, body: { result: '0x1' } }));
    const gone = await startNode(healthy);
    nodes.push(mainnet);
    await gone.close();
    const { log, events } = createStubLogger();

    const refused = await checkReadRpcUrls([{ url: mainnet.url, entry: 3 }], 11155111, getChainId, log);
    expect(!refused.ok && refused.reason).toBe(
      'KEEPER_READ_RPC_URLS entry 3 answers eth_chainId 1 but KEEPER_CHAIN_ID is 11155111; refusing to start.'
    );

    await checkReadRpcUrls([{ url: gone.url, entry: 4 }], 11155111, getChainId, log);
    expect(events[0]).toMatchObject({ event: 'keeper.read-rpc-unavailable', fields: { entry: 4 } });
  });
});
