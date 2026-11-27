import { expect, test } from '@playwright/test';
import { approveIfAsked, expectWalletConnected, fill, openDialog } from './helpers';
import { rpc } from './rpcProbe';

/**
 * While a submitted transaction waits for a block the receipt shows one spinner beside
 * "Waiting for confirmation", announced once as a status. The node's automine is paused
 * to hold the transaction in the mempool, and restored in a finally block so a failure
 * can never leave the node stuck for the rest of the suite.
 */
test.describe.serial('pending spinner', () => {
	let snapshot: unknown;
	test.beforeAll(async () => {
		snapshot = await rpc('evm_snapshot');
	});
	test.afterAll(async () => {
		await rpc('evm_revert', [snapshot]);
		await rpc('evm_setAutomine', [true]);
	});

	test('spins while the receipt is pending and stands still under reduced motion', async ({ page }, testInfo) => {
		test.setTimeout(4 * 60_000);
		await page.goto('/pool');
		await expectWalletConnected(page);
		await page.getByRole('tab', { name: 'Deposit' }).click();
		await fill(page.getByLabel(/you deposit/i), '5');
		await approveIfAsked(page, /^Deposit$/);

		await rpc('evm_setAutomine', [false]);
		try {
			await page.getByRole('button', { name: /^Deposit$/ }).click();
			await openDialog(page).getByRole('button', { name: /^Confirm deposit$/ }).click();

			const receipt = openDialog(page);
			const status = receipt.getByRole('status', { name: 'Waiting for confirmation' });
			await expect(status).toBeVisible({ timeout: 30_000 });
			await expect(status).toHaveAttribute('aria-live', 'polite');
			const spinner = status.locator('svg');
			await expect(spinner).toBeVisible();
			await expect(spinner).toHaveAttribute('aria-hidden', 'true');
			await expect(receipt.getByRole('link', { name: /View on Etherscan/ })).toBeVisible();
			expect(await spinner.evaluate((el) => getComputedStyle(el).animationName)).toBe('spin');
			await receipt.screenshot({ path: testInfo.outputPath('spinner-pending.png') });

			await page.emulateMedia({ reducedMotion: 'reduce' });
			await expect(spinner).toBeVisible();
			expect(await spinner.evaluate((el) => getComputedStyle(el).animationName)).toBe('none');
			await receipt.screenshot({ path: testInfo.outputPath('spinner-reduced.png') });
			await page.emulateMedia({ reducedMotion: null });
		} finally {
			await rpc('evm_mine');
			await rpc('evm_setAutomine', [true]);
		}

		const receipt = openDialog(page);
		await expect(receipt.getByRole('heading', { name: 'Confirmed' })).toBeVisible({ timeout: 60_000 });
		const confirmed = receipt.getByRole('status', { name: 'Confirmed' });
		await expect(confirmed).toBeVisible();
		await expect(confirmed.locator('svg[aria-hidden="true"]')).toHaveCount(0);
		await receipt.getByRole('button', { name: 'Close', exact: true }).first().click();
		await expect(page.getByRole('dialog')).toHaveCount(0);
		expect(await rpc('hardhat_getAutomine')).toBe(true);
	});
});
