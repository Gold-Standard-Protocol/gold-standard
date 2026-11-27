import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readApiConfig } from './config';
import { listenApi, listeningUrl } from './listen';

/**
 * The rate-limit client key follows X-Forwarded-For behind the configured hops, and
 * a hop count trusts whoever connects, so the listener must be reachable
 * only through the proxy it counts. Port 0 lets the system pick a free port for the spec.
 */
describe('listenApi', () => {
  let servers: Server[] = [];

  afterEach(async () => {
    await Promise.all(servers.map((s) => new Promise<void>((done) => s.close(() => done()))));
    servers = [];
  });

  const bind = async (host: string): Promise<AddressInfo> => {
    let listening: () => void = () => undefined;
    const ready = new Promise<void>((done) => {
      listening = done;
    });
    const server = listenApi(express(), { host, port: 0 }, () => listening());
    servers.push(server);
    await new Promise<void>((done, fail) => {
      server.once('error', fail);
      void ready.then(done);
    });
    return server.address() as AddressInfo;
  };

  it('binds loopback alone when API_HOST is unset', async () => {
    const { host } = readApiConfig({});
    expect(host).toBe('127.0.0.1');
    expect((await bind(host)).address).toBe('127.0.0.1');
  });

  it('binds the address API_HOST names instead of every interface', async () => {
    const { host } = readApiConfig({ API_HOST: '::1' });
    const address = await bind(host);
    expect(address.address).toBe('::1');
    expect(address.family).toBe('IPv6');
  });

  it('logs the address it actually binds, with an IPv6 literal in brackets', () => {
    expect(listeningUrl({ host: '127.0.0.1', port: 3333 })).toBe('http://127.0.0.1:3333/trpc');
    expect(listeningUrl({ host: '::1', port: 3333 })).toBe('http://[::1]:3333/trpc');
  });
});
