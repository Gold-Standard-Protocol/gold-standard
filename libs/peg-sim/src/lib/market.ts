import { mulDiv, toNumber18 } from './mechanics';
import type { Pool } from './state';

/** Spot price of GSUSD in USDC from the constant-product pool. */
export function poolPrice(pool: Pool): number {
	if (pool.gsusd18 === 0n) return 0;
	return toNumber18(pool.usdc18) / toNumber18(pool.gsusd18);
}

/** Buy GSUSD with USDC. Returns GSUSD out; mutates reserves. Constant product, no LP fee. */
export function buyGsusd(pool: Pool, usdcIn18: bigint): bigint {
	if (usdcIn18 <= 0n) return 0n;
	const k = pool.gsusd18 * pool.usdc18;
	const newUsdc = pool.usdc18 + usdcIn18;
	const newGsusd = k / newUsdc;
	const out = pool.gsusd18 - newGsusd;
	pool.usdc18 = newUsdc;
	pool.gsusd18 = newGsusd;
	return out;
}

/** Sell GSUSD for USDC. Returns USDC out; mutates reserves. */
export function sellGsusd(pool: Pool, gsusdIn18: bigint): bigint {
	if (gsusdIn18 <= 0n) return 0n;
	const k = pool.gsusd18 * pool.usdc18;
	const newGsusd = pool.gsusd18 + gsusdIn18;
	const newUsdc = k / newGsusd;
	const out = pool.usdc18 - newUsdc;
	pool.gsusd18 = newGsusd;
	pool.usdc18 = newUsdc;
	return out;
}

/**
 * USDC required to lift the pool price to `target`. From x·y = k with
 * price = y/x: y' = sqrt(k · target), so usdcIn = y' − y. Returns 0 if already above.
 */
export function usdcToReachPrice(pool: Pool, target: number): bigint {
	const current = poolPrice(pool);
	if (current >= target) return 0n;
	const k = toNumber18(pool.gsusd18) * toNumber18(pool.usdc18);
	const targetUsdc = Math.sqrt(k * target);
	const delta = targetUsdc - toNumber18(pool.usdc18);
	return delta > 0 ? BigInt(Math.floor(delta * 1e6)) * 10n ** 12n : 0n;
}

/** GSUSD required to push the pool price DOWN to `target`. */
export function gsusdToReachPrice(pool: Pool, target: number): bigint {
	const current = poolPrice(pool);
	if (current <= target) return 0n;
	const k = toNumber18(pool.gsusd18) * toNumber18(pool.usdc18);
	const targetGsusd = Math.sqrt(k / target);
	const delta = targetGsusd - toNumber18(pool.gsusd18);
	return delta > 0 ? BigInt(Math.floor(delta * 1e6)) * 10n ** 12n : 0n;
}

/** LPs withdraw a fraction of both sides proportionally. */
export function withdrawLiquidity(pool: Pool, ppm: bigint): void {
	pool.gsusd18 -= mulDiv(pool.gsusd18, ppm, 1_000_000n);
	pool.usdc18 -= mulDiv(pool.usdc18, ppm, 1_000_000n);
}
