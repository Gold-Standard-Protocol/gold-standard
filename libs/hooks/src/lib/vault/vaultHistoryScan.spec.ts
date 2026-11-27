import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, numberToHex, type Address } from 'viem';
import { goldVaultAbi } from '@goldstandard/constants';
import { type RawLog } from './vaultHistory';
import { createHistoryScanner, LOG_CHUNK, RESCAN_DEPTH, type HistoryClient, type HistoryScanTarget } from './vaultHistoryScan';

const ME: Address = '0x00000000000000000000000000000000000000aa';
const LIQUIDATOR: Address = '0x00000000000000000000000000000000000000cc';
const XAUT: Address = '0x00000000000000000000000000000000000000ff';
const DEPLOY = 1_000n;

const uint = (value: bigint) => encodeAbiParameters([{ type: 'uint256' }], [value]);

/** A log as eth_getLogs returns it; encodeEventTopics leaves null for an unset indexed slot. */
function log(eventName: 'CollateralDeposited' | 'DebtMinted' | 'Liquidated', block: bigint, data: `0x${string}`): RawLog {
	const args =
		eventName === 'CollateralDeposited'
			? { user: ME, token: XAUT }
			: eventName === 'Liquidated'
				? { vaultOwner: ME, liquidator: LIQUIDATOR }
				: { user: ME };
	const topics = encodeEventTopics({ abi: goldVaultAbi, eventName, args } as Parameters<typeof encodeEventTopics>[0])
		.map((topic) => (Array.isArray(topic) ? topic[0] : topic))
		.filter((topic): topic is `0x${string}` => topic !== null);
	const [first, ...rest] = topics;
	return {
		address: '0x00000000000000000000000000000000000000ee',
		topics: [first, ...rest],
		data,
		blockNumber: numberToHex(block),
		blockHash: `0x${'1'.repeat(64)}`,
		transactionHash: `0x${block.toString(16).padStart(64, '0')}`,
		transactionIndex: '0x0',
		logIndex: '0x0',
		removed: false,
	};
}

/** A fake node: a head that moves, a log set the test edits, and a count of every read. */
function fakeChain(head: bigint) {
	const chain = {
		head,
		logs: [] as RawLog[],
		getLogs: [] as [bigint, bigint][],
		headers: [] as bigint[],
	};
	const client: HistoryClient = {
		getBlockNumber: async () => chain.head,
		getLogs: async (from, to) => {
			chain.getLogs.push([from, to]);
			return chain.logs.filter((entry) => {
				const block = BigInt(entry.blockNumber ?? '0x0');
				return block >= from && block <= to;
			});
		},
		getBlockTimestamp: async (block) => {
			chain.headers.push(block);
			return Number(block) * 12;
		},
	};
	return { chain, client };
}

const target: HistoryScanTarget = { key: 'sepolia:me', chainId: 11155111, user: ME, fromBlock: DEPLOY };

describe('createHistoryScanner', () => {
	// Every poll used to walk every chunk since deployment.
	it('scans only from just below the last head after the first scan', async () => {
		const { chain, client } = fakeChain(DEPLOY + 3n * LOG_CHUNK);
		const scanner = createHistoryScanner();
		await scanner.scan(client, target);
		expect(chain.getLogs).toHaveLength(4);

		chain.getLogs = [];
		chain.head += 2n;
		await scanner.scan(client, target);
		const lastHead = DEPLOY + 3n * LOG_CHUNK;
		expect(chain.getLogs).toEqual([[lastHead - RESCAN_DEPTH + 1n, lastHead + 2n]]);
	});

	it('keeps what earlier scans found and adds what the new blocks hold, newest first', async () => {
		const { chain, client } = fakeChain(DEPLOY + 500n);
		chain.logs = [log('CollateralDeposited', DEPLOY + 10n, uint(5n))];
		const scanner = createHistoryScanner();
		await scanner.scan(client, target);

		chain.head = DEPLOY + 600n;
		chain.logs = [...chain.logs, log('DebtMinted', DEPLOY + 590n, uint(1_000n))];
		const items = await scanner.scan(client, target);
		expect(items.map((item) => [item.kind, item.blockNumber])).toEqual([
			['mint', DEPLOY + 590n],
			['deposit', DEPLOY + 10n],
		]);
	});

	// The window below the head is read again, and what it now says replaces what was held.
	it('drops an event a reorg removed from the window it rescans', async () => {
		const { chain, client } = fakeChain(DEPLOY + 500n);
		chain.logs = [log('DebtMinted', DEPLOY + 490n, uint(1n))];
		const scanner = createHistoryScanner();
		expect(await scanner.scan(client, target)).toHaveLength(1);

		chain.logs = [];
		chain.head += 1n;
		expect(await scanner.scan(client, target)).toEqual([]);
	});

	// A liquidation carries no token; the deposit before it, from an earlier scan, names it.
	it('names a new liquidation\'s collateral from a deposit an earlier scan found', async () => {
		const { chain, client } = fakeChain(DEPLOY + 500n);
		chain.logs = [log('CollateralDeposited', DEPLOY + 10n, uint(1_000_000n))];
		const scanner = createHistoryScanner();
		await scanner.scan(client, target);

		chain.head = DEPLOY + 900n;
		chain.logs = [
			...chain.logs,
			log('Liquidated', DEPLOY + 890n, encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [2_000n, 500_000n])),
		];
		const [liquidation] = await scanner.scan(client, target);
		expect(liquidation).toMatchObject({ kind: 'liquidated', token: XAUT, goldAmount: 500_000n });
	});

	it('fetches each block header once, however often the feed is read', async () => {
		const { chain, client } = fakeChain(DEPLOY + 500n);
		chain.logs = [log('CollateralDeposited', DEPLOY + 10n, uint(5n)), log('DebtMinted', DEPLOY + 20n, uint(1n))];
		const scanner = createHistoryScanner();
		const first = await scanner.scan(client, target);
		await scanner.scan(client, target);
		await scanner.scan(client, target);
		expect(chain.headers.sort()).toEqual([DEPLOY + 10n, DEPLOY + 20n]);
		expect(first.map((item) => item.timestamp)).toEqual([Number(DEPLOY + 20n) * 12, Number(DEPLOY + 10n) * 12]);
	});

	// Polls and refresh rounds overlap; a slow scan must not roll the cursor back.
	it('keeps the newer cursor when an older scan finishes last', async () => {
		const { chain, client } = fakeChain(DEPLOY + 500n);
		const scanner = createHistoryScanner();
		let release: () => void = () => undefined;
		const slow: HistoryClient = {
			...client,
			getBlockNumber: async () => DEPLOY + 400n,
			getLogs: async (from, to) => {
				await new Promise<void>((resolve) => {
					release = resolve;
				});
				return client.getLogs(from, to);
			},
		};
		const stale = scanner.scan(slow, target);
		await scanner.scan(client, target);
		release();
		await stale;

		chain.getLogs = [];
		await scanner.scan(client, target);
		expect(chain.getLogs[0]?.[0]).toBe(DEPLOY + 500n - RESCAN_DEPTH + 1n);
	});

	it('starts again from the deployment block for another wallet or chain', async () => {
		const { chain, client } = fakeChain(DEPLOY + 500n);
		const scanner = createHistoryScanner();
		await scanner.scan(client, target);
		chain.getLogs = [];
		await scanner.scan(client, { ...target, key: 'sepolia:other' });
		expect(chain.getLogs).toEqual([[DEPLOY, DEPLOY + 500n]]);
	});
});
