import { sitemapForBuild } from './sitemap';

const SOURCE = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://goldstandard.finance/</loc><changefreq>weekly</changefreq><priority>1.0</priority></url>
  <url><loc>https://goldstandard.finance/terms</loc><changefreq>monthly</changefreq><priority>0.3</priority></url>
</urlset>
`;

describe('sitemapForBuild', () => {
	it('dates every page with the day of the commit the build was made from', () => {
		const built = sitemapForBuild(SOURCE, { lastModified: '2026-11-26', ledgerEnabled: false });
		expect(built.match(/<lastmod>2026-11-26<\/lastmod>/g)).toHaveLength(2);
		expect(built).toContain('<loc>https://goldstandard.finance/terms</loc><lastmod>2026-11-26</lastmod><changefreq>monthly</changefreq>');
	});

	it('leaves the dates out when the day is unknown or malformed, since a wrong date is worse than none', () => {
		for (const lastModified of [undefined, '', 'unknown', '26/11/2026', '2026-13-01']) {
			expect(sitemapForBuild(SOURCE, { lastModified, ledgerEnabled: false })).toBe(SOURCE);
		}
	});

	it('lists the ledger page only in a build that has it, once', () => {
		const built = sitemapForBuild(SOURCE, { lastModified: '2026-11-26', ledgerEnabled: true });
		expect(built.match(/<loc>https:\/\/goldstandard\.finance\/ledger<\/loc>/g)).toHaveLength(1);
		expect(built.match(/<lastmod>/g)).toHaveLength(3);
		expect(sitemapForBuild(built, { lastModified: '2026-11-26', ledgerEnabled: true })).toBe(built);
		expect(sitemapForBuild(SOURCE, { lastModified: undefined, ledgerEnabled: false })).not.toContain('/ledger');
	});

	it('keeps the file a closed urlset', () => {
		const built = sitemapForBuild(SOURCE, { lastModified: '2026-11-26', ledgerEnabled: true });
		expect(built.trimEnd().endsWith('</urlset>')).toBe(true);
		expect(built.match(/<url>/g)).toHaveLength(built.match(/<\/url>/g)?.length ?? -1);
	});

	it('refuses a file it cannot place the ledger page in', () => {
		expect(() => sitemapForBuild('<html></html>', { lastModified: undefined, ledgerEnabled: true })).toThrow(/urlset/);
	});
});
