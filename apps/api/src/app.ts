import express from 'express';
import type { Express, NextFunction, Request, RequestHandler, Response } from 'express';
import { extname, join } from 'node:path';

import { DEFAULT_RATE_MAX_REQUESTS, type CorsOrigins } from './config';
import { createRateLimiter, type RateLimiter } from './rateLimiter';
import { createSecurityHeaders, denyForbiddenPaths, isWellKnownPath, loadHeaderRules } from './securityHeaders';

/**
 * The Express application behind apps/api: the public tRPC surface behind a rate limit
 * and, in production, the dapp build itself. The dapp calls `/trpc` relative to its own
 * origin, so serving both from one process means one host, one TLS certificate and no
 * proxy rewrite to get wrong (docs/MAINNET.md section 4).
 */
export interface AppOptions {
  /** The tRPC middleware mounted at /trpc. */
  trpc: RequestHandler;
  /** Proxy hops in front of this process; see parseTrustProxyHops. */
  trustProxyHops?: number;
  /** Requests per client per minute on the tRPC surface; every call in a batch counts. */
  rateMaxRequests?: number;
  /** Absolute path of a dapp build (index.html, _headers and assets/) to serve from the same origin. */
  dappDist?: string;
  /** Origins allowed to call /trpc from a browser: "*" for any, or exact origins. Unset: same origin only. */
  corsOrigins?: CorsOrigins;
  /**
   * The Usage Ledger's whole record as a download: the CSV and the JSON that describes it,
   * each at its own path. Unset mounts neither (specs of the shell).
   */
  ledgerRecord?: { csvPath: string; jsonPath: string; csv: RequestHandler; json: RequestHandler };
}

export interface Api {
  app: Express;
  /** Stops the limiters' prune timers; call when the process or a spec is done with the app. */
  dispose: () => void;
}

const NO_CACHE = 'no-cache';
/** The dapp's own HSTS value (apps/dapp/public/_headers), so the two hosts never disagree. */
const TRPC_HSTS = 'max-age=31536000; includeSubDomains';
const CORS_METHODS = 'GET, POST, OPTIONS';
const CORS_HEADERS = 'content-type, trpc-accept, x-trpc-source';
const CORS_MAX_AGE_SECONDS = '86400';

/**
 * Browser cross-origin access to /trpc. The API carries no cookies or credentials, so no
 * credential flag is ever set. It runs ahead of the rate limiter so a 429 carries the
 * same headers and a browser client can read it rather than seeing an opaque failure.
 */
export function createCors(allowed: CorsOrigins): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const origin = req.headers.origin;
    const permitted = allowed === '*' ? '*' : origin && allowed.includes(origin) ? origin : undefined;
    if (permitted) {
      res.setHeader('Access-Control-Allow-Origin', permitted);
      res.setHeader('Access-Control-Allow-Methods', CORS_METHODS);
      res.setHeader('Access-Control-Allow-Headers', CORS_HEADERS);
      res.setHeader('Access-Control-Max-Age', CORS_MAX_AGE_SECONDS);
    }
    if (allowed !== '*') res.setHeader('Vary', 'Origin');
    if (req.method === 'OPTIONS') {
      res.status(permitted ? 204 : 403).end();
      return;
    }
    next();
  };
}

/** Cache-Control comes from the _headers rules (immutable under assets/); anything they do not name must revalidate. */
const defaultNoCache = (res: Response): void => {
  if (!res.getHeader('Cache-Control')) res.setHeader('Cache-Control', NO_CACHE);
};

/** Folders of files the dapp fetches by name; a missing one is a deployment error, never a client-side route. */
const FILE_FOLDERS = ['/assets/', '/abi/', '/fonts/', '/images/'];

const isFileRequest = (path: string): boolean => extname(path) !== '' || FILE_FOLDERS.some((folder) => path.startsWith(folder));

function serveDapp(app: Express, dist: string): void {
  const index = join(dist, 'index.html');
  app.use(createSecurityHeaders(loadHeaderRules(dist)));
  app.use(denyForbiddenPaths());
  // Dotfiles are allowed here only because denyForbiddenPaths has already refused all but .well-known.
  app.use(express.static(dist, { index: false, dotfiles: 'allow', setHeaders: defaultNoCache }));
  // Client-side routes (/vault, /pool, /liquidations) resolve to the shell; a missing file of any kind stays a 404.
  app.use((req: Request, res: Response, next: NextFunction): void => {
    // Nothing past express.static serves a file, so the folder's
    // rule (immutable for a year under assets/) must not ride on the 404. A chunk missing
    // during a rebuild would otherwise stay cached as missing after it is back.
    res.setHeader('Cache-Control', NO_CACHE);
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    if (req.path.startsWith('/trpc') || isFileRequest(req.path) || isWellKnownPath(req.path)) return next();
    res.sendFile(index);
  });
}

/**
 * Express 4 ignores a rejected promise from a handler, and Node ends the process on an
 * unhandled rejection. tRPC's handler is async, so anything it throws before it can answer
 * (an unparsable URL, say) is routed to the error handler instead of taking the API down.
 */
export const catchRejections =
  (handler: RequestHandler): RequestHandler =>
  (req: Request, res: Response, next: NextFunction): void => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };

/**
 * HSTS on the tRPC surface whenever the request arrived over TLS.
 * The dapp's _headers rules reached only the dapp's own responses, so an API on its own
 * host never sent it. First in the chain, so a 429 and a CORS refusal carry it too.
 */
const trpcHsts = (req: Request, res: Response, next: NextFunction): void => {
  if (req.secure) res.setHeader('Strict-Transport-Security', TRPC_HSTS);
  next();
};

// The limiter sits after CORS and HSTS, so its 429 carries the same headers and a browser
// client can read it.
const trpcChain = (options: AppOptions, limiter: RateLimiter): readonly RequestHandler[] => [
  trpcHsts,
  ...(options.corsOrigins ? [createCors(options.corsOrigins)] : []),
  limiter.handle,
  catchRejections(options.trpc),
];

/**
 * The ledger's download, mounted before the dapp so the page shell never answers for it. It
 * is read only: GET and HEAD pass, behind the same limiter and with the same HSTS and CORS
 * as the tRPC surface, and every other method is refused.
 */
const mountLedgerRecord = (app: Express, options: AppOptions, limiter: RateLimiter): void => {
  const record = options.ledgerRecord;
  if (record === undefined) return;
  const readOnly = (req: Request, res: Response, next: NextFunction): void => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
    res.setHeader('Allow', 'GET, HEAD');
    res.status(405).json({ error: 'Method not allowed' });
  };
  const chain = (handler: RequestHandler): RequestHandler[] => [
    trpcHsts,
    ...(options.corsOrigins ? [createCors(options.corsOrigins)] : []),
    readOnly,
    limiter.handle,
    catchRejections(handler),
  ];
  app.all(record.csvPath, ...chain(record.csv));
  app.all(record.jsonPath, ...chain(record.json));
};

const clientErrorStatus = (error: unknown): number | undefined => {
  const status = typeof error === 'object' && error !== null ? (error as { status?: unknown }).status : undefined;
  return typeof status === 'number' && status >= 400 && status < 500 ? status : undefined;
};

/** The last resort: a client fault keeps its 4xx, anything else is logged here and told to the client as nothing. */
const answerFailure = (error: unknown, _req: Request, res: Response, next: NextFunction): void => {
  if (res.headersSent) {
    next(error);
    return;
  }
  const status = clientErrorStatus(error);
  if (status === undefined) console.error('Unhandled request error:', error);
  res.status(status ?? 500).json({ error: status === undefined ? 'Internal error' : 'Bad request' });
};

export function createApp(options: AppOptions): Api {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', options.trustProxyHops ?? 0);
  app.use((_req: Request, res: Response, next: NextFunction): void => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    next();
  });
  const limiter = createRateLimiter({ maxRequests: options.rateMaxRequests ?? DEFAULT_RATE_MAX_REQUESTS });
  app.use('/trpc', ...trpcChain(options, limiter));
  mountLedgerRecord(app, options, limiter);
  if (options.dappDist) serveDapp(app, options.dappDist);
  app.use(answerFailure);
  return {
    app,
    dispose: () => {
      limiter.dispose();
    },
  };
}
