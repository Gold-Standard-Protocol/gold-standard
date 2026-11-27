import { DISPLAY_DIGITS, EXPORT_DIGITS, formatUnitDays, formatUnits18 } from './figures';
import { RAW_PER_UNIT_DAY, SECONDS_PER_DAY, UNIT } from './units';

describe('ledger units', () => {
  it('counts a unit-day as one unit of 18 decimals held for 86,400 seconds', () => {
    expect(UNIT).toBe(10n ** 18n);
    expect(SECONDS_PER_DAY).toBe(86_400n);
    expect(RAW_PER_UNIT_DAY).toBe(10n ** 18n * 86_400n);
  });
});

describe('formatUnitDays', () => {
  it('shows two fraction digits by default and six in the export', () => {
    expect(DISPLAY_DIGITS).toBe(2);
    expect(EXPORT_DIGITS).toBe(6);
    expect(formatUnitDays(RAW_PER_UNIT_DAY * 1_234n + RAW_PER_UNIT_DAY / 2n)).toBe('1234.50');
    expect(formatUnitDays(RAW_PER_UNIT_DAY * 1_234n + RAW_PER_UNIT_DAY / 2n, EXPORT_DIGITS)).toBe('1234.500000');
  });

  it('rounds down, never up', () => {
    expect(formatUnitDays((RAW_PER_UNIT_DAY * 1_999n) / 1_000n)).toBe('1.99');
    expect(formatUnitDays(RAW_PER_UNIT_DAY / 100n - 1n)).toBe('0.00');
    expect(formatUnitDays(RAW_PER_UNIT_DAY / 100n)).toBe('0.01');
    expect(formatUnitDays(RAW_PER_UNIT_DAY - 1n, 6)).toBe('0.999999');
  });

  it('shows zero and whole numbers with every digit', () => {
    expect(formatUnitDays(0n)).toBe('0.00');
    expect(formatUnitDays(RAW_PER_UNIT_DAY * 7n)).toBe('7.00');
    expect(formatUnitDays(RAW_PER_UNIT_DAY * 7n, 0)).toBe('7');
  });

  it('keeps every digit of a figure far beyond a double', () => {
    expect(formatUnitDays(RAW_PER_UNIT_DAY * 123_456_789_012_345_678_901_234_567_890n + RAW_PER_UNIT_DAY / 4n)).toBe(
      '123456789012345678901234567890.25'
    );
  });

  it('is one GSUSD-day for one GSUSD held for a day, and half of one for half a day', () => {
    expect(formatUnitDays(UNIT * 86_400n)).toBe('1.00');
    expect(formatUnitDays(UNIT * 43_200n)).toBe('0.50');
    expect(formatUnitDays(1_000n * UNIT * 3_600n, 6)).toBe('41.666666');
  });
});

describe('formatUnits18', () => {
  it('shows a balance of 18 decimals with six fraction digits, rounded down', () => {
    expect(formatUnits18(0n)).toBe('0.000000');
    expect(formatUnits18(UNIT * 60_661n)).toBe('60661.000000');
    expect(formatUnits18(999_999_999_000_000_000_000n)).toBe('999.999999');
    expect(formatUnits18(UNIT - 1n)).toBe('0.999999');
    expect(formatUnits18(UNIT / 2n, 2)).toBe('0.50');
  });
});
