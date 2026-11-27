/**
 * Test double for UniversalProvider 2.26.0, written from its source rather than from the
 * adapter's expectations. The behaviours the adapter must survive are reproduced:
 *   - init adopts the first stored session unless asked for one by topic, and throws
 *     when that topic is not stored;
 *   - required namespaces are deprecated: every proposed chain is optional, and the
 *     wallet alone decides which chains and accounts the session holds;
 *   - connect unsubscribes earlier pairings, waits for the relay, then emits the pairing
 *     link asynchronously; each proposal travels on its own pairing topic, and an
 *     approval on an unsubscribed or deleted pairing is never delivered;
 *   - a late approval overwrites provider.session;
 *   - disconnect() throws without a session; SignClient throws for a topic it no longer
 *     knows; disconnect() and a wallet-side delete run cleanup(), which expires every
 *     pairing, while provider.rpcProviders keeps its stale default chain;
 *   - a wallet-side delete emits session_delete then disconnect { data: topic };
 *   - expiry and extension live in SignClient's session store only; the provider's
 *     session copy keeps its original expiry;
 *   - wallet_switchEthereumChain to an approved chain switches locally; to another
 *     chain it asks the wallet and switches the default chain regardless.
 * Used only by specs.
 */
import type { SignClientEvents, UniversalClient, WalletSession } from './universalProvider';

type Listener = (...args: unknown[]) => void;

class Emitter {
  private listeners = new Map<string, Set<Listener>>();
  on(event: string, listener: Listener): void {
    const set = this.listeners.get(event) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(event, set);
  }
  emit(event: string, ...args: unknown[]): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args);
  }
}

export interface WalletDecision {
  /** CAIP-10 accounts the wallet approves, e.g. eip155:1:0x... */
  accounts: string[];
  topic?: string;
  expiry?: number;
}

export interface Proposal {
  pairingTopic: string;
  optionalChains: string[];
  /** False once the pairing is unsubscribed or deleted: a later approval is never delivered. */
  subscribed: boolean;
  approve(decision: WalletDecision): void;
  reject(error: unknown): void;
}

let counter = 0;
const hex64 = (seed: number) => seed.toString(16).padStart(64, '0');

export class FakeSignClient implements SignClientEvents {
  readonly events = new Emitter();
  /** SignClient's session store, in insertion order like getAll(). */
  readonly sessions = new Map<string, WalletSession>();
  readonly closed: string[] = [];
  readonly deletedPairings: string[] = [];
  onPairingDelete: (topic: string) => void = () => undefined;
  readonly session = {
    get: (topic: string): WalletSession => {
      const stored = this.sessions.get(topic);
      if (!stored) throw new Error(`No matching key. session: ${topic}`);
      return stored;
    },
  };
  readonly core = {
    pairing: {
      disconnect: async ({ topic }: { topic: string }) => {
        this.deletedPairings.push(topic);
        this.onPairingDelete(topic);
      },
    },
  };
  on(event: string, listener: Listener): void { this.events.on(event, listener); }
  async disconnect({ topic }: { topic: string; reason: { message: string; code: number } }): Promise<void> {
    if (!this.sessions.has(topic)) throw new Error(`No matching key. session or pairing topic doesn't exist: ${topic}`);
    this.sessions.delete(topic);
    this.closed.push(topic);
  }
}

export class FakeUniversalProvider implements UniversalClient {
  session?: WalletSession;
  readonly client = new FakeSignClient();
  rpcProviders: UniversalClient['rpcProviders'] = {};
  readonly proposals: Proposal[] = [];
  readonly walletRequests: Array<{ method: string; params?: unknown; chain?: string }> = [];
  /** Times cleanup() expired every pairing. */
  cleanups = 0;
  /** What the wallet answers to a request; throw to simulate a refusal. */
  respond: (method: string) => unknown = () => 'signed';
  private readonly events = new Emitter();
  private defaultChain: string | undefined;
  private relay: Promise<void> = Promise.resolve();

  constructor(private readonly options: { now: () => number; stored?: WalletSession[] }) {
    for (const stored of options.stored ?? []) this.client.sessions.set(stored.topic, stored);
    this.client.onPairingDelete = (topic) => {
      for (const proposal of this.proposals) if (proposal.pairingTopic === topic) proposal.subscribed = false;
    };
  }

  /** UniversalProvider.init: createClient adopts the requested session, or the first stored. */
  init(topic?: string): this {
    if (topic) {
      const stored = this.client.sessions.get(topic);
      if (!stored) throw new Error(`The provided session: ${topic} doesn't exist in the Sign client`);
      this.adopt(stored);
    } else {
      const first = [...this.client.sessions.values()][0];
      if (first) this.adopt(first);
    }
    return this;
  }

  /** Holds the relay offline; proposals wait until the returned function is called. */
  holdRelay(): () => void {
    let release!: () => void;
    this.relay = new Promise((resolve) => { release = resolve; });
    return () => { this.relay = Promise.resolve(); release(); };
  }

  on(event: string, listener: Listener): void { this.events.on(event, listener); }

  private approvedChains(session: WalletSession): string[] {
    return [...new Set(Object.values(session.namespaces).flatMap((ns) => ns.accounts)
      .map((account) => account.split(':').slice(0, 2).join(':')))];
  }

  private adopt(session: WalletSession): void {
    this.session = { ...session };
    const first = this.approvedChains(session)[0];
    this.defaultChain = first?.split(':')[1];
    this.rpcProviders = { eip155: { getDefaultChain: () => {
      if (!this.defaultChain) throw new Error('ChainId not found');
      return this.defaultChain;
    } } };
  }

  async connect(options: Parameters<UniversalClient['connect']>[0]): Promise<WalletSession | undefined> {
    // cleanupPendingPairings without deletion: earlier pairings are unsubscribed.
    for (const proposal of this.proposals) proposal.subscribed = false;
    await this.relay;
    const pairingTopic = hex64(++counter);
    const uri = 'wc:' + pairingTopic + '@2?relay-protocol=irn&symKey=' + hex64(counter + 1_000_000);
    const approval = new Promise<WalletSession>((resolve, reject) => {
      const proposal: Proposal = {
        pairingTopic,
        optionalChains: options.optionalNamespaces['eip155']?.chains ?? [],
        subscribed: true,
        approve: (decision) => {
          if (!proposal.subscribed) return;
          const session: WalletSession = {
            topic: decision.topic ?? 'session-' + ++counter,
            expiry: decision.expiry ?? this.options.now() / 1000 + 7 * 24 * 3600,
            namespaces: { eip155: { accounts: decision.accounts } },
          };
          this.client.sessions.set(session.topic, session);
          this.adopt(session);
          resolve(session);
        },
        reject,
      };
      this.proposals.push(proposal);
    });
    await Promise.resolve();
    this.events.emit('display_uri', uri);
    return approval;
  }

  async request(args: { method: string; params?: unknown[] | Record<string, unknown> }, chain?: string): Promise<unknown> {
    if (!this.session) throw new Error('Please call connect() before request()');
    if (args.method === 'wallet_switchEthereumChain') {
      const target = String(Number((args.params as Array<{ chainId: string }>)[0].chainId));
      if (!this.approvedChains(this.session).includes('eip155:' + target)) {
        this.walletRequests.push({ method: args.method, params: args.params, chain });
      }
      this.defaultChain = target;
      this.events.emit('chainChanged', target);
      return null;
    }
    this.walletRequests.push({ method: args.method, params: args.params, chain });
    return this.respond(args.method);
  }

  private cleanup(): void {
    this.session = undefined;
    this.cleanups += 1;
    for (const proposal of this.proposals) proposal.subscribed = false;
  }

  async disconnect(): Promise<void> {
    if (!this.session) throw new Error('Please call connect() before enable()');
    await this.client.disconnect({ topic: this.session.topic, reason: { message: 'User disconnected.', code: 6000 } });
    this.cleanup();
  }

  // --- Wallet and relay side ---

  emitDisplayUri(uri: string): void {
    this.events.emit('display_uri', uri);
  }

  walletDeletes(topic: string): void {
    if (topic !== this.session?.topic) return;
    this.client.sessions.delete(topic);
    this.cleanup();
    this.events.emit('session_delete', { topic });
    this.events.emit('disconnect', { message: 'User disconnected.', code: 6000, data: topic });
  }

  walletEvent(topic: string, chainId: string, name: string, data: unknown): void {
    if (topic !== this.session?.topic) return;
    if (name === 'chainChanged') {
      this.defaultChain = chainId.split(':')[1];
      this.events.emit('chainChanged', this.defaultChain);
    }
    this.events.emit('session_event', { topic, params: { chainId, event: { name, data } } });
  }

  walletUpdates(topic: string, accounts: string[]): void {
    if (topic !== this.session?.topic) return;
    this.session = { ...this.session, namespaces: { eip155: { accounts } } };
    this.client.sessions.set(topic, this.session);
    this.events.emit('session_update', { topic });
  }

  /** A wallet extends the session: only SignClient's store learns the new expiry. */
  walletExtends(topic: string, expiry: number): void {
    const stored = this.client.sessions.get(topic);
    if (!stored) return;
    this.client.sessions.set(topic, { ...stored, expiry });
    this.client.events.emit('session_extend', { topic });
  }

  /** SignClient's expirer: the session is deleted there, the provider keeps its stale copy. */
  expire(topic: string): void {
    this.client.sessions.delete(topic);
    this.client.events.emit('session_expire', { topic });
  }
}
