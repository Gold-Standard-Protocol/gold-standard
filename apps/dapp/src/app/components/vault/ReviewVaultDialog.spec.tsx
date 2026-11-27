import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { Button, DialogTrigger } from '@goldstandard/ui';
import type { WriteCallbacks, WriteFn } from '@goldstandard/hooks';
import type { MintFeeSplit } from '@goldstandard/utils';
import {
	outcomeSentence,
	ReviewVaultDialog,
	type RepaySettlement,
	type VaultOutcome,
} from './ReviewVaultDialog';

describe('outcomeSentence', () => {
	it('states debt, ratio and the liquidation price a reader can check against the card', () => {
		expect(
			outcomeSentence({ debt: 4_000n * 10n ** 18n, ratioPercent: 200, liquidationPrice: 2200 })
		).toBe(
			'Your vault will owe 4,000.00 GSUSD at a 200.0% collateral ratio, liquidatable below $2,200.00 per ounce.'
		);
	});

	it('says a debt-free vault cannot be liquidated instead of printing an infinite ratio', () => {
		expect(outcomeSentence({ debt: 0n, ratioPercent: Infinity, liquidationPrice: 0 })).toBe(
			'Your vault will owe nothing, so it cannot be liquidated.'
		);
	});

	it('caps an asymptotic ratio in words that still read as a sentence', () => {
		expect(outcomeSentence({ debt: 10n ** 18n, ratioPercent: 40_000, liquidationPrice: 1.1 })).toBe(
			'Your vault will owe 1.00 GSUSD at a collateral ratio above 1,000%, liquidatable below $1.10 per ounce.'
		);
	});
});

const E18 = 10n ** 18n;
const TX_HASH = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
const AFTERWARDS: VaultOutcome = { debt: 100n * E18, ratioPercent: 200, liquidationPrice: 2200 };

/** What the form hands the dialog: it empties both once the wallet no longer covers the typed amount. */
interface FormReading {
	amount: string;
	outcome: VaultOutcome | undefined;
}

const TYPED: FormReading = { amount: '900', outcome: AFTERWARDS };
const EMPTIED: FormReading = { amount: '', outcome: undefined };

interface RepayView {
	status: 'pending' | 'success';
	settlement: RepaySettlement | undefined;
	repaid?: bigint;
	write: (callbacks?: WriteCallbacks) => void;
	form?: FormReading;
}

function repayDialog({ status, settlement, repaid, write, form = TYPED }: RepayView) {
	return (
		<ReviewVaultDialog
			action="repay"
			amount={form.amount}
			write={write}
			reset={() => undefined}
			confirmationStatus={status}
			outcome={form.outcome}
			isSimulationSuccess
			isSimulationError={false}
			simulationError={null}
			txHash={status === 'success' ? TX_HASH : undefined}
			settlement={settlement}
			repaidAmount={repaid}
		>
			{() => (
				<DialogTrigger asChild>
					<Button>Open</Button>
				</DialogTrigger>
			)}
		</ReviewVaultDialog>
	);
}

/** Confirms a repay against `atClick`, then lands the receipt while the live settlement reads `afterwards`. */
async function repayReceipt(
	atClick: RepaySettlement,
	afterwards: RepaySettlement | undefined,
	repaid: bigint,
	formAfter: FormReading = TYPED
): Promise<string> {
	let onSuccess: (() => void) | undefined;
	const write = vi.fn((callbacks?: WriteCallbacks) => {
		onSuccess = callbacks?.onSuccess;
	});
	const { rerender } = render(repayDialog({ status: 'pending', settlement: atClick, write }));
	fireEvent.click(screen.getByText('Open'));
	fireEvent.click(await screen.findByText('Confirm repay'));
	act(() => onSuccess?.());
	rerender(repayDialog({ status: 'success', settlement: afterwards, repaid, write, form: formAfter }));
	return document.body.textContent ?? '';
}

describe('repay receipt', () => {
	const partialAtClick: RepaySettlement = { owedNow: 1000n * E18, authorised: 900n * E18, closes: false };
	const closeAtClick: RepaySettlement = { owedNow: 900n * E18, authorised: 902n * E18, closes: true };

	it('does not say the position is closed when the debt it repaid against fell below the amount repaid', async () => {
		// Once the partial repay lands, the live debt (100) sits under the 900 that was authorised.
		const landed: RepaySettlement = { owedNow: 100n * E18, authorised: 900n * E18, closes: true };
		const text = await repayReceipt(partialAtClick, landed, 900n * E18);
		expect(text).toContain('Repaid 900.00 GSUSD.');
		expect(text).not.toContain('Your position is closed');
		expect(text).toContain(outcomeSentence(AFTERWARDS));
	});

	it('keeps saying the position is closed when a full close lands and the live debt reads zero', async () => {
		const landed: RepaySettlement = { owedNow: 0n, authorised: 902n * E18, closes: false };
		const text = await repayReceipt(closeAtClick, landed, 900n * E18);
		expect(text).toContain('Your position is closed.');
		expect(text).not.toContain(outcomeSentence(AFTERWARDS));
	});

	it('keeps saying the position is closed when the repay leaves the wallet short of the typed amount and the form empties', async () => {
		const text = await repayReceipt(closeAtClick, undefined, 900n * E18, EMPTIED);
		expect(text).toContain('Your position is closed.');
	});

	it('keeps the outcome sentence of a partial repay when the form empties', async () => {
		const text = await repayReceipt(partialAtClick, undefined, 900n * E18, EMPTIED);
		expect(text).toContain('Repaid 900.00 GSUSD.');
		expect(text).toContain(outcomeSentence(AFTERWARDS));
	});

	it('keeps naming the amount of a deposit when the form empties because the wallet gave it all', async () => {
		let onSuccess: (() => void) | undefined;
		const write = vi.fn((callbacks?: WriteCallbacks) => {
			onSuccess = callbacks?.onSuccess;
		});
		const deposit = (status: 'pending' | 'success', amount: string) => (
			<ReviewVaultDialog
				action="deposit"
				amount={amount}
				write={write}
				reset={() => undefined}
				confirmationStatus={status}
				isSimulationSuccess
				isSimulationError={false}
				simulationError={null}
				txHash={status === 'success' ? TX_HASH : undefined}
				collateralSymbol="PAXG"
			>
				{() => (
					<DialogTrigger asChild>
						<Button>Open</Button>
					</DialogTrigger>
				)}
			</ReviewVaultDialog>
		);
		const { rerender } = render(deposit('pending', '5'));
		fireEvent.click(screen.getByText('Open'));
		fireEvent.click(await screen.findByText('Confirm deposit'));
		act(() => onSuccess?.());
		rerender(deposit('success', ''));
		expect(document.body.textContent).toContain('Deposited 5 PAXG.');
	});
});

describe('mint review and receipt', () => {
	const FEE_ON: MintFeeSplit = { bps: 5n, fee: 5n * 10n ** 17n, received: 9995n * 10n ** 17n };

	function mintDialog(status: 'pending' | 'success', amount: string, mintFee: MintFeeSplit | undefined, write: WriteFn) {
		return (
			<ReviewVaultDialog
				action="mint"
				amount={amount}
				write={write}
				reset={() => undefined}
				confirmationStatus={status}
				outcome={AFTERWARDS}
				isSimulationSuccess
				isSimulationError={false}
				simulationError={null}
				txHash={status === 'success' ? TX_HASH : undefined}
				mintFee={mintFee}
			>
				{() => (
					<DialogTrigger asChild>
						<Button>Open</Button>
					</DialogTrigger>
				)}
			</ReviewVaultDialog>
		);
	}

	it('states what reaches the wallet and that the debt is the full amount', async () => {
		render(mintDialog('pending', '1000', FEE_ON, vi.fn()));
		fireEvent.click(screen.getByText('Open'));
		await screen.findByText('Confirm mint');
		expect(document.body.textContent).toContain(
			'You receive 999.50 GSUSD after the 0.05% mint fee of 0.50 GSUSD, which goes to the protocol. Your vault owes the full 1,000 GSUSD.'
		);
	});

	it('will not confirm a mint before the fee is known', async () => {
		const write = vi.fn();
		render(mintDialog('pending', '1000', undefined, write));
		fireEvent.click(screen.getByText('Open'));
		const button = await screen.findByRole('button', { name: 'Checking' });
		expect((button as HTMLButtonElement).disabled).toBe(true);
		fireEvent.click(button);
		expect(write).not.toHaveBeenCalled();
	});

	it('names the fee on the receipt after the form empties', async () => {
		let onSuccess: (() => void) | undefined;
		const write = vi.fn((callbacks?: WriteCallbacks) => {
			onSuccess = callbacks?.onSuccess;
		});
		const { rerender } = render(mintDialog('pending', '1000', FEE_ON, write));
		fireEvent.click(screen.getByText('Open'));
		fireEvent.click(await screen.findByText('Confirm mint'));
		act(() => onSuccess?.());
		rerender(mintDialog('success', '', undefined, write));
		expect(document.body.textContent).toContain(
			'Minted 1,000 GSUSD: 999.50 GSUSD reached your wallet and 0.50 GSUSD went to the protocol as the mint fee.'
		);
	});

	it('says nothing about a fee when none is charged', async () => {
		render(mintDialog('pending', '1000', { bps: 0n, fee: 0n, received: 1000n * 10n ** 18n }, vi.fn()));
		fireEvent.click(screen.getByText('Open'));
		await screen.findByText('Confirm mint');
		expect(document.body.textContent).not.toContain('mint fee');
	});
});
