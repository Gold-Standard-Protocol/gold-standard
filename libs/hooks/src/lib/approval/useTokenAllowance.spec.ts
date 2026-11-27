import { describe, expect, it } from 'vitest';
import { allowancePollInterval } from './useTokenAllowance';

describe('allowancePollInterval', () => {
	it('leaves a read allowance alone when nothing is awaited', () => {
		expect(allowancePollInterval({ status: 'success', data: 0n }, undefined)).toBe(false);
	});

	it('reads again while the allowance is short of an awaited amount, and stops once it covers it', () => {
		expect(allowancePollInterval({ status: 'success', data: 0n }, 10n)).toBe(15_000);
		expect(allowancePollInterval({ status: 'pending', data: undefined }, 10n)).toBe(15_000);
		expect(allowancePollInterval({ status: 'success', data: 10n }, 10n)).toBe(false);
	});

	// A failed read left the approve simulation off and the Approve button dead until the
	// window happened to regain focus.
	it('reads again after a failed read, awaited or not', () => {
		expect(allowancePollInterval({ status: 'error', data: undefined }, undefined)).toBe(15_000);
		expect(allowancePollInterval({ status: 'error', data: 10n }, 10n)).toBe(15_000);
	});
});
