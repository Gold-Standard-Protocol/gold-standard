import { getAbiItem, hexToBigInt, hexToNumber, pad, parseEventLogs, toEventSelector, type Address, type Hex, type RpcLog } from 'viem';
import { goldStabilityReserveAbi, goldVaultAbi } from '@goldstandard/constants';

export type VaultHistoryKind = 'deposit' | 'withdraw' | 'mint' | 'repay' | 'liquidated' | 'swap';

export interface VaultHistoryItem {
	kind: VaultHistoryKind;
	/** GSUSD for mint/repay/swap-in/liquidated debt; gold for deposit/withdraw. */
	amount: bigint;
	/**
	 * Gold token for deposit/withdraw/swap. A liquidation event carries no token, so it
	 * takes the one the wallet had deposited before it; undefined for the debt legs.
	 */
	token: Address | undefined;
	/** Gold received (swap) or seized (liquidation), in the token's decimals. */
	goldAmount: bigint | undefined;
	txHash: Hex;
	blockNumber: bigint;
	logIndex: number;
	/** Unix seconds; filled in after the block header is fetched. */
	timestamp: number | undefined;
}

/** The events in which the wallet is the first indexed argument. */
const VAULT_EVENTS = [
	'CollateralDeposited',
	'CollateralWithdrawn',
	'DebtMinted',
	'DebtRepaid',
	'Liquidated',
	'LiquidatedViaPool',
] as const;

/** topic0 for every event the feed reads, so one eth_getLogs covers all of them. */
export function historyTopics(user: Address): [Hex[], Hex] {
	const vaultSelectors = VAULT_EVENTS.map(name => toEventSelector(getAbiItem({ abi: goldVaultAbi, name })));
	const swapSelector = toEventSelector(getAbiItem({ abi: goldStabilityReserveAbi, name: 'Swapped' }));
	return [[...vaultSelectors, swapSelector], pad(user, { size: 32 })];
}

/**
 * Splits [from, to] into inclusive ranges no wider than `chunk` blocks. Public RPCs
 * cap eth_getLogs at a block span (publicnode: 50,000), so a feed that starts at the
 * deployment block has to walk forward in pieces.
 */
export function blockRanges(from: bigint, to: bigint, chunk: bigint): Array<[bigint, bigint]> {
	if (to < from || chunk <= 0n) return [];
	const ranges: Array<[bigint, bigint]> = [];
	for (let start = from; start <= to; start += chunk) {
		const end = start + chunk - 1n < to ? start + chunk - 1n : to;
		ranges.push([start, end]);
	}
	return ranges;
}

/** The shape eth_getLogs returns before viem formats it. */
export type RawLog = RpcLog;

/**
 * Decodes raw logs from the vault and the reserve into feed items, newest first.
 * Logs that decode to nothing (an unrelated event sharing the address) are dropped.
 */
export function toHistoryItems(logs: readonly RawLog[], user: Address): VaultHistoryItem[] {
	const me = user.toLowerCase();
	const items: VaultHistoryItem[] = [];
	for (const raw of logs) {
		if (raw.removed || raw.blockNumber === null || raw.transactionHash === null || raw.logIndex === null) continue;
		const base = {
			txHash: raw.transactionHash,
			blockNumber: hexToBigInt(raw.blockNumber),
			logIndex: hexToNumber(raw.logIndex),
			timestamp: undefined,
		};
		const [vaultEvent] = parseEventLogs({ abi: goldVaultAbi, logs: [raw], strict: false });
		if (vaultEvent) {
			const a = vaultEvent.args as Record<string, unknown>;
			switch (vaultEvent.eventName) {
				case 'CollateralDeposited':
					if (String(a['user']).toLowerCase() === me) items.push({ ...base, kind: 'deposit', amount: a['amount'] as bigint, token: a['token'] as Address, goldAmount: undefined });
					break;
				case 'CollateralWithdrawn':
					if (String(a['user']).toLowerCase() === me) items.push({ ...base, kind: 'withdraw', amount: a['amount'] as bigint, token: a['token'] as Address, goldAmount: undefined });
					break;
				case 'DebtMinted':
					if (String(a['user']).toLowerCase() === me) items.push({ ...base, kind: 'mint', amount: a['amount'] as bigint, token: undefined, goldAmount: undefined });
					break;
				case 'DebtRepaid':
					if (String(a['user']).toLowerCase() === me) items.push({ ...base, kind: 'repay', amount: a['amount'] as bigint, token: undefined, goldAmount: undefined });
					break;
				case 'Liquidated':
				case 'LiquidatedViaPool':
					if (String(a['vaultOwner']).toLowerCase() === me) items.push({ ...base, kind: 'liquidated', amount: a['debtRepaid'] as bigint, token: undefined, goldAmount: a['collateralSeized'] as bigint });
					break;
				default:
					break;
			}
			continue;
		}
		const [swap] = parseEventLogs({ abi: goldStabilityReserveAbi, eventName: 'Swapped', logs: [raw], strict: false });
		if (swap && String(swap.args.redeemer).toLowerCase() === me) {
			items.push({ ...base, kind: 'swap', amount: swap.args.gsusdIn as bigint, token: swap.args.token as Address, goldAmount: swap.args.goldOut as bigint });
		}
	}
	return newestFirst(attributeLiquidations(items));
}

function newestFirst(items: VaultHistoryItem[]): VaultHistoryItem[] {
	return items.sort((x, y) =>
		y.blockNumber === x.blockNumber ? y.logIndex - x.logIndex : y.blockNumber > x.blockNumber ? 1 : -1
	);
}

/**
 * Folds a fresh scan of [rescanFrom, head] into the items already held, newest first. The
 * held items inside that window are dropped, because the fresh scan read it again and a
 * reorg may have removed or moved them. A liquidation in the fresh scan whose deposit is
 * older than the window takes its collateral from the held items.
 */
export function mergeHistory(
	held: readonly VaultHistoryItem[],
	fresh: readonly VaultHistoryItem[],
	rescanFrom: bigint
): VaultHistoryItem[] {
	const settled = held.filter(item => item.blockNumber < rescanFrom);
	return newestFirst(attributeLiquidations([...settled, ...fresh]));
}

/**
 * Liquidated and LiquidatedViaPool emit the collateral seized in the token's native
 * units but not the token. The wallet's own deposits do carry it, and a vault holds one
 * collateral at a time, so the deposit preceding a liquidation names what was seized.
 * Without this every seized XAUT amount was formatted at 18 decimals and read as zero.
 */
function attributeLiquidations(items: readonly VaultHistoryItem[]): VaultHistoryItem[] {
	const chronological = [...items].sort((x, y) =>
		x.blockNumber === y.blockNumber ? x.logIndex - y.logIndex : x.blockNumber > y.blockNumber ? 1 : -1
	);
	let held: Address | undefined;
	return chronological.map(item => {
		if (item.kind === 'deposit') held = item.token;
		if (item.kind === 'liquidated' && item.token === undefined) return { ...item, token: held };
		return item;
	});
}

/**
 * Runs async jobs with at most `limit` in flight. Public RPCs rate-limit bursts, and a
 * long-lived deployment's event history is hundreds of chunks: firing them all at once
 * gets the whole feed rejected instead of merely slowed.
 */
export async function runLimited<T>(jobs: Array<() => Promise<T>>, limit: number): Promise<T[]> {
	const results: T[] = new Array(jobs.length);
	let next = 0;
	const worker = async () => {
		while (next < jobs.length) {
			const index = next++;
			results[index] = await jobs[index]();
		}
	};
	await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, jobs.length)) }, worker));
	return results;
}
