import { recordingLogger, recordingSender } from './fixtures';
import type { ThresholdState } from './state';
import { evaluateThreshold } from './thresholds';
import type { ThresholdCheck } from './thresholds';

const REPEAT = 21_600;

const setup = () => {
  const sender = recordingSender();
  const log = recordingLogger();
  let reading: bigint | Error = 1_538_105n;
  const check: ThresholdCheck = {
    key: 'vault-ratio:0xabc',
    ruleId: 15,
    severity: 'page',
    subject: 'The collateral ratio of vault 0xabc',
    floor: 1_250_000n,
    read: async () => {
      if (reading instanceof Error) throw reading;
      return reading;
    },
  };
  let state: ThresholdState | undefined;
  const step = async (value: bigint | Error, now: number) => {
    reading = value;
    const outcome = await evaluateThreshold(check, state, now, REPEAT, sender.send, log);
    state = outcome.state;
    return outcome;
  };
  return { sender, log, step, state: () => state };
};

describe('evaluateThreshold', () => {
  it('says nothing while the reading is at or above the floor', async () => {
    const t = setup();
    await t.step(1_538_105n, 1_000);
    await t.step(1_250_000n, 1_060);
    expect(t.sender.sent).toEqual([]);
  });

  it('pages once on crossing, repeats only after the repeat interval, and notes the recovery once', async () => {
    const t = setup();
    await t.step(1_538_105n, 1_000);
    await t.step(1_249_999n, 1_060);
    expect(t.sender.sent).toHaveLength(1);
    expect(t.sender.sent[0]).toEqual({
      severity: 'page',
      text: 'PAGE: The collateral ratio of vault 0xabc is below 125.00%\nNow 124.99% (1249999).',
    });

    await t.step(1_200_000n, 1_120);
    await t.step(1_200_000n, 1_060 + REPEAT - 1);
    expect(t.sender.sent).toHaveLength(1);
    await t.step(1_190_000n, 1_060 + REPEAT);
    expect(t.sender.sent).toHaveLength(2);
    expect(t.sender.sent[1].text).toContain('It has stayed below since the last message.');

    await t.step(1_300_000n, 1_060 + REPEAT + 60);
    await t.step(1_300_000n, 1_060 + REPEAT + 120);
    expect(t.sender.sent).toHaveLength(3);
    expect(t.sender.sent[2]).toEqual({
      severity: 'note',
      text: 'NOTE: The collateral ratio of vault 0xabc is back at or above 125.00%\nNow 130.00% (1300000).',
    });
  });

  it('tries a crossing again next tick when the message could not be delivered', async () => {
    const t = setup();
    t.sender.failNext();
    const failed = await t.step(1_100_000n, 1_000);
    expect(failed.deliveryFailed).toBe(true);
    expect(failed.state.breached).toBe(false);
    const retried = await t.step(1_100_000n, 1_060);
    expect(retried.deliveryFailed).toBe(false);
    expect(t.sender.sent).toHaveLength(1);
  });

  it('never takes a failed read for a low reading, and reports it unreadable after five in a row', async () => {
    const t = setup();
    for (let i = 0; i < 4; i++) await t.step(new Error('execution reverted'), 1_000 + i * 60);
    expect(t.sender.sent).toEqual([]);
    expect(t.state()?.breached).toBe(false);

    await t.step(new Error('execution reverted'), 1_240);
    expect(t.sender.sent).toHaveLength(1);
    expect(t.sender.sent[0].text).toBe(
      'PAGE: The collateral ratio of vault 0xabc cannot be read\n5 reads in a row have failed, so the watcher does not know whether it is below 125.00%.'
    );
    await t.step(new Error('execution reverted'), 1_300);
    expect(t.sender.sent).toHaveLength(1);

    await t.step(1_538_105n, 1_360);
    expect(t.sender.sent).toHaveLength(2);
    expect(t.sender.sent[1].text).toContain('is back at or above 125.00%');
    expect(t.state()).toMatchObject({ breached: false, unreadable: false, failures: 0 });
  });

  it('starts the count of failed reads again after one that worked', async () => {
    const t = setup();
    for (let i = 0; i < 4; i++) await t.step(new Error('timeout'), 1_000 + i);
    await t.step(1_538_105n, 1_010);
    for (let i = 0; i < 4; i++) await t.step(new Error('timeout'), 1_020 + i);
    expect(t.sender.sent).toEqual([]);
  });

  it('keeps provider keys out of the log line of a failed read', async () => {
    const t = setup();
    await t.step(new Error('HTTP request failed. URL: https://rpc.example/v2/secret-key'), 1_000);
    expect(JSON.stringify(t.log.lines)).not.toContain('secret-key');
  });
});
