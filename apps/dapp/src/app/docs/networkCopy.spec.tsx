import { cleanup, render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The chain is fixed at build time, so a mainnet build must never
 * tell its visitors they are on Sepolia or a testnet. Every docs page, the contracts panel,
 * the site figures and the minimum debt advice are rendered as a mainnet build would.
 */
vi.mock('@goldstandard/constants', async (importOriginal) => ({
	...(await importOriginal<typeof import('@goldstandard/constants')>()),
	TARGET_CHAIN_ID: 1,
}));

const NETWORK_WORDS = /sepolia|testnet|test network/i;
/**
 * The other half: a mainnet build is live, so it never calls itself pre-launch
 * either. "Not yet deployed" is left out: the contracts page says it of an address that is
 * still zero, which is a live reading, not launch copy.
 */
const PRE_LAUNCH_WORDS = /pre-launch|not yet launched|not been deployed|not live on mainnet/i;

afterEach(cleanup);

describe('a mainnet build never names a test network', () => {
	it('uses mainnet wording in the network module', async () => {
		const network = await import('../lib/network');
		expect(network.IS_MAINNET_BUILD).toBe(true);
		expect(network.NETWORK_NAME).toBe('Ethereum mainnet');
		expect(network.networkNameFor(11155111)).toBe('Sepolia testnet');
	});

	it('renders every docs page without Sepolia or testnet', async () => {
		const { DOC_ITEMS } = await import('./registry');
		expect(DOC_ITEMS.length).toBeGreaterThan(10);
		for (const { slug, component: Page } of DOC_ITEMS) {
			const { container, unmount } = render(
				<MemoryRouter>
					<Page />
				</MemoryRouter>
			);
			expect(container.textContent?.match(NETWORK_WORDS)?.[0], slug).toBeUndefined();
			expect(container.textContent?.match(PRE_LAUNCH_WORDS)?.[0], slug).toBeUndefined();
			unmount();
		}
	});

	it('says the contracts panel verifies on Ethereum mainnet', async () => {
		const { ContractsPanel } = await import('../transparency/ContractsPanel');
		const { container } = render(<ContractsPanel />);
		expect(container.textContent).toMatch(/verifiable on Ethereum mainnet/);
		expect(container.textContent).not.toMatch(NETWORK_WORDS);
	});

	it('gives the mainnet figure in the site stats, the FAQ and the minimum debt advice', async () => {
		const site = await import('../content/site');
		expect(JSON.stringify(site)).not.toMatch(NETWORK_WORDS);
		const { describeTxError } = await import('../lib/txError');
		const { BaseError, ContractFunctionRevertedError } = await import('viem');
		const revert = new ContractFunctionRevertedError({ abi: [], functionName: 'mint', message: 'Below minimum debt' });
		Object.assign(revert, { reason: 'Below minimum debt' });
		const advice = describeTxError(new BaseError('mint reverted', { cause: revert }));
		expect(advice).toMatch(/1,000 GSUSD at the mainnet launch/);
		expect(advice).not.toMatch(NETWORK_WORDS);
	});

	it('tells a mainnet visitor where the contract addresses are listed, with no launch promise', async () => {
		const { default: FaqPage } = await import('./pages/FaqPage');
		const { container } = render(
			<MemoryRouter>
				<FaqPage />
			</MemoryRouter>
		);
		const text = container.textContent?.replace(/\s+/g, ' ') ?? '';
		expect(text).toContain('The contract addresses are listed on contracts.');
		expect(text).not.toMatch(/planned before mainnet launch|once deployed/i);
	});
});

