import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useVaultDeposit, useVaultMint, useVaultRepay, useVaultWithdraw } from './useVaultActions';

const E18 = 10n ** 18n;
const TOKEN = '0x0000000000000000000000000000000000000001' as const;

/** What the mocked wagmi reports; each test sets the shape it needs before rendering. */
const wagmi = vi.hoisted(() => ({
	simulate: { data: undefined as { request: unknown } | undefined, isPlaceholderData: false, isSuccess: false, isError: false, error: null as Error | null },
	simulateArgs: [] as unknown[],
	simulateBlockTags: [] as unknown[],
	writeContract: vi.fn(),
	reset: vi.fn(),
	account: { address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
	chainId: 11155111,
}));

vi.mock('wagmi', () => ({
	useSimulateContract: (params: { args?: unknown; blockTag?: unknown }) => {
		wagmi.simulateArgs.push(params.args);
		wagmi.simulateBlockTags.push(params.blockTag);
		return wagmi.simulate;
	},
	useWriteContract: () => ({ writeContract: wagmi.writeContract, data: undefined, isPending: false, error: null, reset: wagmi.reset }),
	useWaitForTransactionReceipt: () => ({ status: 'pending', data: undefined }),
	useAccount: () => wagmi.account,
	useChainId: () => wagmi.chainId,
	// Read by the Safe proposal follow, which is idle for a wallet that sends transactions.
	usePublicClient: () => undefined,
}));

vi.mock('@goldstandard/constants', () => ({
	getGoldVaultContractConfig: () => ({ address: '0x00000000000000000000000000000000000000ff', abi: [] }),
}));

const wrapper = ({ children }: { children: ReactNode }) => (
	<QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>
);

describe('vault action hooks: what may be signed', () => {
	beforeEach(() => {
		wagmi.simulate = { data: undefined, isPlaceholderData: false, isSuccess: false, isError: false, error: null };
		wagmi.simulateArgs = [];
		wagmi.simulateBlockTags = [];
		wagmi.writeContract.mockClear();
		wagmi.reset.mockClear();
		wagmi.account = { address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' };
	});
	afterEach(() => vi.restoreAllMocks());

	it('signs the settled request for the amount typed now', () => {
		wagmi.simulate = { data: { request: { args: [50n * E18] } }, isPlaceholderData: false, isSuccess: true, isError: false, error: null };
		const { result } = renderHook(() => useVaultMint(11155111, '50'), { wrapper });
		expect(result.current.write).toBeDefined();
		result.current.write?.({});
		expect(wagmi.writeContract).toHaveBeenCalledWith({ args: [50n * E18] }, {});
	});

	it('judges the ratio checks in the inclusion block, not the latest one', () => {
		renderHook(() => useVaultMint(11155111, '50'), { wrapper });
		renderHook(() => useVaultWithdraw(11155111, '1', 18), { wrapper });
		expect(wagmi.simulateBlockTags).toEqual(['pending', 'pending']);
	});

	// The remaining-debt floor moves with every second of fees.
	it('judges a repayment in the inclusion block too', () => {
		renderHook(() => useVaultRepay(11155111, '50'), { wrapper });
		expect(wagmi.simulateBlockTags).toEqual(['pending']);
	});

	it('refuses to sign while the simulation for the new amount is still a placeholder of the old one', () => {
		// Typed 5000, then 50: the query key changed, the 5000 request is kept as placeholder data.
		wagmi.simulate = { data: { request: { args: [5000n * E18] } }, isPlaceholderData: true, isSuccess: true, isError: false, error: null };
		const { result } = renderHook(() => useVaultMint(11155111, '50'), { wrapper });
		expect(result.current.write).toBeUndefined();
		expect(result.current.isSimulationError).toBe(false);
	});

	it('refuses settled data whose arguments do not match the parsed inputs', () => {
		wagmi.simulate = { data: { request: { args: [TOKEN, 1n * E18] } }, isPlaceholderData: false, isSuccess: true, isError: false, error: null };
		const { result } = renderHook(() => useVaultDeposit(11155111, TOKEN, '2', 18), { wrapper });
		expect(result.current.write).toBeUndefined();
	});

	it('passes the token decimals into the arguments and refuses excess decimals', () => {
		renderHook(() => useVaultDeposit(11155111, TOKEN, '0.000001', 6), { wrapper });
		expect(wagmi.simulateArgs[0]).toEqual([TOKEN, 1n]);
		wagmi.simulateArgs = [];
		renderHook(() => useVaultDeposit(11155111, TOKEN, '0.0000005', 6), { wrapper });
		expect(wagmi.simulateArgs[0]).toBeUndefined();
	});

	it('exposes reset and resets the mutation when the connected account changes', () => {
		const { rerender } = renderHook(() => useVaultMint(11155111, '50'), { wrapper });
		expect(wagmi.reset).not.toHaveBeenCalled();
		wagmi.account = { address: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' };
		rerender();
		expect(wagmi.reset).toHaveBeenCalledTimes(1);
	});

	it('never signs a previous account placeholder after a switch', () => {
		wagmi.simulate = { data: { request: { args: [50n * E18] } }, isPlaceholderData: false, isSuccess: true, isError: false, error: null };
		const { result, rerender } = renderHook(() => useVaultMint(11155111, '50'), { wrapper });
		expect(result.current.write).toBeDefined();
		// The new account's simulation key differs, so wagmi serves the old request as a placeholder.
		wagmi.account = { address: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' };
		wagmi.simulate = { ...wagmi.simulate, isPlaceholderData: true };
		rerender();
		expect(result.current.write).toBeUndefined();
	});
});
