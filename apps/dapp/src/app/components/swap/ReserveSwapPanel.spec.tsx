import { render, screen } from '@testing-library/react';
import { vi } from 'vitest';
import type { Token } from '@goldstandard/models';
import type { OraclePriceState, StabilityReserveState } from '@goldstandard/hooks';
import { ReserveSwapPanel } from './ReserveSwapPanel';

vi.mock('./SwapButton', () => ({ SwapButton: () => null }));

const paxg = { address: '0x45804880De22913dAFE09f4980848ECE6EcbAf78', symbol: 'PAXG', decimals: 18 } as unknown as Token;
const xaut = { address: '0x68749665FF8D2d112Fa859AA293F07A622782F38', symbol: 'XAUT', decimals: 6 } as unknown as Token;

const reserve: StabilityReserveState = {
	isDeployed: true,
	supported: true,
	paused: true,
	redeemable: undefined,
	remainingToday: undefined,
	spreadPpm: undefined,
	spreadPercent: undefined,
	coveragePpm: undefined,
	coveragePercent: undefined,
	reserveValueUsd: undefined,
	inventory: undefined,
	isLoading: false,
	isError: false,
};

const oracle: OraclePriceState = {
	isDeployed: true,
	price8: undefined,
	isLive: false,
	refusal: undefined,
	quoted: false,
	isLoading: false,
	isError: false,
};

const renderPanel = (tokens: Token[], oracleState: OraclePriceState = oracle) =>
	render(
		<ReserveSwapPanel
			chainId={1}
			typedAmount=""
			onAmountChange={vi.fn()}
			tokens={tokens}
			selectedToken={paxg}
			onSelectToken={vi.fn()}
			slippageBps={50n}
			onSlippageChange={vi.fn()}
			reserve={reserve}
			oracle={oracleState}
			preview={undefined}
		/>
	);

describe('ReserveSwapPanel paused asset', () => {
	// On a PAXG-first deployment there is no other reserve asset to suggest.
	it('does not point at another reserve asset when the reserve lists only one', () => {
		renderPanel([paxg]);
		expect(screen.getByText(/paused by the guardian/)).toBeTruthy();
		expect(screen.queryByText(/other reserve asset/)).toBeNull();
	});

	it('suggests the other reserve asset when there is one', () => {
		renderPanel([paxg, xaut]);
		expect(screen.getByText(/other reserve asset may still be available/)).toBeTruthy();
	});
});

describe('ReserveSwapPanel reserve price refusals (variant C)', () => {
	const refused = (refusal: string): OraclePriceState => ({ ...oracle, price8: 400_000_000_000n, refusal });

	it('says swaps wait for the price to return to the gold band when quoteReservePrice is off band', () => {
		renderPanel([paxg], refused('Off gold band'));
		expect(screen.getByText(/paused while its market price sits outside the band around the gold price/)).toBeTruthy();
	});

	it('says swaps wait for both feeds when the oracle has no reliable price', () => {
		renderPanel([paxg], refused('No reliable price'));
		expect(screen.getByText(/until both of its price feeds answer again/)).toBeTruthy();
	});
});
