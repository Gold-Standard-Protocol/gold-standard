/** GoldVault.PRECISION: ratios and the penalty are in parts per million. */
export const PRECISION = 1_000_000n;
/** Oracle prices carry 8 decimals. */
export const PRICE_DECIMALS = 10n ** 8n;
/** Job name every liquidation log line carries. */
export const LIQUIDATION_JOB = 'liquidation-watch';
/**
 * The least gas the keeper ever sends with a liquidateViaPool: the floor of its gas bounds in
 * apps/keeper/src/gas.ts, sized there from Sepolia measurements. It lives here so the signer
 * balance watch prices a liquidation with the figure the sender uses.
 */
export const LIQUIDATE_VIA_POOL_GAS_FLOOR = 1_400_000n;
