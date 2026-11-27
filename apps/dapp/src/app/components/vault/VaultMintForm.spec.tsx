import { fireEvent, render } from '@testing-library/react';
import { vi } from 'vitest';
import { VaultMintForm } from './VaultMintForm';

const { setTypedAmount, ctx } = vi.hoisted(() => ({
	setTypedAmount: vi.fn(),
	ctx: { typedAmount: '' },
}));

// The amount hook reads the chain id from wagmi; there is no provider in these renders.
vi.mock('wagmi', () => ({ useChainId: () => 11155111 }));

vi.mock('@goldstandard/hooks', () => ({
	useVaultMinDebt: () => 100n * 10n ** 18n,
	// The launch value: 5 bps taken from what a mint delivers.
	useOriginationFee: () => ({ bps: 5n, exempt: false }),
	useGsusdToken: () => undefined,
	useAllGoldTokens: () => ({ data: undefined }),
	useTokenBalance: () => ({ data: undefined }),
	useVaultContext: () => ({
		state: { activeTab: 'mint', typedAmount: ctx.typedAmount, selectedToken: undefined },
		position: { position: { collateralAmount: 1n, debtAmount: 0n } },
		// `fees` and `chainId` are always supplied by the real provider; the mock omitted
		// them and only got away with it while every read sat behind a falsy guard.
		fees: { currentDebt: 0n, currentDebtFormatted: '0' },
		chainId: 11155111,
		goldPrice: 2000,
		// Resolved from the position's token address by the real provider.
		collateralDecimals: 18,
		collateralSymbol: 'PAXG',
		depositDecimals: 18,
	}),
	useVaultStateActions: () => ({ setTypedAmount }),
	useVaultSimulation: () => undefined,
	// Risk parameters now come from the chain rather than being hardcoded, so the
	// form reads them through this hook. 130/110 mirrors the deployed defaults.
	useCollateralParams: () => ({
		minRatioPercent: 130,
		liquidationRatioPercent: 110,
		liquidationPenaltyPercent: 5,
		debtCeiling: undefined,
		totalDebt: undefined,
		active: true,
		isLoading: false,
	}),
	// The mint ceiling is read from the ORACLE price, not the market price feed, because
	// that is what the vault enforces against. Undefined capacity keeps this suite
	// focused on input behaviour rather than on the Max button.
	useOraclePrice: () => ({
		isDeployed: true,
		price8: undefined,
		isLive: true,
		isLoading: false,
		isError: false,
	}),
	useMintCapacity: () => ({
		available: undefined,
		recommended: undefined,
		limitedBy: undefined,
		isLoading: false,
	}),
}));

describe('VaultMintForm', () => {
	beforeEach(() => {
		setTypedAmount.mockClear();
		ctx.typedAmount = '';
	});

	it('refuses a fractional amount at the keystroke instead of flooring it', () => {
		const { getByLabelText } = render(<VaultMintForm />);
		fireEvent.change(getByLabelText('Mint GSUSD'), { target: { value: '12.75' } });
		expect(setTypedAmount).not.toHaveBeenCalled();
	});

	it('keeps whole dollars', () => {
		const { getByLabelText } = render(<VaultMintForm />);
		fireEvent.change(getByLabelText('Mint GSUSD'), { target: { value: '1000' } });
		expect(setTypedAmount).toHaveBeenCalledWith('1000');
	});

	it('keeps text that is not a number and says why it cannot be minted', () => {
		const { getByLabelText } = render(<VaultMintForm />);
		fireEvent.change(getByLabelText('Mint GSUSD'), { target: { value: '1e3' } });
		expect(setTypedAmount).toHaveBeenCalledWith('1e3');
		ctx.typedAmount = '1e3';
		const { getByText } = render(<VaultMintForm />);
		expect(getByText('Only digits and one decimal point')).toBeTruthy();
	});

	it('says what a mint delivers once the origination fee is taken', () => {
		ctx.typedAmount = '10000';
		const { container } = render(<VaultMintForm />);
		expect(container.textContent).toContain('You receive 9,995.00 GSUSD after the 0.05% mint fee. Your vault owes the full amount.');
	});
});
