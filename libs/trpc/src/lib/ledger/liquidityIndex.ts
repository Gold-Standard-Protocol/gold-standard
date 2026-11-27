import type { Hex } from 'viem';
import { describeError } from '../config/redact';
import type { ChainPosition, LedgerChainClient } from './chainClient';
import { LedgerIntegrityError } from './errors';
import { decodeLedgerLogs, isLiquidityEvent } from './events';
import type { LiquidityEvent, LedgerEvent } from './events';
import { crossesBoundary, liquidityLimits } from './liquidity';
import type { LiquidityPosition, LiquiditySource, LiquidityState } from './liquidity';
import { LIQUIDITY_AUDIT_POSITIONS_PER_RUN, LIQUIDITY_IDS_PER_FILTER } from './limits';

type LiquidityClient = Pick<LedgerChainClient, 'readPositions' | 'readPoolTick'>;
type PrepareClient = Pick<LedgerChainClient, 'readPositions' | 'getPositionLiquidityLogs' | 'getPositionTransferLogs'>;
type PoolLiquidity = Extract<LiquidityEvent, { kind: 'poolLiquidity' }>;
type PositionChange = Extract<LiquidityEvent, { kind: 'positionChange' }>;
type PositionState = Extract<LiquidityEvent, { kind: 'positionState' }>;

export interface PreparedEvents {
  /** The events for the replay, in chain order. */
  events: LedgerEvent[];
  /** The blocks whose time the replay will ask for. */
  timedBlocks: bigint[];
}

/** The blocks one getLogs window covers, both inclusive. */
export interface BlockWindow {
  from: bigint;
  to: bigint;
}

const RECEIPT_CONCURRENCY = 4;

const same = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();

const isOfPool = (position: ChainPosition, source: LiquiditySource): boolean =>
  same(position.token0, source.token0) && same(position.token1, source.token1) && position.fee === source.fee;

const byPosition = (left: LedgerEvent, right: LedgerEvent): number => {
  if (left.block !== right.block) return left.block < right.block ? -1 : 1;
  return left.logIndex - right.logIndex;
};

const isPositionChange = (event: LedgerEvent): event is PositionChange => event.kind === 'positionChange';

/**
 * The position manager's liquidity logs of each transaction in which the pool added or
 * removed liquidity for it, keyed by transaction hash. One receipt per transaction.
 */
const liquidityLogsByTransaction = async (
  client: PrepareClient,
  source: LiquiditySource,
  triggers: readonly PoolLiquidity[]
): Promise<Map<string, PositionChange[]>> => {
  const hashes = [...new Set(triggers.map((trigger) => trigger.transactionHash))];
  const byTransaction = new Map<string, PositionChange[]>();
  for (let start = 0; start < hashes.length; start += RECEIPT_CONCURRENCY) {
    const batch = hashes.slice(start, start + RECEIPT_CONCURRENCY);
    const fetched = await Promise.all(batch.map((hash) => client.getPositionLiquidityLogs(hash as Hex)));
    batch.forEach((hash, index) => {
      const sources = { vault: source.pool, pool: source.pool, liquidity: source };
      byTransaction.set(hash, decodeLedgerLogs(fetched[index], sources).filter(isPositionChange));
    });
  }
  return byTransaction;
};

/**
 * The token id behind each of the pool's Mint and Burn logs for the position manager. The
 * manager logs IncreaseLiquidity straight after the pool's Mint, and DecreaseLiquidity
 * straight after its Burn, in the same transaction, so the first such log after the pool's
 * own is the one that belongs to it: a transaction that also touches a position of another
 * pool cannot be mistaken for ours. A pool log with no such partner is not skipped.
 */
const changesBehind = async (
  client: PrepareClient,
  source: LiquiditySource,
  triggers: readonly PoolLiquidity[]
): Promise<PositionChange[]> => {
  const byTransaction = await liquidityLogsByTransaction(client, source, triggers);
  return triggers.map((trigger) => {
    const partner = (byTransaction.get(trigger.transactionHash) ?? []).find(
      (log) => log.block === trigger.block && log.logIndex > trigger.logIndex && log.increase === trigger.added
    );
    if (partner === undefined) {
      throw new LedgerIntegrityError(
        `the pool ${trigger.added ? 'added' : 'removed'} liquidity for the position manager at block ${trigger.block} index ${trigger.logIndex}, but the transaction holds no matching position manager log`
      );
    }
    return partner;
  });
};

/** The Transfer logs of these token ids in the window, asked for a filter of ids at a time. */
const transfersOf = async (
  client: PrepareClient,
  source: LiquiditySource,
  tokenIds: readonly string[],
  window: BlockWindow
): Promise<PositionChange[]> => {
  if (tokenIds.length === 0 || window.from > window.to) return [];
  const transfers: PositionChange[] = [];
  for (let start = 0; start < tokenIds.length; start += LIQUIDITY_IDS_PER_FILTER) {
    const ids = tokenIds.slice(start, start + LIQUIDITY_IDS_PER_FILTER).map((id) => BigInt(id));
    const logs = await client.getPositionTransferLogs(window.from, window.to, ids);
    const sources = { vault: source.pool, pool: source.pool, liquidity: source };
    transfers.push(...decodeLedgerLogs(logs, sources).filter(isPositionChange));
  }
  return transfers;
};

/** The position manager's logs of one block: the last log of each token id, and the ids that gained liquidity. */
interface BlockChanges {
  last: Map<string, PositionChange>;
  increased: Set<string>;
}

const changesByBlock = (changes: readonly PositionChange[]): Map<bigint, BlockChanges> => {
  const blocks = new Map<bigint, BlockChanges>();
  for (const event of [...changes].sort(byPosition)) {
    const block = blocks.get(event.block) ?? { last: new Map(), increased: new Set() };
    const key = event.tokenId.toString();
    block.last.set(key, event);
    if (event.increase) block.increased.add(key);
    blocks.set(event.block, block);
  }
  return blocks;
};

/** What one pass over the window's position logs needs and keeps. */
interface Pass {
  client: PrepareClient;
  source: LiquiditySource;
  /** Positions read so far in this window, by block and token id, so a second pass asks nothing twice. */
  readings: Map<string, ChainPosition | undefined>;
}

const readPositionsOnce = async (pass: Pass, block: bigint, keys: readonly string[]): Promise<void> => {
  const missing = keys.filter((key) => !pass.readings.has(`${block}:${key}`));
  if (missing.length === 0) return;
  const readings = await pass.client.readPositions(block, missing.map((key) => BigInt(key)));
  if (readings.length !== missing.length) {
    throw new Error(`the position read at block ${block} answered ${readings.length} of ${missing.length} positions`);
  }
  missing.forEach((key, index) => pass.readings.set(`${block}:${key}`, readings[index]));
};

/**
 * Reads, for one block, every tracked position that has a log in it and every token id
 * that gained liquidity in it, and answers the state of each as of the end of the block.
 * `tracked` follows the replay: a position is tracked while it is worth the minimum.
 */
const readBlock = async (pass: Pass, tracked: Set<string>, block: bigint, changes: BlockChanges): Promise<PositionState[]> => {
  const { valueOf, minValue } = liquidityLimits(pass.source);
  const wanted = [...changes.last.keys()].filter((key) => tracked.has(key) || changes.increased.has(key));
  await readPositionsOnce(pass, block, wanted);
  const states: PositionState[] = [];
  for (const key of wanted) {
    const at = changes.last.get(key);
    const chain = pass.readings.get(`${block}:${key}`);
    const ours = chain !== undefined && isOfPool(chain, pass.source);
    const wasTracked = tracked.has(key);
    const worth = ours && valueOf(chain.liquidity, chain.tickLower, chain.tickUpper) >= minValue;
    if (worth) tracked.add(key);
    else tracked.delete(key);
    if (at === undefined || (!wasTracked && !worth)) continue;
    states.push({
      kind: 'positionState',
      tokenId: at.tokenId,
      reading: ours
        ? { owner: chain.owner, liquidity: chain.liquidity, tickLower: chain.tickLower, tickUpper: chain.tickUpper }
        : undefined,
      block: at.block,
      logIndex: at.logIndex,
    });
  }
  return states;
};

interface PassResult {
  states: PositionState[];
  /** Token ids that were not tracked when the window began, with the block in which each first was. */
  discovered: Map<string, bigint>;
}

/** One pass over the position logs of the window, block by block in chain order. */
const runPass = async (pass: Pass, state: LiquidityState, changes: readonly PositionChange[]): Promise<PassResult> => {
  const tracked = new Set(state.positions.keys());
  const states: PositionState[] = [];
  const discovered = new Map<string, bigint>();
  for (const [block, blockChanges] of changesByBlock(changes)) {
    states.push(...(await readBlock(pass, tracked, block, blockChanges)));
    for (const key of tracked) {
      if (!state.positions.has(key) && !discovered.has(key)) discovered.set(key, block);
    }
  }
  return { states, discovered };
};

/**
 * The position states of the window. Transfers are asked for by token id, so a position
 * found in this window was not in the filter: its transfers after the block it was found in
 * are asked for afterwards and the pass is run again with them.
 */
const positionStates = async (
  pass: Pass,
  state: LiquidityState,
  liquidityChanges: readonly PositionChange[],
  window: BlockWindow
): Promise<PositionState[]> => {
  const changes = [...liquidityChanges, ...(await transfersOf(pass.client, pass.source, [...state.positions.keys()], window))];
  const followed = new Set<string>();
  for (;;) {
    const { states, discovered } = await runPass(pass, state, changes);
    const fresh = [...discovered].filter(([key]) => !followed.has(key));
    if (fresh.length === 0) return states;
    fresh.forEach(([key]) => followed.add(key));
    const earliest = fresh.reduce((least, [, block]) => (block < least ? block : least), fresh[0][1]);
    const later = await transfersOf(pass.client, pass.source, fresh.map(([key]) => key), { from: earliest + 1n, to: window.to });
    const added = later.filter((transfer) => transfer.block > (discovered.get(transfer.tokenId.toString()) ?? window.to));
    if (added.length === 0) return states;
    changes.push(...added);
  }
};

/** The blocks of the tick moves that cross the end of some range, so some account may change. */
const crossingBlocks = (state: LiquidityState, events: readonly LedgerEvent[]): bigint[] => {
  const boundaries = new Set<number>();
  for (const position of state.positions.values()) boundaries.add(position.tickLower).add(position.tickUpper);
  for (const event of events) {
    if (event.kind === 'positionState' && event.reading !== undefined) {
      boundaries.add(event.reading.tickLower).add(event.reading.tickUpper);
    }
  }
  const blocks: bigint[] = [];
  let tick = state.tick;
  for (const event of events) {
    if (event.kind !== 'poolTick') continue;
    const from = tick;
    if ([...boundaries].some((boundary) => crossesBoundary(from, event.tick, boundary))) blocks.push(event.block);
    tick = event.tick;
  }
  return blocks;
};

/**
 * Turns the decoded logs of one window into what the replay applies, asking the position
 * manager only about this pool's positions:
 *
 * - a change of liquidity is found from the pool's own Mint and Burn logs for the position
 *   manager, and the token id from the receipt of that transaction. The position manager
 *   changes a position's liquidity only by calling the pool, so every increase, every
 *   decrease and every new position has such a pool log;
 * - a change of owner is found from the position manager's Transfer logs with the token id
 *   topic set to the tracked ids.
 *
 * Each position with a change in a block becomes one `positionState`: the position as the
 * manager holds it at the end of that block. The amounts in the logs are not added up,
 * exactly as the debt principal is read from the vault, so liquidity added and removed
 * inside one block leaves no trace and records nothing. With the dimension off the events pass
 * through unchanged and nothing is asked.
 */
export const prepareLiquidityEvents = async (
  client: PrepareClient,
  source: LiquiditySource | undefined,
  state: LiquidityState,
  decoded: readonly LedgerEvent[],
  window: BlockWindow
): Promise<PreparedEvents> => {
  if (source === undefined) return { events: [...decoded], timedBlocks: decoded.map((event) => event.block) };
  const triggers = decoded.filter(
    (event): event is PoolLiquidity => event.kind === 'poolLiquidity' && same(event.owner, source.positionManager)
  );
  const pass: Pass = { client, source, readings: new Map() };
  const states = await positionStates(pass, state, await changesBehind(client, source, triggers), window);
  const kept = decoded.filter((event) => event.kind !== 'poolLiquidity' && event.kind !== 'positionChange');
  const events = [...kept, ...states].sort(byPosition);
  const timedBlocks = [
    ...events.filter((event) => !isLiquidityEvent(event) || event.kind === 'positionState').map((event) => event.block),
    ...crossingBlocks(state, events),
  ];
  return { events, timedBlocks };
};

export type LiquidityCheck = { outcome: 'passed'; nextOffset: number } | { outcome: 'unknown' };

const auditSample = (
  positions: ReadonlyMap<string, LiquidityPosition>,
  offset: number
): { sample: [string, LiquidityPosition][]; nextOffset: number } => {
  const all = [...positions];
  if (all.length === 0) return { sample: [], nextOffset: 0 };
  const size = Math.min(LIQUIDITY_AUDIT_POSITIONS_PER_RUN, all.length);
  const first = offset % all.length;
  return {
    sample: Array.from({ length: size }, (_, index) => all[(first + index) % all.length]),
    nextOffset: (first + size) % all.length,
  };
};

/**
 * The liquidity dimension against the chain at the index block: the tracked tick must be the
 * pool's, and no audited position may be tracked for another owner or with more liquidity
 * than the position manager holds. Either is what a log the endpoint failed to return looks
 * like, and would record liquidity that is not there. Less liquidity than the chain holds
 * can only under-record and is left for the position's next log to correct.
 */
export const checkLiquidityAgainstChain = async (
  client: LiquidityClient,
  state: LiquidityState,
  block: bigint,
  offset: number
): Promise<LiquidityCheck> => {
  const { sample, nextOffset } = auditSample(state.positions, offset);
  let tick: number | null;
  let onChain: (ChainPosition | undefined)[];
  try {
    tick = await client.readPoolTick(block);
    onChain = sample.length === 0 ? [] : await client.readPositions(block, sample.map(([tokenId]) => BigInt(tokenId)));
  } catch (error) {
    console.error(
      `Usage ledger index could not be checked against the liquidity pool at block ${block}; no fresh stamp is written this run:`,
      describeError(error)
    );
    return { outcome: 'unknown' };
  }
  if (state.tick === null && tick !== null) {
    throw new LedgerIntegrityError(
      `at block ${block} the liquidity pool is initialized (tick ${tick}) but the index never saw its Initialize log. The index reads from GOLD_VAULT_DEPLOY_BLOCK on, so a pool initialized before that block cannot be followed: name a pool created after the deployment in LEDGER_LIQUIDITY_POOL_ADDRESS, or remove both liquidity variables to turn the source off. If the pool was created after the deploy block, the RPC endpoint failed to return the log and the rebuild that follows corrects it`
    );
  }
  if (tick !== state.tick) {
    throw new LedgerIntegrityError(
      `at block ${block} the index tracks tick ${String(state.tick)} for the liquidity pool but the pool is at ${String(tick)}`
    );
  }
  sample.forEach(([tokenId, position], index) => {
    const held = onChain[index];
    if (held === undefined || !same(held.owner, position.owner) || position.liquidity > held.liquidity) {
      throw new LedgerIntegrityError(
        `at block ${block} the index tracks liquidity position ${tokenId} with ${position.liquidity} of liquidity for ${position.owner} but the position manager holds ${held === undefined ? 'no such position' : `${held.liquidity} for ${held.owner}`}`
      );
    }
  });
  return { outcome: 'passed', nextOffset };
};
