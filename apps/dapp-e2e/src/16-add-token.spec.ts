import { expect, test } from '@playwright/test';
import { deployment, expectWalletConnected, openDialog } from './helpers';

/**
 * The account dialog asks the wallet to list GSUSD. The suite's wallet forwards the request
 * to the local node, which has no such method, so this is the path of a wallet that cannot
 * add a token: the dialog gives the address instead, and keyboard focus stays on the control.
 */
test('offers GSUSD to the wallet and gives its address when the wallet cannot add a token', async ({ page }) => {
	const env = deployment();
	await page.goto('/vault');
	await expectWalletConnected(page);

	await page.getByRole('button', { name: /^Wallet 0x/ }).first().click();
	const dialog = openDialog(page);
	const add = dialog.getByRole('button', { name: 'Add GSUSD to wallet' });
	await add.focus();
	await page.keyboard.press('Enter');

	const alert = dialog.getByRole('alert');
	await expect(alert).toContainText('This wallet cannot add a token from here. Add GSUSD in the wallet itself by its address:');
	await expect(alert).toContainText(new RegExp(env['VITE_GUSD_ADDRESS'], 'i'));
	await expect(add).toBeFocused();

	// The dialog stays inside a phone screen with the 42-character address in it.
	await page.setViewportSize({ width: 360, height: 760 });
	expect(await dialog.evaluate((element) => element.scrollWidth - element.clientWidth)).toBe(0);
});

/** The suite's build names no outside market, so the swap page must not link to one. */
test('shows no link to an outside market in a build that names none', async ({ page }) => {
	await page.goto('/swap');
	await expectWalletConnected(page);
	await expect(page.getByRole('link', { name: /Buy GSUSD on Uniswap/ })).toHaveCount(0);
});
