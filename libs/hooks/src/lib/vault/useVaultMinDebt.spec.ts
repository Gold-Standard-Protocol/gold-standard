import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useVaultMinDebt } from './useVaultMinDebt';

const E18 = 10n ** 18n;
/** What GOLD_VAULT_MIN_DEBT is in a build that targets mainnet. */
const MAINNET_LAUNCH_MIN_DEBT = 1_000n * E18;

const read = vi.hoisted(() => ({
	data: undefined as bigint | undefined,
	calls: [] as { functionName?: string; query?: { enabled?: boolean } }[],
}));

vi.mock('@goldstandard/constants', () => ({
	GOLD_VAULT_MIN_DEBT: 1_000n * 10n ** 18n,
	getGoldVaultContractConfig: (chainId: number | undefined) =>
		chainId === undefined
			? undefined
			: { address: '0x00000000000000000000000000000000000000ff', abi: [] },
	goldVaultAbi: [],
}));

vi.mock('wagmi', () => ({
	useReadContract: (params: { functionName?: string; query?: { enabled?: boolean } }) => {
		read.calls.push(params);
		return { data: params.query?.enabled ? read.data : undefined };
	},
}));

describe('useVaultMinDebt', () => {
	beforeEach(() => {
		read.data = undefined;
		read.calls = [];
	});

	it('returns GoldVault.minDebt as the chain reports it', () => {
		read.data = 2_500n * E18;
		const { result } = renderHook(() => useVaultMinDebt(1));
		expect(result.current).toBe(2_500n * E18);
		expect(read.calls.at(-1)?.functionName).toBe('minDebt');
	});

	// A failed read leaves data undefined as well, so the same figure covers both.
	it('assumes the target chain launch figure until the read lands', () => {
		const { result } = renderHook(() => useVaultMinDebt(1));
		expect(result.current).toBe(MAINNET_LAUNCH_MIN_DEBT);
	});

	it('assumes the launch figure, and reads nothing, without a vault on the chain', () => {
		const { result } = renderHook(() => useVaultMinDebt(undefined));
		expect(result.current).toBe(MAINNET_LAUNCH_MIN_DEBT);
		expect(read.calls.at(-1)?.query?.enabled).toBe(false);
	});
});
