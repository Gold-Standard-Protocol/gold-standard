import { getAddress } from 'viem';
import {
  bandEdges,
  bandPosition,
  explainLiquidation,
  gapFromGoldPpm,
  gapPpm,
  liquidationCap,
  readOracleSnapshot,
  snapshotFields,
  stoppedSources,
} from './oracleReads';
import type { OracleSnapshot, SourceRound } from './oracleReads';
import type { KeeperReadClient } from './ports';

const ORACLE = getAddress('0xe7f1725e7734ce288f8367e1bb143e90bb3f0512');
const PAXG = getAddress('0xcf7ed3acca5a467e9e704c703e8d87f634fb0fc9');
const C_FEED = getAddress('0x9fe46736679d2d9a65f0992f2272de9f3c7fa6e0');
const G_FEED = getAddress('0x2279b7a0a67db372996a5fab50d91eaa73d2ebe6');
const ZERO = getAddress('0x0000000000000000000000000000000000000000');

/** $4,000 in eight decimals. */
const GOLD = 400_000_000_000n;
const NOW = 1_800_000_060n;
const pct = (base: bigint, hundredths: bigint): bigint => (base * hundredths) / 10_000n;

const ok = (feed: typeof C_FEED, answer: bigint): SourceRound => ({
  feed,
  answer,
  updatedAt: 1_800_000_000n,
  status: 'ok',
});
const stopped = (feed: typeof C_FEED, status: SourceRound['status'] = 'stale'): SourceRound => ({
  feed,
  answer: status === 'no-answer' ? 0n : GOLD,
  updatedAt: 1_700_000_000n,
  status,
});

const snap = (overrides: Partial<OracleSnapshot> = {}): OracleSnapshot => ({
  primary: ok(C_FEED, GOLD),
  gold: ok(G_FEED, GOLD),
  goldBandPpm: 20_000n,
  liquidationClampPpm: 20_000n,
  stalenessThreshold: 90_000n,
  now: NOW,
  ...overrides,
});

describe('gapPpm and gapFromGoldPpm', () => {
  it('gapPpm measures against the larger price and floors like Math.mulDiv', () => {
    expect(gapPpm(100n, 98n)).toBe(20_000n);
    expect(gapPpm(98n, 100n)).toBe(20_000n);
  });

  it('gapFromGoldPpm measures against gold, as the oracle bands do', () => {
    expect(gapFromGoldPpm(98n, 100n)).toBe(20_000n);
    expect(gapFromGoldPpm(102n, 100n)).toBe(20_000n);
    expect(gapFromGoldPpm(100n, 0n)).toBe(0n);
  });
});

describe('bandEdges (GoldOracle._clamp)', () => {
  it('rounds both edges down', () => {
    expect(bandEdges(333n, 20_000n)).toEqual({ low: 326n, high: 339n });
  });
});

describe('bandPosition', () => {
  it('is inside at both edges of the gold band and outside one unit beyond them', () => {
    const { low, high } = bandEdges(GOLD, 20_000n);
    expect(bandPosition(snap({ primary: ok(C_FEED, low) }))).toBe('inside');
    expect(bandPosition(snap({ primary: ok(C_FEED, high) }))).toBe('inside');
    expect(bandPosition(snap({ primary: ok(C_FEED, low - 1n) }))).toBe('below');
    expect(bandPosition(snap({ primary: ok(C_FEED, high + 1n) }))).toBe('above');
  });

  it('is unknown while either feed is unhealthy and no-reference with no anchor set', () => {
    expect(bandPosition(snap({ primary: stopped(C_FEED) }))).toBe('unknown');
    expect(bandPosition(snap({ gold: stopped(G_FEED) }))).toBe('unknown');
    expect(bandPosition(snap({ gold: undefined }))).toBe('no-reference');
  });
});

describe('explainLiquidation (variant C: GoldOracle._settlement)', () => {
  it('prices at C while C sits between gold and the cap', () => {
    expect(explainLiquidation(snap({ primary: ok(C_FEED, pct(GOLD, 10_150n)) }))).toEqual({
      outcome: 'priced',
      rule: 'market',
      price: pct(GOLD, 10_150n),
      band: 'inside',
    });
  });

  it('values the token at gold when C sits below it, inside the band', () => {
    expect(explainLiquidation(snap({ primary: ok(C_FEED, pct(GOLD, 9_900n)) }))).toEqual({
      outcome: 'priced',
      rule: 'at-gold',
      price: GOLD,
      band: 'inside',
    });
  });

  it('values the token at gold however far C falls below the band: a PAXG-specific depeg is not liquidated', () => {
    for (const hundredths of [9_700n, 8_000n, 1_000n]) {
      expect(explainLiquidation(snap({ primary: ok(C_FEED, pct(GOLD, hundredths)) }))).toEqual({
        outcome: 'priced',
        rule: 'at-gold',
        price: GOLD,
        band: 'below',
      });
    }
  });

  it('caps a premium at G x (1 + m), below the market', () => {
    const cap = pct(GOLD, 10_200n);
    expect(explainLiquidation(snap({ primary: ok(C_FEED, pct(GOLD, 10_500n)) }))).toEqual({
      outcome: 'priced',
      rule: 'premium-capped',
      price: cap,
      band: 'above',
    });
  });

  it('caps a premium inside the gold band when m is narrower than g', () => {
    const result = explainLiquidation(
      snap({ primary: ok(C_FEED, pct(GOLD, 10_150n)), goldBandPpm: 50_000n, liquidationClampPpm: 10_000n })
    );
    expect(result).toEqual({ outcome: 'priced', rule: 'premium-capped', price: pct(GOLD, 10_100n), band: 'inside' });
  });

  it('prices exactly at the cap as the market, and one unit above it as capped', () => {
    const cap = pct(GOLD, 10_200n);
    expect(explainLiquidation(snap({ primary: ok(C_FEED, cap) }))).toMatchObject({ rule: 'market', price: cap });
    expect(explainLiquidation(snap({ primary: ok(C_FEED, cap + 1n) }))).toMatchObject({
      rule: 'premium-capped',
      price: cap,
    });
  });

  it('refuses with No reliable price while C is unhealthy, naming C', () => {
    const result = explainLiquidation(snap({ primary: stopped(C_FEED, 'incomplete-round') }));
    expect(result).toMatchObject({ outcome: 'refused', refusedBy: 'no-reliable-price' });
    expect(result.outcome === 'refused' && result.detail).toContain('C has stopped (incomplete-round)');
  });

  it('refuses while G is unhealthy too: nothing prices a seizure on C or gold alone', () => {
    const result = explainLiquidation(snap({ gold: stopped(G_FEED) }));
    expect(result).toMatchObject({ outcome: 'refused', refusedBy: 'no-reliable-price' });
    expect(result.outcome === 'refused' && result.detail).toContain('G has stopped (stale)');
    expect(result.outcome === 'refused' && result.detail).toContain('resumes by itself');
  });

  it('names both feeds when both have stopped', () => {
    const result = explainLiquidation(snap({ primary: stopped(C_FEED), gold: stopped(G_FEED, 'unreadable') }));
    expect(result.outcome === 'refused' && result.detail).toContain('C has stopped (stale) and G has stopped (unreadable)');
  });

  it('prices at C with no gold reference set (local deployments)', () => {
    expect(explainLiquidation(snap({ gold: undefined, primary: ok(C_FEED, pct(GOLD, 15_000n)) }))).toEqual({
      outcome: 'priced',
      rule: 'no-reference',
      price: pct(GOLD, 15_000n),
      band: 'no-reference',
    });
  });

  it('applies no cap on an oracle that predates liquidationClampPpm', () => {
    expect(
      explainLiquidation(snap({ primary: ok(C_FEED, pct(GOLD, 10_500n)), liquidationClampPpm: undefined }))
    ).toMatchObject({ rule: 'market', price: pct(GOLD, 10_500n) });
  });
});

describe('liquidationCap', () => {
  it('is G x (1 + m) rounded down, undefined without a healthy G or a cap', () => {
    expect(liquidationCap(snap())).toBe(pct(GOLD, 10_200n));
    expect(liquidationCap(snap({ gold: stopped(G_FEED) }))).toBeUndefined();
    expect(liquidationCap(snap({ liquidationClampPpm: undefined }))).toBeUndefined();
  });
});

describe('stoppedSources', () => {
  it('names each unhealthy source by its plan symbol', () => {
    expect(stoppedSources(snap())).toEqual([]);
    expect(stoppedSources(snap({ primary: stopped(C_FEED), gold: stopped(G_FEED) }))).toEqual(['C', 'G']);
    expect(stoppedSources(snap({ gold: undefined }))).toEqual([]);
  });
});

describe('snapshotFields', () => {
  it('puts C and G side by side with both widths, the cap and the band position', () => {
    const fields = snapshotFields(snap({ primary: ok(C_FEED, pct(GOLD, 9_700n)) }));
    expect(fields).toMatchObject({
      primaryFeed: C_FEED,
      primaryPrice: pct(GOLD, 9_700n),
      primaryStatus: 'ok',
      goldFeed: G_FEED,
      goldPrice: GOLD,
      goldStatus: 'ok',
      goldBandPpm: 20_000n,
      liquidationClampPpm: 20_000n,
      liquidationCap: pct(GOLD, 10_200n),
      stalenessThreshold: 90_000n,
      blockTimestamp: NOW,
      primaryGoldGapPpm: 30_000n,
      bandPosition: 'below',
      stoppedSources: [],
    });
  });

  it('carries none of the retired pool, breach, floor or depth fields', () => {
    const keys = Object.keys(snapshotFields(snap()));
    for (const retired of [
      'confirmationFeed',
      'poolStatus',
      'agreementBandPpm',
      'breachSince',
      'liquidationFloor',
      'heldDepthPpm',
      'floorDescentPpmPerHour',
    ]) {
      expect(keys).not.toContain(retired);
    }
  });

  it('says null for an unset reference and an unknown cap', () => {
    const fields = snapshotFields(snap({ gold: undefined, liquidationClampPpm: undefined }));
    expect(fields).toMatchObject({ goldFeed: null, liquidationClampPpm: null, liquidationCap: null });
  });
});

describe('readOracleSnapshot', () => {
  const stubRead = (
    rounds: Record<string, readonly unknown[]>,
    options: { anchor?: typeof C_FEED; clampMissing?: boolean } = {}
  ): { read: KeeperReadClient; calls: string[] } => {
    const calls: string[] = [];
    return {
      calls,
      read: {
        getBlockTimestamp: async () => NOW,
        readContract: async ({ address, functionName }) => {
          calls.push(functionName);
          switch (functionName) {
            case 'feeds':
              return [C_FEED, GOLD, true];
            case 'anchorFeed':
              return options.anchor ?? G_FEED;
            case 'goldBandPpm':
              return 20_000n;
            case 'liquidationClampPpm':
              if (options.clampMissing === true) throw new Error('returned no data ("0x")');
              return 30_000n;
            case 'stalenessThreshold':
              return 90_000n;
            case 'latestRoundData': {
              const round = rounds[address];
              if (round === undefined) throw new Error('rpc down');
              return round;
            }
            default:
              throw new Error(`Unexpected read: ${functionName}`);
          }
        },
      },
    };
  };

  it('reads C, G, both widths and the staleness limit, and nothing retired', async () => {
    const { read, calls } = stubRead({
      [C_FEED]: [9n, pct(GOLD, 9_900n), 0n, NOW - 60n, 9n],
      [G_FEED]: [4n, GOLD, 0n, NOW - 100_000n, 4n],
    });

    const snapshot = await readOracleSnapshot(read, ORACLE, PAXG);

    expect(snapshot).toMatchObject({
      primary: { feed: C_FEED, answer: pct(GOLD, 9_900n), status: 'ok' },
      gold: { feed: G_FEED, answer: GOLD, status: 'stale' },
      goldBandPpm: 20_000n,
      liquidationClampPpm: 30_000n,
      stalenessThreshold: 90_000n,
      now: NOW,
    });
    for (const retired of ['confirmationFeed', 'agreementBandPpm', 'breachSince', 'quoteLiquidationFloor', 'quoteDepth']) {
      expect(calls).not.toContain(retired);
    }
  });

  it('carries an unreadable feed on its round and an unset anchor as no reference', async () => {
    const { read } = stubRead({}, { anchor: ZERO });

    const snapshot = await readOracleSnapshot(read, ORACLE, PAXG);

    expect(snapshot.primary.status).toBe('unreadable');
    expect(snapshot.gold).toBeUndefined();
  });

  it('answers an undefined cap on an oracle that predates liquidationClampPpm', async () => {
    const { read } = stubRead({ [C_FEED]: [1n, GOLD, 0n, NOW, 1n], [G_FEED]: [1n, GOLD, 0n, NOW, 1n] }, { clampMissing: true });

    expect((await readOracleSnapshot(read, ORACLE, PAXG)).liquidationClampPpm).toBeUndefined();
  });
});
