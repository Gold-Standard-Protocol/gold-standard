import { AnyRouter, TRPCError } from '@trpc/server';
import { initTRPC } from '@trpc/server';
import * as trpcExpress from '@trpc/server/adapters/express';
import { getHTTPStatusCodeFromError } from '@trpc/server/http';

// created for each request: no per-request context is needed
export const createContext = () => ({});
type Context = Awaited<ReturnType<typeof createContext>>;

const INTERNAL_ERROR_MESSAGE = 'Internal server error';

export interface PublicErrorShape {
  message: string;
  code: number;
  data: {
    code: string;
    httpStatus: number;
    path?: string;
  };
}

/**
 * What a caller is told about a failure. Client errors (a rejected input, an unknown
 * procedure) keep their message because the caller caused them; a server error keeps
 * only its code, since its message tends to name a Redis host or an RPC URL. The stack
 * tRPC adds outside production never leaves the process, whatever NODE_ENV says.
 */
export const publicErrorShape = (error: TRPCError, shape: PublicErrorShape): PublicErrorShape => ({
  message: error.code === 'INTERNAL_SERVER_ERROR' ? INTERNAL_ERROR_MESSAGE : shape.message,
  code: shape.code,
  data: {
    code: shape.data.code,
    httpStatus: shape.data.httpStatus,
    ...(shape.data.path === undefined ? {} : { path: shape.data.path }),
  },
});

const MAX_LOGGED_PATH_LENGTH = 80;

/**
 * The procedure path is whatever the client sent, percent-decoded,
 * so a %0A in it would start a forged journal line. It is logged quoted and escaped, cut to a
 * bounded length and always as an argument, never inside the format string.
 */
const loggablePath = (path: string | undefined): string =>
  JSON.stringify((path ?? 'unknown').slice(0, MAX_LOGGED_PATH_LENGTH));

/**
 * A server fault logs the full error, cause and stack included: it belongs in the server
 * log and nowhere else. A client fault (an unknown procedure, a rejected input) is the
 * caller's doing and costs one line with its code, so a client cannot fill the journal
 * with stacks.
 */
const logProcedureError = (path: string | undefined, error: TRPCError): void => {
  if (getHTTPStatusCodeFromError(error) >= 500) {
    console.error(`tRPC procedure failed with ${error.code}:`, loggablePath(path), error.cause ?? error);
    return;
  }
  console.warn(`tRPC client fault ${error.code}:`, loggablePath(path));
};

/**
 * The cap on a request body. Every query takes its input from the URL, so no
 * body is ever read, yet without a cap the adapter queued each chunk of a POST body until
 * the client hung up. 1 KiB is far below anything worth holding; above it the body is
 * refused, not kept.
 */
export const MAX_REQUEST_BODY_BYTES = 1024;

type ExpressMiddleware = ReturnType<typeof trpcExpress.createExpressMiddleware>;

export const createTRPCExpressMiddleware = (appRouter: AnyRouter): ExpressMiddleware =>
  trpcExpress.createExpressMiddleware({
    router: appRouter,
    createContext,
    maxBodySize: MAX_REQUEST_BODY_BYTES,
    onError: ({ path, error }) => logProcedureError(path, error),
  });

const t = initTRPC.context<Context>().create({
  errorFormatter: ({ error, shape }) => publicErrorShape(error, shape),
});

export const router = t.router;
export const publicProcedure = t.procedure;
