import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RevenuePanel } from './RevenuePanel';

const state = vi.hoisted(() => ({ results: [] as Array<{ status: 'success' | 'failure'; result?: bigint }> }));
vi.mock('wagmi', () => ({ useReadContracts: () => ({ data: state.results, isLoading: false }) }));
vi.mock('@goldstandard/constants', () => ({
  TARGET_CHAIN_ID: 11155111,
  TOKEN_LIST: [],
  getSurplusBufferContractConfig: () => ({ address: '0x0000000000000000000000000000000000000001', abi: [] }),
}));

beforeEach(() => { state.results = Array.from({ length: 7 }, () => ({ status: 'failure' })); });
afterEach(cleanup);

describe('reserve floor read failures', () => {
  it('shows an unknown floor without inferring a legacy buffer during an RPC outage', () => {
    render(<RevenuePanel />);
    expect(screen.getByText('Reserve floor')).toBeTruthy();
    expect(screen.getByText(/cannot confirm a floor amount or which buffer version/)).toBeTruthy();
    expect(screen.queryByText(/predates|Reserve floor \(governed/)).toBeNull();
  });

  it('labels a readable governed minimum as a lower bound when the effective floor fails', () => {
    state.results[5] = { status: 'success', result: 15_000n * 10n ** 18n };
    render(<RevenuePanel />);
    expect(screen.getByText('Governed minimum (effective floor unavailable)')).toBeTruthy();
    expect(screen.getByText(/confirmed lower bound; the effective floor may be higher/)).toBeTruthy();
    expect(screen.getByText(/15,000/)).toBeTruthy();
    expect(screen.queryByText(/predates/)).toBeNull();
  });

  it('uses the effective automatic floor when it is readable instead of its lower governed minimum', () => {
    state.results[2] = { status: 'success', result: 30_000n * 10n ** 18n };
    state.results[5] = { status: 'success', result: 15_000n * 10n ** 18n };
    state.results[6] = { status: 'success', result: 200n };
    render(<RevenuePanel />);
    expect(screen.getByText('Reserve floor (2% of supply, contract-enforced)')).toBeTruthy();
    expect(screen.getByText(/30,000/)).toBeTruthy();
    expect(screen.queryByText(/15,000|effective floor unavailable/)).toBeNull();
  });

  it('names the rate the deployed buffer enforces, so a 3% buffer is not labelled 2%', () => {
    state.results[2] = { status: 'success', result: 30_000n * 10n ** 18n };
    state.results[6] = { status: 'success', result: 300n };
    render(<RevenuePanel />);
    expect(screen.getByText('Reserve floor (3% of supply, contract-enforced)')).toBeTruthy();
    expect(screen.getByText(/keeps at least 3% of outstanding GSUSD/)).toBeTruthy();
  });
});
