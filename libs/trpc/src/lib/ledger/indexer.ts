import { describeError } from '../config/redact';
import { isRangeError, MIN_BLOCK_RANGE, narrowerSpan, startingSpan } from '../indexer/vaultOwnerIndexer';
import type { Address } from 'viem';
import type { LedgerAccount } from './account';
import type { LedgerChainClient } from './chainClient';
import type { LedgerMeta } from './codec';
import type { LedgerConfig } from './env';
import { LedgerIntegrityError, LedgerLiquiditySourceError } from './errors';
import { decodeLedgerLogs, isVaultDebtEvent } from './events';
import type { PreparedEvents } from './liquidityIndex';
import type { LedgerEvent } from './events';
import {
  DEBT_AUDIT_ACCOUNTS_PER_RUN,
  MAX_REBUILDS_PER_DAY,
  MAX_RUN_MS,
  MAX_TRACKED_LIQUIDITY_POSITIONS,
  MAX_WINDOWS_PER_RUN,
  MIN_TRACKED_POOL_DEPOSIT,
} from './limits';
import { liquidityLimits } from './liquidity';
import type { LiquidityPosition, LiquiditySource, LiquidityState } from './liquidity';
import { checkLiquidityAgainstChain, prepareLiquidityEvents } from './liquidityIndex';
import { resolveLiquiditySource } from './liquiditySource';
import { decodePool, encodePool, genesisMeta, newStateId, ledgerFingerprint, recentRebuilds } from './meta';
import type { PoolState } from './poolMirror';
import { applyEvents } from './replay';
import type { LedgerStore } from './store';

/** What the worker process remembers between runs, so an idle run reads almost nothing. */
export interface IndexerMemory {
  /** The stateId the in-memory accounts correspond to; null when they must be reloaded. */
  stateId: string | null;
  accounts: ReadonlyMap<string, LedgerAccount>;
  /** Where the next debt audit starts among the accounts that owe. */
  debtAuditOffset: number;
  /** The tracked liquidity positions, keyed by token id; empty while the dimension is off. */
  positions: ReadonlyMap<string, LiquidityPosition>;
  /** The liquidity pool as the chain described it, once read and checked; null before that and while the dimension is off. */
  liquiditySource: LiquiditySource | null;
  /** Where the next liquidity audit starts among the tracked positions. */
  positionAuditOffset: number;
}

export const createIndexerMemory = (): IndexerMemory => ({
  stateId: null,
  accounts: new Map(),
  debtAuditOffset: 0,
  positions: new Map(),
  liquiditySource: null,
  positionAuditOffset: 0,
});

/** Forgets the indexed state so the next run reloads it. */
const dropMemory = (memory: IndexerMemory): void => {
  memory.stateId = null;
  memory.accounts = new Map();
  memory.positions = new Map();
};

const TIMESTAMP_FETCH_CONCURRENCY = 8;

interface RunContext {
  client: LedgerChainClient;
  store: LedgerStore;
  config: LedgerConfig;
  memory: IndexerMemory;
  clock: () => number;
  /** Block timestamps fetched during this run. */
  timestamps: Map<bigint, number>;
}

const fetchTimestamps = async (context: RunContext, blocks: readonly bigint[]): Promise<void> => {
  const missing = [...new Set(blocks)].filter((block) => !context.timestamps.has(block));
  for (let start = 0; start < missing.length; start += TIMESTAMP_FETCH_CONCURRENCY) {
    const batch = missing.slice(start, start + TIMESTAMP_FETCH_CONCURRENCY);
    const fetched = await Promise.all(batch.map((block) => context.client.getBlockTimestamp(block)));
    batch.forEach((block, index) => context.timestamps.set(block, fetched[index]));
  }
};

const principalKey = (block: bigint, account: string): string => `${block}:${account.toLowerCase()}`;

/**
 * Gives every vault event the principal the vault holds for its owner at the end of the
 * event's block. The tracked debt then is the contract's own figure: a repayment or a
 * liquidation retires less principal than its event amount, which includes the fee.
 */
const withPrincipals = async (context: RunContext, events: readonly LedgerEvent[]): Promise<LedgerEvent[]> => {
  const ownersByBlock = new Map<bigint, Set<Address>>();
  for (const event of events) {
    if (!isVaultDebtEvent(event)) continue;
    const owners = ownersByBlock.get(event.block) ?? new Set<Address>();
    owners.add(event.account);
    ownersByBlock.set(event.block, owners);
  }
  const principals = new Map<string, bigint>();
  for (const [block, ownerSet] of ownersByBlock) {
    const owners = [...ownerSet];
    const debts = await context.client.readVaultDebts(block, owners);
    if (debts.length !== owners.length) {
      throw new Error(`the vault debt read at block ${block} answered ${debts.length} of ${owners.length} owners`);
    }
    owners.forEach((owner, index) => principals.set(principalKey(block, owner), debts[index]));
  }
  return events.map((event) =>
    isVaultDebtEvent(event) ? { ...event, principal: principals.get(principalKey(event.block, event.account)) } : event
  );
};

/** Step 1: the meta to work from, after a rebuild when the stored one cannot be used. */
const usableMeta = async (context: RunContext): Promise<LedgerMeta> => {
  const { store, config, memory, clock } = context;
  const stored = await store.readMeta();
  if (stored !== undefined && stored.fingerprint === ledgerFingerprint(config)) return stored;
  console.warn(
    stored === undefined
      ? `Usage ledger index has no readable state; computing the whole ledger from the deploy block ${config.deployBlock}.`
      : `Usage ledger index was computed under another configuration; recomputing the whole ledger from the deploy block ${config.deployBlock}.`
  );
  const fresh = genesisMeta(config, recentRebuilds(stored?.rebuilds ?? [], clock()));
  await store.reset(fresh);
  dropMemory(memory);
  return fresh;
};

/** Steps 2 and 3: bring the process memory in line with the store. */
const syncMemory = async (context: RunContext, meta: LedgerMeta): Promise<void> => {
  const { store, memory } = context;
  if (memory.stateId !== meta.stateId) {
    const accounts = await store.loadAccounts();
    if (accounts.size !== meta.accounts) {
      throw new LedgerIntegrityError(
        `the store holds ${accounts.size} account records but its meta counts ${meta.accounts}`
      );
    }
    const positions = await store.loadPositions();
    if (positions.size !== (meta.lp?.positions ?? 0)) {
      throw new LedgerIntegrityError(
        `the store holds ${positions.size} liquidity position records but its meta counts ${meta.lp?.positions ?? 0}`
      );
    }
    memory.accounts = accounts;
    memory.positions = positions;
    memory.stateId = meta.stateId;
  }
};

/** Adopts a commit the store accepted, or forgets everything when it refused. */
const adopt = (
  memory: IndexerMemory,
  accepted: boolean,
  meta: LedgerMeta,
  accounts: ReadonlyMap<string, LedgerAccount>,
  positions: ReadonlyMap<string, LiquidityPosition> = memory.positions
): boolean => {
  if (!accepted) {
    console.warn('Usage ledger index state was changed by another writer; this run stops and the next reloads it.');
    dropMemory(memory);
    return false;
  }
  memory.accounts = accounts;
  memory.positions = positions;
  memory.stateId = meta.stateId;
  return true;
};

/** The liquidity dimension's state as the meta and the process memory hold it. */
const liquidityOf = (meta: LedgerMeta, memory: IndexerMemory): LiquidityState => ({
  tick: meta.lp?.tick ?? null,
  positions: memory.positions,
});

/** Step 7 for one window: apply its events and commit. Undefined when the commit was refused. */
const applyWindow = async (
  context: RunContext,
  meta: LedgerMeta,
  prepared: PreparedEvents,
  end: bigint
): Promise<LedgerMeta | undefined> => {
  const { store, config, memory } = context;
  const source = memory.liquiditySource ?? undefined;
  const liquidity = liquidityOf(meta, memory);
  await fetchTimestamps(context, [...prepared.timedBlocks, end]);
  const events = await withPrincipals(context, prepared.events);
  const { state, dirty, positionsDirty, positionsRemoved } = applyEvents(
    {
      pool: decodePool(meta.pool),
      accounts: memory.accounts,
      truncated: meta.truncated,
      ...(source === undefined ? {} : { liquidity }),
    },
    events,
    context.timestamps,
    {
      start: config.startTimestamp,
      maxAccounts: config.maxAddresses,
      minTrackedDeposit: MIN_TRACKED_POOL_DEPOSIT,
      ...(source === undefined ? {} : { liquidity: liquidityLimits(source) }),
    }
  );
  const positions = state.liquidity?.positions ?? memory.positions;
  const changedPositions = new Map<string, LiquidityPosition>();
  for (const tokenId of positionsDirty) {
    const position = positions.get(tokenId);
    if (position !== undefined) changedPositions.set(tokenId, position);
  }
  const changed = new Map<string, LedgerAccount>();
  for (const address of dirty) {
    const account = state.accounts.get(address);
    if (account !== undefined) changed.set(address, account);
  }
  const next: LedgerMeta = {
    ...meta,
    stateId: newStateId(),
    cursor: end.toString(),
    asOfTimestamp: context.timestamps.get(end) ?? meta.asOfTimestamp,
    pool: encodePool(state.pool),
    accounts: state.accounts.size,
    truncated: state.truncated,
    ...(state.liquidity === undefined ? {} : { lp: { tick: state.liquidity.tick, positions: positions.size } }),
  };
  const accepted = await store.commit(meta.stateId, {
    meta: next,
    accounts: changed,
    ...(source === undefined ? {} : { positions: changedPositions, positionsRemoved: [...positionsRemoved] }),
  });
  return adopt(memory, accepted, next, state.accounts, positions) ? next : undefined;
};

type ScanOutcome = { reached: true; meta: LedgerMeta } | { reached: false };

/** Steps 5 to 7: windows from the cursor to the target. */
const scan = async (context: RunContext, start: LedgerMeta, from: bigint, target: bigint): Promise<ScanOutcome> => {
  const { client, clock } = context;
  const startedAt = clock();
  let meta = start;
  let span = startingSpan(context.config.maxBlockRange);
  let next = from;
  let windows = 0;
  while (next <= target) {
    if (windows >= MAX_WINDOWS_PER_RUN || clock() - startedAt >= MAX_RUN_MS) return { reached: false };
    const end = next + span - 1n < target ? next + span - 1n : target;
    let prepared: PreparedEvents;
    try {
      // The liquidity dimension's own log queries cover the same window, so a refusal of any of them narrows it too.
      const decoded = decodeLedgerLogs(await client.getLogs(next, end), context.config);
      prepared = await prepareLiquidityEvents(
        client,
        context.memory.liquiditySource ?? undefined,
        liquidityOf(meta, context.memory),
        decoded,
        { from: next, to: end }
      );
    } catch (error) {
      if (error instanceof LedgerIntegrityError) throw error;
      const width = end - next + 1n;
      if (width > MIN_BLOCK_RANGE && isRangeError(error)) {
        span = narrowerSpan(width);
        console.warn(
          `Usage ledger index: eth_getLogs refused ${width} blocks from block ${next} as too wide; retrying in windows of ${span} blocks.`
        );
        continue;
      }
      console.error(
        `Usage ledger indexing stopped at block ${next}; committed progress is kept and the next run resumes there:`,
        describeError(error)
      );
      return { reached: false };
    }
    const committed = await applyWindow(context, meta, prepared, end);
    if (committed === undefined) return { reached: false };
    meta = committed;
    windows += 1;
    next = end + 1n;
  }
  return { reached: true, meta };
};

const describePool = (pool: PoolState): string =>
  `P ${pool.P}, scale ${pool.scale}, epoch ${pool.epoch}, total ${pool.total}`;

type ChainCheck = 'passed' | 'unknown';

/**
 * Section 4.6: the mirror must equal the pool at the cursor block, the vault must still use
 * that pool, and no audited account may be tracked with more debt than the vault holds.
 */
const checkAgainstChain = async (context: RunContext, meta: LedgerMeta, block: bigint): Promise<ChainCheck> => {
  const mirror = decodePool(meta.pool);
  let chain: Awaited<ReturnType<LedgerChainClient['readPoolState']>>;
  try {
    chain = await context.client.readPoolState(block);
  } catch (error) {
    console.error(
      `Usage ledger index could not be checked against the pool at block ${block}; no fresh stamp is written this run:`,
      describeError(error)
    );
    return 'unknown';
  }
  if (chain.vaultPool.toLowerCase() !== context.config.pool.toLowerCase()) {
    throw new LedgerIntegrityError(
      `at block ${block} the vault liquidates through ${chain.vaultPool}, not the configured pool ${context.config.pool}`
    );
  }
  if (chain.P !== mirror.P || chain.scale !== mirror.scale || chain.epoch !== mirror.epoch || chain.total !== mirror.total) {
    throw new LedgerIntegrityError(
      `at block ${block} the pool mirror (${describePool(mirror)}) differs from the contract (${describePool(chain)})`
    );
  }
  const debts = await auditDebts(context, block);
  return debts === 'passed' ? auditLiquidity(context, meta, block) : debts;
};

/** The liquidity dimension's own comparison with the chain; nothing to compare while it is off. */
const auditLiquidity = async (context: RunContext, meta: LedgerMeta, block: bigint): Promise<ChainCheck> => {
  const { client, memory } = context;
  if (memory.liquiditySource === null) return 'passed';
  const check = await checkLiquidityAgainstChain(client, liquidityOf(meta, memory), block, memory.positionAuditOffset);
  if (check.outcome !== 'passed') return 'unknown';
  memory.positionAuditOffset = check.nextOffset;
  return 'passed';
};

/**
 * A vault log the endpoint failed to return would leave a repaid debt on the record for good,
 * and nothing in the pool comparison would show it. So every run compares the tracked
 * principal of some accounts that owe, in rotation, with the vault at the cursor block.
 * A tracked debt above the vault's is an integrity failure. A lower one is left alone: it
 * can only under-record, and the account's next vault event corrects it.
 */
const auditDebts = async (context: RunContext, block: bigint): Promise<ChainCheck> => {
  const { memory } = context;
  const owing = [...memory.accounts].filter(([, account]) => account.debt > 0n);
  if (owing.length === 0) return 'passed';
  const size = Math.min(DEBT_AUDIT_ACCOUNTS_PER_RUN, owing.length);
  const first = memory.debtAuditOffset % owing.length;
  const sample = Array.from({ length: size }, (_, index) => owing[(first + index) % owing.length]);
  let onChain: bigint[];
  try {
    onChain = await context.client.readVaultDebts(block, sample.map(([address]) => address as Address));
  } catch (error) {
    console.error(
      `Usage ledger index could not compare tracked debt with the vault at block ${block}; no fresh stamp is written this run:`,
      describeError(error)
    );
    return 'unknown';
  }
  sample.forEach(([address, account], index) => {
    const held = onChain[index];
    if (held === undefined || account.debt > held) {
      throw new LedgerIntegrityError(
        `at block ${block} the index tracks ${account.debt} of debt principal for ${address} but the vault holds ${String(held)}`
      );
    }
  });
  memory.debtAuditOffset = (first + size) % owing.length;
  return 'passed';
};

/**
 * Step 8: the fresh stamp. Only a state that was read to the target and passed the
 * comparison with the chain gets one, and the readers answer from nothing else.
 */
const publishStamp = async (context: RunContext, indexed: LedgerMeta): Promise<void> => {
  const { store, memory, clock } = context;
  const next: LedgerMeta = { ...indexed, stateId: newStateId(), syncedAt: String(clock()) };
  const accepted = await store.commit(indexed.stateId, { meta: next, accounts: new Map() });
  adopt(memory, accepted, next, memory.accounts);
};

/**
 * Reads the configured liquidity pool from the chain once per process and checks it against
 * the deployment. A pool that fails the check throws LedgerLiquiditySourceError, so nothing
 * is indexed under a pool the operator did not mean.
 */
const ensureLiquiditySource = async (context: RunContext): Promise<void> => {
  const { client, config, memory } = context;
  if (config.liquidity === undefined) {
    memory.liquiditySource = null;
    return;
  }
  if (memory.liquiditySource !== null) return;
  memory.liquiditySource = resolveLiquiditySource(config.liquidity, await client.readLiquidityFacts(config.liquidity));
};

/**
 * The one line for the operator when a cap is first reached. The ledger deletes nothing, so
 * the address cap is a memory guard: raising it recomputes the ledger in full.
 */
const capReachedLine = (config: LedgerConfig, meta: LedgerMeta): string =>
  meta.accounts >= config.maxAddresses
    ? `Usage ledger reached its cap of ${config.maxAddresses} addresses: no new record is opened, every existing record keeps counting and the ledger is marked incomplete. Raise LEDGER_MAX_ADDRESSES and restart the API; the ledger then recomputes from the deploy block and is complete again (docs/USAGE_LEDGER.md section 1.4).`
    : `Usage ledger reached its cap of ${MAX_TRACKED_LIQUIDITY_POSITIONS} liquidity positions: no new position is tracked and the ledger is marked incomplete (docs/USAGE_LEDGER.md section 1.3).`;

const run = async (context: RunContext): Promise<void> => {
  const { client, config } = context;
  await ensureLiquiditySource(context);
  const meta = await usableMeta(context);
  await syncMemory(context, meta);
  if (meta.truncated) {
    console.warn(
      `Usage ledger is incomplete: the cap of ${config.maxAddresses} addresses, or the liquidity position cap, was reached, so some usage is not recorded, and the API, the page and the download say so. Raise LEDGER_MAX_ADDRESSES and restart the API to recompute it in full (docs/USAGE_LEDGER.md section 1.4).`
    );
  }
  const head = await client.getBlockNumber();
  if (config.deployBlock > head) {
    console.error(
      `Usage ledger indexing refused: deploy block ${config.deployBlock} is above the chain head ${head}; check GOLD_VAULT_DEPLOY_BLOCK against the deployment.`
    );
    return;
  }
  const confirmations = BigInt(config.confirmations);
  const target = head > confirmations ? head - confirmations : 0n;
  const from = meta.cursor === null ? config.deployBlock : BigInt(meta.cursor) + 1n;
  // No re-read behind the cursor: applying an event twice would count it twice. Finality
  // comes from the confirmation depth and from the chain check below.
  const outcome: ScanOutcome = from > target ? { reached: true, meta } : await scan(context, meta, from, target);
  if (!outcome.reached || outcome.meta.cursor === null) return;
  const cursor = BigInt(outcome.meta.cursor);
  if ((await checkAgainstChain(context, outcome.meta, cursor)) !== 'passed') return;
  if (!meta.truncated && outcome.meta.truncated) {
    console.warn(capReachedLine(config, outcome.meta));
  }
  await publishStamp(context, outcome.meta);
};

/**
 * Section 4.6: one error line, then a rebuild from the deploy block unless one was already
 * made in the last 24 hours. Past that limit the state is left alone without a fresh stamp:
 * the API reports the index unavailable and the error repeats until an operator acts.
 */
const handleIntegrityFailure = async (context: RunContext, failure: LedgerIntegrityError): Promise<void> => {
  const { store, config, memory, clock } = context;
  dropMemory(memory);
  const now = clock();
  const rebuilds = recentRebuilds((await store.readMeta())?.rebuilds ?? [], now);
  if (rebuilds.length >= MAX_REBUILDS_PER_DAY) {
    console.error(
      `Usage ledger index integrity failure: ${failure.message}. An automatic rebuild was already made in the last 24 hours, so the state is left as it is and the API reports the index unavailable until an operator acts (docs/USAGE_LEDGER.md).`
    );
    return;
  }
  console.error(
    `Usage ledger index integrity failure: ${failure.message}. Recomputing the whole ledger from the deploy block ${config.deployBlock}.`
  );
  await store.reset(genesisMeta(config, [...rebuilds, now]));
};

/**
 * One indexing run: read the confirmed blocks past the cursor, apply their events, check
 * the pool mirror, a sample of tracked debts and the liquidity dimension against the chain and stamp the state as checked. Every window is committed
 * atomically against the state id it started from, so two processes sharing one Redis
 * cannot apply the same events twice. Never throws.
 */
export const indexLedger = async (
  client: LedgerChainClient,
  store: LedgerStore,
  config: LedgerConfig,
  memory: IndexerMemory,
  clock: () => number = Date.now
): Promise<void> => {
  const context: RunContext = { client, store, config, memory, clock, timestamps: new Map() };
  try {
    await run(context);
  } catch (error) {
    try {
      if (error instanceof LedgerIntegrityError) {
        await handleIntegrityFailure(context, error);
        return;
      }
      if (error instanceof LedgerLiquiditySourceError) {
        console.error(
          `Usage ledger liquidity pool refused: ${error.message}. Nothing is indexed and the API reports the index unavailable until LEDGER_LIQUIDITY_POOL_ADDRESS and LEDGER_LIQUIDITY_POSITION_MANAGER are corrected, or both are removed.`
        );
        return;
      }
      dropMemory(memory);
      console.error('Usage ledger indexing failed; the committed state is left for the next run:', describeError(error));
    } catch (secondary) {
      console.error('Usage ledger indexing failed while handling a failure:', describeError(secondary));
    }
  }
};
