import { resetSchedule, type ScheduleQueue } from './schedule';

const SPEC = { schedulerId: 'fetch-and-update-prices', everyMs: 30_000 };

function fakeQueue(counts: Record<string, number>) {
  const calls: string[] = [];
  const upserts: unknown[] = [];
  const queue: ScheduleQueue = {
    getJobCounts: async (...types) => {
      calls.push('counts');
      return Object.fromEntries(types.map((t) => [t, counts[t] ?? 0]));
    },
    obliterate: async (opts) => {
      calls.push(`obliterate:${opts.force}`);
    },
    upsertJobScheduler: async (...args) => {
      calls.push('upsert');
      upserts.push(args);
    },
  };
  return { queue, calls, upserts };
}

describe('resetSchedule', () => {
  it('wipes the queue, live jobs included, before installing exactly one schedule', async () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const { queue, calls, upserts } = fakeQueue({ active: 2, delayed: 6, completed: 15_287, failed: 1 });

    await resetSchedule(queue, SPEC);

    expect(calls).toEqual(['counts', 'obliterate:true', 'upsert']);
    expect(upserts).toEqual([
      [
        'fetch-and-update-prices',
        { every: 30_000 },
        { name: 'fetch-and-update-prices', opts: { removeOnComplete: true, removeOnFail: { count: 20 } } },
      ],
    ]);
    expect(log).toHaveBeenCalledWith('fetch-and-update-prices: cleared 15296 leftover iteration(s) from Redis');
    log.mockRestore();
  });

  it('stays quiet when the queue was already clean', async () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const { queue, calls } = fakeQueue({});
    await resetSchedule(queue, SPEC);
    expect(calls).toEqual(['counts', 'obliterate:true', 'upsert']);
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it('names the scheduler it is resetting in its log line', async () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const { queue } = fakeQueue({ delayed: 6 });
    await resetSchedule(queue, { schedulerId: 'index-vault-owners', everyMs: 60_000 });
    expect(log).toHaveBeenCalledWith('index-vault-owners: cleared 6 leftover iteration(s) from Redis');
    log.mockRestore();
  });
});
