import { expect, test } from '@playwright/test';
import { parseEther } from 'viem';
import {
	approveIfAsked,
	balanceOf,
	deployment,
	expectWalletConnected,
	liquidateUntilSettled,
	POOL_VICTIM,
	runHardhatScript,
	VICTIM,
} from './helpers';

/**
 * A direct liquidation from the UI. The bootstrap opened the victim's vault (0.5 PAXG
 * against 1,400 GSUSD, about 143% at the mocks' $4,000). Walking gold to $3,050 in
 * oracle-safe steps takes it to about 109%, under the 110% liquidation ratio, while
 * every vault that must survive does: the wallet's XAUT vault, the deployer's and the
 * pool's liquidity provider's. The pool liquidation suite's smaller victim goes under
 * water at the same time and is left for that suite. The pool liquidation suite restores the price to $4,000 when it finishes.
 */
test('liquidates an undercollateralised vault from the liquidations page', async ({ page }) => {
	test.setTimeout(300_000);
	const env = deployment();
	// Throws on a non-zero exit; prints nothing to assert on when the price is already there.
	runHardhatScript('scripts/walk-testnet-price.ts', { TARGET_PRICE_USD: '3050' });

	await page.goto('/vault/liquidate');
	await expectWalletConnected(page);
	const gsusdBefore = await balanceOf(env['VITE_GUSD_ADDRESS']);
	const paxgBefore = await balanceOf(env['VITE_PAXG_ADDRESS']);

	// The owners list comes from the API's indexer; the victim has been there since bootstrap.
	const row = page.getByRole('button', { name: new RegExp(VICTIM.slice(0, 6), 'i') });
	await expect(row).toBeVisible({ timeout: 120_000 });
	await row.click();
	const detail = page.locator('[id^="liquidation-detail-"]');
	await detail.getByRole('button', { name: 'Max' }).click();
	await expect(detail.getByLabel('GSUSD to repay')).not.toHaveValue('');
	await approveIfAsked(page, /^Liquidate position$/);
	// Settled on chain: the debt left the wallet and the seized PAXG arrived with its bonus.
	await liquidateUntilSettled(
		detail.getByRole('button', { name: 'Liquidate position' }),
		async () => (await balanceOf(env['VITE_PAXG_ADDRESS'])) > paxgBefore
	);
	// The list re-reads on confirmation and drops the closed vault; the outcome stays on screen.
	await expect(page.getByRole('status').filter({ hasText: 'liquidated; the seized gold is in your wallet' })).toBeVisible({
		timeout: 30_000,
	});
	const paid = gsusdBefore - (await balanceOf(env['VITE_GUSD_ADDRESS']));
	expect(paid >= parseEther('1400')).toBe(true);
	expect(paid < parseEther('1450')).toBe(true);

	// After a reload the list holds only the pool suite's victim; this one is gone.
	await page.reload();
	await expect(page.getByRole('button', { name: new RegExp(POOL_VICTIM.slice(0, 6), 'i') })).toBeVisible({
		timeout: 60_000,
	});
	await expect(page.getByRole('button', { name: new RegExp(VICTIM.slice(0, 6), 'i') })).toHaveCount(0);
});
