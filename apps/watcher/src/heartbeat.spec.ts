import { recordingLogger } from './fixtures';
import { createHeartbeat } from './heartbeat';
import type { PingFetch } from './heartbeat';

const URL_ = 'https://hc.example/ping/00000000-secret';

describe('createHeartbeat', () => {
  it('sends a GET that refuses redirects and logs nothing on success', async () => {
    const log = recordingLogger();
    const calls: unknown[] = [];
    const fetch: PingFetch = async (url, init) => {
      calls.push([url, init.method, init.redirect]);
      return { ok: true, status: 200 };
    };
    const heartbeat = createHeartbeat(URL_, log, { fetch });
    await heartbeat.ping();
    expect(heartbeat.host).toBe('hc.example');
    expect(calls).toEqual([[URL_, 'GET', 'error']]);
    expect(log.lines).toEqual([]);
  });

  it('warns with the host only on an HTTP error, a thrown request or a timeout, and never throws', async () => {
    const log = recordingLogger();
    await createHeartbeat(URL_, log, { fetch: async () => ({ ok: false, status: 503 }) }).ping();
    await createHeartbeat(URL_, log, {
      fetch: async () => {
        throw new TypeError(`fetch failed for ${URL_}`);
      },
    }).ping();
    await createHeartbeat(URL_, log, {
      timeoutMs: 20,
      fetch: (_url, init) => new Promise((_r, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted')))),
    }).ping();
    expect(log.lines.map((line) => line.fields?.['reason'])).toEqual([
      'HTTP 503',
      'request failed (TypeError)',
      'no answer within 20 ms',
    ]);
    expect(JSON.stringify(log.lines)).not.toContain('secret');
  });
});
