import { describe, expect, it } from 'vitest';
import { Token } from '@goldstandard/models';
import { filterActiveCollateral } from './useActiveCollateralTokens';

// The filter reads only the record keys and order; a minimal stand-in is enough here.
const paxg = { address: '0x45804880De22913dAFE09f4980848ECE6EcbAf78', symbol: 'PAXG' } as unknown as Token;
const xaut = { address: '0x68749665FF8D2d112Fa859AA293F07A622782F38', symbol: 'XAUT' } as unknown as Token;
const tokens = { [paxg.address]: paxg, [xaut.address]: xaut };
const type = (active: boolean) => ({ status: 'success' as const, result: [paxg.address, 1n, 1n, 1n, 1n, 0n, active] });

describe('filterActiveCollateral', () => {
	it('keeps only active collateral types: a dormant XAUT stays out of the picker', () => {
		expect(filterActiveCollateral(tokens, [type(true), type(false)])).toEqual({ [paxg.address]: paxg });
	});

	it('treats a failed read or a never-added type as not active', () => {
		expect(filterActiveCollateral(tokens, [{ status: 'failure' }, type(true)])).toEqual({ [xaut.address]: xaut });
		expect(filterActiveCollateral(tokens, [{ status: 'success', result: undefined }, type(false)])).toEqual({});
	});

	it('answers undefined while the reads are loading', () => {
		expect(filterActiveCollateral(tokens, undefined)).toBeUndefined();
	});
});
