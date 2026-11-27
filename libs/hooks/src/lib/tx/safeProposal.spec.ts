import { describe, expect, it, vi } from 'vitest';
import { pad, toEventSelector, type Address, type Hash, type Hex } from 'viem';
import { isSafeConnector, proposalPollInterval, readSafeExecution } from './safeProposal';

const SAFE: Address = '0x00000000000000000000000000000000000000Aa';
const SAFE_TX_HASH: Hash = `0x${'11'.repeat(32)}`;
const CHAIN_HASH: Hash = `0x${'22'.repeat(32)}`;
const BLOCK_HASH: Hash = `0x${'33'.repeat(32)}`;
const OTHER_PROPOSAL: Hash = `0x${'44'.repeat(32)}`;
const EXECUTION_FAILURE = toEventSelector('ExecutionFailure(bytes32,uint256)');
const PAYMENT = pad('0x0', { size: 32 });

interface RawLog {
	address: Address;
	topics: Hex[];
	data: Hex;
}

/** A log as a node returns it: only the top of the receipt has its hash overwritten by the Safe. */
const rawLog = (log: RawLog) => ({
	...log,
	blockHash: BLOCK_HASH,
	blockNumber: '0x10',
	logIndex: '0x0',
	transactionHash: CHAIN_HASH,
	transactionIndex: '0x3',
	removed: false,
});

/** The receipt the Safe provider answers with once a proposal has executed. */
const rawReceipt = (overrides: { status?: Hex; logs?: RawLog[] } = {}) => ({
	// The provider writes the hash it was asked about over the receipt's own.
	transactionHash: SAFE_TX_HASH,
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
	status: overrides.status ?? '0x1',
	logs: (overrides.logs ?? []).map(rawLog),
});

function setup(answer: unknown) {
	const request = vi.fn(async () => answer);
	const getTransaction = vi.fn(async () => ({ hash: CHAIN_HASH }));
	const lookup = {
		connector: { type: 'safe', getProvider: async () => ({ request }) },
		client: { getTransaction },
		safe: SAFE,
		safeTxHash: SAFE_TX_HASH,
	};
	return { request, getTransaction, lookup };
}

describe('isSafeConnector', () => {
	it('is true only for the Safe connector', () => {
		expect(isSafeConnector({ type: 'safe' })).toBe(true);
		expect(isSafeConnector({ type: 'injected' })).toBe(false);
		expect(isSafeConnector(undefined)).toBe(false);
	});
});

describe('readSafeExecution', () => {
	it('asks the Safe, not a chain node, and answers null while the proposal is outstanding', async () => {
		const { request, getTransaction, lookup } = setup(null);
		expect(await readSafeExecution(lookup)).toBeNull();
		expect(request).toHaveBeenCalledWith({ method: 'eth_getTransactionReceipt', params: [SAFE_TX_HASH] });
		expect(getTransaction).not.toHaveBeenCalled();
	});

	// The provider overwrites the receipt's hash with the safeTxHash, which no explorer knows.
	it('reads the hash the chain knows from the place of the receipt in its block', async () => {
		const { getTransaction, lookup } = setup(rawReceipt());
		const execution = await readSafeExecution(lookup);
		expect(getTransaction).toHaveBeenCalledWith({ blockHash: BLOCK_HASH, index: 3 });
		expect(execution?.receipt.transactionHash).toBe(CHAIN_HASH);
		expect(execution?.receipt.status).toBe('success');
		expect(execution?.failed).toBe(false);
	});

	it('carries the logs of the proposed call, for the amounts a receipt names', async () => {
		const transfer = { address: '0x00000000000000000000000000000000000000bb' as Address, topics: [pad('0x1', { size: 32 })], data: '0x' as Hex };
		const { lookup } = setup(rawReceipt({ logs: [transfer] }));
		const execution = await readSafeExecution(lookup);
		expect(execution?.receipt.logs).toHaveLength(1);
		expect(execution?.receipt.logs[0].address).toBe(transfer.address);
	});

	it('reports an execution that reverted as failed', async () => {
		const { lookup } = setup(rawReceipt({ status: '0x0' }));
		expect((await readSafeExecution(lookup))?.failed).toBe(true);
	});

	// With safeTxGas set the Safe swallows a failed call: the transaction succeeds and the
	// Safe logs ExecutionFailure. Safe 1.4 indexes the proposal's hash; 1.3 carries it as data.
	it('reports a call the Safe recorded as failed, in either event layout', async () => {
		const indexed = { address: SAFE, topics: [EXECUTION_FAILURE, SAFE_TX_HASH], data: PAYMENT };
		const inData = { address: SAFE, topics: [EXECUTION_FAILURE], data: `${SAFE_TX_HASH}${PAYMENT.slice(2)}` as Hex };
		for (const log of [indexed, inData]) {
			const { lookup } = setup(rawReceipt({ logs: [log] }));
			expect((await readSafeExecution(lookup))?.failed).toBe(true);
		}
	});

	it('ignores a failure recorded for another proposal or by another contract', async () => {
		const anotherProposal = { address: SAFE, topics: [EXECUTION_FAILURE, OTHER_PROPOSAL], data: PAYMENT };
		const anotherContract = {
			address: '0x00000000000000000000000000000000000000cc' as Address,
			topics: [EXECUTION_FAILURE, SAFE_TX_HASH],
			data: PAYMENT,
		};
		const { lookup } = setup(rawReceipt({ logs: [anotherProposal, anotherContract] }));
		expect((await readSafeExecution(lookup))?.failed).toBe(false);
	});

	it('throws when the Safe cannot be asked', async () => {
		const { lookup } = setup(null);
		const framedNowhere = { ...lookup, connector: { type: 'safe', getProvider: async () => undefined } };
		await expect(readSafeExecution(framedNowhere)).rejects.toThrow(/Safe/);
	});

	it('throws on an answer that is not a receipt, and never reads it as an execution', async () => {
		for (const answer of ['0x1', { status: '0x1' }, { ...rawReceipt(), status: 'ok' }, { ...rawReceipt(), logs: undefined }]) {
			const { getTransaction, lookup } = setup(answer);
			await expect(readSafeExecution(lookup)).rejects.toThrow(/receipt/);
			expect(getTransaction).not.toHaveBeenCalled();
		}
	});
});

describe('proposalPollInterval', () => {
	it('asks every 15 seconds for the first ten minutes, then once a minute', () => {
		expect(proposalPollInterval(0)).toBe(15_000);
		expect(proposalPollInterval(39)).toBe(15_000);
		expect(proposalPollInterval(40)).toBe(60_000);
		expect(proposalPollInterval(5_000)).toBe(60_000);
	});
});
