import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ChainId } from '@goldstandard/models';
import { REQUIRED_MAINNET_ADDRESS_VARIABLES } from './buildEnv';
import { GOLD_VAULT_LAUNCH_MIN_DEBT, GOLD_VAULT_MIN_DEBT } from './goldVault';

const GSUSD = 10n ** 18n;

describe('GOLD_VAULT_LAUNCH_MIN_DEBT', () => {
	it('is 1,000 GSUSD on mainnet', () => {
		expect(GOLD_VAULT_LAUNCH_MIN_DEBT[ChainId.MAINNET]).toBe(1_000n * GSUSD);
	});

	it('is 100 GSUSD on Sepolia, the contract default the testnet harness keeps', () => {
		expect(GOLD_VAULT_LAUNCH_MIN_DEBT[ChainId.SEPOLIA]).toBe(100n * GSUSD);
	});

	it('matches the figure the mainnet deployment is configured with', () => {
		const example = readFileSync(
			resolve(__dirname, '../../../../contracts/.env.mainnet.example'),
			'utf8'
		);
		const configured = /^MIN_DEBT_GSUSD=(\d+)$/m.exec(example)?.[1];
		expect(configured).toBeDefined();
		expect(GOLD_VAULT_LAUNCH_MIN_DEBT[ChainId.MAINNET]).toBe(BigInt(configured ?? 0) * GSUSD);
	});
});

describe('GOLD_VAULT_MIN_DEBT', () => {
	afterEach(() => {
		vi.doUnmock('./targetChain');
		vi.resetModules();
	});

	it('is the Sepolia figure when VITE_TARGET_CHAIN_ID is unset', () => {
		expect(GOLD_VAULT_MIN_DEBT).toBe(100n * GSUSD);
	});

	it('is the mainnet figure in a build that targets mainnet', async () => {
		vi.resetModules();
		vi.doMock('./targetChain', async (importOriginal) => ({
			...(await importOriginal<typeof import('./targetChain')>()),
			TARGET_CHAIN_ID: ChainId.MAINNET,
		}));
		const mainnetBuild = await import('./goldVault');
		expect(mainnetBuild.GOLD_VAULT_MIN_DEBT).toBe(1_000n * GSUSD);
	});
});

// A host that passes variables through the process environment does not trim them, and the
// build guard judges the trimmed value, so the bundle must read the same one. Vitest gives a
// module no stubbed VITE_* value through the typed accessor these files use, so the accessor
// is handed a padded environment here and does its real work on it.
describe('contract addresses read from the environment', () => {
	const addressFor = (index: number): string => `0x${(index + 1).toString(16).padStart(40, '0')}`;
	const VARIABLES = [...REQUIRED_MAINNET_ADDRESS_VARIABLES, 'VITE_UNISWAP_QUOTER', 'VITE_UNISWAP_ROUTER'];
	const PADDED_ENV = Object.fromEntries(VARIABLES.map((key, index) => [key, ` ${addressFor(index)}\r\n`]));
	const expected = (key: string): string => addressFor(VARIABLES.indexOf(key));

	const importWithEnv = async (env: Readonly<Record<string, string | undefined>>) => {
		vi.resetModules();
		vi.doMock('./contractAddressEnv', async (importOriginal) => {
			const real = await importOriginal<typeof import('./contractAddressEnv')>();
			return { ...real, contractAddressFromEnv: (_env: unknown, key: string) => real.contractAddressFromEnv(env, key) };
		});
		return { vault: await import('./goldVault'), dex: await import('./dex') };
	};

	afterEach(() => {
		vi.doUnmock('./contractAddressEnv');
		vi.resetModules();
	});

	it('uses every padded contract address without its padding', async () => {
		const { vault, dex } = await importWithEnv(PADDED_ENV);
		const read = {
			VITE_GOLD_VAULT_ADDRESS: vault.GOLD_VAULT_ADDRESSES,
			VITE_GOLD_ORACLE_ADDRESS: vault.GOLD_ORACLE_ADDRESSES,
			VITE_GUSD_ADDRESS: vault.GUSD_ADDRESSES,
			VITE_STABILITY_MODULE_ADDRESS: vault.STABILITY_MODULE_ADDRESSES,
			VITE_STABILITY_POOL_ADDRESS: vault.STABILITY_POOL_ADDRESSES,
			VITE_STABILITY_RESERVE_ADDRESS: vault.STABILITY_RESERVE_ADDRESSES,
			VITE_SURPLUS_BUFFER_ADDRESS: vault.SURPLUS_BUFFER_ADDRESSES,
			VITE_SILO_FACTORY_ADDRESS: vault.SILO_FACTORY_ADDRESSES,
			VITE_VAULT_REGISTRY_ADDRESS: vault.VAULT_REGISTRY_ADDRESSES,
			VITE_UNISWAP_QUOTER: dex.UNISWAP_QUOTER_ADDRESSES,
			VITE_UNISWAP_ROUTER: dex.UNISWAP_ROUTER_ADDRESSES,
		};
		expect(Object.keys(read).sort()).toEqual([...VARIABLES].sort());
		for (const [key, addresses] of Object.entries(read)) {
			expect(addresses[ChainId.SEPOLIA], key).toBe(expected(key));
		}
		expect(vault.getGoldVaultContractConfig(ChainId.SEPOLIA)?.address).toBe(expected('VITE_GOLD_VAULT_ADDRESS'));
		expect(dex.getDexConfig(ChainId.SEPOLIA)?.router.address).toBe(expected('VITE_UNISWAP_ROUTER'));
	});

	it('treats a blank address as not configured', async () => {
		const { vault, dex } = await importWithEnv({ ...PADDED_ENV, VITE_GOLD_VAULT_ADDRESS: '  ', VITE_UNISWAP_ROUTER: '\n' });
		expect(vault.getGoldVaultContractConfig(ChainId.SEPOLIA)).toBeUndefined();
		expect(dex.getDexConfig(ChainId.SEPOLIA)).toBeUndefined();
	});
});
