import { expect, test } from '@playwright/test';
import { parseEther, type Address } from 'viem';
import {
	balanceOf,
	deployment,
	expectWalletConnected,
	liquidateUntilSettled,
	POOL_VICTIM,
	runHardhatScript,
	submitAction,
} from './helpers';

/**
 * The stability pool's liquidation route, end to end. The pool holds the 500 GSUSD the
 * wallet left in it after its own deposit-and-withdraw suite, and the bootstrap's second
 * victim (0.15 PAXG against 420 GSUSD) went under water when the direct liquidation suite
 * walked gold to $3,050. The pool may absorb strictly less than it holds, so 420 fits.
 * Triggering the absorption costs the wallet nothing and pays it a keeper bounty at once;
 * the seized gold is credited to the pool's only depositor, the wallet, which then claims
 * it from the pool page.
 */
test.describe.serial('stability pool liquidation', () => {
	let env: Record<string, string>;
	test.beforeAll(() => {
		env = deployment();
	});

	// The market pool was seeded at the mocks' $4,000. Later suites swap against it, and with the
	// oracle left at $3,050 the price impact guard rightly refuses a purchase that pays 31% over it.
	test.afterAll(() => {
		test.setTimeout(300_000);
		runHardhatScript('scripts/walk-testnet-price.ts', { TARGET_PRICE_USD: '4000' });
	});

	test('absorbs the vault from the pool and pays the bounty', async ({ page }) => {
		test.setTimeout(300_000);
		// Idempotent: the direct liquidation suite normally ran first and left the price here.
		runHardhatScript('scripts/walk-testnet-price.ts', { TARGET_PRICE_USD: '3050' });

		await page.goto('/vault/liquidate');
		await expectWalletConnected(page);
		const pool = env['VITE_STABILITY_POOL_ADDRESS'] as Address;
		const paxgBefore = await balanceOf(env['VITE_PAXG_ADDRESS']);
		const poolGsusdBefore = await balanceOf(env['VITE_GUSD_ADDRESS'], pool);

		const row = page.getByRole('button', { name: new RegExp(POOL_VICTIM.slice(0, 6), 'i') });
		await expect(row).toBeVisible({ timeout: 120_000 });
		await row.click();
		const detail = page.locator('[id^="liquidation-detail-"]');
		await detail.getByRole('button', { name: 'Max' }).click();
		await expect(detail.getByLabel('GSUSD to repay')).not.toHaveValue('');
		// The bounty lands in the wallet and the pool's GSUSD shrinks by the fee-inclusive debt.
		await liquidateUntilSettled(
			detail.getByRole('button', { name: 'Liquidate from the Stability Pool' }),
			async () => (await balanceOf(env['VITE_PAXG_ADDRESS'])) > paxgBefore
		);
		// The list re-reads on confirmation and drops the closed vault; the outcome stays on screen.
		await expect(
			page.getByRole('status').filter({ hasText: 'liquidated from the pool; your bounty is in your wallet' })
		).toBeVisible({ timeout: 30_000 });
		const absorbed = poolGsusdBefore - (await balanceOf(env['VITE_GUSD_ADDRESS'], pool));
		expect(absorbed >= parseEther('420')).toBe(true);
		expect(absorbed < parseEther('421')).toBe(true);

		await page.reload();
		await expect(page.getByRole('heading', { name: 'No vaults are currently eligible for liquidation' })).toBeVisible({
			timeout: 60_000,
		});
	});

	test('claims the seized gold from the pool', async ({ page }) => {
		await page.goto('/pool');
		await expectWalletConnected(page);
		const before = await balanceOf(env['VITE_PAXG_ADDRESS']);

		await page.getByRole('tab', { name: 'Claim' }).click();
		const gains = page.getByRole('radiogroup', { name: 'Collateral to claim' });
		await gains.getByRole('radio', { name: /PAXG/ }).or(gains.getByRole('button', { name: /PAXG/ })).first().click();
		await submitAction(page, {
			button: /^Claim collateral$/,
			review: 'Review claim',
			confirm: /^Confirm claim$/,
			success: /Claimed .* PAXG/,
		});
		expect((await balanceOf(env['VITE_PAXG_ADDRESS'])) > before).toBe(true);
	});
});
