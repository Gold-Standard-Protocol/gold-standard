import { describe, expect, it } from 'vitest';
import { LEDGER_ENABLED, ledgerEnabled } from './ledgerFlag';

describe('ledgerEnabled', () => {
	it('is on only for the exact text true', () => {
		expect(ledgerEnabled({ VITE_LEDGER_ENABLED: 'true' })).toBe(true);
	});

	it.each([undefined, '', 'false', 'TRUE', 'True', ' true', '1', 'yes', true])('is off for %j', (value) => {
		expect(ledgerEnabled({ VITE_LEDGER_ENABLED: value })).toBe(false);
	});

	it('is off in a build that does not name the variable, which is how the tests run', () => {
		expect(ledgerEnabled({})).toBe(false);
		expect(LEDGER_ENABLED).toBe(false);
	});
});
