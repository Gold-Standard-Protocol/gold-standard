import { getAddress, isAddress, numberToHex, type Address, type EIP1193Provider } from 'viem';

export interface WalletSession {
  topic: string;
  expiry: number;
  namespaces: Record<string, { accounts: string[] }>;
}

interface Namespace {
  chains: string[];
  methods: string[];
  events: string[];
  rpcMap: Record<string, string>;
}

/** The SignClient surface UniversalProvider exposes as `client`. */
export interface SignClientEvents {
  on(event: string, listener: (...args: unknown[]) => void): void;
  disconnect(params: { topic: string; reason: { message: string; code: number } }): Promise<void>;
  /** SignClient's session store: the authoritative expiry, extensions included. Throws for an unknown topic. */
  session?: { get(topic: string): { expiry: number } };
  core?: { pairing: { disconnect(params: { topic: string }): Promise<void> } };
}

/**
 * The public UniversalProvider 2.26 surface used by this Ethereum-only adapter. Required
 * namespaces are deprecated there: everything proposed is optional, so the adapter checks
 * what the wallet actually approved instead of trusting the proposal.
 */
export interface UniversalClient {
  session?: WalletSession;
  client?: SignClientEvents;
  rpcProviders: Record<string, { getDefaultChain(): string }>;
  connect(options: { optionalNamespaces: Record<string, Namespace> }): Promise<WalletSession | undefined>;
  request(args: { method: string; params?: unknown[] | Record<string, unknown> }, chain?: string): Promise<unknown>;
  disconnect(): Promise<void>;
  on(event: string, listener: (...args: unknown[]) => void): void;
}

type Listener = (...args: unknown[]) => void;

export interface UniversalWalletOptions {
  chains: readonly number[];
  rpcMap: Record<string, string>;
  /** Loads the provider; with a topic, UniversalProvider must restore exactly that session or throw. */
  load(topic?: string): Promise<UniversalClient>;
  /** The session topic this dapp approved and recorded, if any. */
  rememberedTopic(): Promise<string | undefined>;
  remember(topic: string | undefined): Promise<void>;
  displayUri(uri: string | undefined): void;
  now?: () => number;
}

interface Attempt {
  cancelled: boolean;
  reject(error: Error): void;
  /** The pairing this attempt's proposal travels on, known once its link arrives. */
  pairingTopic?: string;
  /** Settles when this attempt's link arrives or its proposal call ends. */
  linked: Promise<void>;
  link(): void;
}

const USER_DISCONNECTED = { message: 'User disconnected.', code: 6000 };
const SIGN_METHODS = ['eth_sendTransaction', 'personal_sign', 'eth_signTypedData_v4'];
const CHAIN_METHODS = ['wallet_switchEthereumChain', 'wallet_addEthereumChain'];
/** Wallet-side methods outside SIGN_METHODS would bypass the signer checks below. */
const REFUSED_METHOD = /^(wallet_|eth_sign|personal_)/;
/** How long a retry waits for an abandoned attempt's pairing link before giving up. */
export const ABANDONED_LINK_WAIT_MS = 10_000;
/** How long a disconnect waits for the relay to acknowledge before the dapp moves on. */
export const DISCONNECT_WAIT_MS = 3_000;

export function isPairingUri(value: unknown): value is string {
  if (typeof value !== 'string' || !/^wc:[a-f0-9]{64}@2\?/i.test(value)) return false;
  const query = new URLSearchParams(value.slice(value.indexOf('?') + 1));
  return /^[a-f0-9]{64}$/i.test(query.get('symKey') ?? '') && query.get('relay-protocol') === 'irn';
}

function walletError(message: string, code: number, reason?: string): Error & { code: number; reason?: string } {
  return Object.assign(new Error(message), { code }, reason ? { reason } : {});
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * WalletConnect reports a refusal as SDK error 5000 to 5003, wallets as EIP-1193 4001, and
 * some only in the message. Viem and the dapp recognise 4001, so every form maps to it.
 */
export function toProviderError(error: unknown): unknown {
  const { code, message } = (error ?? {}) as { code?: unknown; message?: unknown };
  const rejected = code === 4001 || (typeof code === 'number' && code >= 5000 && code <= 5003)
    || (typeof message === 'string' && /\buser (rejected|denied|cancell?ed)\b/i.test(message));
  if (!rejected || code === 4001) return error;
  return walletError(typeof message === 'string' && message ? message : 'Request rejected in your wallet.', 4001);
}

/**
 * UniversalProvider supplies the WalletConnect protocol without AppKit or its Zod 3
 * auth frame. This adapter exposes to Wagmi only the session it approved itself:
 * an explicit connect always proposes a new session, and a restore accepts only the
 * topic recorded on the last successful connect. Pairing links stay in memory and are
 * cleared on completion or cancellation.
 */
export class UniversalWallet {
  private client: UniversalClient | undefined;
  private loading: Promise<UniversalClient> | undefined;
  private active = false;
  private approvedTopic: string | undefined;
  private desiredChain: number;
  private listeners = new Map<string, Set<Listener>>();
  private current: Attempt | undefined;
  /** The attempt whose proposal call is waiting for its pairing link, at most one. */
  private awaitingLink: Attempt | undefined;
  private selectedAccounts = new Map<number, readonly Address[]>();

  constructor(private readonly options: UniversalWalletOptions) {
    if (!options.chains.length) throw new Error('A wallet needs at least one configured chain.');
    this.desiredChain = options.chains[0];
  }

  selectChain(chainId: number): void {
    if (!this.options.chains.includes(chainId)) throw walletError('This network is not configured.', 4901);
    this.desiredChain = chainId;
  }

  private emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }

  /** SignClient's stored expiry follows wallet extensions; UniversalProvider's copy does not. */
  private expiry(session: WalletSession): number {
    const store = this.client?.client?.session;
    if (!store) return session.expiry;
    try {
      return store.get(session.topic).expiry;
    } catch {
      return 0;
    }
  }

  private validSession(): boolean {
    const session = this.client?.session;
    return Boolean(session && this.approvedTopic && session.topic === this.approvedTopic
      && this.expiry(session) > (this.options.now?.() ?? Date.now()) / 1000);
  }

  chainId(): number {
    const value = this.client?.rpcProviders.eip155?.getDefaultChain();
    const id = value ? Number(value.replace(/^eip155:/, '')) : this.desiredChain;
    if (!Number.isSafeInteger(id) || id <= 0) throw walletError('The wallet returned an invalid network.', 4901);
    return id;
  }

  private approvedAccounts(chainId: number): readonly Address[] {
    const prefix = 'eip155:' + chainId + ':';
    return [...new Set(Object.entries(this.client?.session?.namespaces ?? {})
      .filter(([key]) => key === 'eip155' || key.startsWith('eip155:'))
      .flatMap(([, namespace]) => namespace.accounts)
      .filter((account) => account.startsWith(prefix))
      .map((account) => account.slice(prefix.length))
      .filter((account) => isAddress(account))
      .map((account) => getAddress(account)))];
  }

  accounts(): readonly Address[] {
    if (!this.active || !this.validSession()) return [];
    const approved = this.approvedAccounts(this.chainId());
    return this.selectedAccounts.get(this.chainId())?.filter((account) => approved.includes(account)) ?? approved;
  }

  /** Drops local authorisation; the wallet session itself is closed by the caller. */
  private reset(): boolean {
    const wasActive = this.active;
    this.active = false;
    this.approvedTopic = undefined;
    this.selectedAccounts.clear();
    void this.options.remember(undefined).catch(() => undefined);
    return wasActive;
  }

  private syncAccounts(): void {
    if (!this.active) return;
    // On a chain the dapp does not support, keep the connection so Wagmi shows the
    // unsupported network; accounts() is empty there, so nothing can be signed.
    if (!this.options.chains.includes(this.chainId())) return;
    const accounts = this.accounts();
    if (!accounts.length) {
      // The wallet withdrew every account: end the session at the wallet too.
      const topic = this.approvedTopic;
      this.reset();
      void this.close(topic);
    }
    this.emit('accountsChanged', accounts);
  }

  private endSession(topic: unknown): void {
    if (typeof topic === 'string' && topic !== this.approvedTopic) return;
    if (this.reset()) this.emit('disconnect', walletError('Wallet disconnected.', 4900));
  }

  /**
   * Best effort: an expired or already deleted topic makes SignClient throw, and a
   * failed close must never block a new proposal. Only this adapter's own topic, or one
   * it is discarding, is ever closed.
   */
  private async close(topic: string | undefined): Promise<void> {
    const client = this.client;
    if (!client) return;
    try {
      if (client.session && (!topic || client.session.topic === topic)) await client.disconnect();
      else if (topic) await this.closeTopic(topic);
    } catch {
      // Already gone: nothing further to close.
    }
  }

  /**
   * Closes a session through SignClient alone. UniversalProvider.disconnect would also
   * run its cleanup, which expires every pairing, a newer attempt's included.
   */
  private async closeTopic(topic: string | undefined): Promise<void> {
    if (!topic) return;
    try {
      await this.client?.client?.disconnect({ topic, reason: USER_DISCONNECTED });
    } catch {
      // Already gone.
    }
  }

  private deletePairing(topic: string | undefined): void {
    if (!topic) return;
    void this.client?.client?.core?.pairing.disconnect({ topic }).catch(() => undefined);
  }

  private onDisplayUri(uri: unknown): void {
    // Each proposal call yields exactly one link; a retry waits for an abandoned call's
    // link first, so a link always belongs to the attempt awaiting one.
    const attempt = this.awaitingLink;
    this.awaitingLink = undefined;
    if (!attempt) return;
    attempt.link();
    if (!isPairingUri(uri)) {
      if (attempt === this.current) this.cancel();
      return;
    }
    attempt.pairingTopic = uri.slice(3, uri.indexOf('@'));
    if (attempt.cancelled || attempt !== this.current) {
      this.deletePairing(attempt.pairingTopic);
      return;
    }
    this.options.displayUri(uri);
  }

  private async getClient(topic?: string): Promise<UniversalClient> {
    if (this.client) return this.client;
    if (!this.loading) {
      this.loading = this.options.load(topic).then((client) => {
        this.client = client;
        client.on('display_uri', (uri) => this.onDisplayUri(uri));
        // The raw event retains its chain and includes empty account lists;
        // UniversalProvider's convenience accountsChanged event drops both.
        client.on('session_event', (value) => {
          const event = value as { topic?: string; params?: { chainId?: string; event?: { name?: string; data?: unknown } } };
          if (!this.approvedTopic || event.topic !== this.approvedTopic || event.params?.event?.name !== 'accountsChanged') return;
          const chain = event.params.chainId;
          const data = event.params.event.data;
          if (!chain?.startsWith('eip155:') || !Array.isArray(data)) return;
          const chainId = Number(chain.slice(7));
          const approved = this.approvedAccounts(chainId);
          const prefix = chain + ':';
          const selected = data
            .filter((account): account is string => typeof account === 'string')
            .map((account) => account.startsWith(prefix) ? account.slice(prefix.length) : account)
            .filter((account) => isAddress(account))
            .map((account) => getAddress(account))
            .filter((account) => approved.includes(account));
          this.selectedAccounts.set(chainId, [...new Set(selected)]);
          if (chainId === this.chainId()) this.syncAccounts();
        });
        client.on('chainChanged', () => {
          if (this.active && this.validSession()) {
            this.emit('chainChanged', numberToHex(this.chainId()));
            this.syncAccounts();
          }
        });
        client.on('session_update', () => {
          if (this.validSession()) this.syncAccounts();
        });
        // UniversalProvider emits this for a wallet-side session_delete, carrying the topic.
        client.on('disconnect', (value) => this.endSession((value as { data?: unknown } | undefined)?.data));
        // UniversalProvider does not forward expiry; SignClient does.
        client.client?.on('session_expire', (value) => this.endSession((value as { topic?: unknown } | undefined)?.topic));
        return client;
      }).catch((error) => {
        this.loading = undefined;
        throw error;
      });
    }
    return this.loading;
  }

  async restore(): Promise<boolean> {
    const topic = await this.options.rememberedTopic();
    if (!topic) return false;
    let client: UniversalClient;
    try {
      // Restore by topic: UniversalProvider otherwise adopts whichever session is stored first.
      client = await this.getClient(topic);
    } catch {
      this.reset();
      return false;
    }
    this.approvedTopic = client.session?.topic === topic ? topic : undefined;
    this.active = this.validSession() && this.options.chains.includes(this.chainId());
    if (!this.active || !this.accounts().length) {
      this.reset();
      return false;
    }
    return true;
  }

  async connect(): Promise<readonly Address[]> {
    if (this.current) throw walletError('A connection request is still open in your wallet.', -32002);
    let reject!: (error: Error) => void;
    const cancelled = new Promise<never>((_, no) => { reject = no; });
    let link!: () => void;
    const linked = new Promise<void>((resolve) => { link = resolve; });
    const attempt: Attempt = { cancelled: false, reject, linked, link };
    this.current = attempt;
    const approval = this.approve(attempt);
    void approval.finally(() => {
      if (this.current === attempt) {
        this.current = undefined;
        this.options.displayUri(undefined);
      }
    }).catch(() => undefined);
    try {
      return await Promise.race([approval, cancelled]);
    } catch (error) {
      throw toProviderError(error);
    }
  }

  private async approve(attempt: Attempt): Promise<readonly Address[]> {
    const stop = () => walletError('Connection cancelled.', 4001);
    const client = await this.getClient();
    if (attempt.cancelled) throw stop();
    const abandoned = this.awaitingLink;
    if (abandoned) {
      await Promise.race([abandoned.linked, delay(ABANDONED_LINK_WAIT_MS)]);
      if (this.awaitingLink === abandoned) {
        throw walletError('WalletConnect is still closing the previous request. Try again in a moment.', -32002);
      }
    }
    if (attempt.cancelled) throw stop();
    // Never reuse a stored session on an explicit connect: it may be an older dapp's
    // session, a failed disconnect, or a cancelled proposal the wallet approved late.
    this.reset();
    await this.close(undefined);
    if (attempt.cancelled) throw stop();
    this.awaitingLink = attempt;
    let session: WalletSession | undefined;
    try {
      session = await client.connect({
        optionalNamespaces: { eip155: {
          chains: this.options.chains.map((id) => 'eip155:' + id),
          methods: [...SIGN_METHODS, ...CHAIN_METHODS],
          events: ['accountsChanged', 'chainChanged'],
          rpcMap: this.options.rpcMap,
        } },
      });
    } finally {
      if (this.awaitingLink === attempt) this.awaitingLink = undefined;
      attempt.link();
    }
    if (attempt.cancelled) {
      // UniversalProvider.abortPairingAttempt is a no-op in 2.26.0. A late approval of a
      // cancelled proposal is closed here and never reaches Wagmi.
      await this.closeTopic(session?.topic);
      throw stop();
    }
    if (!session || client.session?.topic !== session.topic) {
      await this.closeTopic(session?.topic);
      throw walletError('The wallet did not approve a session.', 4001);
    }
    this.approvedTopic = session.topic;
    const refuse = async (error: Error) => {
      this.reset();
      await this.close(session?.topic);
      return error;
    };
    if (!this.approvedAccounts(this.desiredChain).length) {
      throw await refuse(walletError('Your wallet did not approve the required network. Try again and approve it.', 4901,
        'network-not-approved'));
    }
    // The desired chain is approved, so UniversalProvider switches locally without a prompt.
    if (this.chainId() !== this.desiredChain) {
      await client.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: numberToHex(this.desiredChain) }] },
        'eip155:' + this.desiredChain);
    }
    if (attempt.cancelled) throw await refuse(stop());
    this.active = true;
    const accounts = this.accounts();
    if (!accounts.length || this.chainId() !== this.desiredChain) {
      throw await refuse(walletError('The wallet did not approve a supported account and network.', 4901,
        'network-not-approved'));
    }
    try {
      await this.options.remember(session.topic);
    } catch (error) {
      throw await refuse(error instanceof Error ? error : new Error('Could not record the wallet connection.'));
    }
    if (attempt.cancelled) throw await refuse(stop());
    return accounts;
  }

  /** Ends the open attempt at once, so a new one can start without waiting for the wallet. */
  cancel(): void {
    const attempt = this.current;
    if (!attempt) return;
    attempt.cancelled = true;
    this.current = undefined;
    attempt.reject(walletError('Connection cancelled.', 4001));
    this.options.displayUri(undefined);
    // Only this attempt's pairing: deleting the others would break an active session.
    // Without a link yet, onDisplayUri deletes the pairing when it arrives.
    this.deletePairing(attempt.pairingTopic);
  }

  async disconnect(): Promise<void> {
    this.cancel();
    const topic = this.approvedTopic;
    this.reset();
    await this.options.remember(undefined);
    // The relay acknowledges a delete; a slow relay must not hold the dapp connected.
    await Promise.race([this.close(topic), delay(DISCONNECT_WAIT_MS)]);
  }

  /** Signing names an account; refuse one the session did not approve on this chain. */
  private assertSigner(method: string, params: unknown, chainId: number): void {
    if (!Array.isArray(params)) throw walletError('This request is missing its parameters.', -32602);
    const accounts = this.accounts();
    const owns = (value: unknown) => typeof value === 'string' && isAddress(value)
      && accounts.includes(getAddress(value));
    if (method === 'eth_sendTransaction') {
      const tx = params[0] as { from?: unknown; chainId?: unknown } | undefined;
      if (tx?.from !== undefined && !owns(tx.from)) throw walletError('This account is not connected.', 4100);
      if (tx?.chainId !== undefined && Number(tx.chainId) !== chainId) {
        throw walletError('The transaction names a different network.', 4901);
      }
    }
    if (method === 'personal_sign' && !owns(params[1])) throw walletError('This account is not connected.', 4100);
    if (method === 'eth_signTypedData_v4' && !owns(params[0])) throw walletError('This account is not connected.', 4100);
  }

  async request(args: { method: string; params?: unknown[] | Record<string, unknown> }): Promise<unknown> {
    if (args.method === 'eth_chainId') return numberToHex(this.chainId());
    if (args.method === 'eth_accounts') return this.accounts();
    if (args.method === 'eth_requestAccounts') return this.connect();
    if (args.method === 'wallet_revokePermissions') return null;
    const client = this.client;
    if (!this.active || !this.validSession() || !client) throw walletError('Connect your wallet before continuing.', 4900);
    const chainId = this.chainId();
    if (CHAIN_METHODS.includes(args.method)) {
      const target = Array.isArray(args.params) ? args.params[0] as { chainId?: unknown } | undefined : undefined;
      const targetId = typeof target?.chainId === 'string' ? Number(target.chainId) : NaN;
      if (!Number.isSafeInteger(targetId) || !this.options.chains.includes(targetId)) {
        throw walletError('This network is not configured.', 4901);
      }
      // Switching to a chain outside the session would leave it with no account here.
      if (!this.approvedAccounts(targetId).length) {
        throw walletError('Your wallet did not approve this network. Disconnect and connect again to add it.', 4901,
          'network-not-approved');
      }
      if (args.method === 'wallet_addEthereumChain') return null;
      try {
        return await client.request(args, 'eip155:' + targetId);
      } catch (error) {
        throw toProviderError(error);
      }
    }
    const signing = SIGN_METHODS.includes(args.method);
    if (!signing && REFUSED_METHOD.test(args.method)) {
      throw walletError(`${args.method} is not supported by this connection.`, 4200);
    }
    if (!this.options.chains.includes(chainId) || !this.accounts().length) {
      throw walletError('Select a supported network in your wallet.', 4901);
    }
    if (signing) this.assertSigner(args.method, args.params, chainId);
    try {
      return await client.request(args, 'eip155:' + chainId);
    } catch (error) {
      throw toProviderError(error);
    }
  }

  provider(): EIP1193Provider {
    return {
      request: (args: { method: string; params?: unknown[] | Record<string, unknown> }) => this.request(args),
      on: (event: string, listener: Listener) => {
        const listeners = this.listeners.get(event) ?? new Set<Listener>();
        listeners.add(listener);
        this.listeners.set(event, listeners);
      },
      removeListener: (event: string, listener: Listener) => { this.listeners.get(event)?.delete(listener); },
    } as EIP1193Provider;
  }
}
