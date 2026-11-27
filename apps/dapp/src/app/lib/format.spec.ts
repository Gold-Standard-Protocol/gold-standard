import { formatEnteredAmount, formatTokenAmount, formatTokenAmountPrecise, formatRelativeTime, formatNumber, formatPercent , toInputAmount, joinWithOr } from './format';

describe('formatTokenAmount', () => {
  it('renders a whole-number figure when maximumFractionDigits is 0', () => {
    // Regression: minimumFractionDigits was hardcoded to 2, so any caller
    // asking for 0 decimals hit `minimum > maximum` and toLocaleString threw
    // RangeError. That crashed the whole Proof-of-Reserves page the moment
    // GSUSD supply became non-zero, invisible until the protocol was used.
    expect(() => formatTokenAmount(40_000n * 10n ** 18n, 18, 0)).not.toThrow();
    expect(formatTokenAmount(40_000n * 10n ** 18n, 18, 0)).toBe('40,000');
  });

  it('still shows two decimals by default', () => {
    expect(formatTokenAmount(1234n * 10n ** 18n)).toBe('1,234.00');
  });

  it('honours a higher precision request', () => {
    expect(formatTokenAmount(10n ** 17n, 18, 4)).toBe('0.10');
  });

  it('handles 6-decimal collateral such as XAUT', () => {
    expect(formatTokenAmount(250n * 10n ** 6n, 6, 0)).toBe('250');
  });

  it('renders an em dash for an undefined amount rather than a fake zero', () => {
    expect(formatTokenAmount(undefined)).toBe('n/a');
  });
});

describe('formatNumber / formatPercent', () => {
  it('never throws when asked for zero decimals', () => {
    expect(() => formatNumber(1234.5, { maximumFractionDigits: 0 })).not.toThrow();
  });

  it('reports an unknown percentage honestly', () => {
    expect(formatPercent(undefined)).toBe('n/a');
    expect(formatPercent(Infinity)).toBe('n/a');
  });
});

describe('toInputAmount', () => {
  it('truncates an 18-decimal value to something typeable', () => {
    // The exact string that overflowed the repay dialog.
    expect(toInputAmount(39040539673484096736935n, 18)).toBe('39040.539673');
  });

  it('always rounds DOWN, so a Max can never exceed what it came from', () => {
    const value = 1999999999999999999n; // 1.999999999999999999
    const out = toInputAmount(value, 18, 2);
    expect(out).toBe('1.99');
    expect(BigInt(Math.floor(Number(out) * 100))).toBeLessThanOrEqual(value / 10n ** 16n);
  });

  it('leaves a value alone when it already fits', () => {
    expect(toInputAmount(1500000000000000000n, 18)).toBe('1.5');
  });

  it('handles 6-decimal tokens such as XAUT without over-truncating', () => {
    expect(toInputAmount(1234567n, 6)).toBe('1.234567');
  });

  it('returns zero cleanly', () => {
    expect(Number(toInputAmount(0n, 18))).toBe(0);
  });
});

describe('formatTokenAmountPrecise', () => {
	it('shows a sub-cent fee with enough digits to be seen, not as 0.00', () => {
		expect(formatTokenAmountPrecise(1_750_380_667_876_341n)).toBe('0.00175');
	});

	it('keeps the standard two decimals for ordinary figures and for zero', () => {
		expect(formatTokenAmountPrecise(10_000n * 10n ** 18n)).toBe('10,000.00');
		expect(formatTokenAmountPrecise(0n)).toBe('0.00');
		expect(formatTokenAmountPrecise(undefined)).toBe('n/a');
	});
});

describe('formatRelativeTime', () => {
	const now = 1_800_000_000_000; // ms
	const at = (secondsAgo: number) => formatRelativeTime(now / 1000 - secondsAgo, now);
	it('steps from seconds to a date', () => {
		expect(at(10)).toBe('just now');
		expect(at(240)).toBe('4 min ago');
		expect(at(3 * 3600)).toBe('3 h ago');
		expect(at(86_400)).toBe('yesterday');
		expect(at(3 * 86_400)).toBe('3 days ago');
		expect(at(30 * 86_400)).toMatch(/\d{4}$/);
	});
});

describe('joinWithOr', () => {
	// House style: no Oxford comma.
	it('joins one, two and three items without an Oxford comma', () => {
		expect(joinWithOr(['PAXG'])).toBe('PAXG');
		expect(joinWithOr(['PAXG', 'XAUT'])).toBe('PAXG or XAUT');
		expect(joinWithOr(['A', 'B', 'C'])).toBe('A, B or C');
	});

	it('answers an empty string for an empty list', () => {
		expect(joinWithOr([])).toBe('');
	});
});

describe('formatEnteredAmount', () => {
  it('groups the whole part and keeps typed decimals exactly', () => {
    expect(formatEnteredAmount('3000')).toBe('3,000');
    expect(formatEnteredAmount('1234567.891234567890123456')).toBe('1,234,567.891234567890123456');
    expect(formatEnteredAmount('0.25')).toBe('0.25');
    expect(formatEnteredAmount('999')).toBe('999');
    expect(formatEnteredAmount('1000.')).toBe('1,000.');
  });

  it('leaves anything that is not a plain decimal unchanged', () => {
    for (const raw of ['', 'abc', '1e6', '-5', '1,000']) expect(formatEnteredAmount(raw)).toBe(raw);
  });
});
