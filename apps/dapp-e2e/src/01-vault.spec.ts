import { expect, test } from '@playwright/test';
import { parseEther, parseUnits } from 'viem';
import { balanceOf, deployment, expectWalletConnected, fill, mintDelivers, submitAction } from './helpers';

/**
 * The vault lifecycle as a borrower experiences it, on a fresh chain, with the test
 * wallet the node signs for. Serial: each step builds on the last.
 */
test.describe.serial('vault', () => {
	// Read lazily: the file exists only once the bootstrap has run, and listing tests must not need it.
	let env: Record<string, string>;
	test.beforeAll(() => {
		env = deployment();
	});

	test.beforeEach(async ({ page }) => {
		await page.goto('/vault');
		await expectWalletConnected(page);
	});

	test('starts with no vault and names no unit on the withdraw tab', async ({ page }) => {
		await expect(page.getByRole('heading', { name: 'No active vault' })).toBeVisible();
		await page.getByRole('tab', { name: 'Withdraw' }).click();
		await expect(page.getByText('No collateral deposited')).toBeVisible();
		await expect(page.getByLabel('Withdraw collateral')).toBeDisabled();
		await expect(page.getByText('gold', { exact: true })).toHaveCount(0);
	});

	test('deposits 1 PAXG', async ({ page }) => {
		const before = await balanceOf(env['VITE_PAXG_ADDRESS']);
		await page.getByRole('tab', { name: 'Deposit' }).click();
		await page.getByRole('button', { name: 'Choose token' }).click();
		const picker = page.getByRole('dialog');
		await expect(picker.getByRole('heading', { name: 'Select Collateral' })).toBeVisible();
		await picker.getByRole('button', { name: /PAXG/ }).click();
		await expect(picker).toBeHidden();
		await fill(page.getByLabel(/you deposit/i), '1');
		await submitAction(page, {
			button: /^Deposit$/,
			review: 'Review deposit',
			confirm: /^Confirm deposit$/,
			success: /Deposited 1 PAXG/,
		});
		await expect(page.getByRole('heading', { name: 'No active vault' })).toHaveCount(0);
		expect(before - (await balanceOf(env['VITE_PAXG_ADDRESS']))).toBe(parseEther('1'));
	});

	test('mints 500 GSUSD against it', async ({ page }) => {
		const before = await balanceOf(env['VITE_GUSD_ADDRESS']);
		await page.getByRole('tab', { name: 'Mint' }).click();
		await fill(page.getByLabel('Mint GSUSD'), '500');
		await submitAction(page, {
			button: /^Mint GSUSD$/,
			review: 'Review mint',
			confirm: /^Confirm mint$/,
			success: /Minted 500 GSUSD/,
		});
		// The debt is the full 500; the wallet receives it less the origination fee.
		const delivered = await mintDelivers(env['VITE_GOLD_VAULT_ADDRESS'], parseEther('500'));
		expect(delivered).toBeLessThan(parseEther('500'));
		expect((await balanceOf(env['VITE_GUSD_ADDRESS'])) - before).toBe(delivered);
	});

	test('repays 100 GSUSD', async ({ page }) => {
		const before = await balanceOf(env['VITE_GUSD_ADDRESS']);
		await page.getByRole('tab', { name: 'Repay' }).click();
		// By role: a label regex alone also matches the tab panel, which the tab names.
		await fill(page.getByRole('textbox', { name: /repay/i }), '100');
		await submitAction(page, {
			button: /^Repay$/,
			review: 'Review repay',
			confirm: /^Confirm repay$/,
			// Repay reports the amount the contract actually took, not the verb the other actions use.
			success: /Repaid 100(\.\d+)? GSUSD/,
		});
		const repaid = before - (await balanceOf(env['VITE_GUSD_ADDRESS']));
		// The contract settles fee-inclusive debt, so a hair more than 100 can leave.
		expect(repaid >= parseEther('100')).toBe(true);
		expect(repaid < parseEther('101')).toBe(true);
	});

	test('withdraws 0.1 PAXG and names the unit', async ({ page }) => {
		const before = await balanceOf(env['VITE_PAXG_ADDRESS']);
		await page.getByRole('tab', { name: 'Withdraw' }).click();
		await expect(page.getByText('PAXG', { exact: true }).first()).toBeVisible();
		await expect(page.getByRole('button', { name: /^Max:.*PAXG$/ })).toBeVisible();
		await fill(page.getByLabel('Withdraw collateral'), '0.1');
		await submitAction(page, {
			button: /^Withdraw$/,
			review: 'Review withdraw',
			confirm: /^Confirm withdraw$/,
			success: /Withdrew 0\.1 PAXG/,
		});
		expect((await balanceOf(env['VITE_PAXG_ADDRESS'])) - before).toBe(parseUnits('0.1', 18));
	});

	test('closes the position: repays everything, withdraws the rest', async ({ page }) => {
		const paxgBefore = await balanceOf(env['VITE_PAXG_ADDRESS']);
		await page.getByRole('tab', { name: 'Repay' }).click();
		// The Max link reads "Close position" once the wallet can cover the fee-inclusive debt.
		await page.getByRole('button', { name: 'Close position' }).click();
		await submitAction(page, {
			button: /^Repay$/,
			review: 'Review repay',
			confirm: /^Confirm repay$/,
			success: /position is closed/,
		});
		await page.getByRole('tab', { name: 'Withdraw' }).click();
		await page.getByRole('button', { name: /^Max: .* PAXG$/ }).click();
		await submitAction(page, {
			button: /^Withdraw$/,
			review: 'Review withdraw',
			confirm: /^Confirm withdraw$/,
			success: /Withdrew/,
		});
		await expect(page.getByRole('heading', { name: 'No active vault' })).toBeVisible();
		// 1 PAXG in, 0.1 out earlier, 0.9 back now.
		expect((await balanceOf(env['VITE_PAXG_ADDRESS'])) - paxgBefore).toBe(parseUnits('0.9', 18));
	});
});
