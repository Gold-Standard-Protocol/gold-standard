import type { IncomingMessage, ServerResponse } from 'node:http';
import { createSupplyHandler } from './http';

interface Answer {
  status: number;
  headers: Record<string, string | number>;
  body: string | undefined;
}

const call = async (handler: ReturnType<typeof createSupplyHandler>, method = 'GET'): Promise<Answer> => {
  const answer: Answer = { status: 0, headers: {}, body: undefined };
  const res = {
    writeHead: (status: number, headers: Record<string, string | number>) => {
      answer.status = status;
      answer.headers = headers;
    },
    end: (body?: string) => {
      answer.body = body;
    },
  } as unknown as ServerResponse;
  await handler({ method } as IncomingMessage, res);
  return answer;
};

const GSUSD = 10n ** 18n;

describe('supply over HTTP', () => {
  it('answers with the figure alone, in whole GSUSD', async () => {
    const answer = await call(createSupplyHandler(async () => 1551n * GSUSD));
    expect(answer.status).toBe(200);
    expect(answer.body).toBe('1551');
    expect(answer.headers['Content-Type']).toBe('text/plain; charset=utf-8');
    expect(answer.headers['Cache-Control']).toBe('public, max-age=60');
  });

  it('keeps every decimal place the token has', async () => {
    const answer = await call(createSupplyHandler(async () => 1551n * GSUSD + 1n));
    expect(answer.body).toBe('1551.000000000000000001');
  });

  it('answers zero as 0', async () => {
    expect((await call(createSupplyHandler(async () => 0n))).body).toBe('0');
  });

  it('sends headers and no body to HEAD', async () => {
    const answer = await call(createSupplyHandler(async () => 5n * GSUSD), 'HEAD');
    expect(answer.status).toBe(200);
    expect(answer.headers['Content-Length']).toBe(1);
    expect(answer.body).toBeUndefined();
  });

  it('asks the chain once a minute, not once a request', async () => {
    let time = 0;
    const read = jest.fn(async () => 7n * GSUSD);
    const handler = createSupplyHandler(read, { now: () => time });
    await call(handler);
    time = 59_999;
    await call(handler);
    expect(read).toHaveBeenCalledTimes(1);
    time = 60_000;
    await call(handler);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('shares one read among requests that arrive together', async () => {
    const read = jest.fn(async () => 7n * GSUSD);
    const handler = createSupplyHandler(read);
    const answers = await Promise.all([call(handler), call(handler), call(handler)]);
    expect(read).toHaveBeenCalledTimes(1);
    expect(answers.map((answer) => answer.body)).toEqual(['7', '7', '7']);
  });

  it('serves the last good read for ten minutes while the endpoint fails, then 503', async () => {
    let time = 0;
    let fail = false;
    const failures: unknown[] = [];
    const handler = createSupplyHandler(
      async () => {
        if (fail) throw new Error('endpoint down');
        return 9n * GSUSD;
      },
      { now: () => time, onReadFailure: (error) => failures.push(error) }
    );
    await call(handler);
    fail = true;
    time = 10 * 60_000;
    expect((await call(handler)).body).toBe('9');
    time = 10 * 60_000 + 1;
    const late = await call(handler);
    expect(late.status).toBe(503);
    expect(late.headers['Retry-After']).toBe('60');
    expect(late.headers['Cache-Control']).toBe('no-store');
    expect(failures).toHaveLength(2);
  });

  it('answers 503 when the first read fails, and recovers on the next', async () => {
    let fail = true;
    const handler = createSupplyHandler(async () => {
      if (fail) throw new Error('endpoint down');
      return 3n * GSUSD;
    });
    expect((await call(handler)).status).toBe(503);
    fail = false;
    expect((await call(handler)).body).toBe('3');
  });

  it('answers 404 when no reader is configured', async () => {
    expect((await call(createSupplyHandler(undefined))).status).toBe(404);
  });
});
