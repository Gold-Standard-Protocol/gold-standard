import { describe, expect, it } from 'vitest';
import { encodeEventTopics, encodeAbiParameters, type Log } from 'viem';
import { goldVaultAbi } from '@goldstandard/constants';
import { decodeRepaidAmount } from './repayReceipt';

const USER = '0x00000000000000000000000000000000000000aa';
const VAULT = '0x00000000000000000000000000000000000000bb';

function debtRepaidLog(amount: bigint): Log {
	return {
		address: VAULT,
		topics: encodeEventTopics({ abi: goldVaultAbi, eventName: 'DebtRepaid', args: { user: USER } }),
		data: encodeAbiParameters([{ type: 'uint256' }], [amount]),
		blockNumber: 1n,
		blockHash: '0x01',
		transactionHash: '0x02',
		transactionIndex: 0,
		logIndex: 0,
		removed: false,
	} as Log;
}

describe('decodeRepaidAmount', () => {
	it('returns the clamped amount the contract emitted, not the submitted ceiling', () => {
		const owed = 10_000_001_445_000_000_000_000n; // 10,000.001445 GSUSD
		expect(decodeRepaidAmount([debtRepaidLog(owed)])).toBe(owed);
	});

	it('is undefined without a DebtRepaid log', () => {
		expect(decodeRepaidAmount(undefined)).toBeUndefined();
		expect(decodeRepaidAmount([])).toBeUndefined();
	});
});
