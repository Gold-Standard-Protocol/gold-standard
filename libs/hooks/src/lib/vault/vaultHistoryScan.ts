import { blockRanges, mergeHistory, runLimited, toHistoryItems, type RawLog, type VaultHistoryItem } from './vaultHistory';

/** publicnode rejects eth_getLogs spans above 50,000 blocks; stay under it. */
export const LOG_CHUNK = 49_999n;
/** How many entries to show; also bounds the block-header fetches for timestamps. */
export const MAX_ITEMS = 50;
/** Concurrent eth_getLogs calls; public RPCs reject bursts well before they slow them. */
const LOG_CONCURRENCY = 4;
/** Newest chunks scanned per load (~2.3 years of Sepolia at 12 s blocks); older history is truncated. */
export const MAX_CHUNKS = 120;
/**
 * Blocks below the last scanned head that every later scan reads again. A reorg near the
 * head can drop or move an event already listed; re-reading this window replaces what the
 * cache holds for it. 64 blocks is two mainnet epochs, past finality.
 */
export const RESCAN_DEPTH = 64n;

/** The three chain reads a scan needs, so the scan can be tested without a node. */
export interface HistoryClient {
	getBlockNumber(): Promise<bigint>;
	/** eth_getLogs over one inclusive range, with the feed's addresses and topics. */
	getLogs(fromBlock: bigint, toBlock: bigint): Promise<RawLog[]>;
	/** The block's timestamp in Unix seconds. */
	getBlockTimestamp(blockNumber: bigint): Promise<number>;
}

export interface HistoryScanTarget {
	/** Names one feed: chain, wallet and contract addresses. A new key starts a new scan. */
	key: string;
	/** Chain id, for the timestamp cache, which outlives any one wallet. */
	chainId: number;
	user: `0x${string}`;
	/** Where the first scan starts: the deployment block. */
	fromBlock: bigint;
}

interface ScanState {
	/** Highest block the cached items cover. */
	scannedTo: bigint;
	/** Every decoded item so far, newest first, untrimmed so a later liquidation can name its collateral. */
	items: VaultHistoryItem[];
}

/**
 * A vault history scanner with its own caches. The
 * feed used to walk every chunk since deployment on each 30-second poll and in each of the
 * five refresh rounds after a confirmation, and to fetch a header per listed block each
 * time, although every range below the head is sealed. Now the first scan walks from the
 * deployment block and each later one reads only from RESCAN_DEPTH below the last head;
 * block timestamps are fetched once per block. A scan whose result arrives after a newer
 * one never rolls the cursor back, so overlapping polls and refreshes stay correct.
 */
export function createHistoryScanner() {
	const scans = new Map<string, ScanState>();
	const timestamps = new Map<string, number>();

	const stampsFor = async (client: HistoryClient, chainId: number, blocks: readonly bigint[]) => {
		const missing = [...new Set(blocks)].filter(block => !timestamps.has(`${chainId}:${block}`));
		await Promise.all(
			missing.map(async block => {
				timestamps.set(`${chainId}:${block}`, await client.getBlockTimestamp(block));
			})
		);
		return (block: bigint) => timestamps.get(`${chainId}:${block}`);
	};

	return {
		async scan(client: HistoryClient, target: HistoryScanTarget): Promise<VaultHistoryItem[]> {
			const latest = await client.getBlockNumber();
			const previous = scans.get(target.key);
			const resumeFrom = previous && previous.scannedTo >= RESCAN_DEPTH ? previous.scannedTo - RESCAN_DEPTH + 1n : 0n;
			const scanFrom = previous && resumeFrom > target.fromBlock ? resumeFrom : target.fromBlock;
			const allChunks = blockRanges(scanFrom, latest, LOG_CHUNK);
			// A gap wider than one load can walk is a fresh start: only the newest chunks are read,
			// and the cached items would leave a hole between them and the head.
			const kept = previous && allChunks.length <= MAX_CHUNKS ? previous.items : [];
			// Newest first, so a truncated scan still shows the most recent activity.
			const chunks = allChunks.slice(-MAX_CHUNKS).reverse();
			const raw = (
				await runLimited(
					chunks.map(([from, to]) => () => client.getLogs(from, to)),
					LOG_CONCURRENCY
				)
			).flat();
			const items = mergeHistory(kept, toHistoryItems(raw, target.user), scanFrom);

			const current = scans.get(target.key);
			if (!current || current.scannedTo <= latest) scans.set(target.key, { scannedTo: latest, items });

			const shown = items.slice(0, MAX_ITEMS);
			const stampOf = await stampsFor(client, target.chainId, shown.map(item => item.blockNumber));
			return shown.map(item => ({ ...item, timestamp: stampOf(item.blockNumber) }));
		},
	};
}
