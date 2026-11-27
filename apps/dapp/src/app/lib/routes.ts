import { BRAND } from '../content/site';

/** Per-route document titles for SEO and browser history. Docs set their own. */
export const ROUTE_TITLES: Readonly<Record<string, string>> = {
	'/': 'Gold Standard · The dollar, back on the gold standard',
	'/vault': 'Vault · Gold Standard',
	'/vault/liquidate': 'Liquidations · Gold Standard',
	'/pool': 'Stability Pool · Gold Standard',
	'/swap': 'Swap · Gold Standard',
	'/transparency': 'Reserves · Gold Standard',
	'/terms': 'Terms · Gold Standard',
};

/**
 * The ledger page exists only in a build with VITE_LEDGER_ENABLED=true, so its title is kept
 * out of ROUTE_TITLES: that table is the list of routes every build has, which
 * public/sitemap.xml is checked against. A build with the page adds it to its own sitemap
 * (libs/constants/src/lib/sitemap.ts).
 */
const LEDGER_ROUTE = '/ledger';
const LEDGER_TITLE = 'Usage Ledger · Gold Standard';

/** The document title of a route, or undefined for a route that sets its own or does not exist. */
export function routeTitle(pathname: string, ledgerEnabled: boolean): string | undefined {
	if (pathname === LEDGER_ROUTE) return ledgerEnabled ? LEDGER_TITLE : undefined;
	return ROUTE_TITLES[pathname];
}

/**
 * Per-route descriptions for search results, one for every route in ROUTE_TITLES. The home
 * page's is the one index.html ships (publicFiles.spec.tsx holds the two equal), so returning
 * to it restores the text. Docs pages describe themselves from the docs registry.
 */
export const ROUTE_DESCRIPTIONS: Readonly<Record<string, string>> = {
	'/': 'Gold Standard lets you deposit tokenised gold (PAXG at launch, with XAUT to follow once activated) and mint GSUSD, the Gold Standard Dollar: a stablecoin over-collateralised by tokenised gold and convertible to protocol-owned gold through the Stability Reserve.',
	'/vault': 'Open a vault: deposit tokenised gold, mint GSUSD against it, repay and withdraw. Minting and withdrawing need a collateral ratio of at least 130%.',
	'/vault/liquidate': 'Vaults below the 110% liquidation threshold. Anyone can repay the debt of such a vault and claim its gold at a discount.',
	'/pool': 'Deposit GSUSD in the stability pool, which absorbs liquidated vaults. A deposit shrinks with each liquidation absorbed, is at risk and is not a savings balance.',
	'/swap': 'Swap GSUSD for protocol-owned gold through the Gold Stability Reserve, at the oracle price minus a spread of 0.5% to 5%.',
	'/transparency': 'The gold behind GSUSD, read from the contracts: collateral, supply, the peg, the reserve and the risk parameters, verifiable on-chain block by block.',
	'/terms': 'What Gold Standard states about its software, its risks, its license and the Usage Ledger, and the conditions on which the software is offered.',
};

const LEDGER_DESCRIPTION =
	'The Gold Standard Usage Ledger: a record of how each address has used the protocol over time. No token exists, no token is promised.';

/** The description of a route, or undefined for a route that sets its own or does not exist. */
export function routeDescription(pathname: string, ledgerEnabled: boolean): string | undefined {
	if (pathname === LEDGER_ROUTE) return ledgerEnabled ? LEDGER_DESCRIPTION : undefined;
	return ROUTE_DESCRIPTIONS[pathname];
}

/** Sets the page description. Without a description, or a tag to hold it, the page is left alone. */
export function applyDescription(doc: Document, description: string | undefined): void {
	if (description === undefined) return;
	doc.querySelector<HTMLMetaElement>('meta[name="description"]')?.setAttribute('content', description);
}

/**
 * The origin search engines are pointed at. The same bundle is served from the ENS gateway,
 * the mirror and the API, so every copy names one address per page instead of each host
 * indexing its own duplicate. It matches index.html, sitemap.xml, robots.txt and agents.json.
 */
export const SITE_ORIGIN = `https://${BRAND.domain}`;

/** The canonical URL of a route: the site origin and the path, without a trailing slash, query or hash. */
export function canonicalUrl(pathname: string): string {
	const path = pathname.split(/[?#]/)[0].replace(/^\/+|\/+$/g, '');
	return `${SITE_ORIGIN}/${path}`;
}

/**
 * Points the page's canonical link at the current route. index.html ships it pointing at the
 * home page, which told search engines every route was a duplicate of it.
 */
export function applyCanonical(doc: Document, pathname: string): void {
	const link = doc.querySelector<HTMLLinkElement>('link[rel="canonical"]');
	if (link) link.href = canonicalUrl(pathname);
}
