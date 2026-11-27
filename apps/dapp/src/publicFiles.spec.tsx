import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { TOKEN_LIST } from '@goldstandard/constants';
import { DOC_ITEMS } from './app/docs/registry';
import { canonicalUrl, ROUTE_DESCRIPTIONS, ROUTE_TITLES } from './app/lib/routes';

/**
 * The shape of what ships beside the bundle. Everything in
 * apps/dapp/public is copied into the build as it stands, so these read the folder itself.
 */
const DAPP_ROOT = resolve(__dirname, '..');
const PUBLIC_DIR = resolve(DAPP_ROOT, 'public');
const publicFile = (name: string): string => readFileSync(resolve(PUBLIC_DIR, name), 'utf8');
const indexHtml = readFileSync(resolve(DAPP_ROOT, 'index.html'), 'utf8');

describe('single-page fallback for the IPFS and ENS route', () => {
	// The router uses the History API, and an IPFS gateway serves only files that exist in the
	// CID: without this rule a refresh or a shared link to /vault or /docs/faq has no file to
	// serve. Gateways that implement the _redirects convention, and hosts that read the same
	// file, answer such a path with index.html and status 200.
	it('ships _redirects with exactly one rule that rewrites every path to index.html', () => {
		expect(publicFile('_redirects')).toBe('/* /index.html 200\n');
	});

	// A file that exists always wins over the rewrite, so these keep being served as themselves.
	it.each(['_headers', 'agents.json', 'llms.txt', 'sitemap.xml', 'robots.txt', 'manifest.json', 'favicon.ico', 'favicon.svg', 'apple-touch-icon.png', 'logo-512.png', 'og.png', '.well-known/security.txt', 'fonts', 'abi'])(
		'keeps %s as a real file beside the rule',
		(name) => {
			expect(existsSync(resolve(PUBLIC_DIR, name))).toBe(true);
		}
	);

	// Cloudflare Pages turns its own single-page fallback off when a 404.html exists, and a
	// gateway would serve that file for unknown paths instead of the app.
	it('ships no 404.html', () => {
		expect(existsSync(resolve(PUBLIC_DIR, '404.html'))).toBe(false);
	});
});

describe('token list and brand marks', () => {
	// The build writes both beside the bundle (vite.config.mts, publishTokenFiles), so neither
	// has a copy in the public folder to drift from the brand folder or from the build address.
	it('keeps no hand-made copy of either in the public folder', () => {
		expect(existsSync(resolve(PUBLIC_DIR, 'tokenlist.json'))).toBe(false);
		expect(existsSync(resolve(PUBLIC_DIR, 'brand'))).toBe(false);
	});

	it('lets other origins read them', () => {
		const headers = publicFile('_headers');
		expect(headers).toContain('/tokenlist.json\n  Access-Control-Allow-Origin: *\n');
		expect(headers).toContain('/brand/*\n  Access-Control-Allow-Origin: *\n');
	});

	it('is wired into the build', () => {
		const config = readFileSync(resolve(DAPP_ROOT, 'vite.config.mts'), 'utf8');
		expect(config).toMatch(/plugins: \[[^\]]*publishTokenFiles\(\)/s);
	});
});

describe('sitemap and canonical link', () => {
	const listed = [...publicFile('sitemap.xml').matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]);
	const live = [...Object.keys(ROUTE_TITLES), ...DOC_ITEMS.map((item) => `/docs/${item.slug}`)].map(canonicalUrl);

	it('lists every live route once and nothing else', () => {
		expect([...listed].sort()).toEqual([...live].sort());
		expect(new Set(listed).size).toBe(listed.length);
	});

	it('ships the home page as the canonical link the shell then points at each route', () => {
		expect(indexHtml).toContain(`<link rel="canonical" href="${canonicalUrl('/')}" />`);
	});

	it('names the sitemap in robots.txt on the same origin', () => {
		expect(publicFile('robots.txt')).toContain(`Sitemap: ${canonicalUrl('/sitemap.xml')}`);
	});
});

describe('images in the public folder', () => {
	it('ships only the token images the app shows', () => {
		const shown = TOKEN_LIST.map((token) => token.image.replace('/images/', ''));
		expect(readdirSync(resolve(PUBLIC_DIR, 'images')).sort()).toEqual([...shown].sort());
	});
});

describe('page metadata', () => {
	const description = indexHtml.match(/<meta\s+name="description"\s+content="([^"]+)"/)?.[1] ?? '';

	// The shell puts this text back when a visitor returns to the home page from another route.
	it('ships the home page description the route table holds', () => {
		expect(description).toBe(ROUTE_DESCRIPTIONS['/']);
	});

	/** Width and height of a PNG, from its header. */
	const pngSize = (name: string): [number, number] => {
		const header = readFileSync(resolve(PUBLIC_DIR, name));
		return [header.readUInt32BE(16), header.readUInt32BE(20)];
	};

	it('names a square logo of at least 112 pixels in the structured data', () => {
		expect(indexHtml).toContain(`"logo": "${canonicalUrl('/logo-512.png')}"`);
		expect(pngSize('logo-512.png')).toEqual([512, 512]);
	});

	it('links a 180 pixel touch icon for home screen shortcuts', () => {
		expect(indexHtml).toContain('<link rel="apple-touch-icon" href="/apple-touch-icon.png" />');
		expect(pngSize('apple-touch-icon.png')).toEqual([180, 180]);
	});

	it('ships its raster images without embedded metadata', () => {
		for (const name of ['logo-512.png', 'apple-touch-icon.png', 'og.png']) {
			const file = readFileSync(resolve(PUBLIC_DIR, name));
			const chunks = new Set<string>();
			for (let offset = 8; offset < file.length; offset += 12 + file.readUInt32BE(offset)) {
				chunks.add(file.toString('latin1', offset + 4, offset + 8));
			}
			expect([...chunks].filter((chunk) => !['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND'].includes(chunk))).toEqual([]);
		}
	});

	// XAUT is registered but inactive at launch: a deposit of it reverts until governance
	// activates it, so the description may only name it as something that follows.
	it('does not present XAUT as collateral a visitor can use at launch', () => {
		expect(description).toContain('PAXG at launch, with XAUT to follow once activated');
		expect(indexHtml).not.toMatch(/\(PAXG, XAUT\)|PAXG (?:or|and) XAUT/i);
	});
});
