import { formatGwei } from 'viem';

// Fee ceilings. The RPC's fee estimate is the input; a compromised or
// merely spiking endpoint cannot make the keeper pay more than the operator
// allowed. The priority fee is clamped, since paying less priority only delays
// inclusion. viem's max fee estimate is the base fee padded by 1.2 plus the tip,
// so comparing it with the ceiling refused sends from a base fee near 122.5 gwei
// under a 150 gwei ceiling. A max
// fee above its ceiling is therefore clamped to the ceiling while the current base
// fee plus the clamped tip still fits under it, which keeps the transaction
// includable at today's base fee and never pays more than the ceiling; past that
// it is skipped with a reason and retried next tick, because a transaction whose
// max fee is below the base fee is rejected by the node anyway. A send clamped this
// way has less room for a rising base fee, so it may stick, and the stuck nonce is
// then replaced or reported as for any other send.

export interface FeeEstimate {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

export interface FeeCeilings {
  maxFeePerGasWei: bigint;
  maxPriorityFeePerGasWei: bigint;
}

export type FeeDecision =
  | { ok: true; fees: FeeEstimate }
  | { ok: false; reason: string };

const min = (left: bigint, right: bigint): bigint => (left < right ? left : right);

/**
 * The fees a send goes out with. `baseFeePerGas` is the latest block's base fee, which the
 * caller reads only when the estimate passes the max fee ceiling; without it an estimate
 * above the ceiling is refused, as before.
 */
export const boundFees = (
  estimate: FeeEstimate,
  ceilings: FeeCeilings,
  baseFeePerGas?: bigint
): FeeDecision => {
  const clampedPriority = min(estimate.maxPriorityFeePerGas, ceilings.maxPriorityFeePerGasWei);
  if (estimate.maxFeePerGas > ceilings.maxFeePerGasWei) {
    if (baseFeePerGas !== undefined && baseFeePerGas + clampedPriority <= ceilings.maxFeePerGasWei) {
      return {
        ok: true,
        fees: { maxFeePerGas: ceilings.maxFeePerGasWei, maxPriorityFeePerGas: clampedPriority },
      };
    }
    const baseFee =
      baseFeePerGas === undefined ? '' : ` (base fee ${formatGwei(baseFeePerGas)} gwei plus the tip)`;
    return {
      ok: false,
      reason: `network max fee ${formatGwei(estimate.maxFeePerGas)} gwei${baseFee} exceeds the KEEPER_MAX_FEE_GWEI ceiling of ${formatGwei(ceilings.maxFeePerGasWei)} gwei`,
    };
  }
  const maxPriorityFeePerGas = min(clampedPriority, estimate.maxFeePerGas);
  return { ok: true, fees: { maxFeePerGas: estimate.maxFeePerGas, maxPriorityFeePerGas } };
};

/**
 * Same-nonce replacement. A node accepts a replacement only when
 * both fees rise by its price bump over the transaction it displaces, 10% on geth; 12.5% is
 * the common safe figure and clears every client in use.
 */
export const REPLACEMENT_BUMP_BPS = 1_250n;
const BPS = 10_000n;

const max = (left: bigint, right: bigint): bigint => (left > right ? left : right);

/** `value` raised by the replacement bump, rounded up so the bump is never a wei short. */
const bumped = (value: bigint): bigint =>
  (value * (BPS + REPLACEMENT_BUMP_BPS) + BPS - 1n) / BPS;

/**
 * Fees for the transaction that replaces a stuck one. With the fees the stuck transaction
 * was sent with known, each is raised by the bump over them and never set below the fresh
 * estimate (its priority clamped to the ceiling as for any send), so the replacement is
 * both accepted and includable. After a restart those fees are unknown, and the fresh
 * estimate is bumped instead; a node that still calls that underpriced refuses it, and the
 * caller bumps again over what it offered. Never above the max fee ceiling, and at most one
 * bump above the priority ceiling: every ordinary send has its priority clamped to that
 * ceiling, so the replacement of the usual stuck transaction needs exactly one bump over it,
 * and without that allowance no replacement was ever possible in the common case. A replacement
 * that would need more is refused with the reason, and the
 * operator decides.
 */
export const replacementFees = (
  previous: FeeEstimate | undefined,
  estimate: FeeEstimate,
  ceilings: FeeCeilings
): FeeDecision => {
  const freshPriority = min(estimate.maxPriorityFeePerGas, ceilings.maxPriorityFeePerGasWei);
  const maxPriorityFeePerGas =
    previous === undefined
      ? bumped(freshPriority)
      : max(bumped(previous.maxPriorityFeePerGas), freshPriority);
  const maxFee =
    previous === undefined
      ? bumped(estimate.maxFeePerGas)
      : max(bumped(previous.maxFeePerGas), estimate.maxFeePerGas);
  const maxFeePerGas = max(maxFee, maxPriorityFeePerGas);
  if (maxFeePerGas > ceilings.maxFeePerGasWei) {
    return {
      ok: false,
      reason: `a valid replacement needs a max fee of ${formatGwei(maxFeePerGas)} gwei, above the KEEPER_MAX_FEE_GWEI ceiling of ${formatGwei(ceilings.maxFeePerGasWei)} gwei`,
    };
  }
  if (maxPriorityFeePerGas > bumped(ceilings.maxPriorityFeePerGasWei)) {
    return {
      ok: false,
      reason: `a valid replacement needs a priority fee of ${formatGwei(maxPriorityFeePerGas)} gwei, above one bump over the KEEPER_MAX_PRIORITY_FEE_GWEI ceiling of ${formatGwei(ceilings.maxPriorityFeePerGasWei)} gwei`,
    };
  }
  return { ok: true, fees: { maxFeePerGas, maxPriorityFeePerGas } };
};
