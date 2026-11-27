import { getAddress } from 'viem';
import type { Address } from 'viem';
import type { KeeperConfig } from './config';
import { runLiquidationWatch } from './liquidationWatch';
import {
  combineVaultOwnerSources,
  createRegistryVaultOwnerSource,
  MAX_REGISTRY_OWNERS,
} from './registryOwnerSource';
import type {
  KeeperContractCall,
  KeeperJobDeps,
  KeeperLogger,
  KeeperReadClient,
  KeeperTxSender,
} from './ports';

// A keeper that walked only the first 20,000 VaultRegistry entries let one wei dust
// vaults hide every vault listed after them from liquidation monitoring. A keeper with the
// registry as its only owner list (no Redis, the runbook
// shape) runs the real registry source and the real liquidation watch; only the chain
// reads and the sender are stubbed. The registry answers from an array in its listing
// order: debt-free dust owners first, then one liquidatable vault.

const VAULT = getAddress('0x00000000000000000000000000000000000a0001');
const ORACLE = getAddress('0x00000000000000000000000000000000000a0002');
const STABILITY_MODULE = getAddress('0x00000000000000000000000000000000000a0003');
const PAXG = getAddress('0x00000000000000000000000000000000000a0004');
const POOL = getAddress('0x00000000000000000000000000000000000a0005');
const GSUSD = getAddress('0x00000000000000000000000000000000000a0006');
const REGISTRY = getAddress('0x00000000000000000000000000000000000a0007');
const KEEPER_ACCOUNT = getAddress('0x00000000000000000000000000000000000a0008');
const BORROWER = getAddress('0x00000000000000000000000000000000000b0001');
const TX_HASH = `0x${'ab'.repeat(32)}` as const;

/** $2,000 per ounce, 8 decimals. */
const PRICE = 2_000n * 10n ** 8n;
const BORROWER_DEBT = 10_000n * 10n ** 18n;
/** 5.3 PAXG: 106% at $2,000, under the 110% liquidation ratio. */
const BORROWER_COLLATERAL = 53n * 10n ** 17n;
/** 10,000 x 1.1 / 5.3, 8 decimals: above the quote, so liquidatable. */
const BORROWER_LIQUIDATION_PRICE = 207_547_169_811n;

const dustOwner = (index: number): Address =>
  getAddress(`0x${(0xd0000000 + index).toString(16).padStart(40, '0')}`);

const config: KeeperConfig = {
  chainId: 1,
  rpcUrl: 'https://rpc.example.org',
  dryRun: false,
  enableDirect: false,
  intervalSeconds: 60,
  maxFeePerGasWei: 100n * 10n ** 9n,
  maxPriorityFeePerGasWei: 2n * 10n ** 9n,
  redisConfigured: false,
  goldVaultAddress: VAULT,
  goldOracleAddress: ORACLE,
  stabilityModuleAddress: STABILITY_MODULE,
  gsusdAddress: GSUSD,
  stabilityPoolAddress: POOL,
  paxgToken: PAXG,
  xautToken: undefined,
  vaultRegistryAddress: REGISTRY,
  priceWatchdogAlertBps: 100,
  stuckTxReplaceSeconds: 300,
  readCacheMs: 4_000,
  feedHeartbeatSeconds: 86_400,
  feedLateMarginSeconds: 900,
  feedLateRepeatSeconds: 3_600,
  offChainPriceSource: 'none',
  priceApiUrl: 'https://price.example.org/simple',
};

const createChain = (
  listing: readonly Address[]
): { read: KeeperReadClient; borrowerReads: string[] } => {
  const borrowerReads: string[] = [];
  const readContract = async ({ address, functionName, args }: KeeperContractCall): Promise<unknown> => {
    if (address === REGISTRY) {
      if (functionName === 'vaultOwnerCount') return BigInt(listing.length);
      if (functionName === 'vaultOwners') {
        const [offset, limit] = args as readonly [bigint, bigint];
        return listing.slice(Number(offset), Number(offset + limit));
      }
      throw new Error(`Unexpected registry read: ${functionName}`);
    }
    const isBorrower = args?.[0] === BORROWER;
    if (isBorrower) borrowerReads.push(functionName);
    switch (functionName) {
      case 'getVaultCurrentDebt':
        // Dust owners hold one wei of collateral and no debt.
        return isBorrower ? BORROWER_DEBT : 0n;
      case 'vaults':
        return [PAXG, isBorrower ? BORROWER_COLLATERAL : 1n, isBorrower ? BORROWER_DEBT : 0n];
      case 'collateralTypes':
        return [PAXG, 1_300_000n, 1_100_000n, 50_000n, 0n, 0n, true];
      case 'decimals':
        return 18;
      case 'getLiquidationPrice':
        return isBorrower ? BORROWER_LIQUIDATION_PRICE : 0n;
      case 'quoteTokenPrice':
        return PRICE;
      case 'paused':
      case 'tokenFrozen':
        return false;
      case 'totalDeposits':
        return 500_000n * 10n ** 18n;
      case 'minDebt':
        return 1_000n * 10n ** 18n;
      case 'underwaterDiscountPpm':
        return 20_000n;
      case 'balanceOf':
      case 'allowance':
        return 0n;
      default:
        throw new Error(`Unexpected read: ${functionName}`);
    }
  };
  return {
    borrowerReads,
    read: {
      readContract,
      readContracts: async (calls) =>
        Promise.all(
          calls.map(async (call) => {
            try {
              return { status: 'success' as const, result: await readContract(call) };
            } catch (error) {
              return { status: 'failure' as const, error };
            }
          })
        ),
    },
  };
};

interface TickRecord {
  alerted: unknown[];
  sends: string[];
  errors: string[];
  borrowerReads: string[];
}

/**
 * A registry-only keeper whose ticks share one owner source, as the scheduler's do. Its
 * first window starts at the head of the listing unless a test says otherwise: for a
 * vault listed last that is the worst case, since a keeper draws its start page at random.
 */
const createKeeper = (
  listing: readonly Address[],
  pickStartPage: (pageCount: number) => number = () => 0
): { tick: () => Promise<TickRecord> } => {
  const chain = createChain(listing);
  const alerted: unknown[] = [];
  const sends: string[] = [];
  const errors: string[] = [];
  const log: KeeperLogger = {
    info: () => undefined,
    warn: (event, fields) => {
      if (event === 'vault.liquidatable') alerted.push(fields?.['owner']);
    },
    error: (event, fields) => errors.push(`${event}:${String(fields?.['job'])}`),
  };
  const tx: KeeperTxSender = {
    account: KEEPER_ACCOUNT,
    simulateAndSend: async ({ functionName, args }) => {
      sends.push(`${functionName}(${String(args[0])})`);
      return { ok: true, hash: TX_HASH };
    },
    waitForReceipt: async () => ({ status: 'success' }),
  };
  const deps: KeeperJobDeps = {
    read: chain.read,
    tx,
    owners: createRegistryVaultOwnerSource(REGISTRY, chain.read, log, { pickStartPage }),
    log,
  };
  return {
    tick: async () => {
      alerted.length = 0;
      sends.length = 0;
      errors.length = 0;
      chain.borrowerReads.length = 0;
      await runLiquidationWatch(deps, config);
      return {
        alerted: [...alerted],
        sends: [...sends],
        errors: [...errors],
        borrowerReads: [...chain.borrowerReads],
      };
    },
  };
};

const dustThenBorrower = (dust: number): Address[] => [
  ...Array.from({ length: dust }, (_, index) => dustOwner(index)),
  BORROWER,
];

describe('liquidation watch over a VaultRegistry padded with dust owners', () => {
  it('reads, alerts and liquidates a vault listed last inside the window on the first tick', async () => {
    const keeper = createKeeper(dustThenBorrower(MAX_REGISTRY_OWNERS - 1));

    const first = await keeper.tick();

    expect(first.borrowerReads).toContain('getLiquidationPrice');
    expect(first.alerted).toEqual([BORROWER]);
    expect(first.sends).toEqual([`liquidateViaPool(${BORROWER})`]);
    expect(first.errors).toEqual([]);
  });

  it('reads, alerts and liquidates a vault listed behind 20,000 dust owners by the second tick', async () => {
    const keeper = createKeeper(dustThenBorrower(MAX_REGISTRY_OWNERS));

    const first = await keeper.tick();
    const second = await keeper.tick();

    // The first tick fills its window with dust and says, at error level, that the
    // registry is longer than one tick; the second resumes where the first stopped.
    expect(first.errors).toContain('keeper.job-error:vault-registry-owner-source');
    expect(second.borrowerReads).toContain('getLiquidationPrice');
    expect([...first.alerted, ...second.alerted]).toEqual([BORROWER]);
    expect([...first.sends, ...second.sends]).toEqual([`liquidateViaPool(${BORROWER})`]);
  });

  it.each([1, 20, 40])(
    'reaches the vault listed last within two ticks when the first window starts at page %p',
    async (startPage) => {
      const keeper = createKeeper(dustThenBorrower(MAX_REGISTRY_OWNERS), () => startPage);

      const first = await keeper.tick();
      const second = await keeper.tick();

      expect([...first.alerted, ...second.alerted]).toContain(BORROWER);
      expect([...first.sends, ...second.sends]).toContain(`liquidateViaPool(${BORROWER})`);
    }
  );
});

// A registry-only keeper whose registry read fails on
// every tick, for example an address with no code, read no owners, logged one warn and
// then vault.no-owners at info as an honest pre-launch state, so nothing paged while every
// vault went unwatched. The keeper reads its one source through the union, as main.ts does.
describe('liquidation watch of a registry-only keeper that reads no owner list', () => {
  const runTicks = async (read: KeeperReadClient, ticks: number): Promise<string[]> => {
    const events: string[] = [];
    const record =
      (level: string) =>
      (event: string, fields?: Record<string, unknown>): void => {
        events.push(`${level}:${event}:${String(fields?.['job'] ?? '')}`);
      };
    const log: KeeperLogger = { info: record('info'), warn: record('warn'), error: record('error') };
    const deps: KeeperJobDeps = {
      read,
      tx: undefined,
      owners: combineVaultOwnerSources([createRegistryVaultOwnerSource(REGISTRY, read, log)], log),
      log,
    };
    for (let tick = 0; tick < ticks; tick += 1) {
      await runLiquidationWatch(deps, config);
    }
    return events;
  };

  it('pages on every tick on which the registry read fails', async () => {
    const noCode: KeeperReadClient = {
      readContract: async ({ functionName }) => {
        throw new Error(`The contract function "${functionName}" returned no data ("0x").`);
      },
    };

    const events = await runTicks(noCode, 2);

    expect(events.filter((entry) => entry.startsWith('error:'))).toEqual([
      'error:keeper.job-error:vault-owner-sources',
      'error:keeper.job-error:vault-owner-sources',
    ]);
  });

  it('logs only vault.no-owners at info for an empty registry it read, the state before launch', async () => {
    const events = await runTicks(createChain([]).read, 1);

    expect(events).toEqual(['info:vault.no-owners:']);
  });
});
