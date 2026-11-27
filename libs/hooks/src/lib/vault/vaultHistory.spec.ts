import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, numberToHex, type Address } from 'viem';
import { goldStabilityReserveAbi, goldVaultAbi } from '@goldstandard/constants';
import { blockRanges, historyTopics, runLimited, toHistoryItems, type RawLog } from './vaultHistory';

const ME: Address = '0x00000000000000000000000000000000000000aa';
const OTHER: Address = '0x00000000000000000000000000000000000000cc';
const PAXG: Address = '0x00000000000000000000000000000000000000dd';
const XAUT: Address = '0x00000000000000000000000000000000000000ff';

/** encodeEventTopics leaves a null slot for any indexed argument not given; a log never does. */
function raw(
	topics: readonly (`0x${string}` | `0x${string}`[] | null)[],
	data: `0x${string}`,
	block: number,
	index: number
): RawLog {
	const [first, ...rest] = topics
		.map((t) => (Array.isArray(t) ? t[0] : t))
		.filter((t): t is `0x${string}` => t !== null);
	return {
		address: '0x00000000000000000000000000000000000000ee',
		topics: first ? [first, ...rest] : [],
		data,
		blockNumber: numberToHex(block),
		blockHash: `0x${'1'.repeat(64)}`,
		transactionHash: `0x${block.toString(16).padStart(64, '0')}`,
		transactionIndex: '0x0',
		logIndex: numberToHex(index),
		removed: false,
	};
}

describe('blockRanges', () => {
	it('walks an inclusive span in chunks no wider than the cap', () => {
		expect(blockRanges(100n, 100n, 50n)).toEqual([[100n, 100n]]);
		expect(blockRanges(0n, 120n, 50n)).toEqual([
			[0n, 49n],
			[50n, 99n],
			[100n, 120n],
		]);
		expect(blockRanges(10n, 5n, 50n)).toEqual([]);
	});
});

describe('historyTopics', () => {
	it('filters on the wallet as the first indexed argument of seven events', () => {
		const [selectors, who] = historyTopics(ME);
		expect(selectors).toHaveLength(7);
		expect(who).toBe(`0x000000000000000000000000${ME.slice(2)}`);
	});
});

describe('toHistoryItems', () => {
	it('decodes vault and reserve events for the wallet, newest first, and ignores others', () => {
		const u = (v: bigint) => encodeAbiParameters([{ type: 'uint256' }], [v]);
		const logs: RawLog[] = [
			raw(encodeEventTopics({ abi: goldVaultAbi, eventName: 'CollateralDeposited', args: { user: ME, token: PAXG } }), u(10n), 5, 0),
			raw(encodeEventTopics({ abi: goldVaultAbi, eventName: 'DebtMinted', args: { user: ME } }), u(10_000n), 5, 1),
			raw(encodeEventTopics({ abi: goldVaultAbi, eventName: 'DebtRepaid', args: { user: OTHER } }), u(1n), 6, 0),
			raw(
				encodeEventTopics({ abi: goldStabilityReserveAbi, eventName: 'Swapped', args: { redeemer: ME, token: PAXG } }),
				encodeAbiParameters(
					[{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }],
					[100n, 24n, 3000n, 0n]
				),
				7,
				2
			),
		];
		const items = toHistoryItems(logs, ME);
		expect(items.map(i => i.kind)).toEqual(['swap', 'mint', 'deposit']);
		expect(items[0]).toMatchObject({ amount: 100n, goldAmount: 24n, token: PAXG, blockNumber: 7n, logIndex: 2 });
		expect(items[2]).toMatchObject({ amount: 10n, token: PAXG });
	});

	it('names the collateral a liquidation seized from the deposit that preceded it', () => {
		const u = (v: bigint) => encodeAbiParameters([{ type: 'uint256' }], [v]);
		const u2 = (a: bigint, b: bigint) => encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [a, b]);
		const logs: RawLog[] = [
			// A liquidation before any deposit has nothing to inherit.
			raw(encodeEventTopics({ abi: goldVaultAbi, eventName: 'Liquidated', args: { vaultOwner: ME, liquidator: OTHER } }), u2(1n, 1n), 2, 0),
			raw(encodeEventTopics({ abi: goldVaultAbi, eventName: 'CollateralDeposited', args: { user: ME, token: XAUT } }), u(1_000_000n), 5, 0),
			raw(encodeEventTopics({ abi: goldVaultAbi, eventName: 'Liquidated', args: { vaultOwner: ME, liquidator: OTHER } }), u2(2_000n, 500_000n), 8, 3),
			raw(encodeEventTopics({ abi: goldVaultAbi, eventName: 'CollateralDeposited', args: { user: ME, token: PAXG } }), u(7n), 9, 0),
			raw(encodeEventTopics({ abi: goldVaultAbi, eventName: 'LiquidatedViaPool', args: { vaultOwner: ME, liquidator: OTHER } }), u2(3n, 7n), 12, 1),
		];
		const items = toHistoryItems(logs, ME);
		expect(items.map(i => i.kind)).toEqual(['liquidated', 'deposit', 'liquidated', 'deposit', 'liquidated']);
		// Newest first: the pool liquidation follows the PAXG deposit, the earlier one the XAUT deposit.
		expect(items[0]).toMatchObject({ token: PAXG, amount: 3n, goldAmount: 7n });
		expect(items[2]).toMatchObject({ token: XAUT, amount: 2_000n, goldAmount: 500_000n });
		expect(items[4].token).toBeUndefined();
	});
});

describe('runLimited', () => {
	it('keeps at most the limit in flight and preserves order', async () => {
		let inFlight = 0;
		let peak = 0;
		const job = (n: number) => async () => {
			inFlight++;
			peak = Math.max(peak, inFlight);
			await new Promise(r => setTimeout(r, 5));
			inFlight--;
			return n;
		};
		const out = await runLimited([1, 2, 3, 4, 5, 6].map(job), 2);
		expect(out).toEqual([1, 2, 3, 4, 5, 6]);
		expect(peak).toBe(2);
	});
});
