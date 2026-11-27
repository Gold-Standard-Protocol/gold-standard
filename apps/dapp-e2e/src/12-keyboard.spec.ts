import { expect, test, type Page } from '@playwright/test';
import { approveIfAsked, expectWalletConnected, fill, openDialog } from './helpers';

interface FocusReport {
	tag: string;
	name: string;
	ring: boolean;
	inDialog: boolean;
}

/** The focused element: what it is, whether its focus is visible and whether it sits inside a dialog. */
function describeFocus(page: Page): Promise<FocusReport> {
	return page.evaluate(() => {
		const el = document.activeElement;
		if (!(el instanceof HTMLElement) || el === document.body) return { tag: 'body', name: '', ring: false, inDialog: false };
		const style = getComputedStyle(el);
		const ring = (style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0) || (style.boxShadow !== 'none' && style.boxShadow !== '');
		return {
			tag: el.tagName.toLowerCase(),
			name: (el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 40),
			ring,
			inDialog: el.closest('[role="dialog"]') !== null,
		};
	});
}

/**
 * The review dialog from the keyboard alone: Enter on the action opens it, focus lands
 * inside, Tab never leaves it, Escape closes it and focus returns to the button that
 * opened it. The accessibility suite covers structure without a wallet; this covers the
 * one interactive flow that needs one.
 */
test('the review dialog is reachable, trapped and returned from by keyboard', async ({ page }) => {
	test.setTimeout(3 * 60_000);
	await page.goto('/pool');
	await expectWalletConnected(page);
	await page.getByRole('tab', { name: 'Deposit' }).click();
	await fill(page.getByLabel(/you deposit/i), '5');
	await approveIfAsked(page, /^Deposit$/);

	const trigger = page.getByRole('button', { name: /^Deposit$/ });
	await trigger.focus();
	expect((await describeFocus(page)).ring).toBe(true);
	await page.keyboard.press('Enter');
	const review = openDialog(page);
	await expect(review.getByRole('heading', { name: 'Review deposit' })).toBeVisible();
	await expect.poll(async () => (await describeFocus(page)).inDialog).toBe(true);

	for (let i = 0; i < 6; i += 1) {
		await page.keyboard.press('Tab');
		const focus = await describeFocus(page);
		expect(focus.inDialog, `tab stop ${i + 1} (${focus.tag} ${focus.name}) left the dialog`).toBe(true);
		expect(focus.ring, `tab stop ${i + 1} (${focus.tag} ${focus.name}) has no visible focus`).toBe(true);
	}

	await page.keyboard.press('Escape');
	await expect(page.getByRole('dialog')).toHaveCount(0);
	await expect(trigger).toBeFocused();
});

/**
 * The receipt has no trigger of its own, so focus used to fall back to the page body when
 * it closed. It now goes back into the page, the corner Close is a full size target at
 * phone width, and the outcome is announced from one status region that stays mounted.
 */
test('the receipt announces its outcome, has a full size close target and hands focus back', async ({ page }) => {
	test.setTimeout(3 * 60_000);
	await page.setViewportSize({ width: 375, height: 800 });
	await page.goto('/pool');
	await expectWalletConnected(page);
	await page.getByRole('tab', { name: 'Deposit' }).click();
	await fill(page.getByLabel(/you deposit/i), '5');
	await approveIfAsked(page, /^Deposit$/);

	await page.getByRole('button', { name: /^Deposit$/ }).click();
	await openDialog(page).getByRole('button', { name: /^Confirm deposit$/ }).click();

	const receipt = openDialog(page);
	const confirmed = receipt.getByRole('status', { name: 'Confirmed' });
	await expect(confirmed).toBeVisible({ timeout: 90_000 });
	await expect(confirmed).toHaveAttribute('aria-live', 'polite');

	const corner = receipt.getByRole('button', { name: 'Close', exact: true }).last();
	// Layout size, not the bounding box: the dialog is still scaling in and a transform would shrink it.
	const size = await corner.evaluate((el) => ({ width: (el as HTMLElement).offsetWidth, height: (el as HTMLElement).offsetHeight }));
	expect(size.width).toBeGreaterThanOrEqual(44);
	expect(size.height).toBeGreaterThanOrEqual(44);

	await receipt.getByRole('button', { name: 'Close', exact: true }).first().focus();
	await page.keyboard.press('Enter');
	await expect(page.getByRole('dialog')).toHaveCount(0);
	await expect
		.poll(() => page.evaluate(() => document.activeElement !== document.body && document.activeElement?.closest('main') !== null))
		.toBe(true);
});
