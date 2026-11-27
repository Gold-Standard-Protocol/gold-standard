import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpRequestError, UserRejectedRequestError } from 'viem';
import { CurrencyAmount, Token } from '@goldstandard/models';
import { ApprovalState, useTokenApproval } from './useTokenApproval';
import { cancelConfirmationRefreshes } from '../tx/refreshScheduler';
import { REFRESH_DELAYS_MS } from '../tx/scheduleRefreshes';
import { retrySimulationFailure } from '../tx/simulateQuery';

const HASH = '0x1111111111111111111111111111111111111111111111111111111111111111' as const;
const SPENDER = '0x00000000000000000000000000000000000000ee' as const;

const token = new Token({
	chainId: 11155111,
	address: '0x00000000000000000000000000000000000000bb',
	decimals: 18,
	image: '',
	gold: false,
	priceApiId: '',
	symbol: 'GSUSD',
});
const amount = CurrencyAmount.fromRawAmount(token, (10n ** 18n).toString());
const otherToken = new Token({
	chainId: 11155111,
	address: '0x00000000000000000000000000000000000000dd',
	decimals: 18,
	image: '',
	gold: true,
	priceApiId: '',
	symbol: 'PAXG',
});

interface MutationCallbacks {
	onSuccess: (hash: typeof HASH) => Promise<void>;
	onError: (error: Error) => void;
}

const ACCOUNT = '0x00000000000000000000000000000000000000aa' as const;

const wagmi = vi.hoisted(() => ({
	writeContract: vi.fn(),
	isPending: false,
	mutation: undefined as MutationCallbacks | undefined,
	receiptStatus: 'success' as 'success' | 'reverted',
	account: { address: '0x00000000000000000000000000000000000000aa' } as { address: string; connector?: { type: string } },
	waitForTransactionReceipt: vi.fn(),
	/** The query options each render gave the approve simulation. */
	simulations: [] as { enabled?: boolean; retry?: unknown }[],
}));

/** The Safe proposal the hook follows, and what the Safe says became of it. */
const safe = vi.hoisted(() => ({
	followed: [] as (string | undefined)[],
	execution: undefined as { failed: boolean } | undefined,
}));

const reads = vi.hoisted(() => ({
	refetch: vi.fn(async () => undefined),
	invalidateQueries: vi.fn(async () => undefined),
	/** The allowance the chain reports, in wei. */
	allowance: '0',
	/** The `pollWhileBelow` each render asked the allowance read for. */
	polls: [] as (bigint | undefined)[],
	/** The allowance read failed and holds no earlier answer. */
	failed: false,
}));

vi.mock('wagmi', () => ({
	useAccount: () => wagmi.account,
	useChainId: () => 11155111,
	usePublicClient: () => ({ waitForTransactionReceipt: wagmi.waitForTransactionReceipt }),
	useSimulateContract: ({ query }: { query: { enabled?: boolean; retry?: unknown } }) => {
		wagmi.simulations.push(query);
		return { data: { request: { functionName: 'approve' } }, isLoading: false };
	},
	useWriteContract: ({ mutation }: { mutation: MutationCallbacks }) => {
		wagmi.mutation = mutation;
		return { writeContract: wagmi.writeContract, isPending: wagmi.isPending };
	},
}));

vi.mock('@tanstack/react-query', () => ({
	useQueryClient: () => ({ invalidateQueries: reads.invalidateQueries }),
}));

vi.mock('./useTokenAllowance', () => ({
	useTokenAllowance: ({ token: asked, pollWhileBelow }: { token: Token; pollWhileBelow?: bigint }) => {
		reads.polls.push(pollWhileBelow);
		return {
			data: reads.failed ? undefined : CurrencyAmount.fromRawAmount(asked, reads.allowance),
			isLoading: false,
			isError: reads.failed,
			refetch: reads.refetch,
		};
	},
}));

vi.mock('../tx/useSafeProposal', () => ({
	useSafeProposal: ({ safeTxHash }: { safeTxHash: string | undefined }) => {
		safe.followed.push(safeTxHash);
		return safeTxHash ? safe.execution : undefined;
	},
}));

interface GuardProps {
	amount: CurrencyAmount<Token>;
	spender: `0x${string}`;
	approveMax?: boolean;
}

const renderWith = (initialProps: GuardProps) => renderHook((props: GuardProps) => useTokenApproval(props), { initialProps });
const render = () => renderWith({ amount, spender: SPENDER });
const resetReads = () => {
	reads.refetch.mockClear();
	reads.invalidateQueries.mockClear();
	reads.allowance = '0';
	reads.polls = [];
	reads.failed = false;
	wagmi.simulations = [];
	cancelConfirmationRefreshes();
};

/**
 * Every invalidation since the last reset was scoped to what a transaction can change: the
 * allowance and the action's simulation are refreshed, the price feed and token list are not.
 */
const expectScopedRefreshes = () => {
	expect(reads.invalidateQueries.mock.calls.length).toBeGreaterThan(0);
	for (const [filters] of reads.invalidateQueries.mock.calls as unknown as [{ predicate?: (query: { queryKey: unknown[] }) => boolean }?][]) {
		const predicate = filters?.predicate;
		expect(predicate).toBeTypeOf('function');
		expect(predicate?.({ queryKey: ['readContract', { functionName: 'allowance' }] })).toBe(true);
		expect(predicate?.({ queryKey: ['simulateContract', { functionName: 'deposit' }] })).toBe(true);
		expect(predicate?.({ queryKey: [['prices', 'get'], { type: 'query' }] })).toBe(false);
		expect(predicate?.({ queryKey: ['token', '0xbb'] })).toBe(false);
	}
};

describe('useTokenApproval', () => {
	beforeEach(() => {
		wagmi.writeContract.mockClear();
		wagmi.isPending = false;
		wagmi.receiptStatus = 'success';
		wagmi.account = { address: ACCOUNT };
		wagmi.waitForTransactionReceipt.mockReset();
		wagmi.waitForTransactionReceipt.mockImplementation(async () => ({ status: wagmi.receiptStatus }));
		safe.followed = [];
		safe.execution = undefined;
		resetReads();
	});

	// A second click while the first wallet prompt was still open queued a second approve.
	it('ignores a second click before the wallet has answered the first', () => {
		const { result } = render();
		act(() => {
			result.current.approve?.();
			result.current.approve?.();
		});
		expect(wagmi.writeContract).toHaveBeenCalledTimes(1);
	});

	it('reports the wallet wait so the button can show it is busy', () => {
		wagmi.isPending = true;
		const { result } = render();
		expect(result.current.isAwaitingWallet).toBe(true);
		expect(result.current.state).toBe(ApprovalState.NOT_APPROVED);
	});

	// viem's waitForTransactionReceipt does not throw for a reverted receipt, so the
	// button used to drop back to "Approve" with no word on what happened.
	it('reports an approval that reverted on chain', async () => {
		wagmi.receiptStatus = 'reverted';
		const { result } = render();
		await act(async () => {
			await wagmi.mutation?.onSuccess(HASH);
		});
		expect(result.current.failure).toEqual({ kind: 'reverted' });
	});

	it('reports no failure after an approval that confirmed', async () => {
		const { result } = render();
		await act(async () => {
			await wagmi.mutation?.onSuccess(HASH);
		});
		expect(result.current.failure).toBeUndefined();
	});

	it('surfaces a wallet or RPC failure rather than only logging it', () => {
		const { result } = render();
		const error = new Error('RPC unavailable');
		act(() => wagmi.mutation?.onError(error));
		expect(result.current.failure).toEqual({ kind: 'error', error });
	});

	it('stays quiet when the user rejects the request', () => {
		const { result } = render();
		act(() => wagmi.mutation?.onError(new UserRejectedRequestError(new Error('rejected'))));
		expect(result.current.failure).toBeUndefined();
	});

	it('follows no proposal for a wallet that sends transactions', async () => {
		const { result } = render();
		await act(async () => {
			await wagmi.mutation?.onSuccess(HASH);
		});
		expect(wagmi.waitForTransactionReceipt).toHaveBeenCalledWith({ hash: HASH, timeout: 0 });
		expect(result.current.isProposed).toBe(false);
		expect(safe.followed.every(hash => hash === undefined)).toBe(true);
	});

	// A confirmed approval invalidated every cached query, so the
	// vault history scan, the price feed and the token list all refetched for an allowance.
	it('refreshes only the reads a transaction can change once the approval confirms', async () => {
		render();
		await act(async () => {
			await wagmi.mutation?.onSuccess(HASH);
		});
		expect(reads.refetch).toHaveBeenCalledTimes(1);
		expect(reads.invalidateQueries).toHaveBeenCalledTimes(1);
		expectScopedRefreshes();
	});

	// A simulation that reverts is no longer retried (retrySimulationFailure), so a node still
	// behind the approval must not have the last word on the action's simulation.
	it('re-reads them over the following seconds, as after any confirmation', async () => {
		vi.useFakeTimers();
		try {
			render();
			await act(async () => {
				await wagmi.mutation?.onSuccess(HASH);
			});
			expect(reads.invalidateQueries).toHaveBeenCalledTimes(1);
			act(() => {
				vi.advanceTimersByTime(Math.max(...REFRESH_DELAYS_MS));
			});
			expect(reads.invalidateQueries).toHaveBeenCalledTimes(REFRESH_DELAYS_MS.length);
			expectScopedRefreshes();
		} finally {
			vi.useRealTimers();
		}
	});

	it('simulates an approval only while the allowance is short of the amount', () => {
		const { rerender } = render();
		expect(wagmi.simulations.at(-1)?.enabled).toBe(true);
		reads.allowance = (10n ** 18n).toString();
		rerender({ amount, spender: SPENDER });
		expect(wagmi.simulations.at(-1)?.enabled).toBe(false);
	});

	it('does not retry an approve simulation the token refused', () => {
		render();
		expect(wagmi.simulations.at(-1)?.retry).toBe(retrySimulationFailure);
	});

	it('leaves the allowance read without a timer and the other reads alone when an allowance arrives', () => {
		const { rerender } = render();
		expect(reads.polls.every(poll => poll === undefined)).toBe(true);
		reads.allowance = (10n ** 18n).toString();
		rerender({ amount, spender: SPENDER });
		expect(reads.invalidateQueries).not.toHaveBeenCalled();
	});

	// Viem's own wait gives up after 180 seconds. An approval sent at a
	// low fee during a gas spike then showed an error under a live Approve button while it was
	// still in the mempool, and nothing read the allowance again once it was mined.
	describe('while a sent approval is awaited', () => {
		it('waits for the receipt with no deadline, as every other wait in the dapp does', async () => {
			render();
			await act(async () => {
				await wagmi.mutation?.onSuccess(HASH);
			});
			expect(wagmi.waitForTransactionReceipt).toHaveBeenCalledWith({ hash: HASH, timeout: 0 });
		});

		it('reads the allowance on a timer while the receipt is awaited, and stops once it arrives', async () => {
			let mined: (receipt: { status: 'success' }) => void = () => undefined;
			wagmi.waitForTransactionReceipt.mockImplementation(
				() =>
					new Promise(resolve => {
						mined = resolve;
					})
			);
			const { result } = render();
			let sent: Promise<void> | undefined;
			act(() => {
				sent = wagmi.mutation?.onSuccess(HASH);
			});
			expect(result.current.state).toBe(ApprovalState.PENDING);
			expect(reads.polls.at(-1)).toBe(10n ** 18n);
			await act(async () => {
				mined({ status: 'success' });
				await sent;
			});
			expect(reads.polls.at(-1)).toBeUndefined();
		});

		it('says a sent approval is unconfirmed, not failed, when the chain cannot be read', async () => {
			wagmi.waitForTransactionReceipt.mockRejectedValue(new HttpRequestError({ url: 'https://rpc.example' }));
			const { result } = render();
			await act(async () => {
				await wagmi.mutation?.onSuccess(HASH);
			});
			expect(result.current.failure).toEqual({ kind: 'unconfirmed' });
		});

		it('keeps reading the allowance after a failed wait, and refreshes the other reads when it lands', async () => {
			wagmi.waitForTransactionReceipt.mockRejectedValue(new HttpRequestError({ url: 'https://rpc.example' }));
			const { result, rerender } = render();
			await act(async () => {
				await wagmi.mutation?.onSuccess(HASH);
			});
			expect(reads.polls.at(-1)).toBe(10n ** 18n);
			reads.allowance = (10n ** 18n).toString();
			rerender({ amount, spender: SPENDER });
			expect(result.current.state).toBe(ApprovalState.APPROVED);
			expect(reads.invalidateQueries).toHaveBeenCalledTimes(1);
			expectScopedRefreshes();
			// The timer stops, and the unconfirmed line is not kept for a later, larger amount.
			expect(reads.polls.at(-1)).toBeUndefined();
			expect(result.current.failure).toBeUndefined();
		});

		// An exact approval that landed under a raised amount kept "check your wallet before
		// approving again" under the new Approve, and the allowance read on its timer.
		it('stops awaiting an exact approval that lands after the amount was raised', async () => {
			wagmi.waitForTransactionReceipt.mockRejectedValue(new HttpRequestError({ url: 'https://rpc.example' }));
			const { result, rerender } = render();
			act(() => {
				result.current.approve?.();
			});
			await act(async () => {
				await wagmi.mutation?.onSuccess(HASH);
			});
			const raised = CurrencyAmount.fromRawAmount(token, (2n * 10n ** 18n).toString());
			rerender({ amount: raised, spender: SPENDER });
			expect(result.current.failure).toEqual({ kind: 'unconfirmed' });
			reads.allowance = (10n ** 18n).toString();
			rerender({ amount: raised, spender: SPENDER });
			expect(result.current.state).toBe(ApprovalState.NOT_APPROVED);
			expect(result.current.failure).toBeUndefined();
			expect(reads.polls.at(-1)).toBeUndefined();
		});

		it('keeps awaiting while the allowance is still short of the exact approval sent', async () => {
			wagmi.waitForTransactionReceipt.mockRejectedValue(new HttpRequestError({ url: 'https://rpc.example' }));
			const raised = CurrencyAmount.fromRawAmount(token, (2n * 10n ** 18n).toString());
			const { result, rerender } = renderWith({ amount: raised, spender: SPENDER });
			act(() => {
				result.current.approve?.();
			});
			await act(async () => {
				await wagmi.mutation?.onSuccess(HASH);
			});
			reads.allowance = (10n ** 18n).toString();
			rerender({ amount: raised, spender: SPENDER });
			expect(result.current.failure).toEqual({ kind: 'unconfirmed' });
			expect(reads.polls.at(-1)).toBe(2n * 10n ** 18n);
		});

		// The line told another account, which sent nothing, to check its wallet before
		// approving, and nothing could clear it once the switch stopped the await.
		it('drops the unconfirmed line when the account changes', async () => {
			wagmi.waitForTransactionReceipt.mockRejectedValue(new HttpRequestError({ url: 'https://rpc.example' }));
			const { result, rerender } = render();
			await act(async () => {
				await wagmi.mutation?.onSuccess(HASH);
			});
			expect(result.current.failure).toEqual({ kind: 'unconfirmed' });
			wagmi.account = { address: '0x00000000000000000000000000000000000000ee' };
			rerender({ amount, spender: SPENDER });
			expect(result.current.failure).toBeUndefined();
			expect(reads.polls.at(-1)).toBeUndefined();
		});
	});

	// A failed allowance read left the approve simulation off and "Approve GSUSD" dead with no reason.
	it('reports an allowance it could not read', () => {
		reads.failed = true;
		const { result } = render();
		expect(result.current.isAllowanceUnread).toBe(true);
		reads.failed = false;
		const { result: read } = render();
		expect(read.current.isAllowanceUnread).toBe(false);
	});
});

// Inside Safe{Wallet} the wallet answers with a safeTxHash. Waiting on
// it ran into viem's 180 seconds and showed a failure under a live Approve button, for an
// approval the owners had simply not signed yet.
describe('useTokenApproval inside Safe{Wallet}', () => {
	beforeEach(() => {
		wagmi.writeContract.mockClear();
		wagmi.isPending = false;
		wagmi.account = { address: ACCOUNT, connector: { type: 'safe' } };
		wagmi.waitForTransactionReceipt.mockReset();
		safe.followed = [];
		safe.execution = undefined;
		resetReads();
	});

	/** Presses Approve and lets the Safe answer with the hash of its proposal. */
	const propose = async (props: GuardProps = { amount, spender: SPENDER }) => {
		const view = renderWith(props);
		act(() => view.result.current.approve?.());
		await act(async () => {
			await wagmi.mutation?.onSuccess(HASH);
		});
		return view;
	};
	const of = (asked: Token, wei: bigint) => CurrencyAmount.fromRawAmount(asked, wei.toString());

	it('records a proposal and never waits on a hash no chain node knows', async () => {
		const { result } = await propose();
		expect(wagmi.waitForTransactionReceipt).not.toHaveBeenCalled();
		expect(result.current.isProposed).toBe(true);
		expect(result.current.failure).toBeUndefined();
		expect(safe.followed.at(-1)).toBe(HASH);
	});

	// Owners can take days: a button held busy for that long could never propose again.
	it('leaves the button live while the proposal is outstanding', async () => {
		const { result } = await propose();
		expect(result.current.state).toBe(ApprovalState.NOT_APPROVED);
		expect(result.current.approve).toBeTypeOf('function');
	});

	it('reads the allowance again once the Safe has executed the approval', async () => {
		const { result, rerender } = await propose();
		expect(reads.refetch).not.toHaveBeenCalled();
		safe.execution = { failed: false };
		rerender({ amount, spender: SPENDER });
		await waitFor(() => expect(reads.invalidateQueries).toHaveBeenCalledTimes(1));
		expectScopedRefreshes();
		expect(reads.refetch).toHaveBeenCalledTimes(1);
		expect(result.current.isProposed).toBe(false);
		expect(result.current.failure).toBeUndefined();
	});

	it('reports an approval the Safe executed and that failed', async () => {
		const { result, rerender } = await propose();
		safe.execution = { failed: true };
		rerender({ amount, spender: SPENDER });
		await waitFor(() => expect(result.current.failure).toEqual({ kind: 'reverted' }));
		expect(result.current.isProposed).toBe(false);
	});

	// One guard serves a form whose token and amount change: the notice must describe the
	// approval the Safe was actually asked for, which can sit unsigned for days.
	it('says nothing is proposed for another token or another spender', async () => {
		const { result, rerender } = await propose();
		rerender({ amount: of(otherToken, 10n ** 18n), spender: SPENDER });
		expect(result.current.isProposed).toBe(false);
		rerender({ amount, spender: '0x00000000000000000000000000000000000000ff' });
		expect(result.current.isProposed).toBe(false);
		rerender({ amount, spender: SPENDER });
		expect(result.current.isProposed).toBe(true);
		// The proposal is still followed while the form shows something else.
		expect(safe.followed.at(-1)).toBe(HASH);
	});

	it('says nothing is proposed for more than an exact approval covers', async () => {
		const { result, rerender } = await propose({ amount, spender: SPENDER, approveMax: false });
		rerender({ amount: of(token, 2n * 10n ** 18n), spender: SPENDER, approveMax: false });
		expect(result.current.isProposed).toBe(false);
		rerender({ amount: of(token, 10n ** 17n), spender: SPENDER, approveMax: false });
		expect(result.current.isProposed).toBe(true);
	});

	it('counts an unlimited proposal for any amount of that token', async () => {
		const { result, rerender } = await propose({ amount, spender: SPENDER, approveMax: true });
		rerender({ amount: of(token, 500n * 10n ** 18n), spender: SPENDER, approveMax: true });
		expect(result.current.isProposed).toBe(true);
	});

	// A form left and reopened follows no proposal, and one made in Safe{Wallet} itself never
	// did: the allowance is read on a slow timer for as long as it is short of the amount.
	it('reads the allowance on a timer while it is short of the amount', () => {
		render();
		expect(reads.polls.at(-1)).toBe(10n ** 18n);
	});

	it('refreshes the other reads when an allowance arrives that no proposal was followed for', () => {
		const { rerender } = render();
		expect(reads.invalidateQueries).not.toHaveBeenCalled();
		reads.allowance = (10n ** 18n).toString();
		rerender({ amount, spender: SPENDER });
		expect(reads.invalidateQueries).toHaveBeenCalledTimes(1);
		// Not again for the same allowance, nor for another token coming into view.
		rerender({ amount, spender: SPENDER });
		rerender({ amount: of(otherToken, 10n ** 18n), spender: SPENDER });
		expect(reads.invalidateQueries).toHaveBeenCalledTimes(1);
		expectScopedRefreshes();
	});

	it('drops the proposal when the account changes', async () => {
		const { result, rerender } = await propose();
		wagmi.account = { address: '0x00000000000000000000000000000000000000cc', connector: { type: 'safe' } };
		rerender({ amount, spender: SPENDER });
		await waitFor(() => expect(result.current.isProposed).toBe(false));
		expect(safe.followed.at(-1)).toBeUndefined();
	});
});
