import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COVERAGE_SENTINEL_PPM, RESERVE_PANEL_READS, StabilityReservePanel, formatCoverage } from './StabilityReservePanel';

const state = vi.hoisted(() => ({ results: [] as Array<{ status: 'success' | 'failure'; result?: bigint }> }));
vi.mock('wagmi', () => ({ useReadContracts: () => ({ data: state.results, isLoading: false }) }));
vi.mock('@goldstandard/constants', () => ({
  TARGET_CHAIN_ID: 1,
  TOKEN_LIST: [
    { name: 'Paxos Gold', symbol: 'PAXG', decimals: 18, gold: true, addresses: { 1: '0x45804880De22913dAFE09f4980848ECE6EcbAf78' } },
  ],
  getStabilityReserveContractConfig: () => ({ address: '0x0000000000000000000000000000000000000001', abi: [] }),
}));

beforeEach(() => {
  state.results = Array.from({ length: 10 }, () => ({ status: 'failure' }));
});
afterEach(cleanup);

describe('StabilityReservePanel reads', () => {
  it('pins every read to the target chain, whatever chain the wallet is on', () => {
    expect(RESERVE_PANEL_READS.length).toBe(10);
    for (const read of RESERVE_PANEL_READS) expect(read.chainId).toBe(1);
  });
});

describe('reserve coverage with nothing in circulation', () => {
  it('formats a measured coverage as a percentage', () => {
    expect(formatCoverage(1_250_000n)).toBe('125.00%');
  });

  it('shows the no-supply sentinel as n/a, not 100,000.00%', () => {
    expect(formatCoverage(COVERAGE_SENTINEL_PPM)).toBe('n/a');
    state.results[0] = { status: 'success', result: COVERAGE_SENTINEL_PPM };
    render(<StabilityReservePanel />);
    expect(screen.queryByText(/100,000/)).toBeNull();
    expect(screen.getByText('n/a')).toBeTruthy();
    expect(screen.getByText('No GSUSD circulates outside the reserve yet.')).toBeTruthy();
  });
});
