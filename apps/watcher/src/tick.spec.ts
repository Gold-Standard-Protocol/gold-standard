import { DEPLOYMENT, EXPLORER, mintLog, recordingLogger, recordingSender } from './fixtures';
import type { WatchedLog } from './format';
import type { WatcherState } from './state';
import type { ThresholdCheck } from './thresholds';
import { runTick } from './tick';
import type { TickDependencies } from './tick';

const setup = (logs: WatchedLog[] = []) => {
  const sender = recordingSender();
  const log = recordingLogger();
  const saved: WatcherState[] = [];
  const world = { head: 200 as number | Error, coverage: 116_972n, pings: 0 };
  const check: ThresholdCheck = {
    key: 'reserve-coverage',
    ruleId: 16,
    severity: 'note',
    subject: 'The reserve coverage of circulating GSUSD',
    floor: 50_000n,
    read: async () => world.coverage,
  };
  const deps: TickDependencies = {
    deployment: DEPLOYMENT,
    explorerUrl: EXPLORER,
    send: sender.send,
    log,
    getLogs: async (from, to) => logs.filter((entry) => entry.blockNumber >= from && entry.blockNumber <= to),
    getHeadBlock: async () => {
      if (world.head instanceof Error) throw world.head;
      return world.head;
    },
    nowSeconds: () => 1_795_000_000,
    store: { load: async () => undefined, save: async (state) => void saved.push(state) },
    checks: [check],
    repeatSeconds: 21_600,
    heartbeat: async () => void (world.pings += 1),
  };
  return { sender, log, saved, world, deps };
};

describe('runTick', () => {
  it('starts after the current head on a first run, so nothing older is replayed', async () => {
    const t = setup([mintLog(150, 0), mintLog(200, 0)]);
    const result = await runTick(undefined, t.deps);
    expect(t.sender.sent).toEqual([]);
    expect(result?.state.nextBlock).toBe(201);
    expect(result?.clean).toBe(true);
    expect(t.saved).toHaveLength(1);
    expect(t.world.pings).toBe(1);
  });

  it('reports new events and a crossed threshold, saves, and pings the dead-man check', async () => {
    const t = setup([mintLog(201, 0)]);
    const first = await runTick(undefined, t.deps);
    t.world.head = 205;
    t.world.coverage = 40_000n;
    const second = await runTick(first?.state, t.deps);
    expect(t.sender.sent.map((n) => n.text.split('\n')[0])).toEqual([
      'NOTE: DebtMinted on Vault',
      'NOTE: The reserve coverage of circulating GSUSD is below 5.00%',
    ]);
    expect(second?.state).toEqual({
      nextBlock: 206,
      delivered: [],
      thresholds: { 'reserve-coverage': { breached: true, unreadable: false, failures: 0, lastSentAt: 1_795_000_000 } },
    });
    expect(t.world.pings).toBe(2);
  });

  it('saves the partial progress of a tick whose delivery failed and does not ping', async () => {
    const t = setup([mintLog(201, 0), mintLog(202, 0)]);
    const first = await runTick(undefined, t.deps);
    t.world.head = 205;
    const original = t.deps.send;
    let count = 0;
    const second = await runTick(first?.state, {
      ...t.deps,
      send: async (n) => {
        count += 1;
        if (count === 2) throw new Error('Telegram answered HTTP 502');
        await original(n);
      },
    });
    expect(second?.clean).toBe(false);
    expect(second?.state.nextBlock).toBe(202);
    expect(t.saved.at(-1)?.nextBlock).toBe(202);
    expect(t.world.pings).toBe(1);

    const third = await runTick(second?.state, t.deps);
    expect(third?.clean).toBe(true);
    expect(t.sender.sent).toHaveLength(2);
  });

  it('keeps its state and does not ping when the head cannot be read', async () => {
    const t = setup();
    const first = await runTick(undefined, t.deps);
    t.world.head = new Error('HTTP request failed. URL: https://rpc.example/secret-key');
    const second = await runTick(first?.state, t.deps);
    expect(second).toEqual({ state: first?.state, clean: false });
    expect(t.world.pings).toBe(1);
    expect(JSON.stringify(t.log.lines)).not.toContain('secret-key');
    expect(await runTick(undefined, t.deps)).toBeUndefined();
  });
});
