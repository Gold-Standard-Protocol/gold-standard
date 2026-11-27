import { UNSET_ADDRESS, contractAddressFromEnv } from './contractAddressEnv';

const VAULT = '0x45804880De22913dAFE09f4980848ECE6EcbAf78';

describe('contractAddressFromEnv', () => {
	it('returns a set address as it is', () => {
		expect(contractAddressFromEnv({ VITE_GOLD_VAULT_ADDRESS: VAULT }, 'VITE_GOLD_VAULT_ADDRESS')).toBe(VAULT);
	});

	it.each([` ${VAULT}`, `${VAULT} `, `${VAULT}\n`, `\t${VAULT}\r\n`])('removes the whitespace around %j', (padded) => {
		expect(contractAddressFromEnv({ VITE_GOLD_VAULT_ADDRESS: padded }, 'VITE_GOLD_VAULT_ADDRESS')).toBe(VAULT);
	});

	it.each([undefined, '', '   ', '\n'])('reads %j as not configured', (value) => {
		expect(contractAddressFromEnv({ VITE_GOLD_VAULT_ADDRESS: value }, 'VITE_GOLD_VAULT_ADDRESS')).toBe(UNSET_ADDRESS);
	});

	it('reads a value that is not an address as not configured, and says so once', () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const broken = VAULT.replace('De22', 'dE22');
		expect(contractAddressFromEnv({ VITE_BROKEN: broken }, 'VITE_BROKEN')).toBe(UNSET_ADDRESS);
		expect(contractAddressFromEnv({ VITE_BROKEN: '0x1234' }, 'VITE_BROKEN')).toBe(UNSET_ADDRESS);
		expect(error).toHaveBeenCalledTimes(1);
		expect(error).toHaveBeenCalledWith(expect.stringContaining('VITE_BROKEN is not a valid address'));
		error.mockRestore();
	});
});
