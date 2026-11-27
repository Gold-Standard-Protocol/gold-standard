import type { KeeperContractCall, KeeperReadClient, KeeperTxSender } from './ports';

/**
 * A read cache that lives for one tick.
 *
 * The jobs of a tick run one after another and each reads the protocol state it needs by
 * itself, so the same read is repeated across jobs: measured on 2026-11-18, a quiet tick made
 * 42 contract reads of which 20 were distinct, plus the head block three to five times. Every
 * one is a separate request to the RPC provider, which bills by the request.
 *
 * This wrapper answers a repeated read from the first answer and, at the start of a tick,
 * fetches the reads the previous tick made in one multicall. It changes how often the chain
 * is asked, never what a job is told beyond the bounds below:
 *
 *   - An answer is reused for at most `maxAgeMs`, and only inside the tick that fetched it.
 *   - Only an answer is kept. A read that fails is never kept, in the prefetch or outside it,
 *     so the job that makes it sees the live failure with its own error.
 *   - The first transaction the keeper sends in a tick switches the cache off for the rest
 *     of that tick: from that moment every read goes to the chain, as it did before this
 *     wrapper existed. A liquidation and everything after it never act on a reused answer,
 *     and the price a vault is judged at after a receipt wait is always read afresh.
 *   - Batched owner reads (`readContracts`) and balances are never cached.
 *   - `maxAgeMs` of zero turns the wrapper into a plain pass-through.
 */

/** Reads the prefetch asks for in one multicall. Bounds the request, not the cache. */
export const TICK_READ_CACHE_MAX_PREFETCH = 128;

export interface TickReadCacheOptions {
  /** How long an answer may be reused, in milliseconds. Zero disables the cache. */
  maxAgeMs: number;
  /** Injectable clock for specs; Date.now otherwise. */
  now?: () => number;
}

export interface TickReadCacheStats {
  /** Reads answered from the cache since the tick began. */
  hits: number;
  /** Reads that went to the chain one by one since the tick began. */
  misses: number;
  /** Reads the prefetch at the start of this tick asked for, and how many it kept. */
  prefetched: number;
  prefetchKept: number;
}

export interface TickReadCache {
  /** The client the jobs read through. */
  read: KeeperReadClient;
  /** The sender the jobs send through: the same sender, with the cache switched off by a send. */
  guardTx(tx: KeeperTxSender | undefined): KeeperTxSender | undefined;
  stats(): TickReadCacheStats;
}

interface Entry {
  value: unknown;
  at: number;
}

const abiIds = new WeakMap<object, number>();
let nextAbiId = 1;
/** A stable number for an ABI object, so two ABIs that share a function name never share an answer. */
const abiId = (abi: object): number => {
  const known = abiIds.get(abi);
  if (known !== undefined) return known;
  const id = nextAbiId++;
  abiIds.set(abi, id);
  return id;
};

/**
 * JSON with a bigint written as an object, which no string or number argument can equal, so
 * 1n, 1 and "1" are three different keys.
 */
const encodeArgs = (args: readonly unknown[] | undefined): string =>
  JSON.stringify(args ?? [], (_key, value: unknown) => (typeof value === 'bigint' ? { $bigint: value.toString() } : value));

const keyOf = (call: KeeperContractCall): string =>
  `${abiId(call.abi)}|${call.address.toLowerCase()}|${call.functionName}|${encodeArgs(call.args)}`;

export const createTickReadCache = (inner: KeeperReadClient, options: TickReadCacheOptions): TickReadCache => {
  const now = options.now ?? Date.now;
  const maxAgeMs = options.maxAgeMs;
  const enabled = maxAgeMs > 0;

  let entries = new Map<string, Entry>();
  let inFlight = new Map<string, Promise<unknown>>();
  /** The calls this tick has made, to prefetch at the start of the next one. */
  let seen = new Map<string, KeeperContractCall>();
  let head: { value: { number: bigint; timestamp: bigint }; at: number } | undefined;
  let headInFlight: Promise<{ number: bigint; timestamp: bigint }> | undefined;
  /** True from the first send of a tick until the next tick begins. */
  let acted = false;
  /** Bumped whenever the cache is emptied, so a read in flight across that moment is not kept. */
  let generation = 0;
  let stats: TickReadCacheStats = { hits: 0, misses: 0, prefetched: 0, prefetchKept: 0 };

  const fresh = (at: number): boolean => now() - at < maxAgeMs;

  const empty = (): void => {
    entries = new Map();
    inFlight = new Map();
    head = undefined;
    headInFlight = undefined;
    generation += 1;
  };

  const noteSend = (): void => {
    acted = true;
    empty();
  };

  const readContract = async (call: KeeperContractCall): Promise<unknown> => {
    if (!enabled) return inner.readContract(call);
    const key = keyOf(call);
    // Remembered whether or not the cache answers, so the next tick prefetches what this
    // one actually read and a read that stops being made drops out by itself.
    seen.set(key, call);
    if (acted) return inner.readContract(call);

    const entry = entries.get(key);
    if (entry !== undefined && fresh(entry.at)) {
      stats.hits += 1;
      return entry.value;
    }
    const pending = inFlight.get(key);
    if (pending !== undefined) {
      stats.hits += 1;
      return pending;
    }

    stats.misses += 1;
    const startedIn = generation;
    const request = inner.readContract(call).then(
      (value) => {
        if (generation === startedIn) entries.set(key, { value, at: now() });
        return value;
      },
      (error: unknown) => {
        // Never kept: the next read of this call asks the chain again.
        throw error;
      }
    );
    inFlight.set(key, request);
    try {
      return await request;
    } finally {
      if (inFlight.get(key) === request) inFlight.delete(key);
    }
  };

  const readHead = async (read: () => Promise<{ number: bigint; timestamp: bigint }>): Promise<{ number: bigint; timestamp: bigint }> => {
    if (!enabled || acted) return read();
    if (head !== undefined && fresh(head.at)) return head.value;
    if (headInFlight !== undefined) return headInFlight;
    const startedIn = generation;
    const request = read().then((value) => {
      if (generation === startedIn) head = { value, at: now() };
      return value;
    });
    headInFlight = request;
    try {
      return await request;
    } finally {
      if (headInFlight === request) headInFlight = undefined;
    }
  };

  const beginTick = async (): Promise<void> => {
    // The inner client may keep state of its own per tick.
    await inner.beginTick?.();
    const previous = seen;
    seen = new Map();
    acted = false;
    empty();
    stats = { hits: 0, misses: 0, prefetched: 0, prefetchKept: 0 };
    if (!enabled || inner.readContracts === undefined || previous.size === 0) return;

    const keys = [...previous.keys()].slice(0, TICK_READ_CACHE_MAX_PREFETCH);
    const calls = keys.map((key) => previous.get(key) as KeeperContractCall);
    const startedIn = generation;
    stats.prefetched = calls.length;
    let results;
    try {
      results = await inner.readContracts(calls);
    } catch {
      // A prefetch that fails changes nothing: every read falls through to the chain.
      return;
    }
    if (generation !== startedIn || results.length !== calls.length) return;
    const at = now();
    results.forEach((result, index) => {
      if (result.status !== 'success') return;
      entries.set(keys[index] as string, { value: result.result, at });
      stats.prefetchKept += 1;
    });
  };

  const innerHead = inner.getHeadBlock?.bind(inner);
  const innerTimestamp = inner.getBlockTimestamp?.bind(inner);
  const innerBatch = inner.readContracts?.bind(inner);
  const innerBalance = inner.getBalance?.bind(inner);

  const read: KeeperReadClient = {
    readContract,
    beginTick,
    ...(innerBatch === undefined ? {} : { readContracts: (calls) => innerBatch(calls) }),
    ...(innerBalance === undefined ? {} : { getBalance: (address) => innerBalance(address) }),
    ...(innerHead === undefined ? {} : { getHeadBlock: () => readHead(innerHead) }),
    // The block timestamp is the head block's, so one head read serves both where the
    // client can report the head; otherwise the timestamp is read as before.
    ...(innerHead !== undefined
      ? { getBlockTimestamp: async () => (await readHead(innerHead)).timestamp }
      : innerTimestamp === undefined
        ? {}
        : { getBlockTimestamp: () => innerTimestamp() }),
  };

  const guardTx = (tx: KeeperTxSender | undefined): KeeperTxSender | undefined => {
    if (tx === undefined) return undefined;
    const waitForReceipt = tx.waitForReceipt?.bind(tx);
    return {
      account: tx.account,
      simulateAndSend: async (args) => {
        noteSend();
        try {
          return await tx.simulateAndSend(args);
        } finally {
          noteSend();
        }
      },
      ...(waitForReceipt === undefined
        ? {}
        : {
            waitForReceipt: async (hash) => {
              noteSend();
              try {
                return await waitForReceipt(hash);
              } finally {
                noteSend();
              }
            },
          }),
    };
  };

  return { read, guardTx, stats: () => ({ ...stats }) };
};
