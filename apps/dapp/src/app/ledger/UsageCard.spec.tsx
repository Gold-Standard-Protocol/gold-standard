import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LedgerAccountResponse } from '@goldstandard/trpc';
import { UsageCard } from './UsageCard';
import { answered, CAMPAIGN_WORDS, failed, loading, okAccount, WALLET } from './testSupport';

vi.mock('../components/ConnectButton', () => ({
	ConnectButton: () => <button type="button">Connect Wallet</button>,
}));

afterEach(cleanup);

const NO_WALLET = 'none';

const view = (account: Parameters<typeof UsageCard>[0]['account'], address: typeof WALLET | typeof NO_WALLET = WALLET, startsOn?: string) =>
	render(<UsageCard address={address === NO_WALLET ? undefined : address} account={account} startsOn={startsOn} />);

const rows = (testId: string): (string | null)[] => [...screen.getByTestId(testId).querySelectorAll(':scope > div')].map((row) => row.textContent);

describe('UsageCard', () => {
	it('asks for a wallet, with the connect control, when none is connected', () => {
		const { container } = view(loading(), NO_WALLET);
		expect(screen.getByText('Connect a wallet to see its record.')).toBeTruthy();
		expect(screen.getByRole('button', { name: 'Connect Wallet' })).toBeTruthy();
		expect(container.textContent).not.toMatch(/\d/);
	});

	it('announces loading and shows no figure', () => {
		const { container } = view(loading());
		expect(screen.getByRole('status', { name: 'Loading the record of this wallet' })).toBeTruthy();
		expect(screen.getAllByRole('status')).toHaveLength(1);
		expect(container.textContent).not.toMatch(/\d/);
	});

	it('says the service cannot be reached when the request failed', () => {
		const { container } = view(failed());
		expect(screen.getByText('The ledger service cannot be reached. Retrying.')).toBeTruthy();
		expect(container.textContent).not.toMatch(/\d/);
	});

	it('never shows a zero while the ledger is recomputed', () => {
		const { container } = view(answered<LedgerAccountResponse>({ status: 'unavailable' }));
		expect(screen.getByText('The ledger is being recomputed from on-chain events. Check back shortly.')).toBeTruthy();
		expect(container.textContent).not.toMatch(/\d/);
		expect(screen.queryByTestId('ledger-figures')).toBeNull();
	});

	it('says the ledger is not running when the API has it off', () => {
		view(answered<LedgerAccountResponse>({ status: 'disabled' }));
		expect(screen.getByText('The usage ledger is not running at present.')).toBeTruthy();
	});

	it('shows each dimension in its own unit, the balances behind them and the block they are recorded to', () => {
		view(answered<LedgerAccountResponse>(okAccount()));
		expect(rows('ledger-figures')).toEqual(['Vault debt3,000.00GSUSD-days', 'Stability pool deposit4,500.25GSUSD-days']);
		expect(rows('ledger-balances')).toEqual(['Debt held now1,000.00GSUSD', 'Pool deposit held now500.00GSUSD']);
		expect(screen.getByText('Recorded to block 4321, 14 Nov 2026, 12:00 UTC.')).toBeTruthy();
	});

	it('shows no sum of the figures, no rank and no word of a campaign, and says the figures stand alone', () => {
		const { container } = view(answered<LedgerAccountResponse>(okAccount()));
		expect(screen.getByText('Each figure stands alone. They are not added into one number.')).toBeTruthy();
		// 3,000.00 and 4,500.25 would add up to 7,500.25: it is nowhere on the card.
		expect(container.textContent).not.toContain('7,500.25');
		expect(container.textContent).not.toMatch(CAMPAIGN_WORDS);
		expect(container.textContent).not.toMatch(/total|rank/i);
	});

	it('shows nothing about liquidity while that dimension is off, whatever the answer carries', () => {
		const account = okAccount({
			usage: { debt: '3000.00', pool: '4500.25', liquidity: '9.99' },
			balances: { debt: '1000000000000000000000', poolDeposit: '500000000000000000000', liquidity: '2000000000000000000000' },
		});
		const { container } = view(answered<LedgerAccountResponse>(account));
		expect(container.textContent).not.toMatch(/liquidity|dollar/i);
		expect(rows('ledger-figures')).toHaveLength(2);
	});

	it('shows liquidity as a third dimension in dollar-days, with the value in range now, while it is on', () => {
		const account = okAccount({
			usage: { debt: '3000.00', pool: '4500.25', liquidity: '10000.50' },
			balances: { debt: '1000000000000000000000', poolDeposit: '500000000000000000000', liquidity: '2000500000000000000000' },
		});
		render(<UsageCard address={WALLET} account={answered<LedgerAccountResponse>(account)} liquidity />);
		expect(rows('ledger-figures')).toEqual([
			'Vault debt3,000.00GSUSD-days',
			'Stability pool deposit4,500.25GSUSD-days',
			'Liquidity in range10,000.50dollar-days',
		]);
		expect(rows('ledger-balances')[2]).toBe('Liquidity in range now2,000.50USD');
	});

	it('says in words that nothing is recorded yet, beside the real zeros', () => {
		const zero = okAccount({ usage: { debt: '0.00', pool: '0.00', liquidity: '0.00' }, balances: { debt: '0', poolDeposit: '0', liquidity: '0' } });
		const { container } = view(answered<LedgerAccountResponse>(zero));
		expect(container.textContent).toContain('Nothing is recorded for this wallet yet.');
		expect(container.textContent).not.toContain('Uniswap');
		expect(rows('ledger-figures')).toEqual(['Vault debt0.00GSUSD-days', 'Stability pool deposit0.00GSUSD-days']);
	});

	it('names liquidity among the kinds of usage for a wallet with nothing yet, only while that dimension is on', () => {
		const zero = okAccount({ usage: { debt: '0.00', pool: '0.00', liquidity: '0.00' }, balances: { debt: '0', poolDeposit: '0', liquidity: '0' } });
		const { container } = render(<UsageCard address={WALLET} account={answered<LedgerAccountResponse>(zero)} liquidity />);
		expect(container.textContent).toContain('holds a position that is in range in the GSUSD pool on Uniswap.');
	});

	it('does not call a wallet empty for a liquidity figure the page does not show', () => {
		const hidden = okAccount({ usage: { debt: '0.00', pool: '0.00', liquidity: '5.00' }, balances: { debt: '0', poolDeposit: '0', liquidity: '0' } });
		const { container } = view(answered<LedgerAccountResponse>(hidden));
		expect(container.textContent).toContain('Nothing is recorded for this wallet yet.');
	});

	it('says when recording starts while it has not', () => {
		view(answered<LedgerAccountResponse>(okAccount()), WALLET, 'Recording starts on 13 Nov 2026, 12:00 UTC.');
		expect(screen.getByText('Recording starts on 13 Nov 2026, 12:00 UTC.')).toBeTruthy();
	});

	it('does not print a balance it cannot read', () => {
		const { container } = view(answered<LedgerAccountResponse>(okAccount({ balances: { debt: 'NaN', poolDeposit: '500000000000000000000', liquidity: '0' } })));
		expect(container.textContent).toContain('Debt held nowNot readable');
		expect(container.textContent).not.toContain('NaN');
	});

	it('names the card with a second level heading', () => {
		view(answered<LedgerAccountResponse>(okAccount()));
		expect(screen.getByRole('heading', { level: 2, name: 'Your recorded usage' })).toBeTruthy();
	});
});
