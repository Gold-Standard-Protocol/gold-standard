import type { Logger } from './text';

export const HEARTBEAT_TIMEOUT_MS = 5_000;

export type PingFetch = (
  url: string,
  init: { method: 'GET'; signal: AbortSignal; redirect: 'error' }
) => Promise<{ ok: boolean; status: number }>;

/**
 * A GET to a hosted dead-man check. The URL is a capability, so only its host is logged, and
 * a failed ping is a warning that never stops the watcher. Redirects are refused: following
 * one would send the request somewhere the operator did not configure.
 */
export const createHeartbeat = (
  url: string,
  log: Logger,
  options: { fetch?: PingFetch; timeoutMs?: number } = {}
): { host: string; ping: () => Promise<void> } => {
  const host = new URL(url).host;
  const request: PingFetch = options.fetch ?? ((input, init) => fetch(input, init));
  const timeoutMs = options.timeoutMs ?? HEARTBEAT_TIMEOUT_MS;
  return {
    host,
    ping: async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await request(url, { method: 'GET', signal: controller.signal, redirect: 'error' });
        if (!response.ok) log.warn('watcher.heartbeat-ping-failed', { host, reason: `HTTP ${response.status}` });
      } catch (error) {
        log.warn('watcher.heartbeat-ping-failed', {
          host,
          reason: controller.signal.aborted
            ? `no answer within ${timeoutMs} ms`
            : `request failed (${error instanceof Error ? error.name : 'unknown error'})`,
        });
      } finally {
        clearTimeout(timer);
      }
    },
  };
};
