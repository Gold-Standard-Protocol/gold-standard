import { type Address } from 'viem';
import { goldOracleAbi } from './abis/GoldOracle';
import { goldVaultAbi } from './abis/GoldVault';
import { goldStabilityReserveAbi } from './abis/GoldStabilityReserve';
import { stabilityModuleAbi } from './abis/StabilityModule';
import { stabilityPoolAbi } from './abis/StabilityPool';
import { surplusBufferAbi } from './abis/SurplusBuffer';
import { vaultRegistryAbi } from './abis/VaultRegistry';
import { ChainId } from '@goldstandard/models';
import { UNSET_ADDRESS, contractAddressFromEnv } from './contractAddressEnv';
import { TARGET_CHAIN_ID, type TargetChainId } from './targetChain';

// Vite injects `import.meta.env` at build time. Read it through a locally-typed accessor so that
// consumers which compile this file type-check without needing vite/client ambient types in their
// own tsconfig (and without a triple-slash reference, which the lint config disallows).
const viteEnv = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};

// Contract addresses — after deployment, set in .env:
//   VITE_GOLD_VAULT_ADDRESS=0x...
//   VITE_STABILITY_MODULE_ADDRESS=0x...
//   VITE_GUSD_ADDRESS=0x...
//   VITE_STABILITY_POOL_ADDRESS=0x...
//   VITE_STABILITY_RESERVE_ADDRESS=0x...
//   VITE_DEPLOY_BLOCK=11593178   (block the vault was deployed in; the activity feed starts here)
//   VITE_GOLD_ORACLE_ADDRESS=0x...
//   VITE_SURPLUS_BUFFER_ADDRESS=0x...
// Each is read trimmed, as the build guard (buildEnv.ts) judges it.
export const GOLD_VAULT_ADDRESSES: Partial<Record<ChainId, Address>> = {
	[TARGET_CHAIN_ID]: contractAddressFromEnv(viteEnv, 'VITE_GOLD_VAULT_ADDRESS'),
} as const;

export const STABILITY_MODULE_ADDRESSES: Partial<Record<ChainId, Address>> = {
	[TARGET_CHAIN_ID]: contractAddressFromEnv(viteEnv, 'VITE_STABILITY_MODULE_ADDRESS'),
} as const;

export const GUSD_ADDRESSES: Partial<Record<ChainId, Address>> = {
	[TARGET_CHAIN_ID]: contractAddressFromEnv(viteEnv, 'VITE_GUSD_ADDRESS'),
} as const;

export const STABILITY_POOL_ADDRESSES: Partial<Record<ChainId, Address>> = {
	[TARGET_CHAIN_ID]: contractAddressFromEnv(viteEnv, 'VITE_STABILITY_POOL_ADDRESS'),
} as const;

export const STABILITY_RESERVE_ADDRESSES: Partial<Record<ChainId, Address>> = {
	[TARGET_CHAIN_ID]: contractAddressFromEnv(viteEnv, 'VITE_STABILITY_RESERVE_ADDRESS'),
} as const;

export const GOLD_ORACLE_ADDRESSES: Partial<Record<ChainId, Address>> = {
	[TARGET_CHAIN_ID]: contractAddressFromEnv(viteEnv, 'VITE_GOLD_ORACLE_ADDRESS'),
} as const;

export const SURPLUS_BUFFER_ADDRESSES: Partial<Record<ChainId, Address>> = {
	[TARGET_CHAIN_ID]: contractAddressFromEnv(viteEnv, 'VITE_SURPLUS_BUFFER_ADDRESS'),
} as const;

export const SILO_FACTORY_ADDRESSES: Partial<Record<ChainId, Address>> = {
	[TARGET_CHAIN_ID]: contractAddressFromEnv(viteEnv, 'VITE_SILO_FACTORY_ADDRESS'),
} as const;

/**
 * VaultRegistry: the on-chain list of open vaults and the views a liquidator or an agent
 * needs with nothing but the contracts (liquidatableVaults, vaultSummary, collateralTypeOf).
 * Zero until it is deployed and wired on the target chain.
 */
export const VAULT_REGISTRY_ADDRESSES: Partial<Record<ChainId, Address>> = {
	[TARGET_CHAIN_ID]: contractAddressFromEnv(viteEnv, 'VITE_VAULT_REGISTRY_ADDRESS'),
} as const;

/**
 * GoldVault.minDebt, the smallest non-zero debt a vault may carry, as each chain is deployed
 * with it (18 decimals): 1,000 GSUSD on mainnet (MIN_DEBT_GSUSD in
 * contracts/.env.mainnet.example), 100 on Sepolia, where the testnet harness keeps the
 * contract default. The figure is governed, so the chain's own minDebt is the authority and
 * this is only what a form assumes until that read lands, or while it fails.
 */
export const GOLD_VAULT_LAUNCH_MIN_DEBT: Record<TargetChainId, bigint> = {
	[ChainId.MAINNET]: 1_000n * 10n ** 18n,
	[ChainId.SEPOLIA]: 100n * 10n ** 18n,
};

/**
 * The launch figure for the chain this build targets. A mainnet build that assumed the
 * Sepolia 100 offered amounts the vault refuses whenever the minDebt read was slow or
 * failed.
 */
export const GOLD_VAULT_MIN_DEBT = GOLD_VAULT_LAUNCH_MIN_DEBT[TARGET_CHAIN_ID];

export const GOLD_VAULT_SUPPORTED_CHAINS = [TARGET_CHAIN_ID] as const;
export type GoldVaultChainId = TargetChainId;

export const isGoldVaultChainId = (chainId: ChainId) =>
	GOLD_VAULT_SUPPORTED_CHAINS.includes(chainId as GoldVaultChainId);

export const getGoldVaultContractConfig = (chainId: GoldVaultChainId | undefined) => {
	if (!chainId) return;
	const address = configuredAddress(GOLD_VAULT_ADDRESSES[chainId]);
	if (!address) return;
	return { address, abi: goldVaultAbi } as const;
};

export const getStabilityModuleContractConfig = (chainId: GoldVaultChainId | undefined) => {
	if (!chainId) return;
	const address = configuredAddress(STABILITY_MODULE_ADDRESSES[chainId]);
	if (!address) return;
	return { address, abi: stabilityModuleAbi } as const;
};

export const getGusdAddress = (chainId: GoldVaultChainId | undefined): Address | undefined => {
	if (!chainId) return;
	// The zero-address fallback means "unset", never a contract to call.
	return configuredAddress(GUSD_ADDRESSES[chainId]);
};

// Treats the zero-address env fallback as "not configured" so the configs below are only
// returned once a real deployment address is set. Consumers should gate features on the
// config being defined (the pre-launch honesty pattern used by useProtocolStats).
const configuredAddress = (address: Address | undefined): Address | undefined =>
	!address || address === UNSET_ADDRESS ? undefined : address;

export const getStabilityPoolContractConfig = (chainId: GoldVaultChainId | undefined) => {
	if (!chainId) return;
	const address = configuredAddress(STABILITY_POOL_ADDRESSES[chainId]);
	if (!address) return;
	return { address, abi: stabilityPoolAbi } as const;
};

/**
 * Block the vault was deployed in, per chain. Event-history reads start here rather
 * than at genesis: public RPCs cap eth_getLogs spans, so a bounded start keeps the
 * walk short. Zero (unset) means "from the beginning", which still works on RPCs
 * without a span cap.
 */
export const DEPLOY_BLOCKS: Partial<Record<ChainId, bigint>> = {
	// Malformed input must degrade to "scan from genesis", not throw during module
	// evaluation and white-screen the whole app before React even mounts.
	[TARGET_CHAIN_ID]: (() => {
		try {
			return BigInt((viteEnv['VITE_DEPLOY_BLOCK'] ?? '0').trim());
		} catch {
			return 0n;
		}
	})(),
} as const;

export const getDeployBlock = (chainId: GoldVaultChainId | undefined): bigint =>
	(chainId && DEPLOY_BLOCKS[chainId]) || 0n;

/**
 * The Gold Stability Reserve. Returns undefined until VITE_STABILITY_RESERVE_ADDRESS
 * is a real deployment, which is the app-wide switch for the swap surface.
 */
export const getStabilityReserveContractConfig = (chainId: GoldVaultChainId | undefined) => {
	if (!chainId) return;
	const address = configuredAddress(STABILITY_RESERVE_ADDRESSES[chainId]);
	if (!address) return;
	return { address, abi: goldStabilityReserveAbi } as const;
};

/**
 * The on-chain list of open vaults. The liquidations page reads owners from it when the
 * API's owner index is unavailable. Undefined until
 * VITE_VAULT_REGISTRY_ADDRESS names a real deployment.
 */
export const getVaultRegistryContractConfig = (chainId: GoldVaultChainId | undefined) => {
	if (!chainId) return;
	const address = configuredAddress(VAULT_REGISTRY_ADDRESSES[chainId]);
	if (!address) return;
	return { address, abi: vaultRegistryAbi } as const;
};

export const getGoldOracleContractConfig = (chainId: GoldVaultChainId | undefined) => {
	if (!chainId) return;
	const address = configuredAddress(GOLD_ORACLE_ADDRESSES[chainId]);
	if (!address) return;
	return { address, abi: goldOracleAbi } as const;
};

export const getSurplusBufferContractConfig = (chainId: GoldVaultChainId | undefined) => {
	if (!chainId) return;
	const address = configuredAddress(SURPLUS_BUFFER_ADDRESSES[chainId]);
	if (!address) return;
	return { address, abi: surplusBufferAbi } as const;
};
