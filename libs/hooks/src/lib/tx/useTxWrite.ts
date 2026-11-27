import { useCallback, useEffect, useRef, useState } from 'react';
import { BaseError, CallExecutionError, type Hash, type ReplacementReason, type ReplacementReturnType } from 'viem';
import { useAccount, useChainId, useWaitForTransactionReceipt, useWriteContract } from 'wagmi';
import { isSafeConnector, type SafeExecution } from './safeProposal';
import { useRefreshOnConfirmation } from './useRefreshOnConfirmation';
import { useSafeProposal } from './useSafeProposal';

/** Callbacks a review dialog attaches to one write. */
export interface WriteCallbacks {
	/** The wallet returned a hash. */
	onSuccess?: () => void;
	/** The wallet returned a hash or a refusal: the moment to release a click lock. */
	onSettled?: () => void;
}

/** The function a Confirm button calls, or undefined while there is nothing safe to sign. */
export type WriteFn = (callbacks?: WriteCallbacks) => void;

/**
 * What a receipt view can say about a sent transaction. `unconfirmed` is the wait failing
 * to read the chain: the transaction is neither mined nor reverted as far as the dapp
 * knows, and it may still succeed. `proposed` is a write made inside Safe{Wallet}: the Safe
 * holds a proposal, nothing is on-chain until its owners sign, and the hash beside it is the
 * proposal's own, which no explorer knows. `replaced` is the wallet cancelling the
 * transaction or sending another on its nonce: what was mined is not what was reviewed.
 */
export type ConfirmationStatus = 'error' | 'pending' | 'proposed' | 'replaced' | 'success' | 'unconfirmed';

/** The parts of a receipt wait that decide a `ConfirmationStatus`. */
export interface ReceiptWait {
	status: 'error' | 'pending' | 'success';
	error: Error | null;
	failureReason: Error | null;
}

/**
 * True when the wait failed without learning what became of the transaction: a failed HTTP
 * request, a timeout, or a JSON-RPC error the node answered with (a rate limit, an internal
 * error). The test is what is known to be a revert, because only that is certain. wagmi
 * reads a receipt mined as reverted and then replays the transaction for its reason: it
 * throws a plain Error when the replay answers, and the replay's own CallExecutionError when
 * it does not. Either one means the receipt was read and said reverted. Every other viem
 * error comes from the wait itself, before any receipt, and says nothing about the
 * transaction. Testing for transport errors alone called a rate-limited provider's answer a
 * revert.
 */
export function isChainReadFailure(error: unknown): boolean {
	if (!(error instanceof BaseError)) return false;
	return !error.walk((cause) => cause instanceof CallExecutionError);
}

/**
 * Retries a receipt wait only when the chain could not be read, and then for as long as the
 * wait is mounted. React Query's default retried a mined revert three times with backoff,
 * so the dialog said "Waiting for confirmation" for about seven seconds after the user had
 * already paid for a revert that cannot change. A failed read is the opposite case: giving
 * up after a few tries settled the wait as an error for a transaction that may well be
 * mined, the receipt said it had reverted and the confirmation refresh never ran. React
 * Query spaces the retries up to 30 seconds apart and pauses them while the tab is hidden.
 * A receipt that is not yet mined never reaches here: viem's own wait keeps polling for it.
 */
export function retryChainReadFailure(_failureCount: number, error: Error): boolean {
	return isChainReadFailure(error);
}

/**
 * Reads a receipt wait as what the user can be told about the transaction. viem resolves the
 * wait with the receipt of whatever took the nonce, so a cancel (a zero-value self-send) was
 * read as a success and the dialog said "Confirmed" for an action that never ran. Only a
 * speed-up ('repriced': the same call at a higher fee) is the reviewed transaction.
 */
export function confirmationStatusOf(wait: ReceiptWait, replacedBecause?: ReplacementReason): ConfirmationStatus {
	if (replacedBecause && replacedBecause !== 'repriced') return 'replaced';
	if (wait.status === 'success') return 'success';
	const failure = wait.status === 'error' ? wait.error : wait.failureReason;
	return isChainReadFailure(failure) ? 'unconfirmed' : wait.status;
}

/**
 * Reads a Safe proposal as what the user can be told about it. With no proposal it is
 * 'pending', as a receipt wait is with no hash to wait on.
 */
export function proposalStatusOf(safeTxHash: Hash | undefined, execution: SafeExecution | undefined): ConfirmationStatus {
	if (!safeTxHash) return 'pending';
	if (!execution) return 'proposed';
	return execution.failed ? 'error' : 'success';
}

/** A transaction mined on the nonce of the one the wallet returned, as viem reports it. */
interface Replacement {
	/** The hash the wallet returned, which the chain dropped. */
	of: Hash;
	/** The hash the chain mined in its place. */
	hash: Hash;
	reason: ReplacementReason;
}

/** What the confirmation refresh is told about a followed proposal: outstanding is 'pending', which re-arms it. */
function proposalRefreshStatus(execution: SafeExecution | undefined): 'error' | 'pending' | 'success' {
	if (!execution) return 'pending';
	return execution.failed ? 'error' : 'success';
}

/**
 * The write half shared by every action hook: the mutation, the receipt wait, the
 * post-confirmation refresh and a reset tied to the connected account.
 *
 * wagmi keeps the hash and any error until the mutation is reset, so without `reset`
 * a review opened after a completed transaction stayed pinned to the old amount and a
 * rejected signature showed its error in the next review before any click. The dialogs
 * call `reset` when they close; the account or chain changing calls it here, so nothing
 * from the previous account survives a switch.
 */
export function useTxWrite() {
	const { writeContract, data: writeHash, isPending: isWritePending, error: writeError, reset } = useWriteContract();
	const { address, connector } = useAccount();
	const chainId = useChainId();
	// Inside Safe{Wallet} the wallet answers with a safeTxHash, which no chain node knows. The
	// public waits are given nothing to poll and the Safe is asked instead (safeProposal).
	const proposes = isSafeConnector(connector);
	// A cancel or speed-up in the wallet mines another hash on the same nonce. Both waits are
	// told, because they share one query and either one's function may be the one that runs.
	const [replacement, setReplacement] = useState<Replacement | undefined>(undefined);
	const onReplaced = useCallback((replaced: ReplacementReturnType) => {
		setReplacement({ of: replaced.replacedTransaction.hash, hash: replaced.transaction.hash, reason: replaced.reason });
	}, []);
	// Named fields, not a rest spread: React Query re-renders on the fields a component reads.
	const { data: minedReceipt, status, error, failureReason } = useWaitForTransactionReceipt({
		hash: proposes ? undefined : writeHash,
		onReplaced,
		query: { retry: retryChainReadFailure },
	});
	const scope = `${chainId}:${address ?? ''}`;
	const previousScope = useRef(scope);
	// The refresh follows the last hash the wallet returned, not the mutation: closing the
	// receipt while it still waits resets the write and drops txHash, and without this the
	// confirmation arrived unobserved and the figures stayed stale until the next poll.
	// Both waits share one query while the hash is live, so this costs no extra request.
	// The refresh reads the wait's own status: it fires when the receipt arrives, however
	// long the chain was unreadable first.
	const trackedHash = useRef(writeHash);
	// A hash from the previous account or chain is dropped in the render that sees the switch,
	// before the effect below resets the write: a proposal is never asked about under another Safe.
	if (previousScope.current !== scope) trackedHash.current = undefined;
	else if (writeHash) trackedHash.current = writeHash;
	const { status: trackedStatus } = useWaitForTransactionReceipt({
		hash: proposes ? undefined : trackedHash.current,
		onReplaced,
		query: { retry: retryChainReadFailure },
	});
	// A proposal is followed the same way, for as long as its owners take to sign.
	const followed = useSafeProposal({ connector, safe: address, safeTxHash: proposes ? trackedHash.current : undefined });
	useRefreshOnConfirmation(proposes ? proposalRefreshStatus(followed) : trackedStatus);
	// The followed proposal is the written one for as long as the write holds its hash; once the
	// receipt is closed, an execution refreshes the reads and reopens nothing.
	const execution = writeHash ? followed : undefined;

	useEffect(() => {
		if (previousScope.current === scope) return;
		previousScope.current = scope;
		trackedHash.current = undefined;
		reset();
	}, [scope, reset]);

	if (proposes) {
		return {
			writeContract,
			reset,
			// Once executed, the hash the chain knows: the receipt can link it on an explorer.
			txHash: execution?.receipt.transactionHash ?? writeHash,
			receipt: execution?.receipt,
			confirmationStatus: proposalStatusOf(writeHash, execution),
			isWritePending,
			writeError,
		};
	}
	// A replacement of an earlier write says nothing about this one.
	const replaced = writeHash && replacement?.of === writeHash ? replacement : undefined;
	const confirmationStatus = confirmationStatusOf({ status, error, failureReason }, replaced?.reason);
	// The dropped hash is unknown to the explorer: the receipt links what was mined.
	const txHash = replaced?.hash ?? writeHash;
	return { writeContract, reset, txHash, receipt: minedReceipt, confirmationStatus, isWritePending, writeError };
}
