import { expect, test, type FrameLocator } from '@playwright/test';
import { parseUnits } from 'viem';
import { allowanceOf, balanceOf, deployment, depositToken, fill, setAllowance } from './helpers';
import { rpc } from './rpcProbe';
import { openInSafe } from './safeHost';

/**
 * The dapp as a Safe App. Inside Safe{Wallet} a write is a
 * proposal: the wallet answers with the proposal's hash, which no chain node or explorer
 * knows, and nothing is on-chain until the owners sign. safeHost.ts stands in for
 * Safe{Wallet}; the connector, the SDK and the provider inside the frame are the real ones.
 */
const AMOUNT = '0.01';
const TOKEN_ENV = { PAXG: 'VITE_PAXG_ADDRESS', XAUT: 'VITE_XAUT_ADDRESS' } as const;
/** The follow asks the Safe every 15 seconds; two rounds and a margin. */
const FOLLOWED = { timeout: 45_000 };

/**
 * The review dialog fades out beside the receipt for a moment, and Radix hides it from the
 * accessibility tree at once, so a role query stops counting it while it is still painted.
 * Count the nodes, then let the receipt's own entrance finish.
 */
async function receiptSettled(app: FrameLocator): Promise<void> {
	await expect(app.locator('[role="dialog"]')).toHaveCount(1);
	await app
		.locator('[role="dialog"]')
		.evaluate((element) => Promise.all(element.getAnimations({ subtree: true }).map((animation) => animation.finished)));
}

test.describe.serial('inside Safe{Wallet}', () => {
	let env: Record<string, string>;
	let snapshot: unknown;
	test.beforeAll(async () => {
		env = deployment();
		snapshot = await rpc('evm_snapshot');
		// Earlier specs left unlimited approvals; the approval step must start from nothing.
		for (const key of Object.values(TOKEN_ENV)) await setAllowance(env[key], env['VITE_GOLD_VAULT_ADDRESS'], 0n);
	});
	// The approvals and the vault go back to how the earlier specs left them.
	test.afterAll(async () => {
		await rpc('evm_revert', [snapshot]);
	});

	test('an approval and a deposit are proposals until the owners sign', async ({ page, baseURL }) => {
		const safe = await openInSafe(page, baseURL ?? 'http://localhost:4201', '/vault');
		const { app } = safe;
		// The Safe connector connected by itself: the header names the Safe.
		await expect(app.getByRole('button', { name: /0x70.*79C8/i })).toBeVisible();

		await app.getByRole('tab', { name: 'Deposit' }).click();
		const { symbol, decimals } = await depositToken(app);
		const token = env[TOKEN_ENV[symbol]];
		const vault = env['VITE_GOLD_VAULT_ADDRESS'];
		await fill(app.getByLabel(/you deposit/i), AMOUNT);

		// The approval is proposed, not sent: the guard says so and keeps its button live.
		const approve = app.getByRole('button', { name: `Approve ${symbol}`, disabled: false });
		await approve.click();
		await expect(app.getByText(`Approval of ${symbol} proposed to your Safe`)).toBeVisible();
		await expect(approve).toBeVisible();
		await expect(app.getByRole('alert')).toHaveCount(0);
		const [approval] = await safe.proposals();
		expect(approval.to.toLowerCase()).toBe(token.toLowerCase());
		expect(await allowanceOf(token, vault)).toBe(0n);

		// The owners sign. Nothing on the page is touched: the follow finds the execution.
		await safe.execute(approval.safeTxHash);
		const deposit = app.getByRole('button', { name: /^Deposit$/, disabled: false });
		await expect(deposit).toBeVisible(FOLLOWED);
		expect(await allowanceOf(token, vault)).toBeGreaterThan(0n);

		await deposit.click();
		const dialog = app.locator('[role="dialog"][data-state="open"]');
		await expect(dialog.getByRole('heading', { name: 'Review deposit' })).toBeVisible();
		await dialog.getByRole('button', { name: /^Confirm deposit$/ }).click();

		// A proposal: no spinner to sit through, and no link to a hash no explorer knows.
		await expect(dialog.getByRole('heading', { name: 'Proposed to your Safe' })).toBeVisible();
		await expect(dialog).toContainText('Nothing has changed on-chain yet');
		await expect(dialog.getByRole('link', { name: /Etherscan/ })).toHaveCount(0);
		await receiptSettled(app);
		await page.screenshot({ path: test.info().outputPath('proposed-desktop.png') });
		const before = await balanceOf(token);
		const proposal = (await safe.proposals()).at(-1);
		expect(proposal?.executedHash).toBeNull();

		// Once executed, the open receipt confirms and links the executing transaction.
		const executed = await safe.execute(proposal?.safeTxHash ?? '');
		await expect(dialog.getByRole('heading', { name: 'Confirmed' })).toBeVisible(FOLLOWED);
		await expect(dialog).toContainText(new RegExp(`Deposited ${AMOUNT.replace('.', '\\.')} ${symbol}`));
		await expect(dialog.getByRole('link', { name: /View on Etherscan/ })).toHaveAttribute('href', new RegExp(`/tx/${executed}$`));
		expect(before - (await balanceOf(token))).toBe(parseUnits(AMOUNT, decimals));
		await page.screenshot({ path: test.info().outputPath('confirmed-desktop.png') });

		await dialog.getByRole('button', { name: 'Close', exact: true }).first().click();
		await expect(app.getByRole('dialog')).toHaveCount(0);
	});

	// Reduced motion: the page scrolls smoothly otherwise, and at this width a click races the
	// scroll that brings the form out from under the sticky header.
	test.describe('at phone width', () => {
		test.use({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });

		test('a proposal closed from the keyboard clears the form and reopens nothing', async ({ page, baseURL }) => {
			const safe = await openInSafe(page, baseURL ?? 'http://localhost:4201', '/vault');
			const { app } = safe;
			await expect(app.getByRole('button', { name: /0x70.*79C8/i })).toBeVisible();
			// Deposit is the tab the vault page opens on.
			const { symbol, decimals } = await depositToken(app);
			const token = env[TOKEN_ENV[symbol]];
			const amount = app.getByLabel(/you deposit/i);
			await fill(amount, AMOUNT);

			await app.getByRole('button', { name: /^Deposit$/, disabled: false }).click();
			const dialog = app.locator('[role="dialog"][data-state="open"]');
			await dialog.getByRole('button', { name: /^Confirm deposit$/ }).click();
			await expect(dialog.getByRole('heading', { name: 'Proposed to your Safe' })).toBeVisible();
			await receiptSettled(app);

			// Nothing is clipped or scrolls sideways at phone width, and Close is a full tap target.
			const layout = await dialog.evaluate((element) => {
				const box = element.getBoundingClientRect();
				const close = Array.from(element.querySelectorAll('button')).find((button) => button.textContent?.trim() === 'Close');
				return {
					overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
					left: box.left,
					right: window.innerWidth - box.right,
					closeHeight: close?.offsetHeight ?? 0,
				};
			});
			expect(layout.overflow).toBeLessThanOrEqual(0);
			expect(layout.left).toBeGreaterThanOrEqual(0);
			expect(layout.right).toBeGreaterThanOrEqual(0);
			expect(layout.closeHeight).toBeGreaterThanOrEqual(44);
			await page.screenshot({ path: test.info().outputPath('proposed-phone.png') });

			// Escape closes it. The amount is with the Safe now, so the form is empty again.
			await page.keyboard.press('Escape');
			await expect(app.getByRole('dialog')).toHaveCount(0);
			await expect(amount).toHaveValue('');

			// The execution arrives with the receipt closed: the chain moves and nothing reopens.
			const before = await balanceOf(token);
			const proposal = (await safe.proposals()).at(-1);
			await safe.execute(proposal?.safeTxHash ?? '');
			expect(before - (await balanceOf(token))).toBe(parseUnits(AMOUNT, decimals));
			await page.waitForTimeout(20_000);
			await expect(app.getByRole('dialog')).toHaveCount(0);
			await expect(app.getByRole('alert')).toHaveCount(0);
		});
	});
});
