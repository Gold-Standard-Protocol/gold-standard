/**
 * The end-to-end wallet (apps/dapp-e2e).
 *
 * In Vite's `e2e` mode, VITE_E2E_WALLET names an address the local node signs for and the
 * dapp connects to it through a small connector instead of RainbowKit's wallet list. The
 * connector answers the account and chain queries itself and forwards every other request,
 * eth_sendTransaction included, to the node, which holds the account. No private key exists
 * in the dapp, in the tests or in CI.
 *
 * wagmi's own mock connector was not usable: it forwards eth_accounts to the node, which
 * lists all of its accounts with the deployer first, so writes were attributed to the wrong
 * address.
 *
 * Two guards keep this out of real builds: the flag is read only when MODE is "e2e", and
 * vite.config.mts refuses to build in that mode or with the flag set at all.
 *
 * A framed page is a Safe App. The suite's stand-in for Safe{Wallet} (apps/dapp-e2e/src/
 * safeHost.ts) frames the dapp from the Safe web app's origin, and the dapp then connects
 * through the real Safe connector, with the parameters every build registers, so the
 * route a Safe takes is the one under test.
 */
import { useEffect } from 'react';
import { createConfig, createConnector, http, useAccount, useConnect, useConnectors, type Config, type CreateConnectorFn } from 'wagmi';
import { sepolia } from 'viem/chains';
import { getAddress, type Address, type Chain, type EIP1193RequestFn } from 'viem';
import { safeAppConnector } from './wallet/config';

const E2E_MODE = import.meta.env.MODE === 'e2e';

export const E2E_WALLET: Address | undefined = E2E_MODE
	? (import.meta.env['VITE_E2E_WALLET'] as Address | undefined)
	: undefined;

/** A connector for one node-held account: reads answered locally, everything else forwarded. */
export function e2eWalletConnector(account: Address, rpc: string): CreateConnectorFn {
	const address = getAddress(account);
	const forward = async (method: string, params: unknown): Promise<unknown> => {
		const res = await fetch(rpc, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: params ?? [] }),
		});
		const body = (await res.json()) as { result?: unknown; error?: { code?: number; message: string; data?: unknown } };
		// Carry the code as a wallet provider would, so viem classes a 4001 as a user rejection.
		if (body.error) throw Object.assign(new Error(`${method}: ${body.error.message}`), { code: body.error.code, data: body.error.data });
		return body.result;
	};
	const chainId = async () => Number(await forward('eth_chainId', []));
	const request = (async ({ method, params }: { method: string; params?: unknown }) => {
		if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [address];
		if (method === 'wallet_switchEthereumChain') return null;
		return forward(method, params);
	}) as EIP1193RequestFn;
	const provider = { request };

	return createConnector(() => ({
		id: 'e2e-wallet',
		name: 'E2E wallet',
		type: 'e2e-wallet',
		async connect(parameters?: { chainId?: number; isReconnecting?: boolean; withCapabilities?: boolean }) {
			// wagmi types the account list as a conditional on `withCapabilities`; like wagmi's own
			// connectors, the value is built for both shapes and the generic satisfied with `never`.
			const accounts = parameters?.withCapabilities ? [{ address, capabilities: {} }] : [address];
			return { accounts: accounts as never, chainId: await chainId() };
		},
		async disconnect() {
			return;
		},
		async getAccounts() {
			return [address] as readonly Address[];
		},
		getChainId: chainId,
		async getProvider() {
			return provider;
		},
		async isAuthorized() {
			return true;
		},
		onAccountsChanged() {
			return;
		},
		onChainChanged() {
			return;
		},
		onDisconnect() {
			return;
		},
	}));
}

export function createE2EWalletConfig(rpc: string | undefined): Config {
	if (!E2E_WALLET) throw new Error('createE2EWalletConfig needs VITE_E2E_WALLET in e2e mode.');
	if (import.meta.env.PROD) throw new Error('The end-to-end wallet must never be part of a production build.');
	if (!rpc) throw new Error('VITE_SEPOLIA_RPC_URL must point at the local end-to-end node.');
	// The node presents Sepolia's chain id; the chain object's own RPC must point at it too.
	const localSepolia: Chain = { ...sepolia, rpcUrls: { default: { http: [rpc] } } };
	const framed = typeof window !== 'undefined' && window.self !== window.top;
	return createConfig({
		chains: [localSepolia],
		connectors: [framed ? safeAppConnector() : e2eWalletConnector(E2E_WALLET, rpc)],
		// One JSON-RPC batch per tick and one Multicall3 call per batch of reads, as in production.
		transports: { [sepolia.id]: http(rpc, { batch: true }) },
		batch: { multicall: true },
		// The local node mines instantly; a short poll keeps the UI in step with it.
		pollingInterval: 1_000,
	});
}

/** Connects the end-to-end wallet on mount, so no test clicks through a wallet modal. */
export function E2EAutoConnect() {
  const { mutate: connect } = useConnect();
  const connectors = useConnectors();
	const { status } = useAccount();
	useEffect(() => {
		const [connector] = connectors;
		if (status === 'disconnected' && connector) connect({ connector });
	}, [status, connectors, connect]);
	return null;
}
