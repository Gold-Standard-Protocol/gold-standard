import type { LedgerAccountResponse, LedgerStatusResponse, LedgerTerms } from '@goldstandard/trpc';
import type { QueryView } from './useLedger';

/** Fixtures for the ledger specs: the shapes the API sends, with figures chosen to be recognisable. */
export const WALLET = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
export const START = 1_794_571_200;

export const TERMS: LedgerTerms = { startTimestamp: START, liquidity: false };
/** The terms while liquidity is recorded as the third dimension. */
export const LIQUIDITY_TERMS: LedgerTerms = { ...TERMS, liquidity: true };

export type OkAccount = Extract<LedgerAccountResponse, { status: 'ok' }>;
export type OkStatus = Extract<LedgerStatusResponse, { status: 'ok' }>;

export const SHA256 = '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08';

/** What describes the downloadable file, as the status answer carries it. */
export const RECORD: NonNullable<OkStatus['record']> = {
	chainId: 11155111,
	vault: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
	startTimestamp: START,
	liquidity: false,
	asOfBlock: '4321',
	asOfTimestamp: START + 86_400,
	records: 240,
	complete: true,
	sha256: SHA256,
	bytes: 31_337,
};

export const okAccount = (overrides: Partial<OkAccount> = {}): OkAccount => ({
	status: 'ok',
	address: WALLET,
	asOfBlock: '4321',
	asOfTimestamp: START + 86_400,
	usage: { debt: '3000.00', pool: '4500.25', liquidity: '0.00' },
	balances: { debt: '1000000000000000000000', poolDeposit: '500000000000000000000', liquidity: '0' },
	...overrides,
});

export const okStatus = (overrides: Partial<OkStatus> = {}): OkStatus => ({
	status: 'ok',
	terms: TERMS,
	asOfBlock: '4321',
	asOfTimestamp: START + 86_400,
	addresses: 240,
	incomplete: false,
	record: RECORD,
	...overrides,
});

/**
 * The words of a campaign, none of which may appear where the ledger is shown. They are
 * spelled in parts so that a search of the tree for them finds real uses only.
 */
export const CAMPAIGN_WORDS = new RegExp(
	['poi' + 'nts', 'earn', 'multi' + 'plier', 'refer' + 'r', 'leader' + 'board', 'ranked', 'ranking', 'bonus', 'season', 'reward'].join('|'),
	'i'
);

export const answered = <T>(data: T): QueryView<T> => ({ data, isLoading: false, isError: false });
export const loading = <T>(): QueryView<T> => ({ data: undefined, isLoading: true, isError: false });
export const failed = <T>(): QueryView<T> => ({ data: undefined, isLoading: false, isError: true });
