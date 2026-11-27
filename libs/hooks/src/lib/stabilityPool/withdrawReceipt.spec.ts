import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, type Log } from 'viem';
import { stabilityPoolAbi } from '@goldstandard/constants';
import { decodeWithdrawnAmount } from './withdrawReceipt';

const USER = '0x00000000000000000000000000000000000000aa';
const POOL = '0x00000000000000000000000000000000000000ee';

function poolLog(eventName: 'Withdrawn' | 'Deposited', amount: bigint, logIndex = 0): Log {
	return {
		address: POOL,
		topics: encodeEventTopics({ abi: stabilityPoolAbi, eventName, args: { user: USER } }),
		data: encodeAbiParameters([{ type: 'uint256' }], [amount]),
		blockNumber: 1n,
		blockHash: '0x01',
		transactionHash: '0x02',
		transactionIndex: 0,
		logIndex,
		removed: false,
	} as Log;
}

describe('decodeWithdrawnAmount', () => {
	it('returns the capped amount the pool emitted, not the amount that was asked for', () => {
		const returned = 300n * 10n ** 18n + 123n;
		expect(decodeWithdrawnAmount([poolLog('Withdrawn', returned)])).toBe(returned);
	});

	it('reads the Withdrawn event and ignores a Deposited event of the same shape', () => {
		const logs = [poolLog('Deposited', 7n * 10n ** 18n, 0), poolLog('Withdrawn', 3n * 10n ** 18n, 1)];
		expect(decodeWithdrawnAmount(logs)).toBe(3n * 10n ** 18n);
	});

	it('is undefined without a Withdrawn log', () => {
		expect(decodeWithdrawnAmount(undefined)).toBeUndefined();
		expect(decodeWithdrawnAmount([])).toBeUndefined();
		expect(decodeWithdrawnAmount([poolLog('Deposited', 1n)])).toBeUndefined();
	});
});
