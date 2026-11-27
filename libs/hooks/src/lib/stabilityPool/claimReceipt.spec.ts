import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, type Log } from 'viem';
import { stabilityPoolAbi } from '@goldstandard/constants';
import { decodeClaimedAmount } from './claimReceipt';

const USER = '0x00000000000000000000000000000000000000aa';
const POOL = '0x00000000000000000000000000000000000000ee';
const PAXG = '0x00000000000000000000000000000000000000c1';

function baseLog(logIndex: number): Omit<Log, 'topics' | 'data'> {
	return {
		address: POOL,
		blockNumber: 1n,
		blockHash: '0x01',
		transactionHash: '0x02',
		transactionIndex: 0,
		logIndex,
		removed: false,
	};
}

function claimedLog(amount: bigint, logIndex = 0): Log {
	return {
		...baseLog(logIndex),
		topics: encodeEventTopics({ abi: stabilityPoolAbi, eventName: 'CollateralClaimed', args: { user: USER, token: PAXG } }),
		data: encodeAbiParameters([{ type: 'uint256' }], [amount]),
	} as Log;
}

function withdrawnLog(amount: bigint, logIndex = 0): Log {
	return {
		...baseLog(logIndex),
		topics: encodeEventTopics({ abi: stabilityPoolAbi, eventName: 'Withdrawn', args: { user: USER } }),
		data: encodeAbiParameters([{ type: 'uint256' }], [amount]),
	} as Log;
}

describe('decodeClaimedAmount', () => {
	it('returns the amount the pool paid, which a capped claim leaves below the gain', () => {
		const paid = 4n * 10n ** 17n + 7n;
		expect(decodeClaimedAmount([claimedLog(paid)])).toBe(paid);
	});

	it('reads the CollateralClaimed event and ignores other pool events', () => {
		const logs = [withdrawnLog(9n * 10n ** 18n, 0), claimedLog(2_500_000n, 1)];
		expect(decodeClaimedAmount(logs)).toBe(2_500_000n);
	});

	it('is undefined without a CollateralClaimed log', () => {
		expect(decodeClaimedAmount(undefined)).toBeUndefined();
		expect(decodeClaimedAmount([])).toBeUndefined();
		expect(decodeClaimedAmount([withdrawnLog(1n)])).toBeUndefined();
	});
});
