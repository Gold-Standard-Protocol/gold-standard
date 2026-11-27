import { BaseError, ContractFunctionRevertedError, createPublicClient, getAddress, http, parseAbi, parseEventLogs } from 'viem';
import type { Address, Hex } from 'viem';
import { mainnet, sepolia } from 'viem/chains';
import type { LedgerConfig } from './env';
import { LIQUIDITY_POOL_EVENTS, LEDGER_EVENTS, POSITION_LIQUIDITY_EVENTS, POSITION_TRANSFER_EVENT } from './events';
import type { RawLedgerLog } from './events';
import type { LiquidityConfig } from './liquidity';

export interface PoolChainState {
  total: bigint;
  P: bigint;
  scale: bigint;
  epoch: bigint;
  /** The pool the vault liquidates through. */
  vaultPool: Address;
}

/** What the chain says about the configured liquidity pool, before any of it is checked. */
export interface LiquidityFacts {
  token0: Address;
  token1: Address;
  fee: number;
  decimals0: number;
  decimals1: number;
  /** The GSUSD token of the deployment: the vault's `stablecoin()`. */
  stablecoin: Address;
  /** The pool the position manager's factory holds for these two tokens and this fee. */
  factoryPool: Address;
}

/** A position as the position manager holds it. */
export interface ChainPosition {
  token0: Address;
  token1: Address;
  fee: number;
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
  owner: Address;
}

/** Everything the ledger asks of the chain, so specs can stand in for it. */
export interface LedgerChainClient {
  getChainId(): Promise<number>;
  getBlockNumber(): Promise<bigint>;
  /**
   * One eth_getLogs for the nine events from the vault and the pool and, while the liquidity
   * dimension is on, four of the Uniswap pool. The position manager is never part of it: it
   * emits for every pool on the chain.
   */
  getLogs(fromBlock: bigint, toBlock: bigint): Promise<readonly RawLedgerLog[]>;
  getBlockTimestamp(block: bigint): Promise<number>;
  readPoolState(block: bigint): Promise<PoolChainState>;
  /**
   * The debt principal (`vaults(owner).debtAmount`) of each owner at the end of `block`, in
   * the order asked. A block far behind the head needs an endpoint that keeps historical
   * state, so a rebuild from the deploy block needs an archive endpoint.
   */
  readVaultDebts(block: bigint, owners: readonly Address[]): Promise<bigint[]>;
  /**
   * The position manager's IncreaseLiquidity and DecreaseLiquidity logs of one transaction,
   * from its receipt: how the token id behind a pool Mint or Burn is learned.
   */
  getPositionLiquidityLogs(transactionHash: Hex): Promise<readonly RawLedgerLog[]>;
  /**
   * The position manager's Transfer logs for these token ids only (the token id topic is
   * filtered), in one eth_getLogs. The caller keeps the list short enough for one filter.
   */
  getPositionTransferLogs(fromBlock: bigint, toBlock: bigint, tokenIds: readonly bigint[]): Promise<readonly RawLedgerLog[]>;
  /** The liquidity pool's tokens, fee and decimals, the deployment's GSUSD and the factory's pool for the pair. */
  readLiquidityFacts(liquidity: LiquidityConfig): Promise<LiquidityFacts>;
  /**
   * Each position at the end of `block`, in the order asked; undefined for a token id that
   * does not exist then (never minted, or burned). Needs historical state, as the debts do.
   */
  readPositions(block: bigint, tokenIds: readonly bigint[]): Promise<(ChainPosition | undefined)[]>;
  /** The liquidity pool's tick at the end of `block`; null while the pool is not initialized. */
  readPoolTick(block: bigint): Promise<number | null>;
}

const POOL_ABI = parseAbi([
  'function totalDeposits() view returns (uint256)',
  'function P() view returns (uint256)',
  'function currentScale() view returns (uint128)',
  'function currentEpoch() view returns (uint128)',
]);
const VAULT_ABI = parseAbi([
  'function stabilityPool() view returns (address)',
  'function vaults(address owner) view returns (address collateralToken, uint256 collateralAmount, uint256 debtAmount)',
]);
const DEBT_READ_CONCURRENCY = 8;
const UNISWAP_POOL_ABI = parseAbi([
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function fee() view returns (uint24)',
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
]);
const POSITION_MANAGER_ABI = parseAbi([
  'function factory() view returns (address)',
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)',
]);
const FACTORY_ABI = parseAbi(['function getPool(address tokenA, address tokenB, uint24 fee) view returns (address)']);
const TOKEN_ABI = parseAbi(['function decimals() view returns (uint8)']);
const STABLECOIN_ABI = parseAbi(['function stablecoin() view returns (address)']);
const POSITION_READ_CONCURRENCY = 4;

/** True when the contract itself refused the call, as the position manager does for a token id that does not exist. */
const isContractRevert = (error: unknown): boolean =>
  error instanceof BaseError && error.walk((cause) => cause instanceof ContractFunctionRevertedError) !== null;

export const createLedgerChainClient = (config: LedgerConfig): LedgerChainClient => {
  const client = createPublicClient({
    chain: config.chainId === 1 ? mainnet : sepolia,
    transport: http(config.rpcUrl),
  });
  const readPool = (functionName: 'totalDeposits' | 'P' | 'currentScale' | 'currentEpoch', blockNumber: bigint) =>
    client.readContract({ address: config.pool, abi: POOL_ABI, functionName, blockNumber });
  return {
    getChainId: () => client.getChainId(),
    getBlockNumber: () => client.getBlockNumber(),
    getLogs: (fromBlock, toBlock) =>
      config.liquidity === undefined
        ? client.getLogs({ address: [config.vault, config.pool], events: LEDGER_EVENTS, fromBlock, toBlock })
        : client.getLogs({
            address: [config.vault, config.pool, config.liquidity.pool],
            events: [...LEDGER_EVENTS, ...LIQUIDITY_POOL_EVENTS],
            fromBlock,
            toBlock,
          }),
    getPositionLiquidityLogs: async (transactionHash) => {
      const manager = config.liquidity?.positionManager.toLowerCase();
      if (manager === undefined) throw new Error('the liquidity dimension is not configured');
      const receipt = await client.getTransactionReceipt({ hash: transactionHash });
      const ofManager = receipt.logs.filter((log) => log.address.toLowerCase() === manager);
      return parseEventLogs({ abi: POSITION_LIQUIDITY_EVENTS, logs: ofManager });
    },
    getPositionTransferLogs: (fromBlock, toBlock, tokenIds) => {
      const manager = config.liquidity?.positionManager;
      if (manager === undefined) throw new Error('the liquidity dimension is not configured');
      return client.getLogs({
        address: manager,
        event: POSITION_TRANSFER_EVENT,
        args: { tokenId: [...tokenIds] },
        fromBlock,
        toBlock,
      });
    },
    getBlockTimestamp: async (block) => {
      const { timestamp } = await client.getBlock({ blockNumber: block });
      return Number(timestamp);
    },
    readPoolState: async (block) => {
      const [total, P, scale, epoch, vaultPool] = await Promise.all([
        readPool('totalDeposits', block),
        readPool('P', block),
        readPool('currentScale', block),
        readPool('currentEpoch', block),
        client.readContract({ address: config.vault, abi: VAULT_ABI, functionName: 'stabilityPool', blockNumber: block }),
      ]);
      return { total, P, scale, epoch, vaultPool: getAddress(vaultPool) };
    },
    readVaultDebts: async (block, owners) => {
      const debts: bigint[] = [];
      for (let start = 0; start < owners.length; start += DEBT_READ_CONCURRENCY) {
        const batch = owners.slice(start, start + DEBT_READ_CONCURRENCY);
        const vaults = await Promise.all(
          batch.map((owner) =>
            client.readContract({
              address: config.vault,
              abi: VAULT_ABI,
              functionName: 'vaults',
              args: [owner],
              blockNumber: block,
            })
          )
        );
        debts.push(...vaults.map(([, , debtAmount]) => debtAmount));
      }
      return debts;
    },
    readLiquidityFacts: async ({ pool, positionManager }) => {
      const [token0, token1, fee, factory, stablecoin] = await Promise.all([
        client.readContract({ address: pool, abi: UNISWAP_POOL_ABI, functionName: 'token0' }),
        client.readContract({ address: pool, abi: UNISWAP_POOL_ABI, functionName: 'token1' }),
        client.readContract({ address: pool, abi: UNISWAP_POOL_ABI, functionName: 'fee' }),
        client.readContract({ address: positionManager, abi: POSITION_MANAGER_ABI, functionName: 'factory' }),
        client.readContract({ address: config.vault, abi: STABLECOIN_ABI, functionName: 'stablecoin' }),
      ]);
      const [decimals0, decimals1, factoryPool] = await Promise.all([
        client.readContract({ address: token0, abi: TOKEN_ABI, functionName: 'decimals' }),
        client.readContract({ address: token1, abi: TOKEN_ABI, functionName: 'decimals' }),
        client.readContract({ address: factory, abi: FACTORY_ABI, functionName: 'getPool', args: [token0, token1, fee] }),
      ]);
      return {
        token0: getAddress(token0),
        token1: getAddress(token1),
        fee,
        decimals0,
        decimals1,
        stablecoin: getAddress(stablecoin),
        factoryPool: getAddress(factoryPool),
      };
    },
    readPositions: async (block, tokenIds) => {
      const manager = config.liquidity?.positionManager;
      if (manager === undefined) throw new Error('the liquidity dimension is not configured');
      const readOne = async (tokenId: bigint): Promise<ChainPosition | undefined> => {
        try {
          const [position, owner] = await Promise.all([
            client.readContract({ address: manager, abi: POSITION_MANAGER_ABI, functionName: 'positions', args: [tokenId], blockNumber: block }),
            client.readContract({ address: manager, abi: POSITION_MANAGER_ABI, functionName: 'ownerOf', args: [tokenId], blockNumber: block }),
          ]);
          const [, , token0, token1, fee, tickLower, tickUpper, liquidity] = position;
          return { token0: getAddress(token0), token1: getAddress(token1), fee, tickLower, tickUpper, liquidity, owner: getAddress(owner) };
        } catch (error) {
          if (isContractRevert(error)) return undefined;
          throw error;
        }
      };
      const positions: (ChainPosition | undefined)[] = [];
      for (let start = 0; start < tokenIds.length; start += POSITION_READ_CONCURRENCY) {
        positions.push(...(await Promise.all(tokenIds.slice(start, start + POSITION_READ_CONCURRENCY).map(readOne))));
      }
      return positions;
    },
    readPoolTick: async (block) => {
      const pool = config.liquidity?.pool;
      if (pool === undefined) throw new Error('the liquidity dimension is not configured');
      const [sqrtPriceX96, tick] = await client.readContract({ address: pool, abi: UNISWAP_POOL_ABI, functionName: 'slot0', blockNumber: block });
      return sqrtPriceX96 === 0n ? null : tick;
    },
  };
};
