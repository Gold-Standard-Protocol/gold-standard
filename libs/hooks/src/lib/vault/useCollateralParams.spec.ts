import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useCollateralParams } from './useCollateralParams';

vi.mock('wagmi', () => ({
  useReadContract: () => ({
    data: ['0x0000000000000000000000000000000000000001', 1_300_000n, 1_100_000n, 0n, 0n, 0n, true],
    isLoading: false,
  }),
}));

describe('governed collateral parameters', () => {
  it('preserves a valid zero liquidation penalty instead of treating it as missing', () => {
    const { result } = renderHook(() => useCollateralParams(11155111, '0x0000000000000000000000000000000000000001'));
    expect(result.current.liquidationPenaltyPercent).toBe(0);
    expect(result.current.minRatioPercent).toBe(130);
    expect(result.current.liquidationRatioPercent).toBe(110);
  });
});
