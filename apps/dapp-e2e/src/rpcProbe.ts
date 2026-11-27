import type { Page } from '@playwright/test';
import { RPC } from './helpers';

/** Everything the suite watches on the wire between the dapp and the node. */
export interface RpcProbe {
	/** Every transaction the wallet forwarded, in order, with its calldata. */
	sent: { method: string; data: string }[];
	/** How many eth_sendTransaction requests reached the node (sends held or blocked are still counted). */
	sendsArrived: number;
	/** Uncaught page errors, which no flow may produce. */
	pageErrors: string[];
	/** While true, eth_sendTransaction is answered with a user rejection and never reaches the node. */
	blockSends: boolean;
	/** While set, every eth_sendTransaction is delayed by this many milliseconds before reaching the node. */
	holdSendsMs: number;
	/** While set, an eth_call whose calldata starts with the selector and carries the amount at the word index is delayed. */
	holdCall: { selector: string; wordIndex: number; amount: bigint; ms: number } | undefined;
}

interface RpcCall {
	id?: number;
	method?: string;
	params?: { data?: string }[];
}

/** uint256 argument `index` (0-based) from the calldata of a transaction or call. */
export function wordAt(data: string, index: number): bigint {
	return BigInt('0x' + data.slice(10 + index * 64, 10 + (index + 1) * 64));
}

const USER_REJECTION = { code: 4001, message: 'User rejected the request.' };

/**
 * Sit between the dapp and the node: record what the wallet is asked to sign, and when a
 * test asks for it, refuse a send (the wallet "rejects"), hold a send (a slow wallet) or
 * hold one simulation (a lagging RPC). Requests may arrive singly or as a JSON-RPC batch.
 */
export async function probeRpc(page: Page): Promise<RpcProbe> {
	const probe: RpcProbe = { sent: [], sendsArrived: 0, pageErrors: [], blockSends: false, holdSendsMs: 0, holdCall: undefined };
	page.on('pageerror', (error) => probe.pageErrors.push(error.message));
	await page.route(`${RPC}/**`, async (route) => {
		let body: unknown;
		try {
			body = JSON.parse(route.request().postData() ?? 'null');
		} catch {
			body = null;
		}
		const calls = (Array.isArray(body) ? body : [body]).filter((c): c is RpcCall => c !== null && typeof c === 'object');
		const sends = calls.filter((c) => c.method === 'eth_sendTransaction');
		for (const send of sends) {
			probe.sendsArrived += 1;
			if (!probe.blockSends) probe.sent.push({ method: 'eth_sendTransaction', data: send.params?.[0]?.data ?? '' });
		}
		if (sends.length > 0 && probe.blockSends) {
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({ jsonrpc: '2.0', id: sends[0].id ?? 1, error: USER_REJECTION }),
			});
			return;
		}
		if (sends.length > 0 && probe.holdSendsMs > 0) {
			await new Promise((resolve) => setTimeout(resolve, probe.holdSendsMs));
		}
		const hold = probe.holdCall;
		if (hold) {
			const held = calls.some((c) => {
				const data = c.method === 'eth_call' ? c.params?.[0]?.data : undefined;
				return !!data && data.startsWith(hold.selector) && data.length >= 10 + (hold.wordIndex + 1) * 64 && wordAt(data, hold.wordIndex) === hold.amount;
			});
			if (held) await new Promise((resolve) => setTimeout(resolve, hold.ms));
		}
		await route.continue();
	});
	return probe;
}

/** A raw JSON-RPC call to the node, for snapshots and mining control. */
export async function rpc(method: string, params: unknown[] = []): Promise<unknown> {
	const response = await fetch(RPC, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
	});
	const body = (await response.json()) as { result?: unknown; error?: { message: string } };
	if (body.error) throw new Error(body.error.message);
	return body.result;
}

/** Wait for one more transaction than `before` to have been forwarded, and return its calldata. */
export async function nextSentCalldata(probe: RpcProbe, before: number, timeoutMs = 20_000): Promise<string> {
	const deadline = Date.now() + timeoutMs;
	while (probe.sent.length <= before && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	const last = probe.sent[probe.sent.length - 1];
	if (probe.sent.length <= before || !last) throw new Error('No transaction reached the wallet in time.');
	return last.data;
}
