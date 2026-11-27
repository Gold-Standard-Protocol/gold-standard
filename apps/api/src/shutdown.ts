import type { Server } from 'node:http';

export interface ListenFailureOptions {
  server: Server;
  port: number;
  /** The same cleanup the graceful shutdown runs. */
  tasks: () => Promise<void>;
  /** process.exit in production; injectable for specs. */
  exit: (code: number) => void;
}

/**
 * An http.Server emits 'error' only when it cannot bind or listen (the port is taken, say);
 * client faults arrive as 'clientError'. Run the registered cleanup and exit with status 1,
 * so the supervisor restarts or pages instead of watching a process that serves nothing.
 */
export const exitOnListenFailure = (options: ListenFailureOptions): void => {
  options.server.once('error', (error: Error) => {
    console.error(`API failed to listen on port ${options.port}: ${error.message}`);
    void options
      .tasks()
      .catch((cleanupError: unknown) => {
        console.error(
          'Shutdown cleanup failed:',
          cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
        );
      })
      .finally(() => options.exit(1));
  });
};

/**
 * A `once` listener is removed after the first signal, which hands the next SIGTERM back to
 * Node's default and kills the drain in flight. Keep listening: the drain closure already
 * makes every later signal a no-op.
 */
export const installSignalHandlers = (shutdown: () => void, target: NodeJS.EventEmitter = process): void => {
  target.on('SIGTERM', shutdown);
  target.on('SIGINT', shutdown);
};

export interface GracefulShutdownOptions {
  server: Server;
  /** Cleanup the libraries registered (the vault index queue and worker, say). */
  tasks: () => Promise<void>;
  /** process.exit in production; injectable for specs. */
  exit: (code: number) => void;
  /** How long the drain may take before the process exits anyway, with status 1. */
  timeoutMs: number;
  /** How long the cleanup may take once the deadline has cut the drain short. */
  taskTimeoutMs?: number;
}

/** How often the drain closes keep-alive connections that have gone idle since the signal. */
const IDLE_SWEEP_MS = 250;
const DEFAULT_TASK_TIMEOUT_MS = 5_000;

/**
 * The SIGTERM and SIGINT handler. The server stops accepting
 * connections, closes the idle keep-alive ones and answers every request already in
 * flight; the registered cleanup runs after that, and only then does the process exit.
 * A second signal while draining changes nothing.
 *
 * Node's close() closes idle connections once, and a pooled
 * keep-alive connection that was busy at the signal stays open after its answer, so the
 * drain sweeps idle connections until the server has closed. A drain that still outlasts
 * the deadline cuts the remaining connections, runs the cleanup within its own cap and
 * exits with status 1, so a supervisor never waits on a stuck client for ever and the
 * queues are closed either way.
 */
export const createGracefulShutdown = (options: GracefulShutdownOptions): (() => void) => {
  let draining = false;
  return () => {
    if (draining) return;
    draining = true;
    let timedOut = false;
    let backstop: NodeJS.Timeout | undefined;
    const sweep = setInterval(() => options.server.closeIdleConnections(), IDLE_SWEEP_MS);
    sweep.unref();
    const deadline = setTimeout(() => {
      timedOut = true;
      options.server.closeAllConnections();
      // Cleanup that never settles still ends in exit 1.
      backstop = setTimeout(() => options.exit(1), options.taskTimeoutMs ?? DEFAULT_TASK_TIMEOUT_MS);
      backstop.unref();
    }, options.timeoutMs);
    deadline.unref();
    const closed = new Promise<void>((resolve) => {
      options.server.close(() => resolve());
      options.server.closeIdleConnections();
    });
    void closed
      .then(() => {
        clearInterval(sweep);
        return options.tasks();
      })
      .catch((error: unknown) => {
        console.error('Shutdown cleanup failed:', error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        clearTimeout(deadline);
        clearTimeout(backstop);
        options.exit(timedOut ? 1 : 0);
      });
  };
};
