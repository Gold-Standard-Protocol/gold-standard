import { DIRECT_LIQUIDATION_FUNCTIONS } from '@goldstandard/trpc/keeper';
import {
  DEFAULT_GAS_BOUNDS,
  GAS_BOUNDS,
  REGISTRY_HOOK_GAS_FLOOR,
  sizeGasLimit,
} from './gas';

describe('sizeGasLimit', () => {
  it('pads the estimate by a quarter when that lands inside the bounds', () => {
    expect(sizeGasLimit('liquidate', 1_600_000n)).toBe(2_000_000n);
  });

  it('floors a low estimate at the measured Sepolia figure', () => {
    expect(sizeGasLimit('liquidate', 500_000n)).toBe(1_300_000n);
    expect(sizeGasLimit('liquidateViaPool', 500_000n)).toBe(1_400_000n);
    expect(sizeGasLimit('approve', 50_000n)).toBe(160_000n);
  });

  it('lets a twenty-silo liquidation above the old ceiling through', () => {
    // About 1.45M measured; the old fixed 1.3M ceiling made the simulation fail.
    expect(sizeGasLimit('liquidate', 1_450_000n)).toBe(1_812_500n);
  });

  it('caps a poisoned estimate at the hard per-function maximum', () => {
    expect(sizeGasLimit('liquidate', 30_000_000n)).toBe(4_000_000n);
    expect(sizeGasLimit('approve', 10_000_000n)).toBe(400_000n);
  });

  it('carries no bounds for tripCircuitBreaker, which the final oracle removed', () => {
    expect(GAS_BOUNDS['tripCircuitBreaker']).toBeUndefined();
  });

  it('carries no bounds for observeBand, which variant C retired with the band heartbeat', () => {
    expect(GAS_BOUNDS['observeBand']).toBeUndefined();
  });

  it('uses the default bounds for an unlisted function', () => {
    expect(sizeGasLimit('somethingElse', 100_000n)).toBe(DEFAULT_GAS_BOUNDS.floor);
    expect(sizeGasLimit('somethingElse', 10_000_000n)).toBe(DEFAULT_GAS_BOUNDS.cap);
  });

  it('keeps every floor that can reach the vault above the registry hook floor', () => {
    expect(GAS_BOUNDS['liquidate']?.floor).toBeGreaterThan(REGISTRY_HOOK_GAS_FLOOR);
    expect(GAS_BOUNDS['liquidateViaPool']?.floor).toBeGreaterThan(REGISTRY_HOOK_GAS_FLOOR);
    for (const bounds of Object.values(GAS_BOUNDS)) {
      expect(bounds.cap).toBeGreaterThan(bounds.floor);
    }
  });
});

describe('gas bounds for every liquidation the keeper sends', () => {
  const liquidations = [...DIRECT_LIQUIDATION_FUNCTIONS, 'liquidateViaPool'] as const;

  it.each(liquidations)('gives %s explicit bounds rather than the default', (functionName) => {
    const bounds = GAS_BOUNDS[functionName];
    expect(bounds).toBeDefined();
    expect(bounds?.floor).toBeGreaterThan(REGISTRY_HOOK_GAS_FLOOR);
    expect(bounds?.cap).toBeGreaterThan(DEFAULT_GAS_BOUNDS.cap);
  });

  it('bounds emergencyLiquidate exactly as liquidate, since it runs the same seizure', () => {
    expect(GAS_BOUNDS['emergencyLiquidate']).toEqual(GAS_BOUNDS['liquidate']);
    // A twenty-silo emergency liquidation is not clamped to the 2M default.
    expect(sizeGasLimit('emergencyLiquidate', 1_800_000n)).toBe(2_250_000n);
    expect(sizeGasLimit('emergencyLiquidate', 500_000n)).toBe(1_300_000n);
  });
});
