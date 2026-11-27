import type { FrameLocator, Page } from '@playwright/test';
import { RPC, WALLET } from './helpers';

/**
 * A stand-in for the Safe{Wallet} web app.
 *
 * The page is served from the Safe web app's origin, the only parent the dapp lets frame it
 * and the only origin the Safe connector trusts, and frames the dapp as Safe{Wallet} frames
 * a Safe App. Inside the frame everything is real: wagmi's Safe connector, the Safe Apps SDK
 * and its provider. Only the host is simulated. It speaks the SDK's postMessage protocol
 * (node_modules/@safe-global/safe-apps-sdk/dist/esm/communication) and stands for a Safe
 * that needs two signatures:
 *
 * - sendTransactions records a proposal and answers a safeTxHash; nothing reaches the chain.
 * - getTxBySafeTxHash answers AWAITING_CONFIRMATIONS until the test executes the proposal.
 * - rpcCall goes to the local node, as Safe{Wallet} proxies reads to its own RPC.
 *
 * The "Safe" is the suite's funded wallet, which the node signs for, so `execute` sends the
 * proposed call from that address. There is no Safe contract, so the Safe's own events
 * (ExecutionSuccess, ExecutionFailure) are not exercised here; the unit tests cover those.
 */
const SAFE_ORIGIN = 'https://app.safe.global';

export interface SafeProposal {
	safeTxHash: string;
	to: string;
	/** The chain transaction that executed the proposal, once the test has executed it. */
	executedHash: string | null;
}

export interface SafeHost {
	/** The dapp, inside the frame. */
	app: FrameLocator;
	proposals(): Promise<SafeProposal[]>;
	/** Signs and executes one proposal as the owners would; answers the executing transaction's hash. */
	execute(safeTxHash: string): Promise<string>;
}

interface SafeHostWindow {
	safeHost: Pick<SafeHost, 'proposals' | 'execute'>;
}

async function nodeRpc(method: string, params: unknown[]): Promise<unknown> {
	const response = await fetch(RPC, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
	});
	const body = (await response.json()) as { result?: unknown; error?: { message: string } };
	if (body.error) throw new Error(`${method}: ${body.error.message}`);
	return body.result;
}

/** The host page. Plain script: it runs in the browser, outside the suite's TypeScript. */
function hostPage(appUrl: string): string {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Safe host stand-in</title>
<style>html, body { margin: 0; height: 100%; } iframe { display: block; border: 0; width: 100%; height: 100%; }</style>
</head>
<body>
<iframe id="app" title="Gold Standard" src=${JSON.stringify(appUrl)}></iframe>
<script>
(() => {
	const SAFE = ${JSON.stringify(WALLET)};
	const VERSION = '9.1.0';
	const frame = document.getElementById('app');
	const proposals = new Map();
	const quantity = (value) => '0x' + BigInt(value || 0).toString(16);

	const handlers = {
		getSafeInfo: async () => ({
			safeAddress: SAFE,
			chainId: 11155111,
			threshold: 2,
			owners: ['0x00000000000000000000000000000000000000a1', '0x00000000000000000000000000000000000000a2'],
			isReadOnly: false,
		}),
		rpcCall: ({ call, params }) => window.safeHostRpc(call, params),
		sendTransactions: async ({ txs }) => {
			const safeTxHash = '0x' + 'a5'.repeat(31) + (proposals.size + 1).toString(16).padStart(2, '0');
			proposals.set(safeTxHash, { txs, executedHash: null });
			return { safeTxHash };
		},
		getTxBySafeTxHash: async ({ safeTxHash }) => {
			const proposal = proposals.get(safeTxHash);
			if (!proposal) throw new Error('No such Safe transaction');
			return {
				safeTxHash,
				txStatus: proposal.executedHash ? 'SUCCESS' : 'AWAITING_CONFIRMATIONS',
				txHash: proposal.executedHash,
			};
		},
	};

	window.addEventListener('message', async (event) => {
		if (event.source !== frame.contentWindow) return;
		const { id, method, params } = event.data || {};
		if (!id || !method) return;
		const reply = (body) => frame.contentWindow.postMessage({ id, version: VERSION, ...body }, '*');
		try {
			const handler = handlers[method];
			if (!handler) throw new Error('The stand-in does not answer ' + method);
			reply({ success: true, data: await handler(params) });
		} catch (error) {
			reply({ success: false, error: String((error && error.message) || error) });
		}
	});

	window.safeHost = {
		proposals: async () =>
			[...proposals].map(([safeTxHash, proposal]) => ({
				safeTxHash,
				to: proposal.txs[0].to,
				executedHash: proposal.executedHash,
			})),
		execute: async (safeTxHash) => {
			const proposal = proposals.get(safeTxHash);
			if (!proposal) throw new Error('No such Safe transaction');
			const [tx] = proposal.txs;
			proposal.executedHash = await window.safeHostRpc('eth_sendTransaction', [
				{ from: SAFE, to: tx.to, data: tx.data, value: quantity(tx.value) },
			]);
			return proposal.executedHash;
		},
	};
})();
</script>
</body>
</html>`;
}

/** Opens `path` of the dapp inside the stand-in, as a Safe App. */
export async function openInSafe(page: Page, baseURL: string, path: string): Promise<SafeHost> {
	// Chrome asks before a public page reaches a server on this machine, and the stand-in is
	// served under a public origin while the dapp runs on localhost. Safe{Wallet} never meets
	// the prompt: it frames a deployed dapp.
	await page.context().grantPermissions(['local-network-access'], { origin: SAFE_ORIGIN });
	await page.exposeFunction('safeHostRpc', nodeRpc);
	await page.route(`${SAFE_ORIGIN}/**`, (route) =>
		route.fulfill({ contentType: 'text/html', body: hostPage(new URL(path, baseURL).toString()) })
	);
	await page.goto(`${SAFE_ORIGIN}/apps/open`);
	const host = () => page.evaluateHandle(() => (window as unknown as SafeHostWindow).safeHost);
	return {
		app: page.frameLocator('#app'),
		proposals: async () => (await host()).evaluate((safeHost) => safeHost.proposals()),
		execute: async (safeTxHash) => (await host()).evaluate((safeHost, hash) => safeHost.execute(hash), safeTxHash),
	};
}
