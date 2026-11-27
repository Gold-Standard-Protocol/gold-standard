/**
 * The units of the usage ledger. Each of the three dimensions is an amount held over time,
 * kept as the amount in base units (18 decimals) times seconds and reported in its natural
 * unit: GSUSD-days for vault debt and for stability pool deposits, dollar-days for
 * liquidity. No dimension is weighted against another, no period counts for more than
 * another and the three figures are never added together.
 *
 * The ledger is a record of past usage only. No token exists, no token is promised, and
 * the ledger confers no rights and may never confer any (docs/TOKEN_POLICY.md section 2).
 */

export const SECONDS_PER_DAY = 86_400n;
/** One GSUSD, or one dollar of liquidity at the peg, in base units. */
export const UNIT = 10n ** 18n;
/** Raw units per unit-day: base units times seconds. */
export const RAW_PER_UNIT_DAY = UNIT * SECONDS_PER_DAY;
