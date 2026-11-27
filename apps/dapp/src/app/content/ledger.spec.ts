import { describe, expect, it } from 'vitest';
import { LEDGER_COPY } from './ledger';

/** Every string the page can show: plain entries, and each sentence builder called with one and with several. */
function everyString(node: unknown): string[] {
	if (typeof node === 'string') return [node];
	if (typeof node === 'function') {
		const build = node as (...args: unknown[]) => unknown;
		return [1, 2].map((sample) => String(build(...Array.from({ length: build.length }, () => sample))));
	}
	if (typeof node === 'object' && node !== null) return Object.values(node).flatMap(everyString);
	return [];
}

const STRINGS = everyString(LEDGER_COPY);
/** The policy's sentence is the one place a token is named: to say that there is none. */
const OTHER_STRINGS = STRINGS.filter((text) => text !== LEDGER_COPY.disclaimer);

const FORBIDDEN: readonly [string, RegExp][] = [
	['airdrop', /air\s?drop/i],
	['points or a score', /\b(points?|scores?|scoring)\b/i],
	['earning', /\bearn\w*\b/i],
	// Spelled in parts so that a search of the tree for these words finds real uses only.
	['a campaign device', new RegExp(`\\b(${'multi' + 'plier'}|boost\\w*|bonus|${'refer' + 'r'}\\w*|season|campaign|tier)\\b`, 'i')],
	['a ranking', new RegExp(`\\b(${'leader' + 'board'}|ranking|ranked|top|standings?|compet\\w*|winner)\\b`, 'i')],
	['a reward or a distribution', /\b(rewards?|distribution|distributed|allocation|eligib\w*|claim\w*|redeem\w*)\b/i],
	['a hint of what comes later', /\b(future|soon|upcoming|stay tuned|snapshot|convert\w*|retroactive\w*)\b/i],
	['a combined figure', /\btotal\b/i],
	['a contraction', /\b(\w+n['’]t|it['’]s|that['’]s|there['’]s|what['’]s|let['’]s|\w+['’]re|\w+['’]ll|\w+['’]ve|\w+['’]d|i['’]m)\b/i],
	['an em or en dash', /[—–]/],
	['a hyphen used as a dash', /\s-\s|--/],
	['an exclamation mark', /!/],
];

describe('usage ledger copy', () => {
	it('covers every string of the page', () => {
		expect(STRINGS.length).toBeGreaterThan(30);
	});

	it.each(FORBIDDEN)('never contains %s', (_name, pattern) => {
		expect(STRINGS.filter((text) => pattern.test(text))).toEqual([]);
	});

	it('carries the disclaimer in the words of the token policy', () => {
		expect(LEDGER_COPY.disclaimer).toBe('No token exists, no token is promised, the ledger confers no rights and may never confer any.');
	});

	it('names a token nowhere but in the disclaimer', () => {
		expect(OTHER_STRINGS.filter((text) => /\btokens?\b/i.test(text))).toEqual([]);
	});

	it('names each dimension in its own unit', () => {
		expect(LEDGER_COPY.usage.gsusdDays).toBe('GSUSD-days');
		expect(LEDGER_COPY.usage.dollarDays).toBe('dollar-days');
		expect(LEDGER_COPY.about.debt).toContain('One GSUSD owed for one day is one GSUSD-day.');
	});

	it('says that the figures are kept apart and that nothing is weighted', () => {
		expect(LEDGER_COPY.usage.separate).toBe('Each figure stands alone. They are not added into one number.');
		expect(LEDGER_COPY.about.even).toBe('Every second counts the same, and no kind of usage is weighted above another.');
		expect(LEDGER_COPY.record.body).toContain('It ranks nobody, and no record is ever deleted.');
	});

	it('agrees in number with what it counts', () => {
		expect(LEDGER_COPY.record.count(1, '9', 'now')).toBe('It holds 1 address, recorded to block 9, now.');
		expect(LEDGER_COPY.record.count(240, '9', 'now')).toBe('It holds 240 addresses, recorded to block 9, now.');
	});

	it('ends every sentence with a full stop', () => {
		// The loading labels name a region for assistive technology and are not sentences.
		const labels: readonly string[] = [LEDGER_COPY.usage.loading, LEDGER_COPY.about.loading, LEDGER_COPY.record.loading];
		for (const text of STRINGS.filter((entry) => entry.split(' ').length > 5 && !labels.includes(entry))) {
			expect(text).toMatch(/\.$/);
		}
	});
});
