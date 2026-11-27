import { useMemo } from 'react';
import { useReadContracts } from 'wagmi';
import {
  erc20Abi,
  encodePacked,
  formatUnits,
  keccak256,
  zeroAddress,
  type Address,
} from 'viem';
import {
  GOLD_VAULT_ADDRESSES,
  SILO_FACTORY_ADDRESSES,
  GUSD_ADDRESSES,
  TARGET_CHAIN_ID,
  TOKEN_LIST,
  goldVaultAbi,
} from '@goldstandard/constants';
import { useGoldPrices } from './useGoldPrices';
import { getGoldOracleContractConfig, type GoldVaultChainId } from '@goldstandard/constants';

const PRECISION = 1_000_000; // GoldVault ratio precision (1e6 == 100%)

/** `error`: the contracts are deployed but the chain reads failed; the UI names that rather than reading as pre-launch. */
export type ProtocolStatus = 'loading' | 'pre-launch' | 'live' | 'error';

/**
 * Minimal SiloFactory surface for reserve accounting. Deposits are routed into
 * CREATE2 silo clones, so neither the vault nor the factory holds an ERC-20
 * balance; `totalCollateral` is the factory's own tally of what its silos hold.
 */
const siloFactoryStatsAbi = [
  {
    type: 'function',
    name: 'totalCollateral',
    stateMutability: 'view',
    inputs: [{ name: 'token', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'paused',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const;

export interface CollateralStat {
  symbol: string;
  name: string;
  image: string;
  address: Address;
  decimals: number;
  /** Live USD price of one collateral token. */
  priceUsd: number | undefined;
  /** 'oracle' when priced by GoldOracle (what the contracts compute); 'market' pre-launch. */
  priceSource: 'oracle' | 'market' | undefined;
  /** Raw collateral held by the protocol for this asset (token decimals). */
  balance: bigint | undefined;
  /** USD value of the held collateral, at the live price. */
  valueUsd: number | undefined;
  /** GUSD minted against this collateral type (18 decimals). */
  debt: bigint | undefined;
  /** On-chain minimum collateral ratio for this asset, as a percentage. */
  minRatioPercent: number | undefined;
  /** On-chain liquidation ratio for this asset, as a percentage. */
  liquidationRatioPercent: number | undefined;
  /** On-chain liquidation penalty for this asset, as a percentage. */
  liquidationPenaltyPercent: number | undefined;
  /** On-chain debt ceiling for this asset (18 decimals), 0 means unset. */
  debtCeiling: bigint | undefined;
  active: boolean | undefined;
}

export interface ProtocolStats {
  status: ProtocolStatus;
  /** True once the vault contract address has been configured (post-deploy). */
  isDeployed: boolean;
  isLoading: boolean;
  /** Total USD value of all gold collateral held by the protocol. */
  tvlUsd: number | undefined;
  /** Circulating GUSD supply (18 decimals). */
  gusdSupply: bigint | undefined;
  /** System backing ratio: collateral value / GUSD outstanding, as a percent. */
  backingRatioPercent: number | undefined;
  /** Whether the protocol is currently paused. */
  paused: boolean | undefined;
  /** GUSD peg target in USD (always 1). */
  pegTargetUsd: number;
  collaterals: CollateralStat[];
}

const TARGET_CHAIN = TARGET_CHAIN_ID;

/** Gold collateral assets that have an address on the target chain. */
const collateralTokens = TOKEN_LIST.filter(
  (t) => t.gold && !!t.addresses[TARGET_CHAIN]
);

function collateralId(token: Address): `0x${string}` {
  return keccak256(encodePacked(['address'], [token]));
}

/** The oracle reads made per collateral token, in this order, at the tail of the multicall. */
const ORACLE_READS = ['quoteValuationPrice', 'getValidatedPrice', 'getLastKnownPrice'] as const;

interface OracleRead {
  status: 'success' | 'failure';
  result?: unknown;
}

/**
 * The USD price a collateral's holdings are valued at, from its three oracle reads.
 * quoteValuationPrice is what the protocol itself values gold at: the
 * lower of the token's market feed and the gold price while both are healthy, so the TVL
 * and the backing ratio never count a token above gold. It answers zero when either feed
 * has stopped; the page then falls back to the validated market feed and, last, to the
 * oracle's last known price, as it did before. Pure and exported for tests.
 */
export function collateralValuationPrice(
  valuation: OracleRead | undefined,
  validated: OracleRead | undefined,
  lastKnown: OracleRead | undefined
): number | undefined {
  if (valuation?.status === 'success' && typeof valuation.result === 'bigint' && valuation.result > 0n) {
    return Number(valuation.result) / 1e8;
  }
  if (validated?.status === 'success') {
    const [price8, ok] = validated.result as readonly [bigint, boolean];
    if (ok && price8 > 0n) return Number(price8) / 1e8;
  }
  if (lastKnown?.status === 'success') {
    const price8 = lastKnown.result as bigint;
    if (price8 > 0n) return Number(price8) / 1e8;
  }
  return undefined;
}

/**
 * Protocol-wide, honest statistics for the marketing and transparency surfaces.
 *
 * Every figure is read from the live contract or the price API. Before the
 * contracts are deployed (the address is still the zero address) the hook
 * reports `pre-launch` and leaves protocol metrics undefined rather than
 * inventing numbers — the UI renders explicit pre-launch states instead.
 */
export function useProtocolStats(): ProtocolStats {
  const vaultAddress = GOLD_VAULT_ADDRESSES[TARGET_CHAIN];
  const siloFactoryRaw = SILO_FACTORY_ADDRESSES[TARGET_CHAIN];
  const siloFactoryAddress =
    siloFactoryRaw && siloFactoryRaw !== '0x0000000000000000000000000000000000000000'
      ? siloFactoryRaw
      : undefined;
  const gusdAddress = GUSD_ADDRESSES[TARGET_CHAIN];

  const isDeployed =
    !!vaultAddress &&
    vaultAddress !== zeroAddress &&
    vaultAddress.toLowerCase() !== zeroAddress;

  const gusdConfigured =
    !!gusdAddress && gusdAddress !== zeroAddress;

  const { paxg, xaut, isLoading: pricesLoading } = useGoldPrices();
  const priceFor = (symbol: string): number | undefined =>
    symbol === 'PAXG' ? paxg : symbol === 'XAUT' ? xaut : undefined;

  // Build the multicall: per collateral (balanceOf vault + collateralTypes),
  // plus GUSD totalSupply and the vault paused flag.
  const contracts = useMemo(() => {
    if (!isDeployed || !vaultAddress) return [];
    const calls: object[] = [];
    for (const token of collateralTokens) {
      const address = token.addresses[TARGET_CHAIN] as Address;
      // Collateral backing lives in TWO places. In the production topology the
      // vault routes deposits into SiloFactory silo clones for censorship
      // resistance, so balanceOf(vault) is ~0 and reading only that reported
      // "0 held / 0% backed" on the Proof-of-Reserves page while the protocol
      // was in fact fully collateralised. Read both and sum: the vault's own
      // balance (surplus collateral from liquidations, and the no-silo
      // topology) plus everything the factory accounts for across its silos.
      calls.push({
        chainId: TARGET_CHAIN_ID,
        address,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [vaultAddress],
      });
      calls.push({
        chainId: TARGET_CHAIN_ID,
        address: siloFactoryAddress ?? vaultAddress,
        abi: siloFactoryStatsAbi,
        functionName: siloFactoryAddress ? 'totalCollateral' : 'paused',
        args: siloFactoryAddress ? [address] : [],
      });
      calls.push({
        chainId: TARGET_CHAIN_ID,
        address: vaultAddress,
        abi: goldVaultAbi,
        functionName: 'collateralTypes',
        args: [collateralId(address)],
      });
    }
    calls.push({
      chainId: TARGET_CHAIN_ID,
      address: vaultAddress,
      abi: goldVaultAbi,
      functionName: 'paused',
    });
    if (gusdConfigured && gusdAddress) {
      calls.push({
        chainId: TARGET_CHAIN_ID,
        address: gusdAddress,
        abi: erc20Abi,
        functionName: 'totalSupply',
      });
    }
    // Appended LAST so the cursor arithmetic above is untouched: three oracle reads per
    // collateral. The proof-of-reserves numbers must be what the CONTRACTS compute, so
    // once the oracle is deployed every figure prices at quoteValuationPrice (see
    // collateralValuationPrice for the fallbacks), never at the market API. A page that says
    // "priced at the oracle" while showing CoinGecko was quoting a TVL and backing ratio
    // the protocol never produced whenever the feed and the market diverged.
    const oracleConfig = getGoldOracleContractConfig(TARGET_CHAIN_ID as GoldVaultChainId);
    if (oracleConfig) {
      for (const token of collateralTokens) {
        const address = token.addresses[TARGET_CHAIN] as Address;
        for (const functionName of ORACLE_READS) {
          calls.push({ chainId: TARGET_CHAIN_ID, ...oracleConfig, functionName, args: [address] });
        }
      }
    }
    return calls;
  }, [isDeployed, vaultAddress, siloFactoryAddress, gusdAddress, gusdConfigured]);

  const { data, isLoading: readsLoading, isError: readsError } = useReadContracts({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    contracts: contracts as any,
    query: { enabled: isDeployed, refetchInterval: 30_000 },
  });

  return useMemo(() => {
    const pegTargetUsd = 1;

    if (!isDeployed) {
      const collaterals: CollateralStat[] = collateralTokens.map((t) => ({
        symbol: t.symbol,
        name: t.name,
        image: t.image,
        address: t.addresses[TARGET_CHAIN] as Address,
        decimals: t.decimals,
        priceUsd: priceFor(t.symbol),
        priceSource: priceFor(t.symbol) !== undefined ? ('market' as const) : undefined,
        balance: undefined,
        valueUsd: undefined,
        debt: undefined,
        minRatioPercent: undefined,
        liquidationRatioPercent: undefined,
        liquidationPenaltyPercent: undefined,
        debtCeiling: undefined,
        active: undefined,
      }));
      return {
        status: 'pre-launch' as const,
        isDeployed: false,
        isLoading: pricesLoading,
        tvlUsd: undefined,
        gusdSupply: undefined,
        backingRatioPercent: undefined,
        paused: undefined,
        pegTargetUsd,
        collaterals,
      };
    }

    const results = data ?? [];
    const readsFailed = readsError || (!readsLoading && results.length === 0);
    const status: ProtocolStatus = readsFailed ? 'error' : readsLoading && results.length === 0 ? 'loading' : 'live';
    let cursor = 0;
    let tvlUsd = 0;
    let haveAnyValue = false;

    // Oracle reads sit at the tail: ORACLE_READS per collateral token.
    const oracleConfigured = !!getGoldOracleContractConfig(TARGET_CHAIN_ID as GoldVaultChainId);
    const perToken = ORACLE_READS.length;
    const oracleBase = results.length - (oracleConfigured ? collateralTokens.length * perToken : 0);
    const oraclePriceFor = (index: number): number | undefined => {
      if (!oracleConfigured) return undefined;
      const at = oracleBase + index * perToken;
      return collateralValuationPrice(results[at], results[at + 1], results[at + 2]);
    };

    const collaterals: CollateralStat[] = collateralTokens.map((t, tokenIndex) => {
      const address = t.addresses[TARGET_CHAIN] as Address;
      const balanceRes = results[cursor++];
      const siloBalanceRes = results[cursor++];
      const typeRes = results[cursor++];

      const vaultHeld =
        balanceRes && balanceRes.status === 'success'
          ? (balanceRes.result as bigint)
          : undefined;
      // Only counted when a silo factory is configured. NOTE: the factory does
      // not hold the tokens — its CLONES do — so this reads the factory's own
      // totalCollateral accounting rather than an ERC-20 balance.
      const siloHeld =
        siloFactoryAddress && siloBalanceRes && siloBalanceRes.status === 'success'
          ? (siloBalanceRes.result as bigint)
          : undefined;
      const balance =
        vaultHeld === undefined && siloHeld === undefined
          ? undefined
          : (vaultHeld ?? 0n) + (siloHeld ?? 0n);

      // collateralTypes => [token, minRatio, liquidationRatio, penalty, debtCeiling, totalDebt, active]
      const typeTuple =
        typeRes && typeRes.status === 'success'
          ? (typeRes.result as readonly [
              Address,
              bigint,
              bigint,
              bigint,
              bigint,
              bigint,
              boolean
            ])
          : undefined;

      const oraclePrice = oraclePriceFor(tokenIndex);
      const priceUsd = oraclePrice ?? priceFor(t.symbol);
      const priceSource: 'oracle' | 'market' | undefined =
        oraclePrice !== undefined ? 'oracle' : priceUsd !== undefined ? 'market' : undefined;
      const valueUsd =
        balance !== undefined && priceUsd !== undefined
          ? Number(formatUnits(balance, t.decimals)) * priceUsd
          : undefined;
      if (valueUsd !== undefined) {
        tvlUsd += valueUsd;
        haveAnyValue = true;
      }

      return {
        symbol: t.symbol,
        name: t.name,
        image: t.image,
        address,
        decimals: t.decimals,
        priceUsd,
        priceSource,
        balance,
        valueUsd,
        debt: typeTuple ? typeTuple[5] : undefined,
        minRatioPercent: typeTuple
          ? (Number(typeTuple[1]) / PRECISION) * 100
          : undefined,
        liquidationRatioPercent: typeTuple
          ? (Number(typeTuple[2]) / PRECISION) * 100
          : undefined,
        liquidationPenaltyPercent: typeTuple
          ? (Number(typeTuple[3]) / PRECISION) * 100
          : undefined,
        debtCeiling: typeTuple ? typeTuple[4] : undefined,
        active: typeTuple ? typeTuple[6] : undefined,
      };
    });

    const pausedRes = results[cursor++];
    const paused =
      pausedRes && pausedRes.status === 'success'
        ? (pausedRes.result as boolean)
        : undefined;

    let gusdSupply: bigint | undefined;
    if (gusdConfigured) {
      const supplyRes = results[cursor++];
      gusdSupply =
        supplyRes && supplyRes.status === 'success'
          ? (supplyRes.result as bigint)
          : undefined;
    }

    const gusdSupplyUsd =
      gusdSupply !== undefined
        ? Number(formatUnits(gusdSupply, 18)) * pegTargetUsd
        : undefined;

    const backingRatioPercent =
      gusdSupplyUsd !== undefined && gusdSupplyUsd > 0 && haveAnyValue
        ? (tvlUsd / gusdSupplyUsd) * 100
        : undefined;

    return {
      status,
      isDeployed: true,
      isLoading: readsLoading || pricesLoading,
      tvlUsd: haveAnyValue ? tvlUsd : undefined,
      gusdSupply,
      backingRatioPercent,
      paused,
      pegTargetUsd,
      collaterals,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, isDeployed, gusdConfigured, readsLoading, readsError, pricesLoading, paxg, xaut]);
}
