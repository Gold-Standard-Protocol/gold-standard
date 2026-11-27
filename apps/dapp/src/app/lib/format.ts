import { formatUnits } from 'viem';

/**
 * An amount the visitor typed, grouped for reading ("3000" to "3,000") with its decimals
 * kept exactly as entered, so a review restates the amount that will be signed and never
 * rounds it. Anything that is not a plain decimal is returned unchanged.
 */
export function formatEnteredAmount(raw: string): string {
  const match = /^(\d+)(\.\d*)?$/.exec(raw.trim());
  if (!match) return raw;
  return match[1].replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (match[2] ?? '');
}

/** Format a USD value with sensible precision and grouping. */
export function formatUsd(
  value: number | undefined,
  opts: { maximumFractionDigits?: number; minimumFractionDigits?: number } = {}
): string {
  if (value === undefined || Number.isNaN(value)) return 'n/a';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: opts.minimumFractionDigits ?? 2,
    maximumFractionDigits: opts.maximumFractionDigits ?? 2,
  }).format(value);
}

/** Compact USD for headline metrics, e.g. $1.28B, $84.2M, $12.4K. */
export function formatUsdCompact(value: number | undefined): string {
  if (value === undefined || Number.isNaN(value)) return 'n/a';
  if (value === 0) return '$0';
  if (value < 1000) {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      maximumFractionDigits: 0,
    }).format(value);
  }
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    notation: 'compact',
    maximumFractionDigits: value >= 1_000_000 ? 2 : 1,
  }).format(value);
}

/** Plain number with grouping and bounded precision. */
export function formatNumber(
  value: number | undefined,
  opts: { maximumFractionDigits?: number; minimumFractionDigits?: number } = {}
): string {
  if (value === undefined || Number.isNaN(value)) return 'n/a';
  return value.toLocaleString('en-US', {
    minimumFractionDigits: opts.minimumFractionDigits ?? 0,
    maximumFractionDigits: opts.maximumFractionDigits ?? 2,
  });
}

/** Compact plain number, e.g. 84.2M. */
export function formatNumberCompact(value: number | undefined): string {
  if (value === undefined || Number.isNaN(value)) return 'n/a';
  return new Intl.NumberFormat('en-US', {
    notation: 'compact',
    maximumFractionDigits: 2,
  }).format(value);
}

/** Format a bigint token amount (given decimals) for display. */
export function formatTokenAmount(
  value: bigint | undefined,
  decimals = 18,
  maximumFractionDigits = 4
): string {
  if (value === undefined) return 'n/a';
  // minimumFractionDigits must never exceed maximumFractionDigits or
  // toLocaleString throws RangeError. Callers legitimately pass 0 to render a
  // whole-number figure (e.g. GSUSD in circulation), and the hardcoded 2
  // crashed the entire Proof-of-Reserves page the moment supply became
  // non-zero, a fault that could not fire while every figure was still
  // undefined pre-launch.
  return Number(formatUnits(value, decimals)).toLocaleString('en-US', {
    minimumFractionDigits: Math.min(2, maximumFractionDigits),
    maximumFractionDigits,
  });
}

/**
 * Like formatTokenAmount, but a non-zero value below the standard precision is shown
 * with more digits rather than as a false zero. A revenue counter reading "0.00 GSUSD"
 * after a repayment banked 0.00175 GSUSD looks like a stuck panel; "0.00175 GSUSD"
 * is what actually happened.
 */
export function formatTokenAmountPrecise(
  value: bigint | undefined,
  decimals = 18,
  standardDigits = 2,
  smallDigits = 6
): string {
  if (value === undefined) return 'n/a';
  const threshold = 10n ** BigInt(Math.max(decimals - standardDigits, 0));
  const isSmall = value !== 0n && value < threshold && value > -threshold;
  return formatTokenAmount(value, decimals, isSmall ? smallDigits : standardDigits);
}

/** Format a ratio percentage, e.g. 152.4%. */
export function formatPercent(
  value: number | undefined,
  fractionDigits = 1
): string {
  if (value === undefined || Number.isNaN(value) || value === Infinity)
    return 'n/a';
  return `${value.toFixed(fractionDigits)}%`;
}

/** A list in house style, with no Oxford comma: "A", "A or B", "A, B or C". */
export function joinWithOr(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} or ${items[items.length - 1]}`;
}

/** Shorten an EVM address: 0x1234…abcd. */
export function shortAddress(address: string | undefined): string {
  if (!address) return 'n/a';
  if (address.length < 11) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/**
 * A wei amount as a string a person could plausibly have typed, always rounding DOWN.
 *
 * `formatUnits(x, 18)` yields things like `39040.539673484096736935`. Written into an
 * input that is `text-2xl` in a flex row with a token pill, it overflows the field; shown
 * in prose it buries the number it is trying to communicate. Every "Max" button in the
 * app was doing this.
 *
 * Rounding DOWN is not cosmetic. These strings become transaction amounts, and rounding
 * up would push a Max past the very balance or cap it was derived from.
 */
export function toInputAmount(
  value: bigint,
  decimals = 18,
  displayDecimals = 6
): string {
  if (displayDecimals >= decimals) return formatUnits(value, decimals);
  const scale = 10n ** BigInt(decimals - displayDecimals);
  return formatUnits((value / scale) * scale, decimals);
}

/**
 * A short relative time for activity feeds: "just now", "4 min ago", "3 h ago",
 * "2 days ago", and a plain date beyond a week. `now` is injectable for tests.
 */
export function formatRelativeTime(timestampSeconds: number, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.floor(now / 1000) - timestampSeconds);
  if (seconds < 45) return 'just now';
  if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))} min ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)} h ago`;
  if (seconds < 7 * 86_400) {
    const days = Math.round(seconds / 86_400);
    return days === 1 ? 'yesterday' : `${days} days ago`;
  }
  return new Date(timestampSeconds * 1000).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}
