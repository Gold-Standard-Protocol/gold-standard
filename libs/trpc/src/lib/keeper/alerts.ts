import type { KeeperLogger } from './ports';

// Stable event names: this is the alert surface that Tenderly, PagerDuty and
// log-based monitors key on. Renaming any value here is a breaking change to
// on-call tooling and must be treated like an API change.
export const KEEPER_EVENTS = {
  started: 'keeper.started',
  dryRun: 'keeper.dry-run',
  vaultLiquidatable: 'vault.liquidatable',
  vaultLiquidatedViaPool: 'vault.liquidated-via-pool',
  /** Info, once the receipt of a direct liquidation (full or partial) reports success. */
  vaultLiquidatedDirect: 'vault.liquidated-direct',
  vaultPoolUnderfunded: 'vault.pool-underfunded',
  /** Pool cannot cover the full debt; absorbing what it can and leaving a residual. */
  vaultPartialPoolAbsorb: 'vault.partial-pool-absorb',
  vaultNoOwners: 'vault.no-owners',
  /** One line per tick: how many owners were swept and how many carry debt. */
  vaultOwnerSweep: 'vault.owner-sweep',
  /** Owners whose debt could not be read this tick, after a retry and single reads. */
  vaultOwnersUnread: 'vault.owners-unread',
  /**
   * Warn, when the send is broadcast. The keeper wallet could not fund the whole debt of a
   * liquidatable vault, so the direct path sent the largest partial the vault accepts
   * (`repaying`); `uncoveredDebt` stays in the vault and `requiredKeeperGsusd` is what a full
   * liquidation would have needed. The receipt is reported as for any send. Refill the wallet.
   */
  vaultPartialDirectLiquidation: 'vault.partial-direct-liquidation',
  /** The vault accepts only a full liquidation and the pool cannot absorb it all. */
  vaultFullLiquidationRequired: 'vault.full-liquidation-required',
  /**
   * A transaction was not sent because the network fee exceeds the configured ceiling: the
   * current base fee plus the clamped tip passes it, or the base fee could not be read.
   */
  feeAboveCeiling: 'keeper.fee-above-ceiling',
  /** The approval was mined but reverted, so the liquidation was not attempted. */
  approvalReverted: 'keeper.approval-reverted',
  /**
   * No liquidation path is armed: the pool falls short of its yardstick (`poolYardstick`:
   * the debt ceiling while one caps the protocol, otherwise the largest vault debt of the
   * tick or minDebt) and the direct path is off or the keeper wallet holds less than minDebt
   * plus the direct headroom
   * (`minimumDirectFloat`), so dust in the wallet never counts as armed. A wallet that
   * cannot be measured, because minDebt has never been read, is not counted as armed either.
   */
  noLiquidationPath: 'keeper.no-liquidation-path',
  /**
   * Warn, every tick while it holds. GoldVault.minDebt could not be read (`reason`). The
   * keeper sizes partial pool absorbs and judges its direct float with the value it last
   * read (`lastKnownMinDebt`), never with a constant; with none since the process started
   * it sends no partial pool absorb, only whole ones, and reports the direct path as unarmed.
   */
  minDebtUnreadable: 'keeper.min-debt-unreadable',
  /** quoteTokenPrice unreachable, so the alert fell back to the stale ratio; nothing is sent. */
  liquidatabilityDegraded: 'vault.liquidatability-degraded',
  /** A vault holds debt with zero collateral: already bad debt, not liquidatable. */
  vaultBadDebt: 'vault.bad-debt',
  /**
   * lastKnownPrice, the record the vault's views and the dapp read (never a price a seizure
   * uses), has drifted from quoteTokenPrice by half the token's gold band or more (or was
   * never seeded); a getTokenPrice poke follows.
   */
  priceStale: 'oracle.price-stale',
  priceReanchored: 'oracle.price-reanchored',
  /**
   * Warn. C or G is unhealthy (stale, incomplete, no answer, a stamp ahead of the block or
   * unreadable). Every priced path for the token is refused meanwhile; `stoppedSources`
   * names the feeds and `detail` why.
   */
  oracleFeedInvalid: 'oracle.feed-invalid',
  /**
   * Warn, when it starts and then at most once per KEEPER_FEED_LATE_REPEAT_SECONDS while it
   * lasts. A feed that still prices (C or G, named by `source` and `feed`) has not written
   * for longer than its heartbeat plus a margin (`lateAfterSeconds`:
   * KEEPER_FEED_HEARTBEAT_SECONDS plus KEEPER_FEED_LATE_MARGIN_SECONDS). Nothing is refused
   * yet; `secondsUntilRefused` is what is left before the oracle's stalenessThreshold stops
   * every priced path for the token (oracle.price-refused). A second shape, without `source`
   * and `feed`, is sent once at start when the configured mark is not below the oracle's
   * stalenessThreshold: it carries `configuredLateAfterSeconds` and the fallback mark in use.
   */
  oracleFeedLate: 'oracle.feed-late',
  /**
   * Error. quoteTokenPrice refuses this token ("No reliable price": C or G unhealthy), so
   * liquidations, borrowing and reserve swaps in it revert until both feeds answer again,
   * when they resume by themselves. `refusedBy` names the rule, `stoppedSources` the feeds
   * and `guardianHint` the manual options: the guardian may freeze the token; a pause
   * does not open liquidation, since getEmergencyPrice applies the same rule.
   */
  oraclePriceRefused: 'oracle.price-refused',
  /**
   * Warn. C sits outside the gold band (`side` below or above), so borrowing and reserve
   * swaps are refused ("Off gold band") while liquidation still prices: below the band at
   * gold, so a depeg specific to the token is not liquidated, above it at
   * min(C, G x (1 + m)). Liquidation is never refused for being off the band.
   */
  oracleOffGoldBand: 'oracle.off-gold-band',
  /**
   * Warn. C sits above G x (1 + m), so liquidation values the token at that cap
   * (`liquidationCap`), below its market price (`primaryPrice`).
   */
  oraclePremiumCapped: 'oracle.premium-capped',
  /**
   * Warn. Liquidation prices with C inside the gold band yet quoteBorrowPrice or
   * quoteReservePrice refuses, which the rules do not explain.
   */
  oracleBorrowRefused: 'oracle.borrow-refused',
  /** Info. The guardian's global pause is on; the oracle health job checks nothing. */
  oracleAlreadyPaused: 'oracle.already-paused',
  /** Info. The guardian or governance has frozen this token; `frozenUntil` is when it lapses. */
  oracleTokenAlreadyFrozen: 'oracle.token-already-frozen',
  /**
   * The oracle's quoted price or one of its sources sits at least PRICE_WATCHDOG_ALERT_BPS
   * from the off-chain market price; `diverged` names which. Read only.
   */
  oraclePriceDivergence: 'oracle.price-divergence',
  /**
   * Warn, once when the gap appears or changes: the tokens the watchdog has no fresh
   * off-chain price for, with the reason. A gap in the comparison, never a page.
   */
  oracleOffChainPriceMissing: 'oracle.offchain-price-missing',
  /** Info: every configured token has an off-chain price again. */
  oracleOffChainPriceRestored: 'oracle.offchain-price-restored',
  feesAccrued: 'fees.accrued',
  txSent: 'keeper.tx-sent',
  txFailed: 'keeper.tx-failed',
  /**
   * A transaction was broadcast but its receipt could not be read, so whether it mined,
   * reverted or is still pending is not known. The hash is logged for a human to check;
   * the keeper treats the funds as committed and sends nothing competing for that owner.
   */
  txOutcomeUnknown: 'keeper.tx-outcome-unknown',
  /**
   * Warn. The keeper's lowest unmined nonce stayed outstanding past
   * KEEPER_STUCK_TX_REPLACE_SECONDS, so the keeper sent a zero-value transfer to itself at
   * that nonce with bumped fees to displace it. New sends stay
   * refused until the nonce mines; the replacement itself is replaced again, at higher
   * fees, if it sticks as long.
   */
  stuckTxReplaced: 'keeper.stuck-tx-replaced',
  /**
   * Error, page. A stuck nonce is due for replacement but a valid replacement would pass
   * KEEPER_MAX_FEE_GWEI or KEEPER_MAX_PRIORITY_FEE_GWEI, so nothing was sent and every new
   * transaction stays refused. The operator raises the ceiling or replaces the transaction
   * by hand (docs/MAINNET.md, the keeper server section).
   */
  stuckTxReplacementBlocked: 'keeper.stuck-tx-replacement-blocked',
  /**
   * Warn, every tick while it holds. The signer's ETH covers fewer than three of the smallest
   * pool liquidation the keeper sends: 1.4 million gas, the least it sends one with, at
   * KEEPER_MAX_FEE_GWEI (`liquidationCostWei`; `liquidationsCovered` counts those). A vault
   * spanning many silos is sent with more gas, up to 4 million, so near the fee ceiling such
   * a liquidation can be refused for lack of gas money before the page below fires. Top the
   * wallet up.
   */
  signerBalanceLow: 'keeper.signer-balance-low',
  /**
   * Error, page. The signer's ETH does not cover even the smallest pool liquidation at
   * KEEPER_MAX_FEE_GWEI. The keeper offers the network's fee, so a liquidation that falls due
   * is refused by the node for lack of gas money once that fee nears the ceiling; at a lower
   * fee it may still go through. Fund the keeper wallet now.
   */
  signerBalanceInsufficient: 'keeper.signer-balance-insufficient',
  /**
   * Nothing was sent for a vault that looks liquidatable. Either quoteTokenPrice reverted
   * outside any pause or freeze (priceSource "quoteTokenPrice", the reason carried: "No
   * reliable price" while C or G is unhealthy) or answered no data, so liquidate and
   * liquidateViaPool would revert or the keeper has no price to size at; or the oracle or
   * the vault is paused or the guardian has frozen the collateral token, while
   * emergencyLiquidate cannot be used: getEmergencyPrice reverts (the reason is carried,
   * "No price" while C or G is unhealthy), the direct path is off or unfunded, or the
   * vault is not undercollateralised at the emergency price; or, outside any pause, the
   * pool could not take the vault (or left a residual) and the direct path is off or the
   * keeper wallet holds less than `requiredKeeperGsusd` and no valid partial exists for it
   * (see vault.partial-direct-liquidation).
   */
  vaultLiquidationBlocked: 'vault.liquidation-blocked',
  tickSkippedOverlap: 'keeper.tick-skipped-overlap',
  /**
   * Info, one line per completed tick, whatever the tick found: the dead-man signal. `ok` is
   * false when a job reported keeper.job-error or the chain head could not be read.
   * `tickSeconds` is how long the tick took, `headBlock` and `headAgeSeconds` the chain head
   * the keeper read at the end of it, `vaultsWalked` the owners the liquidation watch swept
   * (null when it reported none), and `blockedLiquidations`, `failedLiquidations`,
   * `unknownOutcomes` and `jobErrors` count vault.liquidation-blocked, keeper.tx-failed,
   * keeper.tx-outcome-unknown and keeper.job-error lines since the previous heartbeat. A
   * monitor pages when no line with ok true has arrived for 10 minutes (docs/MAINNET.md
   * section 4.7): one direct liquidation can hold a tick for up to 540 s.
   */
  heartbeat: 'keeper.heartbeat',
  /**
   * Warn. The GET to KEEPER_HEARTBEAT_URL after a successful tick failed or timed out
   * (`host` only, never the URL). The tick itself is unaffected; the hosted dead-man check
   * pages by itself if this lasts.
   */
  heartbeatPingFailed: 'keeper.heartbeat-ping-failed',
  jobError: 'keeper.job-error',
  /**
   * Warn, at shutdown. The tick in flight did not finish within the shutdown grace, so the
   * process exits without it. A transaction it broadcast stays on record at its nonce, and
   * the next start waits for that nonce as for any other outstanding one.
   */
  shutdownTickAbandoned: 'keeper.shutdown-tick-abandoned',
  /**
   * Warn, at start. A KEEPER_READ_RPC_URLS entry (`entry`, counted from 1; the URL itself
   * is never logged) did not answer eth_chainId, so the keeper reads without it until the
   * next restart. Reads fall back to the remaining entries and finally to KEEPER_RPC_URL.
   */
  readRpcUnavailable: 'keeper.read-rpc-unavailable',
} as const;

export type KeeperEventName =
  (typeof KEEPER_EVENTS)[keyof typeof KEEPER_EVENTS];

interface WritableStream {
  write(chunk: string): unknown;
}

// On-chain quantities are bigints; JSON.stringify rejects them, so the logger
// serialises every bigint as a decimal string.
const bigintSafeReplacer = (_key: string, value: unknown): unknown =>
  typeof value === 'bigint' ? value.toString() : value;

/**
 * One JSON line per event: { ts, level, event, ...fields }. No dependencies
 * by design; stdout is the integration point for log shippers.
 */
export const createJsonLogger = (
  stream: WritableStream = process.stdout
): KeeperLogger => {
  const emit = (
    level: 'info' | 'warn' | 'error',
    event: string,
    fields?: Record<string, unknown>
  ): void => {
    const line = JSON.stringify(
      { ts: new Date().toISOString(), level, event, ...fields },
      bigintSafeReplacer
    );
    stream.write(`${line}\n`);
  };
  return {
    info: (event, fields) => emit('info', event, fields),
    warn: (event, fields) => emit('warn', event, fields),
    error: (event, fields) => emit('error', event, fields),
  };
};
