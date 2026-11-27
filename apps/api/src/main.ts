import {
  appRouter,
  createLedgerRecordHandlers,
  createTRPCExpressMiddleware,
  LEDGER_RECORD_CSV_PATH,
  LEDGER_RECORD_JSON_PATH,
  runShutdownTasks,
} from '@goldstandard/trpc';

import { createApp } from './app';
import { readApiConfig, trustProxyExposureWarning } from './config';
import { listenApi, listeningUrl } from './listen';
import { createGracefulShutdown, exitOnListenFailure, installSignalHandlers } from './shutdown';

/** How long SIGTERM waits for requests in flight before exiting anyway. */
const DRAIN_TIMEOUT_MS = 10_000;

export { parseTrustProxyHops } from './config';

const start = (): void => {
  // PORT, API_HOST, TRUST_PROXY_HOPS, RATE_MAX_REQUESTS, DAPP_DIST and CORS_ORIGINS; a bad value stops here with its name.
  const config = readApiConfig(process.env);
  // Logged once per start: only a firewall can make this pair safe, and none is visible from here.
  const exposure = trustProxyExposureWarning(config);
  if (exposure !== undefined) console.warn(exposure);
  const { app } = createApp({
    trpc: createTRPCExpressMiddleware(appRouter),
    trustProxyHops: config.trustProxyHops,
    rateMaxRequests: config.rateMaxRequests,
    dappDist: config.dappDist,
    corsOrigins: config.corsOrigins,
    // With the ledger off both paths answer 404 and open nothing.
    ledgerRecord: { csvPath: LEDGER_RECORD_CSV_PATH, jsonPath: LEDGER_RECORD_JSON_PATH, ...createLedgerRecordHandlers() },
  });
  const server = listenApi(app, config, () => {
    console.info(`Listening at ${listeningUrl(config)}`);
  });
  // A bind failure arrives here asynchronously, outside the try below. Logging it and
  // carrying on left a process alive with no listener that a supervisor saw as healthy.
  exitOnListenFailure({ server, port: config.port, tasks: runShutdownTasks, exit: (code) => process.exit(code) });
  // Drain before exiting. The indexer used to exit on SIGTERM
  // on its own, cutting off requests in flight; it now registers its cleanup instead.
  const shutdown = createGracefulShutdown({
    server,
    tasks: runShutdownTasks,
    exit: (code) => process.exit(code),
    timeoutMs: DRAIN_TIMEOUT_MS,
  });
  installSignalHandlers(shutdown);
};

try {
  start();
} catch (error) {
  console.error(`API configuration error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

export type AppRouter = typeof appRouter;
