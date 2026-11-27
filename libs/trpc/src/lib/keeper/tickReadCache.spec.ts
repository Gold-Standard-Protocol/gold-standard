import type { Abi, Address } from 'viem';
import type { KeeperBatchResult, KeeperContractCall, KeeperReadClient, KeeperTxSender } from './ports';
import { createTickReadCache, TICK_READ_CACHE_MAX_PREFETCH } from './tickReadCache';

const ORACLE = '0x1111111111111111111111111111111111111111' as Address;
const VAULT = '0x2222222222222222222222222222222222222222' as Address;
const TOKEN = '0x3333333333333333333333333333333333333333' as Address;
const abi = [] as unknown as Abi;
const otherAbi = [] as unknown as Abi;

const call = (functionName: string, args?: readonly unknown[], address: Address = ORACLE, useAbi: Abi = abi): KeeperContractCall => ({
  address,
  abi: useAbi,
  functionName,
  args,
});

/** A chain whose every answer is a counter, so a reused answer and a live one are told apart. */
const fakeChain = (overrides: Partial<KeeperReadClient> = {}) => {
  let counter = 0;
  let clock = 1_000_000;
  const singles: KeeperContractCall[] = [];
  const batches: KeeperContractCall[][] = [];
  let headReads = 0;
  const failing = new Set<string>();
  const inner: KeeperReadClient = {
    readContract: async (args) => {
      singles.push(args);
      if (failing.has(args.functionName)) throw new Error(`revert ${args.functionName}`);
      counter += 1;
      return `${args.functionName}#${counter}`;
    },
    readContracts: async (calls) => {
      batches.push([...calls]);
      return calls.map((entry): KeeperBatchResult => {
        if (failing.has(entry.functionName)) return { status: 'failure', error: new Error('revert') };
        counter += 1;
        return { status: 'success', result: `${entry.functionName}#${counter}` };
      });
    },
    getHeadBlock: async () => {
      headReads += 1;
      return { number: BigInt(headReads), timestamp: BigInt(1_700_000_000 + headReads) };
    },
    getBalance: async () => 7n,
    ...overrides,
  };
  return {
    inner,
    singles,
    batches,
    failing,
    headReads: () => headReads,
    now: () => clock,
    advance: (ms: number) => {
      clock += ms;
    },
  };
};

describe('createTickReadCache', () => {
  it('answers a repeated read from the first answer and asks the chain once', async () => {
    const chain = fakeChain();
    const { read, stats } = createTickReadCache(chain.inner, { maxAgeMs: 4_000, now: chain.now });
    await read.beginTick?.();
    const first = await read.readContract(call('paused'));
    const second = await read.readContract(call('paused'));
    expect(second).toBe(first);
    expect(chain.singles).toHaveLength(1);
    expect(stats()).toMatchObject({ hits: 1, misses: 1 });
  });

  it('keeps reads apart by address, function, arguments and ABI', async () => {
    const chain = fakeChain();
    const { read } = createTickReadCache(chain.inner, { maxAgeMs: 4_000, now: chain.now });
    await read.beginTick?.();
    const answers = await Promise.all([
      read.readContract(call('quoteTokenPrice', [TOKEN])),
      read.readContract(call('quoteTokenPrice', [VAULT])),
      read.readContract(call('quoteBorrowPrice', [TOKEN])),
      read.readContract(call('quoteTokenPrice', [TOKEN], VAULT)),
      read.readContract(call('quoteTokenPrice', [TOKEN], ORACLE, otherAbi)),
    ]);
    expect(new Set(answers).size).toBe(5);
    expect(chain.singles).toHaveLength(5);
  });

  it('treats the bigint 1, the number 1 and the string "1" as different arguments', async () => {
    const chain = fakeChain();
    const { read } = createTickReadCache(chain.inner, { maxAgeMs: 4_000, now: chain.now });
    await read.beginTick?.();
    await read.readContract(call('f', [1n]));
    await read.readContract(call('f', [1]));
    await read.readContract(call('f', ['1']));
    await read.readContract(call('f', ['bigint:1']));
    await read.readContract(call('f', ['{"$bigint":"1"}']));
    expect(chain.singles).toHaveLength(5);
  });

  it('matches an address whatever its letter case', async () => {
    const chain = fakeChain();
    const { read } = createTickReadCache(chain.inner, { maxAgeMs: 4_000, now: chain.now });
    await read.beginTick?.();
    const mixed = '0xAbCdEf0000000000000000000000000000000001' as Address;
    await read.readContract(call('paused', undefined, mixed));
    await read.readContract(call('paused', undefined, mixed.toLowerCase() as Address));
    expect(chain.singles).toHaveLength(1);
  });

  it('shares one request between identical reads made at the same moment', async () => {
    const chain = fakeChain();
    const { read } = createTickReadCache(chain.inner, { maxAgeMs: 4_000, now: chain.now });
    await read.beginTick?.();
    const [a, b, c] = await Promise.all([read.readContract(call('paused')), read.readContract(call('paused')), read.readContract(call('paused'))]);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(chain.singles).toHaveLength(1);
  });

  it('never keeps a failure: the next read of the same call asks the chain again', async () => {
    const chain = fakeChain();
    const { read } = createTickReadCache(chain.inner, { maxAgeMs: 4_000, now: chain.now });
    await read.beginTick?.();
    chain.failing.add('quoteTokenPrice');
    await expect(read.readContract(call('quoteTokenPrice', [TOKEN]))).rejects.toThrow('revert quoteTokenPrice');
    await expect(read.readContract(call('quoteTokenPrice', [TOKEN]))).rejects.toThrow('revert quoteTokenPrice');
    chain.failing.delete('quoteTokenPrice');
    await expect(read.readContract(call('quoteTokenPrice', [TOKEN]))).resolves.toMatch(/^quoteTokenPrice#/);
    expect(chain.singles).toHaveLength(3);
  });

  it('hands the caller the error the chain gave, unchanged', async () => {
    const original = new Error('No reliable price');
    const chain = fakeChain({
      readContract: async () => {
        throw original;
      },
    });
    const { read } = createTickReadCache(chain.inner, { maxAgeMs: 4_000, now: chain.now });
    await read.beginTick?.();
    await expect(read.readContract(call('quoteTokenPrice', [TOKEN]))).rejects.toBe(original);
  });

  it('stops reusing an answer once it is as old as the limit', async () => {
    const chain = fakeChain();
    const { read } = createTickReadCache(chain.inner, { maxAgeMs: 4_000, now: chain.now });
    await read.beginTick?.();
    const first = await read.readContract(call('paused'));
    chain.advance(3_999);
    expect(await read.readContract(call('paused'))).toBe(first);
    chain.advance(1);
    expect(await read.readContract(call('paused'))).not.toBe(first);
    expect(chain.singles).toHaveLength(2);
  });

  it('is a plain pass-through with a limit of zero', async () => {
    const chain = fakeChain();
    const { read } = createTickReadCache(chain.inner, { maxAgeMs: 0, now: chain.now });
    await read.beginTick?.();
    await read.readContract(call('paused'));
    await read.readContract(call('paused'));
    await read.getHeadBlock?.();
    await read.getHeadBlock?.();
    await read.beginTick?.();
    expect(chain.singles).toHaveLength(2);
    expect(chain.headReads()).toBe(2);
    expect(chain.batches).toHaveLength(0);
  });

  describe('a new tick', () => {
    it('forgets every answer of the tick before', async () => {
      const chain = fakeChain({ readContracts: undefined });
      const { read } = createTickReadCache(chain.inner, { maxAgeMs: 4_000, now: chain.now });
      await read.beginTick?.();
      const first = await read.readContract(call('paused'));
      await read.beginTick?.();
      expect(await read.readContract(call('paused'))).not.toBe(first);
    });

    it('fetches the reads of the tick before in one batch, and the jobs then ask nothing one by one', async () => {
      const chain = fakeChain();
      const { read, stats } = createTickReadCache(chain.inner, { maxAgeMs: 4_000, now: chain.now });
      await read.beginTick?.();
      const wanted = [call('paused'), call('quoteTokenPrice', [TOKEN]), call('collateralTypes', ['0x01'], VAULT)];
      for (const entry of wanted) await read.readContract(entry);
      expect(chain.singles).toHaveLength(3);

      await read.beginTick?.();
      expect(chain.batches).toHaveLength(1);
      expect(chain.batches[0]).toEqual(wanted);
      const answers = [];
      for (const entry of wanted) answers.push(await read.readContract(entry));
      expect(chain.singles).toHaveLength(3);
      expect(answers).toEqual([expect.stringMatching(/^paused#/), expect.stringMatching(/^quoteTokenPrice#/), expect.stringMatching(/^collateralTypes#/)]);
      expect(stats()).toMatchObject({ hits: 3, misses: 0, prefetched: 3, prefetchKept: 3 });
    });

    it('prefetches only what the last tick read, so a read that stops being made drops out', async () => {
      const chain = fakeChain();
      const { read } = createTickReadCache(chain.inner, { maxAgeMs: 4_000, now: chain.now });
      await read.beginTick?.();
      await read.readContract(call('a'));
      await read.readContract(call('b'));
      await read.beginTick?.();
      await read.readContract(call('a'));
      await read.beginTick?.();
      expect(chain.batches[1]?.map((entry) => entry.functionName)).toEqual(['a']);
    });

    it('does not keep a read that failed in the prefetch: the job sees the live failure', async () => {
      const chain = fakeChain();
      const { read, stats } = createTickReadCache(chain.inner, { maxAgeMs: 4_000, now: chain.now });
      await read.beginTick?.();
      await read.readContract(call('paused'));
      await read.readContract(call('quoteTokenPrice', [TOKEN]));
      chain.failing.add('quoteTokenPrice');
      await read.beginTick?.();
      expect(stats()).toMatchObject({ prefetched: 2, prefetchKept: 1 });
      const before = chain.singles.length;
      await expect(read.readContract(call('quoteTokenPrice', [TOKEN]))).rejects.toThrow('revert quoteTokenPrice');
      expect(chain.singles.length).toBe(before + 1);
      await read.readContract(call('paused'));
      expect(chain.singles.length).toBe(before + 1);
    });

    it('carries on with live reads when the whole prefetch throws', async () => {
      let throwBatch = false;
      const chain = fakeChain();
      const batch = chain.inner.readContracts;
      chain.inner.readContracts = async (calls) => {
        if (throwBatch) throw new Error('rate limited');
        return (batch as NonNullable<typeof batch>)(calls);
      };
      const { read } = createTickReadCache(chain.inner, { maxAgeMs: 4_000, now: chain.now });
      await read.beginTick?.();
      await read.readContract(call('paused'));
      throwBatch = true;
      await expect(read.beginTick?.()).resolves.toBeUndefined();
      await expect(read.readContract(call('paused'))).resolves.toMatch(/^paused#/);
      expect(chain.singles).toHaveLength(2);
    });

    it('ignores a prefetch that answers with the wrong number of results', async () => {
      const chain = fakeChain({ readContracts: async () => [{ status: 'success', result: 'stray' }] });
      const { read } = createTickReadCache(chain.inner, { maxAgeMs: 4_000, now: chain.now });
      await read.beginTick?.();
      await read.readContract(call('a'));
      await read.readContract(call('b'));
      await read.beginTick?.();
      expect(await read.readContract(call('a'))).not.toBe('stray');
    });

    it('asks for no more than the prefetch limit in one batch', async () => {
      const chain = fakeChain();
      const { read } = createTickReadCache(chain.inner, { maxAgeMs: 4_000, now: chain.now });
      await read.beginTick?.();
      for (let i = 0; i < TICK_READ_CACHE_MAX_PREFETCH + 20; i += 1) await read.readContract(call('f', [i]));
      await read.beginTick?.();
      expect(chain.batches[0]).toHaveLength(TICK_READ_CACHE_MAX_PREFETCH);
    });

    it('does not prefetch without a batching client', async () => {
      const chain = fakeChain({ readContracts: undefined });
      const { read } = createTickReadCache(chain.inner, { maxAgeMs: 4_000, now: chain.now });
      await read.beginTick?.();
      await read.readContract(call('paused'));
      await read.beginTick?.();
      await read.readContract(call('paused'));
      expect(chain.singles).toHaveLength(2);
      expect(read.readContracts).toBeUndefined();
    });

    it('does not keep a prefetched answer that was already too old when it is read', async () => {
      const chain = fakeChain();
      const { read } = createTickReadCache(chain.inner, { maxAgeMs: 4_000, now: chain.now });
      await read.beginTick?.();
      await read.readContract(call('paused'));
      await read.beginTick?.();
      chain.advance(4_000);
      const before = chain.singles.length;
      await read.readContract(call('paused'));
      expect(chain.singles.length).toBe(before + 1);
    });

    it("calls the inner client's own tick hook first", async () => {
      const order: string[] = [];
      const chain = fakeChain({
        beginTick: async () => {
          order.push('inner');
        },
      });
      const batch = chain.inner.readContracts as NonNullable<KeeperReadClient['readContracts']>;
      chain.inner.readContracts = async (calls) => {
        order.push('prefetch');
        return batch(calls);
      };
      const { read } = createTickReadCache(chain.inner, { maxAgeMs: 4_000, now: chain.now });
      await read.beginTick?.();
      await read.readContract(call('paused'));
      await read.beginTick?.();
      expect(order).toEqual(['inner', 'inner', 'prefetch']);
    });
  });

  describe('a send', () => {
    const sender = (log: string[]): KeeperTxSender => ({
      account: TOKEN,
      simulateAndSend: async () => {
        log.push('send');
        return { ok: true, hash: '0xabc' };
      },
      waitForReceipt: async () => {
        log.push('wait');
        return { status: 'success' };
      },
    });

    it('switches the cache off for the rest of the tick: every later read is live', async () => {
      const chain = fakeChain();
      const cache = createTickReadCache(chain.inner, { maxAgeMs: 4_000, now: chain.now });
      const tx = cache.guardTx(sender([])) as KeeperTxSender;
      await cache.read.beginTick?.();
      const before = await cache.read.readContract(call('quoteTokenPrice', [TOKEN]));
      expect(await cache.read.readContract(call('quoteTokenPrice', [TOKEN]))).toBe(before);

      await tx.simulateAndSend({ address: VAULT, abi, functionName: 'liquidate', args: [] });
      const after = await cache.read.readContract(call('quoteTokenPrice', [TOKEN]));
      const again = await cache.read.readContract(call('quoteTokenPrice', [TOKEN]));
      expect(after).not.toBe(before);
      expect(again).not.toBe(after);
      await cache.read.getHeadBlock?.();
      await cache.read.getHeadBlock?.();
      expect(chain.headReads()).toBe(2);
    });

    it('is off even when the send fails or throws', async () => {
      const chain = fakeChain();
      const cache = createTickReadCache(chain.inner, { maxAgeMs: 4_000, now: chain.now });
      const tx = cache.guardTx({
        account: TOKEN,
        simulateAndSend: async () => {
          throw new Error('rpc down');
        },
      }) as KeeperTxSender;
      await cache.read.beginTick?.();
      const before = await cache.read.readContract(call('paused'));
      await expect(tx.simulateAndSend({ address: VAULT, abi, functionName: 'liquidate', args: [] })).rejects.toThrow('rpc down');
      expect(await cache.read.readContract(call('paused'))).not.toBe(before);
    });

    it('reads made while the send is in flight are live as well', async () => {
      const chain = fakeChain();
      const cache = createTickReadCache(chain.inner, { maxAgeMs: 4_000, now: chain.now });
      let during: unknown;
      const tx = cache.guardTx({
        account: TOKEN,
        simulateAndSend: async () => {
          during = await cache.read.readContract(call('paused'));
          return { ok: true, hash: '0xabc' };
        },
      }) as KeeperTxSender;
      await cache.read.beginTick?.();
      const before = await cache.read.readContract(call('paused'));
      await tx.simulateAndSend({ address: VAULT, abi, functionName: 'liquidate', args: [] });
      expect(during).not.toBe(before);
    });

    it('does not keep an answer that was in flight when the send began', async () => {
      const chain = fakeChain();
      let release: (value: unknown) => void = () => undefined;
      let slow = true;
      const plain = chain.inner.readContract;
      chain.inner.readContract = (args) => {
        if (slow) {
          slow = false;
          return new Promise((resolve) => {
            release = resolve;
          });
        }
        return plain(args);
      };
      const cache = createTickReadCache(chain.inner, { maxAgeMs: 4_000, now: chain.now });
      const tx = cache.guardTx(sender([])) as KeeperTxSender;
      await cache.read.beginTick?.();
      const pending = cache.read.readContract(call('paused'));
      await tx.simulateAndSend({ address: VAULT, abi, functionName: 'liquidate', args: [] });
      release('stale');
      expect(await pending).toBe('stale');
      await cache.read.beginTick?.();
      // nothing from before the send survives into a later tick either
      expect(await cache.read.readContract(call('paused'))).not.toBe('stale');
    });

    it('waiting for a receipt switches the cache off too', async () => {
      const chain = fakeChain();
      const cache = createTickReadCache(chain.inner, { maxAgeMs: 4_000, now: chain.now });
      const tx = cache.guardTx(sender([])) as KeeperTxSender;
      await cache.read.beginTick?.();
      const before = await cache.read.readContract(call('paused'));
      await tx.waitForReceipt?.('0xabc');
      expect(await cache.read.readContract(call('paused'))).not.toBe(before);
    });

    it('the next tick starts with the cache on again', async () => {
      const chain = fakeChain({ readContracts: undefined });
      const cache = createTickReadCache(chain.inner, { maxAgeMs: 4_000, now: chain.now });
      const tx = cache.guardTx(sender([])) as KeeperTxSender;
      await cache.read.beginTick?.();
      await tx.simulateAndSend({ address: VAULT, abi, functionName: 'liquidate', args: [] });
      await cache.read.beginTick?.();
      const first = await cache.read.readContract(call('paused'));
      expect(await cache.read.readContract(call('paused'))).toBe(first);
    });

    it('passes the sender through unchanged in what it does and reports', async () => {
      const log: string[] = [];
      const chain = fakeChain();
      const cache = createTickReadCache(chain.inner, { maxAgeMs: 4_000, now: chain.now });
      const tx = cache.guardTx(sender(log)) as KeeperTxSender;
      expect(tx.account).toBe(TOKEN);
      await expect(tx.simulateAndSend({ address: VAULT, abi, functionName: 'liquidate', args: [1n] })).resolves.toEqual({ ok: true, hash: '0xabc' });
      await expect(tx.waitForReceipt?.('0xabc')).resolves.toEqual({ status: 'success' });
      expect(log).toEqual(['send', 'wait']);
    });

    it('keeps a watch-only keeper watch-only, and a sender without a receipt wait without one', () => {
      const chain = fakeChain();
      const cache = createTickReadCache(chain.inner, { maxAgeMs: 4_000, now: chain.now });
      expect(cache.guardTx(undefined)).toBeUndefined();
      const bare = cache.guardTx({ account: TOKEN, simulateAndSend: async () => ({ ok: true, hash: '0xabc' }) }) as KeeperTxSender;
      expect(bare.waitForReceipt).toBeUndefined();
    });
  });

  describe('the head block', () => {
    it('is read once a tick for the head and the timestamp together', async () => {
      const chain = fakeChain();
      const { read } = createTickReadCache(chain.inner, { maxAgeMs: 4_000, now: chain.now });
      await read.beginTick?.();
      const head = await read.getHeadBlock?.();
      const timestamp = await read.getBlockTimestamp?.();
      const again = await read.getHeadBlock?.();
      expect(timestamp).toBe(head?.timestamp);
      expect(again).toEqual(head);
      expect(chain.headReads()).toBe(1);
    });

    it('is read again in the next tick and once it is too old', async () => {
      const chain = fakeChain();
      const { read } = createTickReadCache(chain.inner, { maxAgeMs: 4_000, now: chain.now });
      await read.beginTick?.();
      await read.getHeadBlock?.();
      chain.advance(4_000);
      await read.getHeadBlock?.();
      await read.beginTick?.();
      await read.getHeadBlock?.();
      expect(chain.headReads()).toBe(3);
    });

    it('does not keep a head read that failed', async () => {
      let fail = true;
      const chain = fakeChain({
        getHeadBlock: async () => {
          if (fail) throw new Error('timeout');
          return { number: 5n, timestamp: 50n };
        },
      });
      const { read } = createTickReadCache(chain.inner, { maxAgeMs: 4_000, now: chain.now });
      await read.beginTick?.();
      await expect(read.getHeadBlock?.()).rejects.toThrow('timeout');
      fail = false;
      await expect(read.getHeadBlock?.()).resolves.toEqual({ number: 5n, timestamp: 50n });
    });

    it('uses the client timestamp read when it cannot report the head', async () => {
      const chain = fakeChain({ getHeadBlock: undefined, getBlockTimestamp: async () => 99n });
      const { read } = createTickReadCache(chain.inner, { maxAgeMs: 4_000, now: chain.now });
      expect(read.getHeadBlock).toBeUndefined();
      await expect(read.getBlockTimestamp?.()).resolves.toBe(99n);
    });

    it('offers neither when the client offers neither', () => {
      const chain = fakeChain({ getHeadBlock: undefined, getBlockTimestamp: undefined, getBalance: undefined });
      const { read } = createTickReadCache(chain.inner, { maxAgeMs: 4_000, now: chain.now });
      expect(read.getHeadBlock).toBeUndefined();
      expect(read.getBlockTimestamp).toBeUndefined();
      expect(read.getBalance).toBeUndefined();
    });
  });

  it('never caches a balance or a batched owner read', async () => {
    let balances = 0;
    const chain = fakeChain({
      getBalance: async () => {
        balances += 1;
        return BigInt(balances);
      },
    });
    const { read } = createTickReadCache(chain.inner, { maxAgeMs: 4_000, now: chain.now });
    await read.beginTick?.();
    expect(await read.getBalance?.(TOKEN)).toBe(1n);
    expect(await read.getBalance?.(TOKEN)).toBe(2n);
    const owners = [call('getVaultCurrentDebt', [TOKEN], VAULT)];
    const first = await read.readContracts?.(owners);
    const second = await read.readContracts?.(owners);
    expect(first).not.toEqual(second);
    expect(chain.batches).toHaveLength(2);
  });
});
