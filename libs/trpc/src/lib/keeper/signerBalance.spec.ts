import { getAddress } from 'viem';
import type { Address } from 'viem';
import type { KeeperConfig } from './config';
import { LIQUIDATE_VIA_POOL_GAS_FLOOR } from './liquidationConstants';
import type { KeeperJobDeps, KeeperLogger, KeeperTxSender } from './ports';
import { runSignerBalanceWatch, SIGNER_BALANCE_WARN_LIQUIDATIONS } from './signerBalance';

const VAULT = getAddress('0x5fbdb2315678afecb367f032d93f642f64180aa3');
const ORACLE = getAddress('0xe7f1725e7734ce288f8367e1bb143e90bb3f0512');
const PAXG = getAddress('0xcf7ed3acca5a467e9e704c703e8d87f634fb0fc9');
const KEEPER_ACCOUNT = getAddress('0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc');

const MAX_FEE = 150n * 10n ** 9n;
/** One pool liquidation at the fee ceiling: 1.4M gas at 150 gwei, 0.21 ETH. */
const ONE_LIQUIDATION = LIQUIDATE_VIA_POOL_GAS_FLOOR * MAX_FEE;

const baseConfig = (overrides: Partial<KeeperConfig> = {}): KeeperConfig => ({
  chainId: 1,
  rpcUrl: 'https://mainnet.example.org/rpc',
  dryRun: false,
  enableDirect: false,
  intervalSeconds: 60,
  goldVaultAddress: VAULT,
  goldOracleAddress: ORACLE,
  stabilityModuleAddress: '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0',
  gsusdAddress: '0x5FC8d32690cc91D4c39d9d3aBcBD16989F875707',
  stabilityPoolAddress: '0x0165878A594ca255338adfa4d48449f69242Eb8F',
  paxgToken: PAXG,
  xautToken: undefined,
  vaultRegistryAddress: undefined,
  maxFeePerGasWei: MAX_FEE,
  maxPriorityFeePerGasWei: 3n * 10n ** 9n,
  redisConfigured: true,
  offChainPriceSource: 'redis',
  priceApiUrl: 'https://api.coingecko.com/api/v3/simple/price',
  priceWatchdogAlertBps: 100,
  stuckTxReplaceSeconds: 300,
  readCacheMs: 4_000,
  feedHeartbeatSeconds: 86_400,
  feedLateMarginSeconds: 900,
  feedLateRepeatSeconds: 3_600,
  ...overrides,
});

interface LoggedEvent {
  level: 'info' | 'warn' | 'error';
  event: string;
  fields?: Record<string, unknown>;
}

const createStubLogger = (): { log: KeeperLogger; events: LoggedEvent[] } => {
  const events: LoggedEvent[] = [];
  const push =
    (level: LoggedEvent['level']) =>
    (event: string, fields?: Record<string, unknown>): void => {
      events.push({ level, event, fields });
    };
  return { log: { info: push('info'), warn: push('warn'), error: push('error') }, events };
};

const SIGNER: KeeperTxSender = {
  account: KEEPER_ACCOUNT,
  simulateAndSend: async () => {
    throw new Error('the balance watch never sends');
  },
};

interface RunOptions {
  balance?: bigint;
  /** Leave the sender out, as in a dry run or a keeper with no key. */
  noSigner?: boolean;
  /** Leave the balance seam out, as a read client that cannot answer it. */
  noBalanceRead?: boolean;
  balanceError?: Error;
  config?: Partial<KeeperConfig>;
}

const run = async (
  options: RunOptions
): Promise<{ events: LoggedEvent[]; asked: Address[] }> => {
  const { log, events } = createStubLogger();
  const asked: Address[] = [];
  const deps: KeeperJobDeps = {
    read: {
      readContract: async () => {
        throw new Error('the balance watch reads no contract');
      },
      ...(options.noBalanceRead === true
        ? {}
        : {
            getBalance: async (address: Address): Promise<bigint> => {
              asked.push(address);
              if (options.balanceError !== undefined) throw options.balanceError;
              return options.balance ?? 0n;
            },
          }),
    },
    tx: options.noSigner === true ? undefined : SIGNER,
    owners: { getOwners: async () => [] },
    log,
  };
  await runSignerBalanceWatch(deps, baseConfig(options.config));
  return { events, asked };
};

describe('runSignerBalanceWatch', () => {
  it('prices one liquidation at the pool gas floor and the fee ceiling', () => {
    expect(ONE_LIQUIDATION).toBe(210_000_000_000_000_000n);
    expect(SIGNER_BALANCE_WARN_LIQUIDATIONS).toBe(3n);
  });

  it('says nothing while the signer can pay for three liquidations at the fee ceiling', async () => {
    const { events, asked } = await run({ balance: ONE_LIQUIDATION * 3n });
    expect(events).toEqual([]);
    expect(asked).toEqual([KEEPER_ACCOUNT]);
  });

  it('warns keeper.signer-balance-low below three liquidations', async () => {
    const balance = ONE_LIQUIDATION * 3n - 1n;
    const { events } = await run({ balance });
    expect(events).toEqual([
      {
        level: 'warn',
        event: 'keeper.signer-balance-low',
        fields: {
          account: KEEPER_ACCOUNT,
          balanceWei: balance,
          liquidationCostWei: ONE_LIQUIDATION,
          liquidationsCovered: 2n,
        },
      },
    ]);
  });

  it('still only warns at exactly one liquidation', async () => {
    const { events } = await run({ balance: ONE_LIQUIDATION });
    expect(events.map((entry) => [entry.level, entry.event])).toEqual([
      ['warn', 'keeper.signer-balance-low'],
    ]);
    expect(events[0].fields?.liquidationsCovered).toBe(1n);
  });

  // A node refuses a transaction whose gas limit times its fee cap exceeds the balance, so
  // below this line a liquidation is refused once the network fee nears the ceiling,
  // however healthy the pool is.
  it('pages keeper.signer-balance-insufficient below one liquidation', async () => {
    const balance = ONE_LIQUIDATION - 1n;
    const { events } = await run({ balance });
    expect(events).toEqual([
      {
        level: 'error',
        event: 'keeper.signer-balance-insufficient',
        fields: {
          account: KEEPER_ACCOUNT,
          balanceWei: balance,
          liquidationCostWei: ONE_LIQUIDATION,
          liquidationsCovered: 0n,
        },
      },
    ]);
  });

  it('pages for an empty wallet', async () => {
    const { events } = await run({ balance: 0n });
    expect(events.map((entry) => [entry.level, entry.event])).toEqual([
      ['error', 'keeper.signer-balance-insufficient'],
    ]);
  });

  it('follows the configured fee ceiling', async () => {
    // At a 30 gwei ceiling one liquidation is 0.042 ETH, so 0.2 ETH covers four.
    const { events } = await run({
      balance: 200_000_000_000_000_000n,
      config: { maxFeePerGasWei: 30n * 10n ** 9n },
    });
    expect(events).toEqual([]);
  });

  it('checks nothing without a signer: a dry run sends nothing', async () => {
    const { events, asked } = await run({ noSigner: true, balance: 0n });
    expect(events).toEqual([]);
    expect(asked).toEqual([]);
  });

  // A missing adapter used to return in silence, which read as a funded wallet.
  it('reports a keeper that signs but was wired without a balance read', async () => {
    await expect(run({ noBalanceRead: true })).rejects.toThrow('has no balance read');
  });

  // The scheduler turns the rejection into keeper.job-error under the job's own name; an
  // unreadable balance must never read as a healthy one.
  it('lets a failed balance read reach the scheduler', async () => {
    await expect(run({ balanceError: new Error('rpc down') })).rejects.toThrow('rpc down');
  });
});
