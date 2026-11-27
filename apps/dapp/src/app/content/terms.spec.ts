import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TERMS_COPY, type TermsStatement } from './terms';

/** The repository root, from this file at apps/dapp/src/app/content. */
const ROOT = resolve(__dirname, '../../../../..');

/** A source as plain text: tags, JSX spacers, Markdown marks and typographic quotes removed, whitespace collapsed. */
function plain(text: string): string {
	return text
		.replace(/\{' '\}/g, ' ')
		// Simple tags only: a component written with props in braces holds text this must keep.
		.replace(/<\/?[A-Za-z][A-Za-z0-9]*(\s[^<>{}]*)?\/?>/g, '')
		.replace(/&rsquo;|&lsquo;|[‘’]/g, "'")
		.replace(/&ldquo;|&rdquo;|[“”]/g, '"')
		.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
		.replace(/\*\*|`/g, '')
		.replace(/\s+/g, ' ')
		.toLowerCase();
}

const sources = new Map<string, string>();
const sourceText = (path: string): string => {
	const cached = sources.get(path);
	if (cached !== undefined) return cached;
	const text = plain(readFileSync(resolve(ROOT, path), 'utf8'));
	sources.set(path, text);
	return text;
};

const { software, isNot, risks, ownRisk, license, ledger } = TERMS_COPY;

const statements: TermsStatement[] = [
	...software.statements,
	isNot.after,
	{ text: isNot.lead, source: isNot.source },
	...isNot.items.map((text) => ({ text, source: isNot.source })),
	risks.lead,
	...risks.items.flatMap((risk) => [
		{ text: risk.name, source: risks.source },
		{ text: risk.text, source: risks.source },
	]),
	...risks.experimentalFragments.map((text) => ({ text, source: risks.source })),
	risks.others,
	{ text: risks.readBefore, source: risks.source },
	...license.statements,
	...ledger.statements,
	ledger.clause,
];

describe('terms copy', () => {
	it.each(statements.map((statement) => [statement.text.slice(0, 70), statement] as const))(
		'is published, word for word, in its source: %s',
		(_name, statement) => {
			expect(sourceText(statement.source)).toContain(plain(statement.text));
		}
	);

	it('carries the Usage Ledger clause in the exact words of the token policy and of the ledger page', async () => {
		expect(ledger.clause.text).toBe('No token exists, no token is promised, the ledger confers no rights and may never confer any.');
		const { LEDGER_COPY } = await import('./ledger');
		expect(ledger.clause.text).toBe(LEDGER_COPY.disclaimer);
	});

	it('builds the experimental sentence from the fragments the security page holds', () => {
		expect(risks.experimental(false)).toBe('This is experimental software.');
		expect(risks.experimental(true)).toBe('This is experimental, pre-launch software.');
	});

	it('sends the reader to the three pages the security page names, in its order', () => {
		// The links are tags in the source, which `plain` removes: look in the file as written.
		const raw = readFileSync(resolve(ROOT, risks.source), 'utf8');
		const positions = risks.readLinks.map((link) => raw.lastIndexOf(`<Link to="${link.to}">${link.label}</Link>`));
		expect(positions.every((position) => position > 0)).toBe(true);
		expect([...positions].sort((a, b) => a - b)).toEqual(positions);
	});

	it('states the four conditions written for the page, and only those', () => {
		const text = ownRisk.statements.join(' ');
		expect(ownRisk.statements).toHaveLength(5);
		expect(text).toMatch(/at your own risk/);
		expect(text).toMatch(/without warranty of any kind/);
		expect(text).toMatch(/No yield, return or profit is promised/);
		expect(text).toMatch(/not liable/);
	});

	it('keeps warranty and liability wording inside that one section', () => {
		const { ownRisk: _written, ...sourced } = TERMS_COPY;
		const everythingSourced = JSON.stringify(sourced, (_key, value: unknown) =>
			typeof value === 'function' ? String((value as (flag: boolean) => string)(true)) : value
		);
		expect(everythingSourced).not.toMatch(/liabilit|liable|warrant|indemn/i);
	});

	it('leaves out what the page does not state: governing law, venue, eligibility, an offering entity and any agreement', () => {
		const everything = JSON.stringify(TERMS_COPY, (_key, value: unknown) =>
			typeof value === 'function' ? String((value as (flag: boolean) => string)(true)) : value
		);
		expect(everything).not.toMatch(/governing law|jurisdiction|venue|eligib|arbitrat|indemn|sanction|shall|hereby|you agree|by using/i);
	});

	it('uses no contraction, no dash as punctuation and no exclamation mark in the words written for the page', () => {
		for (const text of [TERMS_COPY.lead, risks.more, isNot.title, software.title, risks.title, license.title, ledger.title, ownRisk.title, ...ownRisk.statements]) {
			expect(text).not.toMatch(/n['’]t\b|[—–]|\s-\s|!/);
		}
	});
});
