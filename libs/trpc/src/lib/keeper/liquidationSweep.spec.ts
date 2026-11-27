import { getAddress } from 'viem';
import type { Address } from 'viem';
import type { KeeperConfig } from './config';
import { readDebtsInBatches, reportSweep } from './liquidationSweep';
import type { KeeperBatchResult, KeeperContractCall, KeeperJobDeps, KeeperLogger } from './ports';

const VAULT = getAddress('0x5fbdb2315678afecb367f032d93f642f64180aa3');

const config = { goldVaultAddress: VAULT } as KeeperConfig;

const owner = (index: number): Address =>
  getAddress(`0x${(0x4000 + index).toString(16).padStart(40, '0')}`);

interface Logged {
  level: 'info' | 'warn' | 'error';
  event: string;
  fields?: Record<string, unknown>;
}

const createLog = (): { log: KeeperLogger; events: Logged[] } => {
  const events: Logged[] = [];
  return {
    events,
    log: {
      info: (event, fields) => events.push({ level: 'info', event, fields }),
      warn: (event, fields) => events.push({ level: 'warn', event, fields }),
      error: (event, fields) => events.push({ level: 'error', event, fields }),
    },
  };
};

const ownerOf = (call: KeeperContractCall): Address => call.args?.[0] as Address;

/**
 * A batch reader shaped like the production adapter: viem's multicall with allowFailure
 * never throws for a failed sub-call or a rejected aggregate3 chunk, it hands back one
 * failure entry per call instead.
 */
const createDeps = (options: {
  debts: Map<Address, bigint>;
  /** Decides each batch entry; failures carry the error viem would put there. */
  entry: (owner: Address, batchNumber: number) => KeeperBatchResult | undefined;
  /** Owners whose single read throws. */
  singleFails?: Set<Address>;
}): { deps: KeeperJobDeps; events: Logged[]; batches: Address[][]; singles: Address[] } => {
  const { log, events } = createLog();
  const batches: Address[][] = [];
  const singles: Address[] = [];
  const deps: KeeperJobDeps = {
    log,
    tx: undefined,
    owners: { getOwners: async () => [] },
    read: {
      readContract: async (call) => {
        const target = ownerOf(call);
        singles.push(target);
        if (options.singleFails?.has(target) === true) throw new Error('fetch failed');
        return options.debts.get(target) ?? 0n;
      },
      readContracts: async (calls) => {
        const batchNumber = batches.length;
        batches.push(calls.map(ownerOf));
        return calls.map(
          (call): KeeperBatchResult =>
            options.entry(ownerOf(call), batchNumber) ?? {
              status: 'success',
              result: options.debts.get(ownerOf(call)) ?? 0n,
            }
        );
      },
    },
  };
  return { deps, events, batches, singles };
};

describe('readDebtsInBatches when batch entries fail', () => {
  it('retries the owners whose entries the provider failed and reads them, without single reads', async () => {
    const owners = [owner(0), owner(1), owner(2)];
    const debts = new Map<Address, bigint>([[owner(1), 500n]]);
    const { deps, batches, singles } = createDeps({
      debts,
      // The first batch loses owner 1 to a rate limit; the retry answers.
      entry: (target, batchNumber) =>
        batchNumber === 0 && target === owner(1)
          ? { status: 'failure', error: new Error('HTTP request failed. Status: 429') }
          : undefined,
    });

    const sweep = await readDebtsInBatches(deps, config, owners);

    expect(batches).toEqual([owners, [owner(1)]]);
    expect(singles).toEqual([]);
    expect(sweep?.debts.get(owner(1))).toBe(500n);
    expect(sweep?.unread).toEqual([]);
  });

  it('reads singly what the retry still fails and counts what still fails as unread', async () => {
    const owners = [owner(0), owner(1), owner(2)];
    const debts = new Map<Address, bigint>([[owner(2), 700n]]);
    const { deps, singles, events } = createDeps({
      debts,
      entry: (target) =>
        target === owner(0) || target === owner(2)
          ? { status: 'failure', error: new Error('fetch failed') }
          : undefined,
      singleFails: new Set([owner(0)]),
    });

    const sweep = await readDebtsInBatches(deps, config, owners);

    expect(singles).toEqual([owner(0), owner(2)]);
    expect(sweep?.debts.get(owner(2))).toBe(700n);
    expect(sweep?.debts.has(owner(0))).toBe(false);
    expect(sweep?.unread).toEqual([owner(0)]);

    reportSweep(deps, 'liquidation-watch', owners, sweep ?? { debts: new Map(), unread: [] });
    expect(events.find((entry) => entry.event === 'vault.owner-sweep')?.fields).toMatchObject({
      owners: 3,
      read: 2,
      unread: 1,
    });
    expect(events.find((entry) => entry.event === 'vault.owners-unread')?.fields).toMatchObject({
      count: 1,
      owners: [owner(0)],
    });
  });

  it('reads a reverted entry singly without retrying the batch, since a revert repeats', async () => {
    const owners = [owner(0), owner(1)];
    const { deps, batches, singles } = createDeps({
      debts: new Map(),
      entry: (target) =>
        target === owner(1) ? { status: 'failure', error: new Error('execution reverted') } : undefined,
      singleFails: new Set([owner(1)]),
    });

    const sweep = await readDebtsInBatches(deps, config, owners);

    expect(batches).toHaveLength(1);
    expect(singles).toEqual([owner(1)]);
    expect(sweep?.unread).toEqual([owner(1)]);
  });

  it('treats a malformed entry as a failed one', async () => {
    const owners = [owner(0)];
    const { deps, singles } = createDeps({
      debts: new Map([[owner(0), 42n]]),
      entry: (_target, batchNumber) =>
        batchNumber === 0 ? { status: 'success', result: 'not a number' } : undefined,
    });

    const sweep = await readDebtsInBatches(deps, config, owners);

    expect(singles).toEqual([owner(0)]);
    expect(sweep?.debts.get(owner(0))).toBe(42n);
    expect(sweep?.unread).toEqual([]);
  });

  it('says how many entries of a chunk failed and why', async () => {
    const owners = [owner(0), owner(1)];
    const { deps, events } = createDeps({
      debts: new Map(),
      entry: (target, batchNumber) =>
        batchNumber === 0 && target === owner(0)
          ? { status: 'failure', error: new Error('HTTP request failed. Status: 429') }
          : undefined,
    });

    await readDebtsInBatches(deps, config, owners);

    const warned = events.find((entry) => entry.event === 'keeper.job-error');
    expect(warned?.level).toBe('warn');
    expect(String(warned?.fields?.['detail'])).toContain('1 of 2');
    expect(String(warned?.fields?.['reason'])).toContain('429');
  });
});
