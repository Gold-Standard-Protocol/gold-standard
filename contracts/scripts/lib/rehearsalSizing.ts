/**
 * Arithmetic the fork rehearsal uses to size its vaults from the prices of the day, so that no
 * scenario depends on gold standing at a particular level or on the token's market feed and
 * the gold feed agreeing. Pure: no provider, no Hardhat.
 *
 * Prices carry 8 decimals, token and GSUSD amounts 18, ratios and shares are parts per million.
 */
export const SIZING_PPM = 1_000_000n;
const E8 = 100_000_000n;

export interface OraclePrices {
  /** What a mint and an indebted withdrawal are valued at: the lower of C and G, and only inside the gold band. */
  borrow: bigint | undefined;
  /** What a liquidation is triggered and sized at, and what the vault records: min(max(C, G), G x (1 + clamp)). */
  settlement: bigint;
  /** The lower of C and G, inside the band or not. */
  valuation: bigint;
}

/**
 * GoldOracle's rules for a token with a market feed C and a gold feed G, both healthy
 * (docs/ORACLE_IMPLEMENTATION_PLAN.md section 3). The band is measured against G.
 */
export function oraclePrices(c: bigint, g: bigint, bandPpm: bigint, clampPpm: bigint): OraclePrices {
  if (c <= 0n || g <= 0n) throw new Error("Both prices must be above zero.");
  if (bandPpm < 0n || clampPpm < 0n) throw new Error("The band and the clamp cannot be negative.");
  const edge = (width: bigint, up: boolean): bigint => (g * (up ? SIZING_PPM + width : SIZING_PPM - width)) / SIZING_PPM;
  const lower = c < g ? c : g;
  const higher = c > g ? c : g;
  const cap = edge(clampPpm, true);
  return {
    borrow: c >= edge(bandPpm, false) && c <= edge(bandPpm, true) ? lower : undefined,
    settlement: higher > cap ? cap : higher,
    valuation: lower,
  };
}

/** The debt that leaves `collateral` at `ratioPpm` when it is valued at `price`. */
export function mintAtRatio(collateral: bigint, price: bigint, ratioPpm: bigint): bigint {
  if (ratioPpm <= 0n) throw new Error("The ratio must be above zero.");
  return (((collateral * price) / E8) * SIZING_PPM) / ratioPpm;
}

/** The collateral, rounded up, that backs `debt` at `ratioPpm` when it is valued at `price`. */
export function collateralForDebt(debt: bigint, price: bigint, ratioPpm: bigint): bigint {
  if (price <= 0n) throw new Error("The price must be above zero.");
  const numerator = debt * ratioPpm * E8;
  const denominator = price * SIZING_PPM;
  return (numerator + denominator - 1n) / denominator;
}

/**
 * The share of its debt an underwater vault leaves as bad debt when it is liquidated in full.
 * `valuePpm` is the collateral's value at the liquidation price as a share of the debt. The
 * liquidator pays max(value x (1 - discount), 2 x value - debt), as GoldVault sizes it, and
 * the rest of the debt is written off. Zero for a vault that is not under water.
 */
export function underwaterBadDebtPpm(valuePpm: bigint, discountPpm: bigint): bigint {
  if (valuePpm < 0n || discountPpm < 0n || discountPpm > SIZING_PPM) throw new Error("Shares must lie between 0 and 100%.");
  if (valuePpm >= SIZING_PPM) return 0n;
  const discounted = (valuePpm * (SIZING_PPM - discountPpm)) / SIZING_PPM;
  const floor = 2n * valuePpm > SIZING_PPM ? 2n * valuePpm - SIZING_PPM : 0n;
  const paid = discounted > floor ? discounted : floor;
  return SIZING_PPM - paid;
}

export interface BadDebtSizing {
  /** The bad debt the full liquidation should book, in GSUSD. */
  badDebt: bigint;
  /** The borrowing price the vault is opened at. */
  borrowPrice: bigint;
  /** The liquidation price before the fall. */
  settlementPrice: bigint;
  /** What both feeds are scaled to, in ppm (720,000 is a 28% fall). */
  fallPpm: bigint;
  /** The ratio the vault is opened at, at the borrowing price. */
  ratioPpm: bigint;
  /** GoldVault.underwaterDiscountPpm. */
  discountPpm: bigint;
}

/**
 * The collateral to open a vault with, at `ratioPpm` of the borrowing price, so that a full
 * liquidation after a gold-wide fall books at least `badDebt`. The vault is minted at the
 * borrowing price and liquidated at the settlement price, which can sit above it, so both
 * enter the arithmetic.
 */
export function collateralForBadDebt(s: BadDebtSizing): bigint {
  if (s.badDebt <= 0n) throw new Error("The bad debt to book must be above zero.");
  if (s.borrowPrice <= 0n || s.settlementPrice <= 0n) throw new Error("Both prices must be above zero.");
  // Rounded up: a higher cover means a smaller share lost, so the vault is never sized short.
  const valuePpm = (s.ratioPpm * s.fallPpm * s.settlementPrice) / (SIZING_PPM * s.borrowPrice) + 1n;
  const sharePpm = underwaterBadDebtPpm(valuePpm, s.discountPpm);
  if (sharePpm === 0n) throw new Error("A vault opened at this ratio is not under water after this fall.");
  // The share is known to one part per million, so the debt carries 100 ppm of headroom.
  const debt = (s.badDebt * (SIZING_PPM + 100n) + sharePpm - 1n) / sharePpm;
  return collateralForDebt(debt, s.borrowPrice, s.ratioPpm);
}
