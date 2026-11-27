/**
 * All copy for the Terms page.
 *
 * ACCURACY RULE for this file. Apart from the one section named below, nothing here is
 * new. Every statement is one the project already publishes, word for word, in the document
 * or page named beside it, and terms.spec.ts reads each source and fails when a statement no
 * longer appears there. To change a statement, change its source first and copy the new
 * wording here.
 *
 * The exception is `ownRisk`: four conditions written for this page (use at the user's own
 * risk, no warranty, no promise of yield, limitation of liability). The page states nothing
 * about governing law, venue, eligibility or an offering entity, and terms.spec.ts fails if
 * such wording appears. The other clause that has no source page is the Usage Ledger
 * disclaimer, in the token policy's own words.
 *
 * `source` is a path from the repository root. `fragments`, where given, are the pieces of
 * a sentence whose source splits it (a build-time condition sits in the middle).
 */

export interface TermsStatement {
	text: string;
	source: string;
	/** The pieces to look for in the source when the sentence is not one unbroken string there. */
	fragments?: readonly string[];
}

const README = 'README.md';
const SITE = 'apps/dapp/src/app/content/site.ts';
const INTRODUCTION = 'apps/dapp/src/app/docs/pages/IntroductionPage.tsx';
const SECURITY = 'apps/dapp/src/app/docs/pages/SecurityPage.tsx';
const POLICY = 'docs/TOKEN_POLICY.md';

export const TERMS_COPY = {
	title: 'Terms',
	// Says what the page is. It makes no statement about the protocol.
	lead: 'What the project states about its software, its risks, its license and the Usage Ledger, gathered here from its own documents and pages, and the conditions on which the software is offered.',

	software: {
		title: 'What the software is',
		statements: [
			{ text: 'Gold Standard Protocol runs the smart contracts.', source: README },
			{
				text: 'GSUSD ("Gold Standard Dollar") is an ERC-20 stablecoin minted against over-collateralised deposits of tokenised gold.',
				source: README,
			},
			{ text: 'Everything runs on open, non-custodial smart contracts.', source: INTRODUCTION },
			{
				text: 'It is non-custodial. Your collateral sits in open-source smart contracts that release it only to you, or to a liquidator if your vault falls below the 110% liquidation ratio. Gold Standard never takes custody of your gold or your GSUSD.',
				source: SITE,
			},
			{
				text: 'A vault needs a collateral ratio of at least 130% to mint or withdraw. If a vault falls below the 110% liquidation threshold, anyone can repay its debt and claim its gold at a discount, which keeps the system solvent without a central operator.',
				source: SITE,
			},
		] satisfies TermsStatement[],
	},

	isNot: {
		title: 'What GSUSD is not',
		// The heading of the column these four entries stand under in the introduction.
		lead: 'GSUSD is not',
		source: INTRODUCTION,
		items: [
			'A claim on a bank deposit or any fiat reserve account',
			'A repackaging of US dollars or money-market instruments',
			'A custodial IOU that depends on an issuer honouring withdrawals',
			'A guarantee of value; gold can fall sharply and depeg the unit',
		],
		after: { text: 'Nothing in this documentation is financial advice.', source: SECURITY } satisfies TermsStatement,
	},

	risks: {
		title: 'Risks',
		lead: { text: 'Some risks cannot be engineered away and are stated plainly so that you can weigh them.', source: SECURITY } satisfies TermsStatement,
		source: SECURITY,
		items: [
			{
				name: 'Smart-contract risk.',
				text: 'Bugs may remain despite testing. A bug could cause the loss of some or all of the funds held in the contracts.',
			},
			{
				name: 'Counterparty and custody risk.',
				text: "PAXG depends on Paxos honouring custody and not freezing the protocol's addresses, and XAUT will depend on Tether once activated. Silos raise the cost of a freeze; a second issuer would reduce single-custodian exposure; neither removes the risk.",
			},
			{
				name: 'A depeg specific to PAXG.',
				text: 'Liquidation values PAXG at no less than the gold price, so if PAXG alone fell below gold while gold held, vaults would not be liquidated for it and GSUSD holders would carry the loss. Borrowing and reserve swaps stop while PAXG is off the gold band. This is an accepted trade-off.',
			},
			{
				name: 'Oracle outage.',
				text: 'If either Chainlink feed stops, every priced path for the token waits, liquidation included, until both answer again. Repayment and deposits stay open.',
			},
			{
				name: 'Regulatory action.',
				text: 'Regulatory intervention against an issuer or the protocol could affect collateral or operations.',
			},
			{
				name: 'MEV on small swaps.',
				text: "Small stability swaps can be exposed to value extraction by block producers; the caller's minGoldOut bound mitigates but does not eliminate this.",
			},
			{
				name: 'Tail-event depeg.',
				text: 'If the gold price were to fall more than 50% within minutes, liquidations might not keep pace and the peg could come under strain.',
			},
		],
		// The security page sets ", pre-launch" between the two fragments in a build that is not for mainnet.
		experimental: (preLaunch: boolean) => `This is experimental${preLaunch ? ', pre-launch' : ''} software.`,
		experimentalFragments: ['This is experimental', ', pre-launch', 'software.'],
		others: { text: 'Interacting with it carries the risks above and others.', source: SECURITY } satisfies TermsStatement,
		// The same three pages the security page sends its reader to, in its words.
		readBefore: 'before depositing anything you cannot afford to lose.',
		readLinks: [
			{ label: 'Governance', to: '/docs/governance' },
			{ label: 'Oracle', to: '/docs/oracle' },
			{ label: 'Risk parameters', to: '/docs/parameters' },
		],
		more: 'The security page sets these out in full.',
		moreLink: { label: 'Security', to: '/docs/security' },
	},

	// Written for this page; see the rule at the top of the file.
	ownRisk: {
		title: 'Use at your own risk',
		statements: [
			'You use the software at your own risk.',
			'The software is provided as is and as available, without warranty of any kind, express or implied, including warranties of merchantability, fitness for a particular purpose and non-infringement.',
			'No yield, return or profit is promised. Minting or holding GSUSD, depositing in the stability pool and appearing in the Usage Ledger carry no promise of income.',
			'To the fullest extent the law allows, Gold Standard Protocol and its contributors are not liable for any loss or damage that arises from use of the software, including loss of collateral or GSUSD, liquidation, failed or delayed transactions and errors in the contracts, the interface or third-party services.',
			'Nothing here limits a liability that the law does not allow to be limited.',
		],
	},

	license: {
		title: 'License',
		statements: [
			{ text: 'Business Source License 1.1: see LICENSE and the additional use grants.', source: README },
			{
				text: 'Non-production use, testnet deployment, security research and integration are granted freely. Running a competing production deployment of this work, or a derivative of it, requires a commercial licence until the Change Date of 2030-08-28, after which each version converts automatically to GPL-2.0-or-later.',
				source: README,
			},
		] satisfies TermsStatement[],
	},

	ledger: {
		title: 'The Usage Ledger',
		statements: [
			{
				text: 'From mainnet block one, the protocol operates a Gold Standard Usage Ledger: a published, on-chain-verifiable record of time-weighted protocol usage per address.',
				source: POLICY,
			},
		] satisfies TermsStatement[],
		// The clause the policy makes part of the terms, in its exact words.
		clause: { text: 'No token exists, no token is promised, the ledger confers no rights and may never confer any.', source: POLICY } satisfies TermsStatement,
		pageLink: { label: 'Usage Ledger', to: '/ledger' },
	},
} as const;
