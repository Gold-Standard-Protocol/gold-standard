import { expect, test } from '@playwright/test';
import { parseEther, parseUnits } from 'viem';
import { balanceOf, deployment, expectWalletConnected, fill, mintDelivers, submitAction } from './helpers';

/**
 * The same lifecycle with XAUT, the 6-decimal collateral: every amount the UI parses,
 * previews and displays goes through the decimals path that PAXG never exercises. The
 * wallet closed its PAXG vault at the end of the vault suite, so it can open this one.
 * The vault stays open (1.5 XAUT against 1,000 GSUSD) and must survive the liquidation
 * suite's price walk with room to spare.
 */
test.describe.serial('vault with XAUT', () => {
	let env: Record<string, string>;
	test.beforeAll(() => {
		env = deployment();
	});

	test.beforeEach(async ({ page }) => {
		await page.goto('/vault');
		await expectWalletConnected(page);
	});

	test('deposits 2 XAUT', async ({ page }) => {
		const before = await balanceOf(env['VITE_XAUT_ADDRESS']);
		await page.getByRole('tab', { name: 'Deposit' }).click();
		await page.getByRole('button', { name: 'Choose token' }).click();
		const picker = page.getByRole('dialog');
		await picker.getByRole('button', { name: /XAUT/ }).click();
		await expect(picker).toBeHidden();
		await fill(page.getByLabel(/you deposit/i), '2');
		await submitAction(page, {
			button: /^Deposit$/,
			review: 'Review deposit',
			confirm: /^Confirm deposit$/,
			success: /Deposited 2 XAUT/,
		});
		expect(before - (await balanceOf(env['VITE_XAUT_ADDRESS']))).toBe(parseUnits('2', 6));
	});

	test('mints 1000 GSUSD against it', async ({ page }) => {
		const before = await balanceOf(env['VITE_GUSD_ADDRESS']);
		await page.getByRole('tab', { name: 'Mint' }).click();
		await fill(page.getByLabel('Mint GSUSD'), '1000');
		await submitAction(page, {
			button: /^Mint GSUSD$/,
			review: 'Review mint',
			confirm: /^Confirm mint$/,
			success: /Minted 1,000 GSUSD/,
		});
		// The debt is the full 1,000; the wallet receives it less the origination fee.
		const delivered = await mintDelivers(env['VITE_GOLD_VAULT_ADDRESS'], parseEther('1000'));
		expect(delivered).toBeLessThan(parseEther('1000'));
		expect((await balanceOf(env['VITE_GUSD_ADDRESS'])) - before).toBe(delivered);
	});

	test('withdraws 0.5 XAUT and names the unit', async ({ page }) => {
		const before = await balanceOf(env['VITE_XAUT_ADDRESS']);
		await page.getByRole('tab', { name: 'Withdraw' }).click();
		await expect(page.getByText('XAUT', { exact: true }).first()).toBeVisible();
		await expect(page.getByRole('button', { name: /^Max:.*XAUT$/ })).toBeVisible();
		await fill(page.getByLabel('Withdraw collateral'), '0.5');
		await submitAction(page, {
			button: /^Withdraw$/,
			review: 'Review withdraw',
			confirm: /^Confirm withdraw$/,
			success: /Withdrew 0\.5 XAUT/,
		});
		expect((await balanceOf(env['VITE_XAUT_ADDRESS'])) - before).toBe(parseUnits('0.5', 6));
	});
});
