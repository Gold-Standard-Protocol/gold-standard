import type { Address } from 'viem';
import { erc20KeeperAbi, goldVaultKeeperAbi } from './abis';
import { KEEPER_EVENTS } from './alerts';
import type { KeeperConfig } from './config';
import { describeError, expectBigInt } from './decode';
import { LIQUIDATION_JOB as JOB } from './liquidationConstants';
import { sizeDirectPartial } from './liquidationSizing';
import type { KeeperJobDeps, KeeperTxSender } from './ports';

/** Allowance and balance headroom over the debt read now, for fee accrued by inclusion. */
const APPROVAL_HEADROOM_BPS = 100n;

/**
 * What the keeper wallet must hold to liquidate `debt` from its own GSUSD: the debt, 1%
 * headroom for the fee that accrues before inclusion and one wei. The readiness preflight
 * measures the wallet against the same figure, so it never calls armed a path that would
 * answer 'unfunded'.
 */
export const directLiquidationFloat = (debt: bigint): bigint =>
  debt + (debt * APPROVAL_HEADROOM_BPS) / 10_000n + 1n;

export type ReceiptOutcome =
  | { status: 'success' }
  | { status: 'reverted' }
  /** The sender cannot wait for receipts, so nothing is known beyond the broadcast. */
  | { status: 'unobserved' }
  /** The wait threw (a timeout, a dropped connection): mined, reverted or pending. */
  | { status: 'unknown'; reason: string };

/**
 * Read the receipt of `hash` when the sender can. A wait that throws is not a revert:
 * the transaction may still mine, so callers must neither release what it committed
 * nor send anything that competes with it.
 */
export const confirmReceipt = async (
  tx: KeeperTxSender,
  hash: `0x${string}`
): Promise<ReceiptOutcome> => {
  if (tx.waitForReceipt === undefined) {
    return { status: 'unobserved' };
  }
  try {
    const receipt = await tx.waitForReceipt(hash);
    return { status: receipt.status };
  } catch (error) {
    return { status: 'unknown', reason: describeError(error) };
  }
};

/** Log a broadcast whose receipt could not be read, with the hash for a human to check. */
export const logOutcomeUnknown = (
  deps: KeeperJobDeps,
  owner: Address,
  functionName: string,
  hash: `0x${string}`,
  reason: string
): void => {
  deps.log.error(KEEPER_EVENTS.txOutcomeUnknown, {
    job: JOB,
    owner,
    functionName,
    hash,
    reason,
  });
};

/**
 * Every direct liquidation the keeper can send. apps/keeper sizes gas per function name,
 * and a name missing there falls to the 2M default, below a large multi-silo seizure, so
 * a spec there checks each of these has its own bounds.
 */
export const DIRECT_LIQUIDATION_FUNCTIONS = ['liquidate', 'emergencyLiquidate'] as const;

export type DirectLiquidationFunction = (typeof DIRECT_LIQUIDATION_FUNCTIONS)[number];

/**
 * What the direct path needs to size a partial when the wallet cannot fund the whole debt.
 * A caller that leaves it out gets the full liquidation or nothing, as before.
 */
export interface DirectPartialTerms {
  /** vaults().debtAmount: the principal a partial retires pro rata. */
  principal: bigint;
  /** Underwater at the price the seizure is sized at: the vault refuses any partial. */
  fullOnly: boolean;
  /** GoldVault.minDebt as read from the chain; undefined sizes no partial. */
  minDebt: bigint | undefined;
}

export type DirectOutcome =
  /** KEEPER_ENABLE_DIRECT is off. */
  | 'disabled'
  /** The wallet cannot cover the debt plus headroom, and no valid partial exists for it. */
  | 'unfunded'
  /** Nothing liquidated: the approval failed, or the liquidation failed in simulation or on chain. */
  | 'failed'
  /** Broadcast; mined successfully, or the sender cannot say. */
  | 'sent'
  /** Broadcast, but the receipt of the approval or the liquidation could not be read. */
  | 'unknown';

/**
 * A failed liquidation leaves the freshly granted allowance outstanding; revoke it
 * best effort so no spend authority lingers. A revoke that fails is logged, never thrown.
 *
 * The revoke waits for its receipt like every other keeper send.
 * Left pending, its nonce made the sender refuse every later vault of the same tick.
 */
const revokeAllowance = async (
  deps: KeeperJobDeps,
  config: KeeperConfig,
  tx: KeeperTxSender,
  owner: Address
): Promise<void> => {
  const logRevokeFailure = (reason: string, hash?: `0x${string}`): void => {
    deps.log.error(KEEPER_EVENTS.txFailed, {
      job: JOB,
      owner,
      functionName: 'approve-revoke',
      ...(hash === undefined ? {} : { hash }),
      reason,
    });
  };
  try {
    const revoke = await tx.simulateAndSend({
      address: config.gsusdAddress,
      abi: erc20KeeperAbi,
      functionName: 'approve',
      args: [config.goldVaultAddress, 0n],
    });
    if (!revoke.ok) {
      logRevokeFailure(revoke.reason);
      return;
    }
    const receipt = await confirmReceipt(tx, revoke.hash);
    if (receipt.status === 'reverted') {
      logRevokeFailure('reverted on chain after passing simulation', revoke.hash);
    } else if (receipt.status === 'unknown') {
      logOutcomeUnknown(deps, owner, 'approve-revoke', revoke.hash, receipt.reason);
    }
  } catch (error) {
    logRevokeFailure(describeError(error));
  }
};

/**
 * Approve the vault for the debt plus headroom when the allowance falls short, and wait
 * for the approval to mine. Returns undefined when the liquidation may go ahead.
 */
const ensureAllowance = async (
  deps: KeeperJobDeps,
  config: KeeperConfig,
  tx: KeeperTxSender,
  owner: Address,
  required: bigint
): Promise<DirectOutcome | undefined> => {
  const allowance = expectBigInt(
    await deps.read.readContract({
      address: config.gsusdAddress,
      abi: erc20KeeperAbi,
      functionName: 'allowance',
      args: [tx.account, config.goldVaultAddress],
    }),
    'allowance'
  );
  if (allowance >= required) {
    return undefined;
  }
  const approval = await tx.simulateAndSend({
    address: config.gsusdAddress,
    abi: erc20KeeperAbi,
    functionName: 'approve',
    args: [config.goldVaultAddress, required],
  });
  if (!approval.ok) {
    deps.log.error(KEEPER_EVENTS.txFailed, {
      job: JOB,
      owner,
      functionName: 'approve',
      reason: approval.reason,
    });
    return 'failed';
  }
  deps.log.info(KEEPER_EVENTS.txSent, {
    job: JOB,
    functionName: 'approve',
    hash: approval.hash,
  });
  // The liquidation is simulated against the latest block, where a pending
  // approval has not landed yet: without this wait it saw the old allowance,
  // failed, and the revoke undid the approval, every tick.
  const receipt = await confirmReceipt(tx, approval.hash);
  if (receipt.status === 'reverted') {
    deps.log.error(KEEPER_EVENTS.approvalReverted, {
      job: JOB,
      owner,
      hash: approval.hash,
    });
    return 'failed';
  }
  if (receipt.status === 'unknown') {
    logOutcomeUnknown(deps, owner, 'approve', approval.hash, receipt.reason);
    return 'unknown';
  }
  return undefined;
};

/**
 * Liquidate from the keeper wallet's own GSUSD: GoldVault.liquidate normally, or
 * emergencyLiquidate while the oracle or the vault is paused. Opt in twice over:
 * KEEPER_ENABLE_DIRECT must be on and the wallet must cover the debt plus headroom.
 *
 * A wallet that cannot cover that sends the largest partial the vault accepts instead, when
 * the caller supplies `partial` and one exists: the vault is
 * not underwater, the partial leaves at least minDebt of principal and is itself at least
 * minDebt (sizeDirectPartial, the pool path's rule). The partial is approved exactly, since
 * liquidate pulls exactly the amount asked, simulated like every send and announced with
 * vault.partial-direct-liquidation, which carries the debt left uncovered. With no valid
 * partial the answer stays 'unfunded'.
 *
 * Where the sender can wait, the liquidation receipt is read: a mined
 * revert is reported and the allowance revoked like a simulation failure; an unreadable
 * receipt is reported as an unknown outcome and the allowance kept, since the
 * liquidation may still mine and needs it.
 */
export const attemptDirectLiquidation = async (
  deps: KeeperJobDeps,
  config: KeeperConfig,
  tx: KeeperTxSender,
  owner: Address,
  debt: bigint,
  functionName: DirectLiquidationFunction = 'liquidate',
  partial?: DirectPartialTerms
): Promise<DirectOutcome> => {
  if (!config.enableDirect) {
    return 'disabled';
  }
  // Operator-pinned: the GSUSD address is never learned from the RPC,
  // so a compromised endpoint cannot redirect the keeper's approvals.
  const balance = expectBigInt(
    await deps.read.readContract({
      address: config.gsusdAddress,
      abi: erc20KeeperAbi,
      functionName: 'balanceOf',
      args: [tx.account],
    }),
    'balanceOf'
  );
  // liquidate(owner, 0) pulls the debt as it stands at inclusion, a little above the
  // figure read a block ago; an exact approval was always one block of fee short.
  const fullFloat = directLiquidationFloat(debt);
  const funded = balance >= fullFloat;
  const partialDebt =
    funded || partial === undefined || partial.fullOnly
      ? undefined
      : sizeDirectPartial(debt, partial.principal, balance, partial.minDebt);
  if (!funded && partialDebt === undefined) {
    // Opt-in by funding: a wallet that covers neither the debt nor a valid partial means
    // watch and alert only.
    return 'unfunded';
  }
  // A full liquidation passes 0 and is approved with headroom; a partial pulls exactly the
  // amount asked, so it is approved exactly and leaves no allowance behind.
  const debtToRepay = partialDebt ?? 0n;
  const required = partialDebt ?? fullFloat;
  const blocked = await ensureAllowance(deps, config, tx, owner, required);
  if (blocked !== undefined) {
    return blocked;
  }
  const result = await tx.simulateAndSend({
    address: config.goldVaultAddress,
    abi: goldVaultKeeperAbi,
    functionName,
    args: [owner, debtToRepay],
  });
  if (!result.ok) {
    deps.log.error(KEEPER_EVENTS.txFailed, {
      job: JOB,
      owner,
      functionName,
      reason: result.reason,
    });
    await revokeAllowance(deps, config, tx, owner);
    return 'failed';
  }
  deps.log.info(KEEPER_EVENTS.txSent, {
    job: JOB,
    owner,
    functionName,
    hash: result.hash,
  });
  if (partialDebt !== undefined) {
    deps.log.warn(KEEPER_EVENTS.vaultPartialDirectLiquidation, {
      job: JOB,
      owner,
      functionName,
      hash: result.hash,
      debt,
      repaying: partialDebt,
      uncoveredDebt: debt - partialDebt,
      keeperGsusdBalance: balance,
      requiredKeeperGsusd: fullFloat,
      detail:
        'the keeper wallet cannot cover the whole debt, so it sent the largest partial the vault accepts; the uncovered debt stays in the vault until the wallet is refilled, the pool can take it or someone else liquidates it',
    });
  }
  const receipt = await confirmReceipt(tx, result.hash);
  if (receipt.status === 'reverted') {
    deps.log.error(KEEPER_EVENTS.txFailed, {
      job: JOB,
      owner,
      functionName,
      hash: result.hash,
      reason: 'reverted on chain after passing simulation',
    });
    await revokeAllowance(deps, config, tx, owner);
    return 'failed';
  }
  if (receipt.status === 'unknown') {
    logOutcomeUnknown(deps, owner, functionName, result.hash, receipt.reason);
    return 'unknown';
  }
  deps.log.info(KEEPER_EVENTS.vaultLiquidatedDirect, {
    job: JOB,
    owner,
    hash: result.hash,
    debt,
    repaid: partialDebt ?? debt,
  });
  return 'sent';
};
