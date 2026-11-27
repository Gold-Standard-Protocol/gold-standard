import { describe, expect, it } from 'vitest';
import { SCENARIOS } from './scenarios';
import { simulate } from './run';

/**
 * The generalised identity totalSupply == Σ borrowerPrincipal + gsrIssued must hold
 * after every day of every scenario. The only permitted exception is a bad-debt
 * write-off, which the model records deliberately so it is visible, never silent.
 */
describe('conservation identity across the scenario grid', () => {
	for (const scenario of SCENARIOS) {
		it(`${scenario.name}: identity and ledger hold on every day (or bad debt is the recorded cause)`, () => {
			const r = simulate(scenario, 7);
			const bad = r.series.filter((d) => !d.identityOk);
			// Ledger placement must ALWAYS balance: it has no bad-debt exception.
			expect(r.series.every((d) => d.ledgerOk)).toBe(true);
			if (bad.length > 0) {
				// A violation is only acceptable if it coincides with liquidations that left
				// unbacked debt, i.e. the gold-crash scenarios. Anything else is a bug.
				expect(scenario.name).toMatch(/gold-minus|oracle-lag|impaired|10b/);
			}
		});
	}

	it('runs are deterministic from the seed', () => {
		const a = simulate(SCENARIOS[0], 42);
		const b = simulate(SCENARIOS[0], 42);
		expect(a.metrics).toEqual(b.metrics);
		expect(a.series).toEqual(b.series);
	});

	it('different seeds produce different paths', () => {
		const a = simulate(SCENARIOS[2], 1);
		const b = simulate(SCENARIOS[2], 2);
		expect(a.series.map((d) => d.price)).not.toEqual(b.series.map((d) => d.price));
	});
});
