import { useReadContract } from 'wagmi';
import { keccak256, encodePacked, type Address } from 'viem';
import {
  getGoldVaultContractConfig,
  goldVaultAbi,
  type GoldVaultChainId,
} from '@goldstandard/constants';

/** GoldVault.PRECISION — ratios are 1e6 fixed point (1_300_000 = 130%). */
const PRECISION = 1_000_000;

export interface CollateralParams {
  /** Minimum collateralisation ratio to mint, as a percentage (e.g. 130). */
  minRatioPercent: number | undefined;
  /** Ratio below which the vault can be liquidated, as a percentage (e.g. 110). */
  liquidationRatioPercent: number | undefined;
  /** Liquidation penalty as a percentage (e.g. 5). */
  liquidationPenaltyPercent: number | undefined;
  debtCeiling: bigint | undefined;
  totalDebt: bigint | undefined;
  active: boolean | undefined;
  isLoading: boolean;
}

/**
 * Live risk parameters for one collateral, read from the vault.
 *
 * These were previously hardcoded as `minRatio: 150, liquidationRatio: 110` in every
 * vault form. They are governance-settable per collateral via `updateCollateralRatios` and
 * `setDebtCeiling`, so any change (moving the mint floor to 130%, for example) would have
 * left the UI quoting limits the contract does not enforce: refusing mints the protocol
 * would accept and drawing the liquidation line in the wrong place. The contract is the
 * source of truth.
 */
export function useCollateralParams(
  chainId: GoldVaultChainId | undefined,
  collateralToken: Address | undefined
): CollateralParams {
  const config = getGoldVaultContractConfig(chainId);
  const collateralId = collateralToken
    ? keccak256(encodePacked(['address'], [collateralToken]))
    : undefined;

  const { data, isLoading } = useReadContract({
    ...config,
    abi: goldVaultAbi,
    functionName: 'collateralTypes',
    args: collateralId ? [collateralId] : undefined,
    query: {
      enabled: Boolean(config && collateralId),
      // Parameters move only through a 48h timelock, so this is deliberately slow.
      staleTime: 60_000,
    },
  });

  // collateralTypes => [token, minRatio, liquidationRatio, penalty, debtCeiling, totalDebt, active]
  const tuple = data as
    | readonly [Address, bigint, bigint, bigint, bigint, bigint, boolean]
    | undefined;

  const toPercent = (raw: bigint | undefined): number | undefined =>
    raw === undefined ? undefined : Number(raw) / (PRECISION / 100);

  return {
    minRatioPercent: toPercent(tuple?.[1]),
    liquidationRatioPercent: toPercent(tuple?.[2]),
    liquidationPenaltyPercent: toPercent(tuple?.[3]),
    debtCeiling: tuple?.[4],
    totalDebt: tuple?.[5],
    active: tuple?.[6],
    isLoading,
  };
}
