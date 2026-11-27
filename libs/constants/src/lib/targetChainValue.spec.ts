import { ChainId } from '@goldstandard/models';
import { parseTargetChainId } from './targetChain';
import {
	namesTargetChain,
	resolveTargetChainValue,
	unnamedTargetChainMessage,
	unsupportedTargetChainMessage,
} from './targetChainValue';

const REJECTED = [
	'invalid-chain',
	'5',
	'mainnet',
	'sepolia',
	'0x1',
	'01',
	'1.0',
	'1 1',
	'__proto__',
	'constructor',
];

describe('resolveTargetChainValue', () => {
	it("selects mainnet for '1'", () => {
		expect(resolveTargetChainValue('1')).toBe(ChainId.MAINNET);
	});

	it("selects Sepolia for '11155111'", () => {
		expect(resolveTargetChainValue('11155111')).toBe(ChainId.SEPOLIA);
	});

	it('selects Sepolia when the value is unset, empty or only whitespace', () => {
		expect(resolveTargetChainValue(undefined)).toBe(ChainId.SEPOLIA);
		expect(resolveTargetChainValue('')).toBe(ChainId.SEPOLIA);
		expect(resolveTargetChainValue('   ')).toBe(ChainId.SEPOLIA);
	});

	it('trims surrounding whitespace before matching', () => {
		expect(resolveTargetChainValue(' 1 ')).toBe(ChainId.MAINNET);
		expect(resolveTargetChainValue('\t11155111\n')).toBe(ChainId.SEPOLIA);
	});

	it.each(REJECTED)('rejects %j', (raw) => {
		expect(resolveTargetChainValue(raw)).toBeUndefined();
	});
});

describe('unsupportedTargetChainMessage', () => {
	it('names the bad value and every accepted value', () => {
		const message = unsupportedTargetChainMessage('invalid-chain');
		expect(message).toContain('VITE_TARGET_CHAIN_ID "invalid-chain"');
		expect(message).toContain('"1" (mainnet)');
		expect(message).toContain('"11155111" (Sepolia)');
		expect(message).toContain('unset or empty');
	});
});

describe('namesTargetChain', () => {
	it.each(['1', ' 1 ', '11155111'])('is true for %j, which names a chain', (raw) => {
		expect(namesTargetChain(raw)).toBe(true);
	});

	it.each([undefined, '', '   '])('is false for %j, which falls back to Sepolia', (raw) => {
		expect(namesTargetChain(raw)).toBe(false);
	});
});

describe('unnamedTargetChainMessage', () => {
	it('names every chain a build may name, but not the unset fallback', () => {
		const message = unnamedTargetChainMessage();
		expect(message).toContain('VITE_TARGET_CHAIN_ID is unset or empty');
		expect(message).toContain('"1" (mainnet) or "11155111" (Sepolia)');
		expect(message).not.toContain('an unset or empty value (Sepolia)');
		expect(message).toContain('misspelt variable name');
	});
});

describe('parseTargetChainId agrees with the shared table', () => {
	it.each(['1', ' 1 ', '11155111', '', '  '])(
		'returns the shared chain for accepted value %j in a production build',
		(raw) => {
			expect(parseTargetChainId(raw, true)).toBe(resolveTargetChainValue(raw));
		}
	);

	it.each(REJECTED)(
		'throws the shared message for rejected value %j in a production build',
		(raw) => {
			expect(() => parseTargetChainId(raw, true)).toThrow(
				unsupportedTargetChainMessage(raw)
			);
		}
	);
});
