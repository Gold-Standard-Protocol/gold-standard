import { ChainId } from '@goldstandard/models';
import { TOKEN_LIST, findTokenInfoByAddress } from './tokens';

const listed = (symbol: string) => {
	const token = TOKEN_LIST.find((t) => t.symbol === symbol);
	if (!token) throw new Error(`${symbol} is not in TOKEN_LIST`);
	return token;
};

describe('findTokenInfoByAddress', () => {
	it('resolves PAXG on mainnet with its 18 decimals', () => {
		const found = findTokenInfoByAddress(listed('PAXG').addresses[ChainId.MAINNET], ChainId.MAINNET);
		expect(found?.symbol).toBe('PAXG');
		expect(found?.decimals).toBe(18);
	});

	it('resolves XAUT on mainnet with its 6 decimals', () => {
		const found = findTokenInfoByAddress(listed('XAUT').addresses[ChainId.MAINNET], ChainId.MAINNET);
		expect(found?.symbol).toBe('XAUT');
		expect(found?.decimals).toBe(6);
	});

	it('matches regardless of case, since chain reads come back checksummed', () => {
		const checksummed = listed('PAXG').addresses[ChainId.MAINNET] as string;
		const lower = checksummed.toLowerCase();
		expect(lower).not.toBe(checksummed);
		expect(findTokenInfoByAddress(lower, ChainId.MAINNET)?.symbol).toBe('PAXG');
	});

	it('does not match an address listed for a different chain', () => {
		const mainnetXaut = listed('XAUT').addresses[ChainId.MAINNET];
		expect(findTokenInfoByAddress(mainnetXaut, ChainId.SEPOLIA)).toBeUndefined();
	});

	it('treats the zero address of an empty vault as no token, never as GSUSD', () => {
		expect(findTokenInfoByAddress('0x0000000000000000000000000000000000000000')).toBeUndefined();
	});

	it('returns undefined for no address and for an unlisted one', () => {
		expect(findTokenInfoByAddress(undefined)).toBeUndefined();
		expect(findTokenInfoByAddress('0x1111111111111111111111111111111111111111')).toBeUndefined();
	});
});

// TOKEN_LIST is evaluated at import, so each case stubs the env and loads a fresh copy.
describe('Sepolia collateral addresses come from env only', () => {
	const CURRENT_SEPOLIA_PAXG = '0x5ccd1c3Cf37261EbA2f681b2848271C9e1De4c6e';
	const loadTokens = async () => {
		vi.resetModules();
		return import('./tokens');
	};

	afterEach(() => {
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
	});

	it('lists no PAXG on Sepolia when VITE_PAXG_ADDRESS is unset, instead of a stale mock', async () => {
		vi.stubEnv('VITE_PAXG_ADDRESS', '');
		const tokens = await loadTokens();
		const paxg = tokens.TOKEN_LIST.find((t) => t.symbol === 'PAXG');
		expect(paxg?.addresses[ChainId.SEPOLIA]).toBeUndefined();
		const sepolia = Object.values(tokens.createTokenInstances(ChainId.SEPOLIA, tokens.TOKEN_LIST));
		expect(sepolia.map((t) => t.symbol)).not.toContain('PAXG');
	});

	it('takes the Sepolia PAXG address from VITE_PAXG_ADDRESS', async () => {
		vi.stubEnv('VITE_PAXG_ADDRESS', CURRENT_SEPOLIA_PAXG);
		const tokens = await loadTokens();
		expect(tokens.findTokenInfoByAddress(CURRENT_SEPOLIA_PAXG, ChainId.SEPOLIA)?.symbol).toBe('PAXG');
	});

	it('refuses a malformed address and names the variable, instead of reading a token that is not there', async () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		// One character short of the current token, as a truncated paste would leave it.
		const truncated = CURRENT_SEPOLIA_PAXG.slice(0, -1);
		vi.stubEnv('VITE_PAXG_ADDRESS', truncated);
		const tokens = await loadTokens();
		expect(tokens.TOKEN_LIST.find((t) => t.symbol === 'PAXG')?.addresses[ChainId.SEPOLIA]).toBeUndefined();
		expect(tokens.findTokenInfoByAddress(truncated, ChainId.SEPOLIA)).toBeUndefined();
		const sepolia = Object.keys(tokens.createTokenInstances(ChainId.SEPOLIA, tokens.TOKEN_LIST));
		expect(sepolia).not.toContain(truncated);
		expect(error).toHaveBeenCalledWith(expect.stringContaining('VITE_PAXG_ADDRESS'));
	});

	it('refuses an address whose mixed case is not a valid checksum', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const badChecksum = CURRENT_SEPOLIA_PAXG.replace('EbA', 'eba');
		vi.stubEnv('VITE_PAXG_ADDRESS', badChecksum);
		const tokens = await loadTokens();
		expect(tokens.findTokenInfoByAddress(badChecksum, ChainId.SEPOLIA)).toBeUndefined();
	});

	it('accepts an all lower case address', async () => {
		const lower = CURRENT_SEPOLIA_PAXG.toLowerCase();
		vi.stubEnv('VITE_PAXG_ADDRESS', lower);
		const tokens = await loadTokens();
		expect(tokens.findTokenInfoByAddress(lower, ChainId.SEPOLIA)?.symbol).toBe('PAXG');
	});
});
