import { keepPreviousData } from '@tanstack/react-query';
import {
	CallExecutionError,
	ContractFunctionExecutionError,
	ContractFunctionRevertedError,
	HttpRequestError,
	erc20Abi,
} from 'viem';
import { retrySimulationFailure, simulateQuery } from './simulateQuery';

const call = { abi: erc20Abi, functionName: 'approve', args: [] } as const;

/** What viem's simulateContract throws for a call the contract refuses. */
const revert = () =>
	new ContractFunctionExecutionError(
		new ContractFunctionRevertedError({ abi: erc20Abi, functionName: 'approve', message: 'execution reverted' }),
		call
	);

/** What it throws when the request never reached a node that could answer it. */
const unreachable = () =>
	new ContractFunctionExecutionError(
		new CallExecutionError(new HttpRequestError({ url: 'https://rpc.example' }), {}),
		call
	);

describe('simulateQuery', () => {
	it('keeps the previous simulation while the inputs stay valid', () => {
		expect(simulateQuery(true)).toStrictEqual({ enabled: true, placeholderData: keepPreviousData, retry: retrySimulationFailure });
	});

	it('keeps nothing once the inputs are invalid, so a stale request cannot outlive its form', () => {
		expect(simulateQuery(false)).toStrictEqual({ enabled: false, placeholderData: undefined, retry: retrySimulationFailure });
	});
});

describe('retrySimulationFailure', () => {
	it('never retries a revert: the same call against the same state reverts the same way', () => {
		expect(retrySimulationFailure(0, revert())).toBe(false);
	});

	it('retries a request that did not reach the chain, as React Query does by default', () => {
		expect(retrySimulationFailure(0, unreachable())).toBe(true);
		expect(retrySimulationFailure(2, unreachable())).toBe(true);
		expect(retrySimulationFailure(3, unreachable())).toBe(false);
	});
});
