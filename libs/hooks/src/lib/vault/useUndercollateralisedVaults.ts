import { useQuery } from '@tanstack/react-query';
import { readContracts } from '@wagmi/core';
import { useConfig, useReadContracts } from 'wagmi';
import { encodePacked, keccak256, type Address } from 'viem';
import {
	getGoldOracleContractConfig,
	getGoldVaultContractConfig,
	goldOracleAbi,
	goldVaultAbi,
	type GoldVaultChainId,
} from '@goldstandard/constants';
import { useMemo } from 'react';
import { ratioToPercent, resolveCollateralRatio, type LiveQuote, type RatioSource } from './liveRatio';

export interface UndercollateralisedVault {
	owner: Address;
	collateralToken: Address;
	collateralAmount: bigint;
	/** Principal only, as the vault stores it. */
	debtAmount: bigint;
	/**
	 * Fee-inclusive debt, which is what a liquidation actually settles. Filling the form
	 * with the principal made every "full" liquidation a partial one that left a dust
	 * position behind; the contract now refuses that, so the figure to offer is
	 * this one.
	 */
	currentDebt: bigint;
	ratio: bigint;
	ratioPercent: number;
	/** 'live' at quoteTokenPrice as the keeper judges it; 'stored' when that quote was refused. */
	priceSource: RatioSource;
}

/**
 * Owners per batch of reads. Each owner costs four calls, and the batches run one after
 * another, so a large owner list never becomes one unbounded multicall (up to
 * 50,000 indexed owners used to go out as 150,000 calls in one request).
 */
export const OWNERS_PER_BATCH = 100;

/** The four per-owner reads, in this order. */
const OWNER_READS = ['vaults', 'getVaultCurrentDebt', 'getLiquidationPrice', 'getCollateralisationRatio'] as const;

/** An indebted vault as read from the chain, before any price decides its eligibility. */
export interface IndebtedVault {
	owner: Address;
	collateralToken: Address;
	collateralAmount: bigint;
	debtAmount: bigint;
	currentDebt: bigint;
	liquidationPrice: bigint;
	storedRatio: bigint;
}

interface ReadResult {
	status: 'success' | 'failure';
	result?: unknown;
}

/** Splits a list into consecutive batches of at most `size`. Pure. */
export function inBatches<T>(items: readonly T[], size: number): T[][] {
	const batches: T[][] = [];
	for (let start = 0; start < items.length; start += size) batches.push(items.slice(start, start + size));
	return batches;
}

/**
 * The indebted vaults among one batch of owners, from that batch's reads in OWNER_READS
 * order. An owner with any failed read is left out; a batch whose reads all failed throws,
 * because an unreachable RPC must read as an error and never as "nothing to liquidate".
 * Pure and exported for tests.
 */
export function indebtedVaultsFrom(owners: readonly Address[], results: readonly ReadResult[]): IndebtedVault[] {
	if (owners.length > 0 && results.every((result) => result.status !== 'success')) {
		throw new Error('Vault reads failed for a whole batch of owners');
	}
	const vaults: IndebtedVault[] = [];
	owners.forEach((owner, i) => {
		const reads = results.slice(i * OWNER_READS.length, (i + 1) * OWNER_READS.length);
		if (reads.length !== OWNER_READS.length || reads.some((read) => read.status !== 'success')) return;
		const [vault, currentDebt, liquidationPrice, storedRatio] = reads.map((read) => read.result);
		const [collateralToken, collateralAmount, debtAmount] = vault as readonly [Address, bigint, bigint];
		if (debtAmount > 0n) {
			vaults.push({
				owner,
				collateralToken,
				collateralAmount,
				debtAmount,
				currentDebt: currentDebt as bigint,
				liquidationPrice: liquidationPrice as bigint,
				storedRatio: storedRatio as bigint,
			});
		}
	});
	return vaults;
}

/** A cheap fingerprint of the owner list for the query key, instead of every address. */
function ownersFingerprint(owners: readonly Address[]): string {
	let hash = 0x811c9dc5;
	for (const owner of owners) {
		for (let i = 0; i < owner.length; i++) {
			hash ^= owner.charCodeAt(i);
			hash = Math.imul(hash, 0x01000193) >>> 0;
		}
	}
	return `${owners.length}:${hash.toString(16)}`;
}

/**
 * Whether a vault is eligible and at what ratio, from its collateral's liquidation ratio and
 * live quote. Eligible exactly when the quote is below the vault's
 * liquidation price, which is the keeper's test and the contract's; the stored-price view
 * decides only for a token whose quote was refused. Pure and exported for tests.
 */
export function judgeVault(
	vault: IndebtedVault,
	liquidationRatio: bigint,
	quote: LiveQuote
): UndercollateralisedVault | undefined {
	const resolved = resolveCollateralRatio({
		storedRatio: vault.storedRatio,
		liquidationPrice: vault.liquidationPrice,
		liquidationRatio,
		quote,
	});
	if (resolved.ratio === undefined || resolved.ratio >= liquidationRatio) return undefined;
	return {
		owner: vault.owner,
		collateralToken: vault.collateralToken,
		collateralAmount: vault.collateralAmount,
		debtAmount: vault.debtAmount,
		currentDebt: vault.currentDebt,
		ratio: resolved.ratio,
		ratioPercent: ratioToPercent(resolved.ratio),
		priceSource: resolved.source ?? 'stored',
	};
}

/**
 * The vaults among `knownVaultOwners` that are liquidatable now, worst first.
 *
 * Owners come from the API's index or, when that is unavailable, the on-chain registry; the
 * vault reads go out in batches of OWNERS_PER_BATCH, one batch after another. Eligibility
 * is decided at the live liquidation quote of each collateral, as the keeper decides it.
 */
export function useUndercollateralisedVaults(
	chainId: GoldVaultChainId | undefined,
	knownVaultOwners: Address[]
) {
	const wagmiConfig = useConfig();
	const config = getGoldVaultContractConfig(chainId);
	const oracle = getGoldOracleContractConfig(chainId);
	const fingerprint = useMemo(() => ownersFingerprint(knownVaultOwners), [knownVaultOwners]);

	const owners = useQuery({
		queryKey: ['undercollateralisedVaultReads', chainId, config?.address, fingerprint],
		queryFn: async (): Promise<IndebtedVault[]> => {
			if (!config) return [];
			const indebted: IndebtedVault[] = [];
			for (const batch of inBatches(knownVaultOwners, OWNERS_PER_BATCH)) {
				const results = await readContracts(wagmiConfig, {
					contracts: batch.flatMap((owner) =>
						OWNER_READS.map((functionName) => ({
							address: config.address,
							abi: goldVaultAbi,
							functionName,
							args: [owner] as const,
							chainId,
						}))
					),
				});
				indebted.push(...indebtedVaultsFrom(batch, results as readonly ReadResult[]));
			}
			return indebted;
		},
		enabled: !!config && knownVaultOwners.length > 0,
		refetchInterval: 30_000,
	});
	const indebted = useMemo(() => owners.data ?? [], [owners.data]);

	// The vault liquidates against each collateral's own liquidationRatio, which
	// governance can move through the timelock, at that collateral's live quote.
	const collateralTokens = useMemo(
		() => [...new Set(indebted.map(vault => vault.collateralToken.toLowerCase() as Address))],
		[indebted]
	);

	// One collateralTypes read per token, then one quoteTokenPrice read per token.
	const tokenContracts = useMemo(() => {
		if (!config) return [];
		const params = collateralTokens.map(token => ({
			address: config.address,
			abi: goldVaultAbi,
			functionName: 'collateralTypes' as const,
			args: [keccak256(encodePacked(['address'], [token]))] as const,
			chainId,
		}));
		const quotes = oracle
			? collateralTokens.map(token => ({
				address: oracle.address,
				abi: goldOracleAbi,
				functionName: 'quoteTokenPrice' as const,
				args: [token] as const,
				chainId,
			}))
			: [];
		return [...params, ...quotes];
	}, [config, oracle, collateralTokens, chainId]);

	const {
		data: tokenData,
		isLoading: isTokenLoading,
		isError: isTokenError,
	} = useReadContracts({
		contracts: tokenContracts,
		query: {
			enabled: tokenContracts.length > 0,
			refetchInterval: 30_000,
		},
	});

	const { undercollateralised, judgedAtStoredPrice } = useMemo(() => {
		// collateralTypes => [token, minRatio, liquidationRatio, penalty, debtCeiling, totalDebt, active]
		const liquidationRatios = new Map<Address, bigint>();
		const quotes = new Map<Address, LiveQuote>();
		collateralTokens.forEach((token, i) => {
			const params = tokenData?.[i] as ReadResult | undefined;
			if (params?.status === 'success') {
				const liquidationRatio = (params.result as readonly unknown[])[2];
				if (typeof liquidationRatio === 'bigint' && liquidationRatio > 0n) liquidationRatios.set(token, liquidationRatio);
			}
			if (!tokenData) return;
			// Without a configured oracle there is no quote to read: the stored view decides.
			const quote = oracle ? (tokenData[collateralTokens.length + i] as ReadResult | undefined) : undefined;
			if (quote?.status === 'success' && typeof quote.result === 'bigint' && quote.result > 0n) {
				quotes.set(token, { price8: quote.result });
			} else if (!oracle || quote?.status === 'failure') {
				quotes.set(token, { refused: true });
			}
		});

		// A collateral whose ratio could not be read is left out rather than judged
		// against a guess: listing a vault the contract then refuses wastes a liquidator's gas.
		const eligible = indebted
			.flatMap(vault => {
				const token = vault.collateralToken.toLowerCase() as Address;
				const liquidationRatio = liquidationRatios.get(token);
				if (liquidationRatio === undefined) return [];
				const judged = judgeVault(vault, liquidationRatio, quotes.get(token));
				return judged ? [judged] : [];
			})
			// Sort by ratio ascending (worst first = best opportunity)
			.sort((a, b) => (a.ratio < b.ratio ? -1 : a.ratio > b.ratio ? 1 : 0));
		return {
			undercollateralised: eligible,
			judgedAtStoredPrice: [...quotes.values()].some((quote) => quote !== undefined && 'refused' in quote),
		};
	}, [indebted, collateralTokens, tokenData, oracle]);

	return {
		undercollateralised,
		/** True when a collateral's live quote was refused and its vaults were judged at the stored price. */
		judgedAtStoredPrice,
		isLoading: owners.isLoading || (tokenContracts.length > 0 && isTokenLoading),
		isError: owners.isError || isTokenError,
	};
}
