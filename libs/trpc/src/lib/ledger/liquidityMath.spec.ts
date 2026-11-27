import {
  getSqrtRatioAtTick,
  integerSqrt,
  MAX_TICK,
  MIN_TICK,
  pegAmounts,
  pegSqrtPriceX96,
  pegValue,
  Q96,
} from './liquidityMath';

const ONE = 10n ** 18n;
const USDC = 10n ** 6n;
/** GSUSD (18 decimals) as token0 against a 6 decimal dollar, and the reverse order. */
const GSUSD_FIRST = { decimals0: 18, decimals1: 6 };
const GSUSD_SECOND = { decimals0: 6, decimals1: 18 };
const EQUAL = { decimals0: 18, decimals1: 18 };
/** The tick nearest parity for 18 against 6 decimals: log(1e-12) / log(1.0001). */
const PARITY_TICK_18_6 = -276_324;

const ratioAsNumber = (tick: number): number => {
  // A double keeps 53 bits of the square root price, which is ample for nine decimal places.
  const sqrt = Number(getSqrtRatioAtTick(tick)) / 2 ** 96;
  return sqrt * sqrt;
};

const within = (value: bigint, target: bigint, tolerance: bigint): boolean =>
  value >= target - tolerance && value <= target + tolerance;

describe('getSqrtRatioAtTick', () => {
  it('is 2^96 at tick zero', () => {
    expect(getSqrtRatioAtTick(0)).toBe(79228162514264337593543950336n);
    expect(getSqrtRatioAtTick(0)).toBe(Q96);
  });

  it('matches the pool at the two ends of the tick range', () => {
    expect(getSqrtRatioAtTick(MIN_TICK)).toBe(4295128739n);
    expect(getSqrtRatioAtTick(MAX_TICK)).toBe(1461446703485210103287273052203988822378723970342n);
  });

  it('matches the pool one tick either side of zero and one tick inside each end', () => {
    expect(getSqrtRatioAtTick(1)).toBe(79232123823359799118286999568n);
    expect(getSqrtRatioAtTick(-1)).toBe(79224201403219477170569942574n);
    expect(getSqrtRatioAtTick(MIN_TICK + 1)).toBe(4295343490n);
    expect(getSqrtRatioAtTick(MAX_TICK - 1)).toBe(1461373636630004318706518188784493106690254656249n);
  });

  it('follows 1.0001^tick at every power of two, so every table constant is exercised', () => {
    for (let bit = 0; bit < 19; bit += 1) {
      const tick = 1 << bit;
      expect(ratioAsNumber(tick) / 1.0001 ** tick).toBeCloseTo(1, 9);
      expect(ratioAsNumber(-tick) * 1.0001 ** tick).toBeCloseTo(1, 9);
    }
    expect(ratioAsNumber(1 << 19) / 1.0001 ** (1 << 19)).toBeCloseTo(1, 9);
  });

  it('rises strictly with the tick', () => {
    for (const tick of [MIN_TICK, -500_000, -276_325, -10, -1, 0, 1, 10, 276_324, 500_000, MAX_TICK - 1]) {
      expect(getSqrtRatioAtTick(tick + 1) > getSqrtRatioAtTick(tick)).toBe(true);
    }
  });

  it('refuses a tick outside the range or a fraction', () => {
    expect(() => getSqrtRatioAtTick(MAX_TICK + 1)).toThrow(RangeError);
    expect(() => getSqrtRatioAtTick(MIN_TICK - 1)).toThrow(RangeError);
    expect(() => getSqrtRatioAtTick(0.5)).toThrow(RangeError);
  });
});

describe('integerSqrt', () => {
  it('rounds down', () => {
    for (const value of [0n, 1n, 2n, 3n, 4n, 15n, 16n, 17n, 10n ** 40n, 10n ** 41n, (1n << 200n) - 1n]) {
      const root = integerSqrt(value);
      expect(root * root <= value).toBe(true);
      expect((root + 1n) * (root + 1n) > value).toBe(true);
    }
  });
});

describe('pegSqrtPriceX96', () => {
  it('is 2^96 for two tokens of equal decimals', () => {
    expect(pegSqrtPriceX96(EQUAL)).toBe(Q96);
    expect(pegSqrtPriceX96({ decimals0: 6, decimals1: 6 })).toBe(Q96);
  });

  it('is 2^96 / 10^6 when token0 has 18 decimals and token1 has 6, and the reverse in the other order', () => {
    expect(pegSqrtPriceX96(GSUSD_FIRST)).toBe(Q96 / 10n ** 6n);
    expect(pegSqrtPriceX96(GSUSD_SECOND)).toBe(Q96 * 10n ** 6n);
  });

  it('lies inside the tick nearest parity', () => {
    const peg = pegSqrtPriceX96(GSUSD_FIRST);
    expect(getSqrtRatioAtTick(PARITY_TICK_18_6 - 1) <= peg).toBe(true);
    expect(getSqrtRatioAtTick(PARITY_TICK_18_6 + 1) > peg).toBe(true);
  });

  it('refuses decimals above 18', () => {
    expect(() => pegSqrtPriceX96({ decimals0: 19, decimals1: 6 })).toThrow(RangeError);
  });
});

describe('pegValue', () => {
  it('values a full range position as both sides of the pool at parity (equal decimals)', () => {
    // L = sqrt(x * y): 1,000 of each token.
    const liquidity = 1_000n * ONE;
    const { amount0, amount1 } = pegAmounts(EQUAL, liquidity, -887_270, 887_270);
    expect(within(amount0, 1_000n * ONE, 10n ** 6n)).toBe(true);
    expect(within(amount1, 1_000n * ONE, 10n ** 6n)).toBe(true);
    expect(within(pegValue(EQUAL, liquidity, -887_270, 887_270), 2_000n * ONE, 10n ** 7n)).toBe(true);
  });

  it('values a full range position with 6 against 18 decimals, in either token order', () => {
    // 1,000 GSUSD and 1,000 of the 6 decimal dollar: L = sqrt(1e21 * 1e9).
    const liquidity = 10n ** 15n;
    const first = pegAmounts(GSUSD_FIRST, liquidity, -887_270, 887_270);
    expect(within(first.amount0, 1_000n * ONE, 10n ** 9n)).toBe(true);
    expect(within(first.amount1, 1_000n * USDC, 1n)).toBe(true);
    const second = pegAmounts(GSUSD_SECOND, liquidity, -887_270, 887_270);
    expect(within(second.amount0, 1_000n * USDC, 1n)).toBe(true);
    expect(within(second.amount1, 1_000n * ONE, 10n ** 9n)).toBe(true);
    // The 6 decimal side rounds down by less than one base unit, a millionth of a dollar.
    expect(within(pegValue(GSUSD_FIRST, liquidity, -887_270, 887_270), 2_000n * ONE, 2n * 10n ** 12n)).toBe(true);
    expect(within(pegValue(GSUSD_SECOND, liquidity, -887_270, 887_270), 2_000n * ONE, 2n * 10n ** 12n)).toBe(true);
  });

  it('gives the mirrored range the same value when the token order is reversed', () => {
    const liquidity = 123_456_789_012_345n;
    for (const [lower, upper] of [
      [PARITY_TICK_18_6 - 100, PARITY_TICK_18_6 + 100],
      [PARITY_TICK_18_6 - 5_000, PARITY_TICK_18_6 - 10],
      [PARITY_TICK_18_6 + 20, PARITY_TICK_18_6 + 4_000],
    ] as const) {
      const first = pegValue(GSUSD_FIRST, liquidity, lower, upper);
      const second = pegValue(GSUSD_SECOND, liquidity, -upper, -lower);
      expect(first > 0n).toBe(true);
      // Each side rounds separately, so the two orders agree to within a few base units of the 6 decimal token.
      expect(within(first, second, 10n ** 13n)).toBe(true);
    }
  });

  it('splits a narrow range around parity about evenly and holds both tokens', () => {
    const liquidity = 10n ** 18n;
    const { amount0, amount1 } = pegAmounts(GSUSD_FIRST, liquidity, PARITY_TICK_18_6 - 10, PARITY_TICK_18_6 + 10);
    expect(amount0 > 0n).toBe(true);
    expect(amount1 > 0n).toBe(true);
    const dollars0 = amount0;
    const dollars1 = amount1 * 10n ** 12n;
    // The tick nearest parity is not exactly parity, so the halves differ by a few percent at most.
    expect(within(dollars0, dollars1, dollars0 / 5n)).toBe(true);
  });

  it('is all token0 for a range entirely above parity and all token1 for one entirely below', () => {
    const liquidity = 10n ** 18n;
    const above = pegAmounts(GSUSD_FIRST, liquidity, PARITY_TICK_18_6 + 10, PARITY_TICK_18_6 + 200);
    expect(above.amount1).toBe(0n);
    expect(above.amount0 > 0n).toBe(true);
    const below = pegAmounts(GSUSD_FIRST, liquidity, PARITY_TICK_18_6 - 200, PARITY_TICK_18_6 - 10);
    expect(below.amount0).toBe(0n);
    expect(below.amount1 > 0n).toBe(true);
    expect(pegValue(GSUSD_FIRST, liquidity, PARITY_TICK_18_6 + 10, PARITY_TICK_18_6 + 200)).toBe(above.amount0);
    expect(pegValue(GSUSD_FIRST, liquidity, PARITY_TICK_18_6 - 200, PARITY_TICK_18_6 - 10)).toBe(below.amount1 * 10n ** 12n);
  });

  it('is linear in the liquidity, to within rounding', () => {
    const lower = PARITY_TICK_18_6 - 300;
    const upper = PARITY_TICK_18_6 + 500;
    const one = pegValue(GSUSD_FIRST, 10n ** 15n, lower, upper);
    const seven = pegValue(GSUSD_FIRST, 7n * 10n ** 15n, lower, upper);
    expect(within(seven, 7n * one, 10n ** 14n)).toBe(true);
    expect(pegValue(GSUSD_FIRST, 0n, lower, upper)).toBe(0n);
  });

  it('does not grow without bound as the range widens: the widest range holds the value of the two sides', () => {
    const liquidity = 10n ** 15n;
    const wide = pegValue(GSUSD_FIRST, liquidity, -887_270, 887_270);
    const narrower = pegValue(GSUSD_FIRST, liquidity, PARITY_TICK_18_6 - 50_000, PARITY_TICK_18_6 + 50_000);
    expect(narrower < wide).toBe(true);
    expect(wide <= 2_000n * ONE).toBe(true);
  });

  it('refuses an empty or inverted range and a negative liquidity', () => {
    expect(() => pegValue(EQUAL, 1n, 10, 10)).toThrow(RangeError);
    expect(() => pegValue(EQUAL, 1n, 20, 10)).toThrow(RangeError);
    expect(() => pegValue(EQUAL, -1n, 10, 20)).toThrow(RangeError);
  });
});
