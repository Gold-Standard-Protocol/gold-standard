import express from 'express';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Duplex } from 'node:stream';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { z } from 'zod';
import { createTRPCExpressMiddleware, MAX_REQUEST_BODY_BYTES, publicProcedure, router } from './trpc';

/** Error responses never carry a stack or an internal message, whatever NODE_ENV says. */
describe('tRPC error responses', () => {
  const testRouter = router({
    explode: publicProcedure.query(() => {
      throw new Error('connect ECONNREFUSED 10.0.0.5:6379');
    }),
    echo: publicProcedure.input(z.object({ chainId: z.number() })).query(({ input }) => input.chainId),
  });
  let server: Server;
  let base: string;
  let errorLog: jest.SpyInstance;

  beforeAll(async () => {
    const app = express();
    app.use('/trpc', createTRPCExpressMiddleware(testRouter));
    server = createServer(app);
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  beforeEach(() => {
    errorLog = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    errorLog.mockRestore();
  });

  afterAll(async () => {
    await new Promise<void>((done) => server.close(() => done()));
  });

  it('runs outside production here, where tRPC would otherwise attach a stack', () => {
    expect(process.env['NODE_ENV']).not.toBe('production');
  });

  it('hides the message and stack of a server error and logs the full error server side', async () => {
    const res = await fetch(`${base}/trpc/explode`);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.message).toBe('Internal server error');
    expect(body.error.data).toEqual({ code: 'INTERNAL_SERVER_ERROR', httpStatus: 500, path: 'explode' });
    expect(JSON.stringify(body)).not.toContain('ECONNREFUSED');
    expect(JSON.stringify(body)).not.toContain('stack');
    expect(errorLog).toHaveBeenCalledWith(
      expect.stringContaining('tRPC procedure failed with INTERNAL_SERVER_ERROR'),
      '"explode"',
      expect.objectContaining({ message: 'connect ECONNREFUSED 10.0.0.5:6379' })
    );
  });

  describe('client faults in the log', () => {
    let warnLog: jest.SpyInstance;

    beforeEach(() => {
      warnLog = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    });

    afterEach(() => {
      warnLog.mockRestore();
    });

    const logged = (spy: jest.SpyInstance): string =>
      spy.mock.calls.map((args: unknown[]) => args.map((arg) => (arg instanceof Error ? arg.stack : String(arg))).join(' ')).join('\n');

    it('writes one escaped, bounded line for an unknown procedure, so a decoded newline cannot forge an entry', async () => {
      const forged = `x%0A2026-11-10T12:00:00Z keeper: liquidation sent %25s${'y'.repeat(200)}`;
      const res = await fetch(`${base}/trpc/${forged}`);
      expect(res.status).toBe(404);
      expect(errorLog).not.toHaveBeenCalled();
      expect(warnLog).toHaveBeenCalledTimes(1);
      const [format, path, ...rest] = warnLog.mock.calls[0] as unknown[];
      expect(format).toBe('tRPC client fault NOT_FOUND:');
      // The path is an argument, never the format string, so its %s is printed as written.
      expect(path).toBe(JSON.stringify(`x\n2026-11-10T12:00:00Z keeper: liquidation sent %s${'y'.repeat(200)}`.slice(0, 80)));
      expect(rest).toEqual([]);
      expect(logged(warnLog)).not.toContain('\n');
      expect(logged(warnLog)).not.toContain('    at ');
    });

    it('logs a rejected input as one line with no stack', async () => {
      const input = encodeURIComponent(JSON.stringify({ chainId: 'one' }));
      await fetch(`${base}/trpc/echo?input=${input}`);
      expect(errorLog).not.toHaveBeenCalled();
      expect(warnLog).toHaveBeenCalledWith('tRPC client fault BAD_REQUEST:', '"echo"');
    });
  });

  it('keeps the message of a client error, without a stack', async () => {
    const input = encodeURIComponent(JSON.stringify({ chainId: 'one' }));
    const res = await fetch(`${base}/trpc/echo?input=${input}`);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.data.code).toBe('BAD_REQUEST');
    expect(body.error.message).toContain('chainId');
    expect(body.error.data.stack).toBeUndefined();
    const missing = await fetch(`${base}/trpc/nope`);
    expect(missing.status).toBe(404);
    expect((await missing.json()).error.data).toEqual({ code: 'NOT_FOUND', httpStatus: 404, path: 'nope' });
  });
});

/** An in-memory connection, so the spec controls when each part of a request arrives. */
class MemorySocket extends Duplex {
  readonly written: Buffer[] = [];
  remoteAddress = '127.0.0.1';
  remotePort = 40001;
  override _read(): void {
    // Fed by push.
  }
  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.written.push(Buffer.from(chunk));
    callback();
  }
  setTimeout(): this {
    return this;
  }
  setNoDelay(): this {
    return this;
  }
  setKeepAlive(): this {
    return this;
  }
  destroySoon(): void {
    this.end();
  }
}

/**
 * An unauthenticated POST to /trpc must not buffer its unread body in API memory until the
 * connection closes: every procedure is a query, so tRPC answers a POST
 * with 405 without reading the body, and the adapter used to queue each later chunk anyway.
 */
describe('tRPC request bodies', () => {
  const MIB = 1024 * 1024;
  const CHUNKS = 32;
  const bodyRouter = router({
    getAll: publicProcedure.query(() => ['PAXG']),
    // No production procedure reads a body; this one shows the cap applies when one does.
    measure: publicProcedure.input(z.string()).mutation(({ input }) => input.length),
    measureLarge: publicProcedure.input(z.string()).mutation(({ input }) => input.length),
  });
  let errorLog: jest.SpyInstance;

  beforeEach(() => {
    errorLog = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    errorLog.mockRestore();
  });

  setFlagsFromString('--expose_gc');
  const gc = runInNewContext('gc') as () => void;
  const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
  /** Buffer memory once collection has run, so only what something still references counts. */
  const settledBufferBytes = async (): Promise<number> => {
    for (let i = 0; i < 4; i += 1) {
      await tick();
      gc();
    }
    return process.memoryUsage().arrayBuffers;
  };

  it('holds none of an unread POST body while the connection stays open', async () => {
    const app = express();
    app.use('/trpc', createTRPCExpressMiddleware(bodyRouter));
    const server = createServer(app);
    let finished = false;
    server.prependListener('request', (_req: IncomingMessage, res: ServerResponse) => {
      res.on('finish', () => {
        finished = true;
      });
    });
    const socket = new MemorySocket();
    server.emit('connection', socket);
    socket.push(
      Buffer.from(
        'POST /trpc/getAll HTTP/1.1\r\nHost: api.test\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n',
        'latin1'
      )
    );
    for (let i = 0; i < 200 && !finished; i += 1) await tick();
    expect(Buffer.concat(socket.written).toString('latin1').split('\r\n')[0]).toContain('405');

    const before = await settledBufferBytes();
    for (let i = 0; i < CHUNKS; i += 1) {
      socket.push(Buffer.concat([Buffer.from(`${MIB.toString(16)}\r\n`, 'latin1'), Buffer.alloc(MIB, 0x41), Buffer.from('\r\n', 'latin1')]));
      await tick();
    }
    const retainedMiB = ((await settledBufferBytes()) - before) / MIB;
    socket.destroy();
    // Before the cap all 32 MiB stayed queued until the client hung up.
    expect(retainedMiB).toBeLessThan(4);
  });

  describe('over a real connection', () => {
    let server: Server;
    let base: string;

    beforeAll(async () => {
      const app = express();
      app.use('/trpc', createTRPCExpressMiddleware(bodyRouter));
      server = createServer(app);
      await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    afterAll(async () => {
      await new Promise<void>((done) => server.close(() => done()));
    });

    const post = (body: string): Promise<Response> =>
      fetch(`${base}/trpc/measure`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });

    it('reads a body within the cap', async () => {
      const res = await post(JSON.stringify('x'.repeat(16)));
      expect(res.status).toBe(200);
      expect((await res.json()).result.data).toBe(16);
    });

    it('refuses a body above the cap with 413 rather than reading it', async () => {
      const res = await post(JSON.stringify('x'.repeat(MAX_REQUEST_BODY_BYTES)));
      expect(res.status).toBe(413);
      expect((await res.json()).error.data.code).toBe('PAYLOAD_TOO_LARGE');
    });

    it('caps every body at 1 KiB on every path: no procedure is given a larger one', async () => {
      expect(MAX_REQUEST_BODY_BYTES).toBe(1024);
      for (const path of ['measure', 'measureLarge']) {
        const above = await fetch(`${base}/trpc/${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify('x'.repeat(3 * 1024)),
        });
        expect(above.status).toBe(413);
      }
    });
  });
});
