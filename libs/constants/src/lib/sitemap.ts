/**
 * The sitemap as one build ships it. public/sitemap.xml lists the routes every build has; a
 * build adds what only it knows: the day of the commit it was made from, and the ledger page
 * when that page is in the bundle. Pure text in and out, so the Vite config (which loads
 * without the path aliases) and the tests share it.
 */

const SITE_ORIGIN = 'https://goldstandard.finance';
const LEDGER_URL = `${SITE_ORIGIN}/ledger`;
const LEDGER_ENTRY = `  <url><loc>${LEDGER_URL}</loc><changefreq>daily</changefreq><priority>0.5</priority></url>\n`;

export interface SitemapBuild {
	/** The commit day as YYYY-MM-DD. Anything else leaves the pages undated. */
	lastModified: string | undefined;
	ledgerEnabled: boolean;
}

/** True for a real calendar day written YYYY-MM-DD. */
function isDay(value: string | undefined): value is string {
	if (value === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
	const parsed = new Date(`${value}T00:00:00Z`);
	return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function sitemapForBuild(source: string, build: SitemapBuild): string {
	let xml = source;
	if (build.ledgerEnabled && !xml.includes(`<loc>${LEDGER_URL}</loc>`)) {
		if (!xml.includes('</urlset>')) throw new Error('sitemap.xml has no closing urlset tag to place the ledger page before');
		xml = xml.replace('</urlset>', `${LEDGER_ENTRY}</urlset>`);
	}
	if (isDay(build.lastModified)) {
		const stamp = `<lastmod>${build.lastModified}</lastmod>`;
		xml = xml.replace(/<\/loc>(?:<lastmod>[^<]*<\/lastmod>)?/g, `</loc>${stamp}`);
	}
	return xml;
}
