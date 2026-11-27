import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getAddress } from 'viem';
import { GSUSD_LOGO_URL, GSUSD_TOKEN, tokenListForBuild, tokenListText, type PublishedTokenList } from './tokenList';
import { TOKEN_LIST } from './tokens';

const GSUSD = '0x24C3597eF975bdB565fd146f61438Ef14e15601D';
const build = { chainId: 1, gsusd: GSUSD, day: '2026-11-27' };

/** The rules of the Token Lists schema (tokenlists.org) that apply to this list, by hand. */
function schemaProblems(list: PublishedTokenList): string[] {
	const problems: string[] = [];
	const check = (ok: boolean, problem: string) => {
		if (!ok) problems.push(problem);
	};
	check(/^[\w ]+$/.test(list.name) && list.name.length >= 1 && list.name.length <= 30, 'list name');
	check(!Number.isNaN(Date.parse(list.timestamp)) && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(list.timestamp), 'timestamp');
	for (const part of [list.version.major, list.version.minor, list.version.patch])
		check(Number.isInteger(part) && part >= 0, 'version');
	check(list.keywords.length <= 20 && list.keywords.every((word) => /^[\w ]+$/.test(word) && word.length <= 20), 'keywords');
	check(new Set(list.keywords).size === list.keywords.length, 'keywords are unique');
	check(new URL(list.logoURI).protocol === 'https:', 'list logo');
	check(list.tokens.length >= 1 && list.tokens.length <= 10000, 'token count');
	for (const token of list.tokens) {
		check(Number.isInteger(token.chainId) && token.chainId >= 1, 'chain id');
		check(/^0x[a-fA-F0-9]{40}$/.test(token.address) && getAddress(token.address) === token.address, 'checksummed address');
		check(Number.isInteger(token.decimals) && token.decimals >= 0 && token.decimals <= 255, 'decimals');
		check(token.name.length >= 1 && token.name.length <= 60 && /^[ \S+]+$/.test(token.name), 'token name');
		check(token.symbol.length >= 1 && token.symbol.length <= 20 && /^\S+$/.test(token.symbol), 'token symbol');
		check(new URL(token.logoURI).protocol === 'https:', 'token logo');
	}
	return problems;
}

describe('the published token list', () => {
	const list = tokenListForBuild(build);

	it('lists GSUSD on mainnet at the build address, under the rules of the format', () => {
		expect(list).toBeDefined();
		if (!list) return;
		expect(schemaProblems(list)).toEqual([]);
		expect(list.tokens).toEqual([
			{ chainId: 1, address: GSUSD, name: 'Gold Standard Dollar', symbol: 'GSUSD', decimals: 18, logoURI: GSUSD_LOGO_URL },
		]);
		expect(list.version).toEqual({ major: 1, minor: 0, patch: 0 });
	});

	it('is dated by the commit day, so one commit builds one file', () => {
		expect(list?.timestamp).toBe('2026-11-27T00:00:00.000Z');
		expect(tokenListText(tokenListForBuild(build) as PublishedTokenList)).toBe(tokenListText(list as PublishedTokenList));
		expect(tokenListText(list as PublishedTokenList).endsWith('}\n')).toBe(true);
	});

	it.each([
		['a build for another chain', { ...build, chainId: 11155111 }],
		['no GSUSD address', { ...build, gsusd: undefined }],
		['the zero address', { ...build, gsusd: '0x0000000000000000000000000000000000000000' }],
		['a malformed address', { ...build, gsusd: '0x1234' }],
		['no commit day', { ...build, day: undefined }],
		['a day that is not a date', { ...build, day: '2026-13-40' }],
	])('publishes nothing for %s', (_case, input) => {
		expect(tokenListForBuild(input)).toBeUndefined();
	});

	it('names the token as the dapp token table does', () => {
		const shown = TOKEN_LIST.find((token) => token.symbol === GSUSD_TOKEN.symbol);
		expect(shown).toMatchObject({ name: GSUSD_TOKEN.name, symbol: GSUSD_TOKEN.symbol, decimals: GSUSD_TOKEN.decimals });
	});

	it('names the token as the contract does', () => {
		const source = readFileSync(resolve(__dirname, '../../../../contracts/src/core/GoldStablecoin.sol'), 'utf8');
		expect(source).toContain(`ERC20("${GSUSD_TOKEN.name}", "${GSUSD_TOKEN.symbol}")`);
		// OpenZeppelin's ERC20 reports 18 decimals unless a contract overrides it.
		expect(source).not.toMatch(/function decimals\(/);
		expect(GSUSD_TOKEN.decimals).toBe(18);
	});
});
