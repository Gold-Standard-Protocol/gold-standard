import {
	formatTransactionReceipt,
	isAddressEqual,
	isHex,
	toEventSelector,
	type Address,
	type Hash,
	type RpcTransactionReceipt,
	type TransactionReceipt,
} from 'viem';

/**
 * Inside Safe{Wallet} a write is a proposal, not a transaction.
 *
 * The Safe connector answers eth_sendTransaction with the hash of
 * the Safe transaction, which no chain node knows. The receipt dialog waited on it without
 * end and linked it on Etherscan, the approval guard reported a failure after viem's 180
 * seconds, and nothing refreshed once the owners had signed. Only the connector's own
 * provider can say whether a proposal has executed: it resolves the safeTxHash through the
 * Safe and answers eth_getTransactionReceipt with null until then.
 */

/** `type` of wagmi's Safe connector: the dapp is framed by Safe{Wallet} and the account is a Safe. */
const SAFE_CONNECTOR_TYPE = 'safe';

/** The part of a wagmi connector a proposal is followed through. */
export interface ProposalConnector {
	type: string;
	getProvider(): Promise<unknown>;
}

/** True when writes from this connector are proposals to a Safe. */
export function isSafeConnector(connector: Pick<ProposalConnector, 'type'> | undefined): boolean {
	return connector?.type === SAFE_CONNECTOR_TYPE;
}

/** The one public read the lookup needs: the transaction at a place in a block. */
export interface TransactionLookup {
	getTransaction(position: { blockHash: Hash; index: number }): Promise<{ hash: Hash }>;
}

/** A proposal the Safe has executed. */
export interface SafeExecution {
	/** The receipt of the executing transaction, under the hash the chain knows. */
	receipt: TransactionReceipt;
	/** True when the proposed call took no effect: the execution reverted, or the Safe recorded its failure. */
	failed: boolean;
}

export interface ProposalLookup {
	connector: ProposalConnector;
	client: TransactionLookup;
	/** The Safe that holds the proposal. */
	safe: Address;
	safeTxHash: Hash;
}

interface RequestProvider {
	request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

function isRequestProvider(value: unknown): value is RequestProvider {
	return typeof value === 'object' && value !== null && 'request' in value && typeof value.request === 'function';
}

/** The fields this module reads; the Safe's answer is another page's data until they hold. */
function isRpcReceipt(value: unknown): value is RpcTransactionReceipt {
	if (typeof value !== 'object' || value === null) return false;
	const { status, blockHash, transactionIndex, logs } = value as Record<string, unknown>;
	return (status === '0x1' || status === '0x0') && isHex(blockHash) && isHex(transactionIndex) && Array.isArray(logs);
}

const EXECUTION_FAILURE = toEventSelector('ExecutionFailure(bytes32,uint256)');

/**
 * True when the Safe logged that this proposal's call failed inside a transaction that itself
 * succeeded, which it does whenever the proposal carries a safeTxGas. Safe 1.4 indexes the
 * proposal's hash; 1.3 carries it as the first word of the data.
 */
function recordsFailure(receipt: TransactionReceipt, safe: Address, safeTxHash: Hash): boolean {
	const proposal = safeTxHash.toLowerCase();
	return receipt.logs.some(
		(log) =>
			isAddressEqual(log.address, safe) &&
			log.topics[0] === EXECUTION_FAILURE &&
			(log.topics[1]?.toLowerCase() === proposal || log.data.toLowerCase().startsWith(proposal))
	);
}

/**
 * Asks the Safe whether a proposal has executed. Null while it has not: the owners have yet
 * to sign, or they have rejected it, which the provider does not tell apart.
 */
export async function readSafeExecution({ connector, client, safe, safeTxHash }: ProposalLookup): Promise<SafeExecution | null> {
	const provider = await connector.getProvider();
	if (!isRequestProvider(provider)) throw new Error('The Safe is not answering this page.');
	const answer = await provider.request({ method: 'eth_getTransactionReceipt', params: [safeTxHash] });
	if (answer === null || answer === undefined) return null;
	if (!isRpcReceipt(answer)) throw new Error('The Safe answered with a receipt this page cannot read.');
	const reported = formatTransactionReceipt(answer);
	// The provider writes the safeTxHash over the receipt's own hash, so the hash the chain
	// knows is read from the receipt's place in its block.
	const { hash } = await client.getTransaction({ blockHash: reported.blockHash, index: reported.transactionIndex });
	const receipt: TransactionReceipt = { ...reported, transactionHash: hash };
	return { receipt, failed: receipt.status === 'reverted' || recordsFailure(receipt, safe, safeTxHash) };
}

const BRISK_POLL_MS = 15_000;
const SLOW_POLL_MS = 60_000;
/** Ten minutes of brisk polls: a Safe with one owner executes within the first few. */
const BRISK_POLLS = 40;

/**
 * How long to wait before asking about an outstanding proposal again, given how many times
 * it has been asked about. Owners can take days, so the pace drops after ten minutes.
 */
export function proposalPollInterval(asked: number): number {
	return asked < BRISK_POLLS ? BRISK_POLL_MS : SLOW_POLL_MS;
}
