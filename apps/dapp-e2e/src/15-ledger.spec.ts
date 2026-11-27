import { createHash } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import Redis from 'ioredis';
import { deployment, expectWalletConnected, prepareVaultAtRatio } from './helpers';
import { rpc } from './rpcProbe';

/**
 * The usage ledger page: tools/up.mjs starts the API with the ledger on and builds the dapp
 * with VITE_LEDGER_ENABLED=true.
 *
 * Earlier specs revert the chain to a snapshot while the API indexes it at zero
 * confirmations, so by now the ledger index can describe blocks that no longer exist. The
 * operator's remedy for that (docs/USAGE_LEDGER.md) is to delete the index's meta key, after
 * which the next run recomputes the whole ledger from the deploy block; this spec does the
 * same before it reads a figure. It also gives the wallet a debt of its own, so it passes
 * when run alone.
 */
const CHAIN_ID = 11155111;
const PHONE = { width: 390, height: 844 };
const DISCLAIMER = 'No token exists, no token is promised, the ledger confers no rights and may never confer any.';
// The words of a campaign, spelled in parts so that a search of the tree for them finds real uses only.
const CAMPAIGN_WORDS = new RegExp(
	['poi' + 'nts', 'earn', 'multi' + 'plier', 'refer' + 'r', 'leader' + 'board', 'ranked', 'ranking', 'bonus', 'season', 'reward'].join('|'),
	'i'
);

function redisClient(): Redis {
	return new Redis({ host: process.env['REDIS_HOST'] ?? '127.0.0.1', port: 6379, lazyConnect: true, maxRetriesPerRequest: 1 });
}

/** Runs one command set against the API's Redis namespace; a no-op when the API is not the suite's own. */
async function withLedgerKeys(env: Record<string, string>, use: (redis: Redis, scope: string) => Promise<void>): Promise<void> {
	const namespace = env['SUITE_REDIS_NAMESPACE'];
	if (!namespace) return;
	const redis = redisClient();
	try {
		await redis.connect();
		await use(redis, `${namespace}:ledger:v1:${CHAIN_ID}:${env['VITE_GOLD_VAULT_ADDRESS'].toLowerCase()}`);
	} finally {
		redis.disconnect();
	}
}

/** The wallet's vault debt figure in GSUSD-days, as a number; NaN while the card shows no figure. */
async function shownDebtDays(page: Page): Promise<number> {
	const row = page.getByTestId('ledger-figures').locator('div', { hasText: 'Vault debt' }).first();
	// After a reload the card arrives a moment later; while the ledger is recomputed it never does.
	const shown = await row.waitFor({ timeout: 10_000 }).then(
		() => true,
		() => false
	);
	if (!shown) return Number.NaN;
	const text = (await row.locator('dd span').first().textContent({ timeout: 10_000 })) ?? '';
	return Number(text.replace(/,/g, ''));
}

async function expectNoOverflow(page: Page): Promise<void> {
	const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
	expect(overflow).toBeLessThanOrEqual(0);
}

test.describe.serial('usage ledger', () => {
	let env: Record<string, string>;
	let snapshot: unknown;

	test.beforeAll(async () => {
		test.setTimeout(5 * 60_000);
		env = deployment();
		snapshot = await rpc('evm_snapshot');
		// A debt for the wallet, then twenty minutes of chain time for it to be held over.
		await prepareVaultAtRatio(env, 300n);
		await rpc('hardhat_mine', ['0x2', '0x258']);
		await withLedgerKeys(env, async (redis, scope) => {
			await redis.del(`${scope}:meta`);
		});
	});

	test.afterAll(async () => {
		await rpc('evm_revert', [snapshot]);
	});

	test('the navigation offers the ledger and the page carries the disclaimer in plain text', async ({ page }) => {
		await page.goto('/');
		await page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Ledger' }).first().click();
		await expect(page).toHaveURL(/\/ledger$/);
		await expect(page).toHaveTitle('Usage Ledger · Gold Standard');
		await expect(page.getByRole('heading', { level: 1, name: 'Usage Ledger' })).toBeVisible();
		const disclaimer = page.getByRole('region', { name: 'What the ledger is not' });
		await expect(disclaimer).toBeVisible();
		await expect(disclaimer).toContainText(DISCLAIMER);
		// It is text on the page, not something to open.
		await expect(disclaimer.locator('button, details, [aria-expanded]')).toHaveCount(0);
	});

	test('the old address of the page leads nowhere', async ({ page }) => {
		await page.goto('/points');
		await expect(page.getByRole('heading', { level: 1, name: 'Usage Ledger' })).toHaveCount(0);
		await expect(page.getByTestId('ledger-disclaimer')).toHaveCount(0);
	});

	test('the wallet sees its own figures, each in its own unit, and no other wallet', async ({ page }) => {
		test.setTimeout(5 * 60_000);
		await page.goto('/ledger');
		await expectWalletConnected(page);
		// The index runs once a minute and was dropped above, so the first answers can be
		// "being recomputed"; the page must say so and never show a zero meanwhile.
		await expect(async () => {
			await page.reload();
			expect(await shownDebtDays(page)).toBeGreaterThan(0);
		}).toPass({ timeout: 4 * 60_000, intervals: [5_000] });

		const figures = page.getByTestId('ledger-figures');
		await expect(figures.locator(':scope > div')).toHaveCount(2);
		await expect(figures).toContainText('Vault debt');
		await expect(figures).toContainText('Stability pool deposit');
		await expect(figures.getByText('GSUSD-days')).toHaveCount(2);
		await expect(page.getByText('Each figure stands alone. They are not added into one number.')).toBeVisible();
		await expect(page.getByTestId('ledger-balances')).toContainText('Debt held now');
		await expect(page.getByTestId('ledger-count')).toContainText('recorded to block');

		// No table of wallets, no rank, nothing to sign and none of the words of a campaign.
		await expect(page.getByRole('table')).toHaveCount(0);
		const main = (await page.locator('main').innerText()).replace(/\s+/g, ' ');
		expect(main).not.toMatch(CAMPAIGN_WORDS);
		expect(main).not.toMatch(/0x[0-9a-fA-F]{6}/);
		// The liquidity dimension is off in this suite, so the page says nothing about it.
		expect(main).not.toMatch(/liquidity|uniswap|dollar-days/i);
	});

	test('the debt figure grows with time held and by nothing else', async ({ page }) => {
		test.setTimeout(5 * 60_000);
		await page.goto('/ledger');
		await expectWalletConnected(page);
		await expect(async () => {
			await page.reload();
			expect(await shownDebtDays(page)).toBeGreaterThan(0);
		}).toPass({ timeout: 4 * 60_000, intervals: [5_000] });
		const before = await shownDebtDays(page);
		// One more day of chain time: the figure rises by the debt held, one GSUSD-day per GSUSD.
		await rpc('hardhat_mine', ['0x2', '0x15180']);
		await expect(async () => {
			await page.reload();
			expect(await shownDebtDays(page)).toBeGreaterThan(before);
		}).toPass({ timeout: 4 * 60_000, intervals: [5_000] });
		const after = await shownDebtDays(page);
		const debtText = (await page.getByTestId('ledger-balances').locator('div', { hasText: 'Debt held now' }).first().locator('dd span').first().textContent()) ?? '';
		const debt = Number(debtText.replace(/,/g, ''));
		expect(debt).toBeGreaterThan(0);
		// About one day at this debt, with no factor on top: within a tenth either way for the blocks in between.
		expect((after - before) / debt).toBeGreaterThan(0.9);
		expect((after - before) / debt).toBeLessThan(1.2);
	});

	test('the whole record downloads from the link on the page, and its bytes have the hash the page shows', async ({ page }) => {
		await page.goto('/ledger');
		const link = page.getByRole('link', { name: 'Download the whole record (CSV)' });
		await expect(link).toBeVisible();
		const href = (await link.getAttribute('href')) ?? '';
		expect(href).toMatch(/\/usage-ledger\.csv$/);
		const facts = page.getByTestId('ledger-file');
		await expect(facts).toContainText('SHA-256 of the file');
		// The index writes a new state each minute: read the file and the page's hash again
		// until both describe the same state.
		await expect(async () => {
			await page.reload();
			const response = await page.request.get(href);
			expect(response.status()).toBe(200);
			expect(response.headers()['content-type']).toContain('text/csv');
			const body = await response.body();
			const sha256 = createHash('sha256').update(body).digest('hex');
			expect(response.headers()['etag']).toBe(`"${sha256}"`);
			await expect(page.getByTestId('ledger-file')).toContainText(sha256, { timeout: 3_000 });
			const lines = body.toString('utf8').trimEnd().split('\n');
			expect(lines[0]).toBe('address,debtGsusdDays,poolGsusdDays,liquidityDollarDays,debtGsusd,poolGsusd,liquidityDollars,asOfBlock,asOfTimestamp');
			const addresses = lines.slice(1).map((line) => line.split(',')[0]);
			expect(addresses.length).toBeGreaterThan(0);
			expect([...addresses].sort()).toEqual(addresses);
		}).toPass({ timeout: 60_000 });
	});

	test('the disclaimer links to the terms, which carry the same sentence and no form', async ({ page }) => {
		await page.goto('/ledger');
		await page.getByTestId('ledger-terms-link').click();
		await expect(page).toHaveURL(/\/terms$/);
		await expect(page).toHaveTitle('Terms · Gold Standard');
		await expect(page.getByRole('heading', { level: 1, name: 'Terms' })).toBeVisible();
		await expect(page.getByTestId('terms-ledger-clause')).toHaveText(DISCLAIMER);
		await expect(page.locator('main input, main textarea, main form')).toHaveCount(0);
		expect((await page.locator('main').textContent()) ?? '').not.toMatch(CAMPAIGN_WORDS);
		await page.setViewportSize(PHONE);
		await expectNoOverflow(page);
	});

	test('the footer of every page links to the terms', async ({ page }) => {
		await page.goto('/vault');
		await page.getByRole('contentinfo').getByRole('link', { name: 'Terms' }).click();
		await expect(page).toHaveURL(/\/terms$/);
		await expect(page.getByRole('heading', { level: 1, name: 'Terms' })).toBeVisible();
	});

	test('the page fits a phone without sideways scrolling and keeps the disclaimer in view of the reader', async ({ page }) => {
		await page.setViewportSize(PHONE);
		await page.goto('/ledger');
		await expect(page.getByRole('heading', { level: 1, name: 'Usage Ledger' })).toBeVisible();
		await expect(page.getByTestId('ledger-disclaimer')).toBeVisible();
		await expect(page.getByRole('heading', { level: 2, name: 'What the ledger records' })).toBeVisible();
		await expectNoOverflow(page);
		const disclaimerBox = await page.getByTestId('ledger-disclaimer').boundingBox();
		const cardBox = await page.getByRole('heading', { level: 2, name: 'Your recorded usage' }).boundingBox();
		// The disclaimer comes before the figures.
		expect(disclaimerBox && cardBox && disclaimerBox.y < cardBox.y).toBe(true);
	});

	test('every control is reached with the keyboard and shows where the focus is', async ({ page }) => {
		await page.goto('/ledger');
		await expect(page.getByRole('heading', { level: 1, name: 'Usage Ledger' })).toBeVisible();
		const focusable = await page.locator('main a[href], main button:not([disabled]), main input, main [tabindex]:not([tabindex="-1"])').count();
		// The page adds links only (the terms, the download, the documentation): no form,
		// nothing to sign and no table to scroll.
		expect(await page.locator('main button:not([disabled]), main input, main [tabindex]:not([tabindex="-1"]):not(a)').count()).toBe(0);
		expect(focusable).toBeLessThanOrEqual(4);
		for (let presses = 0; presses < 40; presses += 1) {
			await page.keyboard.press('Tab');
			const done = await page.evaluate(() => document.activeElement === document.body);
			if (done) break;
			const visible = await page.evaluate(() => document.activeElement?.matches(':focus-visible') ?? false);
			expect(visible).toBe(true);
		}
	});
});
