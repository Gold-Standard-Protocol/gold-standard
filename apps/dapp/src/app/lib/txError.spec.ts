import { describe, expect, it } from 'vitest';
import {
	BaseError,
	ContractFunctionExecutionError,
	ContractFunctionRevertedError,
	ContractFunctionZeroDataError,
	encodeErrorResult,
	type Abi,
} from 'viem';
import { goldVaultAbi, stabilityPoolAbi } from '@goldstandard/constants';
import { describeTxError } from './txError';

/** A decoded OpenZeppelin Pausable error, built the way viem builds it from a simulation. */
function pauseRevert(
	abi: Abi,
	functionName: string,
	errorName: 'EnforcedPause' | 'ExpectedPause'
): ContractFunctionExecutionError {
	const data = encodeErrorResult({ abi, errorName });
	const revert = new ContractFunctionRevertedError({ abi, functionName, data });
	return new ContractFunctionExecutionError(revert, {
		abi,
		functionName,
		args: [1n],
		contractAddress: '0x0000000000000000000000000000000000000001',
	});
}

/** A viem error whose custom error the ABI could not decode: only a selector survives. */
function undecodableRevert(selector: string): BaseError {
	const revert = new ContractFunctionRevertedError({
		abi: [],
		functionName: 'deposit',
		data: selector as `0x${string}`,
	});
	const err = new BaseError(
		`The contract function "deposit" reverted with the following signature: ${selector}`,
		{ cause: revert }
	);
	return err;
}

/** A plain string revert, which the vault uses for its own require() reasons. */
function reasonRevert(reason: string): BaseError {
	const revert = new ContractFunctionRevertedError({
		abi: [],
		functionName: 'mint',
		message: reason,
	});
	// viem exposes the parsed reason on the error itself.
	(revert as unknown as { reason: string }).reason = reason;
	return new BaseError('reverted', { cause: revert });
}

describe('describeTxError', () => {
	// The last resort used to name neither the cause nor the next step.
	it('tells the user what to check when nothing better is known', () => {
		const message = describeTxError({ unexpected: true });
		expect(message).toMatch(/wallet could not prepare this transaction/);
		expect(message).toMatch(/unlocked and on the right network/);
	});

	it('returns undefined when there is no error', () => {
		expect(describeTxError(undefined)).toBeUndefined();
		expect(describeTxError(null)).toBeUndefined();
	});

	// The exact failure seen in testing: a bare selector shown to the user.
	it('never leaks a raw selector for an undecodable ERC20 allowance error', () => {
		const message = describeTxError(undecodableRevert('0xfb8f41b2'));
		expect(message).toBeDefined();
		expect(message).not.toContain('0xfb8f41b2');
		expect(message).toMatch(/approve/i);
	});

	// With no context we must NOT guess: claiming a stability-fee shortfall on what
	// might be a deposit is worse than saying nothing specific.
	it('explains an undecodable ERC20 balance error without inventing a cause', () => {
		const message = describeTxError(undecodableRevert('0xe450d38c'));
		expect(message).not.toContain('0xe450d38c');
		expect(message).toMatch(/do not hold enough/i);
		expect(message).not.toMatch(/stability fee/i);
	});

	it('translates the per-block mint cap into advice, not a bare reason string', () => {
		const message = describeTxError(reasonRevert('Per-block mint cap reached'));
		expect(message).toMatch(/smaller amount/i);
	});

	// Mainnet launches with no debt ceiling, so the revert means governance has since set
	// one; the copy must not describe the retired $5M backstop.
	it('explains a reached debt ceiling as one governance set, not as a fixed backstop', () => {
		const message = describeTxError(reasonRevert('Debt ceiling reached'));
		expect(message).toMatch(/governance/i);
		expect(message).toMatch(/repaid/i);
		expect(message).not.toMatch(/backstop/i);
	});

	it('passes through an unmapped reason string rather than swallowing it', () => {
		expect(describeTxError(reasonRevert('Some new guard'))).toBe('Some new guard');
	});

	// A deposit shortfall is gold, not GSUSD. The old copy explained stability fees on
	// a deposit, which is advice for a completely different problem.
	it('names the right token on a deposit rather than talking about GSUSD', () => {
		const message = describeTxError(undecodableRevert('0xe450d38c'), {
			action: 'deposit',
			tokenSymbol: 'PAXG',
		});
		expect(message).toContain('PAXG');
		expect(message).not.toMatch(/GSUSD/);
		expect(message).not.toMatch(/stability fee/i);
	});

	it('keeps the stability-fee explanation where it belongs, on a repayment', () => {
		const message = describeTxError(undecodableRevert('0xe450d38c'), {
			action: 'repay',
			tokenSymbol: 'GSUSD',
		});
		expect(message).toMatch(/stability fee/i);
	});

	// "deposit more gold first" is nonsense when the user is withdrawing gold.
	it('gives withdrawal advice on a withdrawal, not minting advice', () => {
		const message = describeTxError(reasonRevert('Below min collateralisation ratio'), {
			action: 'withdraw',
		});
		expect(message).toMatch(/withdraw less/i);
		expect(message).not.toMatch(/deposit more gold/i);
	});

	it('still gives minting advice when the user is minting', () => {
		const message = describeTxError(reasonRevert('Below min collateralisation ratio'), {
			action: 'mint',
		});
		expect(message).toMatch(/mint less/i);
	});

	// A ternary defaulting to mint advice would hand it to every unlisted action.
	it('offers no direction rather than the wrong one when the action is unknown', () => {
		const message = describeTxError(reasonRevert('Below min collateralisation ratio'));
		expect(message).toMatch(/minimum collateral ratio/i);
		expect(message).not.toMatch(/mint less/i);
		expect(message).not.toMatch(/withdraw less/i);
	});

	it('explains a reserve-side limit as a reserve limit, never as a vault problem', () => {
		const insufficient = describeTxError(reasonRevert('Reserve insufficient'), { action: 'swap' });
		expect(insufficient).toMatch(/reserve does not hold enough/i);
		expect(insufficient).not.toMatch(/vault/i);
		const slippage = describeTxError(reasonRevert('Slippage'), { action: 'swap' });
		expect(slippage).toMatch(/price tolerance/i);
	});

	it('names the token in an allowance error', () => {
		const message = describeTxError(undecodableRevert('0xfb8f41b2'), {
			action: 'deposit',
			tokenSymbol: 'XAUT',
		});
		expect(message).toContain('XAUT');
	});

	it('does not alarm the user when they simply rejected the transaction', () => {
		const err = new BaseError('User rejected the request.');
		expect(describeTxError(err)).toMatch(/rejected/i);
	});

	// The market leg. Uniswap's router reverts with three-letter codes that mean nothing
	// to a user, and a missing pool reverts with no data at all.
	describe('market swap (Uniswap v3)', () => {
		it('spells out "Too little received" as a slippage problem', () => {
			const message = describeTxError(reasonRevert('Too little received'), { action: 'dex-swap' });
			expect(message).toMatch(/price tolerance/i);
		});

		it('blames the device clock for "Transaction too old"', () => {
			const message = describeTxError(reasonRevert('Transaction too old'), { action: 'dex-swap' });
			expect(message).toMatch(/device clock/i);
			expect(message).toMatch(/refresh the quote/i);
		});

		it('explains STF as an allowance or balance shortfall, naming the token', () => {
			const message = describeTxError(reasonRevert('STF'), { action: 'dex-swap', tokenSymbol: 'GSUSD' });
			expect(message).toContain('GSUSD');
			expect(message).toMatch(/approve/i);
			expect(message).not.toBe('STF');
		});

		it('explains SPL as a price limit', () => {
			expect(describeTxError(reasonRevert('SPL'), { action: 'dex-swap' })).toMatch(/smaller amount/i);
		});

		it('reads the quoter\'s zero-liquidity revert as "no DEX liquidity"', () => {
			const message = describeTxError(
				reasonRevert('swaps entirely within 0-liquidity regions are not supported'),
				{ action: 'dex-swap' }
			);
			expect(message).toMatch(/no dex liquidity/i);
		});

		it('reads an empty revert on a market swap as a missing pool', () => {
			const bare = new BaseError('reverted', {
				cause: new ContractFunctionRevertedError({ abi: [], functionName: 'exactInputSingle' }),
			});
			expect(describeTxError(bare, { action: 'dex-swap' })).toMatch(/no dex liquidity/i);
			const zero = new BaseError('returned no data', {
				cause: new ContractFunctionZeroDataError({ functionName: 'quoteExactInputSingle' }),
			});
			expect(describeTxError(zero, { action: 'dex-swap' })).toMatch(/no dex liquidity/i);
		});

		// A bare revert on a vault deposit is NOT a liquidity problem; do not say it is.
		it('never claims missing liquidity on a non-DEX action', () => {
			const bare = new BaseError('reverted', {
				cause: new ContractFunctionRevertedError({ abi: [], functionName: 'deposit' }),
			});
			expect(describeTxError(bare, { action: 'deposit' })).not.toMatch(/liquidity/i);
		});
	});

	describe('guardian pause', () => {
		it.each([
			['mint', 'mint'],
			['liquidate', 'pool-liquidate'],
		] as const)('says the guardian paused the vault on %s', (fn, action) => {
			const message = describeTxError(pauseRevert(goldVaultAbi as Abi, fn, 'EnforcedPause'), { action });
			expect(message).toMatch(/guardian has paused this action/i);
			expect(message).toMatch(/repaying, depositing collateral and withdrawing/i);
			expect(message).toMatch(/try again later/i);
			expect(message).not.toMatch(/reverted/i);
		});

		it.each([
			['deposit', 'pool-deposit'],
			['withdraw', 'pool-withdraw'],
		] as const)('says the guardian paused the pool on %s', (fn, action) => {
			const message = describeTxError(pauseRevert(stabilityPoolAbi as Abi, fn, 'EnforcedPause'), { action });
			expect(message).toMatch(/guardian has paused this action/i);
			expect(message).toMatch(/claiming/i);
			expect(message).toMatch(/try again later/i);
		});

		it('explains ExpectedPause rather than surfacing the bare revert', () => {
			const message = describeTxError(pauseRevert(goldVaultAbi as Abi, 'unpause', 'ExpectedPause'));
			expect(message).toMatch(/paused/i);
			expect(message).not.toMatch(/reverted/i);
		});
	});

	// The final oracle (variant C): a gold band per token for borrowing and reserve swaps, a
	// liquidation price never refused for being off the band, a guardian-only freeze.
	describe('oracle pricing rules', () => {
		it('says borrowing waits for the price to return to the gold band', () => {
			const message = describeTxError(reasonRevert('Off gold band'), { action: 'mint' });
			expect(message).toMatch(/gold price/i);
			expect(message).toMatch(/repaying and depositing collateral still work/i);
			expect(message).toMatch(/resumes on its own/i);
		});

		it('says a reserve swap off the gold band waits for the price to return, with no second source', () => {
			const message = describeTxError(reasonRevert('Off gold band'), { action: 'swap' });
			expect(message).toMatch(/reserve swaps/i);
			expect(message).toMatch(/back inside the band/i);
			expect(message).not.toMatch(/second (price )?source|confirm/i);
		});

		it('never says liquidation is refused for being off the band', () => {
			const message = describeTxError(reasonRevert('Off gold band'), { action: 'pool-liquidate' });
			expect(message).toMatch(/liquidation is not refused/i);
			expect(message).not.toMatch(/second (price )?source|confirm/i);
		});

		it('explains that no reliable price means a stale or invalid feed, and that it resumes by itself', () => {
			const message = describeTxError(reasonRevert('No reliable price'));
			expect(message).toMatch(/no reliable price/i);
			expect(message).toMatch(/gold price/i);
			expect(message).toMatch(/borrowing, liquidation and reserve swaps resume on their own/i);
			expect(message).not.toMatch(/recovery|confirmed price|corroborate/i);
		});

		it('says the emergency path never liquidates on an old price', () => {
			expect(describeTxError(reasonRevert('No price'))).toMatch(/never liquidates on an old price/i);
		});

		it('names the guardian as the one who froze a token and says what still works', () => {
			const message = describeTxError(reasonRevert('Token frozen'), { action: 'mint' });
			expect(message).toMatch(/guardian has frozen/i);
			expect(message).toMatch(/repaying, depositing collateral and withdrawing from a vault without debt still work/i);
		});

		it('never promises another reserve asset for a frozen token', () => {
			const message = describeTxError(reasonRevert('Token frozen'), { action: 'swap' });
			expect(message).toMatch(/frozen/i);
			expect(message).not.toMatch(/other reserve asset/i);
		});

		it.each([
			['Not frozen', /not frozen/i],
			['Thin vault: liquidate in full', /only a full liquidation/i],
			['Liquidation too small', /too small/i],
			['Residual debt below minimum', /minimum/i],
			['Absorption would drain pool', /emptying itself/i],
			['No same-block withdrawal', /wait for the next block, then withdraw/i],
			['No same-block claim', /wait for the next block, then claim/i],
			['No gains', /no collateral gain/i],
			['No collateral held', /stays owed/i],
			['Nothing credited', /nothing was deposited/i],
			['Paused: repay in full to withdraw', /repay the debt in full/i],
			['Feed not independent', /independent/i],
			['No oracle feed', /no price feed/i],
		])('translates "%s" into a sentence', (reason, expected) => {
			const message = describeTxError(reasonRevert(reason));
			expect(message).toMatch(expected);
			expect(message).not.toBe(reason);
		});

		// The recovery activation and the second source are gone from the contract, so are
		// their reasons.
		it('no longer carries a mapping for a reason the oracle cannot raise', () => {
			expect(describeTxError(reasonRevert('No confirmation feed'))).toBe('No confirmation feed');
			expect(describeTxError(reasonRevert('Feeds disagree'))).toBe('Feeds disagree');
			// freezeToken now extends a live freeze instead of refusing it.
			expect(describeTxError(reasonRevert('Already frozen'))).toBe('Already frozen');
		});
	});
});
