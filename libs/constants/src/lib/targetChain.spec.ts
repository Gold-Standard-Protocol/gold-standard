import { ChainId } from '@goldstandard/models';
import {
	EXPLORER_BASE_URL,
	TARGET_CHAIN_ID,
	explorerAddressUrl,
	parseTargetChainId,
} from './targetChain';

describe('parseTargetChainId', () => {
	it("maps '1' to mainnet", () => {
		expect(parseTargetChainId('1')).toBe(ChainId.MAINNET);
	});

	it("maps '11155111' to Sepolia", () => {
		expect(parseTargetChainId('11155111')).toBe(ChainId.SEPOLIA);
	});

	it('maps undefined to Sepolia', () => {
		expect(parseTargetChainId(undefined)).toBe(ChainId.SEPOLIA);
	});

	it('maps an empty string to Sepolia', () => {
		expect(parseTargetChainId('')).toBe(ChainId.SEPOLIA);
	});

	it("trims whitespace, so '  1 ' is mainnet", () => {
		expect(parseTargetChainId('  1 ')).toBe(ChainId.MAINNET);
	});

	it("falls back to Sepolia for '5' with a warning naming the value", () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		expect(parseTargetChainId('5')).toBe(ChainId.SEPOLIA);
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn.mock.calls[0][0]).toContain('5');
		warn.mockRestore();
	});

	it("falls back to Sepolia for 'mainnet' with a warning naming the value", () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		expect(parseTargetChainId('mainnet')).toBe(ChainId.SEPOLIA);
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn.mock.calls[0][0]).toContain('mainnet');
		warn.mockRestore();
	});

	it('throws on an unrecognised value in a production build', () => {
		expect(() => parseTargetChainId('5', true)).toThrow(
			'VITE_TARGET_CHAIN_ID'
		);
	});

	it('still accepts valid values in a production build', () => {
		expect(parseTargetChainId('1', true)).toBe(ChainId.MAINNET);
		expect(parseTargetChainId(undefined, true)).toBe(ChainId.SEPOLIA);
	});
});

describe('TARGET_CHAIN_ID', () => {
	it('defaults to Sepolia when VITE_TARGET_CHAIN_ID is unset', () => {
		expect(TARGET_CHAIN_ID).toBe(ChainId.SEPOLIA);
	});
});

describe('explorerAddressUrl', () => {
	const address = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';

	it('builds an Etherscan mainnet URL', () => {
		expect(explorerAddressUrl(ChainId.MAINNET, address)).toBe(
			`https://etherscan.io/address/${address}`
		);
	});

	it('builds an Etherscan Sepolia URL', () => {
		expect(explorerAddressUrl(ChainId.SEPOLIA, address)).toBe(
			`https://sepolia.etherscan.io/address/${address}`
		);
	});

	it('exposes a base URL per supported chain', () => {
		expect(EXPLORER_BASE_URL[ChainId.MAINNET]).toBe('https://etherscan.io');
		expect(EXPLORER_BASE_URL[ChainId.SEPOLIA]).toBe(
			'https://sepolia.etherscan.io'
		);
	});
});
