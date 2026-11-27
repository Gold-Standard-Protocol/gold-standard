import { getAddress } from 'viem';
import type { Address } from 'viem';
import type { KeeperConfig } from './config';
import {
  fullLiquidationRepay,
  isThinVault,
  requiresFullLiquidation,
  requiresFullLiquidationByRatio,
  sizeDirectPartial,
  sizePoolAbsorb,
} from './liquidationSizing';
import { createLiquidationWatch, QUOTE_MAX_AGE_MS, runLiquidationWatch } from './liquidationWatch';
import type {
  KeeperJobDeps,
  KeeperLogger,
  KeeperReadClient,
  KeeperTxSender,
} from './ports';

const OWNER_A = getAddress('0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266');
const OWNER_B = getAddress('0x70997970c51812dc3a010c7d01b50e0d17dc79c8');
const VAULT = getAddress('0x5fbdb2315678afecb367f032d93f642f64180aa3');
const ORACLE = getAddress('0xe7f1725e7734ce288f8367e1bb143e90bb3f0512');
const STABILITY_MODULE = getAddress(
  '0x9fe46736679d2d9a65f0992f2272de9f3c7fa6e0'
);
const PAXG = getAddress('0xcf7ed3acca5a467e9e704c703e8d87f634fb0fc9');
const POOL = getAddress('0xdc64a140aa3e981100a9beca4e685f962f0cf6c9');
const GSUSD = getAddress('0x5fc8d32690cc91d4c39d9d3abcbd16989f875707');
const KEEPER_ACCOUNT = getAddress('0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc');
const TX_HASH = `0x${'12'.repeat(32)}` as const;

const LIQUIDATION_RATIO = 1_100_000n;
/** $2000/oz, 8 decimals — the live feed price used by the fixtures. */
const DEFAULT_LIVE_PRICE = 200_000_000_000n;
/**
 * Derive a vault's liquidation price from the ratio a fixture declares.
 *
 * The collateralisation ratio scales linearly with the gold price, so
 * `liquidationPrice = livePrice * liquidationRatio / ratio`. That makes the
 * stub model the real contract relationship exactly: a fixture whose ratio is
 * below LIQUIDATION_RATIO yields a liquidation price ABOVE the live price and
 * is therefore liquidatable under the live-price gate, and vice versa. Every
 * pre-existing fixture keeps its original meaning without being rewritten.
 */
const liquidationPriceForRatio = (ratio: bigint, livePrice: bigint): bigint =>
  ratio === 0n ? 0n : (livePrice * LIQUIDATION_RATIO) / ratio;

const baseConfig = (overrides: Partial<KeeperConfig> = {}): KeeperConfig => ({
  chainId: 11155111,
  rpcUrl: 'https://sepolia.example.org/rpc',
  dryRun: false,
  enableDirect: false,
  intervalSeconds: 60,
  goldVaultAddress: VAULT,
  goldOracleAddress: ORACLE,
  stabilityModuleAddress: STABILITY_MODULE,
  gsusdAddress: GSUSD,
  stabilityPoolAddress: POOL,
  paxgToken: PAXG,
  xautToken: undefined,
  vaultRegistryAddress: undefined,
  maxFeePerGasWei: 150n * 10n ** 9n,
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
  return {
    log: {
      info: (event, fields) => {
        events.push({ level: 'info', event, fields });
      },
      warn: (event, fields) => {
        events.push({ level: 'warn', event, fields });
      },
      error: (event, fields) => {
        events.push({ level: 'error', event, fields });
      },
    },
    events,
  };
};

interface VaultState {
  debt: bigint;
  /** Stale-price ratio, still used by the degraded fallback path. */
  ratio: bigint;
  /**
   * 8-decimal gold price at which this vault becomes liquidatable
   * (GoldVault.getLiquidationPrice). Compared against the live feed below.
   */
  liquidationPrice?: bigint;
  /** Principal (vaults().debtAmount); defaults to the debt. */
  principal?: bigint;
  /** This vault's collateral; defaults to ReadStubOptions.collateralAmount. */
  collateralAmount?: bigint;
}

interface ReadStubOptions {
  vaults: Partial<Record<Address, VaultState>>;
  pool?: Address;
  totalDeposits?: bigint;
  balance?: bigint;
  allowance?: bigint;
  /** Owner whose reads throw, to prove one failure does not abort the rest. */
  failFor?: Address;
  /** Live validated feed price (8 decimals). Defaults to a healthy $2000. */
  livePrice?: bigint;
  /** Vault collateral amount; 0 models a bad-debt vault. */
  collateralAmount?: bigint;
  /** Set false to model a dead feed and force the degraded fallback. */
  liveOk?: boolean;
  /** Collateral debt ceiling. 0 models a pre-ramp protocol with no exposure. */
  debtCeiling?: bigint;
  /** GoldVault.minDebt as the chain reports it; defaults to the deploy default of 100 GSUSD. */
  minDebt?: bigint;
  /** Make the minDebt read fail, as an unreachable RPC does. */
  minDebtUnreadable?: boolean;
  /** The first `remaining` totalDeposits reads fail, as a transient RPC error does. */
  totalDepositsFailures?: { remaining: number };
  /** collateralTypes().liquidationPenalty in ppm; defaults to 5%. */
  penaltyPpm?: bigint;
  /** Collateral token decimals as the token reports them. */
  decimals?: number;
  /** GoldVault.underwaterDiscountPpm; defaults to the deploy default of 2%. */
  underwaterDiscountPpm?: bigint;
  /** Make the underwaterDiscountPpm read revert. */
  discountUnreadable?: boolean;
  /** GoldOracle.paused(), the guardian's global emergencyPause. */
  oraclePaused?: boolean;
  /** GoldVault.paused(). */
  vaultPaused?: boolean;
  /**
   * GoldOracle.getLastKnownPrice. getEmergencyPrice never weighs it under variant C; set it
   * to prove the keeper never sizes at it either.
   */
  lastKnownPrice?: bigint;
  /** GoldOracle.tokenFrozen(token), set by the guardian or governance with freezeToken. */
  tokenFrozen?: boolean;
  /**
   * The liquidation rule gives no price (C or G unhealthy). getEmergencyPrice then reverts
   * "No price" even while paused: lastKnownPrice never prices a seizure.
   */
  rulesRefuse?: boolean;
  /** getEmergencyPrice while paused: the liquidation rule; defaults to the quoted price. */
  emergencyPrice?: bigint;
  /** GoldVault.collateralTypes(id).active; false models XAUT on a PAXG-first launch. */
  collateralActive?: boolean;
  /** Force getEmergencyPrice to revert with this reason. */
  emergencyPriceRevert?: string;
  /**
   * GoldOracle.quoteTokenPrice: min(max(C, G), G x (1 + m)). Defaults to the live primary
   * price, C sitting on gold.
   */
  quotePrice?: bigint;
  /** Make quoteTokenPrice revert with this reason ("No reliable price" and so on). */
  quoteRevert?: string;
  /** Make quoteTokenPrice fail as an unreachable RPC does, which is not a revert. */
  quoteUnreachable?: boolean;
  /** Model an oracle deployed before quoteTokenPrice existed: the call returns no data. */
  quoteMissing?: boolean;
  /** Counts quoteTokenPrice calls: one per token per tick while it stays current, more once outdated. */
  quoteCalls?: { count: number };
}

const createStubRead = (options: ReadStubOptions): KeeperReadClient => ({
  readContract: async ({ address, functionName, args }) => {
    const owner = args?.[0] as Address | undefined;
    switch (functionName) {
      case 'getVaultCurrentDebt': {
        if (owner !== undefined && owner === options.failFor) {
          throw new Error('rpc down');
        }
        return owner !== undefined ? options.vaults[owner]?.debt ?? 0n : 0n;
      }
      case 'getCollateralisationRatio':
        return owner !== undefined
          ? options.vaults[owner]?.ratio ?? 0n
          : 0n;
      case 'getLiquidationPrice': {
        if (owner === undefined) return 0n;
        const vault = options.vaults[owner];
        if (vault === undefined) return 0n;
        return (
          vault.liquidationPrice ??
          liquidationPriceForRatio(
            vault.ratio,
            options.livePrice ?? DEFAULT_LIVE_PRICE
          )
        );
      }
      case 'minDebt':
        if (options.minDebtUnreadable === true) throw new Error('minDebt read failed');
        return options.minDebt ?? 100n * 10n ** 18n;
      case 'underwaterDiscountPpm':
        if (options.discountUnreadable === true) {
          throw new Error('underwaterDiscountPpm reverted');
        }
        return options.underwaterDiscountPpm ?? 20_000n;
      case 'paused':
        if (address === ORACLE) return options.oraclePaused ?? false;
        if (address === VAULT) return options.vaultPaused ?? false;
        throw new Error(`Unexpected paused read on ${address}`);
      case 'tokenFrozen':
        return options.tokenFrozen ?? false;
      case 'getEmergencyPrice': {
        // GoldOracle.getEmergencyPrice: the vault or the oracle must be paused; then the
        // liquidation rule, or "No price" when it refuses.
        if (options.emergencyPriceRevert !== undefined) {
          throw new Error(`execution reverted: ${options.emergencyPriceRevert}`);
        }
        // Only a pause opens it; a frozen token outside one is stopped ("Token frozen").
        const pausedNow = args?.[1] === true || options.oraclePaused === true;
        if (!pausedNow) {
          throw new Error(
            `execution reverted: ${options.tokenFrozen === true ? 'Token frozen' : 'Not in emergency'}`
          );
        }
        if (options.rulesRefuse === true) throw new Error('execution reverted: No price');
        return options.emergencyPrice ?? options.quotePrice ?? options.livePrice ?? DEFAULT_LIVE_PRICE;
      }
      case 'decimals':
        return options.decimals ?? 18;
      case 'quoteTokenPrice': {
        // GoldOracle.quoteTokenPrice: the view twin of getTokenPrice, with its reverts.
        if (options.quoteCalls !== undefined) options.quoteCalls.count += 1;
        if (options.quoteUnreachable === true) throw new Error('fetch failed');
        if (options.quoteMissing === true) {
          throw new Error('The contract function "quoteTokenPrice" returned no data ("0x").');
        }
        if (options.quoteRevert !== undefined) {
          throw new Error(`execution reverted: ${options.quoteRevert}`);
        }
        if (options.oraclePaused === true) throw new Error('execution reverted: EnforcedPause');
        if (options.tokenFrozen === true) throw new Error('execution reverted: Token frozen');
        if (options.liveOk === false) throw new Error('execution reverted: No reliable price');
        return options.quotePrice ?? options.livePrice ?? DEFAULT_LIVE_PRICE;
      }
      case 'getValidatedPrice':
        return [
          options.livePrice ?? DEFAULT_LIVE_PRICE,
          options.liveOk ?? true,
        ];
      case 'vaults':
        return [
          PAXG,
          (owner !== undefined ? options.vaults[owner]?.collateralAmount : undefined) ??
            options.collateralAmount ??
            1_000_000_000_000_000_000n,
          owner !== undefined
            ? options.vaults[owner]?.principal ?? options.vaults[owner]?.debt ?? 0n
            : 0n,
        ];
      case 'collateralTypes':
        return [
          PAXG,
          1_200_000n,
          LIQUIDATION_RATIO,
          options.penaltyPpm ?? 50_000n,
          options.debtCeiling ?? 0n,
          0n,
          options.collateralActive ?? true,
        ];
      // Tripwires: transaction-target addresses are operator-pinned in
      // KeeperConfig and must NEVER be learned from the RPC. Any code path
      // that reads them again fails every test in this file.
      case 'stabilityPool':
        throw new Error('stabilityPool must come from config, not the RPC');
      case 'stablecoin':
        throw new Error('stablecoin must come from config, not the RPC');
      case 'totalDeposits':
        if (options.totalDepositsFailures !== undefined && options.totalDepositsFailures.remaining > 0) {
          options.totalDepositsFailures.remaining -= 1;
          throw new Error('fetch failed');
        }
        return options.totalDeposits ?? 0n;
      case 'balanceOf':
        return options.balance ?? 0n;
      case 'allowance':
        return options.allowance ?? 0n;
      default:
        throw new Error(`Unexpected read: ${functionName}`);
    }
  },
});

interface StubTx {
  tx: KeeperTxSender;
  sends: { address: Address; functionName: string; args: readonly unknown[] }[];
}

const createStubTx = (
  options: {
    /** Outcome of waitForReceipt; when set the stub sender supports waiting. */
    receiptStatus?: 'success' | 'reverted';
    /**
     * Receipt outcomes consumed one per wait, in order; 'throw' models a timed out or
     * unreadable receipt. Once exhausted, waits fall back to receiptStatus (or success).
     */
    receiptSequence?: ('success' | 'reverted' | 'throw')[];
    /** Function names whose send fails in simulation. */
    failing?: string[];
    /** How the approve(vault, 0) revoke fails: refused in simulation, or thrown. */
    revokeOutcome?: 'reject' | 'throw';
    /**
     * Model the production sender's pending-nonce guard: a send is refused (and recorded
     * as `refused:<name>`) while an earlier send has not had its receipt awaited.
     */
    refuseWhilePending?: boolean;
  } = {}
): StubTx => {
  const sends: StubTx['sends'] = [];
  let outstanding = false;
  const tx: KeeperTxSender = {
    account: KEEPER_ACCOUNT,
    simulateAndSend: async ({ address, functionName, args }) => {
      if (options.refuseWhilePending === true && outstanding) {
        sends.push({ address, functionName: `refused:${functionName}`, args });
        return { ok: false, reason: 'Keeper has a pending transaction or inconsistent nonce data' };
      }
      sends.push({ address, functionName, args });
      if (options.failing?.includes(functionName)) {
        return { ok: false, reason: `simulated revert in ${functionName}` };
      }
      const isRevoke = functionName === 'approve' && args[1] === 0n;
      if (isRevoke && options.revokeOutcome === 'reject') {
        return { ok: false, reason: 'simulated revert in revoke' };
      }
      if (isRevoke && options.revokeOutcome === 'throw') {
        throw new Error('revoke rpc down');
      }
      outstanding = true;
      return { ok: true, hash: TX_HASH };
    },
  };
  if (options.receiptStatus !== undefined || options.receiptSequence !== undefined) {
    const sequence = [...(options.receiptSequence ?? [])];
    tx.waitForReceipt = async (hash) => {
      outstanding = false;
      sends.push({ address: KEEPER_ACCOUNT, functionName: `wait:${hash}`, args: [] });
      const next = sequence.shift() ?? options.receiptStatus ?? 'success';
      if (next === 'throw') {
        throw new Error('receipt wait timed out');
      }
      return { status: next };
    };
  }
  return { tx, sends };
};

const createDeps = (
  read: KeeperReadClient,
  tx: KeeperTxSender | undefined,
  owners: Address[]
): { deps: KeeperJobDeps; events: LoggedEvent[] } => {
  const { log, events } = createStubLogger();
  return {
    deps: { read, tx, owners: { getOwners: async () => owners }, log },
    events,
  };
};

const eventNames = (events: LoggedEvent[]): string[] =>
  events.map((entry) => entry.event);

/**
 * The stub reader with a multicall shaped like the production adapter: a call that throws
 * comes back as a failure entry, never as a throw. `batches` records each batch's size.
 */
const withMulticall = (read: KeeperReadClient, batches: number[] = []): KeeperReadClient => ({
  readContract: read.readContract,
  readContracts: async (calls) => {
    batches.push(calls.length);
    return Promise.all(
      calls.map(async (call) => {
        try {
          return { status: 'success' as const, result: await read.readContract(call) };
        } catch (error) {
          return { status: 'failure' as const, error };
        }
      })
    );
  },
});

/**
 * A sender during whose receipt waits the market moves, as
 * both feeds do on chain while a keeper waits minutes for a receipt. quoteTokenPrice answers
 * `price` from the wait that follows a send of `during`, or from the first wait when omitted.
 * The allowance revoke, approve(vault, 0), is named 'approve-revoke' as the keeper logs it.
 */
const fallingWhileWaiting = (
  tx: KeeperTxSender,
  readOptions: ReadStubOptions,
  price: bigint,
  during?: string
): KeeperTxSender => {
  const wait = tx.waitForReceipt;
  if (wait === undefined) {
    throw new Error('the price moves only while the keeper waits for a receipt');
  }
  let lastSent = '';
  return {
    ...tx,
    simulateAndSend: async (call) => {
      lastSent =
        call.functionName === 'approve' && call.args[1] === 0n ? 'approve-revoke' : call.functionName;
      return tx.simulateAndSend(call);
    },
    waitForReceipt: async (hash) => {
      if (during === undefined || lastSent === during) readOptions.quotePrice = price;
      return wait(hash);
    },
  };
};

describe('runLiquidationWatch', () => {
  it('logs an honest empty-owner state and returns', async () => {
    const { deps, events } = createDeps(
      createStubRead({ vaults: {} }),
      undefined,
      []
    );

    await runLiquidationWatch(deps, baseConfig({ dryRun: true }));

    expect(eventNames(events)).toEqual(['vault.no-owners']);
  });

  it('emits no vault alert and sends nothing for a healthy vault', async () => {
    const { tx, sends } = createStubTx();
    const { deps, events } = createDeps(
      createStubRead({
        vaults: { [OWNER_A]: { debt: 100n, ratio: 1_500_000n } },
      }),
      tx,
      [OWNER_A]
    );

    await runLiquidationWatch(deps, baseConfig());

    // No vault-level alert of any kind. The readiness preflight
    // (keeper.no-liquidation-path) is expected here and asserted separately:
    // this fixture's pool is empty and direct is off, which is exactly the
    // unarmed launch-day state the preflight exists to surface.
    expect(
      eventNames(events).filter((name) => name.startsWith('vault.'))
    ).toEqual([]);
    expect(sends).toEqual([]);
  });

  it('warns keeper.no-liquidation-path when neither execution path is armed', async () => {
    const { tx } = createStubTx();
    const { deps, events } = createDeps(
      createStubRead({
        vaults: { [OWNER_A]: { debt: 100n, ratio: 1_500_000n } },
        // A ramped ceiling with an empty pool: real exposure, no armed path.
        debtCeiling: 250_000n,
      }),
      tx,
      [OWNER_A]
    );

    await runLiquidationWatch(deps, baseConfig());

    expect(eventNames(events)).toContain('keeper.no-liquidation-path');
  });

  it('stays silent about readiness in dry run, where watch-only is the point', async () => {
    const { deps, events } = createDeps(
      createStubRead({
        vaults: { [OWNER_A]: { debt: 100n, ratio: 1_500_000n } },
      }),
      undefined,
      [OWNER_A]
    );

    await runLiquidationWatch(deps, baseConfig({ dryRun: true }));

    expect(eventNames(events)).not.toContain('keeper.no-liquidation-path');
  });

  it('emits vault.liquidatable for an under-ratio vault', async () => {
    const { deps, events } = createDeps(
      createStubRead({
        vaults: { [OWNER_A]: { debt: 100n, ratio: 1_000_000n } },
      }),
      undefined,
      [OWNER_A]
    );

    await runLiquidationWatch(deps, baseConfig({ dryRun: true }));

    const alert = events.find(
      (entry) => entry.event === 'vault.liquidatable'
    );
    expect(alert).toBeDefined();
    expect(alert?.fields).toMatchObject({
      owner: OWNER_A,
      ratio: 1_000_000n,
      liquidationRatio: LIQUIDATION_RATIO,
      debt: 100n,
      collateralToken: PAXG,
    });
  });

  it('alerts on a vault the STALE ratio calls healthy but the live price does not', async () => {
    // The divergence between the stale and the live price. lastKnownPrice is 8% stale-high, so
    // getCollateralisationRatio reports 112.5% and the old gate stayed silent —
    // while GoldVault.liquidate, pricing off the live feed, would accept the
    // liquidation at 106.5%. The keeper must follow the contract, not the view.
    const { deps, events } = createDeps(
      createStubRead({
        vaults: {
          [OWNER_A]: {
            debt: 100n,
            ratio: 1_125_000n, // stale view: comfortably healthy
            liquidationPrice: (DEFAULT_LIVE_PRICE * 1035n) / 1000n, // live: under water
          },
        },
      }),
      undefined,
      [OWNER_A]
    );

    await runLiquidationWatch(deps, baseConfig());

    const alert = events.find((entry) => entry.event === 'vault.liquidatable');
    expect(alert).toBeDefined();
    expect(alert?.fields?.['priceSource']).toBe('quoteTokenPrice');
    // The reported ratio is the LIVE one, below the liquidation ratio — not the
    // stale 112.5% the view would have shown.
    expect(alert?.fields?.['ratio'] as bigint).toBeLessThan(LIQUIDATION_RATIO);
  });

  it('falls back to the stale ratio and says so when the RPC cannot be reached', async () => {
    const { deps, events } = createDeps(
      createStubRead({
        vaults: { [OWNER_A]: { debt: 100n, ratio: 1_000_000n } },
        quoteUnreachable: true,
      }),
      undefined,
      [OWNER_A]
    );

    await runLiquidationWatch(deps, baseConfig());

    // Still alerts (the stale ratio is under water) but flags the blindness.
    expect(eventNames(events)).toContain('vault.liquidatability-degraded');
    const alert = events.find((entry) => entry.event === 'vault.liquidatable');
    expect(alert?.fields?.['priceSource']).toBe('last-known');
  });

  it('sends nothing on the stale ratio when the RPC cannot quote, live and armed alike', async () => {
    const { tx, sends } = createStubTx();
    const { deps, events } = createDeps(
      createStubRead({
        vaults: { [OWNER_A]: { debt: 100n, ratio: 1_000_000n } },
        quoteUnreachable: true,
        totalDeposits: 10_000n * 10n ** 18n,
        balance: 5_000n * 10n ** 18n,
      }),
      tx,
      [OWNER_A]
    );

    await runLiquidationWatch(deps, baseConfig({ enableDirect: true }));

    expect(sends).toEqual([]);
    expect(eventNames(events)).toContain('vault.liquidatable');
    const degraded = events.find((entry) => entry.event === 'vault.liquidatability-degraded');
    expect(String(degraded?.fields?.['detail'])).toContain('only from quoteTokenPrice');
  });

  it('reports a debt-with-no-collateral vault as bad debt, not liquidatable', async () => {
    const { deps, events } = createDeps(
      createStubRead({
        vaults: { [OWNER_A]: { debt: 100n, ratio: 0n } },
        collateralAmount: 0n,
      }),
      undefined,
      [OWNER_A]
    );

    await runLiquidationWatch(deps, baseConfig());

    expect(eventNames(events)).toContain('vault.bad-debt');
    expect(eventNames(events)).not.toContain('vault.liquidatable');
  });

  it('sends nothing in dry run even when a tx sender exists', async () => {
    const { tx, sends } = createStubTx();
    const { deps, events } = createDeps(
      createStubRead({
        vaults: { [OWNER_A]: { debt: 100n, ratio: 1_000_000n } },
        pool: POOL,
        totalDeposits: 1_000n,
      }),
      tx,
      [OWNER_A]
    );

    await runLiquidationWatch(deps, baseConfig({ dryRun: true }));

    expect(sends).toEqual([]);
    const dryRun = events.find((entry) => entry.event === 'keeper.dry-run');
    expect(dryRun?.fields).toMatchObject({
      functionName: 'liquidateViaPool',
      to: VAULT,
    });
    expect(typeof dryRun?.fields?.['calldata']).toBe('string');
  });

  it('calls liquidateViaPool with [owner, 0n] when live and the pool is funded', async () => {
    const { tx, sends } = createStubTx({ receiptStatus: 'success' });
    const { deps, events } = createDeps(
      createStubRead({
        vaults: { [OWNER_A]: { debt: 100n, ratio: 1_000_000n } },
        pool: POOL,
        totalDeposits: 101n,
      }),
      tx,
      [OWNER_A]
    );

    await runLiquidationWatch(deps, baseConfig());

    expect(sends).toEqual([
      {
        address: VAULT,
        functionName: 'liquidateViaPool',
        args: [OWNER_A, 0n],
      },
      { address: KEEPER_ACCOUNT, functionName: `wait:${TX_HASH}`, args: [] },
    ]);
    expect(eventNames(events)).toContain('vault.liquidated-via-pool');
  });

  it('absorbs what the pool can when it cannot cover the full debt (partial fill)', async () => {
    // Previously all-or-nothing: a pool equal to (or just under) the debt did
    // NOTHING, wasting capital that could legally absorb totalDeposits-1.
    const { tx, sends } = createStubTx();
    const debt = 13_000n * 10n ** 18n;
    const { deps, events } = createDeps(
      createStubRead({
        vaults: { [OWNER_A]: { debt, ratio: 1_000_000n } },
        pool: POOL,
        totalDeposits: 10_000n * 10n ** 18n,
        // 7 PAXG at $2000 covers 13,000 of debt plus the 5% penalty, so a partial is legal.
        collateralAmount: 7n * 10n ** 18n,
      }),
      tx,
      [OWNER_A]
    );

    await runLiquidationWatch(deps, baseConfig());

    // totalDeposits - 1, satisfying absorbLiquidationPrefunded's strict inequality, and well
    // inside the partial that keeps MIN_DEBT of principal behind.
    expect(sends).toEqual([
      {
        address: VAULT,
        functionName: 'liquidateViaPool',
        args: [OWNER_A, 10_000n * 10n ** 18n - 1n],
      },
    ]);
    expect(eventNames(events)).toContain('vault.partial-pool-absorb');
  });

  it('passes 0 (full debt) when the pool comfortably covers the position', async () => {
    const { tx, sends } = createStubTx();
    const { deps } = createDeps(
      createStubRead({
        vaults: { [OWNER_A]: { debt: 100n, ratio: 1_000_000n } },
        pool: POOL,
        totalDeposits: 1_000n,
      }),
      tx,
      [OWNER_A]
    );

    await runLiquidationWatch(deps, baseConfig());

    expect(sends).toEqual([
      { address: VAULT, functionName: 'liquidateViaPool', args: [OWNER_A, 0n] },
    ]);
  });

  it('reports the pool underfunded and falls through when it is EMPTY', async () => {
    const { tx, sends } = createStubTx();
    const { deps, events } = createDeps(
      createStubRead({
        vaults: { [OWNER_A]: { debt: 100n, ratio: 1_000_000n } },
        pool: POOL,
        totalDeposits: 0n,
      }),
      tx,
      [OWNER_A]
    );

    await runLiquidationWatch(deps, baseConfig());

    expect(sends).toEqual([]);
    const underfunded = events.find(
      (entry) => entry.event === 'vault.pool-underfunded'
    );
    expect(underfunded?.fields).toMatchObject({
      owner: OWNER_A,
      debt: 100n,
      totalDeposits: 0n,
    });
  });

  it('does not direct-liquidate when KEEPER_ENABLE_DIRECT is off', async () => {
    const { tx, sends } = createStubTx();
    const { deps } = createDeps(
      createStubRead({
        vaults: { [OWNER_A]: { debt: 100n, ratio: 1_000_000n } },
        pool: POOL,
        // Empty pool: the direct fallback is the path under test here.
        totalDeposits: 0n,
        balance: 1_000n,
        allowance: 1_000n,
      }),
      tx,
      [OWNER_A]
    );

    await runLiquidationWatch(deps, baseConfig({ enableDirect: false }));

    expect(sends).toEqual([]);
  });

  it('direct-liquidates only when enabled AND the wallet holds enough GSUSD', async () => {
    const { tx, sends } = createStubTx();
    const { deps } = createDeps(
      createStubRead({
        vaults: { [OWNER_A]: { debt: 100n, ratio: 1_000_000n } },
        pool: POOL,
        // Empty pool: the direct fallback is the path under test here.
        totalDeposits: 0n,
        balance: 1_000n,
        allowance: 0n,
      }),
      tx,
      [OWNER_A]
    );

    await runLiquidationWatch(deps, baseConfig({ enableDirect: true }));

    // The allowance carries 1% headroom plus a wei: liquidate(owner, 0) pulls the
    // debt as it stands at inclusion, which is above the figure read now.
    expect(sends).toEqual([
      { address: GSUSD, functionName: 'approve', args: [VAULT, 102n] },
      { address: VAULT, functionName: 'liquidate', args: [OWNER_A, 0n] },
    ]);
  });

  it('waits for the approval to mine before simulating the liquidation', async () => {
    const { tx, sends } = createStubTx({ receiptStatus: 'success' });
    const { deps } = createDeps(
      createStubRead({
        vaults: { [OWNER_A]: { debt: 100n, ratio: 1_000_000n } },
        pool: POOL,
        totalDeposits: 0n,
        balance: 1_000n,
        allowance: 0n,
      }),
      tx,
      [OWNER_A]
    );

    await runLiquidationWatch(deps, baseConfig({ enableDirect: true }));

    expect(sends.map((entry) => entry.functionName)).toEqual([
      'approve',
      `wait:${TX_HASH}`,
      'liquidate',
      `wait:${TX_HASH}`,
    ]);
  });

  it('stops when the approval reverts instead of liquidating against a stale allowance', async () => {
    const { tx, sends } = createStubTx({ receiptStatus: 'reverted' });
    const { deps, events } = createDeps(
      createStubRead({
        vaults: { [OWNER_A]: { debt: 100n, ratio: 1_000_000n } },
        pool: POOL,
        totalDeposits: 0n,
        balance: 1_000n,
        allowance: 0n,
      }),
      tx,
      [OWNER_A]
    );

    await runLiquidationWatch(deps, baseConfig({ enableDirect: true }));

    expect(sends.map((entry) => entry.functionName)).toEqual(['approve', `wait:${TX_HASH}`]);
    expect(eventNames(events)).toContain('keeper.approval-reverted');
  });

  it('treats a dust pool as underfunded rather than absorbing a wei per tick', async () => {
    const { tx, sends } = createStubTx();
    const { deps, events } = createDeps(
      createStubRead({
        vaults: { [OWNER_A]: { debt: 13_000n * 10n ** 18n, ratio: 1_000_000n } },
        pool: POOL,
        totalDeposits: 2n,
        collateralAmount: 7n * 10n ** 18n,
        balance: 20_000n * 10n ** 18n,
        allowance: 20_000n * 10n ** 18n,
      }),
      tx,
      [OWNER_A]
    );

    await runLiquidationWatch(deps, baseConfig({ enableDirect: true }));

    expect(sends).toEqual([
      { address: VAULT, functionName: 'liquidate', args: [OWNER_A, 0n] },
    ]);
    expect(eventNames(events)).toContain('vault.pool-underfunded');
  });

  it('sizes a partial pool absorb so the vault keeps MIN_DEBT of principal', async () => {
    const { tx, sends } = createStubTx();
    const debt = 300n * 10n ** 18n;
    const { deps } = createDeps(
      createStubRead({
        vaults: { [OWNER_A]: { debt, principal: debt, ratio: 1_000_000n } },
        pool: POOL,
        totalDeposits: 250n * 10n ** 18n,
      }),
      tx,
      [OWNER_A]
    );

    await runLiquidationWatch(deps, baseConfig());

    // The pool could absorb 250, but 200 is the most that leaves 100 of principal.
    expect(sends).toEqual([
      { address: VAULT, functionName: 'liquidateViaPool', args: [OWNER_A, 200n * 10n ** 18n] },
    ]);
  });

  it('falls through to the direct path when the pool attempt fails', async () => {
    const { tx, sends } = createStubTx({ failing: ['liquidateViaPool'] });
    const { deps, events } = createDeps(
      createStubRead({
        vaults: { [OWNER_A]: { debt: 100n, ratio: 1_000_000n } },
        pool: POOL,
        totalDeposits: 1_000n,
        balance: 1_000n,
        allowance: 1_000n,
      }),
      tx,
      [OWNER_A]
    );

    await runLiquidationWatch(deps, baseConfig({ enableDirect: true }));

    expect(sends.map((entry) => entry.functionName)).toEqual(['liquidateViaPool', 'liquidate']);
    expect(eventNames(events)).toContain('keeper.tx-failed');
  });

  it('reads debts in batches and skips owners without debt when the client can multicall', async () => {
    const { tx, sends } = createStubTx();
    const base = createStubRead({
      vaults: {
        [OWNER_A]: { debt: 0n, ratio: 2_000_000n },
        [OWNER_B]: { debt: 100n, ratio: 1_000_000n },
      },
      pool: POOL,
      totalDeposits: 1_000n,
    });
    const sequentialDebtReads: Address[] = [];
    const batches: number[] = [];
    const read: KeeperReadClient = {
      readContract: async (args) => {
        if (args.functionName === 'getVaultCurrentDebt') {
          sequentialDebtReads.push(args.args?.[0] as Address);
        }
        return base.readContract(args);
      },
      readContracts: async (calls) => {
        batches.push(calls.length);
        return Promise.all(
          calls.map(async (call) => ({
            status: 'success' as const,
            result: await base.readContract(call),
          }))
        );
      },
    };
    const { deps, events } = createDeps(read, tx, [OWNER_A, OWNER_B]);

    await runLiquidationWatch(deps, baseConfig());

    // The debt batch for both owners, then the screen batch (vaults and getLiquidationPrice)
    // for the one owner with debt.
    expect(batches).toEqual([2, 2]);
    expect(sequentialDebtReads).toEqual([]);
    expect(sends).toEqual([
      { address: VAULT, functionName: 'liquidateViaPool', args: [OWNER_B, 0n] },
    ]);
    const sweep = events.find((entry) => entry.event === 'vault.owner-sweep');
    expect(sweep?.fields).toMatchObject({ owners: 2, read: 2, withDebt: 1 });
  });

  it('skips the direct fallback when the wallet is unfunded', async () => {
    const { tx, sends } = createStubTx();
    const { deps } = createDeps(
      createStubRead({
        vaults: { [OWNER_A]: { debt: 100n, ratio: 1_000_000n } },
        pool: POOL,
        // Empty pool: the direct fallback is the path under test here.
        totalDeposits: 0n,
        balance: 99n,
      }),
      tx,
      [OWNER_A]
    );

    await runLiquidationWatch(deps, baseConfig({ enableDirect: true }));

    expect(sends).toEqual([]);
  });

  it('continues to the next owner when one owner read fails', async () => {
    const { tx, sends } = createStubTx();
    const { deps, events } = createDeps(
      createStubRead({
        vaults: { [OWNER_B]: { debt: 100n, ratio: 1_000_000n } },
        pool: POOL,
        totalDeposits: 200n,
        failFor: OWNER_A,
      }),
      tx,
      [OWNER_A, OWNER_B]
    );

    await runLiquidationWatch(deps, baseConfig());

    const names = eventNames(events);
    expect(names).toContain('keeper.job-error');
    expect(names).toContain('vault.liquidatable');
    expect(sends).toEqual([
      {
        address: VAULT,
        functionName: 'liquidateViaPool',
        args: [OWNER_B, 0n],
      },
    ]);
  });

  it('never throws when the owner source itself fails', async () => {
    const { log, events } = createStubLogger();
    const deps: KeeperJobDeps = {
      read: createStubRead({ vaults: {} }),
      tx: undefined,
      owners: {
        getOwners: async () => {
          throw new Error('redis down');
        },
      },
      log,
    };

    await expect(
      runLiquidationWatch(deps, baseConfig({ dryRun: true }))
    ).resolves.toBeUndefined();
    expect(eventNames(events)).toContain('keeper.job-error');
  });

  it('keeps walking when one multicall chunk fails and still alerts the vault in another chunk', async () => {
    const owners = Array.from({ length: 250 }, (_, index) =>
      getAddress(`0x${(0x2000 + index).toString(16).padStart(40, '0')}`)
    );
    const victim = owners[3];
    if (victim === undefined) throw new Error('fixture');
    const base = createStubRead({
      vaults: { [victim]: { debt: 800n * 10n ** 18n, ratio: 1_000_000n } },
      totalDeposits: 1_000n * 10n ** 18n,
    });
    let batchCalls = 0;
    const read: KeeperReadClient = {
      readContract: base.readContract,
      readContracts: async (calls) => {
        batchCalls++;
        // The second chunk fails on both attempts.
        if (calls.length === 50) throw new Error('HTTP 429 from provider');
        return Promise.all(
          calls.map(async (call) => ({
            status: 'success' as const,
            result: await base.readContract(call),
          }))
        );
      },
    };
    const { tx, sends } = createStubTx();
    const { deps, events } = createDeps(read, tx, owners);

    await runLiquidationWatch(deps, baseConfig());

    // Two debt chunks, the second tried twice, then one screen batch for the indebted victim.
    expect(batchCalls).toBe(4);
    expect(eventNames(events)).toContain('vault.liquidatable');
    expect(sends.map((entry) => entry.functionName)).toEqual(['liquidateViaPool']);
    const sweep = events.find((entry) => entry.event === 'vault.owner-sweep');
    expect(sweep?.fields).toMatchObject({ owners: 250, read: 250, withDebt: 1, unread: 0 });
    expect(eventNames(events)).not.toContain('vault.owners-unread');
  });

  it('names the owners it could not read after the retry and single reads', async () => {
    const owners = Array.from({ length: 201 }, (_, index) =>
      getAddress(`0x${(0x3000 + index).toString(16).padStart(40, '0')}`)
    );
    const unreadable = owners[200];
    if (unreadable === undefined) throw new Error('fixture');
    const base = createStubRead({ vaults: {}, failFor: unreadable });
    const read: KeeperReadClient = {
      readContract: base.readContract,
      readContracts: async (calls) => {
        if (calls.length === 1) throw new Error('provider timeout');
        return calls.map(() => ({ status: 'success' as const, result: 0n }));
      },
    };
    const { deps, events } = createDeps(read, undefined, owners);

    await runLiquidationWatch(deps, baseConfig({ dryRun: true }));

    const unread = events.filter((entry) => entry.event === 'vault.owners-unread');
    expect(unread).toHaveLength(1);
    expect(unread[0]?.fields).toMatchObject({ count: 1, owners: [unreadable] });
    expect(events.filter((entry) => entry.event === 'keeper.job-error' && entry.fields?.['owner'])).toEqual([]);
  });

  it('never sizes several pool sends against one stale pool balance', async () => {
    const debt = 800n * 10n ** 18n;
    const pool = 1_000n * 10n ** 18n;
    const owners = [OWNER_A, OWNER_B, KEEPER_ACCOUNT];
    const read = createStubRead({
      vaults: Object.fromEntries(owners.map((owner) => [owner, { debt, ratio: 1_000_000n }])),
      totalDeposits: pool,
    });
    const { tx, sends } = createStubTx();
    const { deps } = createDeps(read, tx, owners);

    await runLiquidationWatch(deps, baseConfig());

    const poolSends = sends.filter((entry) => entry.functionName === 'liquidateViaPool');
    const committed = poolSends.reduce(
      (sum, entry) => sum + ((entry.args[1] as bigint) === 0n ? debt : (entry.args[1] as bigint)),
      0n
    );
    expect(poolSends.length).toBeLessThan(3);
    expect(committed).toBeLessThan(pool);
    expect(poolSends[0]?.args).toEqual([OWNER_A, 0n]);
  });

  it('waits for each pool receipt before sizing the next vault when the sender can', async () => {
    const debt = 100n * 10n ** 18n;
    const read = createStubRead({
      vaults: {
        [OWNER_A]: { debt, ratio: 1_000_000n },
        [OWNER_B]: { debt, ratio: 1_000_000n },
      },
      totalDeposits: 10_000n * 10n ** 18n,
    });
    const { tx, sends } = createStubTx({ receiptStatus: 'success' });
    const { deps } = createDeps(read, tx, [OWNER_A, OWNER_B]);

    await runLiquidationWatch(deps, baseConfig());

    expect(sends.map((entry) => entry.functionName)).toEqual([
      'liquidateViaPool',
      `wait:${TX_HASH}`,
      'liquidateViaPool',
      `wait:${TX_HASH}`,
    ]);
  });

  it('liquidates a thin but solvent vault in full when the pool covers it', async () => {
    // 1 PAXG at $2000 against 1,950 GSUSD of debt: value 2,000 < 1,950 * 1.05 = 2,047.5,
    // so the penalty no longer fits, but the gold still covers the debt.
    const debt = 1_950n * 10n ** 18n;
    const read = createStubRead({
      vaults: { [OWNER_A]: { debt, ratio: 1_025_000n } },
      totalDeposits: 3_000n * 10n ** 18n,
    });
    const { tx, sends } = createStubTx();
    const { deps, events } = createDeps(read, tx, [OWNER_A]);

    await runLiquidationWatch(deps, baseConfig());

    expect(sends).toEqual([
      { address: VAULT, functionName: 'liquidateViaPool', args: [OWNER_A, 0n] },
    ]);
    const alert = events.find((entry) => entry.event === 'vault.liquidatable');
    expect(alert?.fields).toMatchObject({ thinVault: true, fullLiquidationRequired: false });
  });

  it('absorbs a pro-rata partial from a thin solvent vault larger than the pool', async () => {
    // GoldVault._sizeSeizure takes a thin solvent partial pro rata,
    // so a pool smaller than the vault works it down instead of refusing it.
    const debt = 1_950n * 10n ** 18n;
    const read = createStubRead({
      vaults: { [OWNER_A]: { debt, ratio: 1_025_000n } },
      totalDeposits: 1_000n * 10n ** 18n,
      balance: 3_000n * 10n ** 18n,
      allowance: 3_000n * 10n ** 18n,
    });
    const { tx, sends } = createStubTx();
    const { deps, events } = createDeps(read, tx, [OWNER_A]);

    await runLiquidationWatch(deps, baseConfig({ enableDirect: true }));

    expect(sends).toEqual([
      { address: VAULT, functionName: 'liquidateViaPool', args: [OWNER_A, 1_000n * 10n ** 18n - 1n] },
    ]);
    expect(eventNames(events)).toContain('vault.partial-pool-absorb');
    expect(eventNames(events)).not.toContain('vault.full-liquidation-required');
  });

  it('keeps the residual principal of a thin partial at minDebt or above', async () => {
    // 1 PAXG at $2000 against 1,950 GSUSD with a 1,900 pool: the partial is capped so
    // 1,950 * (1 - x / 1,950) of principal stays at the 100 GSUSD minimum.
    const debt = 1_950n * 10n ** 18n;
    const read = createStubRead({
      vaults: { [OWNER_A]: { debt, ratio: 1_025_000n } },
      totalDeposits: 1_900n * 10n ** 18n,
    });
    const { tx, sends } = createStubTx();
    const { deps } = createDeps(read, tx, [OWNER_A]);

    await runLiquidationWatch(deps, baseConfig());

    expect(sends).toEqual([
      { address: VAULT, functionName: 'liquidateViaPool', args: [OWNER_A, 1_850n * 10n ** 18n] },
    ]);
  });

  it('still refuses a partial for an underwater vault and prefers the direct path', async () => {
    // 1 PAXG at $2000 against 2,100 GSUSD: the gold no longer covers the debt.
    const debt = 2_100n * 10n ** 18n;
    const read = createStubRead({
      vaults: { [OWNER_A]: { debt, ratio: 952_380n } },
      totalDeposits: 1_000n * 10n ** 18n,
      balance: 3_000n * 10n ** 18n,
      allowance: 3_000n * 10n ** 18n,
    });
    const { tx, sends } = createStubTx();
    const { deps, events } = createDeps(read, tx, [OWNER_A]);

    await runLiquidationWatch(deps, baseConfig({ enableDirect: true }));

    expect(sends).toEqual([{ address: VAULT, functionName: 'liquidate', args: [OWNER_A, 0n] }]);
    expect(eventNames(events)).toContain('vault.full-liquidation-required');
    expect(eventNames(events)).not.toContain('vault.partial-pool-absorb');
    expect(events.find((entry) => entry.event === 'vault.liquidatable')?.fields).toMatchObject({
      fullLiquidationRequired: true,
    });
  });

  it('still absorbs a partial while the penalty fits', async () => {
    // 1 PAXG at $2000 against 1,850 GSUSD: value 2,000 >= 1,850 * 1.05 = 1,942.5.
    const debt = 1_850n * 10n ** 18n;
    const read = createStubRead({
      vaults: { [OWNER_A]: { debt, ratio: 1_081_000n } },
      totalDeposits: 1_000n * 10n ** 18n,
    });
    const { tx, sends } = createStubTx();
    const { deps } = createDeps(read, tx, [OWNER_A]);

    await runLiquidationWatch(deps, baseConfig());

    expect(sends).toEqual([
      { address: VAULT, functionName: 'liquidateViaPool', args: [OWNER_A, 1_000n * 10n ** 18n - 1n] },
    ]);
  });

  it('normalises six-decimal collateral before judging the vault underwater', async () => {
    // 1 XAUT (1e6 units) at $2000 against 1,950 GSUSD: thin but solvent, as the PAXG
    // case. Read as 18 decimals the gold would be worth nothing and the partial refused.
    const debt = 1_950n * 10n ** 18n;
    const read = createStubRead({
      vaults: { [OWNER_A]: { debt, ratio: 1_025_000n } },
      totalDeposits: 1_000n * 10n ** 18n,
      collateralAmount: 1_000_000n,
      decimals: 6,
    });
    const { tx, sends } = createStubTx();
    const { deps } = createDeps(read, tx, [OWNER_A]);

    await runLiquidationWatch(deps, baseConfig());

    expect(sends).toEqual([
      { address: VAULT, functionName: 'liquidateViaPool', args: [OWNER_A, 1_000n * 10n ** 18n - 1n] },
    ]);
  });
});

describe('runLiquidationWatch receipts', () => {
  /**
   * Two thin but solvent vaults: 1 PAXG at $2000 against 1,950 GSUSD each. A 2,000 pool
   * covers one in full; what it has left for the other is under minDebt.
   */
  const THIN_DEBT = 1_950n * 10n ** 18n;
  const thinVaults = {
    [OWNER_A]: { debt: THIN_DEBT, ratio: 1_025_000n },
    [OWNER_B]: { debt: THIN_DEBT, ratio: 1_025_000n },
  };

  it('reports success only after the pool receipt confirms it', async () => {
    const { tx } = createStubTx({ receiptStatus: 'reverted' });
    const { deps, events } = createDeps(
      createStubRead({ vaults: { [OWNER_A]: { debt: 100n, ratio: 1_000_000n } }, totalDeposits: 1_000n }),
      tx,
      [OWNER_A]
    );

    await runLiquidationWatch(deps, baseConfig());

    expect(eventNames(events)).not.toContain('vault.liquidated-via-pool');
    const failure = events.find(
      (entry) => entry.event === 'keeper.tx-failed' && entry.fields?.functionName === 'liquidateViaPool'
    );
    expect(failure?.fields).toMatchObject({ hash: TX_HASH });
  });

  it('runs the direct fallback when the pool liquidation reverts on chain', async () => {
    const { tx, sends } = createStubTx({ receiptSequence: ['reverted', 'success'] });
    const { deps, events } = createDeps(
      createStubRead({
        vaults: { [OWNER_A]: { debt: 100n, ratio: 1_000_000n } },
        totalDeposits: 1_000n,
        balance: 1_000n,
        allowance: 1_000n,
      }),
      tx,
      [OWNER_A]
    );

    await runLiquidationWatch(deps, baseConfig({ enableDirect: true }));

    expect(sends.map((entry) => entry.functionName)).toEqual([
      'liquidateViaPool',
      `wait:${TX_HASH}`,
      'liquidate',
      `wait:${TX_HASH}`,
    ]);
    expect(eventNames(events)).not.toContain('vault.liquidated-via-pool');
  });

  it('sizes the next vault against pool capacity a reverted send never spent', async () => {
    const { tx, sends } = createStubTx({ receiptSequence: ['reverted', 'success'] });
    const { deps, events } = createDeps(
      createStubRead({ vaults: thinVaults, totalDeposits: 2_000n * 10n ** 18n }),
      tx,
      [OWNER_A, OWNER_B]
    );

    await runLiquidationWatch(deps, baseConfig());

    expect(sends.filter((entry) => entry.functionName === 'liquidateViaPool')).toEqual([
      { address: VAULT, functionName: 'liquidateViaPool', args: [OWNER_A, 0n] },
      { address: VAULT, functionName: 'liquidateViaPool', args: [OWNER_B, 0n] },
    ]);
    expect(eventNames(events)).not.toContain('vault.full-liquidation-required');
    const successes = events.filter((entry) => entry.event === 'vault.liquidated-via-pool');
    expect(successes.map((entry) => entry.fields?.owner)).toEqual([OWNER_B]);
  });

  it('keeps a pending commitment and runs no competing direct liquidation when the receipt is unreadable', async () => {
    const { tx, sends } = createStubTx({ receiptSequence: ['throw'] });
    const { deps, events } = createDeps(
      createStubRead({
        vaults: thinVaults,
        // The pool read stays at its pre-send figure: a lagging RPC.
        totalDeposits: 2_000n * 10n ** 18n,
        balance: 10_000n * 10n ** 18n,
        allowance: 10_000n * 10n ** 18n,
      }),
      tx,
      [OWNER_A, OWNER_B]
    );

    await runLiquidationWatch(deps, baseConfig({ enableDirect: true }));

    const poolSends = sends.filter((entry) => entry.functionName === 'liquidateViaPool');
    expect(poolSends).toEqual([
      { address: VAULT, functionName: 'liquidateViaPool', args: [OWNER_A, 0n] },
    ]);
    const directForA = sends.filter(
      (entry) => entry.functionName === 'liquidate' && entry.args[0] === OWNER_A
    );
    expect(directForA).toEqual([]);
    const unknown = events.find((entry) => entry.event === 'keeper.tx-outcome-unknown');
    expect(unknown?.level).toBe('error');
    expect(unknown?.fields).toMatchObject({
      owner: OWNER_A,
      functionName: 'liquidateViaPool',
      hash: TX_HASH,
    });
    expect(eventNames(events)).not.toContain('vault.liquidated-via-pool');
    expect(eventNames(events)).not.toContain('keeper.job-error');
    // The second vault is held back by the pending commitment, not sized against stale
    // funds: 2,000 less the 1,950 committed leaves 50, under the 100 GSUSD minimum partial.
    const held = events.find((entry) => entry.event === 'vault.pool-underfunded');
    expect(held?.fields).toMatchObject({ owner: OWNER_B });
  });

  const directDeps = (txOptions: Parameters<typeof createStubTx>[0]) => {
    const stub = createStubTx(txOptions);
    const { deps, events } = createDeps(
      createStubRead({
        vaults: { [OWNER_A]: { debt: 800n * 10n ** 18n, ratio: 1_000_000n } },
        totalDeposits: 0n,
        balance: 1_000n * 10n ** 18n,
        allowance: 0n,
      }),
      stub.tx,
      [OWNER_A]
    );
    return { ...stub, deps, events };
  };

  it('waits for a direct liquidation receipt and leaves the allowance on success', async () => {
    const { deps, events, sends } = directDeps({ receiptSequence: ['success', 'success'] });

    await runLiquidationWatch(deps, baseConfig({ enableDirect: true }));

    expect(sends.map((entry) => entry.functionName)).toEqual([
      'approve',
      `wait:${TX_HASH}`,
      'liquidate',
      `wait:${TX_HASH}`,
    ]);
    expect(eventNames(events)).not.toContain('keeper.tx-failed');
  });

  it('reports a mined direct liquidation revert and revokes the fresh allowance', async () => {
    const { deps, events, sends } = directDeps({ receiptSequence: ['success', 'reverted'] });

    await runLiquidationWatch(deps, baseConfig({ enableDirect: true }));

    expect(sends.map((entry) => entry.functionName)).toEqual([
      'approve',
      `wait:${TX_HASH}`,
      'liquidate',
      `wait:${TX_HASH}`,
      'approve',
      `wait:${TX_HASH}`,
    ]);
    expect(sends[4]?.args).toEqual([VAULT, 0n]);
    const failure = events.find(
      (entry) => entry.event === 'keeper.tx-failed' && entry.fields?.functionName === 'liquidate'
    );
    expect(failure?.fields).toMatchObject({ owner: OWNER_A, hash: TX_HASH });
  });

  it('waits for the revoke to mine so the next vault of the tick is not refused', async () => {
    const { tx, sends } = createStubTx({
      // A: approve mines, the liquidation reverts on chain, the revoke mines. B: all mine.
      receiptSequence: ['success', 'reverted', 'success', 'success', 'success'],
      refuseWhilePending: true,
    });
    const { deps, events } = createDeps(
      createStubRead({
        vaults: {
          [OWNER_A]: { debt: 800n * 10n ** 18n, ratio: 1_000_000n },
          [OWNER_B]: { debt: 800n * 10n ** 18n, ratio: 1_000_000n },
        },
        totalDeposits: 0n,
        balance: 10_000n * 10n ** 18n,
        allowance: 0n,
      }),
      tx,
      [OWNER_A, OWNER_B]
    );

    await runLiquidationWatch(deps, baseConfig({ enableDirect: true }));

    const names = sends.map((entry) => entry.functionName);
    expect(names.filter((name) => name.startsWith('refused:'))).toEqual([]);
    expect(names).toEqual([
      'approve',
      `wait:${TX_HASH}`,
      'liquidate',
      `wait:${TX_HASH}`,
      'approve',
      `wait:${TX_HASH}`,
      'approve',
      `wait:${TX_HASH}`,
      'liquidate',
      `wait:${TX_HASH}`,
    ]);
    expect(sends[8]?.args).toEqual([OWNER_B, 0n]);
    expect(eventNames(events)).not.toContain('keeper.job-error');
  });

  it('logs a revoke that reverts on chain, with its hash', async () => {
    const { deps, events } = directDeps({ receiptSequence: ['success', 'reverted', 'reverted'] });

    await runLiquidationWatch(deps, baseConfig({ enableDirect: true }));

    const revokeFailure = events.find(
      (entry) => entry.event === 'keeper.tx-failed' && entry.fields?.functionName === 'approve-revoke'
    );
    expect(revokeFailure?.fields).toMatchObject({ owner: OWNER_A, hash: TX_HASH });
  });

  it('reports an unreadable revoke receipt as an unknown outcome', async () => {
    const { deps, events } = directDeps({ receiptSequence: ['success', 'reverted', 'throw'] });

    await runLiquidationWatch(deps, baseConfig({ enableDirect: true }));

    const unknown = events.find(
      (entry) => entry.event === 'keeper.tx-outcome-unknown' && entry.fields?.functionName === 'approve-revoke'
    );
    expect(unknown?.fields).toMatchObject({ owner: OWNER_A, hash: TX_HASH });
    expect(eventNames(events)).not.toContain('keeper.job-error');
  });

  it('treats an unreadable direct liquidation receipt as an unknown outcome', async () => {
    const { deps, events, sends } = directDeps({ receiptSequence: ['success', 'throw'] });

    await runLiquidationWatch(deps, baseConfig({ enableDirect: true }));

    // No revoke: the liquidation may still mine and needs the allowance to do so.
    expect(sends.map((entry) => entry.functionName)).toEqual([
      'approve',
      `wait:${TX_HASH}`,
      'liquidate',
      `wait:${TX_HASH}`,
    ]);
    const unknown = events.find((entry) => entry.event === 'keeper.tx-outcome-unknown');
    expect(unknown?.fields).toMatchObject({ owner: OWNER_A, functionName: 'liquidate', hash: TX_HASH });
    expect(eventNames(events)).not.toContain('keeper.job-error');
  });

  it.each(['reject', 'throw'] as const)(
    'logs a revoke that fails (%s) after a mined revert without aborting the tick',
    async (revokeOutcome) => {
      const { deps, events } = directDeps({ receiptSequence: ['success', 'reverted'], revokeOutcome });

      await runLiquidationWatch(deps, baseConfig({ enableDirect: true }));

      const revokeFailure = events.find(
        (entry) => entry.event === 'keeper.tx-failed' && entry.fields?.functionName === 'approve-revoke'
      );
      expect(revokeFailure?.fields).toMatchObject({ owner: OWNER_A });
      expect(eventNames(events)).not.toContain('keeper.job-error');
    }
  );
});

describe('runLiquidationWatch residual after a partial pool fill', () => {
  // 7 PAXG at $2000 against 13,000 GSUSD: the 10,000 pool absorbs all but one wei of
  // itself and leaves the rest of the debt behind.
  const DEBT = 13_000n * 10n ** 18n;
  const ABSORBED = 10_000n * 10n ** 18n - 1n;
  const RESIDUAL = DEBT - ABSORBED;

  /**
   * The chain shows `after` for OWNER_A once the pool send has gone out, and `afterCollateral`
   * as its collateral when given (a partial fill shrinks the collateral as well as the debt).
   */
  const setup = (
    after: VaultState,
    txOptions: Parameters<typeof createStubTx>[0] = { receiptStatus: 'success' },
    readOverrides: Partial<ReadStubOptions> = {},
    afterCollateral?: bigint
  ) => {
    const vaults: Partial<Record<Address, VaultState>> = {
      [OWNER_A]: { debt: DEBT, ratio: 1_000_000n },
    };
    const readOptions: ReadStubOptions = {
      vaults,
      totalDeposits: 10_000n * 10n ** 18n,
      collateralAmount: 7n * 10n ** 18n,
      balance: 20_000n * 10n ** 18n,
      allowance: 20_000n * 10n ** 18n,
      ...readOverrides,
    };
    const stub = createStubTx(txOptions);
    const tx: KeeperTxSender = {
      ...stub.tx,
      simulateAndSend: async (call) => {
        const result = await stub.tx.simulateAndSend(call);
        if (call.functionName === 'liquidateViaPool') {
          vaults[OWNER_A] = after;
          if (afterCollateral !== undefined) readOptions.collateralAmount = afterCollateral;
        }
        return result;
      },
    };
    const { deps, events } = createDeps(createStubRead(readOptions), tx, [OWNER_A]);
    return { deps, events, sends: stub.sends, readOptions, tx };
  };

  it('liquidates the residual from the keeper wallet in the same tick while the vault is still liquidatable', async () => {
    const { deps, sends } = setup({ debt: RESIDUAL, ratio: 1_000_000n });

    await runLiquidationWatch(deps, baseConfig({ enableDirect: true }));

    expect(sends).toEqual([
      { address: VAULT, functionName: 'liquidateViaPool', args: [OWNER_A, ABSORBED] },
      { address: KEEPER_ACCOUNT, functionName: `wait:${TX_HASH}`, args: [] },
      { address: VAULT, functionName: 'liquidate', args: [OWNER_A, 0n] },
      { address: KEEPER_ACCOUNT, functionName: `wait:${TX_HASH}`, args: [] },
    ]);
  });

  it('leaves a vault the partial fill restored to health alone', async () => {
    const { deps, sends } = setup({ debt: RESIDUAL, ratio: 1_200_000n });

    await runLiquidationWatch(deps, baseConfig({ enableDirect: true }));

    expect(sends.map((entry) => entry.functionName)).toEqual(['liquidateViaPool', `wait:${TX_HASH}`]);
  });

  it('sends nothing more while the direct path is off', async () => {
    const { deps, sends } = setup({ debt: RESIDUAL, ratio: 1_000_000n });

    await runLiquidationWatch(deps, baseConfig({ enableDirect: false }));

    expect(sends.map((entry) => entry.functionName)).toEqual(['liquidateViaPool', `wait:${TX_HASH}`]);
  });

  // A residual the direct path could not take was dropped
  // without a word, where the paused path already reported it.
  it('reports a residual the keeper wallet cannot cover as vault.liquidation-blocked at error', async () => {
    const { deps, events, sends } = setup(
      { debt: RESIDUAL, ratio: 1_000_000n },
      { receiptStatus: 'success' },
      // Below the 100 GSUSD minimum debt, so not even a partial is worth sending.
      { balance: 50n * 10n ** 18n }
    );

    await runLiquidationWatch(deps, baseConfig({ enableDirect: true }));

    expect(sends.map((entry) => entry.functionName)).toEqual(['liquidateViaPool', `wait:${TX_HASH}`]);
    const blocked = events.find((entry) => entry.event === 'vault.liquidation-blocked');
    expect(blocked?.level).toBe('error');
    expect(blocked?.fields).toMatchObject({ owner: OWNER_A, debt: RESIDUAL, poolTried: true });
  });

  it('reports a residual left while the direct path is off as vault.liquidation-blocked at error', async () => {
    const { deps, events } = setup({ debt: RESIDUAL, ratio: 1_000_000n });

    await runLiquidationWatch(deps, baseConfig({ enableDirect: false }));

    const blocked = events.find((entry) => entry.event === 'vault.liquidation-blocked');
    expect(blocked?.level).toBe('error');
    expect(blocked?.fields).toMatchObject({ owner: OWNER_A, debt: RESIDUAL, enableDirect: false });
  });

  it('reports nothing blocked when the residual is liquidated or the vault is restored', async () => {
    const liquidated = setup({ debt: RESIDUAL, ratio: 1_000_000n });
    await runLiquidationWatch(liquidated.deps, baseConfig({ enableDirect: true }));
    const restored = setup({ debt: RESIDUAL, ratio: 1_200_000n });
    await runLiquidationWatch(restored.deps, baseConfig({ enableDirect: false }));

    expect(eventNames(liquidated.events)).not.toContain('vault.liquidation-blocked');
    expect(eventNames(restored.events)).not.toContain('vault.liquidation-blocked');
  });

  // The paused path: a partial fill through the pool at the emergency
  // price used to drop the residual flag, so the leftover waited a tick. The collateral is
  // read fresh: 1.5 PAXG at $2,000 against the 3,000 residual is 100%, still liquidatable.
  for (const pause of [{ oraclePaused: true }, { vaultPaused: true }] as const) {
    const name = Object.keys(pause)[0];
    it(`${name}: emergency-liquidates the residual in the same tick`, async () => {
      const { deps, sends } = setup({ debt: RESIDUAL, ratio: 1_000_000n }, { receiptStatus: 'success' }, pause, 15n * 10n ** 17n);

      await runLiquidationWatch(deps, baseConfig({ enableDirect: true }));

      expect(sends.map((entry) => entry.functionName)).toEqual([
        'liquidateViaPool',
        `wait:${TX_HASH}`,
        'emergencyLiquidate',
        `wait:${TX_HASH}`,
      ]);
      // emergencyLiquidate takes the whole remaining debt (0 is the full-repay sentinel, as for liquidate).
      expect(sends[2]?.args).toEqual([OWNER_A, 0n]);
    });
  }

  it('oraclePaused: leaves a vault the partial fill restored to health alone, judged at getEmergencyPrice', async () => {
    // The collateral stays at 7 PAXG: $14,000 against the 3,000 residual is far above the ratio.
    const { deps, sends } = setup({ debt: RESIDUAL, ratio: 1_000_000n }, { receiptStatus: 'success' }, { oraclePaused: true });

    await runLiquidationWatch(deps, baseConfig({ enableDirect: true }));

    expect(sends.map((entry) => entry.functionName)).toEqual(['liquidateViaPool', `wait:${TX_HASH}`]);
  });

  it('oraclePaused: sends nothing more while the direct path is off, and says the pool was tried', async () => {
    const { deps, events, sends } = setup({ debt: RESIDUAL, ratio: 1_000_000n }, { receiptStatus: 'success' }, { oraclePaused: true }, 15n * 10n ** 17n);

    await runLiquidationWatch(deps, baseConfig({ enableDirect: false }));

    expect(sends.map((entry) => entry.functionName)).toEqual(['liquidateViaPool', `wait:${TX_HASH}`]);
    expect(events.find((entry) => entry.event === 'vault.liquidation-blocked')?.fields).toMatchObject({ poolTried: true });
  });

  it('runs nothing competing while the partial fill receipt cannot be read', async () => {
    const { deps, sends } = setup({ debt: RESIDUAL, ratio: 1_000_000n }, { receiptSequence: ['throw'] });

    await runLiquidationWatch(deps, baseConfig({ enableDirect: true }));

    expect(sends.map((entry) => entry.functionName)).toEqual(['liquidateViaPool', `wait:${TX_HASH}`]);
  });

  // The residual crosses its line at $1,900. It is healthy
  // at the $2,000 quote that sized the partial, and both feeds fall to $1,800 while the
  // partial's receipt is awaited, so only a quote read after that wait sees it liquidatable.
  it('decides the residual at a price read after the partial fill receipt, not the one before it', async () => {
    const quoteCalls = { count: 0 };
    const { readOptions, tx, sends } = setup(
      { debt: RESIDUAL, ratio: 1_150_000n, liquidationPrice: 190_000_000_000n },
      { receiptStatus: 'success' },
      { quotePrice: DEFAULT_LIVE_PRICE, quoteCalls }
    );
    const { deps } = createDeps(
      createStubRead(readOptions),
      fallingWhileWaiting(tx, readOptions, 180_000_000_000n),
      [OWNER_A]
    );

    await runLiquidationWatch(deps, baseConfig({ enableDirect: true }));

    expect(sends.map((entry) => entry.functionName)).toEqual([
      'liquidateViaPool',
      `wait:${TX_HASH}`,
      'liquidate',
      `wait:${TX_HASH}`,
    ]);
    expect(quoteCalls.count).toBe(2);
  });
});

describe('runLiquidationWatch underwater sizing', () => {
  // 1 PAXG at $2000 against 2,100 GSUSD: coverable 2,000 < debt, so the vault repays
  // 2,000 * 0.98 = 1,960 (the shortfall cap 2 * 2,000 - 2,100 = 1,900 is lower).
  const DEBT = 2_100n * 10n ** 18n;
  const REPAY = 1_960n * 10n ** 18n;
  const underwater = { [OWNER_A]: { debt: DEBT, ratio: 952_380n } };

  it('sends a full pool liquidation when the pool holds one wei more than the discounted repayment', async () => {
    const { tx, sends } = createStubTx();
    const { deps } = createDeps(
      createStubRead({ vaults: underwater, totalDeposits: REPAY + 1n }),
      tx,
      [OWNER_A]
    );

    await runLiquidationWatch(deps, baseConfig());

    expect(sends).toEqual([
      { address: VAULT, functionName: 'liquidateViaPool', args: [OWNER_A, 0n] },
    ]);
  });

  it('still refuses a pool holding exactly the discounted repayment', async () => {
    const { tx, sends } = createStubTx();
    const { deps, events } = createDeps(
      createStubRead({ vaults: underwater, totalDeposits: REPAY }),
      tx,
      [OWNER_A]
    );

    await runLiquidationWatch(deps, baseConfig());

    expect(sends).toEqual([]);
    const held = events.find((entry) => entry.event === 'vault.full-liquidation-required');
    expect(held?.fields).toMatchObject({ repay: REPAY });
  });

  it('commits the discounted repayment, not the nominal debt, against the pool', async () => {
    const { tx, sends } = createStubTx();
    const { deps } = createDeps(
      createStubRead({
        vaults: { ...underwater, [OWNER_B]: { debt: DEBT, ratio: 952_380n } },
        totalDeposits: 2n * REPAY + 2n,
      }),
      tx,
      [OWNER_A, OWNER_B]
    );

    await runLiquidationWatch(deps, baseConfig());

    expect(sends.map((entry) => entry.args)).toEqual([
      [OWNER_A, 0n],
      [OWNER_B, 0n],
    ]);
  });

  it('falls back to the nominal debt when the discount cannot be read', async () => {
    const { tx, sends } = createStubTx();
    const { deps, events } = createDeps(
      createStubRead({ vaults: underwater, totalDeposits: REPAY + 1n, discountUnreadable: true }),
      tx,
      [OWNER_A]
    );

    await runLiquidationWatch(deps, baseConfig());

    expect(sends).toEqual([]);
    expect(eventNames(events)).toContain('vault.full-liquidation-required');
  });
});

describe('runLiquidationWatch while paused', () => {
  // 1 PAXG at $2000 against 2,000 GSUSD: ratio 100%, under the 110% liquidation ratio.
  const DEBT = 2_000n * 10n ** 18n;
  const vaults = { [OWNER_A]: { debt: DEBT, ratio: 1_000_000n } };
  const funded = {
    vaults,
    totalDeposits: 10_000n * 10n ** 18n,
    balance: 5_000n * 10n ** 18n,
    allowance: 0n,
  };

  it('an oracle pause does not disable the funded pool when the keeper has no GSUSD', async () => {
    const { tx, sends } = createStubTx();
    const { deps } = createDeps(
      createStubRead({ ...funded, oraclePaused: true, balance: 0n }),
      tx,
      [OWNER_A]
    );

    await runLiquidationWatch(deps, baseConfig({ enableDirect: false }));

    expect(sends).toEqual([{ address: VAULT, functionName: 'liquidateViaPool', args: [OWNER_A, 0n] }]);
  });

  it('checks the clamped emergency price even when the raw primary feed calls the vault healthy', async () => {
    const { tx, sends } = createStubTx();
    const { deps } = createDeps(
      createStubRead({
        ...funded,
        oraclePaused: true,
        totalDeposits: 0n,
        // One PAXG against 2,000 GSUSD: C=$2,400 says 120%, but the oracle
        // clamps settlement to G * 1.02=$2,040, so the actual ratio is 102%.
        livePrice: 240_000_000_000n,
        emergencyPrice: 204_000_000_000n,
        vaults: { [OWNER_A]: { debt: DEBT, ratio: 1_200_000n, liquidationPrice: 220_000_000_000n } },
      }),
      tx,
      [OWNER_A]
    );

    await runLiquidationWatch(deps, baseConfig({ enableDirect: true }));

    expect(sends.map((entry) => entry.functionName)).toEqual(['approve', 'emergencyLiquidate']);
  });

  it('emergency-liquidates while the oracle is paused when the pool cannot cover the vault', async () => {
    const { tx, sends } = createStubTx();
    const { deps, events } = createDeps(createStubRead({ ...funded, oraclePaused: true, totalDeposits: 0n }), tx, [OWNER_A]);

    await runLiquidationWatch(deps, baseConfig({ enableDirect: true }));

    expect(sends.map((entry) => entry.functionName)).toEqual(['approve', 'emergencyLiquidate']);
    expect(sends[1]).toEqual({
      address: VAULT,
      functionName: 'emergencyLiquidate',
      args: [OWNER_A, 0n],
    });
    expect(eventNames(events)).not.toContain('vault.liquidation-blocked');
  });

  it('uses the pool first while only the vault is paused, priced at getEmergencyPrice', async () => {
    const { tx, sends } = createStubTx();
    const { deps, events } = createDeps(createStubRead({ ...funded, vaultPaused: true }), tx, [OWNER_A]);

    await runLiquidationWatch(deps, baseConfig({ enableDirect: true }));

    expect(sends).toEqual([{ address: VAULT, functionName: 'liquidateViaPool', args: [OWNER_A, 0n] }]);
    expect(eventNames(events)).not.toContain('vault.liquidation-blocked');
  });

  it('falls back to emergencyLiquidate when the pool cannot take the vault while the vault is paused', async () => {
    const { tx, sends } = createStubTx();
    const { deps } = createDeps(
      createStubRead({ ...funded, vaultPaused: true, totalDeposits: 0n }),
      tx,
      [OWNER_A]
    );

    await runLiquidationWatch(deps, baseConfig({ enableDirect: true }));

    expect(sends.map((entry) => entry.functionName)).toEqual(['approve', 'emergencyLiquidate']);
  });

  it('says the pool was tried when a vault pause leaves the vault blocked', async () => {
    const { tx, sends } = createStubTx();
    const { deps, events } = createDeps(
      createStubRead({ ...funded, vaultPaused: true, totalDeposits: 0n }),
      tx,
      [OWNER_A]
    );

    await runLiquidationWatch(deps, baseConfig({ enableDirect: false }));

    expect(sends).toEqual([]);
    expect(events.find((entry) => entry.event === 'vault.liquidation-blocked')?.fields).toMatchObject({
      poolTried: true,
      vaultPaused: true,
    });
  });

  it('waits for the emergency liquidation receipt and revokes after a mined revert', async () => {
    const { tx, sends } = createStubTx({ receiptSequence: ['success', 'reverted'] });
    const { deps, events } = createDeps(
      createStubRead({ ...funded, oraclePaused: true, totalDeposits: 0n }),
      tx,
      [OWNER_A]
    );

    await runLiquidationWatch(deps, baseConfig({ enableDirect: true }));

    // The revoke waits for its receipt too.
    expect(sends.map((entry) => entry.functionName)).toEqual([
      'approve',
      `wait:${TX_HASH}`,
      'emergencyLiquidate',
      `wait:${TX_HASH}`,
      'approve',
      `wait:${TX_HASH}`,
    ]);
    const failure = events.find(
      (entry) => entry.event === 'keeper.tx-failed' && entry.fields?.functionName === 'emergencyLiquidate'
    );
    expect(failure).toBeDefined();
  });

  it('judges the emergency gate at getEmergencyPrice, the price the contract uses', async () => {
    // The rule values the token at $2,400 (gold above a $2000 C): 120%, and
    // emergencyLiquidate would revert, so nothing is sent.
    const { tx, sends } = createStubTx();
    const { deps, events } = createDeps(
      createStubRead({
        ...funded,
        oraclePaused: true,
        emergencyPrice: 240_000_000_000n,
      }),
      tx,
      [OWNER_A]
    );

    await runLiquidationWatch(deps, baseConfig({ enableDirect: true }));

    expect(sends).toEqual([]);
    expect(eventNames(events)).not.toContain('vault.liquidatable');
    expect(eventNames(events)).not.toContain('vault.liquidation-blocked');
  });

  it('attempts nothing in a pause while either feed is unhealthy, whatever lastKnownPrice says', async () => {
    // Last known $1,800 would read 90%, but variant C never prices a seizure on it: the
    // paused rule refuses ("No price") until C and G both answer again.
    const { tx, sends } = createStubTx();
    const { deps, events } = createDeps(
      createStubRead({
        ...funded,
        oraclePaused: true,
        rulesRefuse: true,
        lastKnownPrice: 180_000_000_000n,
      }),
      tx,
      [OWNER_A]
    );

    await runLiquidationWatch(deps, baseConfig({ enableDirect: true }));

    expect(sends).toEqual([]);
    const blocked = events.find((entry) => entry.event === 'vault.liquidation-blocked');
    expect(String(blocked?.fields?.['reason'])).toContain('No price');
  });

  it.each([
    ['the direct path is disabled', { enableDirect: false }, {}],
    ['the keeper wallet is unfunded', { enableDirect: true }, { balance: 0n }],
  ] as const)(
    'reports liquidation blocked by the pause when %s',
    async (_why, configOverrides, readOverrides) => {
      const { tx, sends } = createStubTx();
      const { deps, events } = createDeps(
        createStubRead({ ...funded, oraclePaused: true, totalDeposits: 0n, ...readOverrides }),
        tx,
        [OWNER_A]
      );

      await runLiquidationWatch(deps, baseConfig(configOverrides));

      expect(sends).toEqual([]);
      const blocked = events.find((entry) => entry.event === 'vault.liquidation-blocked');
      expect(blocked?.level).toBe('error');
      expect(blocked?.fields).toMatchObject({
        owner: OWNER_A,
        oraclePaused: true,
        vaultPaused: false,
        tokenFrozen: false,
      });
    }
  );

  it('liquidates a frozen token through the pool while the vault is paused', async () => {
    const { tx, sends } = createStubTx();
    const { deps, events } = createDeps(
      createStubRead({ ...funded, tokenFrozen: true, vaultPaused: true }),
      tx,
      [OWNER_A]
    );

    await runLiquidationWatch(deps, baseConfig({ enableDirect: true }));

    expect(sends.map((entry) => entry.functionName)).toEqual(['liquidateViaPool']);
    expect(eventNames(events)).not.toContain('vault.liquidation-blocked');
  });

  it('cannot emergency-liquidate a frozen token outside a pause and says Token frozen', async () => {
    const { tx, sends } = createStubTx();
    const { deps, events } = createDeps(
      createStubRead({ ...funded, tokenFrozen: true }),
      tx,
      [OWNER_A]
    );

    await runLiquidationWatch(deps, baseConfig({ enableDirect: true }));

    expect(sends).toEqual([]);
    const blocked = events.find((entry) => entry.event === 'vault.liquidation-blocked');
    expect(blocked?.level).toBe('error');
    expect(blocked?.fields).toMatchObject({ owner: OWNER_A, tokenFrozen: true, oraclePaused: false });
    expect(String(blocked?.fields?.['reason'])).toContain('Token frozen');
  });

  it('carries a Not in emergency revert into the blocked alert', async () => {
    const { tx, sends } = createStubTx();
    const { deps, events } = createDeps(
      createStubRead({ ...funded, vaultPaused: true, emergencyPriceRevert: 'Not in emergency' }),
      tx,
      [OWNER_A]
    );

    await runLiquidationWatch(deps, baseConfig({ enableDirect: true }));

    expect(sends).toEqual([]);
    const blocked = events.find((entry) => entry.event === 'vault.liquidation-blocked');
    expect(String(blocked?.fields?.['reason'])).toContain('Not in emergency');
  });
});

describe('runLiquidationWatch at the variant C price', () => {
  // 1 PAXG at $2000 against 2,000 GSUSD: ratio 100%, under the 110% liquidation ratio.
  const DEBT = 2_000n * 10n ** 18n;
  const underwater = { [OWNER_A]: { debt: DEBT, ratio: 1_000_000n } };
  const funded = {
    totalDeposits: 10_000n * 10n ** 18n,
    balance: 5_000n * 10n ** 18n,
    allowance: 0n,
  };

  it('decides at quoteTokenPrice, the variant C rule, not at the primary alone', async () => {
    // Under water at a $2000 C, but the rule values the token at $2,100 gold (C below G),
    // where the vault holds 115.5%: liquidateViaPool would revert.
    const { tx, sends } = createStubTx();
    const { deps, events } = createDeps(
      createStubRead({
        ...funded,
        vaults: { [OWNER_A]: { debt: DEBT, ratio: 1_000_000n, liquidationPrice: 205_000_000_000n } },
        quotePrice: 210_000_000_000n,
      }),
      tx,
      [OWNER_A]
    );

    await runLiquidationWatch(deps, baseConfig({ enableDirect: true }));

    expect(eventNames(events)).not.toContain('vault.liquidatable');
    expect(sends).toEqual([]);
  });

  it('reports the quoted price and its source on the liquidatable alert', async () => {
    const { deps, events } = createDeps(
      createStubRead({ vaults: underwater, quotePrice: DEFAULT_LIVE_PRICE }),
      undefined,
      [OWNER_A]
    );

    await runLiquidationWatch(deps, baseConfig({ dryRun: true }));

    expect(events.find((entry) => entry.event === 'vault.liquidatable')?.fields).toMatchObject({
      priceSource: 'quoteTokenPrice',
      livePrice: DEFAULT_LIVE_PRICE,
    });
  });

  it.each([
    'No reliable price',
  ])('sends nothing and reports the vault blocked when quoteTokenPrice reverts %s', async (reason) => {
    const { tx, sends } = createStubTx();
    const { deps, events } = createDeps(
      createStubRead({ ...funded, vaults: underwater, quoteRevert: reason }),
      tx,
      [OWNER_A]
    );

    await runLiquidationWatch(deps, baseConfig({ enableDirect: true }));

    expect(sends).toEqual([]);
    expect(eventNames(events)).not.toContain('vault.liquidatable');
    expect(eventNames(events)).not.toContain('vault.liquidatability-degraded');
    const blocked = events.find((entry) => entry.event === 'vault.liquidation-blocked');
    expect(blocked?.level).toBe('error');
    expect(blocked?.fields).toMatchObject({
      owner: OWNER_A,
      debt: DEBT,
      collateralToken: PAXG,
      priceSource: 'quoteTokenPrice',
      reason,
      primaryPrice: DEFAULT_LIVE_PRICE,
    });
  });

  it('reports a blocked vault in dry run too, where nothing would be sent anyway', async () => {
    const { deps, events } = createDeps(
      createStubRead({ vaults: underwater, quoteRevert: 'No reliable price' }),
      undefined,
      [OWNER_A]
    );

    await runLiquidationWatch(deps, baseConfig({ dryRun: true }));

    expect(eventNames(events)).toContain('vault.liquidation-blocked');
    expect(eventNames(events)).not.toContain('keeper.dry-run');
  });

  it('stays quiet about a blocked vault that is healthy even at the primary feed', async () => {
    // The rule price sits at gold or above it and within m of gold, so while PAXG trades
    // near gold a vault healthy at C is healthy at the rule price too: no alert storm.
    const { tx, sends } = createStubTx();
    const { deps, events } = createDeps(
      createStubRead({
        ...funded,
        vaults: { [OWNER_A]: { debt: DEBT, ratio: 1_500_000n } },
        quoteRevert: 'No reliable price',
      }),
      tx,
      [OWNER_A]
    );

    await runLiquidationWatch(deps, baseConfig({ enableDirect: true }));

    expect(eventNames(events).filter((name) => name.startsWith('vault.'))).toEqual([]);
    expect(sends).toEqual([]);
  });

  it('treats a dead primary feed as a blocked price, not a degraded one', async () => {
    const { tx, sends } = createStubTx();
    const { deps, events } = createDeps(
      createStubRead({ ...funded, vaults: underwater, liveOk: false }),
      tx,
      [OWNER_A]
    );

    await runLiquidationWatch(deps, baseConfig({ enableDirect: true }));

    expect(sends).toEqual([]);
    expect(eventNames(events)).not.toContain('vault.liquidatability-degraded');
    const blocked = events.find((entry) => entry.event === 'vault.liquidation-blocked');
    expect(blocked?.fields).toMatchObject({ reason: 'No reliable price', primaryPrice: undefined });
  });

  it('keeps the degraded fallback for an unreachable RPC, distinct from a revert', async () => {
    const { deps, events } = createDeps(
      createStubRead({ vaults: underwater, quoteUnreachable: true }),
      undefined,
      [OWNER_A]
    );

    await runLiquidationWatch(deps, baseConfig({ dryRun: true }));

    expect(eventNames(events)).not.toContain('vault.liquidation-blocked');
    const degraded = events.find((entry) => entry.event === 'vault.liquidatability-degraded');
    expect(String(degraded?.fields?.['detail'])).toContain('quoteTokenPrice unreachable');
    expect(events.find((entry) => entry.event === 'vault.liquidatable')?.fields?.['priceSource']).toBe(
      'last-known'
    );
  });

  it('never sizes at the primary feed: an oracle without quoteTokenPrice blocks the vault', async () => {
    const { tx, sends } = createStubTx();
    const { deps, events } = createDeps(
      createStubRead({ ...funded, vaults: underwater, quoteMissing: true }),
      tx,
      [OWNER_A]
    );

    await runLiquidationWatch(deps, baseConfig({ enableDirect: true }));

    expect(sends).toEqual([]);
    expect(eventNames(events)).not.toContain('vault.liquidatable');
    const blocked = events.find((entry) => entry.event === 'vault.liquidation-blocked');
    expect(String(blocked?.fields?.['reason'])).toContain('no data');
  });

  it('skips a vault whose token is not an active collateral without a word or a price read', async () => {
    // XAUT on a PAXG-first deployment: registered at the oracle on a dormant feed, never a
    // vault collateral type, so nothing can be liquidated and nothing should page.
    const quoteCalls = { count: 0 };
    const { tx, sends } = createStubTx();
    const { deps, events } = createDeps(
      createStubRead({ ...funded, vaults: underwater, collateralActive: false, quoteCalls }),
      tx,
      [OWNER_A]
    );

    await runLiquidationWatch(deps, baseConfig({ enableDirect: true }));

    expect(eventNames(events).filter((name) => name.startsWith('vault.') && name !== 'vault.owner-sweep')).toEqual(
      []
    );
    expect(sends).toEqual([]);
    expect(quoteCalls.count).toBe(0);
  });

  it('points the blocked alert at the oracle health alert and the guardian', async () => {
    const { deps, events } = createDeps(
      createStubRead({ vaults: underwater, quoteRevert: 'No reliable price' }),
      undefined,
      [OWNER_A]
    );

    await runLiquidationWatch(deps, baseConfig({ dryRun: true }));

    const blocked = events.find((entry) => entry.event === 'vault.liquidation-blocked');
    expect(String(blocked?.fields?.['detail'])).toContain('oracle.price-refused');
  });

  it('quotes each collateral token once per tick, however many vaults hold it', async () => {
    const quoteCalls = { count: 0 };
    const { deps } = createDeps(
      createStubRead({
        vaults: {
          [OWNER_A]: { debt: DEBT, ratio: 1_000_000n },
          [OWNER_B]: { debt: DEBT, ratio: 1_500_000n },
        },
        quoteCalls,
      }),
      undefined,
      [OWNER_A, OWNER_B]
    );

    await runLiquidationWatch(deps, baseConfig({ dryRun: true }));

    expect(quoteCalls.count).toBe(1);
  });
});

// One quote served the whole owner walk, so a vault that
// crossed its line while the keeper waited for an earlier receipt was judged at the old price,
// skipped without an alert and seen only on a later tick.
describe('runLiquidationWatch price freshness across the owner walk', () => {
  // The reproduction: 1 PAXG each against a 110% liquidation ratio. A owes 2,600 GSUSD
  // and crosses its line below $2,860; B owes 2,500 and crosses it below $2,750. At $2,800 only
  // A is liquidatable; at $2,600 B stands at 104%.
  const E18 = 10n ** 18n;
  const BEFORE = 280_000_000_000n;
  const AFTER = 260_000_000_000n;
  const crash = (overrides: Partial<ReadStubOptions> = {}): ReadStubOptions => ({
    vaults: {
      [OWNER_A]: { debt: 2_600n * E18, ratio: 1_076_923n, liquidationPrice: 286_000_000_000n },
      [OWNER_B]: { debt: 2_500n * E18, ratio: 1_120_000n, liquidationPrice: 275_000_000_000n },
    },
    quotePrice: BEFORE,
    totalDeposits: 100_000n * E18,
    ...overrides,
  });

  /** Each liquidatable alert as [owner, the price it was decided at]. */
  const alerts = (events: LoggedEvent[]): unknown[][] =>
    events
      .filter((entry) => entry.event === 'vault.liquidatable')
      .map((entry) => [entry.fields?.['owner'], entry.fields?.['livePrice']]);

  /** A read client whose clock moves by `elapsedMs` (back, when negative) and whose price falls as the walk reaches B. */
  const reachingBLater = (
    readOptions: ReadStubOptions,
    clock: { ms: number },
    elapsedMs: number
  ): KeeperReadClient => {
    const read = createStubRead(readOptions);
    return {
      readContract: async (call) => {
        if (call.functionName === 'vaults' && call.args?.[0] === OWNER_B) {
          clock.ms += elapsedMs;
          readOptions.quotePrice = AFTER;
        }
        return read.readContract(call);
      },
    };
  };

  it('alerts and liquidates a vault that crossed its line while a pool receipt was awaited, in the same walk', async () => {
    const quoteCalls = { count: 0 };
    const readOptions = crash({ quoteCalls });
    const { tx, sends } = createStubTx({ receiptStatus: 'success' });
    const { deps, events } = createDeps(
      createStubRead(readOptions),
      fallingWhileWaiting(tx, readOptions, AFTER),
      [OWNER_A, OWNER_B]
    );

    await runLiquidationWatch(deps, baseConfig());

    expect(alerts(events)).toEqual([
      [OWNER_A, BEFORE],
      [OWNER_B, AFTER],
    ]);
    expect(
      sends.filter((entry) => entry.functionName === 'liquidateViaPool').map((entry) => entry.args[0])
    ).toEqual([OWNER_A, OWNER_B]);
    expect(quoteCalls.count).toBe(2);
  });

  it.each(['approve', 'liquidate'])(
    'alerts and liquidates a vault that crossed its line while the direct path awaited its %s receipt',
    async (during) => {
      const readOptions = crash({ totalDeposits: 0n, balance: 10_000n * E18, allowance: 0n });
      const { tx, sends } = createStubTx({ receiptStatus: 'success' });
      const { deps, events } = createDeps(
        createStubRead(readOptions),
        fallingWhileWaiting(tx, readOptions, AFTER, during),
        [OWNER_A, OWNER_B]
      );

      await runLiquidationWatch(deps, baseConfig({ enableDirect: true }));

      expect(alerts(events)).toEqual([
        [OWNER_A, BEFORE],
        [OWNER_B, AFTER],
      ]);
      expect(
        sends.filter((entry) => entry.functionName === 'liquidate').map((entry) => entry.args[0])
      ).toEqual([OWNER_A, OWNER_B]);
    }
  );

  it('alerts and tries a vault that crossed its line while the direct path awaited its allowance revoke receipt', async () => {
    const readOptions = crash({ totalDeposits: 0n, balance: 10_000n * E18, allowance: 0n });
    const { tx, sends } = createStubTx({ receiptStatus: 'success', failing: ['liquidate'] });
    const { deps, events } = createDeps(
      createStubRead(readOptions),
      fallingWhileWaiting(tx, readOptions, AFTER, 'approve-revoke'),
      [OWNER_A, OWNER_B]
    );

    await runLiquidationWatch(deps, baseConfig({ enableDirect: true }));

    expect(alerts(events)).toEqual([
      [OWNER_A, BEFORE],
      [OWNER_B, AFTER],
    ]);
    expect(
      sends.filter((entry) => entry.functionName === 'liquidate').map((entry) => entry.args[0])
    ).toEqual([OWNER_A, OWNER_B]);
  });

  it.each([
    ['a pool receipt', { vaultPaused: true }, 'liquidateViaPool', undefined],
    [
      'the approve receipt of an emergencyLiquidate',
      { vaultPaused: true, totalDeposits: 0n, balance: 10_000n * E18, allowance: 0n },
      'emergencyLiquidate',
      'approve',
    ],
  ])(
    'alerts and liquidates a vault that crossed its line while the vault was paused and %s was awaited',
    async (_receipt, overrides: Partial<ReadStubOptions>, sent: string, during: string | undefined) => {
      const readOptions = crash(overrides);
      const { tx, sends } = createStubTx({ receiptStatus: 'success' });
      const { deps, events } = createDeps(
        createStubRead(readOptions),
        fallingWhileWaiting(tx, readOptions, AFTER, during),
        [OWNER_A, OWNER_B]
      );

      await runLiquidationWatch(deps, baseConfig({ enableDirect: true }));

      expect(alerts(events)).toEqual([
        [OWNER_A, BEFORE],
        [OWNER_B, AFTER],
      ]);
      expect(sends.filter((entry) => entry.functionName === sent).map((entry) => entry.args[0])).toEqual([
        OWNER_A,
        OWNER_B,
      ]);
    }
  );

  it('alerts and liquidates a vault that crossed its line while a pool receipt wait timed out', async () => {
    const readOptions = crash();
    const { tx, sends } = createStubTx({ receiptSequence: ['throw'] });
    const { deps, events } = createDeps(
      createStubRead(readOptions),
      fallingWhileWaiting(tx, readOptions, AFTER),
      [OWNER_A, OWNER_B]
    );

    await runLiquidationWatch(deps, baseConfig());

    expect(alerts(events)).toEqual([
      [OWNER_A, BEFORE],
      [OWNER_B, AFTER],
    ]);
    expect(
      sends.filter((entry) => entry.functionName === 'liquidateViaPool').map((entry) => entry.args[0])
    ).toEqual([OWNER_A, OWNER_B]);
  });

  it('alerts and liquidates a vault that crossed its line during a broadcast from a sender that cannot wait', async () => {
    const readOptions = crash();
    const { tx, sends } = createStubTx();
    const falling: KeeperTxSender = {
      account: tx.account,
      simulateAndSend: async (call) => {
        const result = await tx.simulateAndSend(call);
        readOptions.quotePrice = AFTER;
        return result;
      },
    };
    const { deps, events } = createDeps(createStubRead(readOptions), falling, [OWNER_A, OWNER_B]);

    // A frozen clock: only the broadcast, never the slot bound, can outdate A's quote.
    await runLiquidationWatch({ ...deps, now: () => 1_000_000 }, baseConfig());

    expect(alerts(events)).toEqual([
      [OWNER_A, BEFORE],
      [OWNER_B, AFTER],
    ]);
    expect(
      sends.filter((entry) => entry.functionName === 'liquidateViaPool').map((entry) => entry.args[0])
    ).toEqual([OWNER_A, OWNER_B]);
  });

  it('re-reads a quote older than one slot before the next vault, with nothing sent', async () => {
    const quoteCalls = { count: 0 };
    const clock = { ms: 1_000_000 };
    const { deps, events } = createDeps(
      reachingBLater(crash({ quoteCalls }), clock, QUOTE_MAX_AGE_MS + 1),
      undefined,
      [OWNER_A, OWNER_B]
    );

    await runLiquidationWatch({ ...deps, now: () => clock.ms }, baseConfig({ dryRun: true }));

    expect(quoteCalls.count).toBe(2);
    expect(alerts(events)).toEqual([
      [OWNER_A, BEFORE],
      [OWNER_B, AFTER],
    ]);
  });

  it('keeps a quote no older than one slot for the next vault, with nothing sent', async () => {
    const quoteCalls = { count: 0 };
    const clock = { ms: 1_000_000 };
    const { deps, events } = createDeps(
      reachingBLater(crash({ quoteCalls }), clock, QUOTE_MAX_AGE_MS),
      undefined,
      [OWNER_A, OWNER_B]
    );

    await runLiquidationWatch({ ...deps, now: () => clock.ms }, baseConfig({ dryRun: true }));

    expect(quoteCalls.count).toBe(1);
    expect(alerts(events)).toEqual([[OWNER_A, BEFORE]]);
  });

  it('re-reads a quote when the clock steps back before the next vault, with nothing sent', async () => {
    const quoteCalls = { count: 0 };
    const clock = { ms: 1_000_000 };
    const { deps, events } = createDeps(
      reachingBLater(crash({ quoteCalls }), clock, -60_000),
      undefined,
      [OWNER_A, OWNER_B]
    );

    await runLiquidationWatch({ ...deps, now: () => clock.ms }, baseConfig({ dryRun: true }));

    expect(quoteCalls.count).toBe(2);
    expect(alerts(events)).toEqual([
      [OWNER_A, BEFORE],
      [OWNER_B, AFTER],
    ]);
  });

  it('leaves a dry run walk alone: no sends and one quote per token while within a slot', async () => {
    const quoteCalls = { count: 0 };
    const { tx, sends } = createStubTx({ receiptStatus: 'success' });
    const { deps, events } = createDeps(
      createStubRead(crash({ quoteCalls, quotePrice: AFTER })),
      tx,
      [OWNER_A, OWNER_B]
    );

    await runLiquidationWatch({ ...deps, now: () => 1_000_000 }, baseConfig({ dryRun: true }));

    expect(sends).toEqual([]);
    expect(quoteCalls.count).toBe(1);
    expect(alerts(events)).toEqual([
      [OWNER_A, AFTER],
      [OWNER_B, AFTER],
    ]);
    expect(eventNames(events).filter((name) => name === 'keeper.dry-run')).toHaveLength(2);
  });

  it.each([
    ['the pool is empty and the direct path is off', { totalDeposits: 0n }, {}],
    ['the pool send fails in simulation', {}, { failing: ['liquidateViaPool'] }],
    [
      'the pool send of a sender that cannot wait fails in simulation',
      {},
      { failing: ['liquidateViaPool'], receiptStatus: undefined },
    ],
  ])(
    'keeps one quote per token while a live walk sends nothing because %s',
    async (_reason, readOverrides: Partial<ReadStubOptions>, txOptions: Parameters<typeof createStubTx>[0]) => {
      const quoteCalls = { count: 0 };
      const { tx } = createStubTx({ receiptStatus: 'success', ...txOptions });
      const { deps, events } = createDeps(
        createStubRead(crash({ quoteCalls, quotePrice: AFTER, ...readOverrides })),
        tx,
        [OWNER_A, OWNER_B]
      );

      await runLiquidationWatch({ ...deps, now: () => 1_000_000 }, baseConfig());

      expect(quoteCalls.count).toBe(1);
      expect(alerts(events)).toEqual([
        [OWNER_A, AFTER],
        [OWNER_B, AFTER],
      ]);
    }
  );
});

// Every indebted vault used to cost
// two sequential eth_calls (vaults and getLiquidationPrice) and, while quoteTokenPrice refused,
// about six; vaults were sent in the owner source's order; and an owner whose batch entry
// failed was walked singly without ever being counted as unread.
describe('runLiquidationWatch over a multicall client', () => {
  const E18 = 10n ** 18n;
  const owner = (index: number): Address =>
    getAddress(`0x${(0x6000 + index).toString(16).padStart(40, '0')}`);

  /** The stub with multicall, logging every sequential read and every send in one order. */
  const recording = (readOptions: ReadStubOptions, txOptions: Parameters<typeof createStubTx>[0] = {}) => {
    const base = createStubRead(readOptions);
    const trail: string[] = [];
    const sequential: KeeperReadClient = {
      readContract: async (call) => {
        trail.push(`${call.functionName}(${String(call.args?.[0] ?? '')})`);
        return base.readContract(call);
      },
    };
    const read: KeeperReadClient = {
      readContract: sequential.readContract,
      readContracts: withMulticall(base).readContracts,
    };
    const { tx, sends } = createStubTx(txOptions);
    const tracked: KeeperTxSender = {
      ...tx,
      simulateAndSend: async (call) => {
        trail.push(`send:${call.functionName}(${String(call.args[0])})`);
        return tx.simulateAndSend(call);
      },
    };
    return { read, tx: tracked, sends, trail };
  };
  const reads = (trail: readonly string[], functionName: string): string[] =>
    trail.filter((entry) => entry.startsWith(`${functionName}(`));

  it('makes no sequential read for an indebted vault that is healthy at the quote', async () => {
    const owners = Array.from({ length: 50 }, (_, index) => owner(index));
    const quoteCalls = { count: 0 };
    const { read, tx, trail } = recording({
      vaults: Object.fromEntries(owners.map((entry) => [entry, { debt: 2_000n * E18, ratio: 1_500_000n }])),
      quoteCalls,
    });
    const { deps, events } = createDeps(read, tx, owners);

    await runLiquidationWatch(deps, baseConfig());

    expect(reads(trail, 'vaults')).toEqual([]);
    expect(reads(trail, 'getLiquidationPrice')).toEqual([]);
    expect(quoteCalls.count).toBe(1);
    expect(eventNames(events).filter((name) => name.startsWith('vault.') && name !== 'vault.owner-sweep')).toEqual(
      []
    );
  });

  it('still re-reads the vault and its liquidation price immediately before a send', async () => {
    const { read, tx, trail } = recording({
      vaults: {
        [owner(0)]: { debt: 2_000n * E18, ratio: 1_500_000n },
        [owner(1)]: { debt: 2_000n * E18, ratio: 1_000_000n },
      },
      totalDeposits: 100_000n * E18,
    });
    const { deps } = createDeps(read, tx, [owner(0), owner(1)]);

    await runLiquidationWatch(deps, baseConfig());

    const send = trail.indexOf(`send:liquidateViaPool(${owner(1)})`);
    expect(send).toBeGreaterThan(-1);
    const beforeSend = trail.slice(0, send);
    expect(beforeSend).toContain(`vaults(${owner(1)})`);
    expect(beforeSend).toContain(`getLiquidationPrice(${owner(1)})`);
    expect(reads(trail, 'vaults')).toEqual([`vaults(${owner(1)})`]);
  });

  it('reads the pause state and the primary price once per token while quoteTokenPrice refuses', async () => {
    const owners = Array.from({ length: 20 }, (_, index) => owner(index));
    const vaults: Record<Address, VaultState> = Object.fromEntries(
      owners.map((entry) => [entry, { debt: 2_000n * E18, ratio: 1_500_000n }])
    );
    // One vault is liquidatable even at the primary feed, so it is still reported blocked.
    vaults[owner(7)] = { debt: 2_000n * E18, ratio: 1_000_000n };
    const { read, tx, trail } = recording({ vaults, quoteRevert: 'No reliable price' });
    const { deps, events } = createDeps(read, tx, owners);

    await runLiquidationWatch(deps, baseConfig());

    // The screen's reads, then the full decision for the one vault reported blocked.
    expect(reads(trail, 'getValidatedPrice')).toHaveLength(2);
    expect(reads(trail, 'tokenFrozen')).toHaveLength(2);
    expect(reads(trail, 'getLiquidationPrice')).toEqual([`getLiquidationPrice(${owner(7)})`]);
    const blocked = events.filter((entry) => entry.event === 'vault.liquidation-blocked');
    expect(blocked.map((entry) => entry.fields?.['owner'])).toEqual([owner(7)]);
  });

  it('sends to the underwater vault first, then the largest debt, whatever the listing order', async () => {
    const small = owner(0);
    const large = owner(1);
    const underwater = owner(2);
    const { read, tx, sends } = recording(
      {
        vaults: {
          // $2,000 of gold against 1,000 GSUSD, past its line.
          [small]: { debt: 1_000n * E18, ratio: 1_050_000n, collateralAmount: E18 },
          // $42,000 against 40,000: past its line, still solvent.
          [large]: { debt: 40_000n * E18, ratio: 1_050_000n, collateralAmount: 21n * E18 },
          // $4,000 against 5,000: underwater.
          [underwater]: { debt: 5_000n * E18, ratio: 800_000n, collateralAmount: 2n * E18 },
        },
        totalDeposits: 1_000_000n * E18,
      },
      { receiptStatus: 'success' }
    );
    const { deps } = createDeps(read, tx, [small, large, underwater]);

    await runLiquidationWatch(deps, baseConfig());

    expect(
      sends.filter((entry) => entry.functionName === 'liquidateViaPool').map((entry) => entry.args[0])
    ).toEqual([underwater, large, small]);
  });

  it('re-screens the vaults it judged healthy after a receipt wait, and liquidates one that crossed', async () => {
    const BEFORE = 280_000_000_000n;
    const AFTER = 260_000_000_000n;
    const readOptions: ReadStubOptions = {
      vaults: {
        [OWNER_A]: { debt: 2_600n * E18, ratio: 1_076_923n, liquidationPrice: 286_000_000_000n },
        [OWNER_B]: { debt: 2_500n * E18, ratio: 1_120_000n, liquidationPrice: 275_000_000_000n },
      },
      quotePrice: BEFORE,
      totalDeposits: 100_000n * E18,
    };
    const { read, tx, sends } = recording(readOptions, { receiptStatus: 'success' });
    // B is listed first and screened healthy at $2,800; the price falls while A's receipt is awaited.
    const { deps, events } = createDeps(read, fallingWhileWaiting(tx, readOptions, AFTER), [OWNER_B, OWNER_A]);

    await runLiquidationWatch(deps, baseConfig());

    expect(
      events
        .filter((entry) => entry.event === 'vault.liquidatable')
        .map((entry) => [entry.fields?.['owner'], entry.fields?.['livePrice']])
    ).toEqual([
      [OWNER_A, BEFORE],
      [OWNER_B, AFTER],
    ]);
    expect(
      sends.filter((entry) => entry.functionName === 'liquidateViaPool').map((entry) => entry.args[0])
    ).toEqual([OWNER_A, OWNER_B]);
  });

  it('visits every candidate of a pass whose screen outlives a slot with nothing sent, screening once', async () => {
    // GoldVault is paused, so quoteTokenPrice reverts and the screen price screens nothing:
    // every indebted vault is a candidate. Each batch read takes longer than a slot, so the
    // screen is older than QUOTE_MAX_AGE_MS before the first visit; a pass that stopped on
    // age alone visited one vault and screened all the others again, once per vault.
    const owners = Array.from({ length: 12 }, (_, index) => owner(index));
    const walk = async (batchMs: number): Promise<{ batches: number; visited: string[] }> => {
      const clock = { ms: 1_000_000 };
      const base = createStubRead({
        vaults: Object.fromEntries(owners.map((entry) => [entry, { debt: 2_000n * E18, ratio: 1_500_000n }])),
        quoteRevert: 'EnforcedPause',
        vaultPaused: true,
      });
      const trail: string[] = [];
      const batches: number[] = [];
      const multicall = withMulticall(base, batches);
      const read: KeeperReadClient = {
        readContract: async (call) => {
          trail.push(`${call.functionName}(${String(call.args?.[0] ?? '')})`);
          return base.readContract(call);
        },
        readContracts: async (calls) => {
          clock.ms += batchMs;
          return multicall.readContracts?.(calls) ?? [];
        },
      };
      const { tx } = createStubTx({ receiptStatus: 'success' });
      const { deps } = createDeps(read, tx, owners);
      await runLiquidationWatch({ ...deps, now: () => clock.ms }, baseConfig({ dryRun: true }));
      return { batches: batches.length, visited: reads(trail, 'getLiquidationPrice') };
    };

    const slow = await walk(QUOTE_MAX_AGE_MS + 1);
    const still = await walk(0);

    expect(slow.visited).toHaveLength(owners.length);
    expect(new Set(slow.visited).size).toBe(owners.length);
    expect(slow.batches).toBe(still.batches);
  });

  it('counts an owner whose batch entry and single read both fail as unread, and does not walk it', async () => {
    const { read, tx, sends } = recording({
      vaults: { [OWNER_B]: { debt: 100n, ratio: 1_000_000n } },
      totalDeposits: 200n,
      failFor: OWNER_A,
    });
    const { deps, events } = createDeps(read, tx, [OWNER_A, OWNER_B]);

    await runLiquidationWatch(deps, baseConfig());

    expect(events.find((entry) => entry.event === 'vault.owner-sweep')?.fields).toMatchObject({
      owners: 2,
      read: 1,
      unread: 1,
    });
    expect(events.find((entry) => entry.event === 'vault.owners-unread')?.fields).toMatchObject({
      count: 1,
      owners: [OWNER_A],
    });
    expect(events.filter((entry) => entry.event === 'keeper.job-error' && entry.fields?.['owner'])).toEqual([]);
    expect(sends.map((entry) => entry.args[0])).toEqual([OWNER_B]);
  });
});

// Any non-zero keeper GSUSD balance used to silence the keeper.no-liquidation-path page
// while the direct path could not cover the vault. The open
// launch profile: the PAXG ceiling is MaxUint256, the pool is empty, KEEPER_ENABLE_DIRECT
// is on and one vault of 10,000 GSUSD sits at 106%. One wei sent to the keeper by any
// holder, or a float smaller than the vault, used to leave only warn-level lines.
describe('runLiquidationWatch when the direct path float cannot cover the vault', () => {
  const E18 = 10n ** 18n;
  const DEBT = 10_000n * E18;
  const MIN_DEBT = 1_000n * E18;
  const openProfile = (overrides: Partial<ReadStubOptions> = {}): ReadStubOptions => ({
    vaults: { [OWNER_A]: { debt: DEBT, ratio: 1_060_000n } },
    collateralAmount: 53n * 10n ** 17n,
    debtCeiling: 2n ** 256n - 1n,
    totalDeposits: 0n,
    minDebt: MIN_DEBT,
    allowance: 0n,
    ...overrides,
  });

  const run = async (read: ReadStubOptions, enableDirect = true) => {
    const { tx, sends } = createStubTx();
    const { deps, events } = createDeps(createStubRead(read), tx, [OWNER_A]);
    await runLiquidationWatch(deps, baseConfig({ enableDirect }));
    const errors = events.filter((entry) => entry.level === 'error');
    return { events, errors, sends };
  };

  it('pages keeper.no-liquidation-path when the keeper wallet holds one wei', async () => {
    const { errors, sends } = await run(openProfile({ balance: 1n }));

    expect(errors.map((entry) => entry.event)).toContain('keeper.no-liquidation-path');
    expect(sends).toEqual([]);
  });

  it('pages keeper.no-liquidation-path while the wallet holds less than minDebt plus the direct headroom', async () => {
    const { errors } = await run(openProfile({ balance: MIN_DEBT + MIN_DEBT / 100n }));

    expect(errors.find((entry) => entry.event === 'keeper.no-liquidation-path')?.fields).toMatchObject({
      keeperGsusdBalance: MIN_DEBT + MIN_DEBT / 100n,
      minimumDirectFloat: MIN_DEBT + MIN_DEBT / 100n + 1n,
    });
  });

  it('counts a wallet that covers the smallest vault as armed, and sends a partial into the vault it cannot cover', async () => {
    const balance = MIN_DEBT + MIN_DEBT / 100n + 1n;
    const { errors, events, sends } = await run(openProfile({ balance }));

    expect(errors).toEqual([]);
    expect(sends.map((entry) => [entry.functionName, entry.args[1]])).toEqual([
      ['approve', balance],
      ['liquidate', balance],
    ]);
    expect(events.find((entry) => entry.event === 'vault.partial-direct-liquidation')?.fields).toMatchObject({
      owner: OWNER_A,
      repaying: balance,
      uncoveredDebt: DEBT - balance,
    });
    // The receipt reported success, so the direct path says so (the pool path always did).
    expect(events.find((entry) => entry.event === 'vault.liquidated-direct')?.fields).toMatchObject({
      owner: OWNER_A,
      debt: DEBT,
      repaid: balance,
    });
  });

  it('reports a vault the float can cover neither whole nor in part as vault.liquidation-blocked at error', async () => {
    // Above the armed line would be a valid partial, so the vault here refuses partials: its
    // gold, 4.9 oz at $2,000, is worth less than the debt.
    const { errors, sends } = await run(openProfile({ balance: 5_000n * E18, collateralAmount: 49n * 10n ** 17n }));

    const blocked = errors.find((entry) => entry.event === 'vault.liquidation-blocked');
    expect(blocked?.fields).toMatchObject({ owner: OWNER_A, debt: DEBT, poolTried: true, enableDirect: true });
    expect(String(blocked?.fields?.['reason'])).toContain('cannot cover');
    expect(sends).toEqual([]);
  });

  it('reports vault.liquidation-blocked when the pool cannot take the vault and the direct path is off', async () => {
    const { errors, sends } = await run(openProfile({ balance: 20_000n * E18 }), false);

    const blocked = errors.find((entry) => entry.event === 'vault.liquidation-blocked');
    expect(blocked?.fields).toMatchObject({ owner: OWNER_A, poolTried: true, enableDirect: false });
    expect(String(blocked?.fields?.['reason'])).toContain('KEEPER_ENABLE_DIRECT');
    expect(sends).toEqual([]);
  });

  it('liquidates directly and pages nothing when the float covers the debt plus 1% plus 1 wei', async () => {
    const { errors, sends } = await run(openProfile({ balance: 10_101n * E18 }));

    expect(errors).toEqual([]);
    expect(sends.map((entry) => entry.functionName)).toEqual(['approve', 'liquidate']);
  });

  it('pages the same unfunded outcome on the paused path, as it did before', async () => {
    const { errors, sends } = await run(openProfile({ balance: 1n, vaultPaused: true }));

    expect(errors.map((entry) => entry.event)).toContain('vault.liquidation-blocked');
    expect(sends).toEqual([]);
  });
});

// The direct path was all or nothing: a wallet one
// wei short of the debt plus headroom sent nothing although GoldVault accepts a partial from
// any vault whose gold still covers its debt. It now sends the largest partial the vault
// accepts and says how much debt stays uncovered; with no valid partial it stays unfunded.
describe('runLiquidationWatch direct partial when the wallet cannot fund the whole debt', () => {
  const E18 = 10n ** 18n;
  const DEBT = 10_000n * E18;
  const MIN_DEBT = 1_000n * E18;
  const FULL_FLOAT = DEBT + DEBT / 100n + 1n;
  /** The most a partial may repay: it leaves exactly minDebt of principal behind. */
  const MAX_PARTIAL = DEBT - MIN_DEBT;
  const solvent = (overrides: Partial<ReadStubOptions> = {}): ReadStubOptions => ({
    // 5.3 oz at $2,000 is 10,600: liquidatable at 106% and not underwater.
    vaults: { [OWNER_A]: { debt: DEBT, ratio: 1_060_000n } },
    collateralAmount: 53n * 10n ** 17n,
    debtCeiling: 2n ** 256n - 1n,
    totalDeposits: 0n,
    minDebt: MIN_DEBT,
    allowance: 0n,
    ...overrides,
  });

  const run = async (
    read: ReadStubOptions,
    txOptions: Parameters<typeof createStubTx>[0] = { receiptStatus: 'success' }
  ) => {
    const { tx, sends } = createStubTx(txOptions);
    const { deps, events } = createDeps(createStubRead(read), tx, [OWNER_A]);
    await runLiquidationWatch(deps, baseConfig({ enableDirect: true }));
    const calls = sends
      .filter((entry) => !entry.functionName.startsWith('wait:'))
      .map((entry) => [entry.functionName, entry.args[1]]);
    return { events, calls, errors: events.filter((entry) => entry.level === 'error') };
  };

  const partialEvent = (events: LoggedEvent[]): LoggedEvent | undefined =>
    events.find((entry) => entry.event === 'vault.partial-direct-liquidation');

  it('still liquidates in full, passing 0, when the wallet holds exactly the debt plus headroom', async () => {
    const { events, calls, errors } = await run(solvent({ balance: FULL_FLOAT }));

    expect(calls).toEqual([
      ['approve', FULL_FLOAT],
      ['liquidate', 0n],
    ]);
    expect(partialEvent(events)).toBeUndefined();
    expect(errors).toEqual([]);
  });

  it('sends the largest partial when the wallet is one wei short of the debt plus headroom', async () => {
    const { events, calls, errors } = await run(solvent({ balance: FULL_FLOAT - 1n }));

    expect(calls).toEqual([
      ['approve', MAX_PARTIAL],
      ['liquidate', MAX_PARTIAL],
    ]);
    expect(partialEvent(events)).toMatchObject({
      level: 'warn',
      fields: {
        owner: OWNER_A,
        functionName: 'liquidate',
        hash: TX_HASH,
        debt: DEBT,
        repaying: MAX_PARTIAL,
        uncoveredDebt: MIN_DEBT,
        keeperGsusdBalance: FULL_FLOAT - 1n,
        requiredKeeperGsusd: FULL_FLOAT,
      },
    });
    expect(errors).toEqual([]);
  });

  it('never sends the debt itself as a partial when the balance equals the debt', async () => {
    const { calls } = await run(solvent({ balance: DEBT }));

    expect(calls).toEqual([
      ['approve', MAX_PARTIAL],
      ['liquidate', MAX_PARTIAL],
    ]);
  });

  it('sends the largest partial when the balance is one wei short of the debt', async () => {
    const { calls } = await run(solvent({ balance: DEBT - 1n }));

    expect(calls).toEqual([
      ['approve', MAX_PARTIAL],
      ['liquidate', MAX_PARTIAL],
    ]);
  });

  it('spends the whole balance when that leaves more than minDebt behind', async () => {
    const balance = 4_000n * E18;
    const { events, calls } = await run(solvent({ balance }));

    expect(calls).toEqual([
      ['approve', balance],
      ['liquidate', balance],
    ]);
    expect(partialEvent(events)?.fields).toMatchObject({ repaying: balance, uncoveredDebt: DEBT - balance });
  });

  it('sends a partial of exactly minDebt, the smallest worth sending', async () => {
    const { calls } = await run(solvent({ balance: MIN_DEBT }));

    expect(calls).toEqual([
      ['approve', MIN_DEBT],
      ['liquidate', MIN_DEBT],
    ]);
  });

  it('sizes the partial from the principal, which the vault retires pro rata', async () => {
    // 9,000 of principal under 10,000 of debt: repaying x retires 0.9x, so 8,888.88... leaves
    // exactly minDebt of principal. One wei more would strand less than the minimum.
    const principal = 9_000n * E18;
    const expected = (DEBT * (principal - MIN_DEBT)) / principal;
    const { calls } = await run(
      solvent({ vaults: { [OWNER_A]: { debt: DEBT, ratio: 1_060_000n, principal } }, balance: DEBT })
    );

    expect(calls).toEqual([
      ['approve', expected],
      ['liquidate', expected],
    ]);
    expect(principal - (principal * expected) / DEBT).toBeGreaterThanOrEqual(MIN_DEBT);
    expect(principal - (principal * (expected + E18)) / DEBT).toBeLessThan(MIN_DEBT);
  });

  it.each([
    ['one wei below minDebt', MIN_DEBT - 1n],
    ['one wei', 1n],
    ['zero', 0n],
  ])('stays unfunded and pages the vault with a balance of %s', async (_label, balance) => {
    const { events, calls, errors } = await run(solvent({ balance }));

    expect(calls).toEqual([]);
    expect(partialEvent(events)).toBeUndefined();
    expect(errors.map((entry) => entry.event)).toContain('vault.liquidation-blocked');
  });

  it('stays unfunded when any partial would leave less than minDebt of principal', async () => {
    // A vault of 1,500 with a 1,000 minimum: a partial must be at least 1,000 and may be at
    // most 500, so none exists.
    const debt = 1_500n * E18;
    const { calls, errors } = await run(
      solvent({
        vaults: { [OWNER_A]: { debt, ratio: 1_060_000n } },
        collateralAmount: 795n * 10n ** 15n,
        balance: 1_400n * E18,
      })
    );

    expect(calls).toEqual([]);
    expect(errors.map((entry) => entry.event)).toContain('vault.liquidation-blocked');
  });

  it('stays unfunded for a vault at exactly minDebt, which no partial can leave valid', async () => {
    const { calls } = await run(
      solvent({
        vaults: { [OWNER_A]: { debt: MIN_DEBT, ratio: 1_060_000n } },
        collateralAmount: 53n * 10n ** 16n,
        balance: MIN_DEBT,
      })
    );

    expect(calls).toEqual([]);
  });

  it('sends no partial into an underwater vault, which takes only a full liquidation', async () => {
    // 4.9 oz at $2,000 is 9,800, below the 10,000 of debt.
    const { events, calls, errors } = await run(solvent({ balance: DEBT, collateralAmount: 49n * 10n ** 17n }));

    expect(calls).toEqual([]);
    expect(partialEvent(events)).toBeUndefined();
    expect(errors.map((entry) => entry.event)).toContain('vault.liquidation-blocked');
  });

  it('sends a partial into a thin but solvent vault, which takes one pro rata', async () => {
    // 5.1 oz is 10,200: above the debt, below the debt plus the 5% penalty.
    const { calls } = await run(solvent({ balance: 4_000n * E18, collateralAmount: 51n * 10n ** 17n }));

    expect(calls).toEqual([
      ['approve', 4_000n * E18],
      ['liquidate', 4_000n * E18],
    ]);
  });

  it('sizes no partial while minDebt has never been read', async () => {
    const { calls, errors } = await run(solvent({ balance: 4_000n * E18, minDebtUnreadable: true }));

    expect(calls).toEqual([]);
    expect(errors.map((entry) => entry.event)).toContain('vault.liquidation-blocked');
  });

  it('skips the approval when the allowance already covers the partial', async () => {
    const { calls } = await run(solvent({ balance: 4_000n * E18, allowance: 4_000n * E18 }));

    expect(calls).toEqual([['liquidate', 4_000n * E18]]);
  });

  it('reports a partial refused in simulation, revokes the allowance and announces no partial', async () => {
    const { events, calls, errors } = await run(solvent({ balance: 4_000n * E18 }), {
      receiptStatus: 'success',
      failing: ['liquidate'],
    });

    expect(calls).toEqual([
      ['approve', 4_000n * E18],
      ['liquidate', 4_000n * E18],
      ['approve', 0n],
    ]);
    expect(partialEvent(events)).toBeUndefined();
    expect(errors.map((entry) => entry.event)).toEqual(['keeper.tx-failed']);
  });

  it('reports a partial that reverted on chain as keeper.tx-failed and revokes the allowance', async () => {
    const { calls, errors } = await run(solvent({ balance: 4_000n * E18 }), {
      receiptSequence: ['success', 'reverted', 'success'],
    });

    expect(calls.map(([name]) => name)).toEqual(['approve', 'liquidate', 'approve']);
    expect(errors.map((entry) => entry.event)).toEqual(['keeper.tx-failed']);
  });

  it('keeps the allowance and sends nothing more when the receipt of the partial cannot be read', async () => {
    const { calls, errors } = await run(solvent({ balance: 4_000n * E18 }), {
      receiptSequence: ['success', 'throw'],
    });

    expect(calls.map(([name]) => name)).toEqual(['approve', 'liquidate']);
    expect(errors.map((entry) => entry.event)).toEqual(['keeper.tx-outcome-unknown']);
  });

  it('takes what it can of the residual a partial pool fill leaves, sized from the vault as it then stands', async () => {
    // The pool holds 4,001 and absorbs one wei less; the stub vault still reads 10,000 of
    // debt, so the direct path sizes its partial against that with the 3,000 the wallet holds.
    const { calls, events } = await run(solvent({ totalDeposits: 4_001n * E18, balance: 3_000n * E18 }));

    expect(calls).toEqual([
      ['liquidateViaPool', 4_001n * E18 - 1n],
      ['approve', 3_000n * E18],
      ['liquidate', 3_000n * E18],
    ]);
    expect(partialEvent(events)?.fields).toMatchObject({ repaying: 3_000n * E18 });
  });

  it('sends the partial through emergencyLiquidate while the vault is paused', async () => {
    const { events, calls, errors } = await run(solvent({ balance: 4_000n * E18, vaultPaused: true }));

    expect(calls).toEqual([
      ['approve', 4_000n * E18],
      ['emergencyLiquidate', 4_000n * E18],
    ]);
    expect(partialEvent(events)?.fields).toMatchObject({
      functionName: 'emergencyLiquidate',
      uncoveredDebt: 6_000n * E18,
    });
    expect(errors).toEqual([]);
  });

  it('sends no partial through emergencyLiquidate into a vault underwater at the emergency price', async () => {
    const { calls, errors } = await run(
      solvent({ balance: 4_000n * E18, vaultPaused: true, collateralAmount: 49n * 10n ** 17n })
    );

    expect(calls).toEqual([]);
    expect(errors.map((entry) => entry.event)).toContain('vault.liquidation-blocked');
  });
});

describe('sizeDirectPartial', () => {
  const E18 = 10n ** 18n;
  const DEBT = 3_000n * E18;
  const MIN = 1_000n * E18;

  it('is always strictly below the debt, however large the balance', () => {
    expect(sizeDirectPartial(DEBT, DEBT, DEBT * 5n, MIN)).toBe(2_000n * E18);
    expect(sizeDirectPartial(DEBT, DEBT, DEBT * 5n, 1n)).toBe(DEBT - 1n);
  });

  it('spends the balance when that leaves at least minDebt of principal', () => {
    expect(sizeDirectPartial(DEBT, DEBT, 1_500n * E18, MIN)).toBe(1_500n * E18);
    expect(sizeDirectPartial(DEBT, DEBT, 2_000n * E18, MIN)).toBe(2_000n * E18);
    expect(sizeDirectPartial(DEBT, DEBT, 2_000n * E18 + 1n, MIN)).toBe(2_000n * E18);
  });

  it('is undefined below minDebt, at zero and for a debt no partial can split', () => {
    expect(sizeDirectPartial(DEBT, DEBT, MIN - 1n, MIN)).toBeUndefined();
    expect(sizeDirectPartial(DEBT, DEBT, 0n, MIN)).toBeUndefined();
    expect(sizeDirectPartial(MIN, MIN, MIN, MIN)).toBeUndefined();
    expect(sizeDirectPartial(2n * MIN - 1n, 2n * MIN - 1n, 2n * MIN, MIN)).toBeUndefined();
    expect(sizeDirectPartial(1n, 1n, 1n, 1n)).toBeUndefined();
    expect(sizeDirectPartial(0n, 0n, 5n, 1n)).toBeUndefined();
  });

  it('is exactly minDebt for a vault of twice the minimum', () => {
    expect(sizeDirectPartial(2n * MIN, 2n * MIN, 2n * MIN, MIN)).toBe(MIN);
  });

  it('is undefined while minDebt is unknown', () => {
    expect(sizeDirectPartial(DEBT, DEBT, 2_000n * E18, undefined)).toBeUndefined();
  });
});

// A failed minDebt read used to fall back to the
// deploy default of 100 GSUSD, a tenth of the mainnet minimum: a partial pool absorb sized
// with it left less principal than the vault allows and reverted, and a wallet too small for
// the smallest vault counted as an armed direct path. The watch now reads minDebt once per
// sending tick and, when that read fails, uses the value it last read and never a constant.
describe('the liquidation watch when GoldVault.minDebt cannot be read', () => {
  const E18 = 10n ** 18n;
  const MIN_DEBT = 1_000n * E18;
  const DEBT = 3_000n * E18;
  const healthy = { [OWNER_A]: { debt: DEBT, principal: DEBT, ratio: 1_200_000n } };
  const liquidatable = { [OWNER_A]: { debt: DEBT, principal: DEBT, ratio: 1_050_000n } };
  /** A 3,000 GSUSD vault on two ounces, solvent at $2,000, against a pool of 2,500. */
  const poolProfile = (overrides: Partial<ReadStubOptions> = {}): ReadStubOptions => ({
    vaults: healthy,
    pool: POOL,
    collateralAmount: 2n * E18,
    totalDeposits: 2_500n * E18,
    minDebt: MIN_DEBT,
    ...overrides,
  });
  const unreadable = (events: LoggedEvent[]): LoggedEvent[] =>
    events.filter((entry) => entry.event === 'keeper.min-debt-unreadable');

  it('sizes a partial pool absorb with the minDebt it last read', async () => {
    const watch = createLiquidationWatch();
    const readOptions = poolProfile();
    const { tx, sends } = createStubTx();
    const { deps, events } = createDeps(createStubRead(readOptions), tx, [OWNER_A]);

    await watch(deps, baseConfig());
    expect(sends).toEqual([]);
    expect(unreadable(events)).toEqual([]);

    readOptions.vaults = liquidatable;
    readOptions.minDebtUnreadable = true;
    await watch(deps, baseConfig());

    // 2,000 leaves 1,000 of principal. The old 100 GSUSD fallback sized 2,500 less one wei,
    // which leaves 500 and which the vault refuses.
    expect(sends).toEqual([
      { address: VAULT, functionName: 'liquidateViaPool', args: [OWNER_A, 2_000n * E18] },
    ]);
    expect(unreadable(events)).toEqual([
      {
        level: 'warn',
        event: 'keeper.min-debt-unreadable',
        fields: { job: 'liquidation-watch', reason: 'minDebt read failed', lastKnownMinDebt: MIN_DEBT },
      },
    ]);
  });

  it('reads minDebt afresh every tick, so a governed change applies on the next one', async () => {
    const watch = createLiquidationWatch();
    const readOptions = poolProfile();
    const { tx, sends } = createStubTx();
    const { deps, events } = createDeps(createStubRead(readOptions), tx, [OWNER_A]);

    await watch(deps, baseConfig());
    readOptions.vaults = liquidatable;
    readOptions.minDebt = 500n * E18;
    await watch(deps, baseConfig());

    // At a 500 GSUSD minimum the whole absorbable pool, 2,500 less one wei, is a legal partial.
    expect(sends).toEqual([
      { address: VAULT, functionName: 'liquidateViaPool', args: [OWNER_A, 2_500n * E18 - 1n] },
    ]);
    expect(unreadable(events)).toEqual([]);
  });

  it('sends no partial pool absorb when minDebt was never read, and still tries the direct path', async () => {
    const { tx, sends } = createStubTx();
    const { deps, events } = createDeps(
      createStubRead(
        poolProfile({
          vaults: liquidatable,
          minDebtUnreadable: true,
          balance: 5_000n * E18,
          allowance: 5_000n * E18,
        })
      ),
      tx,
      [OWNER_A]
    );

    await runLiquidationWatch(deps, baseConfig({ enableDirect: true }));

    expect(sends).toEqual([{ address: VAULT, functionName: 'liquidate', args: [OWNER_A, 0n] }]);
    expect(unreadable(events).map((entry) => entry.fields)).toEqual([
      { job: 'liquidation-watch', reason: 'minDebt read failed', lastKnownMinDebt: undefined },
    ]);
    const underfunded = events.find((entry) => entry.event === 'vault.pool-underfunded');
    expect(underfunded?.fields).toMatchObject({ owner: OWNER_A, debt: DEBT });
    expect(String(underfunded?.fields?.['detail'])).toContain('minDebt');
  });

  it('still absorbs a whole vault through the pool when minDebt was never read', async () => {
    const { tx, sends } = createStubTx();
    const { deps } = createDeps(
      createStubRead(
        poolProfile({ vaults: liquidatable, minDebtUnreadable: true, totalDeposits: 5_000n * E18 })
      ),
      tx,
      [OWNER_A]
    );

    await runLiquidationWatch(deps, baseConfig());

    expect(sends).toEqual([
      { address: VAULT, functionName: 'liquidateViaPool', args: [OWNER_A, 0n] },
    ]);
  });

  it('does not read minDebt in a dry run, which sizes nothing', async () => {
    const { deps, events } = createDeps(
      createStubRead(poolProfile({ vaults: liquidatable, minDebtUnreadable: true })),
      undefined,
      [OWNER_A]
    );

    await runLiquidationWatch(deps, baseConfig({ dryRun: true }));

    expect(unreadable(events)).toEqual([]);
    expect(eventNames(events)).toContain('vault.liquidatable');
  });

  // The open launch profile of the float tests above: an unlimited ceiling and an empty pool,
  // so the direct float decides whether any path is armed.
  const openProfile = (overrides: Partial<ReadStubOptions> = {}): ReadStubOptions => ({
    vaults: healthy,
    collateralAmount: 2n * E18,
    debtCeiling: 2n ** 256n - 1n,
    totalDeposits: 0n,
    minDebt: MIN_DEBT,
    balance: 20_000n * E18,
    allowance: 0n,
    ...overrides,
  });
  const pages = (events: LoggedEvent[]): LoggedEvent[] =>
    events.filter((entry) => entry.event === 'keeper.no-liquidation-path');

  it('never counts the direct path as armed against a minDebt it has not read', async () => {
    const { tx, sends } = createStubTx();
    const { deps, events } = createDeps(
      createStubRead(openProfile({ vaults: liquidatable, minDebtUnreadable: true })),
      tx,
      [OWNER_A]
    );

    await runLiquidationWatch(deps, baseConfig({ enableDirect: true }));

    const [page] = pages(events);
    expect(page?.level).toBe('error');
    expect(page?.fields).toMatchObject({
      keeperGsusdBalance: 20_000n * E18,
      minimumDirectFloat: undefined,
      enableDirect: true,
    });
    expect(String(page?.fields?.['detail'])).toContain('GoldVault.minDebt has not been readable');
    // The liquidation itself is sized by the vault's debt, so it still goes through.
    expect(sends.map((entry) => entry.functionName)).toEqual(['approve', 'liquidate']);
  });

  it('judges the direct float against the minDebt it last read', async () => {
    const watch = createLiquidationWatch();
    const readOptions = openProfile();
    const { tx } = createStubTx();
    const { deps, events } = createDeps(createStubRead(readOptions), tx, [OWNER_A]);

    await watch(deps, baseConfig({ enableDirect: true }));
    readOptions.minDebtUnreadable = true;
    await watch(deps, baseConfig({ enableDirect: true }));

    expect(unreadable(events)).toHaveLength(1);
    expect(pages(events)).toEqual([]);

    // A wallet below the remembered minimum still pages, with the figure it was held to.
    readOptions.balance = MIN_DEBT;
    await watch(deps, baseConfig({ enableDirect: true }));

    expect(pages(events).map((entry) => entry.fields?.['minimumDirectFloat'])).toEqual([
      MIN_DEBT + MIN_DEBT / 100n + 1n,
    ]);
  });
});

// The readiness preflight reads the pool and the
// keeper wallet unguarded, and one failed read used to abort the tick before the owner walk,
// so a vault that had crossed its line waited for the next tick.
describe('the liquidation watch when the readiness preflight cannot read', () => {
  it('reports the failed preflight and still liquidates in the same tick', async () => {
    const { tx, sends } = createStubTx();
    const { deps, events } = createDeps(
      createStubRead({
        vaults: { [OWNER_A]: { debt: 100n, ratio: 1_000_000n } },
        pool: POOL,
        totalDeposits: 1_000n,
        totalDepositsFailures: { remaining: 1 },
      }),
      tx,
      [OWNER_A]
    );

    await runLiquidationWatch(deps, baseConfig());

    expect(sends).toEqual([
      { address: VAULT, functionName: 'liquidateViaPool', args: [OWNER_A, 0n] },
    ]);
    expect(events.filter((entry) => entry.event === 'keeper.job-error')).toEqual([
      {
        level: 'error',
        event: 'keeper.job-error',
        fields: { job: 'liquidation-watch', step: 'readiness', reason: 'fetch failed' },
      },
    ]);
  });
});

// Under LAUNCH_CAPS=open the PAXG ceiling is
// MaxUint256, so a pool measured against it could never clear and a pool-only keeper paged
// keeper.no-liquidation-path every tick however deep the pool was. With an unlimited ceiling
// the pool is measured against the largest vault debt of the tick's sweep, or minDebt.
describe('the readiness preflight under the open launch profile', () => {
  const E18 = 10n ** 18n;
  const MIN_DEBT = 1_000n * E18;
  const LARGEST = 8_000n * E18;
  const UNLIMITED = 2n ** 256n - 1n;
  const healthyVaults = {
    [OWNER_A]: { debt: 3_000n * E18, ratio: 1_500_000n },
    [OWNER_B]: { debt: LARGEST, ratio: 1_500_000n },
  };
  const pages = (events: LoggedEvent[]): LoggedEvent[] =>
    events.filter((entry) => entry.event === 'keeper.no-liquidation-path');

  const run = async (options: { totalDeposits: bigint; debtCeiling: bigint; multicall: boolean }) => {
    const base = createStubRead({
      vaults: healthyVaults,
      debtCeiling: options.debtCeiling,
      totalDeposits: options.totalDeposits,
      minDebt: MIN_DEBT,
    });
    const { tx, sends } = createStubTx();
    const { deps, events } = createDeps(options.multicall ? withMulticall(base) : base, tx, [
      OWNER_A,
      OWNER_B,
    ]);
    await runLiquidationWatch(deps, baseConfig());
    return { events, sends };
  };

  it('counts a pool deeper than the largest vault debt as armed', async () => {
    const { events } = await run({ totalDeposits: LARGEST + 1n, debtCeiling: UNLIMITED, multicall: true });

    expect(pages(events)).toEqual([]);
  });

  it('pages a pool that cannot take the largest vault and names that yardstick', async () => {
    const { events } = await run({ totalDeposits: LARGEST, debtCeiling: UNLIMITED, multicall: true });

    const [page] = pages(events);
    expect(page?.level).toBe('error');
    expect(page?.fields).toMatchObject({
      stabilityPoolDeposits: LARGEST,
      poolYardstick: 'largest-vault-debt',
      poolYardstickAmount: LARGEST,
    });
    expect(String(page?.fields?.['detail'])).toContain('largest vault debt');
    expect(String(page?.fields?.['detail'])).not.toContain('below the debt ceiling');
    // A pool holding something still takes smaller vaults, so the line must not say otherwise.
    expect(String(page?.fields?.['detail'])).toContain('cannot liquidate the largest vault');
    expect(String(page?.fields?.['detail'])).not.toContain('can alert but cannot liquidate');
  });

  it('measures the pool against minDebt when the client cannot batch the debts', async () => {
    const armed = await run({ totalDeposits: MIN_DEBT + 1n, debtCeiling: UNLIMITED, multicall: false });
    expect(pages(armed.events)).toEqual([]);

    const unarmed = await run({ totalDeposits: MIN_DEBT, debtCeiling: UNLIMITED, multicall: false });
    expect(pages(unarmed.events)[0]?.fields).toMatchObject({
      poolYardstick: 'min-debt',
      poolYardstickAmount: MIN_DEBT,
    });
  });

  it('keeps the debt ceiling as the yardstick of a capped deployment', async () => {
    const ceiling = 250_000n * E18;
    const { events } = await run({ totalDeposits: 100_000n * E18, debtCeiling: ceiling, multicall: true });

    const [page] = pages(events);
    expect(page?.fields).toMatchObject({ poolYardstick: 'debt-ceiling', poolYardstickAmount: ceiling });
    expect(String(page?.fields?.['detail'])).toContain('below the debt ceiling');
    expect(pages((await run({ totalDeposits: ceiling, debtCeiling: ceiling, multicall: true })).events)).toEqual(
      []
    );
  });
});

describe('sizePoolAbsorb', () => {
  const E18 = 10n ** 18n;

  it('absorbs the whole debt, as 0, when the pool covers it, whatever minDebt is', () => {
    expect(sizePoolAbsorb(300n * E18, 300n * E18, 300n * E18, 100n * E18)).toBe(0n);
    expect(sizePoolAbsorb(300n * E18, 300n * E18, 300n * E18, undefined)).toBe(0n);
  });

  it('leaves minDebt of principal behind', () => {
    expect(sizePoolAbsorb(3_000n * E18, 3_000n * E18, 2_500n * E18, 1_000n * E18)).toBe(2_000n * E18);
    expect(sizePoolAbsorb(3_000n * E18, 3_000n * E18, 2_500n * E18, 100n * E18)).toBe(2_500n * E18);
  });

  it('refuses a partial smaller than minDebt', () => {
    expect(sizePoolAbsorb(3_000n * E18, 3_000n * E18, 999n * E18, 1_000n * E18)).toBeUndefined();
  });

  it('sizes no partial without a minDebt to size it against', () => {
    expect(sizePoolAbsorb(3_000n * E18, 3_000n * E18, 2_500n * E18, undefined)).toBeUndefined();
  });
});

describe('fullLiquidationRepay', () => {
  const base = {
    collateralAmount: 10n ** 18n,
    decimals: 18,
    price: 200_000_000_000n,
    penaltyPpm: 50_000n,
    discountPpm: 20_000n,
  };
  const gsusd = (units: bigint): bigint => units * 10n ** 18n;

  it('repays the whole debt while the vault is not in the full-only band', () => {
    expect(fullLiquidationRepay({ ...base, debt: gsusd(1_800n) })).toBe(gsusd(1_800n));
  });

  it('repays the whole debt in the full-only band while the gold still covers it', () => {
    expect(fullLiquidationRepay({ ...base, debt: gsusd(1_950n) })).toBe(gsusd(1_950n));
  });

  it('repays the gold value less the discount once underwater', () => {
    // 90% collateralised: 2,000 * 0.98 = 1,960, above the cap 2 * 2,000 - 2,222.22.
    const debt = (gsusd(2_000n) * 1_000_000n) / 900_000n;
    expect(fullLiquidationRepay({ ...base, debt })).toBe(gsusd(1_960n));
  });

  it('never lets the discount exceed the shortfall just under 100%', () => {
    // Shortfall 10: 2 * 2,000 - 2,010 = 1,990 beats the discounted 1,960.
    expect(fullLiquidationRepay({ ...base, debt: gsusd(2_010n) })).toBe(gsusd(1_990n));
  });

  it('applies the plain discount when the vault is under half collateralised', () => {
    expect(fullLiquidationRepay({ ...base, debt: gsusd(5_000n) })).toBe(gsusd(1_960n));
  });

  it('values six-decimal collateral in 18 decimals', () => {
    expect(
      fullLiquidationRepay({ ...base, collateralAmount: 1_000_000n, decimals: 6, debt: gsusd(5_000n) })
    ).toBe(gsusd(1_960n));
  });
});

describe('isThinVault', () => {
  const base = {
    collateralAmount: 10n ** 18n,
    decimals: 18,
    price: 200_000_000_000n,
    penaltyPpm: 50_000n,
  };

  it('is false while the collateral covers the debt plus the whole penalty', () => {
    expect(isThinVault({ ...base, debt: 1_904n * 10n ** 18n })).toBe(false);
  });

  it('is true one wei past the band edge', () => {
    // 2000 / 1.05 = 1904.76...: at 1,905 GSUSD the penalty no longer fits.
    expect(isThinVault({ ...base, debt: 1_905n * 10n ** 18n })).toBe(true);
  });

  it('mirrors _sizeSeizure one unit either side of the fit', () => {
    const priceScale = 200_000_000_000n;
    const fits = (debt: bigint): boolean =>
      (debt * 1_050_000n * 10n ** 8n) / (priceScale * 1_000_000n) <= 10n ** 18n;
    for (const debt of [1_904_761_904_761_904_761_904n, 1_904_761_904_761_904_761_905n, 1_905n * 10n ** 18n]) {
      expect(isThinVault({ ...base, debt })).toBe(!fits(debt));
    }
  });

  it('scales native decimals to 18 before valuing the collateral', () => {
    expect(isThinVault({ ...base, collateralAmount: 1_000_000n, decimals: 6, debt: 1_905n * 10n ** 18n })).toBe(true);
    expect(isThinVault({ ...base, collateralAmount: 1_000_000n, decimals: 6, debt: 1_904n * 10n ** 18n })).toBe(false);
  });
});

describe('requiresFullLiquidation', () => {
  const base = {
    collateralAmount: 10n ** 18n,
    decimals: 18,
    price: 200_000_000_000n,
    penaltyPpm: 50_000n,
  };

  it('is false for a thin vault whose gold still covers the debt: a pro-rata partial is allowed', () => {
    expect(requiresFullLiquidation({ ...base, debt: 1_950n * 10n ** 18n })).toBe(false);
    expect(requiresFullLiquidation({ ...base, debt: 2_000n * 10n ** 18n })).toBe(false);
  });

  it('is true one wei underwater, where the vault refuses a partial', () => {
    expect(requiresFullLiquidation({ ...base, debt: 2_000n * 10n ** 18n + 1n })).toBe(true);
  });

  it('scales native decimals to 18 before valuing the collateral', () => {
    const xaut = { ...base, collateralAmount: 1_000_000n, decimals: 6 };
    expect(requiresFullLiquidation({ ...xaut, debt: 1_950n * 10n ** 18n })).toBe(false);
    expect(requiresFullLiquidation({ ...xaut, debt: 2_100n * 10n ** 18n })).toBe(true);
  });

  it('reads the underwater line off a ppm ratio for the degraded path', () => {
    expect(requiresFullLiquidationByRatio(999_999n)).toBe(true);
    expect(requiresFullLiquidationByRatio(1_000_000n)).toBe(false);
    expect(requiresFullLiquidationByRatio(1_025_000n)).toBe(false);
  });
});
