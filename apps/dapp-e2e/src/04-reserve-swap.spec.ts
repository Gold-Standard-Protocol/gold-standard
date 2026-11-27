import { expect, test } from '@playwright/test';
import { parseEther } from 'viem';
import { balanceOf, deployment, expectWalletConnected, fill, submitAction } from './helpers';

/** A reserve swap: GSUSD in, protocol-owned PAXG out at the oracle price minus the spread. */
test('swaps 100 GSUSD for PAXG from the Stability Reserve', async ({ page }) => {
	const env = deployment();
	await page.goto('/swap');
	await expectWalletConnected(page);
	const gsusdBefore = await balanceOf(env['VITE_GUSD_ADDRESS']);
	const paxgBefore = await balanceOf(env['VITE_PAXG_ADDRESS']);

	await page.getByRole('tab', { name: /Reserve swap/ }).click();
	// The token toggles carry the token image's alt text in their accessible name.
	await page.getByRole('button', { name: /Paxos Gold/ }).click();
	await fill(page.getByLabel('Swap GSUSD'), '100');
	await submitAction(page, {
		button: /^Swap GSUSD for PAXG$/,
		review: 'Review swap',
		confirm: /^Confirm swap$/,
		success: /Swapped 100 GSUSD for \d[\d.,]* PAXG from the protocol reserve\./,
	});

	expect(gsusdBefore - (await balanceOf(env['VITE_GUSD_ADDRESS']))).toBe(parseEther('100'));
	expect((await balanceOf(env['VITE_PAXG_ADDRESS'])) > paxgBefore).toBe(true);
});
