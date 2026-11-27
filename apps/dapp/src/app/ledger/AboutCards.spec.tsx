import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { LedgerStatusResponse } from '@goldstandard/trpc';
import { AboutCard, RecordCard } from './AboutCards';
import { answered, CAMPAIGN_WORDS, failed, LIQUIDITY_TERMS, loading, okStatus, SHA256, START, TERMS } from './testSupport';

afterEach(cleanup);

const DAY = 86_400;
const about = (status: Parameters<typeof AboutCard>[0]['status'], nowSeconds = START + DAY) =>
	render(<AboutCard status={status} nowSeconds={nowSeconds} />);

describe('AboutCard', () => {
	it('says what each dimension records, in its own unit, and that nothing is weighted', () => {
		const { container } = about(answered<LedgerStatusResponse>(okStatus()));
		expect(screen.getByText(/^Vault debt: the GSUSD a wallet owes as principal/)).toBeTruthy();
		expect(screen.getByText(/^Stability pool deposits: the GSUSD a wallet keeps in the pool/)).toBeTruthy();
		expect(screen.getByText('Every second counts the same, and no kind of usage is weighted above another.')).toBeTruthy();
		expect(container.textContent).toContain('One GSUSD owed for one day is one GSUSD-day.');
	});

	it('states no rate, no schedule and no table of periods', () => {
		const { container } = about(answered<LedgerStatusResponse>(okStatus()));
		expect(screen.queryByRole('table')).toBeNull();
		expect(container.textContent).not.toMatch(CAMPAIGN_WORDS);
		expect(container.textContent).not.toMatch(/\dx\b/);
	});

	it('says nothing about liquidity while that dimension is off', () => {
		const { container } = about(answered<LedgerStatusResponse>(okStatus()));
		expect(container.textContent).not.toMatch(/liquidity|uniswap|in range/i);
		expect(screen.queryByTestId('ledger-about-liquidity')).toBeNull();
	});

	it('describes liquidity, valued at the peg and in range only, while that dimension is on', () => {
		about(answered<LedgerStatusResponse>(okStatus({ terms: LIQUIDITY_TERMS })));
		expect(screen.getByTestId('ledger-about-liquidity').textContent).toBe(
			'Liquidity: positions in the GSUSD pool on Uniswap v3, in dollar-days. A position counts at the value it holds when GSUSD trades at one dollar, and only while the pool price is inside its range.'
		);
	});

	it('says when recording started, or when it starts while it has not', () => {
		about(answered<LedgerStatusResponse>(okStatus()));
		expect(screen.getByTestId('ledger-start').textContent).toBe('Recording started on 13 Nov 2026, 12:00 UTC.');
		cleanup();
		about(answered<LedgerStatusResponse>(okStatus()), START - DAY);
		expect(screen.getByTestId('ledger-start').textContent).toBe('Recording starts on 13 Nov 2026, 12:00 UTC.');
	});

	it('still says what is recorded while the figures are recomputed', () => {
		about(answered<LedgerStatusResponse>({ status: 'unavailable', terms: TERMS }));
		expect(screen.getByText(/^Vault debt:/)).toBeTruthy();
	});

	it.each<[string, Parameters<typeof AboutCard>[0]['status'], string]>([
		['off', answered<LedgerStatusResponse>({ status: 'disabled' }), 'The usage ledger is not running at present.'],
		['unreachable', failed(), 'The ledger service cannot be reached. Retrying.'],
	])('shows a sentence and no number when %s', (_name, status, sentence) => {
		const { container } = about(status);
		expect(screen.getByText(sentence)).toBeTruthy();
		expect(container.textContent).not.toMatch(/\d/);
	});

	it('announces loading', () => {
		about(loading());
		expect(screen.getByRole('status', { name: 'Loading what the ledger records' })).toBeTruthy();
		expect(screen.getAllByRole('status')).toHaveLength(1);
	});
});

describe('RecordCard', () => {
	const URL = 'https://api.example/usage-ledger.csv';
	const record = (status: Parameters<typeof RecordCard>[0]['status']) => render(<RecordCard status={status} downloadUrl={URL} />);

	it('says the whole record is published as one file in address order, that nothing is deleted, and how to check it', () => {
		record(answered<LedgerStatusResponse>(okStatus()));
		expect(screen.getByText(/The whole record is published as one file, in address order\. It ranks nobody, and no record is ever deleted\.$/)).toBeTruthy();
		expect(screen.getByText(/^Anyone can recompute the file from the events of the contracts and compare its hash\./)).toBeTruthy();
		expect(screen.getByTestId('ledger-count').textContent).toBe('It holds 240 addresses, recorded to block 4321, 14 Nov 2026, 12:00 UTC.');
	});

	it('links to the download on the API, as a file to save', () => {
		record(answered<LedgerStatusResponse>(okStatus()));
		const link = screen.getByRole('link', { name: 'Download the whole record (CSV)' });
		expect(link.getAttribute('href')).toBe(URL);
		expect(link.hasAttribute('download')).toBe(true);
		expect(screen.getByTestId('ledger-download')).toBe(link);
	});

	it('shows the block the file is as of and the whole hash of its bytes', () => {
		record(answered<LedgerStatusResponse>(okStatus()));
		const facts = screen.getByTestId('ledger-file');
		expect(facts.textContent).toContain('The file is recorded to block 4321, 14 Nov 2026, 12:00 UTC.');
		expect(facts.textContent).toContain(`SHA-256 of the file: ${SHA256}`);
		// A 64 character hash must wrap inside a phone-width card.
		expect(facts.querySelector('.break-all')?.textContent).toBe(SHA256);
		// Shown as sha256sum prints it, never forced to capitals.
		expect(facts.querySelector('.label-mono')).toBeNull();
	});

	it('keeps the link and says the file is being prepared while the API has no hash for it yet', () => {
		record(answered<LedgerStatusResponse>(okStatus({ record: null })));
		expect(screen.getByRole('link', { name: 'Download the whole record (CSV)' })).toBeTruthy();
		expect(screen.getByText('The file is being prepared. Check back shortly.')).toBeTruthy();
		expect(screen.queryByTestId('ledger-file')).toBeNull();
	});

	it('lists no wallet and no table', () => {
		const { container } = record(answered<LedgerStatusResponse>(okStatus()));
		expect(screen.queryByRole('table')).toBeNull();
		expect(container.textContent).not.toMatch(/0x[0-9a-fA-F]{4}/);
	});

	it('says so when the address limit was reached', () => {
		record(answered<LedgerStatusResponse>(okStatus({ incomplete: true })));
		expect(screen.getByTestId('ledger-incomplete').textContent).toBe(
			'The ledger has reached its address limit, so usage of addresses beyond it is not recorded until the limit is raised. The file says so too.'
		);
		cleanup();
		record(answered<LedgerStatusResponse>(okStatus()));
		expect(screen.queryByTestId('ledger-incomplete')).toBeNull();
	});

	it('shows no link, no count and no hash while the ledger is recomputed', () => {
		const { container } = record(answered<LedgerStatusResponse>({ status: 'unavailable', terms: TERMS }));
		expect(screen.queryByTestId('ledger-count')).toBeNull();
		expect(screen.queryByRole('link')).toBeNull();
		expect(container.textContent).toContain('The ledger is being recomputed from on-chain events.');
	});

	it.each<[string, Parameters<typeof RecordCard>[0]['status'], string]>([
		['off', answered<LedgerStatusResponse>({ status: 'disabled' }), 'The usage ledger is not running at present.'],
		['unreachable', failed(), 'The ledger service cannot be reached. Retrying.'],
	])('shows one sentence and no link when %s', (_name, status, sentence) => {
		record(status);
		expect(screen.getByText(sentence)).toBeTruthy();
		expect(screen.queryByRole('link')).toBeNull();
	});

	it('announces loading', () => {
		record(loading());
		expect(screen.getByRole('status', { name: 'Loading the state of the ledger' })).toBeTruthy();
		expect(screen.queryByRole('link')).toBeNull();
	});
});
