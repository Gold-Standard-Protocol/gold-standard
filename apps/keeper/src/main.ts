import { createPublicClient, createWalletClient, http } from 'viem';
import type {
  Abi,
  Account,
  Chain,
  EstimateContractGasParameters,
  SimulateContractParameters,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { mainnet, sepolia } from 'viem/chains';

import {
  createCachedOffChainPriceSource,
  createHeartbeatPinger,
  createHttpOffChainPriceSource,
  createJsonLogger,
  createTallyingLogger,
  createTickReadCache,
  describeError,
  KEEPER_EVENTS,
  parseKeeperConfig,
  redactUrls,
  startKeeper,
} from '@goldstandard/trpc/keeper';
import type { KeeperConfig, KeeperLogger, KeeperTxSender } from '@goldstandard/trpc/keeper';
import { boundFees } from './fees';
import { sizeGasLimit } from './gas';
import { createOwnerSource } from './ownerSources';
import { createPendingTransactionGuard } from './pendingTransactions';
import { createReadClient } from './readClient';
import { checkReadRpcUrls, createReadPublicClient } from './readRpc';

// Keeper bootstrap. This file and libs/trpc/src/lib/keeper/config.ts are the
// ONLY two files that ever reference KEEPER_PRIVATE_KEY, and this is the only
// place process.env is read for the keeper. The key is parsed, validated and
// handed to viem; it is never logged (keeper.started carries the signer
// ADDRESS only). The RPC URLs carry provider keys, so they are never logged
// either: every error message passes through describeError, which redacts
// URLs, and keeper.started counts the read endpoints without naming them.
// KEEPER_HEARTBEAT_URL is a capability too: only its host is logged. The keeper imports '@goldstandard/trpc/keeper', never '@goldstandard/trpc': the
// package entry of @goldstandard/trpc starts the price worker and opens an IORedis
// connection at module load, neither of which a keeper wants. Pre-merge gate:
// `grep -c KEEPER_PRIVATE_KEY dist/apps/api/main.js` must return 0 after
// `nx build api`.

const CHAINS: Readonly<Record<KeeperConfig['chainId'], Chain>> = {
  1: mainnet,
  11155111: sepolia,
};

type KeeperPublicClient = ReturnType<typeof createPublicClient>;

type ContractCall = {
  address: `0x${string}`;
  abi: Abi;
  functionName: string;
  args: readonly unknown[];
};

type GenericSimulateParameters = SimulateContractParameters<
  Abi,
  string,
  readonly unknown[],
  Chain,
  Chain | undefined,
  Account
>;

type GenericEstimateParameters = EstimateContractGasParameters<
  Abi,
  string,
  readonly unknown[],
  Chain
>;

/** A plain transfer to an externally owned account, the replacement for a stuck nonce. */
const SELF_TRANSFER_GAS = 21_000n;

/**
 * Live transaction sender: the node's fee estimate is bounded by the operator's
 * ceilings, the node's gas estimate is padded and clamped per function, and
 * simulateContract runs with exactly those figures so a state change between the
 * keeper's read and its send fails in simulation instead of burning gas. The
 * send then uses the simulated request at the nonce the pending-transaction guard
 * handed out, and the guard records the nonce and fees so it can replace the
 * transaction if it sticks. Returns undefined in dry run
 * so every job takes the watch-only path.
 */
const createTxSender = (
  config: KeeperConfig,
  publicClient: KeeperPublicClient,
  log: KeeperLogger
): KeeperTxSender | undefined => {
  if (config.dryRun || config.privateKey === undefined) {
    return undefined;
  }
  const account = privateKeyToAccount(config.privateKey);
  const walletClient = createWalletClient({
    account,
    chain: CHAINS[config.chainId],
    transport: http(config.rpcUrl),
  });
  const ceilings = {
    maxFeePerGasWei: config.maxFeePerGasWei,
    maxPriorityFeePerGasWei: config.maxPriorityFeePerGasWei,
  };
  const pendingGuard = createPendingTransactionGuard({
    client: {
      getTransactionCount: (args) => publicClient.getTransactionCount(args),
      estimateFeesPerGas: () => publicClient.estimateFeesPerGas(),
      sendSelfTransfer: ({ nonce, fees }) =>
        walletClient.sendTransaction({
          to: account.address,
          value: 0n,
          gas: SELF_TRANSFER_GAS,
          nonce,
          ...fees,
        }),
    },
    account: account.address,
    ceilings,
    replaceAfterMs: config.stuckTxReplaceSeconds * 1000,
    log,
  });
  const send = async (call: ContractCall): Promise<`0x${string}`> => {
    const nonce = await pendingGuard.nextNonce();
    const feeEstimate = await publicClient.estimateFeesPerGas();
    // The estimate pads the base fee by 1.2, so above the ceiling the unpadded base fee
    // decides whether a send capped at the ceiling is still includable (fees.ts).
    const baseFeePerGas =
      feeEstimate.maxFeePerGas > ceilings.maxFeePerGasWei
        ? (await publicClient.getBlock({ blockTag: 'latest' })).baseFeePerGas ?? undefined
        : undefined;
    const feeDecision = boundFees(feeEstimate, ceilings, baseFeePerGas);
    if (!feeDecision.ok) {
      log.warn(KEEPER_EVENTS.feeAboveCeiling, {
        functionName: call.functionName,
        reason: feeDecision.reason,
      });
      throw new Error(feeDecision.reason);
    }
    const estimate = await publicClient.estimateContractGas({
      account,
      ...call,
    } as GenericEstimateParameters);
    const { request } = await publicClient.simulateContract({
      account,
      ...call,
      gas: sizeGasLimit(call.functionName, estimate),
      ...feeDecision.fees,
    } as GenericSimulateParameters);
    const hash = await walletClient.writeContract({ ...request, nonce });
    pendingGuard.recordSent(nonce, feeDecision.fees);
    return hash;
  };
  return {
    account: account.address,
    simulateAndSend: async (call) => {
      try {
        return { ok: true, hash: await send(call) };
      } catch (error) {
        return { ok: false, reason: describeError(error) };
      }
    },
    waitForReceipt: async (hash) => {
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      return { status: receipt.status };
    },
  };
};

const fail = (reason: string): never => {
  // Fail fast: unlike the dormant indexer, this process exists solely to
  // keep, so an unconfigured keeper is an operational fault, not a no-op.
  process.stderr.write(`${redactUrls(reason)}\n`);
  process.exit(1);
};

const main = async (): Promise<void> => {
  const result = parseKeeperConfig(process.env);
  if (!result.ok) {
    fail(result.reason);
    return;
  }
  const config = result.config;
  // Every line the keeper writes passes through the tally, so the keeper.heartbeat line counts
  // what the owner sources and the sender report as well as what the jobs do (heartbeat.ts).
  const tally = createTallyingLogger(createJsonLogger());
  const log = tally.log;

  const chain = CHAINS[config.chainId];
  // The send endpoint: nonces, estimates, simulations, sends and receipts (readRpc.ts).
  const publicClient = createPublicClient({ chain, transport: http(config.rpcUrl) });
  // The RPC must be the chain the addresses were configured for: a keeper pointed
  // at the wrong network would read nothing and, armed, sign against it.
  const rpcChainId = await publicClient.getChainId();
  if (rpcChainId !== config.chainId) {
    fail(
      `KEEPER_RPC_URL answers eth_chainId ${rpcChainId} but KEEPER_CHAIN_ID is ${config.chainId}; refusing to start.`
    );
    return;
  }
  // Every other read goes to KEEPER_READ_RPC_URLS first, when set, so the send endpoint's
  // rate limit or outage does not blind the keeper.
  const readRpc = await checkReadRpcUrls(
    config.readRpcUrls ?? [],
    config.chainId,
    (url) => createPublicClient({ chain, transport: http(url, { retryCount: 1 }) }).getChainId(),
    log
  );
  if (!readRpc.ok) {
    fail(readRpc.reason);
    return;
  }

  // One tick reuses an answer it has already read and fetches its known reads in one
  // request; a send switches that off for the rest of the tick (tickReadCache.ts).
  const readCache = createTickReadCache(
    createReadClient(createReadPublicClient(chain, readRpc.urls, config.rpcUrl)),
    { maxAgeMs: config.readCacheMs }
  );
  const read = readCache.read;
  const tx = readCache.guardTx(createTxSender(config, publicClient, log));
  const { owners, names } = createOwnerSource(config, read, log);
  // The price watchdog's market price: the API's cached aggregator quote from the shared
  // Redis when there is one, otherwise fetched by the keeper itself, so the Redis-free
  // keeper host keeps the one check that is independent of Chainlink. With `none` the
  // watchdog still checks the on-chain sources and says once that it has nothing to
  // compare them with. Read only: the quote reaches log lines and nothing else.
  const offChainPrices =
    config.offChainPriceSource === 'redis'
      ? createCachedOffChainPriceSource(config)
      : config.offChainPriceSource === 'http'
        ? createHttpOffChainPriceSource(config, { url: config.priceApiUrl })
        : undefined;

  // The hosted dead-man check, pinged after every clean tick (heartbeat.ts).
  const heartbeat =
    config.heartbeatUrl === undefined ? undefined : createHeartbeatPinger(config.heartbeatUrl, log);

  log.info(KEEPER_EVENTS.started, {
    chainId: config.chainId,
    dryRun: config.dryRun,
    intervalSeconds: config.intervalSeconds,
    // How many KEEPER_READ_RPC_URLS entries answered at start; reads fall back to KEEPER_RPC_URL.
    readRpcEndpoints: readRpc.urls.length,
    // Address only, never the key. Null while watch-only (dry run needs no key).
    signer: tx?.account ?? null,
    enableDirect: config.enableDirect,
    // PAXG-only launch when false: all XAUT keeper tasks are skipped.
    xautEnabled: config.xautToken !== undefined,
    vaultRegistry: config.vaultRegistryAddress ?? null,
    // Which owner lists this keeper reads; "registry" alone means no Redis client exists.
    ownerSources: names,
    maxFeePerGasWei: config.maxFeePerGasWei,
    maxPriorityFeePerGasWei: config.maxPriorityFeePerGasWei,
    priceWatchdogAlertBps: config.priceWatchdogAlertBps,
    stuckTxReplaceSeconds: config.stuckTxReplaceSeconds,
    // 0 means every read goes to the chain; otherwise the reuse window within a tick.
    readCacheMs: config.readCacheMs,
    offChainPriceSource: offChainPrices === undefined ? null : config.offChainPriceSource,
    priceApiUrl: config.offChainPriceSource === 'http' ? config.priceApiUrl : null,
    // An oracle.feed-late warning is due once a feed is this much older than its heartbeat.
    feedHeartbeatSeconds: config.feedHeartbeatSeconds,
    feedLateMarginSeconds: config.feedLateMarginSeconds,
    feedLateRepeatSeconds: config.feedLateRepeatSeconds,
    // Host only: the path of KEEPER_HEARTBEAT_URL is the secret. Null sends no ping.
    heartbeatHost: heartbeat?.host ?? null,
  });

  startKeeper(config, { read, tx, owners, log, offChainPrices }, undefined, { heartbeat, tally });
};

main().catch((error: unknown) => {
  fail(`Keeper failed to start: ${describeError(error)}`);
});
