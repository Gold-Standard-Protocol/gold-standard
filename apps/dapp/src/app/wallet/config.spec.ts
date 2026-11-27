import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connect, disconnect, getChainId, getClient, getConnection, reconnect, switchChain } from '@wagmi/core';
import { mainnet, sepolia } from 'viem/chains';
import type { EIP1193Provider } from 'viem';
import { SAFE_ALLOWED_ORIGINS, createWalletConfig, walletChains, walletConnectProjectId, walletConnectRpcMap } from './config';
import { FakeUniversalProvider } from './fakeUniversalProvider';

const sdkModule = vi.hoisted(() => ({ init: vi.fn() }));
vi.mock('@walletconnect/universal-provider', () => ({ default: { init: sdkModule.init } }));

// The SDK import happens inside @wagmi/connectors, which Vitest cannot intercept, so the
// Coinbase connector is replaced by a stub with the same surface: `create` counts every
// time the SDK would be constructed.
const coinbase = vi.hoisted(() => ({ create: vi.fn(), parameters: [] as unknown[] }));
vi.mock('wagmi/connectors/coinbaseWallet', async () => {
  const { createConnector } = await import('@wagmi/core');
  return {
    coinbaseWallet: (parameters: unknown) => {
      coinbase.parameters.push(parameters);
      let provider: ReturnType<typeof coinbaseProvider> | undefined;
      return createConnector(() => ({
        id: 'coinbaseWalletSDK', name: 'Coinbase Wallet', type: 'coinbaseWallet',
        async getProvider() {
          if (!provider) { coinbase.create(parameters); provider = coinbaseProvider(); }
          return provider;
        },
        async connect() { await this.getProvider(); return { accounts: [ACCOUNT] as never, chainId: 1 }; },
        async disconnect() { await this.getProvider(); },
        async getAccounts() { return [ACCOUNT]; },
        async getChainId() { return 1; },
        async isAuthorized() { return (await this.getAccounts()).length > 0; },
        onAccountsChanged() { return undefined; },
        onChainChanged() { return undefined; },
        onDisconnect() { return undefined; },
      }));
    },
  };
});

const safeParameters = vi.hoisted(() => ({ calls: [] as unknown[] }));
vi.mock('wagmi/connectors/safe', async (importOriginal) => {
  const actual = await importOriginal<typeof import('wagmi/connectors/safe')>();
  return {
    ...actual,
    safe: (parameters: Parameters<typeof actual.safe>[0]) => {
      safeParameters.calls.push(parameters);
      return actual.safe(parameters);
    },
  };
});

const ACCOUNT = '0x0000000000000000000000000000000000000001';
const OTHER = '0x0000000000000000000000000000000000000002';
const BOTH = ['eip155:1:' + ACCOUNT, 'eip155:11155111:' + OTHER];

function walletConnectFixture() {
  const sdk = new FakeUniversalProvider({ now: () => Date.now() });
  // UniversalProvider.init({ session: { topic } }) restores exactly that session.
  sdkModule.init.mockImplementation(async (opts: { session?: { topic: string } }) => sdk.init(opts.session?.topic));
  /** The wallet approves whatever proposal is open next. */
  const approveNext = (accounts = BOTH, topic = 'approved') => {
    const seen = sdk.proposals.length;
    void vi.waitFor(() => expect(sdk.proposals.length).toBeGreaterThan(seen))
      .then(() => sdk.proposals[seen].approve({ accounts, topic }));
  };
  return { sdk, approveNext };
}

function coinbaseProvider() {
  return {
    request: vi.fn(async ({ method }: { method: string }) => {
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [ACCOUNT];
      if (method === 'eth_chainId') return '0x1';
      return null;
    }),
    on: vi.fn(),
    removeListener: vi.fn(),
    disconnect: vi.fn(),
  };
}

const options = {
  chains: [mainnet, sepolia] as const, rpcUrls: {}, origin: 'https://example.com',
};

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  coinbase.parameters.length = 0;
});

describe('wallet connectors on a fresh visit', () => {
  it('keeps browser, Coinbase and Safe and loads neither WalletConnect nor the Coinbase SDK', async () => {
    const config = createWalletConfig(options);
    expect(config.connectors.map((connector) => connector.id)).toEqual(['injected', 'coinbaseWalletSDK', 'safe']);
    await reconnect(config);
    expect(sdkModule.init).not.toHaveBeenCalled();
    expect(coinbase.create).not.toHaveBeenCalled();
  });

  it('trusts only the Safe web app as a Safe parent frame', () => {
    createWalletConfig(options);
    expect(safeParameters.calls.at(-1)).toMatchObject({
      allowedDomains: SAFE_ALLOWED_ORIGINS, shimDisconnect: true, unstable_getInfoTimeout: 500,
    });
    const trusted = (origin: string) => SAFE_ALLOWED_ORIGINS.some((pattern) => pattern.test(origin));
    expect(trusted('https://app.safe.global')).toBe(true);
    for (const origin of ['https://app.safe.global.evil.example', 'http://app.safe.global', 'https://evil.example', 'null']) {
      expect(trusted(origin)).toBe(false);
    }
  });
});

describe('the build target is the only configured chain', () => {
  it('configures the target chain and nothing else', () => {
    expect(walletChains(sepolia.id)).toEqual([sepolia]);
    expect(walletChains(mainnet.id)).toEqual([mainnet]);
  });

  it('leaves a wallet on another network without a configured chain, so every guard asks it to switch', async () => {
    const config = createWalletConfig({ ...options, chains: walletChains(sepolia.id) });
    const connector = config.connectors.find((item) => item.id === 'coinbaseWalletSDK');
    if (!connector) throw new Error('Coinbase missing');
    // The stub wallet sits on mainnet. With both chains configured, the reads followed it.
    await connect(config, { connector });
    expect(getConnection(config)).toMatchObject({ isConnected: true, chainId: mainnet.id, chain: undefined });
    expect(getChainId(config)).toBe(sepolia.id);
    await disconnect(config);
  });
});

describe('Coinbase connector', () => {
  it('loads the SDK, without telemetry, only once chosen and again on reload until disconnected', async () => {
    const config = createWalletConfig(options);
    const connector = config.connectors.find((item) => item.id === 'coinbaseWalletSDK');
    if (!connector) throw new Error('Coinbase missing');
    await connect(config, { connector, chainId: mainnet.id });
    expect(coinbase.create).toHaveBeenCalledTimes(1);
    expect(coinbase.parameters[0]).toMatchObject({ appName: 'Gold Standard', preference: { telemetry: false } });
    expect(getConnection(config)).toMatchObject({ address: ACCOUNT, isConnected: true });

    const reloaded = createWalletConfig(options);
    await reconnect(reloaded);
    expect(getConnection(reloaded)).toMatchObject({ address: ACCOUNT, isConnected: true });

    const next = reloaded.connectors.find((item) => item.id === 'coinbaseWalletSDK');
    if (!next) throw new Error('Coinbase missing');
    await disconnect(reloaded, { connector: next });
    coinbase.create.mockClear();
    await reconnect(createWalletConfig(options));
    expect(coinbase.create).not.toHaveBeenCalled();
  });

  it('forgets Coinbase when the wallet itself ends the connection', async () => {
    const config = createWalletConfig(options);
    const connector = config.connectors.find((item) => item.id === 'coinbaseWalletSDK');
    if (!connector) throw new Error('Coinbase missing');
    await connect(config, { connector, chainId: mainnet.id });
    connector.onDisconnect();
    await vi.waitFor(() => expect(localStorage.getItem('wagmi.goldstandard.coinbaseWalletSDK.used')).toBeNull());
    coinbase.create.mockClear();
    await reconnect(createWalletConfig(options));
    expect(coinbase.create).not.toHaveBeenCalled();
  });
});

describe('WalletConnect connector', () => {
  it('connects, signs, switches chain and disconnects through Wagmi', async () => {
    const f = walletConnectFixture();
    const config = createWalletConfig({ ...options, projectId: 'test-project-id' });
    const connector = config.connectors.find((item) => item.id === 'walletConnect');
    if (!connector) throw new Error('WalletConnect missing');
    expect(await connector.isAuthorized()).toBe(false);
    expect(sdkModule.init).not.toHaveBeenCalled();
    f.approveNext();
    await connect(config, { connector, chainId: sepolia.id });
    expect(getConnection(config)).toMatchObject({ address: OTHER, chainId: sepolia.id, isConnected: true });
    const provider = await connector.getProvider() as EIP1193Provider;
    await expect(provider.request({ method: 'personal_sign', params: ['0x00', OTHER] })).resolves.toBe('signed');
    expect(f.sdk.walletRequests.at(-1)).toMatchObject({ method: 'personal_sign', chain: 'eip155:11155111' });
    await switchChain(config, { chainId: mainnet.id });
    expect(getConnection(config)).toMatchObject({ address: ACCOUNT, chainId: mainnet.id });
    await disconnect(config, { connector });
    expect(getConnection(config).isConnected).toBe(false);
    expect(await connector.isAuthorized()).toBe(false);
    expect(f.sdk.client.closed).toEqual(['approved']);
  });

  it('reports a session without the required chain as a refusal and stays disconnected', async () => {
    const f = walletConnectFixture();
    const config = createWalletConfig({ ...options, projectId: 'test-project-id' });
    const connector = config.connectors.find((item) => item.id === 'walletConnect');
    if (!connector) throw new Error('WalletConnect missing');
    f.approveNext(['eip155:1:' + ACCOUNT], 'mainnet-only');
    await expect(connect(config, { connector, chainId: sepolia.id })).rejects.toMatchObject({ code: 4901 });
    expect(getConnection(config).isConnected).toBe(false);
    expect(f.sdk.client.closed).toEqual(['mainnet-only']);
  });

  it('restores its own session on reload and propagates wallet revocation into Wagmi', async () => {
    const f = walletConnectFixture();
    const first = createWalletConfig({ ...options, projectId: 'test-project-id' });
    const connector = first.connectors.find((item) => item.id === 'walletConnect');
    if (!connector) throw new Error('WalletConnect missing');
    f.approveNext();
    await connect(first, { connector, chainId: mainnet.id });
    const restored = createWalletConfig({ ...options, projectId: 'test-project-id' });
    await reconnect(restored);
    expect(getConnection(restored)).toMatchObject({ address: ACCOUNT, isConnected: true });
    expect(sdkModule.init).toHaveBeenLastCalledWith(expect.objectContaining({ session: { topic: 'approved' } }));
    expect(f.sdk.proposals).toHaveLength(1);
    f.sdk.walletDeletes('approved');
    await vi.waitFor(() => expect(getConnection(restored).isConnected).toBe(false));
    const next = restored.connectors.find((item) => item.id === 'walletConnect');
    expect(await next?.isAuthorized()).toBe(false);
  });

  it('drops the Wagmi connection when the session expires', async () => {
    const f = walletConnectFixture();
    const config = createWalletConfig({ ...options, projectId: 'test-project-id' });
    const connector = config.connectors.find((item) => item.id === 'walletConnect');
    if (!connector) throw new Error('WalletConnect missing');
    f.approveNext();
    await connect(config, { connector, chainId: mainnet.id });
    f.sdk.expire('approved');
    await vi.waitFor(() => expect(getConnection(config).isConnected).toBe(false));
  });
});

/**
 * One browser RPC endpoint made every read on the page
 * fail together when its provider was down or over quota. These drive the real transport
 * against a stubbed fetch, so they prove a request reaches the second endpoint.
 */
describe('read transport over one or more RPC endpoints', () => {
  const PRIMARY = 'https://rpc-one.example/key';
  const SECONDARY = 'https://rpc-two.example/key';
  const BLOCK_NUMBER = '0x10';

  interface RpcCall { id: number; method: string }

  /** Answers eth_blockNumber on the healthy endpoints and fails with HTTP 503 on the others. */
  function stubRpc(healthy: readonly string[]) {
    const requested: string[] = [];
    const bodies: unknown[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      requested.push(url);
      if (!healthy.includes(url)) return new Response('unavailable', { status: 503 });
      const body: unknown = JSON.parse(String(init?.body));
      bodies.push(body);
      const answer = (call: RpcCall) => ({ jsonrpc: '2.0', id: call.id, result: BLOCK_NUMBER });
      const payload = Array.isArray(body) ? (body as RpcCall[]).map(answer) : answer(body as RpcCall);
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    return { requested, bodies };
  }

  const blockNumber = (rpcUrls: Record<number, readonly string[] | undefined>) => {
    const config = createWalletConfig({ chains: walletChains(mainnet.id), rpcUrls, origin: 'https://example.com' });
    const client = getClient(config, { chainId: mainnet.id });
    if (!client) throw new Error('No client for mainnet');
    return client.request({ method: 'eth_blockNumber' });
  };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses the single configured endpoint, batched, as before', async () => {
    const rpc = stubRpc([PRIMARY]);
    await expect(blockNumber({ [mainnet.id]: [PRIMARY] })).resolves.toBe(BLOCK_NUMBER);
    expect(new Set(rpc.requested)).toEqual(new Set([PRIMARY]));
    expect(Array.isArray(rpc.bodies[0])).toBe(true);
  });

  it('prefers the first endpoint and leaves the second alone while the first answers', async () => {
    const rpc = stubRpc([PRIMARY, SECONDARY]);
    await expect(blockNumber({ [mainnet.id]: [PRIMARY, SECONDARY] })).resolves.toBe(BLOCK_NUMBER);
    expect(rpc.requested).toEqual([PRIMARY]);
  });

  it('answers from the second endpoint, still batched, when the first is down', async () => {
    const rpc = stubRpc([SECONDARY]);
    await expect(blockNumber({ [mainnet.id]: [PRIMARY, SECONDARY] })).resolves.toBe(BLOCK_NUMBER);
    expect(rpc.requested.at(0)).toBe(PRIMARY);
    expect(rpc.requested.at(-1)).toBe(SECONDARY);
    expect(Array.isArray(rpc.bodies[0])).toBe(true);
  });

  it('does not ping the endpoints to rank them', async () => {
    const rpc = stubRpc([PRIMARY, SECONDARY]);
    const config = createWalletConfig({
      chains: walletChains(mainnet.id), rpcUrls: { [mainnet.id]: [PRIMARY, SECONDARY] }, origin: 'https://example.com',
    });
    expect(getClient(config, { chainId: mainnet.id })?.transport).toMatchObject({ type: 'fallback' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(rpc.requested).toEqual([]);
  });

  it('gives WalletConnect the first endpoint of each chain, or the public one when none is configured', () => {
    expect(walletConnectRpcMap([mainnet, sepolia], { [mainnet.id]: [PRIMARY, SECONDARY] })).toEqual({
      [String(mainnet.id)]: PRIMARY,
      [String(sepolia.id)]: sepolia.rpcUrls.default.http[0],
    });
    expect(walletConnectRpcMap([mainnet], { [mainnet.id]: [] })).toEqual({
      [String(mainnet.id)]: mainnet.rpcUrls.default.http[0],
    });
  });
});

describe('WalletConnect project id', () => {
  it.each([undefined, '', '  ', 'YOUR_PROJECT_ID', '<fill in: WalletConnect Cloud project id>'])(
    'treats %j as not configured, so no dead WalletConnect option is offered',
    (raw) => {
      expect(walletConnectProjectId(raw)).toBeUndefined();
      const config = createWalletConfig({ ...options, projectId: raw });
      expect(config.connectors.map((connector) => connector.id)).not.toContain('walletConnect');
    }
  );

  it('keeps a real id, trimmed', () => {
    expect(walletConnectProjectId(' abc123 ')).toBe('abc123');
  });
});
