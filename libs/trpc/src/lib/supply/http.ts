import type { IncomingMessage, ServerResponse } from 'node:http';
import { formatUnits } from 'viem';

/**
 * GSUSD supply as a plain number over HTTP, for listing sites that poll an address and
 * expect nothing but the figure. Total and circulating are the same number: GSUSD exists
 * only as vault debt, with no allocation held back, so both paths answer alike.
 */
export const SUPPLY_TOTAL_PATH = '/supply/total';
export const SUPPLY_CIRCULATING_PATH = '/supply/circulating';

const GSUSD_DECIMALS = 18;
/** How long one read is served before the chain is asked again. */
const FRESH_MS = 60_000;
/** How long the last good read stands in while the endpoint fails; past it the answer is 503. */
const STALE_MS = 10 * 60_000;
const CACHE_CONTROL = 'public, max-age=60';
const RETRY_AFTER_SECONDS = '60';

/** Reads `totalSupply()` of GSUSD, in its smallest unit. */
export type SupplyReader = () => Promise<bigint>;

export type SupplyHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

export interface SupplyHandlerOptions {
  now?: () => number;
  /** Told once per failed read; the value carries no endpoint URL. */
  onReadFailure?: (error: unknown) => void;
}

interface Reading {
  value: bigint;
  at: number;
}

const sendText = (req: IncomingMessage, res: ServerResponse, status: number, body: string, headers: Record<string, string>): void => {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': Buffer.byteLength(body), ...headers });
  res.end(req.method === 'HEAD' ? undefined : body);
};

/**
 * The handler for both paths. Without a reader (the chain settings are incomplete) it
 * answers 404. A read is kept for a minute; when the endpoint fails, the last good read
 * stands in for ten minutes, and after that the answer is 503, never a guessed figure.
 */
export const createSupplyHandler = (read: SupplyReader | undefined, options: SupplyHandlerOptions = {}): SupplyHandler => {
  const now = options.now ?? Date.now;
  let last: Reading | undefined;
  let inFlight: Promise<Reading | undefined> | undefined;

  const refresh = (reader: SupplyReader): Promise<Reading | undefined> => {
    inFlight ??= reader()
      .then((value): Reading => {
        last = { value, at: now() };
        return last;
      })
      .catch((error: unknown): Reading | undefined => {
        options.onReadFailure?.(error);
        return last !== undefined && now() - last.at <= STALE_MS ? last : undefined;
      })
      .finally(() => {
        inFlight = undefined;
      });
    return inFlight;
  };

  return async (req, res) => {
    if (read === undefined) {
      sendText(req, res, 404, 'Not found', {});
      return;
    }
    const reading = last !== undefined && now() - last.at < FRESH_MS ? last : await refresh(read);
    if (reading === undefined) {
      sendText(req, res, 503, 'Supply unavailable, retry shortly', { 'Retry-After': RETRY_AFTER_SECONDS, 'Cache-Control': 'no-store' });
      return;
    }
    sendText(req, res, 200, formatUnits(reading.value, GSUSD_DECIMALS), { 'Cache-Control': CACHE_CONTROL });
  };
};
