import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LedgerAccountResponse, LedgerStatusResponse } from '@goldstandard/trpc';
import LedgerPage from './LedgerPage';
import { answered, CAMPAIGN_WORDS, failed, LIQUIDITY_TERMS, loading, okAccount, okStatus, START, TERMS, WALLET } from './testSupport';
import type { QueryView } from './useLedger';

const state = vi.hoisted(() => ({
	address: undefined as string | undefined,
	status: undefined as unknown,
	account: undefined as unknown,
	accountAsked: [] as (string | undefined)[],
}));

vi.mock('wagmi', () => ({
	useConnection: () => ({ isConnected: state.address !== undefined, address: state.address }),
}));

vi.mock('./useLedger', () => ({
	useLedgerStatus: () => state.status,
	useLedgerAccount: (address: string | undefined) => {
		state.accountAsked.push(address);
		return state.account;
	},
}));

vi.mock('../components/Reveal', () => ({
	Reveal: ({ children }: { children: ReactNode }) => children,
}));

vi.mock('../components/ConnectButton', () => ({
	ConnectButton: () => <button type="button">Connect Wallet</button>,
}));

const open = () =>
	render(
		<MemoryRouter initialEntries={['/ledger']}>
			<LedgerPage />
		</MemoryRouter>
	);

const DISCLAIMER = 'No token exists, no token is promised, the ledger confers no rights and may never confer any.';

beforeEach(() => {
	state.address = WALLET;
	state.status = answered<LedgerStatusResponse>(okStatus()) satisfies QueryView<LedgerStatusResponse>;
	state.account = answered<LedgerAccountResponse>(okAccount());
	state.accountAsked = [];
	vi.useRealTimers();
});

afterEach(cleanup);

describe('LedgerPage', () => {
	it('opens with the title, the lead and the disclaimer, then the three cards in order', () => {
		open();
		expect(screen.getByRole('heading', { level: 1, name: 'Usage Ledger' })).toBeTruthy();
		expect(screen.getByText(/^The Gold Standard Usage Ledger is a record of how each address has used the protocol/)).toBeTruthy();
		expect(screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent)).toEqual([
			'What the ledger is not',
			'Your recorded usage',
			'What the ledger records',
			'The whole record',
		]);
		expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
	});

	it.each<[string, () => void]>([
		['with a wallet and figures', () => undefined],
		['with no wallet', () => { state.address = undefined; }],
		['while everything loads', () => { state.status = loading(); state.account = loading(); }],
		['while the ledger is off', () => { state.status = answered<LedgerStatusResponse>({ status: 'disabled' }); state.account = answered<LedgerAccountResponse>({ status: 'disabled' }); }],
		['while the ledger is recomputed', () => { state.status = answered<LedgerStatusResponse>({ status: 'unavailable', terms: TERMS }); state.account = answered<LedgerAccountResponse>({ status: 'unavailable' }); }],
		['when the service cannot be reached', () => { state.status = failed(); state.account = failed(); }],
	])('shows the disclaimer in plain text, in the policy wording, %s', (_name, arrange) => {
		arrange();
		open();
		const region = screen.getByTestId('ledger-disclaimer');
		expect(region.textContent).toContain(DISCLAIMER);
		// Plain text in the page: not a tooltip, not a dialog, not behind a control.
		expect(region.querySelector('button, details, [role="tooltip"], [aria-expanded]')).toBeNull();
		expect(region.querySelector('p')?.textContent).toBe(DISCLAIMER);
		expect(screen.getByRole('region', { name: 'What the ledger is not' })).toBe(region);
	});

	it('links the disclaimer to the terms it is part of, and the whole record to its download', () => {
		open();
		const terms = screen.getByTestId('ledger-terms-link');
		expect(terms.getAttribute('href')).toBe('/terms');
		expect(screen.getByTestId('ledger-disclaimer').contains(terms)).toBe(true);
		expect(screen.getByRole('link', { name: 'Download the whole record (CSV)' }).getAttribute('href')).toBe('/usage-ledger.csv');
	});

	it('offers no download when the service cannot be reached, and says so in the usual words', () => {
		state.status = failed();
		state.account = failed();
		open();
		expect(screen.queryByTestId('ledger-download')).toBeNull();
		expect(screen.getAllByText('The ledger service cannot be reached. Retrying.').length).toBeGreaterThan(0);
	});

	it('shows the wallet its own three separate figures and no other wallet', () => {
		state.status = answered<LedgerStatusResponse>(okStatus({ terms: LIQUIDITY_TERMS }));
		state.account = answered<LedgerAccountResponse>(okAccount({ usage: { debt: '3000.00', pool: '4500.25', liquidity: '12.50' } }));
		const { container } = open();
		expect(screen.getByTestId('ledger-figures').querySelectorAll(':scope > div')).toHaveLength(3);
		expect(state.accountAsked.every((asked) => asked === WALLET)).toBe(true);
		expect(screen.queryByRole('table')).toBeNull();
		expect(container.textContent).not.toMatch(/0x[0-9a-fA-F]{6}/);
	});

	it('carries none of the words of a campaign anywhere on the page', () => {
		state.status = answered<LedgerStatusResponse>(okStatus({ terms: LIQUIDITY_TERMS }));
		const { container } = open();
		expect(container.textContent).not.toMatch(CAMPAIGN_WORDS);
		expect(container.textContent).not.toMatch(/your rank|total/i);
		expect(container.querySelectorAll('input, textarea')).toHaveLength(0);
	});

	it('says nothing about liquidity anywhere on the page while the API does not record it', () => {
		const { container } = open();
		expect(container.textContent).not.toMatch(/liquidity|uniswap|dollar-days/i);
	});

	it('names liquidity in the record and in what is recorded once the API records it', () => {
		state.status = answered<LedgerStatusResponse>(okStatus({ terms: LIQUIDITY_TERMS }));
		const { container } = open();
		expect(container.textContent).toContain('Liquidity in range');
		expect(container.textContent).toContain('dollar-days');
		expect(screen.getByTestId('ledger-about-liquidity')).toBeTruthy();
	});

	it('keeps liquidity off the page while the status is loading, before the API has said whether it is recorded', () => {
		state.status = loading<LedgerStatusResponse>();
		state.account = answered<LedgerAccountResponse>(okAccount({ usage: { debt: '1.00', pool: '1.00', liquidity: '5.00' } }));
		const { container } = open();
		expect(container.textContent).not.toMatch(/liquidity|uniswap/i);
	});

	it('asks for no account while no wallet is connected, and offers to connect one', () => {
		state.address = undefined;
		open();
		expect(state.accountAsked.every((asked) => asked === undefined)).toBe(true);
		expect(screen.getByRole('button', { name: 'Connect Wallet' })).toBeTruthy();
	});

	it('says when recording starts while the start is still ahead', () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date((START - 3_600) * 1000));
		open();
		expect(screen.getAllByText('Recording starts on 13 Nov 2026, 12:00 UTC.').length).toBeGreaterThan(0);
	});

	it('shows no figure and no zero while the ledger is recomputed, and still says what it records', () => {
		state.status = answered<LedgerStatusResponse>({ status: 'unavailable', terms: TERMS });
		state.account = answered<LedgerAccountResponse>({ status: 'unavailable' });
		open();
		expect(screen.queryByTestId('ledger-figures')).toBeNull();
		expect(screen.getByText(/^Vault debt:/)).toBeTruthy();
		expect(screen.getAllByText('The ledger is being recomputed from on-chain events. Check back shortly.').length).toBe(2);
	});
});
