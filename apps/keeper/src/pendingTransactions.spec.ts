import type { KeeperLogger } from '@goldstandard/trpc/keeper';
import type { FeeEstimate } from './fees';
import { createPendingTransactionGuard } from './pendingTransactions';
import type { PendingTransactionClient } from './pendingTransactions';

const account = '0x0000000000000000000000000000000000000001' as const;
const HASH = `0x${'ab'.repeat(32)}` as const;
const GWEI = 10n ** 9n;
const CEILINGS = { maxFeePerGasWei: 150n * GWEI, maxPriorityFeePerGasWei: 3n * GWEI };
const REPLACE_AFTER_MS = 300_000;
const T0 = 1_800_000_000_000;

interface LoggedEvent {
  level: 'info' | 'warn' | 'error';
  event: string;
  fields?: Record<string, unknown>;
}

const createLogger = (): { log: KeeperLogger; events: LoggedEvent[] } => {
  const events: LoggedEvent[] = [];
  return {
    events,
    log: {
      info: (event, fields) => events.push({ level: 'info', event, fields }),
      warn: (event, fields) => events.push({ level: 'warn', event, fields }),
      error: (event, fields) => events.push({ level: 'error', event, fields }),
    },
  };
};

interface Harness {
  client: PendingTransactionClient & {
    getTransactionCount: jest.Mock<Promise<number>, [{ address: string; blockTag: 'latest' | 'pending' }]>;
    sendSelfTransfer: jest.Mock<Promise<`0x${string}`>, [{ nonce: number; fees: FeeEstimate }]>;
    estimateFeesPerGas: jest.Mock<Promise<FeeEstimate>, []>;
  };
  setNonces(latest: number, pending: number): void;
  clock: { now: number };
  events: LoggedEvent[];
  guard: ReturnType<typeof createPendingTransactionGuard>;
}

const createHarness = (
  estimate: FeeEstimate = { maxFeePerGas: 30n * GWEI, maxPriorityFeePerGas: 1n * GWEI }
): Harness => {
  const nonces = { latest: 4, pending: 4 };
  const clock = { now: T0 };
  const { log, events } = createLogger();
  const client = {
    getTransactionCount: jest.fn<Promise<number>, [{ address: string; blockTag: 'latest' | 'pending' }]>(
      async ({ blockTag }) => (blockTag === 'latest' ? nonces.latest : nonces.pending)
    ),
    estimateFeesPerGas: jest.fn<Promise<FeeEstimate>, []>(async () => estimate),
    sendSelfTransfer: jest.fn<Promise<`0x${string}`>, [{ nonce: number; fees: FeeEstimate }]>(
      async () => HASH
    ),
  };
  const guard = createPendingTransactionGuard({
    client,
    account,
    ceilings: CEILINGS,
    replaceAfterMs: REPLACE_AFTER_MS,
    log,
    now: () => clock.now,
  });
  return {
    client,
    setNonces: (latest, pending) => {
      nonces.latest = latest;
      nonces.pending = pending;
    },
    clock,
    events,
    guard,
  };
};

const SENT_FEES: FeeEstimate = { maxFeePerGas: 40n * GWEI, maxPriorityFeePerGas: 1n * GWEI };

describe('keeper outstanding transactions across ticks', () => {
  it('hands out the confirmed nonce once nothing is outstanding', async () => {
    const { guard, client } = createHarness();
    await expect(guard.nextNonce()).resolves.toBe(4);
    expect(client.getTransactionCount).toHaveBeenCalledWith({ address: account, blockTag: 'latest' });
    expect(client.getTransactionCount).toHaveBeenCalledWith({ address: account, blockTag: 'pending' });
  });

  it('refuses another signature while an earlier transaction is still pending', async () => {
    const { guard, setNonces } = createHarness();
    setNonces(4, 5);
    await expect(guard.nextNonce()).rejects.toThrow('pending transaction');
  });

  it('refuses inconsistent RPC data rather than guessing a nonce', async () => {
    const { guard, setNonces } = createHarness();
    setNonces(5, 4);
    await expect(guard.nextNonce()).rejects.toThrow('inconsistent nonce');
  });

  it('does not allow a signing decision after a nonce read fails', async () => {
    const { guard, client } = createHarness();
    client.getTransactionCount.mockRejectedValue(new Error('RPC unavailable'));
    await expect(guard.nextNonce()).rejects.toThrow('RPC unavailable');
  });
});

describe('stuck transaction replacement', () => {
  it('replaces nothing while the outstanding nonce is younger than the configured age', async () => {
    const { guard, client, setNonces, clock, events } = createHarness();
    guard.recordSent(4, SENT_FEES);
    setNonces(4, 5);
    clock.now = T0 + REPLACE_AFTER_MS - 1;

    await expect(guard.nextNonce()).rejects.toThrow('pending transaction');

    expect(client.sendSelfTransfer).not.toHaveBeenCalled();
    expect(client.estimateFeesPerGas).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it('replaces the stuck nonce with a zero-value self-transfer 12.5% over its fees once it passes the age', async () => {
    const { guard, client, setNonces, clock, events } = createHarness();
    guard.recordSent(4, SENT_FEES);
    setNonces(4, 5);
    clock.now = T0 + REPLACE_AFTER_MS;

    // The nonce is still outstanding until the replacement mines, so this send is refused too.
    await expect(guard.nextNonce()).rejects.toThrow('pending transaction');

    expect(client.sendSelfTransfer).toHaveBeenCalledTimes(1);
    expect(client.sendSelfTransfer).toHaveBeenCalledWith({
      nonce: 4,
      fees: { maxFeePerGas: 45n * GWEI, maxPriorityFeePerGas: 1_125_000_000n },
    });
    const replaced = events.find((entry) => entry.event === 'keeper.stuck-tx-replaced');
    expect(replaced?.level).toBe('warn');
    expect(replaced?.fields).toMatchObject({
      nonce: 4,
      hash: HASH,
      previousMaxFeePerGas: SENT_FEES.maxFeePerGas,
      maxFeePerGas: 45n * GWEI,
      originalFeesKnown: true,
    });
  });

  it('waits a full age again before replacing its own replacement, and bumps over it', async () => {
    const { guard, client, setNonces, clock } = createHarness();
    guard.recordSent(4, SENT_FEES);
    setNonces(4, 5);
    clock.now = T0 + REPLACE_AFTER_MS;
    await expect(guard.nextNonce()).rejects.toThrow('pending transaction');

    clock.now = T0 + 2 * REPLACE_AFTER_MS - 1;
    await expect(guard.nextNonce()).rejects.toThrow('pending transaction');
    expect(client.sendSelfTransfer).toHaveBeenCalledTimes(1);

    clock.now = T0 + 2 * REPLACE_AFTER_MS;
    await expect(guard.nextNonce()).rejects.toThrow('pending transaction');
    expect(client.sendSelfTransfer).toHaveBeenCalledTimes(2);
    expect(client.sendSelfTransfer).toHaveBeenLastCalledWith({
      nonce: 4,
      // 45 and 1.125 gwei, each raised another 12.5%.
      fees: { maxFeePerGas: 50_625_000_000n, maxPriorityFeePerGas: 1_265_625_000n },
    });
  });

  it('raises the distinct alert and keeps refusing when the ceilings prevent a valid replacement', async () => {
    const { guard, client, setNonces, clock, events } = createHarness();
    guard.recordSent(4, { maxFeePerGas: 140n * GWEI, maxPriorityFeePerGas: 1n * GWEI });
    setNonces(4, 5);
    clock.now = T0 + REPLACE_AFTER_MS;

    await expect(guard.nextNonce()).rejects.toThrow('pending transaction');

    expect(client.sendSelfTransfer).not.toHaveBeenCalled();
    const blocked = events.find((entry) => entry.event === 'keeper.stuck-tx-replacement-blocked');
    expect(blocked?.level).toBe('error');
    expect(blocked?.fields).toMatchObject({ nonce: 4 });
    expect(String(blocked?.fields?.['reason'])).toContain('KEEPER_MAX_FEE_GWEI');
    expect(events.map((entry) => entry.event)).not.toContain('keeper.stuck-tx-replaced');
  });

  it('after a restart, ages the nonce from first sight and bumps a fresh estimate', async () => {
    const { guard, client, setNonces, clock, events } = createHarness({
      maxFeePerGas: 60n * GWEI,
      maxPriorityFeePerGas: 2n * GWEI,
    });
    // No recordSent: this process never sent nonce 4 and does not know its fees.
    setNonces(4, 5);
    await expect(guard.nextNonce()).rejects.toThrow('pending transaction');
    expect(client.sendSelfTransfer).not.toHaveBeenCalled();

    clock.now = T0 + REPLACE_AFTER_MS;
    await expect(guard.nextNonce()).rejects.toThrow('pending transaction');

    expect(client.sendSelfTransfer).toHaveBeenCalledWith({
      nonce: 4,
      fees: { maxFeePerGas: 67_500_000_000n, maxPriorityFeePerGas: 2_250_000_000n },
    });
    expect(events.find((entry) => entry.event === 'keeper.stuck-tx-replaced')?.fields).toMatchObject({
      originalFeesKnown: false,
    });
  });

  it('offers more next time when the node refuses a replacement', async () => {
    const { guard, client, setNonces, clock, events } = createHarness({
      maxFeePerGas: 40n * GWEI,
      maxPriorityFeePerGas: 1n * GWEI,
    });
    client.sendSelfTransfer.mockRejectedValueOnce(new Error('replacement transaction underpriced'));
    setNonces(4, 5);
    await expect(guard.nextNonce()).rejects.toThrow('pending transaction');
    clock.now = T0 + REPLACE_AFTER_MS;

    await expect(guard.nextNonce()).rejects.toThrow('pending transaction');
    const failure = events.find((entry) => entry.event === 'keeper.tx-failed');
    expect(failure?.fields).toMatchObject({ functionName: 'replace-stuck-nonce', nonce: 4 });
    expect(String(failure?.fields?.['reason'])).toContain('underpriced');

    // Still past the age: the next attempt bumps over the refused offer of 45 and 1.125 gwei.
    await expect(guard.nextNonce()).rejects.toThrow('pending transaction');
    expect(client.sendSelfTransfer).toHaveBeenLastCalledWith({
      nonce: 4,
      fees: { maxFeePerGas: 50_625_000_000n, maxPriorityFeePerGas: 1_265_625_000n },
    });
  });

  it('offers the same fees again when the send failed before the node saw it', async () => {
    const { guard, client, setNonces, clock } = createHarness({
      maxFeePerGas: 40n * GWEI,
      maxPriorityFeePerGas: 1n * GWEI,
    });
    client.sendSelfTransfer
      .mockRejectedValueOnce(new Error('HTTP request failed. Status: 503'))
      .mockRejectedValueOnce(new Error('The request took too long to respond.'))
      .mockRejectedValueOnce(new Error('txpool is full'));
    guard.recordSent(4, SENT_FEES);
    setNonces(4, 5);
    clock.now = T0 + REPLACE_AFTER_MS;

    // Three failed sends in one tick: none reached the mempool, so none raises the offer.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await expect(guard.nextNonce()).rejects.toThrow('pending transaction');
    }
    const offers = client.sendSelfTransfer.mock.calls.map(([args]) => args.fees.maxFeePerGas);
    expect(offers).toEqual([45_000_000_000n, 45_000_000_000n, 45_000_000_000n, 45_000_000_000n]);
  });

  it('cannot run the fee headroom out on send failures alone', async () => {
    const { guard, client, setNonces, clock, events } = createHarness({
      maxFeePerGas: 100n * GWEI,
      maxPriorityFeePerGas: 1n * GWEI,
    });
    client.sendSelfTransfer.mockRejectedValue(new Error('HTTP request failed. Status: 503'));
    guard.recordSent(4, { maxFeePerGas: 100n * GWEI, maxPriorityFeePerGas: 1n * GWEI });
    setNonces(4, 5);
    clock.now = T0 + REPLACE_AFTER_MS;

    for (let attempt = 0; attempt < 4; attempt += 1) {
      await expect(guard.nextNonce()).rejects.toThrow('pending transaction');
    }
    expect(events.map((entry) => entry.event)).not.toContain('keeper.stuck-tx-replacement-blocked');

    // The RPC recovers: the next send replaces at 112.5 gwei, inside the 150 gwei ceiling.
    client.sendSelfTransfer.mockResolvedValue(HASH);
    await expect(guard.nextNonce()).rejects.toThrow('pending transaction');
    expect(client.sendSelfTransfer).toHaveBeenLastCalledWith({
      nonce: 4,
      fees: { maxFeePerGas: 112_500_000_000n, maxPriorityFeePerGas: 1_125_000_000n },
    });
  });

  it('pages once for a blocked nonce and reason, then reports the repeat at info', async () => {
    const { guard, client, setNonces, clock, events } = createHarness();
    guard.recordSent(4, { maxFeePerGas: 140n * GWEI, maxPriorityFeePerGas: 1n * GWEI });
    setNonces(4, 5);
    clock.now = T0 + REPLACE_AFTER_MS;

    // Two vaults in one tick, then a tick later: the same blocked nonce every time.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(guard.nextNonce()).rejects.toThrow('pending transaction');
    }
    expect(client.sendSelfTransfer).not.toHaveBeenCalled();
    const blocked = events.filter((entry) => entry.event === 'keeper.stuck-tx-replacement-blocked');
    expect(blocked.map((entry) => entry.level)).toEqual(['error', 'info', 'info']);
    expect(blocked[1]?.fields).toMatchObject({ nonce: 4, repeated: true });

    // The nonce mines; a later stuck nonce pages again.
    setNonces(5, 5);
    await expect(guard.nextNonce()).resolves.toBe(5);
    guard.recordSent(5, { maxFeePerGas: 140n * GWEI, maxPriorityFeePerGas: 1n * GWEI });
    setNonces(5, 6);
    clock.now += REPLACE_AFTER_MS;
    await expect(guard.nextNonce()).rejects.toThrow('pending transaction');
    const again = events.filter((entry) => entry.event === 'keeper.stuck-tx-replacement-blocked');
    expect(again.at(-1)?.level).toBe('error');
    expect(again.at(-1)?.fields).toMatchObject({ nonce: 5 });
  });

  it('forgets a mined nonce and ages the next outstanding one from first sight', async () => {
    const { guard, client, setNonces, clock } = createHarness();
    guard.recordSent(4, SENT_FEES);
    setNonces(5, 5);
    await expect(guard.nextNonce()).resolves.toBe(5);

    // Nonce 5 appears outstanding without this process having recorded it.
    setNonces(5, 6);
    clock.now = T0 + REPLACE_AFTER_MS;
    await expect(guard.nextNonce()).rejects.toThrow('pending transaction');
    expect(client.sendSelfTransfer).not.toHaveBeenCalled();
  });
});
