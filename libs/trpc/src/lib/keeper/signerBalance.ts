import { KEEPER_EVENTS } from './alerts';
import type { KeeperConfig } from './config';
import { LIQUIDATE_VIA_POOL_GAS_FLOOR } from './liquidationConstants';
import type { KeeperJobDeps } from './ports';

/** Below this many of the smallest pool liquidation, in ETH at the fee ceiling, the watch warns. */
export const SIGNER_BALANCE_WARN_LIQUIDATIONS = 3n;

/**
 * Signer balance watch: warns before the keeper wallet runs out of gas money.
 *
 * A node refuses a transaction whose gas limit times its fee cap exceeds the sender's
 * balance, so an empty wallet fails every liquidation in simulation while the pool and the
 * oracle look healthy. The yardstick is the smallest pool liquidation the keeper sends: its
 * gas floor at the configured fee ceiling, the most the keeper will pay per unit of gas. The
 * keeper offers the network's fee, so below that line a liquidation is refused once the
 * network fee nears the ceiling, not before; and a vault spanning many silos is sent with
 * more gas than the floor, so it can be refused while the wallet still holds more than one
 * yardstick. The watch only reports: it never sends and never holds a send back. A balance
 * that cannot be read, because the read failed or because a keeper that signs was wired
 * without a balance read, is left to the scheduler, which logs keeper.job-error, so an
 * unreadable balance never passes for a healthy one.
 */
export const runSignerBalanceWatch = async (
  deps: KeeperJobDeps,
  config: KeeperConfig
): Promise<void> => {
  const { read, tx, log } = deps;
  // A dry run or a keeper without a key sends nothing, so there is no wallet to watch.
  if (tx === undefined) return;
  if (read.getBalance === undefined) {
    throw new Error('The keeper signs but its read client has no balance read, so the signer balance is not watched.');
  }

  const balanceWei = await read.getBalance(tx.account);
  const liquidationCostWei = LIQUIDATE_VIA_POOL_GAS_FLOOR * config.maxFeePerGasWei;
  if (balanceWei >= liquidationCostWei * SIGNER_BALANCE_WARN_LIQUIDATIONS) return;

  const fields = {
    account: tx.account,
    balanceWei,
    liquidationCostWei,
    // The fee ceiling is validated as positive, so the cost is never zero.
    liquidationsCovered: balanceWei / liquidationCostWei,
  };
  if (balanceWei < liquidationCostWei) {
    log.error(KEEPER_EVENTS.signerBalanceInsufficient, fields);
    return;
  }
  log.warn(KEEPER_EVENTS.signerBalanceLow, fields);
};
