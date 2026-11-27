import { isAddress, parseAbiItem } from 'viem';
import type { Address } from 'viem';
import { LedgerIntegrityError } from './errors';
import type { LiquidityConfig } from './liquidity';
import { isTick } from './liquidityMath';

/** The nine vault and stability pool events the ledger is computed from. EpochReset is derived by the pool mirror. */
export const VAULT_EVENTS = [
  parseAbiItem('event DebtMinted(address indexed user, uint256 amount)'),
  parseAbiItem('event DebtRepaid(address indexed user, uint256 amount)'),
  parseAbiItem(
    'event Liquidated(address indexed vaultOwner, address indexed liquidator, uint256 debtRepaid, uint256 collateralSeized)'
  ),
  parseAbiItem(
    'event LiquidatedViaPool(address indexed vaultOwner, address indexed liquidator, uint256 debtRepaid, uint256 collateralSeized)'
  ),
  parseAbiItem('event BadDebt(address indexed vaultOwner, uint256 amount)'),
] as const;

export const POOL_EVENTS = [
  parseAbiItem('event Deposited(address indexed user, uint256 amount)'),
  parseAbiItem('event Withdrawn(address indexed user, uint256 amount)'),
  parseAbiItem(
    'event LiquidationAbsorbed(address indexed token, uint256 debtAbsorbed, uint256 collateralGained)'
  ),
  parseAbiItem('event CollateralClaimed(address indexed user, address indexed token, uint256 amount)'),
] as const;

export const LEDGER_EVENTS = [...VAULT_EVENTS, ...POOL_EVENTS] as const;

/**
 * The Uniswap v3 pool events the liquidity dimension reads: the tick, and every addition and
 * removal of liquidity. The pool is the only contract asked for a whole window of logs.
 */
export const LIQUIDITY_POOL_EVENTS = [
  parseAbiItem('event Initialize(uint160 sqrtPriceX96, int24 tick)'),
  parseAbiItem(
    'event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)'
  ),
  parseAbiItem(
    'event Mint(address sender, address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)'
  ),
  parseAbiItem(
    'event Burn(address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)'
  ),
] as const;

/**
 * The NonfungiblePositionManager events that name the token id behind a change of the
 * pool's liquidity. They are read from the receipt of a transaction the pool itself logged
 * in, never asked for by block range: the manager serves every pool on the chain.
 */
export const POSITION_LIQUIDITY_EVENTS = [
  parseAbiItem('event IncreaseLiquidity(uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)'),
  parseAbiItem('event DecreaseLiquidity(uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)'),
] as const;

/** The position NFT's transfer, asked for with the token id topic set to tracked ids only. */
export const POSITION_TRANSFER_EVENT = parseAbiItem(
  'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)'
);

/** A log as the RPC client returns it, before anything in it is trusted. */
export interface RawLedgerLog {
  address: string;
  eventName?: string;
  args?: Readonly<Record<string, unknown>>;
  blockNumber: bigint | null;
  logIndex: number | null;
  removed?: boolean;
  /** Needed on the pool's liquidity logs only: the receipt of that transaction names the token id. */
  transactionHash?: string | null;
}

interface Position {
  block: bigint;
  logIndex: number;
}

/**
 * A vault event may carry `principal`: the vault's debt principal at the end of the event's
 * block, read from the contract by the indexer. The replay then takes the tracked debt from
 * it instead of from the event amount, which includes the stability fee.
 */
interface ChainPrincipal {
  principal?: bigint;
}

export type VaultDebtEvent =
  | ({ kind: 'mint' | 'repay' | 'liquidated'; account: Address; amount: bigint } & Position & ChainPrincipal)
  | ({ kind: 'badDebt'; account: Address } & Position & ChainPrincipal);

/** A position of the configured pool as the position manager holds it at the end of a block. */
export interface PositionReading {
  owner: Address;
  liquidity: bigint;
  tickLower: number;
  tickUpper: number;
}

/**
 * The liquidity dimension's events. The first three are decoded from logs. `positionState` is
 * written by the indexer in place of a position's logs of one block: the position as the
 * chain holds it at the end of that block, or nothing when it no longer exists. The replay
 * takes a position from it and never adds up log amounts, as it takes the debt principal
 * from the vault.
 */
export type TransactionHash = `0x${string}`;

export type LiquidityEvent =
  /** The pool's tick after an Initialize or a Swap. */
  | ({ kind: 'poolTick'; tick: number } & Position)
  /**
   * The pool's Mint (`added`) or Burn for `owner`, which is the position manager for an NFT
   * position. The receipt of `transactionHash` names the token id.
   */
  | ({ kind: 'poolLiquidity'; owner: Address; added: boolean; transactionHash: TransactionHash } & Position)
  /** A position manager log about one token id; `increase` is true for IncreaseLiquidity. */
  | ({ kind: 'positionChange'; tokenId: bigint; increase: boolean } & Position)
  | ({ kind: 'positionState'; tokenId: bigint; reading: PositionReading | undefined } & Position);

export type LedgerEvent =
  | VaultDebtEvent
  | ({ kind: 'deposit' | 'withdraw'; account: Address; amount: bigint } & Position)
  | ({ kind: 'claim'; account: Address } & Position)
  | ({ kind: 'absorb'; debt: bigint } & Position)
  | LiquidityEvent;

export const isLiquidityEvent = (event: LedgerEvent): event is LiquidityEvent =>
  event.kind === 'poolTick' ||
  event.kind === 'poolLiquidity' ||
  event.kind === 'positionChange' ||
  event.kind === 'positionState';

export const isVaultDebtEvent = (event: LedgerEvent): event is VaultDebtEvent =>
  event.kind === 'mint' || event.kind === 'repay' || event.kind === 'liquidated' || event.kind === 'badDebt';

export interface EventSources {
  vault: Address;
  pool: Address;
  /** Set while the liquidity dimension is on; its events are refused otherwise. */
  liquidity?: LiquidityConfig;
}

type Emitter = 'vault' | 'pool' | 'liquidity pool' | 'position manager';

interface EventRule {
  emitter: Emitter;
  build: (args: Readonly<Record<string, unknown>>, at: Position, log: RawLedgerLog) => LedgerEvent;
}

const fail = (log: RawLedgerLog, reason: string): never => {
  throw new LedgerIntegrityError(
    `log ${String(log.eventName)} at block ${String(log.blockNumber)} index ${String(log.logIndex)}: ${reason}`
  );
};

const addressArg = (args: Readonly<Record<string, unknown>>, name: string): Address => {
  const value = args[name];
  if (typeof value !== 'string' || !isAddress(value, { strict: false })) {
    throw new LedgerIntegrityError(`argument ${name} is not an address`);
  }
  return value.toLowerCase() as Address;
};

const amountArg = (args: Readonly<Record<string, unknown>>, name: string): bigint => {
  const value = args[name];
  if (typeof value !== 'bigint' || value < 0n) {
    throw new LedgerIntegrityError(`argument ${name} is not an amount`);
  }
  return value;
};

const tickArg = (args: Readonly<Record<string, unknown>>, name: string): number => {
  const value = args[name];
  if (!isTick(value)) throw new LedgerIntegrityError(`argument ${name} is not a tick`);
  return value;
};

const positionChange = (increase: boolean): EventRule => ({
  emitter: 'position manager',
  build: (args, at) => ({ kind: 'positionChange', tokenId: amountArg(args, 'tokenId'), increase, ...at }),
});

const TRANSACTION_HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;

const transactionHashOf = (log: RawLedgerLog): TransactionHash => {
  if (typeof log.transactionHash !== 'string' || !TRANSACTION_HASH_PATTERN.test(log.transactionHash)) {
    throw new LedgerIntegrityError('the log has no transaction hash');
  }
  return log.transactionHash.toLowerCase() as TransactionHash;
};

const poolLiquidity = (added: boolean): EventRule => ({
  emitter: 'liquidity pool',
  build: (args, at, log) => ({
    kind: 'poolLiquidity',
    owner: addressArg(args, 'owner'),
    added,
    transactionHash: transactionHashOf(log),
    ...at,
  }),
});

const poolTick: EventRule = {
  emitter: 'liquidity pool',
  build: (args, at) => ({ kind: 'poolTick', tick: tickArg(args, 'tick'), ...at }),
};

const RULES: Readonly<Record<string, EventRule>> = {
  Initialize: poolTick,
  Swap: poolTick,
  Mint: poolLiquidity(true),
  Burn: poolLiquidity(false),
  IncreaseLiquidity: positionChange(true),
  DecreaseLiquidity: positionChange(false),
  Transfer: positionChange(false),
  DebtMinted: {
    emitter: 'vault',
    build: (args, at) => ({ kind: 'mint', account: addressArg(args, 'user'), amount: amountArg(args, 'amount'), ...at }),
  },
  DebtRepaid: {
    emitter: 'vault',
    build: (args, at) => ({ kind: 'repay', account: addressArg(args, 'user'), amount: amountArg(args, 'amount'), ...at }),
  },
  Liquidated: {
    emitter: 'vault',
    build: (args, at) => ({
      kind: 'liquidated',
      account: addressArg(args, 'vaultOwner'),
      amount: amountArg(args, 'debtRepaid'),
      ...at,
    }),
  },
  LiquidatedViaPool: {
    emitter: 'vault',
    build: (args, at) => ({
      kind: 'liquidated',
      account: addressArg(args, 'vaultOwner'),
      amount: amountArg(args, 'debtRepaid'),
      ...at,
    }),
  },
  BadDebt: {
    emitter: 'vault',
    build: (args, at) => ({ kind: 'badDebt', account: addressArg(args, 'vaultOwner'), ...at }),
  },
  Deposited: {
    emitter: 'pool',
    build: (args, at) => ({ kind: 'deposit', account: addressArg(args, 'user'), amount: amountArg(args, 'amount'), ...at }),
  },
  Withdrawn: {
    emitter: 'pool',
    build: (args, at) => ({ kind: 'withdraw', account: addressArg(args, 'user'), amount: amountArg(args, 'amount'), ...at }),
  },
  CollateralClaimed: {
    emitter: 'pool',
    build: (args, at) => ({ kind: 'claim', account: addressArg(args, 'user'), ...at }),
  },
  LiquidationAbsorbed: {
    emitter: 'pool',
    build: (args, at) => ({ kind: 'absorb', debt: amountArg(args, 'debtAbsorbed'), ...at }),
  },
};

const emitterAddress = (emitter: Emitter, sources: EventSources): Address | undefined => {
  if (emitter === 'vault') return sources.vault;
  if (emitter === 'pool') return sources.pool;
  return emitter === 'liquidity pool' ? sources.liquidity?.pool : sources.liquidity?.positionManager;
};

const decodeLog = (log: RawLedgerLog, sources: EventSources): LedgerEvent => {
  if (log.removed === true) return fail(log, 'the log is flagged as removed by a reorganisation');
  if (typeof log.blockNumber !== 'bigint' || typeof log.logIndex !== 'number' || !Number.isInteger(log.logIndex)) {
    return fail(log, 'the log has no block number or log index');
  }
  const rule = log.eventName === undefined ? undefined : Object.hasOwn(RULES, log.eventName) ? RULES[log.eventName] : undefined;
  if (rule === undefined) return fail(log, 'the event is not one the ledger index consumes');
  const expected = emitterAddress(rule.emitter, sources)?.toLowerCase();
  if (typeof log.address !== 'string' || log.address.toLowerCase() !== expected) {
    return fail(log, `emitted by ${String(log.address)}, not by the configured ${rule.emitter}`);
  }
  try {
    return rule.build(log.args ?? {}, { block: log.blockNumber, logIndex: log.logIndex }, log);
  } catch (error) {
    return fail(log, error instanceof Error ? error.message : 'undecodable arguments');
  }
};

const byPosition = (left: LedgerEvent, right: LedgerEvent): number => {
  if (left.block !== right.block) return left.block < right.block ? -1 : 1;
  return left.logIndex - right.logIndex;
};

/**
 * Validates every log and returns the events in chain order. A log is attributed by the
 * address that emitted it. Anything unexpected (a missing argument, an invalid address, a
 * removed log, another emitter) throws a LedgerIntegrityError: a log is never skipped,
 * because a skipped log would silently change every figure after it.
 */
export const decodeLedgerLogs = (
  logs: readonly RawLedgerLog[],
  sources: EventSources
): LedgerEvent[] => logs.map((log) => decodeLog(log, sources)).sort(byPosition);
