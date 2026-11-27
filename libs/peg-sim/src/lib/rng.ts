/**
 * Deterministic PRNG. Every run is reproducible from its seed, which is the only way
 * a simulation result can be cited in a parameter decision: "scenario X, seed Y" must
 * mean the same thing next month.
 */
export type Rng = () => number;

/** mulberry32: small, fast, good enough statistical quality for agent behaviour. */
export function mulberry32(seed: number): Rng {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** Standard normal via Box-Muller. */
export function gaussian(rng: Rng): number {
	let u = 0;
	let v = 0;
	while (u === 0) u = rng();
	while (v === 0) v = rng();
	return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}
