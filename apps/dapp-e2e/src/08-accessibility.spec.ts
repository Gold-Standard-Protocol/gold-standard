import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

/**
 * Every public route at phone and desktop width, without a wallet: no horizontal overflow,
 * every landmark distinguishable, every sideways-scrolling docs table reachable from the
 * keyboard, no ARIA label on a role-less element, no empty column header and every
 * definition list well formed. When axe-core resolves (it arrives with the lint tooling, it
 * is not a declared dependency) the page is also run through it and must show no serious
 * or critical violation. Reduced motion is emulated so the one-time section reveals do
 * not leave text half-faded while contrast is measured.
 */
const WIDTHS = [360, 1440] as const;
const DOCS = [
	'introduction',
	'why-gold-standard',
	'getting-started',
	'vaults',
	'minting-redeeming',
	'liquidations',
	'peg-stability',
	'stability-fee',
	'oracle',
	'collateral',
	'parameters',
	'security',
	'governance',
	'contracts',
	'agents',
	'faq',
	'glossary',
];
// /ledger is in this suite's build: tools/up.mjs builds the dapp with the ledger page on.
const ROUTES = ['/', '/transparency', '/vault', '/vault/liquidate', '/pool', '/swap', '/ledger', '/terms', ...DOCS.map((slug) => `/docs/${slug}`)];
const DOCS_WITH_TABLES = ['why-gold-standard', 'vaults', 'minting-redeeming', 'stability-fee', 'parameters', 'security', 'governance'];

interface StructureReport {
	overflow: number;
	duplicateLandmarks: string[];
	labelledWithoutRole: string[];
	emptyHeaders: number;
	malformedLists: string[];
	unfocusableTables: string[];
	redundantAlts: string[];
}

function axeSource(): string | undefined {
	try {
		return readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
	} catch {
		return undefined;
	}
}

/** Structural checks that need no library, evaluated in the page. */
function inspectStructure(): StructureReport {
	const root = document.documentElement;
	const visible = (el: Element): boolean => {
		const rect = el.getBoundingClientRect();
		return rect.width > 0 && rect.height > 0 && getComputedStyle(el).visibility !== 'hidden';
	};
	const nameOf = (el: Element): string => {
		const byId = el.getAttribute('aria-labelledby');
		const referenced = byId ? document.getElementById(byId)?.textContent?.trim() : undefined;
		return (el.getAttribute('aria-label') ?? referenced ?? el.getAttribute('title') ?? '').trim();
	};

	const landmarks = Array.from(
		document.querySelectorAll('nav, aside, [role="navigation"], [role="complementary"], [role="region"], section[aria-label]')
	).filter(visible);
	const seen = new Map<string, number>();
	for (const el of landmarks) {
		const role = el.getAttribute('role') ?? (el.tagName === 'NAV' ? 'navigation' : el.tagName === 'ASIDE' ? 'complementary' : 'region');
		const key = `${role}:${nameOf(el)}`;
		seen.set(key, (seen.get(key) ?? 0) + 1);
	}
	const duplicateLandmarks = Array.from(seen.entries())
		.filter(([, count]) => count > 1)
		.map(([key]) => key);

	const labelledWithoutRole = Array.from(document.querySelectorAll('div[aria-label]:not([role]), span[aria-label]:not([role])'))
		.filter(visible)
		.map((el) => el.className.toString().slice(0, 60));

	const emptyHeaders = Array.from(document.querySelectorAll('th')).filter((th) => (th.textContent ?? '').trim() === '').length;

	const malformedLists: string[] = [];
	for (const dl of Array.from(document.querySelectorAll('dl'))) {
		for (const child of Array.from(dl.children)) {
			const tag = child.tagName;
			if (tag === 'DT' || tag === 'DD' || tag === 'SCRIPT' || tag === 'TEMPLATE') continue;
			const groupIsClean = tag === 'DIV' && Array.from(child.children).every((inner) => inner.tagName === 'DT' || inner.tagName === 'DD');
			if (!groupIsClean) malformedLists.push(`${tag.toLowerCase()} inside dl`);
		}
	}

	const unfocusableTables = Array.from(document.querySelectorAll('.doc-prose table'))
		.map((table) => table.parentElement)
		.filter((wrapper): wrapper is HTMLElement => wrapper !== null && wrapper.scrollWidth > wrapper.clientWidth)
		.filter((wrapper) => wrapper.tabIndex !== 0 || wrapper.getAttribute('role') !== 'region' || !wrapper.getAttribute('aria-label'))
		.map((wrapper) => wrapper.getAttribute('aria-label') ?? wrapper.className.slice(0, 60));

	const redundantAlts = Array.from(document.querySelectorAll('img[alt]'))
		.filter((img) => {
			const alt = (img.getAttribute('alt') ?? '').trim().toLowerCase();
			const siblingText = (img.parentElement?.textContent ?? '').trim().toLowerCase();
			return alt.length > 0 && siblingText.length > 0 && siblingText === alt;
		})
		.map((img) => img.getAttribute('alt') ?? '');

	return {
		overflow: root.scrollWidth - root.clientWidth,
		duplicateLandmarks,
		labelledWithoutRole,
		emptyHeaders,
		malformedLists,
		unfocusableTables,
		redundantAlts,
	};
}

interface AxeViolation {
	id: string;
	impact: string | null;
	nodes: { target: unknown[]; html: string }[];
}

interface AxeWindow {
	axe: { run: (context: Document, options: unknown) => Promise<{ violations: AxeViolation[] }> };
}

async function seriousAxeViolations(page: Page, source: string): Promise<string[]> {
	await page.addScriptTag({ content: source });
	return page.evaluate(async () => {
		// axe is injected above at run time, so the window type cannot declare it.
		const runner = (window as unknown as AxeWindow).axe;
		const result = await runner.run(document, {
			runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] },
		});
		return result.violations
			.filter((v) => v.impact === 'serious' || v.impact === 'critical')
			.map((v) => `${v.id} (${v.impact}, ${v.nodes.length}): ${v.nodes[0]?.html.slice(0, 120) ?? ''}`);
	});
}

async function settle(page: Page, route: string): Promise<void> {
	await page.goto(route);
	await expect(page.locator('main h1').first()).toBeVisible();
	// Live reads land after the first paint; give the cards one poll to show their state.
	await page.waitForTimeout(800);
}

interface PolicyViolation {
	directive: string;
	blocked: string;
}

/**
 * The one violation the page is allowed: the Coinbase wallet SDK (a RainbowKit default)
 * injects an inline analytics script, and blocking it is what script-src 'self' is for.
 */
function isWalletTelemetry(violation: PolicyViolation): boolean {
	return violation.directive === 'script-src-elem' && violation.blocked === 'inline';
}

test.describe('content security policy', () => {
	test.use({ reducedMotion: 'reduce', viewport: { width: 1440, height: 900 } });

	for (const route of ['/', '/docs/introduction', '/transparency', '/vault']) {
		test(`${route} carries the meta policy and loads under it`, async ({ page }) => {
			const pageErrors: string[] = [];
			page.on('pageerror', (error) => pageErrors.push(error.message));
			await page.addInitScript(() => {
				const log: { directive: string; blocked: string }[] = [];
				Object.assign(window, { __policyViolations: log });
				document.addEventListener('securitypolicyviolation', (event) => {
					log.push({ directive: event.violatedDirective, blocked: event.blockedURI });
				});
			});
			await settle(page, route);
			const policy = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
			expect(policy).toContain("script-src 'self'");
			expect(policy).not.toContain('frame-ancestors');
			// The log is installed by the init script above, so the window type cannot declare it.
			const violations = await page.evaluate(() => (window as unknown as { __policyViolations: PolicyViolation[] }).__policyViolations);
			expect(violations.filter((violation) => !isWalletTelemetry(violation))).toEqual([]);
			expect(pageErrors).toEqual([]);
		});
	}
});

test.describe('accessibility and responsive layout', () => {
	// The page's own CSP (index.html) refuses inline scripts, which is what the suite above
	// checks; axe has to be injected inline, so this block alone runs with the policy lifted.
	test.use({ reducedMotion: 'reduce', bypassCSP: true });
	const axe = axeSource();

	for (const width of WIDTHS) {
		test.describe(`at ${width}px`, () => {
			test.use({ viewport: { width, height: width < 700 ? 800 : 900 } });

			for (const route of ROUTES) {
				test(`${route} has no overflow and sound structure`, async ({ page }) => {
					await settle(page, route);
					const report = await page.evaluate(inspectStructure);
					expect.soft(report.overflow, 'horizontal overflow in px').toBeLessThanOrEqual(0);
					expect.soft(report.duplicateLandmarks, 'landmarks sharing a role and name').toEqual([]);
					expect.soft(report.labelledWithoutRole, 'aria-label on a role-less element').toEqual([]);
					expect.soft(report.emptyHeaders, 'empty column headers').toBe(0);
					expect.soft(report.malformedLists, 'definition lists with stray children').toEqual([]);
					expect.soft(report.unfocusableTables, 'scrolling tables without keyboard focus').toEqual([]);
					expect.soft(report.redundantAlts, 'image alt repeating adjacent text').toEqual([]);
					if (axe) {
						expect.soft(await seriousAxeViolations(page, axe), 'serious or critical axe violations').toEqual([]);
					} else {
						test.info().annotations.push({ type: 'note', description: 'axe-core not resolvable; structural checks only' });
					}
				});
			}
		});
	}

	test.describe('docs tables at 360px', () => {
		test.use({ viewport: { width: 360, height: 800 } });

		for (const slug of DOCS_WITH_TABLES) {
			test(`/docs/${slug} tables take keyboard focus and announce a name`, async ({ page }) => {
				await settle(page, `/docs/${slug}`);
				const regions = page.locator('.doc-prose [role="region"]');
				expect(await regions.count()).toBeGreaterThan(0);
				for (let i = 0; i < (await regions.count()); i += 1) {
					const region = regions.nth(i);
					await expect(region).toHaveAttribute('tabindex', '0');
					await expect(region).toHaveAttribute('aria-label', /\S/);
					await region.focus();
					await expect(region).toBeFocused();
				}
			});
		}
	});
});
