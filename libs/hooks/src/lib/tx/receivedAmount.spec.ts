import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, erc20Abi, type Address, type Log } from 'viem';
import { decodeReceivedAmount } from './receivedAmount';

const USER: Address = '0x00000000000000000000000000000000000000aa';
const OTHER: Address = '0x00000000000000000000000000000000000000cc';
const PAXG: Address = '0x00000000000000000000000000000000000000bb';
const GSUSD: Address = '0x00000000000000000000000000000000000000dd';

function transferLog(token: Address, from: Address, to: Address, value: bigint): Log {
	return {
		address: token,
		topics: encodeEventTopics({ abi: erc20Abi, eventName: 'Transfer', args: { from, to } }),
		data: encodeAbiParameters([{ type: 'uint256' }], [value]),
		blockNumber: 1n,
		blockHash: '0x01',
		transactionHash: '0x02',
		transactionIndex: 0,
		logIndex: 0,
		removed: false,
	} as Log;
}

describe('decodeReceivedAmount', () => {
	it('reads what the recipient was paid, ignoring the token they sold and transfers to others', () => {
		const logs = [
			transferLog(GSUSD, USER, OTHER, 1_000n * 10n ** 18n),
			transferLog(PAXG, OTHER, USER, 250_123_456_789_000_000n),
			transferLog(PAXG, OTHER, OTHER, 7n),
		];
		expect(decodeReceivedAmount(logs, PAXG, USER)).toBe(250_123_456_789_000_000n);
	});

	it('matches addresses regardless of checksum case', () => {
		const logs = [transferLog(PAXG, OTHER, USER, 5n)];
		expect(decodeReceivedAmount(logs, PAXG.toUpperCase().replace('0X', '0x') as Address, USER)).toBe(5n);
	});

	it('is undefined without a matching transfer or inputs', () => {
		expect(decodeReceivedAmount(undefined, PAXG, USER)).toBeUndefined();
		expect(decodeReceivedAmount([], PAXG, USER)).toBeUndefined();
		expect(decodeReceivedAmount([transferLog(PAXG, OTHER, OTHER, 5n)], PAXG, USER)).toBeUndefined();
		expect(decodeReceivedAmount([transferLog(PAXG, OTHER, USER, 5n)], undefined, USER)).toBeUndefined();
	});
});
