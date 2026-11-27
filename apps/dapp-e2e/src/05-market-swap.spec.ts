import { expect, test } from '@playwright/test';
import { parseEther } from 'viem';
import { balanceOf, deployment, expectWalletConnected, fill, submitAction } from './helpers';

/** A market swap through the real Uniswap v3 the bootstrap deployed and seeded. */
test('swaps 100 GSUSD for PAXG on Uniswap v3', async ({ page }) => {
	const env = deployment();
	await page.goto('/swap');
	await expectWalletConnected(page);
	const gsusdBefore = await balanceOf(env['VITE_GUSD_ADDRESS']);
	const paxgBefore = await balanceOf(env['VITE_PAXG_ADDRESS']);

	await page.getByRole('tab', { name: 'Market swap' }).click();
	await page.getByRole('group', { name: 'Swap direction' }).getByRole('button', { name: 'GSUSD to gold' }).click();
	await page.getByRole('button', { name: /Paxos Gold/ }).click();
	await fill(page.getByLabel('Sell GSUSD'), '100');
	// The quote must land before the swap button is live.
	await expect(page.getByText('Uniswap v3', { exact: false }).first()).toBeVisible();
	await submitAction(page, {
		button: /^Swap GSUSD for PAXG$/,
		review: 'Review swap',
		confirm: /^Confirm swap$/,
		success: /Swapped 100 GSUSD for \d[\d.,]* PAXG on Uniswap v3\./,
	});

	expect(gsusdBefore - (await balanceOf(env['VITE_GUSD_ADDRESS']))).toBe(parseEther('100'));
	expect((await balanceOf(env['VITE_PAXG_ADDRESS'])) > paxgBefore).toBe(true);
});

/** The seeded pool is thin, so a large sale fills far below the oracle: it must not sign unchallenged. */
test('asks for an acknowledgement before a swap that fills far below the oracle price', async ({ page }) => {
	await page.goto('/swap');
	await expectWalletConnected(page);
	await page.getByRole('tab', { name: 'Market swap' }).click();
	await page.getByRole('group', { name: 'Swap direction' }).getByRole('button', { name: 'GSUSD to gold' }).click();
	await page.getByRole('button', { name: /Paxos Gold/ }).click();

	await fill(page.getByLabel('Sell GSUSD'), '3000');
	const alert = page.getByRole('alert').filter({ hasText: 'than the oracle price' });
	await expect(alert).toBeVisible();
	await expect(alert).toContainText('You would pay');
	const swap = page.getByRole('button', { name: /^Swap GSUSD for PAXG$/ });
	await expect(swap).toBeDisabled();

	await page.getByRole('checkbox', { name: /I understand and want to swap at this price/ }).check();
	// Acknowledged, the flow moves on to the exact-amount approval rather than staying blocked.
	await expect(page.getByRole('button', { name: /^Approve GSUSD$/ })).toBeEnabled();

	await fill(page.getByLabel('Sell GSUSD'), '2999');
	await expect(page.getByRole('checkbox', { name: /I understand and want to swap at this price/ })).not.toBeChecked();
	await expect(swap).toBeDisabled();

	await fill(page.getByLabel('Sell GSUSD'), '10');
	await expect(page.getByRole('alert').filter({ hasText: 'than the oracle price' })).toHaveCount(0);
});
