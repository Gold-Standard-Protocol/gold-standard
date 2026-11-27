import { Agent, createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { EventEmitter } from 'node:events';
import { createGracefulShutdown, exitOnListenFailure, installSignalHandlers } from './shutdown';

/** One request; with no agent it asks for Connection: close, with a keep-alive agent the socket stays pooled. */
const get = (port: number, agent: Agent | false = false): Promise<{ status: number; body: string }> =>
  new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path: '/', agent }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });

describe('createGracefulShutdown', () => {
  let server: Server;
  let release: () => void;
  let arrived: Promise<void>;
  let port: number;
  /** What happened, in order; the server records when its answer has gone out. */
  let order: string[];

  beforeEach(async () => {
    order = [];
    let signalArrival: () => void = () => undefined;
    arrived = new Promise((resolve) => {
      signalArrival = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    server = createServer((_req, res) => {
      signalArrival();
      res.on('finish', () => order.push('answered'));
      void gate.then(() => res.end('answered'));
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    release();
    await new Promise<void>((done) => (server.listening ? server.close(() => done()) : done()));
  });

  it('answers the request in flight, then runs the shutdown tasks, then exits 0', async () => {
    let response: Promise<{ status: number; body: string }> | undefined;
    const exited = new Promise<number>((resolve) => {
      const shutdown = createGracefulShutdown({
        server,
        tasks: async () => {
          order.push('tasks');
        },
        exit: (code) => {
          order.push('exit');
          resolve(code);
        },
        timeoutMs: 10_000,
      });
      response = get(port);
      void arrived.then(() => {
        shutdown();
        // A second signal while draining changes nothing.
        shutdown();
        setTimeout(release, 50);
      });
    });

    await expect(exited).resolves.toBe(0);
    expect(order).toEqual(['answered', 'tasks', 'exit']);
    await expect(response).resolves.toEqual({ status: 200, body: 'answered' });
    await expect(get(port)).rejects.toThrow();
  });

  it('drains a keep-alive connection that was busy at the signal, then exits 0', async () => {
    // The proxy in front pools connections. Node's close() closes the idle ones once and
    // re-arms the keep-alive timer (5 s) on a busy one when its answer goes out, so without a
    // second sweep this connection outlives the 2 s deadline below.
    const agent = new Agent({ keepAlive: true, maxSockets: 1 });
    try {
      let response: Promise<{ status: number; body: string }> | undefined;
      const exited = new Promise<number>((resolve) => {
        const shutdown = createGracefulShutdown({
          server,
          tasks: async () => {
            order.push('tasks');
          },
          exit: (code) => {
            order.push('exit');
            resolve(code);
          },
          timeoutMs: 2_000,
        });
        response = get(port, agent);
        void arrived.then(() => {
          shutdown();
          setTimeout(release, 50);
        });
      });

      await expect(exited).resolves.toBe(0);
      expect(order).toEqual(['answered', 'tasks', 'exit']);
      await expect(response).resolves.toEqual({ status: 200, body: 'answered' });
    } finally {
      agent.destroy();
    }
  });

  it('cuts the connections still open at the deadline, runs the shutdown tasks and exits 1', async () => {
    const exited = new Promise<number>((resolve) => {
      const shutdown = createGracefulShutdown({
        server,
        tasks: async () => {
          order.push('tasks');
        },
        exit: (code) => {
          order.push('exit');
          resolve(code);
        },
        timeoutMs: 50,
      });
      void get(port).catch(() => undefined);
      void arrived.then(shutdown);
    });

    await expect(exited).resolves.toBe(1);
    expect(order).toEqual(['tasks', 'exit']);
  });

  it('exits 1 even when the shutdown tasks hang past the deadline', async () => {
    const exited = new Promise<number>((resolve) => {
      const shutdown = createGracefulShutdown({
        server,
        tasks: () => new Promise<void>(() => undefined),
        exit: resolve,
        timeoutMs: 50,
        taskTimeoutMs: 50,
      });
      void get(port).catch(() => undefined);
      void arrived.then(shutdown);
    });

    await expect(exited).resolves.toBe(1);
  });
});

describe('exitOnListenFailure', () => {
  it('runs the cleanup and exits 1 when the port cannot be bound', async () => {
    const occupant = createServer();
    await new Promise<void>((done) => occupant.listen(0, '127.0.0.1', done));
    const port = (occupant.address() as AddressInfo).port;
    const order: string[] = [];
    try {
      const exited = new Promise<number>((resolve) => {
        const server = createServer();
        exitOnListenFailure({
          server,
          port,
          tasks: async () => {
            order.push('tasks');
          },
          exit: (code) => {
            order.push('exit');
            resolve(code);
          },
        });
        server.listen(port, '127.0.0.1');
      });
      await expect(exited).resolves.toBe(1);
      expect(order).toEqual(['tasks', 'exit']);
    } finally {
      await new Promise<void>((done) => occupant.close(() => done()));
    }
  });

  it('still exits 1 when the cleanup itself fails', async () => {
    const occupant = createServer();
    await new Promise<void>((done) => occupant.listen(0, '127.0.0.1', done));
    const port = (occupant.address() as AddressInfo).port;
    try {
      const exited = new Promise<number>((resolve) => {
        const server = createServer();
        exitOnListenFailure({
          server,
          port,
          tasks: async () => {
            throw new Error('queue close failed');
          },
          exit: resolve,
        });
        server.listen(port, '127.0.0.1');
      });
      await expect(exited).resolves.toBe(1);
    } finally {
      await new Promise<void>((done) => occupant.close(() => done()));
    }
  });
});

describe('installSignalHandlers', () => {
  it('keeps listening after the first signal, so a second SIGTERM cannot kill the drain', () => {
    const target = new EventEmitter();
    let calls = 0;
    installSignalHandlers(() => {
      calls += 1;
    }, target);
    target.emit('SIGTERM');
    target.emit('SIGTERM');
    target.emit('SIGINT');
    expect(calls).toBe(3);
    expect(target.listenerCount('SIGTERM')).toBe(1);
    expect(target.listenerCount('SIGINT')).toBe(1);
  });
});
