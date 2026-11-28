import { readFile } from 'node:fs/promises';

import { createPublicClient, fallback, http } from 'viem';

import { parseWatcherConfig } from './config';
import { parseDeployment } from './deployment';
import { createFileStateStore } from './fileStateStore';
import type { WatchedLog } from './format';
import { createHeartbeat } from './heartbeat';
import { FULLY_HELD_PPM, lowestHeldShare } from './poolHoldings';
import {
  CONTRACT_KEYS,
  POOL_HOLDINGS_RULE_ID,
  READ_ABI,
  RESERVE_COVERAGE_RULE_ID,
  RULE_COUNT,
  VAULT_RATIO_RULE_ID,
  WATCHED_EVENTS,
} from './rules';
import { createPrintingSender, createTelegramSender } from './telegram';
import { createJsonLogger, describeError } from './text';
import type { ThresholdCheck } from './thresholds';
import { runTick } from './tick';

// Watcher bootstrap: the only place process.env is read. The watcher holds no key and sends
// no transaction; it reads logs and a few view functions and writes to one Telegram chat. The
// RPC URLs, the bot token and the heartbeat URL are never logged: every error passes through
// describeError, which cuts URLs to their host and removes anything shaped like a bot token.

const EXPLORERS: Readonly<Record<number, string>> = {
  1: 'https://etherscan.io',
  11155111: 'https://sepolia.etherscan.io',
};

const log = createJsonLogger((line) => process.stdout.write(line));

const sleep = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));

const main = async (): Promise<void> => {
  const config = parseWatcherConfig(process.env);
  const deployment = parseDeployment(await readFile(config.deploymentFile, 'utf8'));
  const explorerUrl = EXPLORERS[deployment.chainId];
  if (explorerUrl === undefined) throw new Error(`no explorer is known for chain ${deployment.chainId}`);

  const transports = config.rpcUrls.map((url) => http(url, { retryCount: 1, timeout: 20_000 }));
  const client = createPublicClient({ transport: transports.length === 1 ? transports[0] : fallback(transports) });
  const chainId = await client.getChainId();
  if (chainId !== deployment.chainId)
    throw new Error(`the RPC endpoint is on chain ${chainId} and the deployment snapshot on chain ${deployment.chainId}`);

  const watched = CONTRACT_KEYS.map((key) => deployment.addresses[key]);
  const getLogs = async (fromBlock: number, toBlock: number): Promise<WatchedLog[]> => {
    const logs = await client.getLogs({
      address: watched,
      events: WATCHED_EVENTS,
      fromBlock: BigInt(fromBlock),
      toBlock: BigInt(toBlock),
      strict: true,
    });
    return logs
      .filter((entry) => !entry.removed)
      .map((entry) => ({
        address: entry.address,
        eventName: entry.eventName,
        args: entry.args as Record<string, unknown>,
        blockNumber: Number(entry.blockNumber),
        logIndex: entry.logIndex,
        transactionHash: entry.transactionHash,
      }));
  };

  const pool = deployment.addresses.stabilityPool;
  const readPoolHoldings = async (): Promise<bigint> => {
    const tokens = await client.readContract({
      address: deployment.addresses.oracle,
      abi: READ_ABI,
      functionName: 'getSupportedTokens',
    });
    const holdings = await Promise.all(
      tokens.map(async (token) => {
        const [held, recorded] = await Promise.all([
          client.readContract({ address: token, abi: READ_ABI, functionName: 'balanceOf', args: [pool] }),
          client.readContract({ address: pool, abi: READ_ABI, functionName: 'collateralAccounted', args: [token] }),
        ]);
        return { held, recorded };
      })
    );
    return lowestHeldShare(holdings);
  };

  const checks: ThresholdCheck[] = [
    ...config.vaultOwners.map(
      (owner): ThresholdCheck => ({
        key: `vault-ratio:${owner.toLowerCase()}`,
        ruleId: VAULT_RATIO_RULE_ID,
        severity: 'page',
        subject: `The collateral ratio of vault ${owner}`,
        floor: config.vaultRatioFloor,
        read: () =>
          client.readContract({
            address: deployment.addresses.vault,
            abi: READ_ABI,
            functionName: 'getCollateralisationRatio',
            args: [owner],
          }),
      })
    ),
    {
      key: 'reserve-coverage',
      ruleId: RESERVE_COVERAGE_RULE_ID,
      severity: 'note',
      subject: 'The reserve coverage of circulating GSUSD',
      floor: config.reserveCoverageFloor,
      read: () => client.readContract({ address: deployment.addresses.reserve, abi: READ_ABI, functionName: 'coveragePpm' }),
    },
    {
      key: 'pool-holdings',
      ruleId: POOL_HOLDINGS_RULE_ID,
      severity: 'page',
      subject: 'The gold the stability pool holds, as a share of the gold it has recorded,',
      floor: FULLY_HELD_PPM,
      read: readPoolHoldings,
    },
  ];

  const send =
    config.telegram === undefined || config.dryRun
      ? createPrintingSender((text) => process.stdout.write(text))
      : createTelegramSender(config.telegram);
  const store = createFileStateStore(config.stateFile);
  const heartbeat = config.heartbeatUrl === undefined ? undefined : createHeartbeat(config.heartbeatUrl, log);

  let state = await store.load();
  const head = Number(await client.getBlockNumber());
  log.info('watcher.started', {
    chainId,
    head,
    nextBlock: state?.nextBlock ?? head + 1,
    rules: RULE_COUNT,
    vaultOwners: config.vaultOwners.length,
    rpcEndpoints: config.rpcUrls.length,
    dryRun: config.dryRun,
    heartbeatHost: heartbeat?.host ?? null,
  });
  // The proof that the channel works. A start that cannot say so stops, so a wrong token or
  // chat is noticed at once and the service manager tries again.
  await send({
    severity: 'note',
    text: [
      'NOTE: watcher started',
      `Chain ${chainId}, head block ${head}. Reporting from block ${state?.nextBlock ?? head + 1}.`,
      `${RULE_COUNT} rules, ${config.vaultOwners.length} vault${config.vaultOwners.length === 1 ? '' : 's'} on the ratio check.`,
    ].join('\n'),
  });

  for (;;) {
    try {
      const result = await runTick(state, {
        deployment,
        explorerUrl,
        getLogs,
        send,
        log,
        getHeadBlock: async () => Number(await client.getBlockNumber()),
        nowSeconds: () => Math.floor(Date.now() / 1000),
        store,
        checks,
        repeatSeconds: config.repeatSeconds,
        heartbeat: heartbeat?.ping,
      });
      if (result !== undefined) state = result.state;
    } catch (error) {
      log.error('watcher.tick-failed', { reason: describeError(error) });
    }
    await sleep(config.pollSeconds * 1000);
  }
};

main().catch((error: unknown) => {
  log.error('watcher.fatal', { reason: describeError(error) });
  process.exitCode = 1;
});
