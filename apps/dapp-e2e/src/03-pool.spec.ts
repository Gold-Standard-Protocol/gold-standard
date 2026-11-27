import { expect, test } from '@playwright/test';
import { parseEther } from 'viem';
import { balanceOf, deployment, expectWalletConnected, fill, submitAction } from './helpers';

/** Stability pool deposit and withdrawal with the funded wallet's GSUSD. */
test.describe.serial('stability pool', () => {
	// Read lazily: the file exists only once the bootstrap has run, and listing tests must not need it.
	let env: Record<string, string>;
	test.beforeAll(() => {
		env = deployment();
	});

	test.beforeEach(async ({ page }) => {
		await page.goto('/pool');
		await expectWalletConnected(page);
	});

	test('deposits 1000 GSUSD', async ({ page }) => {
		const before = await balanceOf(env['VITE_GUSD_ADDRESS']);
		await page.getByRole('tab', { name: 'Deposit' }).click();
		await fill(page.getByLabel(/you deposit/i), '1000');
		await submitAction(page, {
			button: /^Deposit$/,
			review: 'Review deposit',
			confirm: /^Confirm deposit$/,
			success: /Deposited 1,000 GSUSD/,
		});
		expect(before - (await balanceOf(env['VITE_GUSD_ADDRESS']))).toBe(parseEther('1000'));
	});

	test('withdraws 500 GSUSD', async ({ page }) => {
		const before = await balanceOf(env['VITE_GUSD_ADDRESS']);
		await page.getByRole('tab', { name: 'Withdraw' }).click();
		await fill(page.getByRole('textbox', { name: /withdraw/i }), '500');
		await submitAction(page, {
			button: /^Withdraw$/,
			review: 'Review withdraw',
			confirm: /^Confirm withdraw$/,
			success: /Withdrew 500 GSUSD/,
		});
		expect((await balanceOf(env['VITE_GUSD_ADDRESS'])) - before).toBe(parseEther('500'));
	});
});
