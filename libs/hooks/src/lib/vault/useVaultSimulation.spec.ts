import { simulateVault, type SimulationInput } from './useVaultSimulation';

const GSUSD = 10n ** 18n;
const PAXG = 10n ** 18n;
const XAUT = 10n ** 6n;

const base = (overrides: Partial<SimulationInput>): SimulationInput => ({
	action: 'deposit',
	amount: '1',
	currentCollateralAmount: 0n,
	currentDebt: 0n,
	collateralPrice: 4000,
	collateralDecimals: 18,
	minRatio: 130,
	liquidationRatio: 110,
	...overrides,
});

describe('simulateVault', () => {
	it('deposits one XAUT in its own 6-decimal units and values it at the full price', () => {
		const result = simulateVault(
			base({ action: 'deposit', amount: '1', collateralDecimals: 6, currentDebt: 1000n * GSUSD })
		);
		expect(result?.newCollateralAmount).toBe(1n * XAUT);
		// $4,000 of gold against 1,000 GSUSD of debt.
		expect(result?.newRatioPercent).toBeCloseTo(400, 6);
		// Liquidated when 1 XAUT is worth 110% of 1,000 GSUSD.
		expect(result?.newLiquidationPrice).toBeCloseTo(1100, 6);
	});

	it('previews the same USD position identically for XAUT and PAXG', () => {
		const xaut = simulateVault(
			base({ action: 'mint', amount: '2000', collateralDecimals: 6, currentCollateralAmount: 1n * XAUT })
		);
		const paxg = simulateVault(
			base({ action: 'mint', amount: '2000', collateralDecimals: 18, currentCollateralAmount: 1n * PAXG })
		);
		expect(xaut?.newRatioPercent).toBeCloseTo(paxg?.newRatioPercent ?? NaN, 6);
		expect(xaut?.newLiquidationPrice).toBeCloseTo(paxg?.newLiquidationPrice ?? NaN, 6);
		expect(xaut?.newRatioPercent).toBeCloseTo(200, 6);
	});

	it('rejects a withdrawal larger than the collateral held', () => {
		const result = simulateVault(
			base({ action: 'withdraw', amount: '2', collateralDecimals: 6, currentCollateralAmount: 1n * XAUT })
		);
		expect(result?.isValid).toBe(false);
		expect(result?.errorMessage).toBe('Insufficient collateral');
	});

	it('withdraws in native units and flags a ratio that would fall below the minimum', () => {
		const result = simulateVault(
			base({
				action: 'withdraw',
				amount: '0.5',
				collateralDecimals: 6,
				currentCollateralAmount: 1n * XAUT,
				currentDebt: 2000n * GSUSD,
			})
		);
		expect(result?.newCollateralAmount).toBe(500_000n);
		// $2,000 of gold left against 2,000 GSUSD: 100%, below the 130% floor.
		expect(result?.newRatioPercent).toBeCloseTo(100, 6);
		expect(result?.isValid).toBe(false);
		expect(result?.errorMessage).toBe('Ratio would drop below 130%');
	});

	it('clamps an overshooting repayment to zero debt and treats it as valid', () => {
		const result = simulateVault(
			base({ action: 'repay', amount: '5000', currentCollateralAmount: 1n * PAXG, currentDebt: 1000n * GSUSD })
		);
		expect(result?.newDebt).toBe(0n);
		expect(result?.isValid).toBe(true);
		expect(result?.newRatioPercent).toBe(Infinity);
		expect(result?.newLiquidationPrice).toBe(0);
	});

	it('flags a first mint below the 100 GSUSD minimum debt, as the contract rejects it', () => {
		const result = simulateVault(
			base({ action: 'mint', amount: '50', currentCollateralAmount: 1n * PAXG, principalDebt: 0n })
		);
		expect(result?.isValid).toBe(false);
		expect(result?.errorMessage).toBe('A vault must owe at least 100 GSUSD');
		// Reaching the floor is fine.
		const atFloor = simulateVault(
			base({ action: 'mint', amount: '100', currentCollateralAmount: 1n * PAXG, principalDebt: 0n })
		);
		expect(atFloor?.isValid).toBe(true);
	});

	it('flags a partial repayment that would leave principal under the minimum', () => {
		// Principal 150, fee-inclusive 151.5; repaying 60 leaves 91.5 owed and 90.6 of principal.
		const result = simulateVault(
			base({
				action: 'repay',
				amount: '60',
				currentCollateralAmount: 1n * PAXG,
				currentDebt: 151_500_000_000_000_000_000n,
				principalDebt: 150n * GSUSD,
			})
		);
		expect(result?.isValid).toBe(false);
		expect(result?.errorMessage).toBe('Repay in full or leave at least 100 GSUSD owing');
		// Full repayment is always allowed.
		const full = simulateVault(
			base({
				action: 'repay',
				amount: '200',
				currentCollateralAmount: 1n * PAXG,
				currentDebt: 151_500_000_000_000_000_000n,
				principalDebt: 150n * GSUSD,
			})
		);
		expect(full?.isValid).toBe(true);
	});

	// GoldVault checks the minimum ratio on mint and withdraw only. Calling a deposit or a
	// repayment invalid for it told the holder of an unhealthy vault that the two actions
	// which repair it would fail.
	describe('a vault below the minimum ratio', () => {
		// 1 PAXG at $4,000 against 3,400 GSUSD: 117.6%.
		const unhealthy = (overrides: Partial<SimulationInput>) =>
			base({ currentCollateralAmount: 1n * PAXG, currentDebt: 3400n * GSUSD, principalDebt: 3400n * GSUSD, ...overrides });
		const note = 'Still below the 130% minimum. Minting and withdrawing stay locked.';

		it('accepts a deposit that improves the ratio without reaching the minimum', () => {
			const result = simulateVault(unhealthy({ action: 'deposit', amount: '0.05' }));
			expect(result?.newRatioPercent).toBeCloseTo(123.53, 2);
			expect(result?.isValid).toBe(true);
			expect(result?.errorMessage).toBeUndefined();
			expect(result?.note).toBe(note);
		});

		it('accepts a repayment that improves the ratio without reaching the minimum', () => {
			const result = simulateVault(unhealthy({ action: 'repay', amount: '200' }));
			expect(result?.newRatioPercent).toBeCloseTo(125, 6);
			expect(result?.isValid).toBe(true);
			expect(result?.errorMessage).toBeUndefined();
			expect(result?.note).toBe(note);
		});

		it('says nothing more once the deposit or the repayment reaches the minimum', () => {
			expect(simulateVault(unhealthy({ action: 'deposit', amount: '0.2' }))?.note).toBeUndefined();
			expect(simulateVault(unhealthy({ action: 'repay', amount: '400' }))?.note).toBeUndefined();
		});

		it('still refuses a mint or a withdrawal, which the contract does check', () => {
			for (const action of ['mint', 'withdraw'] as const) {
				const result = simulateVault(unhealthy({ action, amount: '0.01' }));
				expect(result?.isValid).toBe(false);
				expect(result?.errorMessage).toBe('Ratio would drop below 130%');
				expect(result?.note).toBeUndefined();
			}
		});

		it('still refuses a repayment that would leave principal under the minimum debt', () => {
			const result = simulateVault(unhealthy({ action: 'repay', amount: '3350' }));
			expect(result?.isValid).toBe(false);
			expect(result?.errorMessage).toBe('Repay in full or leave at least 100 GSUSD owing');
			expect(result?.note).toBeUndefined();
		});
	});

	it('returns nothing rather than throwing on text that is not a number', () => {
		expect(simulateVault(base({ amount: 'abc' }))).toBeUndefined();
		expect(simulateVault(base({ amount: '' }))).toBeUndefined();
		expect(simulateVault(base({ amount: '0' }))).toBeUndefined();
	});
});
