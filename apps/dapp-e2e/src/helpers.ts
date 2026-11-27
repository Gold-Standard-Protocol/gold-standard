import { expect, type FrameLocator, type Locator, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createPublicClient, encodeFunctionData, http, maxUint256, parseAbi, type Address, type Hash, type Hex } from 'viem';

/** The node's account #1: the wallet the dapp connects to in e2e mode. */
export const WALLET: Address = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
/** The node's account #2: the vault the direct liquidation suite takes under water. */
export const VICTIM: Address = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';
/** The node's account #4: the smaller vault the stability pool absorbs. */
export const POOL_VICTIM: Address = '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65';
export const RPC = 'http://127.0.0.1:8546';

const CONTRACTS = resolve(__dirname, '../../../contracts');

/** Run one of the contracts scripts against the e2e node, as the bootstrap does. */
export function runHardhatScript(script: string, env: Record<string, string>, timeoutMs = 180_000): string {
	return execFileSync(process.execPath, [resolve(CONTRACTS, 'node_modules/hardhat/internal/cli/cli.js'), 'run', script, '--network', 'e2e'], {
		cwd: CONTRACTS,
		env: { ...process.env, ...env },
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
		timeout: timeoutMs,
	});
}

/** Addresses of the current run, as up.mjs wrote them for the dapp. */
export function deployment(): Record<string, string> {
	const file = resolve(__dirname, '../../dapp/.env.e2e.local');
	const out: Record<string, string> = {};
	for (const line of readFileSync(file, 'utf8').split('\n')) {
		const m = line.match(/^([A-Z_]+)=(.*)$/);
		if (m) out[m[1]] = m[2];
	}
	return out;
}

const erc20 = parseAbi([
	'function balanceOf(address) view returns (uint256)',
	'function allowance(address owner, address spender) view returns (uint256)',
	'function approve(address spender, uint256 amount) returns (bool)',
]);
const client = createPublicClient({ transport: http(RPC) });

/** Read a balance straight from the chain: the UI must have moved real state, not just its own view. */
export async function balanceOf(token: string, owner: Address = WALLET): Promise<bigint> {
	return client.readContract({ address: token as Address, abi: erc20, functionName: 'balanceOf', args: [owner] });
}

export async function allowanceOf(token: string, spender: string, owner: Address = WALLET): Promise<bigint> {
	return client.readContract({ address: token as Address, abi: erc20, functionName: 'allowance', args: [owner, spender as Address] });
}

/** Sends a transaction from the wallet straight to the node, which signs for it, and waits for it to mine. */
async function sendFromWallet(to: string, data: Hex): Promise<void> {
	const hash = await client.request<{ Method: 'eth_sendTransaction'; Parameters: [unknown]; ReturnType: Hash }>({
		method: 'eth_sendTransaction',
		params: [{ from: WALLET, to, data }],
	});
	const receipt = await client.waitForTransactionReceipt({ hash });
	if (receipt.status !== 'success') throw new Error(`A setup transaction to ${to} reverted.`);
}

/** Sets the wallet's allowance without the dapp: a spec that needs the approval step starts from zero. */
export async function setAllowance(token: string, spender: string, amount: bigint): Promise<void> {
	await sendFromWallet(token, encodeFunctionData({ abi: erc20, functionName: 'approve', args: [spender as Address, amount] }));
}

const vaultState = parseAbi([
	'function vaults(address) view returns (address collateralToken, uint256 collateralAmount, uint256 debtAmount)',
	'function getVaultCurrentDebt(address) view returns (uint256)',
	'function deposit(address token, uint256 amount)',
	'function mint(uint256 amount)',
]);
const oracleAbi = parseAbi(['function quoteBorrowPrice(address token) view returns (uint256)']);

export interface PreparedVault {
	symbol: 'PAXG' | 'XAUT';
	/** The oracle's borrowing price of the collateral, in whole dollars. */
	priceUsd: number;
}

/**
 * Leaves the wallet's vault at `ratioPercent` of collateral value to debt at the oracle's
 * current price, without the dapp: at least one unit of gold as collateral, then a mint up
 * to the ratio, or more collateral when the vault already owes more than that. A spec then
 * moves the price to put the vault where it needs it.
 */
export async function prepareVaultAtRatio(env: Record<string, string>, ratioPercent: bigint): Promise<PreparedVault> {
	const vault = env['VITE_GOLD_VAULT_ADDRESS'] as Address;
	const read = <T>(functionName: 'vaults' | 'getVaultCurrentDebt'): Promise<T> =>
		client.readContract({ address: vault, abi: vaultState, functionName, args: [WALLET] }) as Promise<T>;
	const [heldToken, held] = await read<readonly [Address, bigint, bigint]>('vaults');
	const token = (held > 0n ? heldToken : env['VITE_PAXG_ADDRESS']) as Address;
	const isXaut = token.toLowerCase() === env['VITE_XAUT_ADDRESS'].toLowerCase();
	const decimals = isXaut ? 6n : 18n;
	const deposit = async (amount: bigint): Promise<void> => {
		await setAllowance(token, vault, maxUint256);
		await sendFromWallet(vault, encodeFunctionData({ abi: vaultState, functionName: 'deposit', args: [token, amount] }));
	};

	const one = 10n ** decimals;
	if (held < one) await deposit(one - held);
	const collateral = held < one ? one : held;
	const price8 = await client.readContract({
		address: env['VITE_GOLD_ORACLE_ADDRESS'] as Address,
		abi: oracleAbi,
		functionName: 'quoteBorrowPrice',
		args: [token],
	});
	// Collateral value in GSUSD's 18 decimals.
	const scale = 10n ** (18n - decimals);
	const value = (collateral * scale * price8) / 10n ** 8n;
	const debt = await read<bigint>('getVaultCurrentDebt');
	const target = (value * 100n) / ratioPercent;
	if (debt < target) {
		await sendFromWallet(vault, encodeFunctionData({ abi: vaultState, functionName: 'mint', args: [target - debt] }));
	} else if (debt > target) {
		const shortfall = (debt * ratioPercent) / 100n - value;
		await deposit((shortfall * 10n ** 8n) / (price8 * scale) + 1n);
	}
	return { symbol: isXaut ? 'XAUT' : 'PAXG', priceUsd: Number(price8 / 10n ** 8n) };
}

const vaultAbi = parseAbi(['function originationFeeBps() view returns (uint256)']);

/** What a mint of `amount` delivers to the wallet: the vault keeps its origination fee (5 bps at launch). */
export async function mintDelivers(vault: string, amount: bigint): Promise<bigint> {
	const bps = await client.readContract({ address: vault as Address, abi: vaultAbi, functionName: 'originationFeeBps' });
	return amount - (amount * bps) / 10_000n;
}

export async function expectWalletConnected(page: Page): Promise<void> {
	// The header truncates to four characters each side: "0x70…79C8".
	await expect(page.getByRole('button', { name: /0x70.*79C8/i })).toBeVisible();
}

/**
 * The approval guard stands in for the action button until the allowance exists. It also
 * shows, for an instant and disabled, while the allowance is re-read after the amount
 * changes, so a one-shot "visible then click" races it. Instead: settle on whichever of the
 * two is live, click approve only while it is enabled, and stop once the action button is
 * there and enabled. A disabled action button also shows while the allowance loads, before
 * the guard replaces it, so visible alone is not ready. The enabled check lives in the
 * locator (`disabled: false`) and is read with `isVisible()`, which answers at once.
 * `isEnabled()` would instead wait, with no default timeout, for a button that the flash has
 * already re-rendered away, and hang the predicate.
 */
export async function approveIfAsked(page: Page, action: RegExp): Promise<void> {
	const approve = page.getByRole('button', { name: /^approv/i, disabled: false });
	const actionButton = page.getByRole('button', { name: action, disabled: false });
	await expect(async () => {
		if (await actionButton.isVisible()) return;
		if (await approve.isVisible()) await approve.click({ timeout: 5_000 });
		await expect(actionButton).toBeVisible({ timeout: 5_000 });
	}).toPass({ timeout: 90_000, intervals: [500, 1_000, 2_000] });
}

export interface ActionFlow {
	/** The action button's accessible name, for example /^Deposit$/. */
	button: RegExp;
	/** The review dialog heading, for example 'Review deposit'. */
	review: string | RegExp;
	/** The confirm button inside the review dialog. */
	confirm: RegExp;
	/** Text the confirmed dialog must contain. */
	success: RegExp;
}

/** Drive one review, confirm, confirmed, close cycle. */
export async function submitAction(page: Page, flow: ActionFlow): Promise<void> {
	await approveIfAsked(page, flow.button);
	await page.getByRole('button', { name: flow.button }).click();
	const dialog = page.getByRole('dialog');
	await expect(dialog.getByRole('heading', { name: flow.review })).toBeVisible();
	await dialog.getByRole('button', { name: flow.confirm }).click();
	// On a local chain the receipt lands inside the review dialog's 150 ms exit animation,
	// so for a moment two dialogs exist: the closing review and the opening receipt. An
	// unscoped getByRole('dialog') then fails strict mode outright, so scope to the open one.
	const receipt = page.locator('[role="dialog"][data-state="open"]');
	await expect(receipt.getByRole('heading', { name: 'Confirmed' })).toBeVisible({ timeout: 90_000 });
	await expect(receipt).toContainText(flow.success);
	// The dialog has two buttons named Close: the footer button, first in the DOM, and the
	// corner icon with visually hidden text, which Radix appends last.
	await receipt.getByRole('button', { name: 'Close', exact: true }).first().click();
	// toBeHidden on an unscoped dialog locator fails strict mode while the receipt is still
	// animating out beside anything else mounted; a count retries until every dialog is gone.
	await expect(page.getByRole('dialog')).toHaveCount(0);
}

/**
 * Trigger a liquidation button and wait for its effect on chain. The row re-renders as the
 * transaction goes through, so a retrying click can hang on the disabled replacement and a
 * single dispatched click can land on a node React has already swapped out. Instead: click
 * only while the button is enabled, bounded, and keep trying until `settled` reports the
 * chain has moved. Once the transaction is in flight the button is disabled, so this never
 * sends twice.
 */
export async function liquidateUntilSettled(button: Locator, settled: () => Promise<boolean>): Promise<void> {
	// `isEnabled()` waits for the element to attach and has no default timeout, so once the
	// liquidated row is gone it would wait forever and `settled` would never be read again.
	const enabled = () => button.isEnabled({ timeout: 1_000 }).catch(() => false);
	await expect(async () => {
		if (await enabled()) {
			await button.click({ timeout: 5_000, noWaitAfter: true }).catch(() => undefined);
		}
		expect(await settled()).toBe(true);
	}).toPass({ timeout: 150_000, intervals: [2_000, 5_000] });
}

export async function fill(input: Locator, value: string): Promise<void> {
	await input.click();
	await input.fill(value);
	await expect(input).toHaveValue(value);
}

/**
 * The deposit form's token: picks PAXG when the vault is empty and the picker is offered,
 * otherwise reads the token the vault already holds. Returns the symbol and its decimals,
 * since every amount on the wire scales by them.
 */
export async function depositToken(page: Page | FrameLocator): Promise<{ symbol: 'PAXG' | 'XAUT'; decimals: number }> {
	const choose = page.getByRole('button', { name: 'Choose token' });
	// A vault that holds collateral names its one token in a pill, not a button: it cannot be changed.
	const held = page.locator('[data-token-pill]', { hasText: /PAXG|XAUT/ }).first();
	// Decide only once the position is read: until then the form offers the picker even for a
	// vault that holds collateral, and a choice made in that moment is gone when the read lands.
	// "Liquidation price" stands only on a position that has been read; the heading alone is also on the loading card.
	await expect(page.getByText('Liquidation price').or(page.getByText('No active vault')).first()).toBeVisible();
	await expect(choose.or(held)).toBeVisible();
	if (await choose.isVisible()) {
		await choose.click();
		const picker = page.getByRole('dialog');
		await picker.getByRole('button', { name: /PAXG/ }).click();
		await expect(picker).toBeHidden();
		return { symbol: 'PAXG', decimals: 18 };
	}
	const text = await held.innerText();
	return /XAUT/.test(text) ? { symbol: 'XAUT', decimals: 6 } : { symbol: 'PAXG', decimals: 18 };
}

/** The open dialog: scoped so a closing dialog's exit animation never trips strict mode. */
export function openDialog(page: Page): Locator {
	return page.locator('[role="dialog"][data-state="open"]');
}

/** Wait for the receipt to confirm and close it. */
export async function closeConfirmedReceipt(page: Page): Promise<void> {
	const receipt = openDialog(page);
	await expect(receipt.getByRole('heading', { name: 'Confirmed' })).toBeVisible({ timeout: 90_000 });
	await receipt.getByRole('button', { name: 'Close', exact: true }).first().click();
	await expect(page.getByRole('dialog')).toHaveCount(0);
}
