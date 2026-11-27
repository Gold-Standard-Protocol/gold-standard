// Per-function gas bounds. The limit sent is the node's
// estimate with a margin, never below the floor and never above the cap, and the
// same figure is used for the simulation and the send. The floor is sized from
// Sepolia measurements (2026-10-22), where a new storage slot costs about 100k
// gas, five times Hardhat's figure: a liquidation ran 437k to 535k before the
// vault's registry hook, and the vault then requires 375k left for that hook; a
// first approve of a fresh allowance slot cost 112k. The cap is the defence
// against a compromised RPC inflating its estimate: liquidation gas grows with
// the silos a vault spans (about 1.45M for a 20-silo vault), so the cap sits
// well above any honest figure and a poisoned one above it fails in simulation.

import { LIQUIDATE_VIA_POOL_GAS_FLOOR } from '@goldstandard/trpc/keeper';

export interface GasBounds {
  floor: bigint;
  cap: bigint;
}

const LIQUIDATE_BOUNDS: GasBounds = { floor: 1_300_000n, cap: 4_000_000n };

export const GAS_BOUNDS: Readonly<Record<string, GasBounds>> = {
  accrueInterest: { floor: 400_000n, cap: 1_500_000n },
  // The floor is shared with the signer balance watch, which prices a liquidation with it.
  liquidateViaPool: { floor: LIQUIDATE_VIA_POOL_GAS_FLOOR, cap: 4_000_000n },
  liquidate: LIQUIDATE_BOUNDS,
  // The same silo walk, surplus routing and registry hook as
  // liquidate. Unlisted, it fell to the 2M default cap, below a large multi-silo seizure.
  emergencyLiquidate: LIQUIDATE_BOUNDS,
  approve: { floor: 160_000n, cap: 400_000n },
};

export const DEFAULT_GAS_BOUNDS: GasBounds = { floor: 600_000n, cap: 2_000_000n };

/** Headroom over the estimate: 1.25 times. */
const GAS_MARGIN_NUMERATOR = 125n;
const GAS_MARGIN_DENOMINATOR = 100n;

/** GoldVault's registry hook floor; every floor that can reach it must exceed it. */
export const REGISTRY_HOOK_GAS_FLOOR = 375_000n;

export const gasBoundsFor = (functionName: string): GasBounds =>
  GAS_BOUNDS[functionName] ?? DEFAULT_GAS_BOUNDS;

/** The gas limit for a call: the padded estimate clamped to the function's bounds. */
export const sizeGasLimit = (functionName: string, estimate: bigint): bigint => {
  const { floor, cap } = gasBoundsFor(functionName);
  const padded = (estimate * GAS_MARGIN_NUMERATOR) / GAS_MARGIN_DENOMINATOR;
  if (padded < floor) return floor;
  if (padded > cap) return cap;
  return padded;
};
