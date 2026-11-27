import { expect, test, type Page } from '@playwright/test';
import { toFunctionSelector } from 'viem';
import {
	approveIfAsked,
	deployment,
	expectWalletConnected,
	fill,
	openDialog,
	prepareVaultAtRatio,
	RPC,
	runHardhatScript,
	submitAction,
	WALLET,
} from './helpers';
import { rpc } from './rpcProbe';

/**
 * What the dapp says when the chain cannot be read, and what it lets the holder of an
 * unhealthy vault do. Each of these used to state something untrue:
 * a failed position read said "No active vault", an RPC failure during the receipt wait said
 * the transaction had reverted, and the preview refused the deposit and the repayment that
 * repair a vault below its minimum ratio.
 *
 * The suite's chain is restored afterwards: the last test moves the oracle.
 */
const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 900 };

/** Answers 503 to every RPC request whose body contains `needle`, for as long as `failing()` holds. */
async function failRpcWhile(page: Page, needle: string, failing: () => boolean): Promise<void> {
	await page.route(`${RPC}/**`, async (route) => {
		const body = (route.request().postData() ?? '').toLowerCase();
		if (failing() && body.includes(needle.toLowerCase())) {
			await route.fulfill({ status: 503, contentType: 'text/plain', body: 'unavailable' });
			return;
		}
		await route.continue();
	});
}

/** No sideways scroll: nothing in the page is wider than the viewport. */
async function expectNoOverflow(page: Page): Promise<void> {
	const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
	expect(overflow).toBeLessThanOrEqual(0);
}

test.describe.serial('degraded reads and unhealthy vaults', () => {
	let snapshot: unknown;
	test.beforeAll(async () => {
		snapshot = await rpc('evm_snapshot');
	});
	test.afterAll(async () => {
		await rpc('evm_revert', [snapshot]);
		await rpc('evm_setAutomine', [true]);
	});

	test('a position read that fails is not an empty vault', async ({ page }, testInfo) => {
		// The read as it travels inside a Multicall3 batch: the selector, then the owner.
		const positionRead = toFunctionSelector('vaults(address)').slice(2) + WALLET.slice(2).padStart(64, '0');
		let failing = true;
		await failRpcWhile(page, positionRead, () => failing);

		await page.goto('/vault');
		await expectWalletConnected(page);
		const notice = page.getByRole('status').filter({ hasText: 'Your position could not be read' });
		await expect(notice).toBeVisible({ timeout: 60_000 });
		await expect(notice).toContainText('The vault itself is unaffected');
		await expect(page.getByRole('heading', { name: 'No active vault' })).toHaveCount(0);
		await page.screenshot({ path: testInfo.outputPath('position-unread-desktop.png') });

		await page.setViewportSize(PHONE);
		await expect(notice).toBeVisible();
		await expectNoOverflow(page);
		// The button stays through each automatic retry, reading "Retrying" while one runs.
		const retry = page.getByRole('button', { name: /^Retry/ });
		expect(await retry.evaluate((element) => (element as HTMLElement).offsetHeight)).toBeGreaterThanOrEqual(44);
		await retry.scrollIntoViewIfNeeded();
		await page.screenshot({ path: testInfo.outputPath('position-unread-phone.png') });
		await page.setViewportSize(DESKTOP);

		// The notice and its button hold through a whole retry cycle; they used to give way to
		// the loading skeleton each time the read was tried again.
		await page.waitForTimeout(12_000);
		await expect(notice).toBeVisible();
		await expect(retry).toBeVisible();

		// The chain answers again: Retry now, from the keyboard, reads the position.
		failing = false;
		await retry.focus();
		await page.keyboard.press('Enter');
		await expect(notice).toHaveCount(0);
		await expect(page.getByRole('heading', { name: 'Position overview' }).or(page.getByRole('heading', { name: 'No active vault' }))).toBeVisible();
	});

	test('a receipt wait that cannot read the chain says so, and never that the transaction reverted', async ({ page }, testInfo) => {
		test.setTimeout(4 * 60_000);
		let failing = false;
		await failRpcWhile(page, 'eth_getTransactionReceipt', () => failing);

		await page.goto('/pool');
		await expectWalletConnected(page);
		await page.getByRole('tab', { name: 'Deposit' }).click();
		await fill(page.getByLabel(/you deposit/i), '5');
		await approveIfAsked(page, /^Deposit$/);

		// Hold the transaction in the mempool, then mine it while its receipt cannot be read.
		await rpc('evm_setAutomine', [false]);
		const receipt = openDialog(page);
		try {
			await page.getByRole('button', { name: /^Deposit$/ }).click();
			await openDialog(page).getByRole('button', { name: /^Confirm deposit$/ }).click();
			await expect(receipt.getByRole('status', { name: 'Waiting for confirmation' })).toBeVisible({ timeout: 30_000 });
			failing = true;
			await rpc('evm_mine');

			const unconfirmed = receipt.getByRole('status', { name: 'Not confirmed yet' });
			await expect(unconfirmed).toBeVisible({ timeout: 60_000 });
			await expect(unconfirmed).toContainText('may still succeed');
			await expect(receipt).not.toContainText(/reverted|Transaction failed/);
			// The wait goes on, and the explorer is the one place the result can be checked.
			await expect(unconfirmed.locator('svg')).toBeVisible();
			await expect(receipt.getByRole('link', { name: /View on Etherscan/ })).toBeVisible();
			await page.screenshot({ path: testInfo.outputPath('unconfirmed-desktop.png') });
			await page.setViewportSize(PHONE);
			await expect(unconfirmed).toBeVisible();
			await expectNoOverflow(page);
			await page.screenshot({ path: testInfo.outputPath('unconfirmed-phone.png') });
			await page.setViewportSize(DESKTOP);
		} finally {
			failing = false;
			await rpc('evm_mine');
			await rpc('evm_setAutomine', [true]);
		}

		// The chain answers again and the same receipt confirms: the transaction was mined all along.
		await expect(receipt.getByRole('heading', { name: 'Confirmed' })).toBeVisible({ timeout: 90_000 });
		await receipt.getByRole('button', { name: 'Close', exact: true }).first().click();
		await expect(page.getByRole('dialog')).toHaveCount(0);
		expect(await rpc('hardhat_getAutomine')).toBe(true);
	});

	test('a vault below its minimum ratio can be topped up and repaid, and still cannot mint', async ({ page }, testInfo) => {
		test.setTimeout(6 * 60_000);
		const env = deployment();
		// 134% at today's price, above the 130% minimum; gold then falls 7.5% and leaves the
		// vault near 124%: under the minimum and well clear of the 110% liquidation ratio.
		const { symbol, priceUsd } = await prepareVaultAtRatio(env, 134n);
		runHardhatScript('scripts/walk-testnet-price.ts', { TARGET_PRICE_USD: String(Math.round(priceUsd * 0.925)) });
		const stillBelow = page.getByText('Still below the 130% minimum. Minting and withdrawing stay locked.');

		await page.goto('/vault');
		await expectWalletConnected(page);

		// A deposit raises the ratio, and the contract takes it at any ratio.
		await page.getByRole('tab', { name: 'Deposit' }).click();
		await fill(page.getByLabel(/you deposit/i), '0.01');
		await expect(stillBelow).toBeVisible({ timeout: 30_000 });
		await expect(page.getByText(/Ratio would drop below/)).toHaveCount(0);
		await stillBelow.scrollIntoViewIfNeeded();
		await page.screenshot({ path: testInfo.outputPath('below-minimum-deposit-desktop.png') });
		await page.setViewportSize(PHONE);
		await expect(stillBelow).toBeVisible();
		await expectNoOverflow(page);
		await stillBelow.scrollIntoViewIfNeeded();
		await page.screenshot({ path: testInfo.outputPath('below-minimum-deposit-phone.png') });
		await page.setViewportSize(DESKTOP);
		await submitAction(page, {
			button: /^Deposit$/,
			review: 'Review deposit',
			confirm: /^Confirm deposit$/,
			success: new RegExp(`Deposited 0\\.01 ${symbol}`),
		});

		// So does a repayment.
		await page.getByRole('tab', { name: 'Repay' }).click();
		await fill(page.getByRole('textbox', { name: /repay/i }), '100');
		await expect(stillBelow).toBeVisible({ timeout: 30_000 });
		await submitAction(page, {
			button: /^Repay$/,
			review: 'Review repay',
			confirm: /^Confirm repay$/,
			success: /Repaid 100(\.\d+)? GSUSD/,
		});

		// A mint lowers the ratio: the minimum still applies, as it does in the contract.
		await page.getByRole('tab', { name: 'Mint' }).click();
		await fill(page.getByLabel('Mint GSUSD'), '100');
		await expect(page.getByText(/Ratio would drop below 130%/)).toBeVisible({ timeout: 30_000 });
		await expect(stillBelow).toHaveCount(0);
		await expect(page.getByRole('button', { name: /^Mint GSUSD$/, disabled: false })).toHaveCount(0);
	});
});
