/**
 * Installing a BullMQ repeat schedule exactly once, kept free of Redis so the logic can
 * be tested with a fake queue. Shared by the price refresh and the vault owner indexer.
 */

/** How many failed iterations to keep for inspection; completed ones are dropped. */
const FAILED_ITERATIONS_KEPT = 20;

/** The queue surface the reset needs, so a fake can stand in for Redis in tests. */
export interface ScheduleQueue {
  getJobCounts(...types: string[]): Promise<Record<string, number>>;
  obliterate(opts: { force: boolean }): Promise<void>;
  upsertJobScheduler(
    schedulerId: string,
    repeat: { every: number },
    template: { name: string; opts: { removeOnComplete: boolean; removeOnFail: { count: number } } }
  ): Promise<unknown>;
}

export interface ScheduleSpec {
  /** Both the scheduler id and the job name, as the log lines and Redis keys show it. */
  schedulerId: string;
  everyMs: number;
}

const LEFTOVER_STATES = ['active', 'wait', 'delayed', 'completed', 'failed'] as const;

/**
 * Installs a repeat schedule exactly once, on a queue that holds nothing else.
 *
 * Every restart used to leave the previous run's iterations behind and add a fresh
 * chain, so after N restarts the job fired N times per tick: the price fetch was
 * rate-limited by CoinGecko and the indexer walked the RPC six times a minute. Each
 * legacy chain re-spawns its own successor the moment a worker picks it up, so pruning
 * the pending ones is not enough; the queue is wiped, live jobs included, and rebuilt.
 * Both jobs are idempotent and run again within a tick, so nothing is lost. Finished
 * iterations were also kept for ever, a slow Redis leak; they are now dropped on
 * completion.
 */
export async function resetSchedule(queue: ScheduleQueue, spec: ScheduleSpec): Promise<void> {
  const { schedulerId, everyMs } = spec;
  const counts = await queue.getJobCounts(...LEFTOVER_STATES);
  const leftovers = LEFTOVER_STATES.reduce((sum, state) => sum + (counts[state] ?? 0), 0);
  await queue.obliterate({ force: true });
  if (leftovers > 0) console.log(`${schedulerId}: cleared ${leftovers} leftover iteration(s) from Redis`);
  await queue.upsertJobScheduler(
    schedulerId,
    { every: everyMs },
    {
      name: schedulerId,
      opts: { removeOnComplete: true, removeOnFail: { count: FAILED_ITERATIONS_KEPT } },
    }
  );
}
