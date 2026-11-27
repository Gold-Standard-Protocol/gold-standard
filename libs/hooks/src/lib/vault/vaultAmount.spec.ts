import { parseVaultAmount } from './vaultAmount';

describe('parseVaultAmount', () => {
	it('scales by the token decimals, so 1.5 XAUT is 1_500_000 native units', () => {
		expect(parseVaultAmount('1.5', 6)).toBe(1_500_000n);
	});

	it('scales an 18-decimal token the same way', () => {
		expect(parseVaultAmount('1.5', 18)).toBe(1_500_000_000_000_000_000n);
	});

	it('returns undefined rather than throwing on text that is not a number', () => {
		expect(parseVaultAmount('abc', 18)).toBeUndefined();
		expect(parseVaultAmount('1..2', 18)).toBeUndefined();
	});

	it('returns undefined when the decimals are not yet known', () => {
		expect(parseVaultAmount('1', undefined)).toBeUndefined();
	});

	it('returns undefined for an empty or missing amount', () => {
		expect(parseVaultAmount('', 18)).toBeUndefined();
		expect(parseVaultAmount(undefined, 18)).toBeUndefined();
	});
});
