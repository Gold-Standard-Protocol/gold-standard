import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { decodeFunctionData, getAddress, type Hex } from 'viem';
import { uniswapSwapRouter02Abi } from '@goldstandard/constants';
import { useDexSwap } from './useDexSwap';
import {
	SAFE_SWAP_DEADLINE_SECONDS,
	SWAP_DEADLINE_SECONDS,
	isContractAccountCode,
	swapDeadline,
} from './swapDeadline';

const E18 = 10n ** 18n;
const GSUSD = '0x00000000000000000000000000000000000000a1' as const;
const PAXG = '0x00000000000000000000000000000000000000b2' as const;
const ROUTER = '0x00000000000000000000000000000000000000ff' as const;
const ACCOUNT = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as const;
// 2026-11-04 12:00:30 UTC: thirty seconds into a minute.
const NOW_MS = 1_793_793_630_000;
const STEP_START = 1_793_793_600;

type Simulated = { functionName?: string; args?: readonly [bigint, readonly Hex[]]; address?: string };

const wagmi = vi.hoisted(() => ({
	simulated: [] as unknown[],
	simulate: { data: undefined as { request: unknown } | undefined, isPlaceholderData: false, isSuccess: false, isError: false, error: null },
	connector: { type: 'injected' } as { type: string } | undefined,
	code: undefined as string | undefined,
	writeContract: vi.fn(),
}));

vi.mock('wagmi', () => ({
	useSimulateContract: (params: unknown) => {
		wagmi.simulated.push(params);
		return wagmi.simulate;
	},
	useBytecode: () => ({ data: wagmi.code }),
	useAccount: () => ({ address: ACCOUNT, connector: wagmi.connector }),
}));

vi.mock('../tx/useTxWrite', () => ({
	useTxWrite: () => ({
		writeContract: wagmi.writeContract,
		reset: vi.fn(),
		txHash: undefined,
		receipt: undefined,
		confirmationStatus: 'idle',
		isWritePending: false,
		writeError: null,
	}),
}));

vi.mock('@goldstandard/constants', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@goldstandard/constants')>();
	return {
		...actual,
		getDexConfig: () => ({ router: { address: ROUTER, abi: actual.uniswapSwapRouter02Abi }, poolFee: 3000 }),
	};
});

const lastSimulation = () => wagmi.simulated[wagmi.simulated.length - 1] as Simulated;

function decodeSwap(call: Hex) {
	const decoded = decodeFunctionData({ abi: uniswapSwapRouter02Abi, data: call });
	expect(decoded.functionName).toBe('exactInputSingle');
	return (decoded.args as readonly [Record<string, unknown>])[0];
}

describe('swapDeadline', () => {
	it('counts the window from the start of the current minute', () => {
		expect(swapDeadline(STEP_START + 30, SWAP_DEADLINE_SECONDS)).toBe(BigInt(STEP_START + 20 * 60));
		expect(swapDeadline(STEP_START + 59, SWAP_DEADLINE_SECONDS)).toBe(BigInt(STEP_START + 20 * 60));
		expect(swapDeadline(STEP_START + 60, SWAP_DEADLINE_SECONDS)).toBe(BigInt(STEP_START + 60 + 20 * 60));
	});

	it('gives a Safe a day', () => {
		expect(swapDeadline(STEP_START, SAFE_SWAP_DEADLINE_SECONDS)).toBe(BigInt(STEP_START + 86_400));
	});
});

describe('isContractAccountCode', () => {
	it('treats deployed bytecode as a contract account and an EIP-7702 delegation as a key', () => {
		expect(isContractAccountCode('0x608060405234801561001057600080fd')).toBe(true);
		expect(isContractAccountCode('0xef0100aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).toBe(false);
		expect(isContractAccountCode('0x')).toBe(false);
		expect(isContractAccountCode(undefined)).toBe(false);
	});
});

describe('useDexSwap: the market swap carries a deadline', () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(NOW_MS);
		wagmi.simulated = [];
		wagmi.simulate = { data: undefined, isPlaceholderData: false, isSuccess: false, isError: false, error: null };
		wagmi.connector = { type: 'injected' };
		wagmi.code = undefined;
		wagmi.writeContract.mockClear();
	});
	afterEach(() => vi.useRealTimers());

	it('simulates multicall(deadline, [exactInputSingle]) twenty minutes out', () => {
		renderHook(() => useDexSwap(11155111, GSUSD, PAXG, 10n * E18, 2n * 10n ** 15n));
		const simulation = lastSimulation();
		expect(simulation.functionName).toBe('multicall');
		expect(simulation.address).toBe(ROUTER);
		const [deadline, calls] = simulation.args ?? [];
		expect(deadline).toBe(BigInt(STEP_START + SWAP_DEADLINE_SECONDS));
		expect(calls).toHaveLength(1);
		expect(decodeSwap((calls as readonly Hex[])[0])).toEqual({
			tokenIn: getAddress(GSUSD),
			tokenOut: getAddress(PAXG),
			fee: 3000,
			recipient: getAddress(ACCOUNT),
			amountIn: 10n * E18,
			amountOutMinimum: 2n * 10n ** 15n,
			sqrtPriceLimitX96: 0n,
		});
	});

	it('gives a Safe inside Safe{Wallet} 24 hours', () => {
		wagmi.connector = { type: 'safe' };
		renderHook(() => useDexSwap(11155111, GSUSD, PAXG, 10n * E18, 1n));
		expect(lastSimulation().args?.[0]).toBe(BigInt(STEP_START + SAFE_SWAP_DEADLINE_SECONDS));
	});

	it('gives a contract account reached through WalletConnect 24 hours', () => {
		wagmi.connector = { type: 'walletConnect' };
		wagmi.code = '0x608060405234801561001057600080fd';
		renderHook(() => useDexSwap(11155111, GSUSD, PAXG, 10n * E18, 1n));
		expect(lastSimulation().args?.[0]).toBe(BigInt(STEP_START + SAFE_SWAP_DEADLINE_SECONDS));
	});

	it('signs exactly the simulated multicall and refuses one with another deadline', () => {
		const { result, rerender } = renderHook(() => useDexSwap(11155111, GSUSD, PAXG, 10n * E18, 1n));
		const args = lastSimulation().args;
		wagmi.simulate = { data: { request: { args } }, isPlaceholderData: false, isSuccess: true, isError: false, error: null };
		rerender();
		expect(result.current.write).toBeDefined();
		result.current.write?.({});
		expect(wagmi.writeContract).toHaveBeenCalledWith({ args }, {});

		const stale = [BigInt(STEP_START - 60 + SWAP_DEADLINE_SECONDS), args?.[1]];
		wagmi.simulate = { data: { request: { args: stale } }, isPlaceholderData: false, isSuccess: true, isError: false, error: null };
		rerender();
		expect(result.current.write).toBeUndefined();
	});

	it('simulates nothing without an amount', () => {
		renderHook(() => useDexSwap(11155111, GSUSD, PAXG, undefined, 1n));
		expect(lastSimulation().args).toBeUndefined();
	});
});
