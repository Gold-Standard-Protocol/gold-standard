export interface ThresholdState {
  /** The reading is below its floor and a message said so. */
  breached: boolean;
  /** The reading has failed often enough that a message said so. */
  unreadable: boolean;
  /** Consecutive failed reads. */
  failures: number;
  /** Unix seconds of the last message about this threshold; 0 for none. */
  lastSentAt: number;
}

export interface WatcherState {
  /** The first block not yet fully reported. */
  nextBlock: number;
  /** Events of `nextBlock` already delivered (`<transaction hash>:<log index>`), so a retry skips them. */
  delivered: readonly string[];
  thresholds: Readonly<Record<string, ThresholdState>>;
}

export const NEW_THRESHOLD_STATE: ThresholdState = { breached: false, unreadable: false, failures: 0, lastSentAt: 0 };

export interface StateStore {
  /** Undefined when nothing has been saved yet. Throws on a file that is there but unusable. */
  load(): Promise<WatcherState | undefined>;
  save(state: WatcherState): Promise<void>;
}

const isThresholdState = (value: unknown): value is ThresholdState => {
  const candidate = value as ThresholdState;
  return (
    typeof candidate === 'object' &&
    candidate !== null &&
    typeof candidate.breached === 'boolean' &&
    typeof candidate.unreadable === 'boolean' &&
    Number.isSafeInteger(candidate.failures) &&
    Number.isSafeInteger(candidate.lastSentAt)
  );
};

/** Throws on anything that is not a state this version wrote: a damaged cursor must not be guessed. */
export const parseState = (json: string): WatcherState => {
  const parsed = JSON.parse(json) as Partial<WatcherState>;
  if (!Number.isSafeInteger(parsed.nextBlock) || (parsed.nextBlock as number) < 0)
    throw new Error('the state file has no usable nextBlock');
  if (!Array.isArray(parsed.delivered) || !parsed.delivered.every((id) => typeof id === 'string'))
    throw new Error('the state file has no usable delivered list');
  const thresholds = parsed.thresholds ?? {};
  if (typeof thresholds !== 'object' || !Object.values(thresholds).every(isThresholdState))
    throw new Error('the state file has unusable threshold records');
  return { nextBlock: parsed.nextBlock as number, delivered: parsed.delivered, thresholds };
};
