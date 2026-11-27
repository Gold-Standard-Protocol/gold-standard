import {
  createHeartbeatPinger,
  createTallyingLogger,
  HEAD_AHEAD_SECONDS,
  HEAD_STALE_SECONDS,
  HEARTBEAT_PING_TIMEOUT_MS,
  reportHeartbeat,
} from './heartbeat';
import type { HeartbeatFetch, TickTally } from './heartbeat';
import type { KeeperLogger, KeeperReadClient } from './ports';

interface LoggedEvent {
  level: 'info' | 'warn' | 'error';
  event: string;
  fields?: Record<string, unknown>;
}

const createStubLogger = (): { log: KeeperLogger; events: LoggedEvent[] } => {
  const events: LoggedEvent[] = [];
  const push =
    (level: LoggedEvent['level']) =>
    (event: string, fields?: Record<string, unknown>): void => {
      events.push({ level, event, fields });
    };
  return { log: { info: push('info'), warn: push('warn'), error: push('error') }, events };
};

const CLEAN: TickTally = {
  blockedLiquidations: 0,
  failedLiquidations: 0,
  unknownOutcomes: 0,
  jobErrors: 0,
  ticksSkipped: 0,
  vaultsWalked: undefined,
  vaultsWithDebt: undefined,
};

const readContract = async (): Promise<unknown> => {
  throw new Error('not used by heartbeat specs');
};

describe('createTallyingLogger', () => {
  it('passes every line on unchanged, at its level', () => {
    const { log, events } = createStubLogger();
    const tally = createTallyingLogger(log);

    tally.log.info('keeper.tx-sent', { hash: '0x01' });
    tally.log.warn('vault.liquidatable', { owner: '0xabc' });
    tally.log.error('vault.liquidation-blocked', { owner: '0xabc' });

    expect(events).toEqual([
      { level: 'info', event: 'keeper.tx-sent', fields: { hash: '0x01' } },
      { level: 'warn', event: 'vault.liquidatable', fields: { owner: '0xabc' } },
      { level: 'error', event: 'vault.liquidation-blocked', fields: { owner: '0xabc' } },
    ]);
  });

  it('counts the lines that mean liquidations are not happening', () => {
    const tally = createTallyingLogger(createStubLogger().log);

    tally.log.error('vault.liquidation-blocked');
    tally.log.error('vault.liquidation-blocked');
    tally.log.error('keeper.tx-failed', { job: 'liquidation-watch', functionName: 'liquidateViaPool' });
    tally.log.error('keeper.tx-failed', { job: 'liquidation-watch', functionName: 'approve' });
    tally.log.error('keeper.approval-reverted', { job: 'liquidation-watch' });
    tally.log.error('keeper.tx-outcome-unknown', { job: 'liquidation-watch' });
    tally.log.error('keeper.job-error', { job: 'liquidation-watch' });
    tally.log.warn('keeper.job-error', { job: 'oracle-health' });
    tally.log.warn('keeper.tick-skipped-overlap');

    expect(tally.take()).toEqual({
      ...CLEAN,
      blockedLiquidations: 2,
      failedLiquidations: 3,
      unknownOutcomes: 1,
      jobErrors: 2,
      ticksSkipped: 1,
    });
  });

  it('does not count a failed allowance revoke, a failed poke or a failed nonce replacement as a failed liquidation', () => {
    const tally = createTallyingLogger(createStubLogger().log);

    tally.log.error('keeper.tx-failed', { job: 'liquidation-watch', functionName: 'approve-revoke' });
    tally.log.error('keeper.tx-failed', { job: 'price-freshness', functionName: 'getTokenPrice' });
    tally.log.error('keeper.tx-failed', { functionName: 'replace-stuck-nonce' });

    expect(tally.take().failedLiquidations).toBe(0);
  });

  it('reads the vaults walked from the sweep line, and zero from an empty owner set', () => {
    const tally = createTallyingLogger(createStubLogger().log);

    tally.log.info('vault.owner-sweep', { owners: 412, read: 412, withDebt: 37, unread: 0 });
    expect(tally.take()).toMatchObject({ vaultsWalked: 412, vaultsWithDebt: 37 });

    tally.log.info('vault.no-owners', { chainId: 1 });
    expect(tally.take()).toMatchObject({ vaultsWalked: 0, vaultsWithDebt: 0 });
  });

  it('starts from zero after each take', () => {
    const tally = createTallyingLogger(createStubLogger().log);
    tally.log.error('vault.liquidation-blocked');
    tally.log.info('vault.owner-sweep', { owners: 3, withDebt: 1 });

    tally.take();

    expect(tally.take()).toEqual(CLEAN);
  });
});

describe('reportHeartbeat', () => {
  const NOW_MS = 1_800_000_000_000;
  const headAt = (ageSeconds: number): KeeperReadClient => ({
    readContract,
    getHeadBlock: async () => ({ number: 21_000_000n, timestamp: BigInt(NOW_MS / 1000 - ageSeconds) }),
  });
  const report = async (read: KeeperReadClient, tally: TickTally = CLEAN) => {
    const { log, events } = createStubLogger();
    const ok = await reportHeartbeat({
      read,
      log,
      tally,
      startedAtMs: NOW_MS - 2_500,
      nowMs: NOW_MS,
      intervalSeconds: 60,
      dryRun: false,
    });
    return { ok, events };
  };

  it('writes one info line with the tick duration, the head and its age, the vaults walked and the counts', async () => {
    const { ok, events } = await report(headAt(7), {
      ...CLEAN,
      blockedLiquidations: 2,
      failedLiquidations: 1,
      vaultsWalked: 412,
      vaultsWithDebt: 37,
    });

    expect(ok).toBe(true);
    expect(events).toEqual([
      {
        level: 'info',
        event: 'keeper.heartbeat',
        fields: {
          ok: true,
          tickSeconds: 2.5,
          intervalSeconds: 60,
          dryRun: false,
          headBlock: 21_000_000n,
          headAgeSeconds: 7,
          vaultsWalked: 412,
          vaultsWithDebt: 37,
          blockedLiquidations: 2,
          failedLiquidations: 1,
          unknownOutcomes: 0,
          jobErrors: 0,
          ticksSkipped: 0,
        },
      },
    ]);
  });

  it('stays clean when liquidations were blocked or failed: those lines page by themselves', async () => {
    const { ok } = await report(headAt(7), { ...CLEAN, blockedLiquidations: 3, failedLiquidations: 2, unknownOutcomes: 1 });

    expect(ok).toBe(true);
  });

  it('is not clean when a job reported an error', async () => {
    const { ok, events } = await report(headAt(7), { ...CLEAN, jobErrors: 1 });

    expect(ok).toBe(false);
    expect(events[0]?.fields).toMatchObject({ ok: false, jobErrors: 1 });
  });

  it('is not clean when the head cannot be read, and carries the reason without the endpoint', async () => {
    const { ok, events } = await report({
      readContract,
      getHeadBlock: async () => {
        throw new Error('HTTP request failed. URL: https://rpc.example.org/v2/secret-key');
      },
    });

    expect(ok).toBe(false);
    expect(events[0]?.fields).toMatchObject({ ok: false, headBlock: null, headAgeSeconds: null });
    expect(JSON.stringify(events)).not.toContain('secret-key');
    expect(String(events[0]?.fields?.['headError'])).toContain('rpc.example.org');
  });

  it('accepts a head exactly at the staleness limit and refuses one a second older', async () => {
    const atLimit = await report(headAt(HEAD_STALE_SECONDS));
    const past = await report(headAt(HEAD_STALE_SECONDS + 1));

    expect(atLimit.ok).toBe(true);
    expect(atLimit.events[0]?.fields).not.toHaveProperty('headStale');
    expect(past.ok).toBe(false);
    expect(past.events[0]?.fields).toMatchObject({ headStale: true, headAgeSeconds: HEAD_STALE_SECONDS + 1 });
  });

  it('accepts a head stamped up to two minutes ahead of the host clock and refuses one further ahead', async () => {
    const atLimit = await report(headAt(-HEAD_AHEAD_SECONDS));
    const past = await report(headAt(-HEAD_AHEAD_SECONDS - 1));

    expect(atLimit.ok).toBe(true);
    expect(atLimit.events[0]?.fields).not.toHaveProperty('headAhead');
    expect(past.ok).toBe(false);
    expect(past.events[0]?.fields).toMatchObject({ headAhead: true, headAgeSeconds: -HEAD_AHEAD_SECONDS - 1 });
    expect(past.events[0]?.fields).not.toHaveProperty('headStale');
  });

  it('does not let a slow host clock hide a stalled endpoint', async () => {
    // The endpoint stopped ten minutes ago and the host clock is fifteen minutes slow: the
    // head reads five minutes ahead, not eleven minutes old.
    const { ok, events } = await report(headAt(-300));
    expect(ok).toBe(false);
    expect(events[0]?.fields).toMatchObject({ headAhead: true, headAgeSeconds: -300 });
  });

  it('reports no head and stays clean for a client without the head adapter', async () => {
    const { ok, events } = await report({ readContract });

    expect(ok).toBe(true);
    expect(events[0]?.fields).toMatchObject({ headBlock: null, headAgeSeconds: null, vaultsWalked: null });
  });
});

describe('createHeartbeatPinger', () => {
  const URL_WITH_SECRET = 'https://hc.example.com/ping/5b1f2c3d-secret?token=abc';

  it('GETs the URL exactly as configured and logs nothing on success', async () => {
    const { log, events } = createStubLogger();
    const calls: { url: string; method: string; redirect: string }[] = [];
    const fetchStub: HeartbeatFetch = async (url, init) => {
      calls.push({ url, method: init.method, redirect: init.redirect });
      return { ok: true, status: 200 };
    };

    const pinger = createHeartbeatPinger(URL_WITH_SECRET, log, { fetch: fetchStub });
    await pinger.ping();

    expect(pinger.host).toBe('hc.example.com');
    expect(calls).toEqual([{ url: URL_WITH_SECRET, method: 'GET', redirect: 'error' }]);
    expect(events).toEqual([]);
  });

  it('warns with the host and the status on a refusal, never the URL', async () => {
    const { log, events } = createStubLogger();

    await createHeartbeatPinger(URL_WITH_SECRET, log, { fetch: async () => ({ ok: false, status: 503 }) }).ping();

    expect(events).toEqual([
      { level: 'warn', event: 'keeper.heartbeat-ping-failed', fields: { host: 'hc.example.com', reason: 'HTTP 503' } },
    ]);
  });

  it.each([
    { ok: true, status: 200 },
    { ok: false, status: 503 },
  ])('cancels the unread body of an answer with status $status', async ({ ok, status }) => {
    const { log } = createStubLogger();
    const cancel = jest.fn(async () => undefined);

    await createHeartbeatPinger(URL_WITH_SECRET, log, { fetch: async () => ({ ok, status, body: { cancel } }) }).ping();

    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('accepts an answer without a body', async () => {
    const { log, events } = createStubLogger();

    await createHeartbeatPinger(URL_WITH_SECRET, log, { fetch: async () => ({ ok: true, status: 204, body: null }) }).ping();

    expect(events).toEqual([]);
  });

  it('keeps the answer when cancelling its body fails', async () => {
    const { log, events } = createStubLogger();
    const body = {
      cancel: async (): Promise<void> => {
        throw new TypeError(`locked ${URL_WITH_SECRET}`);
      },
    };

    await createHeartbeatPinger(URL_WITH_SECRET, log, { fetch: async () => ({ ok: true, status: 200, body }) }).ping();
    await createHeartbeatPinger(URL_WITH_SECRET, log, { fetch: async () => ({ ok: false, status: 500, body }) }).ping();

    expect(events).toEqual([
      { level: 'warn', event: 'keeper.heartbeat-ping-failed', fields: { host: 'hc.example.com', reason: 'HTTP 500' } },
    ]);
  });

  it('stops waiting at the timeout for a body that never finishes cancelling', async () => {
    jest.useFakeTimers();
    try {
      const { log, events } = createStubLogger();
      const body = { cancel: (): Promise<void> => new Promise(() => undefined) };

      const pending = createHeartbeatPinger(URL_WITH_SECRET, log, {
        fetch: async () => ({ ok: true, status: 200, body }),
      }).ping();
      await jest.advanceTimersByTimeAsync(HEARTBEAT_PING_TIMEOUT_MS);

      await expect(pending).resolves.toBeUndefined();
      expect(events).toEqual([]);
    } finally {
      jest.useRealTimers();
    }
  });

  it('never throws and never logs the error text, which may quote the URL', async () => {
    const { log, events } = createStubLogger();
    const failing: HeartbeatFetch = async () => {
      throw new TypeError(`fetch failed for ${URL_WITH_SECRET}`);
    };

    await expect(createHeartbeatPinger(URL_WITH_SECRET, log, { fetch: failing }).ping()).resolves.toBeUndefined();

    expect(events).toEqual([
      {
        level: 'warn',
        event: 'keeper.heartbeat-ping-failed',
        fields: { host: 'hc.example.com', reason: 'request failed (TypeError)' },
      },
    ]);
    expect(JSON.stringify(events)).not.toContain('5b1f2c3d-secret');
  });

  it('abandons a ping that does not answer within the timeout', async () => {
    jest.useFakeTimers();
    try {
      const { log, events } = createStubLogger();
      const hanging: HeartbeatFetch = (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(new Error('aborted')));
        });

      const pending = createHeartbeatPinger(URL_WITH_SECRET, log, { fetch: hanging }).ping();
      await jest.advanceTimersByTimeAsync(HEARTBEAT_PING_TIMEOUT_MS);
      await pending;

      expect(events).toEqual([
        {
          level: 'warn',
          event: 'keeper.heartbeat-ping-failed',
          fields: { host: 'hc.example.com', reason: `no answer within ${HEARTBEAT_PING_TIMEOUT_MS} ms` },
        },
      ]);
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not throw even when the logger does', async () => {
    const throwing: KeeperLogger = {
      info: () => undefined,
      warn: () => {
        throw new Error('stdout closed');
      },
      error: () => undefined,
    };
    const stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      await expect(
        createHeartbeatPinger(URL_WITH_SECRET, throwing, { fetch: async () => ({ ok: false, status: 500 }) }).ping()
      ).resolves.toBeUndefined();
      expect(stderr).toHaveBeenCalled();
    } finally {
      stderr.mockRestore();
    }
  });
});
