import { expect, test, type Locator, type Page } from '@playwright/test';
import { depositToken, expectWalletConnected, fill, openDialog } from './helpers';
import { rpc } from './rpcProbe';

/**
 * Every amount field runs the same parser: text that is not a plain decimal, more decimals
 * than the token carries, zero and more than the balance all disable the action and say why
 * under the field. Nothing is sanitised in silence, and a seventh decimal on a 6-decimal
 * token is refused at the keystroke rather than rounded into a figure the wallet never sees.
 */
const HOSTILE: [string, RegExp][] = [
	['1e3', /Only digits and one decimal point/],
	['-1', /Only digits and one decimal point/],
	['+1', /Only digits and one decimal point/],
	['0x10', /Only digits and one decimal point/],
	['1,000', /Only digits and one decimal point/],
	['1 000', /Only digits and one decimal point/],
	['abc', /Only digits and one decimal point/],
	['١٢٣', /Only digits and one decimal point/],
	['0.0', /Enter an amount/],
	['9'.repeat(70), /too large|More than your balance/],
];

async function expectRefused(page: Page, field: Locator, button: RegExp, typed: string, reason: RegExp): Promise<void> {
	await field.fill(typed);
	await expect(page.getByRole('button', { name: button })).toBeDisabled();
	await expect(page.getByRole('status').filter({ hasText: reason })).toBeVisible();
}

test.describe.serial('amount validation', () => {
	let snapshot: unknown;
	test.beforeAll(async () => {
		snapshot = await rpc('evm_snapshot');
	});
	test.afterAll(async () => {
		await rpc('evm_revert', [snapshot]);
	});

	test('vault deposit refuses hostile text and a digit beyond the token decimals', async ({ page }) => {
		test.setTimeout(4 * 60_000);
		await page.goto('/vault');
		await expectWalletConnected(page);
		await page.getByRole('tab', { name: 'Deposit' }).click();
		const token = await depositToken(page);
		const field = page.getByLabel(/you deposit/i);
		for (const [typed, reason] of HOSTILE) {
			await expectRefused(page, field, /^Deposit$/, typed, reason);
		}
		// The last allowed decimal is accepted; one more is refused and the field does not change.
		const edge = `0.${'0'.repeat(token.decimals - 1)}1`;
		await fill(field, edge);
		await field.pressSequentially('5');
		await expect(field).toHaveValue(edge);
		// A paste with too many decimals is refused whole.
		await field.fill(`0.${'0'.repeat(token.decimals)}5`);
		await expect(field).toHaveValue(edge);
		await field.fill('');
		await expect(page.getByRole('status')).toHaveCount(0);
	});

	test('mint takes whole dollars only and explains anything else', async ({ page }) => {
		await page.goto('/vault');
		await expectWalletConnected(page);
		await page.getByRole('tab', { name: 'Mint' }).click();
		const field = page.getByLabel('Mint GSUSD');
		if (await field.isDisabled()) {
			test.info().annotations.push({ type: 'note', description: 'no collateral held: mint field disabled' });
			return;
		}
		await expectRefused(page, field, /^Mint GSUSD$/, '1e3', /Only digits and one decimal point/);
		await expectRefused(page, field, /^Mint GSUSD$/, '0', /Enter an amount/);
		await fill(field, '100');
		await field.fill('100.5');
		await expect(field).toHaveValue('100');
		await expect(page.getByRole('button', { name: /^Mint GSUSD$/ })).toBeEnabled();
		await page.getByRole('button', { name: /^Mint GSUSD$/ }).click();
		await expect(openDialog(page).getByText('100 GSUSD', { exact: true })).toBeVisible();
		await expect(openDialog(page).getByText(/You receive 99\.95 GSUSD after the 0\.05% mint fee/)).toBeVisible();
		await page.keyboard.press('Escape');
	});

	test('pool deposit and withdraw refuse hostile text', async ({ page }) => {
		await page.goto('/pool');
		await expectWalletConnected(page);
		await page.getByRole('tab', { name: 'Deposit' }).click();
		for (const [typed, reason] of HOSTILE.slice(0, 4)) {
			await expectRefused(page, page.getByLabel(/you deposit/i), /^Deposit$/, typed, reason);
		}
		await page.getByRole('tab', { name: 'Withdraw' }).click();
		await expectRefused(page, page.getByRole('textbox', { name: /withdraw/i }), /^Withdraw$/, 'abc', /Only digits and one decimal point/);
		await expectRefused(page, page.getByRole('textbox', { name: /withdraw/i }), /^Withdraw$/, '0.0', /Enter an amount/);
	});

	test('swap forms keep rejecting hostile text', async ({ page }) => {
		await page.goto('/swap');
		await expectWalletConnected(page);
		await page.getByRole('tab', { name: /Reserve swap/ }).click();
		await page.getByRole('button', { name: /Paxos Gold/ }).click();
		await page.getByLabel('Swap GSUSD').fill('1e3');
		await expect(page.getByRole('alert').filter({ hasText: /valid GSUSD amount/ })).toBeVisible();
		await expect(page.getByRole('button', { name: /^Swap GSUSD for PAXG$/ })).toBeDisabled();
	});
});
