import type { Address } from 'viem';
import type { ChainPosition, LiquidityFacts, LedgerChainClient, PoolChainState } from './chainClient';
import type { LedgerConfig } from './env';
import { decodeLedgerLogs, isLiquidityEvent, isVaultDebtEvent } from './events';
import type { LedgerEvent, RawLedgerLog } from './events';
import { GENESIS_POOL } from './poolMirror';
import { applyEvents } from './replay';

/** Spec support: a chain made of logs, standing in for the RPC endpoint. Not used by the API. */

export const TEST_VAULT: Address = '0x5FbDB2315678afecb367f032d93F642f64180aa3';
export const TEST_POOL: Address = '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512';
export const TEST_START = 1_800_000_000;
export const TEST_DEPLOY_BLOCK = 100n;
const SECONDS_PER_BLOCK = 12;

export const TEST_LIQUIDITY_POOL: Address = '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0';
export const TEST_POSITION_MANAGER: Address = '0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9';
export const TEST_GSUSD: Address = '0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9';
export const TEST_DOLLAR: Address = '0x5FC8d32690cc91D4c39d9d3abcBD16989F875707';
export const TEST_LIQUIDITY = { pool: TEST_LIQUIDITY_POOL, positionManager: TEST_POSITION_MANAGER };
export const TEST_POOL_FEE = 500;
/** GSUSD (18 decimals) is token0 and the 6 decimal dollar is token1, so parity is near tick -276,324. */
export const TEST_LIQUIDITY_FACTS: LiquidityFacts = {
  token0: TEST_GSUSD,
  token1: TEST_DOLLAR,
  fee: TEST_POOL_FEE,
  decimals0: 18,
  decimals1: 6,
  stablecoin: TEST_GSUSD,
  factoryPool: TEST_LIQUIDITY_POOL,
};
export const TEST_PARITY_TICK = -276_324;

export type FakeEmitter = 'vault' | 'pool' | 'liquidityPool' | 'positionManager';

export const testConfig = (overrides: Partial<LedgerConfig> = {}): LedgerConfig => ({
  rpcUrl: 'https://rpc.example.org/v1/secret-key',
  chainId: 11155111,
  vault: TEST_VAULT,
  pool: TEST_POOL,
  deployBlock: TEST_DEPLOY_BLOCK,
  startTimestamp: TEST_START,
  confirmations: 0,
  maxAddresses: 50_000,
  ...overrides,
});

/** Block 100 is one hour before the ledger start; blocks are twelve seconds apart. */
export const testBlockTime = (block: bigint): number =>
  TEST_START - 3_600 + Number(block - TEST_DEPLOY_BLOCK) * SECONDS_PER_BLOCK;

export interface FakeChain extends LedgerChainClient {
  head: bigint;
  logs: RawLedgerLog[];
  /** Every getLogs window asked for, in order. */
  windows: [bigint, bigint][];
  /** Replace to make a call fail or lie. */
  beforeGetLogs: (fromBlock: bigint, toBlock: bigint) => void;
  poolStateOverride: ((block: bigint, truth: PoolChainState) => PoolChainState) | undefined;
  /** Replace to make the vault hold another principal than the event amounts add up to (fees). */
  vaultDebtOverride: ((block: bigint, owner: string, truth: bigint) => bigint) | undefined;
  /** Every vault debt read asked for, in order. */
  debtReads: { block: bigint; owners: string[] }[];
  /** What the chain says about the liquidity pool; replace to describe another pool. */
  liquidityFacts: LiquidityFacts;
  /** The positions the position manager holds, by block: `setPosition` writes them. */
  positionHistory: Map<string, { block: bigint; position: ChainPosition | undefined }[]>;
  /** Every position read asked for, in order. */
  positionReads: { block: bigint; tokenIds: bigint[] }[];
  /** Replace to make the position manager or the pool answer something else, or fail. */
  positionOverride: ((block: bigint, tokenId: bigint, truth: ChainPosition | undefined) => ChainPosition | undefined) | undefined;
  poolTickOverride: ((block: bigint, truth: number | null) => number | null) | undefined;
  /**
   * Adds a log. Logs of one block share a transaction unless `transaction` names another:
   * any short label, turned into a hash.
   */
  emit(block: bigint, emitter: FakeEmitter, eventName: string, args: Record<string, unknown>, transaction?: string): void;
  /** Every position manager log the chain handed over, by any request, in order. */
  positionLogsServed: RawLedgerLog[];
  /** Every receipt asked for, and every Transfer filter with its window and token ids, in order. */
  receiptReads: string[];
  transferReads: { fromBlock: bigint; toBlock: bigint; tokenIds: bigint[] }[];
  /** Records the position as the manager holds it from `block` on; undefined burns it. Emits nothing. */
  setPosition(block: bigint, tokenId: bigint, position: ChainPosition | undefined): void;
}

/** The principal a fee-free vault would hold: the event amounts of every vault log up to the block. */
const principalFromLogs = (logs: readonly RawLedgerLog[], config: LedgerConfig, block: bigint, owner: string): bigint => {
  const events = decodeLedgerLogs(
    logs.filter((log) => log.blockNumber !== null && log.blockNumber <= block),
    config
  );
  return debtOf(events, owner);
};

const debtOf = (events: readonly LedgerEvent[], owner: string): bigint => {
  let debt = 0n;
  for (const event of events) {
    if (!isVaultDebtEvent(event) || event.account.toLowerCase() !== owner) continue;
    if (event.kind === 'mint') debt += event.amount;
    else if (event.kind === 'badDebt') debt = 0n;
    else debt = debt > event.amount ? debt - event.amount : 0n;
  }
  return debt;
};

const isManagerLog = (log: RawLedgerLog): boolean => log.address === TEST_POSITION_MANAGER;

/** A transaction hash for a label, the same for the same label. */
export const testTransactionHash = (label: string): `0x${string}` =>
  `0x${Buffer.from(label).toString('hex').padStart(64, '0').slice(-64)}`;

const emitterAddress = (emitter: FakeEmitter, config: LedgerConfig): Address => {
  if (emitter === 'vault') return config.vault;
  if (emitter === 'pool') return config.pool;
  return emitter === 'liquidityPool' ? TEST_LIQUIDITY_POOL : TEST_POSITION_MANAGER;
};

export const createFakeChain = (config: LedgerConfig = testConfig()): FakeChain => {
  let nextLogIndex = 0;
  const chain: FakeChain = {
    head: config.deployBlock,
    logs: [],
    windows: [],
    beforeGetLogs: () => undefined,
    poolStateOverride: undefined,
    vaultDebtOverride: undefined,
    debtReads: [],
    liquidityFacts: TEST_LIQUIDITY_FACTS,
    positionHistory: new Map(),
    positionReads: [],
    positionOverride: undefined,
    poolTickOverride: undefined,
    setPosition: (block, tokenId, position) => {
      const key = tokenId.toString();
      chain.positionHistory.set(key, [...(chain.positionHistory.get(key) ?? []), { block, position }]);
    },
    positionLogsServed: [],
    receiptReads: [],
    transferReads: [],
    emit: (block, emitter, eventName, args, transaction) => {
      chain.logs.push({
        address: emitterAddress(emitter, config),
        eventName,
        args,
        blockNumber: block,
        logIndex: nextLogIndex++,
        removed: false,
        transactionHash: testTransactionHash(transaction ?? `block ${block}`),
      });
    },
    getChainId: async () => config.chainId,
    getBlockNumber: async () => chain.head,
    getLogs: async (fromBlock, toBlock) => {
      chain.beforeGetLogs(fromBlock, toBlock);
      chain.windows.push([fromBlock, toBlock]);
      // As the real client asks: never the position manager, which serves every pool on the chain.
      return chain.logs.filter(
        (log) => !isManagerLog(log) && log.blockNumber !== null && log.blockNumber >= fromBlock && log.blockNumber <= toBlock
      );
    },
    getPositionLiquidityLogs: async (transactionHash) => {
      chain.receiptReads.push(transactionHash);
      const logs = chain.logs.filter(
        (log) => isManagerLog(log) && log.transactionHash === transactionHash && log.eventName !== 'Transfer'
      );
      chain.positionLogsServed.push(...logs);
      return logs;
    },
    getPositionTransferLogs: async (fromBlock, toBlock, tokenIds) => {
      chain.beforeGetLogs(fromBlock, toBlock);
      chain.transferReads.push({ fromBlock, toBlock, tokenIds: [...tokenIds] });
      const logs = chain.logs.filter(
        (log) =>
          isManagerLog(log) &&
          log.eventName === 'Transfer' &&
          log.blockNumber !== null &&
          log.blockNumber >= fromBlock &&
          log.blockNumber <= toBlock &&
          tokenIds.includes(log.args?.['tokenId'] as bigint)
      );
      chain.positionLogsServed.push(...logs);
      return logs;
    },
    getBlockTimestamp: async (block) => testBlockTime(block),
    readPoolState: async (block) => {
      // The pool as the contract would hold it: the mirror arithmetic over every pool log so far.
      const events = decodeLedgerLogs(
        chain.logs.filter((log) => log.blockNumber !== null && log.blockNumber <= block),
        config
      ).filter((event) => !isLiquidityEvent(event));
      const timestamps = new Map(events.map((event) => [event.block, testBlockTime(event.block)] as const));
      const { state } = applyEvents(
        { pool: GENESIS_POOL, accounts: new Map(), truncated: false },
        events,
        timestamps,
        { start: config.startTimestamp, maxAccounts: 0, minTrackedDeposit: 0n }
      );
      const truth: PoolChainState = { ...state.pool, vaultPool: config.pool };
      return chain.poolStateOverride === undefined ? truth : chain.poolStateOverride(block, truth);
    },
    readVaultDebts: async (block, owners) => {
      chain.debtReads.push({ block, owners: owners.map((owner) => owner.toLowerCase()) });
      return owners.map((owner) => {
        const truth = principalFromLogs(chain.logs, config, block, owner.toLowerCase());
        return chain.vaultDebtOverride === undefined ? truth : chain.vaultDebtOverride(block, owner.toLowerCase(), truth);
      });
    },
    readLiquidityFacts: async () => chain.liquidityFacts,
    readPositions: async (block, tokenIds) => {
      chain.positionReads.push({ block, tokenIds: [...tokenIds] });
      return tokenIds.map((tokenId) => {
        const history = chain.positionHistory.get(tokenId.toString()) ?? [];
        const truth = history.filter((entry) => entry.block <= block).at(-1)?.position;
        return chain.positionOverride === undefined ? truth : chain.positionOverride(block, tokenId, truth);
      });
    },
    readPoolTick: async (block) => {
      // The tick as the pool would hold it: the last Initialize or Swap log so far.
      const ticks = decodeLedgerLogs(
        chain.logs.filter((log) => log.blockNumber !== null && log.blockNumber <= block),
        config
      ).filter((event) => event.kind === 'poolTick');
      const last = ticks.at(-1);
      const truth = last !== undefined && last.kind === 'poolTick' ? last.tick : null;
      return chain.poolTickOverride === undefined ? truth : chain.poolTickOverride(block, truth);
    },
  };
  return chain;
};
