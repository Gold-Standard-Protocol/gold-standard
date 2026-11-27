import { RAW_PER_UNIT_DAY } from './units';

/** Fraction digits of a figure on the page and in the API's account answer. */
export const DISPLAY_DIGITS = 2;
/** Fraction digits of a figure in the published export, where it is meant to be checked. */
export const EXPORT_DIGITS = 6;

/**
 * Raw units (base units times seconds) as unit-days with exactly `digits` fraction digits,
 * rounded down: GSUSD-days for debt and pool deposits, dollar-days for liquidity.
 */
export const formatUnitDays = (raw: bigint, digits: number = DISPLAY_DIGITS): string => {
  const scale = 10n ** BigInt(digits);
  const scaled = (raw * scale) / RAW_PER_UNIT_DAY;
  if (digits === 0) return scaled.toString();
  return `${scaled / scale}.${(scaled % scale).toString().padStart(digits, '0')}`;
};

/** A balance in base units (18 decimals) as a decimal with `digits` fraction digits, rounded down. */
export const formatUnits18 = (amount: bigint, digits: number = EXPORT_DIGITS): string => {
  const scale = 10n ** BigInt(digits);
  const scaled = (amount * scale) / 10n ** 18n;
  return `${scaled / scale}.${(scaled % scale).toString().padStart(digits, '0')}`;
};
