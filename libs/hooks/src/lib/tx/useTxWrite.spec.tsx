import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import {
	BaseError,
	CallExecutionError,
	HttpRequestError,
	InternalRpcError,
	LimitExceededRpcError,
	RpcRequestError,
	TimeoutError,
	UnknownRpcError,
	type ReplacementReason,
	type ReplacementReturnType,
} from 'viem';
import { confirmationStatusOf, isChainReadFailure, proposalStatusOf, retryChainReadFailure, useTxWrite } from './useTxWrite';
import type { SafeExecution } from './safeProposal';

const HASH = '0x1111111111111111111111111111111111111111111111111111111111111111' as const;
const CHAIN_HASH = '0x2222222222222222222222222222222222222222222222222222222222222222' as const;
const BLOCK_HASH = '0x3333333333333333333333333333333333333333333333333333333333333333' as const;
const SAFE = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as const;

interface TestConnector {
	type: string;
	getProvider: () => Promise<unknown>;
}

const wagmi = vi.hoisted(() => ({
	txHash: undefined as string | undefined,
	waitedHashes: [] as (string | undefined)[],
	waitedRetries: [] as unknown[],
	onReplaced: [] as (((replacement: ReplacementReturnType) => void) | undefined)[],
	reset: vi.fn(),
	wait: { status: 'pending', error: null, failureReason: null } as {
		status: 'error' | 'pending' | 'success';
		error: Error | null;
		failureReason: Error | null;
	},
	account: { address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' } as { address: string | undefined; connector?: TestConnector },
	chainId: 11155111,
	getTransaction: vi.fn(),
}));

/** Every status the hook hands the confirmation refresh, in order. */
const refresh = vi.hoisted(() => ({ statuses: [] as (string | undefined)[] }));

vi.mock('wagmi', () => ({
	useWriteContract: () => ({
		writeContract: vi.fn(),
		data: wagmi.txHash,
		isPending: false,
		error: null,
		reset: wagmi.reset,
	}),
	useWaitForTransactionReceipt: ({
		hash,
		query,
		onReplaced,
	}: {
		hash?: string;
		query?: { retry?: unknown };
		onReplaced?: (replacement: ReplacementReturnType) => void;
	}) => {
		wagmi.waitedHashes.push(hash);
		wagmi.waitedRetries.push(query?.retry);
		wagmi.onReplaced.push(onReplaced);
		return { ...wagmi.wait, data: undefined };
	},
	useAccount: () => wagmi.account,
	useChainId: () => wagmi.chainId,
	usePublicClient: () => ({ getTransaction: wagmi.getTransaction }),
}));

// The refresh has its own specs (refreshLifecycle); here only the status it is given matters.
vi.mock('./useRefreshOnConfirmation', () => ({
	useRefreshOnConfirmation: (status: string | undefined) => {
		refresh.statuses.push(status);
	},
}));

// One client per test: the Safe proposal is a query, and its answer must survive a rerender.
let queryClient: QueryClient;
const wrapper = ({ children }: { children: ReactNode }) => (
	<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
);

beforeEach(() => {
	queryClient = new QueryClient({ defaultOptions: { queries: { retryDelay: 1 } } });
	refresh.statuses = [];
});

afterEach(() => {
	queryClient.clear();
});

describe('useTxWrite', () => {
	beforeEach(() => {
		wagmi.txHash = undefined;
		wagmi.waitedHashes = [];
		wagmi.waitedRetries = [];
		wagmi.reset.mockClear();
		wagmi.wait = { status: 'pending', error: null, failureReason: null };
		wagmi.account = { address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' };
	});

	it('keeps following the last hash after the write is reset, so the refresh still sees the confirmation', () => {
		wagmi.txHash = HASH;
		const { rerender } = renderHook(() => useTxWrite(), { wrapper });
		// Closing the receipt while it waits resets the mutation and drops the hash.
		wagmi.txHash = undefined;
		wagmi.waitedHashes = [];
		rerender();
		expect(wagmi.waitedHashes).toContain(HASH);
	});

	it('exposes no hash to the dialogs once the write is reset', () => {
		wagmi.txHash = HASH;
		const { result, rerender } = renderHook(() => useTxWrite(), { wrapper });
		expect(result.current.txHash).toBe(HASH);
		wagmi.txHash = undefined;
		rerender();
		expect(result.current.txHash).toBeUndefined();
	});

	it('stops following a hash from the previous account after a switch', () => {
		wagmi.txHash = HASH;
		const { rerender } = renderHook(() => useTxWrite(), { wrapper });
		wagmi.txHash = undefined;
		wagmi.account = { address: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' };
		rerender();
		wagmi.waitedHashes = [];
		rerender();
		expect(wagmi.reset).toHaveBeenCalledTimes(1);
		expect(wagmi.waitedHashes.every(hash => hash === undefined)).toBe(true);
	});

	// React Query's default of three retries held a mined revert on "Waiting for
	// confirmation" for about seven seconds; a reverted receipt cannot change on retry.
	it('passes the transport-only retry to both receipt waits', () => {
		wagmi.txHash = HASH;
		renderHook(() => useTxWrite(), { wrapper });
		expect(wagmi.waitedRetries.length).toBeGreaterThanOrEqual(2);
		expect(typeof wagmi.waitedRetries[0]).toBe('function');
		expect(wagmi.waitedRetries.every(retry => retry === retryChainReadFailure)).toBe(true);
	});

	// An RPC outage during the wait used to settle as 'error', and the receipt then said the
	// transaction had reverted on-chain when nothing was known about it.
	it('reports a sent transaction as unconfirmed while the chain cannot be read', () => {
		wagmi.txHash = HASH;
		wagmi.wait = { status: 'pending', error: null, failureReason: new HttpRequestError({ url: 'https://rpc.example' }) };
		const { result } = renderHook(() => useTxWrite(), { wrapper });
		expect(result.current.confirmationStatus).toBe('unconfirmed');
	});

	it('still reports a mined revert as an error', () => {
		wagmi.txHash = HASH;
		wagmi.wait = { status: 'error', error: new Error('unknown reason'), failureReason: new Error('unknown reason') };
		const { result } = renderHook(() => useTxWrite(), { wrapper });
		expect(result.current.confirmationStatus).toBe('error');
	});

	// Viem resolves a wait with the receipt of a same-nonce replacement.
	// A cancel is a mined zero-value self-send, so the dialog said "Confirmed" for a mint that
	// never happened, and a speed-up linked Etherscan to the hash the chain dropped.
	describe('a transaction replaced in the wallet', () => {
		/** Tells every wait the hook mounted, as viem would, that `hash` was mined in place of the write. */
		const replace = (reason: ReplacementReason, replaced: string = HASH) => {
			const replacement = {
				reason,
				replacedTransaction: { hash: replaced },
				transaction: { hash: CHAIN_HASH },
				transactionReceipt: { transactionHash: CHAIN_HASH },
			} as unknown as ReplacementReturnType;
			act(() => {
				for (const onReplaced of wagmi.onReplaced) onReplaced?.(replacement);
			});
		};

		beforeEach(() => {
			wagmi.onReplaced = [];
			wagmi.txHash = HASH;
			wagmi.wait = { status: 'success', error: null, failureReason: null };
		});

		it('listens for a replacement on both receipt waits', () => {
			renderHook(() => useTxWrite(), { wrapper });
			expect(wagmi.onReplaced.length).toBeGreaterThanOrEqual(2);
			expect(wagmi.onReplaced.every(onReplaced => typeof onReplaced === 'function')).toBe(true);
		});

		it('reports a cancel as replaced, never as confirmed, and links the mined replacement', () => {
			const { result } = renderHook(() => useTxWrite(), { wrapper });
			replace('cancelled');
			expect(result.current.confirmationStatus).toBe('replaced');
			expect(result.current.txHash).toBe(CHAIN_HASH);
		});

		it('reports a different transaction on the same nonce as replaced', () => {
			const { result } = renderHook(() => useTxWrite(), { wrapper });
			replace('replaced');
			expect(result.current.confirmationStatus).toBe('replaced');
		});

		it('confirms a sped-up transaction under the hash the chain mined', () => {
			const { result } = renderHook(() => useTxWrite(), { wrapper });
			replace('repriced');
			expect(result.current.confirmationStatus).toBe('success');
			expect(result.current.txHash).toBe(CHAIN_HASH);
		});

		it('ignores a replacement of an earlier write', () => {
			const { result } = renderHook(() => useTxWrite(), { wrapper });
			replace('cancelled', BLOCK_HASH);
			expect(result.current.confirmationStatus).toBe('success');
			expect(result.current.txHash).toBe(HASH);
		});
	});
});

/** The receipt the Safe provider answers with once the owners have signed and the proposal has executed. */
const executedReceipt = (status: '0x0' | '0x1' = '0x1') => ({
	// The provider writes the hash it was asked about over the receipt's own.
	transactionHash: HASH,
	blockHash: BLOCK_HASH,
	blockNumber: '0x10',
	transactionIndex: '0x3',
	from: '0x00000000000000000000000000000000000000ee',
	to: SAFE,
	contractAddress: null,
	cumulativeGasUsed: '0x5208',
	gasUsed: '0x5208',
	effectiveGasPrice: '0x1',
	logsBloom: '0x',
	type: '0x2',
	status,
	logs: [],
});

const lookAtTheTabAgain = () => {
	act(() => {
		window.dispatchEvent(new Event('visibilitychange'));
	});
};

// Inside Safe{Wallet} the wallet answers a write with a safeTxHash.
// No chain node knows it, so the receipt waited without end and linked nothing an explorer has.
describe('useTxWrite inside Safe{Wallet}', () => {
	let answer: unknown;
	const request = vi.fn(async () => answer);

	beforeEach(() => {
		answer = null;
		request.mockClear();
		wagmi.txHash = HASH;
		wagmi.waitedHashes = [];
		wagmi.reset.mockClear();
		wagmi.wait = { status: 'pending', error: null, failureReason: null };
		wagmi.getTransaction.mockReset();
		wagmi.getTransaction.mockResolvedValue({ hash: CHAIN_HASH });
		wagmi.account = { address: SAFE, connector: { type: 'safe', getProvider: async () => ({ request }) } };
	});

	it('gives the public receipt waits nothing to poll', () => {
		renderHook(() => useTxWrite(), { wrapper });
		expect(wagmi.waitedHashes.length).toBeGreaterThanOrEqual(2);
		expect(wagmi.waitedHashes.every(hash => hash === undefined)).toBe(true);
	});

	it('reports a proposal, and asks the Safe for its receipt, while the owners have not signed', async () => {
		const { result } = renderHook(() => useTxWrite(), { wrapper });
		await waitFor(() => expect(request).toHaveBeenCalledWith({ method: 'eth_getTransactionReceipt', params: [HASH] }));
		expect(result.current.confirmationStatus).toBe('proposed');
		expect(result.current.txHash).toBe(HASH);
		expect(result.current.receipt).toBeUndefined();
		// 'pending' is what re-arms the refresh for the next proposal.
		expect(refresh.statuses.at(-1)).toBe('pending');
	});

	it('confirms with the hash the chain knows once the Safe has executed the proposal', async () => {
		answer = executedReceipt();
		const { result } = renderHook(() => useTxWrite(), { wrapper });
		await waitFor(() => expect(result.current.confirmationStatus).toBe('success'));
		expect(wagmi.getTransaction).toHaveBeenCalledWith({ blockHash: BLOCK_HASH, index: 3 });
		expect(result.current.txHash).toBe(CHAIN_HASH);
		expect(result.current.receipt?.transactionHash).toBe(CHAIN_HASH);
		expect(refresh.statuses.at(-1)).toBe('success');
	});

	it('asks again when the tab is looked at again', async () => {
		const { result } = renderHook(() => useTxWrite(), { wrapper });
		await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
		answer = executedReceipt();
		lookAtTheTabAgain();
		await waitFor(() => expect(result.current.confirmationStatus).toBe('success'));
	});

	it('asks again on a slow timer while the proposal is outstanding', async () => {
		vi.useFakeTimers();
		try {
			const { result } = renderHook(() => useTxWrite(), { wrapper });
			await act(async () => {
				await vi.advanceTimersByTimeAsync(0);
			});
			expect(request).toHaveBeenCalledTimes(1);
			answer = executedReceipt();
			await act(async () => {
				await vi.advanceTimersByTimeAsync(15_000);
			});
			expect(request).toHaveBeenCalledTimes(2);
			// The answer still has to be placed in its block and handed to the hook.
			await act(async () => {
				await vi.advanceTimersByTimeAsync(10);
			});
			expect(result.current.confirmationStatus).toBe('success');
		} finally {
			vi.useRealTimers();
		}
	});

	// Owners can take days. Closing the receipt resets the write; the proposal is still followed.
	it('keeps following the proposal after the receipt is closed, so the refresh sees the execution', async () => {
		const { result, rerender } = renderHook(() => useTxWrite(), { wrapper });
		await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
		wagmi.txHash = undefined;
		rerender();
		expect(result.current.txHash).toBeUndefined();
		expect(result.current.confirmationStatus).toBe('pending');
		answer = executedReceipt();
		lookAtTheTabAgain();
		await waitFor(() => expect(refresh.statuses.at(-1)).toBe('success'));
		// The closed receipt is not reopened with a hash or a receipt from the old write.
		expect(result.current.txHash).toBeUndefined();
		expect(result.current.receipt).toBeUndefined();
	});

	it('reports an execution that failed as an error, and refreshes nothing', async () => {
		answer = executedReceipt('0x0');
		const { result } = renderHook(() => useTxWrite(), { wrapper });
		await waitFor(() => expect(result.current.confirmationStatus).toBe('error'));
		expect(result.current.txHash).toBe(CHAIN_HASH);
		expect(refresh.statuses).not.toContain('success');
	});

	it('stays a proposal while the Safe cannot be asked', async () => {
		const getProvider = vi.fn(async () => undefined);
		wagmi.account = { address: SAFE, connector: { type: 'safe', getProvider } };
		const { result } = renderHook(() => useTxWrite(), { wrapper });
		await waitFor(() => expect(getProvider).toHaveBeenCalled());
		expect(result.current.confirmationStatus).toBe('proposed');
		expect(result.current.txHash).toBe(HASH);
	});

	// Until the chain hash is known the receipt has nothing an explorer could show.
	it('stays a proposal while the public RPC cannot place the receipt in its block', async () => {
		answer = executedReceipt();
		wagmi.getTransaction.mockRejectedValue(new Error('Transaction not found'));
		const { result } = renderHook(() => useTxWrite(), { wrapper });
		await waitFor(() => expect(wagmi.getTransaction).toHaveBeenCalled());
		expect(result.current.confirmationStatus).toBe('proposed');
		expect(result.current.txHash).toBe(HASH);
	});

	it('stops following a proposal from the previous Safe after a switch', async () => {
		const { rerender } = renderHook(() => useTxWrite(), { wrapper });
		await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
		wagmi.txHash = undefined;
		wagmi.account = { ...wagmi.account, address: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' };
		rerender();
		rerender();
		answer = executedReceipt();
		lookAtTheTabAgain();
		await act(async () => {
			await new Promise(resolve => setTimeout(resolve, 20));
		});
		expect(request).toHaveBeenCalledTimes(1);
		expect(refresh.statuses).not.toContain('success');
	});
});

describe('proposalStatusOf', () => {
	const execution = (failed: boolean) => ({ failed }) as SafeExecution;

	it('is pending with no proposal, as a receipt wait is with no hash', () => {
		expect(proposalStatusOf(undefined, undefined)).toBe('pending');
	});

	it('is proposed until the Safe has executed it', () => {
		expect(proposalStatusOf(HASH, undefined)).toBe('proposed');
	});

	it('passes an execution through', () => {
		expect(proposalStatusOf(HASH, execution(false))).toBe('success');
		expect(proposalStatusOf(HASH, execution(true))).toBe('error');
	});
});

/** The error wagmi rethrows when its replay of a reverted transaction fails, as it usually does. */
const replayOf = (cause: BaseError) => new CallExecutionError(cause, {});
const RPC_URL = 'https://rpc.example';
/** A provider's rate limit as viem reports it from a batch item: a JSON-RPC error, not an HTTP one. */
const rateLimited = new RpcRequestError({ body: {}, url: RPC_URL, error: { code: 429, message: 'Too many requests' } });

describe('retryChainReadFailure', () => {
	const http = new HttpRequestError({ url: RPC_URL });
	const timeout = new TimeoutError({ body: {}, url: RPC_URL });

	it('never retries a reverted receipt, which wagmi reports as a plain Error', () => {
		expect(retryChainReadFailure(0, new Error('unknown reason'))).toBe(false);
	});

	// wagmi replays a reverted transaction to read its reason. The replay runs only after the
	// receipt said reverted, so its error means a revert whatever made the replay itself fail.
	it('never retries the replay of a reverted transaction, even one that failed at the transport', () => {
		expect(retryChainReadFailure(0, replayOf(new BaseError('execution reverted')))).toBe(false);
		expect(retryChainReadFailure(0, replayOf(http))).toBe(false);
		expect(retryChainReadFailure(0, replayOf(rateLimited))).toBe(false);
	});

	// A wait that gave up after three tries settled as an error for a transaction that may
	// well have succeeded, and the confirmation refresh never ran.
	it('keeps retrying a failed HTTP request or a timeout for as long as the wait is mounted', () => {
		expect(retryChainReadFailure(0, http)).toBe(true);
		expect(retryChainReadFailure(3, timeout)).toBe(true);
		expect(retryChainReadFailure(500, http)).toBe(true);
	});

	// A hosted provider answers a rate limit with a JSON-RPC error, often inside an HTTP 200.
	// viem reports none of these as an HTTP failure, and the receipt used to say "reverted".
	it('keeps retrying an error the node answered with before any receipt was read', () => {
		expect(retryChainReadFailure(0, rateLimited)).toBe(true);
		expect(retryChainReadFailure(0, new LimitExceededRpcError(rateLimited))).toBe(true);
		expect(retryChainReadFailure(0, new InternalRpcError(rateLimited))).toBe(true);
		expect(retryChainReadFailure(0, new UnknownRpcError(new TypeError('Unexpected token')))).toBe(true);
	});

	it('finds a failed read anywhere in the cause chain, and nothing in no error at all', () => {
		expect(isChainReadFailure(new BaseError('wait failed', { cause: http }))).toBe(true);
		expect(isChainReadFailure(null)).toBe(false);
	});
});

describe('confirmationStatusOf', () => {
	const http = new HttpRequestError({ url: 'https://rpc.example' });

	it('is pending while nothing has failed, and with no hash to wait on', () => {
		expect(confirmationStatusOf({ status: 'pending', error: null, failureReason: null })).toBe('pending');
	});

	it('is unconfirmed while the last attempt could not read the chain', () => {
		expect(confirmationStatusOf({ status: 'pending', error: null, failureReason: http })).toBe('unconfirmed');
		expect(confirmationStatusOf({ status: 'error', error: http, failureReason: http })).toBe('unconfirmed');
		expect(confirmationStatusOf({ status: 'pending', error: null, failureReason: rateLimited })).toBe('unconfirmed');
	});

	it('is replaced once a cancel or another transaction took the nonce, whatever the wait says', () => {
		expect(confirmationStatusOf({ status: 'success', error: null, failureReason: null }, 'cancelled')).toBe('replaced');
		expect(confirmationStatusOf({ status: 'error', error: new Error('unknown reason'), failureReason: null }, 'replaced')).toBe(
			'replaced'
		);
		expect(confirmationStatusOf({ status: 'success', error: null, failureReason: null }, 'repriced')).toBe('success');
	});

	it('passes a mined result through', () => {
		expect(confirmationStatusOf({ status: 'success', error: null, failureReason: null })).toBe('success');
		expect(confirmationStatusOf({ status: 'error', error: new Error('unknown reason'), failureReason: null })).toBe('error');
		const replay = replayOf(new BaseError('execution reverted'));
		expect(confirmationStatusOf({ status: 'error', error: replay, failureReason: replay })).toBe('error');
	});
});
