import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { encodePacked, keccak256, type Address } from 'viem';
import { OWNERS_PER_BATCH, inBatches, indebtedVaultsFrom, judgeVault, useUndercollateralisedVaults } from './useUndercollateralisedVaults';

const E18 = 10n ** 18n;
const E8 = 10n ** 8n;
const PAXG = '0x00000000000000000000000000000000000000a1' as const;
const XAUT = '0x00000000000000000000000000000000000000a2' as const;
const ALICE = '0x0000000000000000000000000000000000000a11' as const;
const BOB = '0x0000000000000000000000000000000000000b0b' as const;

interface Call {
	functionName: string;
	args: readonly unknown[];
}

/**
 * What the chain reports: each owner's vault (its collateral, liquidation price and the
 * stored-price ratio), each collateral's liquidation ratio and live quote.
 */
const chain = vi.hoisted(() => ({
	vaults: {} as Record<string, { token: string; liquidationPrice: bigint; storedRatio: bigint }>,
	liquidationRatios: {} as Record<string, bigint | undefined>,
	quotes: {} as Record<string, bigint | 'refused'>,
	batchSizes: [] as number[],
	failAll: false,
}));

const idOf = (token: Address) => keccak256(encodePacked(['address'], [token]));

vi.mock('@goldstandard/constants', () => ({
	getGoldVaultContractConfig: () => ({ address: '0x00000000000000000000000000000000000000ff', abi: [] }),
	getGoldOracleContractConfig: () => ({ address: '0x00000000000000000000000000000000000000ee', abi: [] }),
	goldVaultAbi: [],
	goldOracleAbi: [],
}));

vi.mock('@wagmi/core', () => ({
	readContracts: async (_config: unknown, { contracts }: { contracts: Call[] }) => {
		chain.batchSizes.push(contracts.length / 4);
		return contracts.map(({ functionName, args }) => {
			if (chain.failAll) return { status: 'failure', error: new Error('HTTP request failed') };
			const vault = chain.vaults[args[0] as string];
			if (functionName === 'vaults') return { status: 'success', result: [vault.token, E18, 1000n * E18] };
			if (functionName === 'getVaultCurrentDebt') return { status: 'success', result: 1000n * E18 };
			if (functionName === 'getLiquidationPrice') return { status: 'success', result: vault.liquidationPrice };
			return { status: 'success', result: vault.storedRatio };
		});
	},
}));

vi.mock('wagmi', () => ({
	useConfig: () => ({}),
	useReadContracts: ({ contracts, query }: { contracts: Call[]; query?: { enabled?: boolean } }) => {
		if (!query?.enabled || contracts.length === 0) return { data: undefined, isLoading: false, isError: false };
		return {
			data: contracts.map(({ functionName, args }) => {
				if (functionName === 'collateralTypes') {
					const token = Object.keys(chain.liquidationRatios).find(t => idOf(t as Address) === args[0]);
					const ratio = token ? chain.liquidationRatios[token] : undefined;
					return ratio === undefined
						? { status: 'failure', error: new Error('read failed') }
						: { status: 'success', result: [token, 1_300_000n, ratio, 50_000n, 0n, 0n, true] };
				}
				const quote = chain.quotes[(args[0] as string).toLowerCase()];
				return quote === undefined || quote === 'refused'
					? { status: 'failure', error: new Error('No reliable price') }
					: { status: 'success', result: quote };
			}),
			isLoading: false,
			isError: false,
		};
	},
}));

const wrapper = ({ children }: { children: ReactNode }) => (
	<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{children}</QueryClientProvider>
);

async function eligible(owners: Address[]) {
	const { result } = renderHook(() => useUndercollateralisedVaults(11155111, owners), { wrapper });
	await waitFor(() => expect(result.current.isLoading).toBe(false));
	return result;
}

describe('batching helpers', () => {
	it('splits owners into bounded batches', () => {
		expect(inBatches([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
		expect(inBatches([], 2)).toEqual([]);
	});

	it('treats a batch whose reads all failed as an error, not as nobody to liquidate', () => {
		expect(() => indebtedVaultsFrom([ALICE], Array.from({ length: 4 }, () => ({ status: 'failure' as const })))).toThrow();
	});
});

describe('judgeVault', () => {
	const vault = {
		owner: ALICE,
		collateralToken: PAXG,
		collateralAmount: E18,
		debtAmount: 1000n * E18,
		currentDebt: 1000n * E18,
		liquidationPrice: 3_300n * E8,
		storedRatio: 1_250_000n,
	};

	it('lists a vault below its liquidation price at the live quote even when the stored view says healthy', () => {
		expect(judgeVault(vault, 1_100_000n, { price8: 3_000n * E8 })).toMatchObject({ ratio: 1_000_000n, ratioPercent: 100, priceSource: 'live' });
	});

	it('does not list a vault above its liquidation price at the live quote', () => {
		expect(judgeVault({ ...vault, storedRatio: 1_000_000n }, 1_100_000n, { price8: 3_400n * E8 })).toBeUndefined();
	});

	it('falls back to the stored ratio, marked, when the quote is refused', () => {
		expect(judgeVault({ ...vault, storedRatio: 1_050_000n }, 1_100_000n, { refused: true })).toMatchObject({ priceSource: 'stored', ratio: 1_050_000n });
	});
});

describe('useUndercollateralisedVaults', () => {
	beforeEach(() => {
		chain.vaults = {};
		chain.liquidationRatios = { [PAXG]: 1_100_000n, [XAUT]: 1_100_000n };
		chain.quotes = { [PAXG]: 3_000n * E8, [XAUT]: 3_000n * E8 };
		chain.batchSizes = [];
		chain.failAll = false;
	});

	// The stored view priced a quiet fall at the old price and listed nothing.
	it('lists a vault the live quote has made liquidatable', async () => {
		chain.vaults = { [ALICE]: { token: PAXG, liquidationPrice: 3_300n * E8, storedRatio: 1_400_000n } };
		const result = await eligible([ALICE]);
		expect(result.current.undercollateralised.map(v => v.owner)).toEqual([ALICE]);
		expect(result.current.undercollateralised[0].priceSource).toBe('live');
		expect(result.current.judgedAtStoredPrice).toBe(false);
	});

	// Governance can raise a collateral's liquidation ratio through the timelock.
	it('judges each vault against its own collateral liquidation ratio', async () => {
		chain.liquidationRatios = { [PAXG]: 1_200_000n, [XAUT]: 1_100_000n };
		// At $3,000 both stand at 115%: below PAXG's 120% and above XAUT's 110%.
		chain.vaults = {
			[ALICE]: { token: PAXG, liquidationPrice: (3_000n * E8 * 1_200_000n) / 1_150_000n, storedRatio: 1_150_000n },
			[BOB]: { token: XAUT, liquidationPrice: (3_000n * E8 * 1_100_000n) / 1_150_000n, storedRatio: 1_150_000n },
		};
		const result = await eligible([ALICE, BOB]);
		expect(result.current.undercollateralised.map(v => v.owner)).toEqual([ALICE]);
	});

	it('lists nothing for a collateral whose ratio could not be read rather than guessing one', async () => {
		chain.liquidationRatios = { [PAXG]: undefined };
		chain.vaults = { [ALICE]: { token: PAXG, liquidationPrice: 3_300n * E8, storedRatio: 1_000_000n } };
		const result = await eligible([ALICE]);
		expect(result.current.undercollateralised).toEqual([]);
	});

	it('judges at the stored ratio, and says so, when the live quote is refused', async () => {
		chain.quotes = { [PAXG]: 'refused' };
		chain.vaults = { [ALICE]: { token: PAXG, liquidationPrice: 3_300n * E8, storedRatio: 1_050_000n } };
		const result = await eligible([ALICE]);
		expect(result.current.undercollateralised.map(v => v.priceSource)).toEqual(['stored']);
		expect(result.current.judgedAtStoredPrice).toBe(true);
	});

	it('reads a large owner list in bounded batches, never one unbounded multicall', async () => {
		const owners = Array.from({ length: OWNERS_PER_BATCH * 2 + 7 }, (_, i) => `0x${(i + 1).toString(16).padStart(40, '0')}` as Address);
		chain.vaults = Object.fromEntries(owners.map(owner => [owner, { token: PAXG, liquidationPrice: 2_000n * E8, storedRatio: 1_500_000n }]));
		await eligible(owners);
		expect(chain.batchSizes).toEqual([OWNERS_PER_BATCH, OWNERS_PER_BATCH, 7]);
	});

	it('reports an error, not an empty list, when the vault reads fail', async () => {
		chain.failAll = true;
		const { result } = renderHook(() => useUndercollateralisedVaults(11155111, [ALICE]), { wrapper });
		await waitFor(() => expect(result.current.isError).toBe(true));
	});
});
