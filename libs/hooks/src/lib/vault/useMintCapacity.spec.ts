import { renderHook } from '@testing-library/react';
import { computeMintCapacity, MAX_RATIO_RESERVE_PER_100K, useMintCapacity, type MintCapacityInputs } from './useMintCapacity';

interface ReadParams {
	contracts: readonly { functionName: string; args?: readonly unknown[] }[];
	query?: { enabled?: boolean };
}

const chain = vi.hoisted(() => ({
	blockNumber: undefined as bigint | undefined,
	calls: [] as ReadParams[],
	results: {} as Record<string, unknown>,
}));

vi.mock('wagmi', () => ({
	useBlockNumber: () => ({ data: chain.blockNumber }),
	useReadContracts: (params: ReadParams) => {
		chain.calls.push(params);
		return {
			data: params.query?.enabled
				? params.contracts.map((c) => ({ status: 'success', result: chain.results[c.functionName] }))
				: undefined,
			isLoading: false,
		};
	},
}));

vi.mock('@goldstandard/constants', async (importOriginal) => ({
	...(await importOriginal<typeof import('@goldstandard/constants')>()),
	getGoldVaultContractConfig: () => ({ address: '0x00000000000000000000000000000000000000ff', abi: [] }),
}));

const GSUSD = 10n ** 18n;
const PRICE_4000 = 4000n * 10n ** 8n;

const base = (overrides: Partial<MintCapacityInputs>): MintCapacityInputs => ({
	collateralAmount: 10n ** 18n,
	collateralDecimals: 18,
	collateralPrice: PRICE_4000,
	currentDebt: 0n,
	principalDebt: 0n,
	minRatio: 1_300_000n,
	debtCeiling: 250_000n * GSUSD,
	totalDebt: 0n,
	perBlockCap: undefined,
	mintedThisBlock: 0n,
	...overrides,
});

describe('computeMintCapacity', () => {
	it('treats an unlimited ceiling and a disarmed per-block cap as no limit at all', () => {
		// The open launch profile: ceiling at the maximum uint256, per-block cap off.
		const unlimited = (1n << 256n) - 1n;
		const result = computeMintCapacity(
			base({ collateralAmount: 1000n * 10n ** 18n, debtCeiling: unlimited, totalDebt: 123_456n * GSUSD, perBlockCap: 0n })
		);
		// 1,000 PAXG at $4,000 supports 3,076,923.07 GSUSD at 130%; only the ratio binds.
		expect(result.available).toBe((4_000_000n * GSUSD * 1_000_000n) / 1_300_000n);
		expect(result.limitedBy).toBe('ratio');
	});

	it('values one XAUT (6 decimals) exactly like one PAXG (18 decimals)', () => {
		const xaut = computeMintCapacity(base({ collateralAmount: 10n ** 6n, collateralDecimals: 6 }));
		const paxg = computeMintCapacity(base({ collateralAmount: 10n ** 18n, collateralDecimals: 18 }));
		expect(xaut.available).toBe(paxg.available);
		// $4,000 of gold at 130% supports 3,076.92 GSUSD.
		expect(xaut.available).toBe((4000n * GSUSD * 1_000_000n) / 1_300_000n);
		expect(xaut.limitedBy).toBe('ratio');
	});

	it('quotes nothing when the ratio headroom is below the 100 GSUSD minimum debt', () => {
		// 0.03 XAUT at $4,000 supports 92.3 GSUSD at 130%; the contract rejects any first
		// mint under 100, so offering 92 as Max would have reverted "Below minimum debt".
		const result = computeMintCapacity(base({ collateralAmount: 30_000n, collateralDecimals: 6 }));
		expect(result.available).toBe(0n);
		expect(result.limitedBy).toBe('minimum debt');
	});

	it('applies the minimum to principal plus amount, not to the amount alone', () => {
		// 150 GSUSD of headroom with 100 already owed: every top-up is allowed.
		const withDebt = computeMintCapacity(
			base({ collateralAmount: 81_250n, collateralDecimals: 6, currentDebt: 100n * GSUSD, principalDebt: 100n * GSUSD })
		);
		expect(withDebt.available).toBe(150n * GSUSD);
		expect(withDebt.limitedBy).toBe('ratio');
		// Dust principal of 40 needs at least 60 more; 50 of headroom is not enough.
		const dust = computeMintCapacity(
			base({ collateralAmount: 29_250n, collateralDecimals: 6, currentDebt: 40n * GSUSD, principalDebt: 40n * GSUSD })
		);
		expect(dust.available).toBe(0n);
		expect(dust.limitedBy).toBe('minimum debt');
	});

	it('subtracts the debt already owed from the ratio headroom', () => {
		const result = computeMintCapacity(base({ currentDebt: 3000n * GSUSD, principalDebt: 3000n * GSUSD }));
		expect(result.available).toBe((4000n * GSUSD * 1_000_000n) / 1_300_000n - 3000n * GSUSD);
	});

	it('reports zero, not a negative figure, when the vault is already past the ratio', () => {
		const result = computeMintCapacity(base({ currentDebt: 3500n * GSUSD, principalDebt: 3500n * GSUSD }));
		expect(result.available).toBe(0n);
		expect(result.limitedBy).toBe('ratio');
	});

	it('is bound by the debt ceiling when less remains under it', () => {
		const result = computeMintCapacity(base({ debtCeiling: 1000n * GSUSD, totalDebt: 900n * GSUSD }));
		expect(result.available).toBe(100n * GSUSD);
		expect(result.limitedBy).toBe('debt ceiling');
	});

	it('is bound by the per-block cap when it is armed and nearly spent', () => {
		// A vault already above the 100 GSUSD floor, so only the cap binds.
		const result = computeMintCapacity(
			base({
				currentDebt: 100n * GSUSD,
				principalDebt: 100n * GSUSD,
				perBlockCap: 500n * GSUSD,
				mintedThisBlock: 450n * GSUSD,
			})
		);
		expect(result.available).toBe(50n * GSUSD);
		expect(result.limitedBy).toBe('per-block cap');
	});

	it('treats a zero per-block cap as disarmed rather than as nothing mintable', () => {
		const result = computeMintCapacity(base({ perBlockCap: 0n, mintedThisBlock: 0n }));
		expect(result.limitedBy).toBe('ratio');
		expect(result.available).toBeGreaterThan(0n);
	});

	describe('the Max reserve', () => {
		it('leaves a share of the ratio limit unused so fees and price moves cannot push Max under water', () => {
			// 1 PAXG at $4,000 supports 3,076.92 GSUSD at 130%; Max keeps 0.25% of that back.
			const exact = (4000n * GSUSD * 1_000_000n) / 1_300_000n;
			const result = computeMintCapacity(base({}));
			expect(result.available).toBe(exact);
			expect(result.recommended).toBe(exact - (exact * MAX_RATIO_RESERVE_PER_100K) / 100_000n);
			expect(result.recommended).toBeLessThan(result.available as bigint);
		});

		it('scales the reserve with the whole debt the vault can carry, not only the new headroom', () => {
			// Fees accrue on the existing debt too: 3,000 already owed still reserves 0.25% of 3,076.92.
			const result = computeMintCapacity(base({ currentDebt: 3000n * GSUSD, principalDebt: 3000n * GSUSD }));
			const maxDebt = (4000n * GSUSD * 1_000_000n) / 1_300_000n;
			expect(result.available).toBe(maxDebt - 3000n * GSUSD);
			expect(result.recommended).toBe(maxDebt - 3000n * GSUSD - (maxDebt * MAX_RATIO_RESERVE_PER_100K) / 100_000n);
		});

		it('holds nothing back when a limit other than the ratio binds', () => {
			const ceiling = computeMintCapacity(base({ debtCeiling: 1000n * GSUSD, totalDebt: 900n * GSUSD }));
			expect(ceiling.recommended).toBe(100n * GSUSD);
			const perBlock = computeMintCapacity(base({ perBlockCap: 500n * GSUSD, mintedThisBlock: 100n * GSUSD }));
			expect(perBlock.recommended).toBe(400n * GSUSD);
		});

		it('keeps the reserve when a ceiling sits just under the ratio limit', () => {
			// Ceiling headroom 3,076.00 against a ratio limit of 3,076.92: the ceiling binds, but the
			// ratio limit is close enough that fees could still pull a full-headroom mint under water.
			const exact = (4000n * GSUSD * 1_000_000n) / 1_300_000n;
			const reserve = (exact * MAX_RATIO_RESERVE_PER_100K) / 100_000n;
			const result = computeMintCapacity(base({ debtCeiling: 3076n * GSUSD, totalDebt: 0n }));
			expect(result.limitedBy).toBe('debt ceiling');
			expect(result.available).toBe(3076n * GSUSD);
			expect(result.recommended).toBe(exact - reserve);
		});

		it('offers nothing when the reserve leaves less than the minimum debt in whole dollars', () => {
			// Headroom of 100.10 passes the 100 floor on its own; less 0.25% of the ratio limit it is
			// under it, and Max offers whole dollars, so the honest Max is zero.
			const maxDebt = (4000n * GSUSD * 1_000_000n) / 1_300_000n;
			const debt = maxDebt - 100_100_000_000_000_000_000n;
			const result = computeMintCapacity(base({ currentDebt: debt, principalDebt: 0n, minDebt: 100n * GSUSD }));
			expect(result.available).toBe(100_100_000_000_000_000_000n);
			expect(result.recommended).toBe(0n);
			expect(result.limitedBy).toBe('minimum debt');
		});

		it('never returns a negative reserve or a recommended figure above the exact limit', () => {
			const pastRatio = computeMintCapacity(base({ currentDebt: 3500n * GSUSD, principalDebt: 3500n * GSUSD }));
			expect(pastRatio.available).toBe(0n);
			expect(pastRatio.recommended).toBe(0n);
		});
	});
});

describe('useMintCapacity', () => {
	const TOKEN = '0x00000000000000000000000000000000000000a1' as const;
	const render = () =>
		renderHook(() => useMintCapacity(11155111, TOKEN, 10n ** 18n, 0n, PRICE_4000, 18, 0n));
	const keyOf = (params: ReadParams | undefined) =>
		JSON.stringify(params?.contracts, (_key, value) => (typeof value === 'bigint' ? value.toString() : value));

	beforeEach(() => {
		chain.calls = [];
		chain.blockNumber = undefined;
		chain.results = {
			collateralTypes: [TOKEN, 1_300_000n, 1_100_000n, 50_000n, 250_000n * GSUSD, 0n, true],
			perBlockMintCap: 0n,
			minDebt: 1_000n * GSUSD,
		};
	});

	// A sealed block's counter says nothing about the block a mint lands in, and keying the
	// read on the watched block blanked Max for a round trip on every new block.
	it('reads the same contracts whatever the latest block is, so the figure survives a new block', () => {
		chain.blockNumber = 100n;
		const view = render();
		const first = keyOf(chain.calls.at(-1));
		chain.blockNumber = 101n;
		view.rerender();
		expect(keyOf(chain.calls.at(-1))).toBe(first);
		expect(chain.calls.at(-1)?.contracts.some((c) => c.functionName === 'blockMinted')).toBe(false);
	});

	it('quotes capacity without waiting for a block number', () => {
		const { result } = render();
		expect(chain.calls.at(-1)?.query?.enabled).toBe(true);
		// 1 PAXG at $4,000 and 130%: 3,076.92 GSUSD, only the ratio binds.
		expect(result.current.available).toBe((4_000n * GSUSD * 1_000_000n) / 1_300_000n);
		expect(result.current.limitedBy).toBe('ratio');
	});

	// The next block's counter starts at zero, so an armed cap is the whole headroom there.
	it('offers the whole per-block cap when the breaker is armed', () => {
		chain.results = { ...chain.results, perBlockMintCap: 2_000n * GSUSD };
		const { result } = render();
		expect(result.current.available).toBe(2_000n * GSUSD);
		expect(result.current.limitedBy).toBe('per-block cap');
	});
});
