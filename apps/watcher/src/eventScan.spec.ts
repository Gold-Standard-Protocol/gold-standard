import { MAX_BLOCK_RANGE, MAX_CHUNKS_PER_TICK, scanEvents } from './eventScan';
import type { ScanContext } from './eventScan';
import { DEPLOYMENT, EXPLORER, hash, mintLog, recordingLogger, recordingSender } from './fixtures';
import type { WatchedLog } from './format';

const setup = (logs: WatchedLog[]) => {
  const sender = recordingSender();
  const log = recordingLogger();
  const requests: [number, number][] = [];
  const context: ScanContext = {
    deployment: DEPLOYMENT,
    explorerUrl: EXPLORER,
    send: sender.send,
    log,
    getLogs: async (from, to) => {
      requests.push([from, to]);
      return logs.filter((entry) => entry.blockNumber >= from && entry.blockNumber <= to);
    },
  };
  return { sender, log, requests, context };
};

describe('scanEvents', () => {
  it('reports the events of the range oldest first and moves the cursor past the head', async () => {
    const { sender, context, requests } = setup([mintLog(105, 2), mintLog(101, 0), mintLog(105, 1)]);
    const result = await scanEvents({ nextBlock: 100, delivered: [] }, 110, context);
    expect(requests).toEqual([[100, 110]]);
    expect(sender.sent.map((n) => n.text.match(/tx\/0x0*([0-9a-f]+)$/)?.[1])).toEqual(
      [10100, 10501, 10502].map((n) => n.toString(16))
    );
    expect(result).toEqual({ nextBlock: 111, delivered: [], sent: 3, deliveryFailed: false, readFailed: false });
  });

  it('does nothing when the cursor is already past the head', async () => {
    const { context, requests } = setup([]);
    const result = await scanEvents({ nextBlock: 111, delivered: [] }, 110, context);
    expect(requests).toEqual([]);
    expect(result.nextBlock).toBe(111);
  });

  it('skips a log of a watched address that no rule covers', async () => {
    const stray: WatchedLog = { ...mintLog(101, 0), address: DEPLOYMENT.addresses.reserve };
    const { sender, context } = setup([stray]);
    const result = await scanEvents({ nextBlock: 100, delivered: [] }, 110, context);
    expect(sender.sent).toEqual([]);
    expect(result.nextBlock).toBe(111);
  });

  it('stops at a failed delivery, keeps what it delivered in that block, and finishes on the retry', async () => {
    const { sender, context, log } = setup([mintLog(101, 0), mintLog(105, 1), mintLog(105, 2), mintLog(107, 0)]);
    const failing = { ...context, send: async (n: Parameters<typeof sender.send>[0]) => {
      if (n.text.includes(hash(10502))) throw new Error('Telegram answered HTTP 502');
      await sender.send(n);
    } };
    const first = await scanEvents({ nextBlock: 100, delivered: [] }, 110, failing);
    expect(first).toEqual({ nextBlock: 105, delivered: [`${hash(10501)}:1`], sent: 2, deliveryFailed: true, readFailed: false });
    expect(log.lines.some((line) => line.event === 'watcher.delivery-failed')).toBe(true);

    const second = await scanEvents(first, 110, context);
    expect(second).toEqual({ nextBlock: 111, delivered: [], sent: 2, deliveryFailed: false, readFailed: false });
    const hashes = sender.sent.map((n) => n.text.split('/tx/')[1]);
    expect(hashes).toEqual([hash(10100), hash(10501), hash(10502), hash(10700)]);
  });

  it('stands still when a log request fails, and says so', async () => {
    const { context, log } = setup([]);
    const result = await scanEvents({ nextBlock: 100, delivered: ['kept'] }, 110, {
      ...context,
      getLogs: async () => {
        throw new Error('HTTP request failed. URL: https://rpc.example/v2/secret-key');
      },
    });
    expect(result).toEqual({ nextBlock: 100, delivered: ['kept'], sent: 0, deliveryFailed: false, readFailed: true });
    const line = log.lines.find((entry) => entry.event === 'watcher.logs-unread');
    expect(JSON.stringify(line)).not.toContain('secret-key');
  });

  it('asks in ranges of at most 2,000 blocks and stops after the tick allowance', async () => {
    const { context, requests } = setup([]);
    const result = await scanEvents({ nextBlock: 1, delivered: [] }, 4_500, context);
    expect(requests).toEqual([[1, 2_000], [2_001, 4_000], [4_001, 4_500]]);
    expect(result.nextBlock).toBe(4_501);

    const far = setup([]);
    const behind = await scanEvents({ nextBlock: 1, delivered: [] }, 10_000_000, far.context);
    expect(far.requests).toHaveLength(MAX_CHUNKS_PER_TICK);
    expect(behind.nextBlock).toBe(MAX_CHUNKS_PER_TICK * MAX_BLOCK_RANGE + 1);
  });
});
