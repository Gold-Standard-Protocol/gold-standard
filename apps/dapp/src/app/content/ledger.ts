/**
 * All copy for the usage ledger page.
 *
 * ACCURACY RULE for this file (docs/TOKEN_POLICY.md section 2). The ledger is a record of
 * past usage and nothing else. The disclaimer below is the policy's own wording and is shown
 * on the page at all times. No other sentence here may name a token, or say or suggest that
 * a figure carries value, can be exchanged for anything, ranks a wallet among others or
 * leads to anything later. Every number shown beside this copy comes from the API; none is
 * written here. House style as in site.ts: no contractions and no dashes.
 */

const plural = (count: number | string, one: string, many: string): string => (Number(count) === 1 ? one : many);

export const LEDGER_COPY = {
	title: 'Usage Ledger',
	navLabel: 'Ledger',
	lead: 'The Gold Standard Usage Ledger is a record of how each address has used the protocol over time. It is computed from on-chain events alone, so anyone can recompute it.',
	// The policy's wording, shown on the page at all times and never behind a control.
	termsLink: 'Terms',
	termsNote: 'This sentence is part of the terms.',
	disclaimerTitle: 'What the ledger is not',
	disclaimer: 'No token exists, no token is promised, the ledger confers no rights and may never confer any.',

	states: {
		unavailable: 'The ledger is being recomputed from on-chain events. Check back shortly.',
		unreachable: 'The ledger service cannot be reached. Retrying.',
		off: 'The usage ledger is not running at present.',
		startsOn: (date: string) => `Recording starts on ${date}.`,
	},

	usage: {
		title: 'Your recorded usage',
		connect: 'Connect a wallet to see its record.',
		loading: 'Loading the record of this wallet',
		debt: 'Vault debt',
		pool: 'Stability pool deposit',
		liquidity: 'Liquidity in range',
		gsusdDays: 'GSUSD-days',
		dollarDays: 'dollar-days',
		debtNow: 'Debt held now',
		poolNow: 'Pool deposit held now',
		liquidityNow: 'Liquidity in range now',
		gsusd: 'GSUSD',
		dollars: 'USD',
		unreadBalance: 'Not readable',
		separate: 'Each figure stands alone. They are not added into one number.',
		none: 'Nothing is recorded for this wallet yet. A figure grows while the wallet owes GSUSD on a vault or keeps GSUSD in the stability pool.',
		noneWithLiquidity:
			'Nothing is recorded for this wallet yet. A figure grows while the wallet owes GSUSD on a vault, keeps GSUSD in the stability pool or holds a position that is in range in the GSUSD pool on Uniswap.',
		asOf: (block: string, time: string) => `Recorded to block ${block}, ${time}.`,
	},

	about: {
		title: 'What the ledger records',
		loading: 'Loading what the ledger records',
		debt: 'Vault debt: the GSUSD a wallet owes as principal, for every second it is owed. One GSUSD owed for one day is one GSUSD-day.',
		pool: 'Stability pool deposits: the GSUSD a wallet keeps in the pool, for every second it is there, in GSUSD-days.',
		liquidity:
			'Liquidity: positions in the GSUSD pool on Uniswap v3, in dollar-days. A position counts at the value it holds when GSUSD trades at one dollar, and only while the pool price is inside its range.',
		even: 'Every second counts the same, and no kind of usage is weighted above another.',
		startedOn: (date: string) => `Recording started on ${date}.`,
	},

	record: {
		title: 'The whole record',
		loading: 'Loading the state of the ledger',
		body: 'The ledger holds one record per address: its figures and its balances as of one block. The whole record is published as one file, in address order. It ranks nobody, and no record is ever deleted.',
		download: 'Download the whole record (CSV)',
		// The block the file is as of and the SHA-256 of its bytes, so a copy can be checked.
		fileAsOf: (block: string, time: string) => `The file is recorded to block ${block}, ${time}.`,
		hashLabel: 'SHA-256 of the file',
		preparing: 'The file is being prepared. Check back shortly.',
		verify: 'Anyone can recompute the file from the events of the contracts and compare its hash. The method is in docs/USAGE_LEDGER.md in the repository.',
		count: (addresses: number, block: string, time: string) =>
			`It holds ${addresses} ${plural(addresses, 'address', 'addresses')}, recorded to block ${block}, ${time}.`,
		incomplete: 'The ledger has reached its address limit, so usage of addresses beyond it is not recorded until the limit is raised. The file says so too.',
	},
} as const;
