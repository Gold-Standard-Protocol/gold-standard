import type { Abi, Address } from 'viem';

// Dependency-injection seams for every keeper job, modelled on the indexer's
// VaultLogClient and IndexerCacheStore: nothing in the keeper specs touches a
// live chain or Redis. Production adapters live in apps/keeper/src/main.ts
// (chain clients) and ownerSource.ts (Redis-backed owner set).

export interface KeeperContractCall {
  address: Address;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
}

export type KeeperBatchResult =
  | { status: 'success'; result: unknown }
  | { status: 'failure'; error: unknown };

/** Narrow wrapper over viem PublicClient.readContract, injectable for tests. */
export interface KeeperReadClient {
  readContract(args: KeeperContractCall): Promise<unknown>;
  /**
   * Optional multicall. The liquidation walk reads each owner's debt, then each indebted
   * vault and its liquidation price, and the owner set is permissionless (any address that
   * deposits one unit joins it), so a sequential walk of thousands of junk owners took
   * minutes per tick and delayed real liquidations. With this seam the walk costs one RPC
   * round trip per few hundred owners; without it the job falls back to sequential reads.
   * A failed call comes back as a failure entry, and the adapter may also throw for the
   * whole batch; either way the owners concerned fall back to retries and single reads.
   */
  readContracts?(calls: readonly KeeperContractCall[]): Promise<KeeperBatchResult[]>;
  /**
   * Optional: the latest block's timestamp, so the oracle health job judges a source's
   * age exactly as GoldOracle does (block.timestamp against stalenessThreshold). Without
   * it the job still reports every answer but cannot call a round stale.
   */
  getBlockTimestamp?(): Promise<bigint>;
  /**
   * Optional: the latest block's number and timestamp, for the keeper.heartbeat line. A
   * client without it reports no head; one whose read throws marks the tick as not clean,
   * since a keeper that cannot read the head cannot see its vaults either.
   */
  getHeadBlock?(): Promise<{ number: bigint; timestamp: bigint }>;
  /**
   * Optional: an account's ETH balance in wei, so the signer balance watch can warn before
   * the keeper wallet is too empty to pay for a liquidation. A dry run never asks for it. A
   * keeper that signs without it has its watch fail every tick (keeper.job-error), so a
   * missing adapter is never read as a funded wallet.
   */
  getBalance?(address: Address): Promise<bigint>;
  /**
   * Optional: called by the scheduler once at the start of every tick, before the first
   * job. A client that reuses answers within a tick (tickReadCache.ts) drops them here and
   * may fetch the tick's known reads in one request. A plain client has nothing to do.
   */
  beginTick?(): Promise<void>;
}

export type KeeperTxResult =
  | { ok: true; hash: `0x${string}` }
  | { ok: false; reason: string };

/**
 * Transaction sender that always simulates before sending so a state change
 * between read and send fails in simulation instead of burning gas. Undefined
 * in the deps of a dry-run or watch-only keeper.
 */
export interface KeeperTxSender {
  /** Address of the signing account; used for balance and allowance checks. */
  readonly account: Address;
  simulateAndSend(args: {
    address: Address;
    abi: Abi;
    functionName: string;
    args: readonly unknown[];
  }): Promise<KeeperTxResult>;
  /**
   * Optional: block until `hash` is mined. A liquidation simulated in the same tick
   * as the approval it depends on sees the OLD allowance (the approval is still in the
   * mempool), fails, and revokes; the direct path never executed without this.
   */
  waitForReceipt?(hash: `0x${string}`): Promise<{ status: 'success' | 'reverted' }>;
}

/**
 * Source of vault owner addresses. The production implementation reads the
 * exact Redis set the indexer writes (vaultOwnersSetKey(chainId) parsed with
 * parseStoredOwners); the keeper never rescans logs itself.
 */
export interface VaultOwnerSource {
  getOwners(): Promise<Address[]>;
}

/**
 * One off-chain market quote, display grade: the API's cached aggregator price. The
 * watchdog compares it with the oracle and logs; it never reaches a transaction.
 */
export type OffChainPriceRead =
  | {
      ok: true;
      /** USD price of one whole token, 8 decimals, the oracle's own unit. */
      price: bigint;
      /** Milliseconds since the epoch at which the quote was cached. */
      updatedAt: number;
      /** Where the quote came from, for the alert. */
      source: string;
    }
  | { ok: false; reason: string };

export interface OffChainPriceSource {
  getUsdPrice(token: Address): Promise<OffChainPriceRead>;
}

export interface KeeperLogger {
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

/** Bundle every job takes; `tx` is undefined for a watch-only keeper. */
export interface KeeperJobDeps {
  read: KeeperReadClient;
  tx: KeeperTxSender | undefined;
  owners: VaultOwnerSource;
  log: KeeperLogger;
  /**
   * Read only by the price watchdog. Undefined on a keeper without Redis, where the
   * watchdog still checks the on-chain sources and says once per tick that it has no
   * market price to compare them with.
   */
  offChainPrices?: OffChainPriceSource;
  /**
   * Injectable clock for specs; Date.now otherwise. The liquidation watch ages its price
   * quotes against it.
   */
  now?: () => number;
}
