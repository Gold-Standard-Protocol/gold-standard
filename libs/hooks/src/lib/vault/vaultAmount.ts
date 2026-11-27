import { parseAmount } from '@goldstandard/utils';

/**
 * A typed amount in the token's native units, or undefined when it cannot be one.
 *
 * The shared parser never throws on free text (the repay box accepts anything) and
 * refuses more decimals than the token carries rather than rounding them. Unknown
 * decimals are also "cannot parse": guessing 18 for a 6-decimal token asks the contract
 * for a million million times what was typed.
 */
export function parseVaultAmount(amount: string | undefined, decimals: number | undefined): bigint | undefined {
	if (decimals === undefined) return undefined;
	return parseAmount(amount, decimals);
}
