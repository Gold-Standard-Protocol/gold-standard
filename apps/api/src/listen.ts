import type { Express } from 'express';
import type { Server } from 'node:http';

import type { ApiConfig } from './config';

export type ListenAddress = Pick<ApiConfig, 'host' | 'port'>;

/**
 * Starts the HTTP listener on the configured address alone. Express forwards a missing
 * host to Node, which then binds every interface; passing API_HOST (loopback unless the
 * operator overrides it) keeps the API behind the proxy that TRUST_PROXY_HOPS counts.
 */
export const listenApi = (app: Express, address: ListenAddress, onListening: () => void): Server =>
  app.listen(address.port, address.host, onListening);

/** The tRPC endpoint as bound, for the startup log; an IPv6 literal needs brackets in a URL. */
export const listeningUrl = ({ host, port }: ListenAddress): string =>
  `http://${host.includes(':') ? `[${host}]` : host}:${port}/trpc`;
