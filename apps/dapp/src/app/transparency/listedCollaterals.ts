import type { CollateralStat } from '@goldstandard/hooks';

/**
 * The collaterals the reserves page should list. A type the vault reports as inactive
 * that holds no gold and carries no debt is dormant (XAUT on a PAXG-first deployment,
 * registered in the oracle only), and a row of zeros beside PAXG read as an accepted
 * collateral. One that still holds gold or debt stays, so nothing backing GSUSD is ever
 * hidden. Before the vault answers every asset is kept.
 */
export function listedCollaterals(collaterals: readonly CollateralStat[]): CollateralStat[] {
  return collaterals.filter(
    (asset) => !(asset.active === false && (asset.balance ?? 0n) === 0n && (asset.debt ?? 0n) === 0n)
  );
}
