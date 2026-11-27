import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The in-app docs must describe the launch profile the contracts ship with. Mainnet
 * launches PAXG first under LAUNCH_CAPS=open (docs/ORACLE_IMPLEMENTATION_PLAN.md section
 * 4): no debt ceiling and no per-block mint cap, with XAUT registered in the oracle and
 * otherwise inactive, and the oracle bounding a manipulated price instead of a ceiling. No
 * page may describe the guarded ramp or the backstop as the launch plan. The AGENTS page is
 * generated from the agent manifest and is owned elsewhere, so only the oracle guard reads it.
 */
const pagesDir = resolve(__dirname, 'pages');
const allPages = readdirSync(pagesDir)
	.filter((name) => name.endsWith('Page.tsx'))
	.map((name) => ({ name, text: readFileSync(resolve(pagesDir, name), 'utf8') }));
const pages = allPages.filter((page) => page.name !== 'AgentsPage.tsx');
const pageText = (name: string) => allPages.find((page) => page.name === name)?.text ?? '';

const GUARDED_RAMP = [
	/guarded launch ramp/i,
	/guarded rollout/i,
	/guarded ramp/i,
	/doubl(es|ing) weekly/i,
	/ceiling (held |stays |is )?at zero/i,
	/ships at zero/i,
	/250,000 GSUSD/,
	/XAUT (ceiling|is) (stays|held|registered)[^.]*zero/i,
	/only PAXG carries/i,
	// The $5M backstop of LAUNCH_CAPS=backstop, superseded by the open profile.
	/5,000,000 GSUSD/,
	/backstop debt ceiling/i,
	/(?:under|with) a \$5M/i,
	/armed at mainnet launch/i,
];

describe('docs copy matches the open launch profile', () => {
	it('covers the docs pages', () => {
		expect(pages.length).toBeGreaterThan(10);
	});

	for (const page of pages) {
		it(`${page.name} does not describe the guarded ramp as the launch plan`, () => {
			const hits = GUARDED_RAMP.filter((pattern) => pattern.test(page.text)).map(String);
			expect(hits).toEqual([]);
		});
	}

	it('says mainnet launches with no debt ceiling where minting limits are explained', () => {
		for (const name of ['CollateralPage.tsx', 'MintingRedeemingPage.tsx', 'ParametersPage.tsx', 'FaqPage.tsx']) {
			const text = pages.find((page) => page.name === name)?.text ?? '';
			expect(text, name).toMatch(/no debt ceiling|None at mainnet launch/);
		}
	});

	it('says XAUT is inactive at launch where collateral and pricing are explained', () => {
		for (const name of ['OraclePage.tsx', 'CollateralPage.tsx']) {
			const text = pages.find((page) => page.name === name)?.text ?? '';
			expect(text, name).toMatch(/inactive/);
			expect(text, name).not.toMatch(/invisible to the oracle/);
		}
	});

	// The final oracle (variant C, docs/ORACLE_IMPLEMENTATION_PLAN.md section 3) has two
	// Chainlink sources and nothing else: no permissionless breaker, no recovery activation, no
	// confirmation band, no Pyth, no Uniswap pool or TWAP, no agreement band, no observed breach,
	// no descending liquidation floor and no depth record. The keeper's breaker, band breach and
	// depth observation alerts went with them.
	const RETIRED_ORACLE = [
		/tripCircuitBreaker/,
		/activateRecovery/,
		/confirmation band/i,
		/recovery (?:activation|delay|window)/i,
		/\bPyth\b/,
		/guardianUnpauseBreaker/,
		/spot proxy/i,
		/breaker-tripped/,
		/breaker-attempt-failed/,
		/quote-reverted/,
		/observeBand/,
		/quoteBreach/,
		/band-breach/,
		/MAX_OBSERVATION_GAP/,
		/quoteDepth/,
		/depth record/i,
		/depth-observation/,
		/quoteLiquidationFloor/,
		/(?<!partial )liquidation floor/i,
		/floor descent/i,
		/FloorDescent/,
		/\bUniswap\b/i,
		/PAXG\/WETH/,
		/\bTWAP\b/i,
		/confirming (?:pool|source)/i,
		/pool (?:confirms|confirmation)/i,
		/setConfirmationFeed/,
		/Feeds disagree/i,
		/agreement band/i,
		/AgreementBand/,
	];
	for (const page of allPages) {
		it(`${page.name} describes no retired oracle mechanism`, () => {
			const hits = RETIRED_ORACLE.filter((pattern) => pattern.test(page.text)).map(String);
			expect(hits).toEqual([]);
		});
	}

	it('states the variant C liquidation rule and the freeze lapse', () => {
		const oracle = pageText('OraclePage.tsx');
		expect(oracle).toMatch(/min\(max\(C, G\), G × \(1 \+ m\)\)/);
		expect(oracle).toMatch(/No reliable price/);
		expect(oracle).toMatch(/no\s+call, role or keeper step/);
		expect(oracle).toMatch(/never refused for the market feed being off the gold band/);
		expect(oracle).toMatch(/lapses after\s+14 days/);
	});

	it('documents the liquidation cap beside the gold band', () => {
		for (const name of ['OraclePage.tsx', 'ParametersPage.tsx', 'GovernancePage.tsx']) {
			const text = pageText(name);
			expect(text, name).toMatch(/liquidationClampPpm|setLiquidationClamp/);
			expect(text, name).toMatch(/0\.5% to 5%/);
		}
		expect(pageText('ParametersPage.tsx')).toMatch(/proposeLiquidationClampUpdate/);
	});

	it('says a depeg specific to PAXG is not liquidated', () => {
		for (const name of ['OraclePage.tsx', 'LiquidationsPage.tsx', 'SecurityPage.tsx']) {
			expect(pageText(name), name).toMatch(/depeg specific to PAXG is not liquidated/);
		}
	});

	it('uses no dash characters in prose', () => {
		for (const page of pages) {
			expect(page.text, page.name).not.toMatch(/[\u2013\u2014]/);
		}
	});
});

const siteText = readFileSync(resolve(__dirname, '../content/site.ts'), 'utf8');
const prose = [...pages, { name: 'site.ts', text: siteText }];

const CONTRACTION = /\b(?:don|doesn|isn|aren|can|won|it|that|you|we|they|there|didn|wasn|haven|hasn|wouldn|couldn|shouldn|let)(?:'|\u2019|&rsquo;|&apos;)(?:t|s|re|ll|ve|d)\b/i;
const OXFORD_COMMA = /[A-Za-z0-9]+, [A-Za-z0-9]+, (?:and|or) [a-z]/;
const BUZZWORD = /\b(?:unlock(?:s|ing)?|seamless(?:ly)?|revolutionary|cutting-edge|empower(?:s|ed|ing)?|elevate[sd]?|next-generation|effortless(?:ly)?|leverag(?:e|es|ed|ing))\b/i;

describe('docs copy follows the house style', () => {
	for (const { name, text } of prose) {
		it(`${name} has no contractions, short-list Oxford commas or buzzwords`, () => {
			expect(text.match(CONTRACTION)?.[0], 'contraction').toBeUndefined();
			expect(text.match(OXFORD_COMMA)?.[0], 'Oxford comma').toBeUndefined();
			expect(text.match(BUZZWORD)?.[0], 'buzzword').toBeUndefined();
		});
	}

	it('never gives the Sepolia minimum debt without the mainnet figure beside it', () => {
		for (const page of pages) {
			if (/100 GSUSD on Sepolia/.test(page.text)) {
				expect(page.text, page.name).toMatch(/1,000/);
			}
		}
	});
});

/**
 * Statements the docs must not make because they go stale or were never true of a release:
 * a process that is not what stands behind a release, a count that changes with the next
 * commit, a keeper job that does not exist and a token fee that no longer exists.
 */
describe('docs copy states the testing and keeper facts as they are', () => {
	const security = pageText('SecurityPage.tsx');

	const FALSE_OR_STALE = [
		// The contracts are deployed wherever a build runs, so the addresses are simply listed.
		/once deployed/i,
		// Continuous integration is not what stands behind a release; the runs before each release are.
		/continuous integration/i,
		/\bin CI\b/,
		/on every change/i,
		// Test counts go stale with the next commit.
		/\b\d+ (?:behavioural|property-based|invariants?|fuzz|tests?)\b/i,
		/including \d+ invariants/i,
		// The keeper has no fee-accrual job.
		/(?:and|,) accrues (?:stability )?fees/i,
		// PAXG has had no fee mechanism since Paxos removed it in June 2026.
		/carries a fee-on-transfer mechanism/i,
		/currently\s+holds at zero/i,
	];
	for (const page of allPages) {
		it(`${page.name} makes no false or stale claim about testing or the keeper`, () => {
			const hits = FALSE_OR_STALE.filter((pattern) => pattern.test(page.text)).map(String);
			expect(hits).toEqual([]);
		});
	}

	it('describes how the suites and static analysis are run without citing counts', () => {
		expect(security).toContain('are run before each release. A release requires Slither to report nothing at medium or high severity.');
		expect(security).toContain("title: 'Slither and Solhint before each release'");
	});

	it('says the keeper runs no fee job', () => {
		expect(security).toMatch(/It runs no fee job/);
		expect(pageText('GlossaryPage.tsx')).toMatch(/It runs no fee job/);
	});

	it('says the underwater discount is split like the penalty, 60% to the liquidator', () => {
		const liquidations = pageText('LiquidationsPage.tsx');
		expect(liquidations).toMatch(/That discount is split like the penalty: 60% of it\s+goes to the liquidator and 40% to the protocol/);
		expect(liquidations).toMatch(/at most 1\.2% of the gold&rsquo;s value at launch, not 2%/);
	});

	it('says PAXG has no transfer fee today and that the protocol still measures what arrives', () => {
		const collateral = pageText('CollateralPage.tsx');
		expect(collateral).toMatch(/PAXG has no transfer fee today: Paxos removed the fee mechanism\s+from the token in its June 2026 upgrade/);
		expect(collateral).toMatch(/upgradeable\s+proxy/);
		expect(collateral).toMatch(/still measures what arrives/);
	});
});

