import { createConfig, createConnector, fallback, http, type Config, type CreateConnectorFn, type Transport } from 'wagmi';
import { injected } from 'wagmi/connectors/injected';
import { coinbaseWallet } from 'wagmi/connectors/coinbaseWallet';
import { safe } from 'wagmi/connectors/safe';
import type { Chain } from 'viem';
import { mainnet, sepolia } from 'viem/chains';
import { UniversalWallet } from './universalProvider';
import { SAFE_ALLOWED_ORIGINS } from '../frameGuard';

/** Holds the approved WalletConnect session topic, never a boolean. */
const SESSION_TOPIC_KEY = 'goldstandard.walletConnect.topic';

// One list of trusted parents for the Safe connector and the frame guard in main.tsx.
export { SAFE_ALLOWED_ORIGINS };

/**
 * The chains the wallet layer is configured with: the build's target chain and nothing
 * else.
 *
 * With mainnet and Sepolia both configured, a wallet on the other one counted as a
 * supported chain: useChainId followed it, every page read contracts that do not exist
 * there and showed empty states, and Guard.Chain compared the wallet's chain with itself
 * so the Switch Chain prompt never appeared. With one chain, a wallet anywhere else has
 * no configured chain, the header says "Unsupported Network" and every guarded action
 * offers Switch Chain. The WalletConnect adapter and the network picker follow the same
 * list.
 */
export function walletChains(targetChainId: number): readonly [Chain] {
  return [targetChainId === mainnet.id ? mainnet : sepolia];
}

export function walletConnectUniversal(parameters: {
  projectId: string;
  rpcMap: Record<string, string>;
  origin: string;
}) {
  return createConnector((config) => {
    const wallet = new UniversalWallet({
      chains: config.chains.map((chain) => chain.id),
      rpcMap: parameters.rpcMap,
      load: async (topic) => {
        const { default: UniversalProvider } = await import('@walletconnect/universal-provider');
        return UniversalProvider.init({
          // With a topic, init restores exactly that session (and throws if it is gone)
          // instead of adopting whichever session is stored first. Only `topic` is read.
          ...(topic ? { session: { topic } as never } : {}),
          projectId: parameters.projectId,
          metadata: {
            name: 'Gold Standard',
            description: 'Borrow GSUSD against tokenised gold.',
            url: parameters.origin,
            icons: [],
          },
          logger: 'error',
        });
      },
      rememberedTopic: async () => {
        const topic: unknown = await config.storage?.getItem(SESSION_TOPIC_KEY);
        return typeof topic === 'string' && topic ? topic : undefined;
      },
      remember: async (topic) => {
        if (topic) await config.storage?.setItem(SESSION_TOPIC_KEY, topic);
        else await config.storage?.removeItem(SESSION_TOPIC_KEY);
      },
      displayUri: (uri) => config.emitter.emit('message', { type: 'display_uri', data: uri }),
    });
    const provider = wallet.provider();
    // Reuse Wagmi's maintained Ethereum connector for accounts and switching.
    // This adapter owns persistence; injected-wallet shims are not used here.
    const base = injected({
      shimDisconnect: false,
      target: { id: 'walletConnect', name: 'WalletConnect', provider },
    })({ ...config, storage: null });
    return {
      ...base,
      id: 'walletConnect',
      name: 'WalletConnect',
      type: 'walletConnect',
      async connect(parameters) {
        if (parameters?.chainId) wallet.selectChain(parameters.chainId);
        const connected = await base.connect.call(this, parameters);
        // The base connector builds both capability shapes; Function.call loses
        // its generic conditional return type.
        return { ...connected, accounts: connected.accounts as never };
      },
      async disconnect() {
        await wallet.disconnect();
        await base.disconnect.call(this);
      },
      isAuthorized: () => wallet.restore(),
      cancelConnect: () => wallet.cancel(),
    };
  });
}

/**
 * Wagmi's reconnect asks every connector for its provider on each page load. For an SDK
 * connector that means downloading and constructing the SDK for every visitor. This keeps
 * the SDK untouched until the visitor chooses that wallet once; a successful connection
 * is remembered so a reload restores it.
 */
export function dormantUntilUsed(create: CreateConnectorFn): CreateConnectorFn {
  return createConnector((config) => {
    const base = create(config);
    const usedKey = `goldstandard.${base.id}.used`;
    let chosen = false;
    const used = async () => chosen || Boolean(await config.storage?.getItem(usedKey));
    return {
      ...base,
      async connect(parameters) {
        chosen = true;
        const connected = await base.connect.call(this, parameters);
        await config.storage?.setItem(usedKey, true);
        return { ...connected, accounts: connected.accounts as never };
      },
      async disconnect() {
        await base.disconnect.call(this);
        chosen = false;
        await config.storage?.removeItem(usedKey);
      },
      // The wallet ended the connection itself, so this visitor no longer uses it.
      onDisconnect(error) {
        chosen = false;
        void config.storage?.removeItem(usedKey);
        return base.onDisconnect.call(this, error);
      },
      async getProvider(parameters) {
        if (!(await used())) return undefined;
        return base.getProvider.call(this, parameters);
      },
      async isAuthorized() {
        if (!(await used())) return false;
        return base.isAuthorized.call(this);
      },
    };
  });
}

/**
 * The Safe connector, as every build registers it. Safe answers getInfo within milliseconds
 * inside its web app; wagmi's 10ms default can lose that race. Outside an iframe the
 * connector returns before waiting at all. The disconnect shim keeps a deliberate
 * disconnect from reconnecting on reload.
 */
export function safeAppConnector(): CreateConnectorFn {
  return safe({ allowedDomains: [...SAFE_ALLOWED_ORIGINS], shimDisconnect: true, unstable_getInfoTimeout: 500 });
}

/** What the service env printer leaves in a value the operator has not supplied yet. */
const UNFILLED_MARKER = '<fill in';

/** The WalletConnect project id, or undefined when it is absent or still a placeholder. */
export function walletConnectProjectId(raw: string | undefined): string | undefined {
  const projectId = raw?.trim() ?? '';
  const isPlaceholder = projectId === 'YOUR_PROJECT_ID' || projectId.toLowerCase().includes(UNFILLED_MARKER);
  return projectId === '' || isPlaceholder ? undefined : projectId;
}

/** With a second endpoint behind it, one endpoint gets a single retry before the next is tried. */
const FAILOVER_ENDPOINT_RETRIES = 1;
/** How often the whole list is tried again after every endpoint has failed. */
const FAILOVER_ROUND_RETRIES = 2;

/**
 * The read transport for one chain. Every endpoint
 * batches its JSON-RPC calls. One URL is used as it always was. Several are tried in the order
 * given: a request that fails on the first for a transport reason (a timeout, a rate limit, an
 * outage) goes to the next, so one provider's quota or downtime no longer fails every read on
 * the page. Ranking stays off: it would ping every endpoint on a timer to reorder them, which
 * spends quota on each visitor's key for nothing, and the order given is the order wanted. No
 * URL at all leaves viem on the chain's public endpoint, which only local development uses.
 */
export function chainTransport(urls: readonly string[]): Transport {
  if (urls.length <= 1) return http(urls[0], { batch: true });
  return fallback(
    urls.map((url) => http(url, { batch: true, retryCount: FAILOVER_ENDPOINT_RETRIES })),
    { rank: false, retryCount: FAILOVER_ROUND_RETRIES }
  );
}

/**
 * WalletConnect takes one URL per chain: the first configured endpoint, which is the preferred
 * one, or the chain's public endpoint when none is configured.
 */
export function walletConnectRpcMap(
  chains: readonly Chain[],
  rpcUrls: Record<number, readonly string[] | undefined>
): Record<string, string> {
  return Object.fromEntries(chains.map((chain) =>
    [String(chain.id), rpcUrls[chain.id]?.[0] ?? chain.rpcUrls.default.http[0]]));
}

export function createWalletConfig(options: {
  chains: readonly [Chain, ...Chain[]];
  /** Per chain, the endpoints in order of preference (parseRpcUrls); none falls back to the chain's public one. */
  rpcUrls: Record<number, readonly string[] | undefined>;
  projectId?: string;
  origin: string;
}): Config {
  const rpcMap = walletConnectRpcMap(options.chains, options.rpcUrls);
  const projectId = walletConnectProjectId(options.projectId);
  return createConfig({
    chains: options.chains,
    connectors: [
      injected(),
      // Telemetry off: the SDK would otherwise inject Coinbase's analytics script.
      dormantUntilUsed(coinbaseWallet({ appName: 'Gold Standard', preference: { options: 'all', telemetry: false } })),
      safeAppConnector(),
      ...(projectId
        ? [walletConnectUniversal({ projectId, rpcMap, origin: options.origin })]
        : []),
    ],
    transports: Object.fromEntries(options.chains.map((chain) => [
      chain.id, chainTransport(options.rpcUrls[chain.id] ?? []),
    ])),
    batch: { multicall: true },
    pollingInterval: 10_000,
    ssr: false,
  });
}
