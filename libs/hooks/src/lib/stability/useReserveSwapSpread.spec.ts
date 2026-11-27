import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useReserveSwapSpread } from './useReserveSwapSpread';

const TOKEN = '0x00000000000000000000000000000000000000a1' as const;
const E18 = 10n ** 18n;

const read = vi.hoisted(() => ({
	data: undefined as readonly [bigint, bigint] | undefined,
	isError: false,
	calls: [] as { args?: readonly unknown[]; query?: { enabled?: boolean } }[],
}));

vi.mock('@goldstandard/constants', () => ({
	getStabilityReserveContractConfig: () => ({ address: '0x00000000000000000000000000000000000000ff', abi: [] }),
	goldStabilityReserveAbi: [],
}));

vi.mock('wagmi', () => ({
	useReadContract: (params: { args?: readonly unknown[]; query?: { enabled?: boolean } }) => {
		read.calls.push(params);
		return { data: params.query?.enabled ? read.data : undefined, isError: params.query?.enabled ? read.isError : false };
	},
}));

describe('useReserveSwapSpread', () => {
	beforeEach(() => {
		read.data = undefined;
		read.isError = false;
		read.calls = [];
	});

	// A large swap prices at the tier of the coverage it leaves behind, which can be
	// dearer than currentSpreadPpm; quoteGoldOut applies that rule, so its spread wins.
	it('returns the spread quoteGoldOut reports for this amount', () => {
		read.data = [5n * 10n ** 17n, 3_000n];
		const { result } = renderHook(() => useReserveSwapSpread(11155111, TOKEN, 1_000n * E18));
		expect(result.current).toEqual({ spreadPpm: 3_000n, status: 'quoted' });
		expect(read.calls.at(-1)?.args).toEqual([TOKEN, 1_000n * E18]);
	});

	// (0, 0) is the contract's answer for an unsupported asset or a missing price.
	it('reports no quote when the quoted spread is zero', () => {
		read.data = [0n, 0n];
		const { result } = renderHook(() => useReserveSwapSpread(11155111, TOKEN, 1_000n * E18));
		expect(result.current).toEqual({ spreadPpm: undefined, status: 'unavailable' });
	});

	it('reports no quote when the read failed', () => {
		read.isError = true;
		const { result } = renderHook(() => useReserveSwapSpread(11155111, TOKEN, 1_000n * E18));
		expect(result.current).toEqual({ spreadPpm: undefined, status: 'unavailable' });
	});

	// Until then the amount has no price: the marginal tier would overstate a large swap.
	it('says it is quoting before the read for this amount lands', () => {
		const { result } = renderHook(() => useReserveSwapSpread(11155111, TOKEN, 1_000n * E18));
		expect(result.current).toEqual({ spreadPpm: undefined, status: 'quoting' });
	});

	it('does not read while nothing is typed', () => {
		read.data = [5n * 10n ** 17n, 3_000n];
		const zero = renderHook(() => useReserveSwapSpread(11155111, TOKEN, 0n));
		const empty = renderHook(() => useReserveSwapSpread(11155111, TOKEN, undefined));
		expect(zero.result.current).toEqual({ spreadPpm: undefined, status: 'idle' });
		expect(empty.result.current).toEqual({ spreadPpm: undefined, status: 'idle' });
		expect(read.calls.every(call => call.query?.enabled === false)).toBe(true);
	});

	it('does not read without a token', () => {
		read.data = [5n * 10n ** 17n, 3_000n];
		const { result } = renderHook(() => useReserveSwapSpread(11155111, undefined, 1_000n * E18));
		expect(result.current).toEqual({ spreadPpm: undefined, status: 'idle' });
		expect(read.calls.at(-1)?.query?.enabled).toBe(false);
	});
});
