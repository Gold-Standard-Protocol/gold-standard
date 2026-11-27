import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { encodeAbiParameters, encodeEventTopics, type Log } from 'viem';
import type { ReactNode } from 'react';
import { stabilityPoolAbi as realStabilityPoolAbi } from '@goldstandard/constants';
import { useStabilityPoolClaim, useStabilityPoolDeposit, useStabilityPoolWithdraw } from './useStabilityPoolActions';

const E18 = 10n ** 18n;

const wagmi = vi.hoisted(() => ({
	simulate: { data: undefined as { request: unknown } | undefined, isPlaceholderData: false, isSuccess: false, isError: false, error: null as Error | null },
	simulateBlockTags: [] as unknown[],
	receiptLogs: undefined as Log[] | undefined,
	writeContract: vi.fn(),
	reset: vi.fn(),
}));

vi.mock('wagmi', () => ({
	useSimulateContract: (params: { blockTag?: unknown }) => {
		wagmi.simulateBlockTags.push(params.blockTag);
		return wagmi.simulate;
	},
	useWriteContract: () => ({ writeContract: wagmi.writeContract, data: undefined, isPending: false, error: null, reset: wagmi.reset }),
	useWaitForTransactionReceipt: () => ({ status: 'pending', data: wagmi.receiptLogs ? { logs: wagmi.receiptLogs } : undefined }),
	useAccount: () => ({ address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }),
	useChainId: () => 11155111,
	// Read by the Safe proposal follow, which is idle for a wallet that sends transactions.
	usePublicClient: () => undefined,
}));

vi.mock('@goldstandard/constants', async (importOriginal) => ({
	stabilityPoolAbi: (await importOriginal<typeof import('@goldstandard/constants')>()).stabilityPoolAbi,
	getStabilityPoolContractConfig: () => ({ address: '0x00000000000000000000000000000000000000ee', abi: [] }),
}));

const wrapper = ({ children }: { children: ReactNode }) => (
	<QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>
);

describe('stability pool action hooks', () => {
	beforeEach(() => {
		wagmi.simulate = { data: undefined, isPlaceholderData: false, isSuccess: false, isError: false, error: null };
		wagmi.simulateBlockTags = [];
		wagmi.receiptLogs = undefined;
		wagmi.writeContract.mockClear();
	});

	it('simulates a withdrawal in the pending block, where the deposit-block refusal no longer applies', () => {
		renderHook(() => useStabilityPoolWithdraw(11155111, '5'), { wrapper });
		expect(wagmi.simulateBlockTags).toEqual(['pending']);
	});

	it('simulates a claim in the pending block, where the deposit-block refusal no longer applies', () => {
		renderHook(() => useStabilityPoolClaim(11155111, '0x00000000000000000000000000000000000000c1', true), { wrapper });
		expect(wagmi.simulateBlockTags).toEqual(['pending']);
	});

	it('leaves the deposit simulation on the latest block', () => {
		renderHook(() => useStabilityPoolDeposit(11155111, '5'), { wrapper });
		expect(wagmi.simulateBlockTags).toEqual([undefined]);
	});

	it('signs a withdrawal only for the amount typed now', () => {
		wagmi.simulate = { data: { request: { args: [5n * E18] } }, isPlaceholderData: false, isSuccess: true, isError: false, error: null };
		const matching = renderHook(() => useStabilityPoolWithdraw(11155111, '5'), { wrapper });
		expect(matching.result.current.write).toBeDefined();
		matching.result.current.write?.({});
		expect(wagmi.writeContract).toHaveBeenCalledWith({ args: [5n * E18] }, {});

		const stale = renderHook(() => useStabilityPoolWithdraw(11155111, '6'), { wrapper });
		expect(stale.result.current.write).toBeUndefined();
	});

	it('exposes the amount the pool emitted, which is below the amount asked for when it capped the withdrawal', () => {
		const returned = 300n * E18;
		wagmi.receiptLogs = [
			{
				address: '0x00000000000000000000000000000000000000ee',
				topics: encodeEventTopics({ abi: realStabilityPoolAbi, eventName: 'Withdrawn', args: { user: '0x00000000000000000000000000000000000000aa' } }),
				data: encodeAbiParameters([{ type: 'uint256' }], [returned]),
				blockHash: '0x01',
				blockNumber: 1n,
				logIndex: 0,
				transactionHash: '0x02',
				transactionIndex: 0,
				removed: false,
			} as Log,
		];
		const { result } = renderHook(() => useStabilityPoolWithdraw(11155111, '500'), { wrapper });
		expect(result.current.withdrawnAmount).toBe(returned);
	});

	it('has no withdrawn amount until a receipt carries the event', () => {
		const { result } = renderHook(() => useStabilityPoolWithdraw(11155111, '500'), { wrapper });
		expect(result.current.withdrawnAmount).toBeUndefined();
	});

	it('exposes the gold the pool paid on a claim, which is below the gain when the pool held less', () => {
		const paid = 250_000n;
		const token = '0x00000000000000000000000000000000000000c1';
		wagmi.receiptLogs = [
			{
				address: '0x00000000000000000000000000000000000000ee',
				topics: encodeEventTopics({
					abi: realStabilityPoolAbi,
					eventName: 'CollateralClaimed',
					args: { user: '0x00000000000000000000000000000000000000aa', token },
				}),
				data: encodeAbiParameters([{ type: 'uint256' }], [paid]),
				blockHash: '0x01',
				blockNumber: 1n,
				logIndex: 0,
				transactionHash: '0x02',
				transactionIndex: 0,
				removed: false,
			} as Log,
		];
		const { result } = renderHook(() => useStabilityPoolClaim(11155111, token, true), { wrapper });
		expect(result.current.claimedAmount).toBe(paid);
	});

	it('has no claimed amount until a receipt carries the event', () => {
		const { result } = renderHook(() => useStabilityPoolClaim(11155111, '0x00000000000000000000000000000000000000c1', true), { wrapper });
		expect(result.current.claimedAmount).toBeUndefined();
	});
});
