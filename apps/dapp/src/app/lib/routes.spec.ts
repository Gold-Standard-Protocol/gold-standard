import { describe, expect, it } from 'vitest';
import { applyCanonical, applyDescription, canonicalUrl, ROUTE_DESCRIPTIONS, ROUTE_TITLES, routeDescription, routeTitle, SITE_ORIGIN } from './routes';

describe('canonicalUrl', () => {
	it('names the home page with its trailing slash', () => {
		expect(canonicalUrl('/')).toBe('https://goldstandard.finance/');
		expect(canonicalUrl('')).toBe(`${SITE_ORIGIN}/`);
	});

	it('names each route by its own path, not the home page', () => {
		expect(canonicalUrl('/vault')).toBe('https://goldstandard.finance/vault');
		expect(canonicalUrl('/docs/faq')).toBe('https://goldstandard.finance/docs/faq');
		expect(canonicalUrl('/vault/liquidate')).toBe('https://goldstandard.finance/vault/liquidate');
	});

	it('drops a trailing slash, a query and a hash, which name the same page', () => {
		expect(canonicalUrl('/docs/oracle/')).toBe('https://goldstandard.finance/docs/oracle');
		expect(canonicalUrl('/swap?from=gsusd#quote')).toBe('https://goldstandard.finance/swap');
	});
});

describe('routeTitle', () => {
	it('names the terms page in every build', () => {
		expect(routeTitle('/terms', false)).toBe('Terms · Gold Standard');
		expect(routeTitle('/terms', true)).toBe('Terms · Gold Standard');
	});

	it('names the ledger page only in a build that has it', () => {
		expect(routeTitle('/ledger', true)).toBe('Usage Ledger · Gold Standard');
		expect(routeTitle('/ledger', false)).toBeUndefined();
	});

	it('leaves every other route as it was, and the ledger page out of the live route list', () => {
		for (const enabled of [true, false]) {
			expect(routeTitle('/vault', enabled)).toBe('Vault · Gold Standard');
			expect(routeTitle('/docs/faq', enabled)).toBeUndefined();
		}
		expect(Object.keys(ROUTE_TITLES)).toEqual(['/', '/vault', '/vault/liquidate', '/pool', '/swap', '/transparency', '/terms']);
	});
});

describe('applyCanonical', () => {
	const documentWith = (head: string): Document => new DOMParser().parseFromString(`<html><head>${head}</head></html>`, 'text/html');

	it('points the canonical link at the current route', () => {
		const doc = documentWith('<link rel="canonical" href="https://goldstandard.finance/" />');
		applyCanonical(doc, '/docs/security');
		expect(doc.querySelector('link[rel="canonical"]')?.getAttribute('href')).toBe('https://goldstandard.finance/docs/security');
		applyCanonical(doc, '/');
		expect(doc.querySelector('link[rel="canonical"]')?.getAttribute('href')).toBe('https://goldstandard.finance/');
	});

	it('leaves a page without the link alone', () => {
		const doc = documentWith('');
		applyCanonical(doc, '/vault');
		expect(doc.querySelector('link[rel="canonical"]')).toBeNull();
	});
});

describe('routeDescription', () => {
	it('describes every route that has a title, each in its own words', () => {
		expect(Object.keys(ROUTE_DESCRIPTIONS)).toEqual(Object.keys(ROUTE_TITLES));
		const texts = Object.values(ROUTE_DESCRIPTIONS);
		expect(new Set(texts).size).toBe(texts.length);
	});

	it('keeps each description a length a search result shows whole, except the home page, which index.html fixes', () => {
		for (const [path, text] of Object.entries(ROUTE_DESCRIPTIONS)) {
			if (path === '/') continue;
			expect(text.length).toBeGreaterThanOrEqual(70);
			expect(text.length).toBeLessThanOrEqual(160);
		}
	});

	it('uses no contraction, no dash as punctuation and no exclamation mark', () => {
		for (const text of [...Object.values(ROUTE_DESCRIPTIONS), routeDescription('/ledger', true) ?? '']) {
			expect(text).not.toMatch(/n['’]t\b|[—–]|\s-\s|!/);
		}
	});

	it('does not present XAUT as collateral a visitor can use at launch', () => {
		for (const text of Object.values(ROUTE_DESCRIPTIONS).slice(1)) expect(text).not.toMatch(/XAUT/i);
	});

	it('describes the ledger page only in a build that has it, with the policy sentence', () => {
		expect(routeDescription('/ledger', false)).toBeUndefined();
		expect(routeDescription('/ledger', true)).toContain('No token exists, no token is promised');
	});

	it('leaves a docs route to the docs page, which describes itself', () => {
		expect(routeDescription('/docs/faq', true)).toBeUndefined();
	});
});

describe('applyDescription', () => {
	const documentWith = (head: string): Document => new DOMParser().parseFromString(`<html><head>${head}</head></html>`, 'text/html');

	it('sets the description of the current page', () => {
		const doc = documentWith('<meta name="description" content="home" />');
		applyDescription(doc, 'Vault page.');
		expect(doc.querySelector('meta[name="description"]')?.getAttribute('content')).toBe('Vault page.');
	});

	it('leaves the page alone when there is nothing to say or no tag to say it in', () => {
		const doc = documentWith('<meta name="description" content="home" />');
		applyDescription(doc, undefined);
		expect(doc.querySelector('meta[name="description"]')?.getAttribute('content')).toBe('home');
		const bare = documentWith('');
		applyDescription(bare, 'Vault page.');
		expect(bare.querySelector('meta[name="description"]')).toBeNull();
	});
});
