import { expect, test, type Page } from '@playwright/test';
import { decodeFunctionData, parseAbi, parseUnits, toFunctionSelector, type Hex } from 'viem';
import { approveIfAsked, closeConfirmedReceipt, depositToken, expectWalletConnected, fill, openDialog, submitAction } from './helpers';
import { nextSentCalldata, probeRpc, rpc, wordAt, type RpcProbe } from './rpcProbe';

const E18 = 10n ** 18n;

/** The router calls a market swap sends: the swap rides inside multicall(deadline, data). */
const SWAP_ROUTER = parseAbi([
	'function multicall(uint256 deadline, bytes[] data) payable returns (bytes[])',
	'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) payable returns (uint256)',
]);

/** The amount and deadline of a sent market swap, checking it is the deadline form of multicall. */
function decodeMarketSwap(calldata: string): { amountIn: bigint; deadline: bigint } {
	const outer = decodeFunctionData({ abi: SWAP_ROUTER, data: calldata as Hex });
	if (outer.functionName !== 'multicall') throw new Error(`expected multicall, sent ${outer.functionName}`);
	const [deadline, calls] = outer.args;
	expect(calls).toHaveLength(1);
	const inner = decodeFunctionData({ abi: SWAP_ROUTER, data: calls[0] });
	if (inner.functionName !== 'exactInputSingle') throw new Error(`expected exactInputSingle, sent ${inner.functionName}`);
	return { amountIn: inner.args[0].amountIn, deadline };
}

/**
 * What the review shows is exactly what the wallet is asked to sign, every time: after a
 * completed transaction on the same page, while the simulation for a new amount is still
 * running, after a rejected signature, under a double click and with Escape pressed while
 * the wallet holds the request. Chain state is snapshotted and reverted around the file.
 */
test.describe.serial('review integrity', () => {
	let snapshot: unknown;
	test.beforeAll(async () => {
		snapshot = await rpc('evm_snapshot');
	});
	test.afterAll(async () => {
		await rpc('evm_revert', [snapshot]);
	});

	const bigFigure = async (page: Page): Promise<string> =>
		(await openDialog(page).locator('.font-serif').first().innerText()).replace(/\s+/g, ' ').trim();

	async function openReview(page: Page, button: RegExp, heading: string) {
		await page.getByRole('button', { name: button }).click();
		const review = openDialog(page);
		await expect(review.getByRole('heading', { name: heading })).toBeVisible();
		return review;
	}

	async function openVault(page: Page, probe?: RpcProbe) {
		await page.goto('/vault');
		await expectWalletConnected(page);
		expect(probe?.pageErrors ?? []).toEqual([]);
	}

	test('a review after a completed deposit shows and signs the amount typed now', async ({ page }) => {
		test.setTimeout(4 * 60_000);
		const probe = await probeRpc(page);
		await openVault(page);
		await page.getByRole('tab', { name: 'Deposit' }).click();
		const token = await depositToken(page);
		await fill(page.getByLabel(/you deposit/i), '1');
		await submitAction(page, { button: /^Deposit$/, review: 'Review deposit', confirm: /^Confirm deposit$/, success: new RegExp(`Deposited 1 ${token.symbol}`) });

		await fill(page.getByLabel(/you deposit/i), '2');
		await approveIfAsked(page, /^Deposit$/);
		const review = await openReview(page, /^Deposit$/, 'Review deposit');
		expect(await bigFigure(page)).toBe(`2 ${token.symbol}`);
		const before = probe.sent.length;
		await review.getByRole('button', { name: /^Confirm deposit$/ }).click();
		const data = await nextSentCalldata(probe, before);
		expect(wordAt(data, 1)).toBe(parseUnits('2', token.decimals));
		await closeConfirmedReceipt(page);
		expect(probe.pageErrors).toEqual([]);
	});

	test('confirm waits for the simulation of the new amount instead of signing the previous one', async ({ page }) => {
		test.setTimeout(4 * 60_000);
		const probe = await probeRpc(page);
		await openVault(page);
		await page.getByRole('tab', { name: 'Mint' }).click();
		// Typed 5000, settled; then 500 with its simulation held for six seconds, as a lagging
		// RPC would. Both clear the 100 GSUSD minimum, so only the lag separates them.
		probe.holdCall = { selector: toFunctionSelector('mint(uint256)'), wordIndex: 0, amount: 500n * E18, ms: 6_000 };
		await fill(page.getByLabel('Mint GSUSD'), '5000');
		await page.waitForTimeout(2_500);
		await page.getByLabel('Mint GSUSD').fill('500');
		await page.waitForTimeout(300);
		const review = await openReview(page, /^Mint GSUSD$/, 'Review mint');
		expect(await bigFigure(page)).toBe('500 GSUSD');
		const checking = review.getByRole('button', { name: 'Checking' });
		await expect(checking).toBeVisible();
		await expect(checking).toBeDisabled();
		await expect(checking).toHaveAttribute('aria-busy', 'true');
		const confirm = review.getByRole('button', { name: /^Confirm mint$/ });
		await expect(confirm).toBeEnabled({ timeout: 20_000 });
		probe.holdCall = undefined;
		const before = probe.sent.length;
		await confirm.click();
		const data = await nextSentCalldata(probe, before);
		expect(wordAt(data, 0)).toBe(500n * E18);
		await closeConfirmedReceipt(page);
		expect(probe.pageErrors).toEqual([]);
	});

	test('a rejected signature is explained in the review and forgotten by the next one', async ({ page }) => {
		test.setTimeout(4 * 60_000);
		const probe = await probeRpc(page);
		await openVault(page);
		await page.getByRole('tab', { name: 'Mint' }).click();
		probe.blockSends = true;
		await fill(page.getByLabel('Mint GSUSD'), '100');
		let review = await openReview(page, /^Mint GSUSD$/, 'Review mint');
		await review.getByRole('button', { name: /^Confirm mint$/ }).click();
		await expect(review.getByRole('alert')).toContainText(/rejected/i);
		await expect(review.getByRole('button', { name: /^Confirm mint$/ })).toBeEnabled();
		await page.keyboard.press('Escape');
		await expect(page.getByRole('dialog')).toHaveCount(0);
		probe.blockSends = false;

		await fill(page.getByLabel('Mint GSUSD'), '200');
		await expect(page.getByRole('button', { name: /^Mint GSUSD$/ })).toBeEnabled();
		review = await openReview(page, /^Mint GSUSD$/, 'Review mint');
		await expect(review.getByRole('alert')).toHaveCount(0);
		expect(await bigFigure(page)).toBe('200 GSUSD');
		await page.keyboard.press('Escape');
		await expect(page.getByRole('dialog')).toHaveCount(0);
		expect(probe.pageErrors).toEqual([]);
	});

	test('the pool Deposit button survives a rejected signature', async ({ page }) => {
		test.setTimeout(4 * 60_000);
		const probe = await probeRpc(page);
		await page.goto('/pool');
		await expectWalletConnected(page);
		await page.getByRole('tab', { name: 'Deposit' }).click();
		await fill(page.getByLabel(/you deposit/i), '10');
		await approveIfAsked(page, /^Deposit$/);
		probe.blockSends = true;
		const review = await openReview(page, /^Deposit$/, 'Review deposit');
		await review.getByRole('button', { name: /^Confirm deposit$/ }).click();
		await expect(review.getByRole('alert')).toContainText(/rejected/i);
		await page.keyboard.press('Escape');
		await expect(page.getByRole('dialog')).toHaveCount(0);
		probe.blockSends = false;
		await fill(page.getByLabel(/you deposit/i), '11');
		await expect(page.getByRole('button', { name: /^Deposit$/ })).toBeEnabled();
		expect(probe.pageErrors).toEqual([]);
	});

	test('two Confirm clicks in one frame send one request', async ({ page }) => {
		test.setTimeout(4 * 60_000);
		const probe = await probeRpc(page);
		await openVault(page);
		await page.getByRole('tab', { name: 'Mint' }).click();
		await fill(page.getByLabel('Mint GSUSD'), '100');
		const review = await openReview(page, /^Mint GSUSD$/, 'Review mint');
		const confirm = review.getByRole('button', { name: /^Confirm mint$/ });
		await expect(confirm).toBeEnabled();
		probe.holdSendsMs = 2_000;
		const before = probe.sendsArrived;
		await confirm.evaluate((el) => {
			(el as HTMLButtonElement).click();
			(el as HTMLButtonElement).click();
		});
		await page.waitForTimeout(1_000);
		expect(probe.sendsArrived - before).toBe(1);
		await closeConfirmedReceipt(page);
		expect(probe.sendsArrived - before).toBe(1);
		expect(probe.pageErrors).toEqual([]);
	});

	test('Escape while the wallet holds the request keeps the review open and the receipt follows it', async ({ page }) => {
		test.setTimeout(4 * 60_000);
		const probe = await probeRpc(page);
		await openVault(page);
		await page.getByRole('tab', { name: 'Mint' }).click();
		await fill(page.getByLabel('Mint GSUSD'), '100');
		const review = await openReview(page, /^Mint GSUSD$/, 'Review mint');
		probe.holdSendsMs = 4_000;
		await review.getByRole('button', { name: /^Confirm mint$/ }).click();
		await expect(review.getByRole('button', { name: 'Waiting for your wallet' })).toBeVisible();
		await page.keyboard.press('Escape');
		await page.mouse.click(5, 5);
		await page.waitForTimeout(500);
		await expect(review.getByRole('heading', { name: 'Review mint' })).toBeVisible();
		await expect(review.getByText('Waiting for your wallet. Reject in your wallet to cancel.')).toBeVisible();
		await closeConfirmedReceipt(page);
		expect(probe.pageErrors).toEqual([]);
	});

	test('pool and swap reviews after a completed transaction show and sign the new amount', async ({ page }) => {
		test.setTimeout(8 * 60_000);
		const probe = await probeRpc(page);

		await page.goto('/pool');
		await expectWalletConnected(page);
		await page.getByRole('tab', { name: 'Deposit' }).click();
		await fill(page.getByLabel(/you deposit/i), '10');
		await submitAction(page, { button: /^Deposit$/, review: 'Review deposit', confirm: /^Confirm deposit$/, success: /Deposited 10 GSUSD/ });
		await fill(page.getByLabel(/you deposit/i), '20');
		await approveIfAsked(page, /^Deposit$/);
		let review = await openReview(page, /^Deposit$/, 'Review deposit');
		expect(await bigFigure(page)).toBe('20 GSUSD');
		let before = probe.sent.length;
		await review.getByRole('button', { name: /^Confirm deposit$/ }).click();
		expect(wordAt(await nextSentCalldata(probe, before), 0)).toBe(20n * E18);
		await closeConfirmedReceipt(page);

		await page.goto('/swap');
		await expectWalletConnected(page);
		await page.getByRole('tab', { name: /Reserve swap/ }).click();
		await page.getByRole('button', { name: /Paxos Gold/ }).click();
		await fill(page.getByLabel('Swap GSUSD'), '10');
		await submitAction(page, { button: /^Swap GSUSD for PAXG$/, review: 'Review swap', confirm: /^Confirm swap$/, success: /Swapped 10 GSUSD/ });
		await fill(page.getByLabel('Swap GSUSD'), '20');
		await approveIfAsked(page, /^Swap GSUSD for PAXG$/);
		review = await openReview(page, /^Swap GSUSD for PAXG$/, 'Review swap');
		expect(await bigFigure(page)).toBe('20 GSUSD');
		before = probe.sent.length;
		await review.getByRole('button', { name: /^Confirm swap$/ }).click();
		expect(wordAt(await nextSentCalldata(probe, before), 1)).toBe(20n * E18);
		await closeConfirmedReceipt(page);

		await page.getByRole('tab', { name: 'Market swap' }).click();
		await page.getByRole('group', { name: 'Swap direction' }).getByRole('button', { name: 'GSUSD to gold' }).click();
		await page.getByRole('button', { name: /Paxos Gold/ }).click();
		await fill(page.getByLabel('Sell GSUSD'), '10');
		await expect(page.getByText('Uniswap v3', { exact: false }).first()).toBeVisible();
		await submitAction(page, { button: /^Swap GSUSD for PAXG$/, review: 'Review swap', confirm: /^Confirm swap$/, success: /Swapped 10 GSUSD for \d[\d.,]* PAXG on Uniswap v3\./ });
		await fill(page.getByLabel('Sell GSUSD'), '20');
		await approveIfAsked(page, /^Swap GSUSD for PAXG$/);
		review = await openReview(page, /^Swap GSUSD for PAXG$/, 'Review swap');
		expect(await bigFigure(page)).toBe('20 GSUSD');
		before = probe.sent.length;
		await review.getByRole('button', { name: /^Confirm swap$/ }).click();
		// The swap is signed with a deadline at most 20 minutes out.
		const swap = decodeMarketSwap(await nextSentCalldata(probe, before));
		expect(swap.amountIn).toBe(20n * E18);
		const now = BigInt(Math.floor(Date.now() / 1000));
		expect(swap.deadline > now).toBe(true);
		expect(swap.deadline <= now + 20n * 60n).toBe(true);
		await closeConfirmedReceipt(page);
		expect(probe.pageErrors).toEqual([]);
	});
});
