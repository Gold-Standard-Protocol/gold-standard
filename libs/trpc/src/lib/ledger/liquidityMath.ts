/**
 * Uniswap v3 arithmetic for the liquidity dimension, in exact integers: the square root price
 * of a tick (a port of the pool's TickMath), the square root price at which one GSUSD is
 * worth exactly one dollar of the other token, and the value of a position at that price.
 *
 * A position's recorded amount is its value at the peg: the two token amounts it would hold
 * if the pool traded at parity, added as dollars with 18 decimals. For a given liquidity
 * and tick range that is a constant, so it does not follow the live price, and it is what
 * the position is worth when GSUSD holds its peg, so a wide range cannot inflate it.
 */

export const MIN_TICK = -887_272;
export const MAX_TICK = 887_272;
export const Q96 = 1n << 96n;

const MAX_UINT256 = (1n << 256n) - 1n;
const DOLLAR_DECIMALS = 18;

/** sqrt(1.0001^-(2^bit)) as a Q128 number, for bit 1 to 19, as in the pool's TickMath. */
const TICK_BIT_FACTORS: readonly bigint[] = [
  0xfff97272373d413259a46990580e213an,
  0xfff2e50f5f656932ef12357cf3c7fdccn,
  0xffe5caca7e10e4e61c3624eaa0941cd0n,
  0xffcb9843d60f6159c9db58835c926644n,
  0xff973b41fa98c081472e6896dfb254c0n,
  0xff2ea16466c96a3843ec78b326b52861n,
  0xfe5dee046a99a2a811c461f1969c3053n,
  0xfcbe86c7900a88aedcffc83b479aa3a4n,
  0xf987a7253ac413176f2b074cf7815e54n,
  0xf3392b0822b70005940c7a398e4b70f3n,
  0xe7159475a2c29b7443b29c7fa6e889d9n,
  0xd097f3bdfd2022b8845ad8f792aa5825n,
  0xa9f746462d870fdf8a65dc1f90e061e5n,
  0x70d869a156d2a1b890bb3df62baf32f7n,
  0x31be135f97d08fd981231505542fcfa6n,
  0x9aa508b5b7a84e1c677de54f3e99bc9n,
  0x5d6af8dedb81196699c329225ee604n,
  0x2216e584f5fa1ea926041bedfe98n,
  0x48a170391f7dc42444e8fa2n,
];
const TICK_BIT_ZERO_FACTOR = 0xfffcb933bd6fad37aa2d162d1a594001n;

export const isTick = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= MIN_TICK && value <= MAX_TICK;

/** sqrt(1.0001^tick) as a Q96 number, exactly as the pool computes it. */
export const getSqrtRatioAtTick = (tick: number): bigint => {
  if (!isTick(tick)) throw new RangeError(`tick ${String(tick)} is outside the Uniswap v3 range`);
  const magnitude = Math.abs(tick);
  let ratio = (magnitude & 1) !== 0 ? TICK_BIT_ZERO_FACTOR : 1n << 128n;
  TICK_BIT_FACTORS.forEach((factor, index) => {
    if ((magnitude & (1 << (index + 1))) !== 0) ratio = (ratio * factor) >> 128n;
  });
  if (tick > 0) ratio = MAX_UINT256 / ratio;
  return (ratio >> 32n) + (ratio % (1n << 32n) === 0n ? 0n : 1n);
};

/** The largest integer whose square is not above `value`. */
export const integerSqrt = (value: bigint): bigint => {
  if (value < 0n) throw new RangeError('square root of a negative number');
  if (value < 2n) return value;
  let low = 1n << BigInt((value.toString(2).length - 1) >> 1);
  let high = low << 1n;
  while (low + 1n < high) {
    const middle = (low + high) >> 1n;
    if (middle * middle <= value) low = middle;
    else high = middle;
  }
  return low;
};

/** The two tokens of the pool as the value needs them: which is GSUSD is irrelevant at the peg. */
export interface PegPair {
  decimals0: number;
  decimals1: number;
}

const assertDecimals = (decimals: number): void => {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > DOLLAR_DECIMALS) {
    throw new RangeError(`token decimals must be a whole number from 0 to ${DOLLAR_DECIMALS}`);
  }
};

/**
 * The pool's square root price, Q96, when one whole token0 is worth one whole token1: the
 * price in base units is 10^decimals1 / 10^decimals0.
 */
export const pegSqrtPriceX96 = (pair: PegPair): bigint => {
  assertDecimals(pair.decimals0);
  assertDecimals(pair.decimals1);
  return integerSqrt((10n ** BigInt(pair.decimals1) * Q96 * Q96) / 10n ** BigInt(pair.decimals0));
};

/** Token0 a position of `liquidity` holds between two square root prices, rounded down. */
const amount0Between = (lower: bigint, upper: bigint, liquidity: bigint): bigint =>
  (liquidity * Q96 * (upper - lower)) / upper / lower;

/** Token1 a position of `liquidity` holds between two square root prices, rounded down. */
const amount1Between = (lower: bigint, upper: bigint, liquidity: bigint): bigint =>
  (liquidity * (upper - lower)) / Q96;

export interface PegAmounts {
  amount0: bigint;
  amount1: bigint;
}

/**
 * The token amounts a position holds at the peg, in base units, rounded down as the pool
 * rounds what it pays out. A range entirely above parity is all token0 and a range entirely
 * below it is all token1.
 */
export const pegAmounts = (pair: PegPair, liquidity: bigint, tickLower: number, tickUpper: number): PegAmounts => {
  if (liquidity < 0n) throw new RangeError('liquidity is negative');
  if (tickLower >= tickUpper) throw new RangeError('the lower tick must be below the upper tick');
  const lower = getSqrtRatioAtTick(tickLower);
  const upper = getSqrtRatioAtTick(tickUpper);
  const peg = pegSqrtPriceX96(pair);
  if (peg <= lower) return { amount0: amount0Between(lower, upper, liquidity), amount1: 0n };
  if (peg >= upper) return { amount0: 0n, amount1: amount1Between(lower, upper, liquidity) };
  return { amount0: amount0Between(peg, upper, liquidity), amount1: amount1Between(lower, peg, liquidity) };
};

/** A position's value at the peg in dollars with 18 decimals: both amounts, each counted at one dollar a token. */
export const pegValue = (pair: PegPair, liquidity: bigint, tickLower: number, tickUpper: number): bigint => {
  const { amount0, amount1 } = pegAmounts(pair, liquidity, tickLower, tickUpper);
  return (
    amount0 * 10n ** BigInt(DOLLAR_DECIMALS - pair.decimals0) + amount1 * 10n ** BigInt(DOLLAR_DECIMALS - pair.decimals1)
  );
};
