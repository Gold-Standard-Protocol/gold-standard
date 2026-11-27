import { encodeFunctionData } from 'viem';
import type { Address } from 'viem';
import {
  erc20KeeperAbi,
  goldVaultKeeperAbi,
  stabilityPoolKeeperAbi,
} from './abis';
import { KEEPER_EVENTS } from './alerts';
import { collateralIdForToken } from './collateral';
import type { KeeperConfig } from './config';
import {
  describeError,
  expectAddress,
  expectBigInt,
  expectBoolean,
  expectTuple,
} from './decode';
import {
  attemptDirectLiquidation,
  confirmReceipt,
  directLiquidationFloat,
  logOutcomeUnknown,
} from './directLiquidation';
import type { DirectOutcome } from './directLiquidation';
import { attemptEmergencyLiquidation, isPaused, readPauseState } from './emergencyLiquidation';
import { LIQUIDATION_JOB } from './liquidationConstants';
import { decideLiquidatability, screenPrice } from './liquidationPricing';
import type { LiquidationDecision } from './liquidationPricing';
import { reportReadinessOrLog } from './liquidationReadiness';
import { rankCandidates, readVaultScreens } from './liquidationScreen';
import type { Candidate, VaultScreen } from './liquidationScreen';
import {
  fullLiquidationRepay,
  isThinVault,
  requiresFullLiquidation,
  requiresFullLiquidationByRatio,
  sizePoolAbsorb,
} from './liquidationSizing';
import { readDebtsInBatches, reportSweep } from './liquidationSweep';
import { quoteOraclePrice } from './oracleReads';
import type { PriceQuote } from './oracleReads';
import type { KeeperJobDeps, KeeperTxSender } from './ports';

/**
 * Liquidation watch.
 *
 * Enumerates vault owners from the injected sources (the on-chain registry and,
 * when configured, the indexer's Redis set) and emits a `vault.liquidatable`
 * alert for every vault the CONTRACT would consider liquidatable. The alert is
 * the primary product and is ALWAYS emitted, in dry run and live alike.
 *
 * Liquidatability is decided at the LIVE price. The obvious gate,
 * `getCollateralisationRatio`, is a view and therefore prices off the stale
 * `lastKnownPrice`, while `GoldVault.liquidate` prices off the live
 * `getTokenPrice`. Those can differ by as much as the market moved since the
 * last state-changing read, against a 10-point liquidation buffer, so the keeper
 * could see a vault as healthy while it was liquidatable on-chain, and never alert.
 *
 * Instead the job compares two values that are both exact:
 *   - `getLiquidationPrice(owner)`, oracle-FREE, the gold price at which this
 *     vault crosses its liquidation ratio (uses getCurrentDebt internally);
 *   - `oracle.quoteTokenPrice(token)`, the view twin of getTokenPrice: the same
 *     rule and the same price, the trigger and the settlement alike (variant C:
 *     min(max(C, G), G x (1 + m)) with C and G both healthy, refused otherwise).
 * The vault is liquidatable exactly when that price < liquidation price, and every
 * liquidation is sized at that price. A token's vaults share one quote until a receipt wait
 * (a send, for a sender that cannot wait) or one slot of age outdates it.
 *
 * If quoteTokenPrice refuses ("No reliable price": C or G is unhealthy) outside a
 * pause or freeze, liquidate and liquidateViaPool would revert for the same reason,
 * so nothing is sent for the vault and it is reported `vault.liquidation-blocked`
 * with the reason and priceSource, unless it is healthy even at C. Liquidation
 * resumes by itself on the first healthy pair; the keeper needs to call nothing. An
 * unreachable RPC is a different thing: the job falls back to the old ratio gate for
 * the alert alone, marks it `vault.liquidatability-degraded` and sends nothing, so
 * blindness is always visible and never sized at a stale price. `priceFreshness`
 * keeps `lastKnownPrice` close to live, which keeps that alert honest. See
 * liquidationPricing.ts.
 *
 * Live execution prefers GoldVault.liquidateViaPool: it needs no keeper
 * capital and pays the caller a keeper bounty. It runs ONLY when the
 * StabilityPool's totalDeposits STRICTLY exceed what the liquidation repays, because
 * StabilityPool.absorbLiquidationPrefunded requires debtToAbsorb < totalDeposits;
 * equality is treated as underfunded so a borderline attempt never burns gas.
 *
 * The direct GoldVault.liquidate fallback burns the keeper wallet's own
 * GSUSD, so it is opt-in twice over: KEEPER_ENABLE_DIRECT must be "true" AND
 * the wallet's GSUSD balance must cover the vault debt. On launch day the
 * wallet holds no GSUSD, so the keeper watches, alerts and uses the pool path
 * only. A failed pool attempt falls through to the direct path in the same
 * tick, and so does the residual of a confirmed partial fill while the vault is
 * still liquidatable, on the paused path through
 * emergencyLiquidate at the emergency price; failures emit
 * keeper.tx-failed and the loop continues to the next vault. Never throws.
 *
 * Sizing. A partial pool absorb must leave at least minDebt of
 * principal behind, which the contract enforces, and must be worth the gas: a
 * pool holding two wei used to be "funded", and the keeper absorbed one wei per
 * tick for ever while the vault stayed liquidatable. minDebt is governed, so a
 * sending tick reads it once, before anything is sized; when that read fails the
 * tick uses the value the watch last read and never a constant, and a watch that
 * has never read it sends no partial at all
 * (see createLiquidationWatch). Once the gold is worth less
 * than the debt (underwater) the vault accepts only a full liquidation, so the
 * keeper computes that line from the same inputs and never sends a partial into
 * it. A thin but solvent vault, between 100% and 100% plus the penalty, takes a
 * pro-rata partial, so a pool smaller than it
 * works it down instead of waiting. A keeper wallet that cannot fund the whole debt sends
 * the largest partial under the same rules (sizeDirectPartial)
 * and says how much debt stays uncovered. The direct path approves the debt plus headroom for
 * the fee that accrues before inclusion, and waits for the approval to mine
 * before simulating the liquidation, which otherwise saw the old allowance,
 * failed and revoked on every tick.
 *
 * Several pool sends in one tick are sized against a pool estimate that is
 * decremented by what earlier sends committed (and the receipt is awaited when
 * the sender can), because three vaults sized against one stale balance passed
 * simulation and two of them reverted on chain. A pool send is reported as a
 * liquidation only once its receipt confirms it; a mined revert
 * releases its commitment and lets the direct path try, while an unreadable
 * receipt keeps the commitment and sends nothing competing for that owner,
 * since the transaction may still mine.
 *
 * An underwater vault repays its gold's value less the underwater discount, not
 * its nominal debt, and the vault checks the pool against that repayment, so
 * the keeper sizes an underwater vault against the same figure.
 *
 * While the vault is paused the pool path still runs, priced at getEmergencyPrice,
 * so the keeper tries it before emergencyLiquidate from its own GSUSD. While
 * the oracle is paused only emergencyLiquidate works, and a token the guardian or
 * governance has frozen cannot be seized at all outside a pause; the keeper reports
 * each blocked vault and why. See emergencyLiquidation.ts.
 *
 * The owner set is permissionless (any address that deposits one unit joins
 * it), so debts are read in multicall batches where the client supports it
 * and owners without debt are skipped without further reads. A failed batch, or
 * a failed entry inside one, is retried and then read owner by owner, so one bad
 * chunk never hides a liquidatable vault in another, and an owner that still
 * cannot be read is reported unread.
 * The vaults with debt are then screened in batches too, vaults(owner) and
 * getLiquidationPrice(owner) against the token's quote, so a healthy vault costs
 * no sequential read; only candidates take the single reads that precede a send,
 * underwater vaults first and then the largest debt, and the rest are screened
 * again after every receipt wait (see walkScreened). Without
 * multicall every owner is walked one by one, as before.
 */
const JOB = LIQUIDATION_JOB;

/** One Ethereum slot: a quote older than this may predate a block that moved the feeds. */
export const QUOTE_MAX_AGE_MS = 12_000;

const readVaultContract = (
  deps: KeeperJobDeps,
  config: KeeperConfig,
  functionName: string,
  args?: readonly unknown[]
): Promise<unknown> =>
  deps.read.readContract({
    address: config.goldVaultAddress,
    abi: goldVaultKeeperAbi,
    functionName,
    args,
  });

interface CollateralParams {
  /** GoldVault.collateralTypes(id).active; false for XAUT on a PAXG-first launch. */
  active: boolean;
  liquidationRatio: bigint;
  liquidationPenalty: bigint;
  decimals: number;
}

/** When a read began, which is what it takes to tell whether it is still current. */
interface ReadStamp {
  /** The walk's clock as the read began. */
  readAt: number;
  /** QuoteBook.settled as the read began. */
  settled: number;
}

/** A quoteTokenPrice answer and when it was read. */
interface CachedQuote extends ReadStamp {
  quote: PriceQuote;
}

/** A token's screen price (see screenPrice) and when it was read; undefined screens nothing. */
interface CachedScreenPrice extends ReadStamp {
  price: bigint | undefined;
}

/**
 * The walk's quotes and what outdates them. One quote used
 * to serve the whole walk, but a send can wait minutes for its receipt and the scheduler skips
 * the ticks it overlaps, so a vault that crossed its line during the wait was judged at a
 * price the feeds had left, skipped without an alert and seen a tick late. A quote is now
 * reused only while no send has settled since it was read (see settlingQuotes) and it is no
 * older than QUOTE_MAX_AGE_MS; a walk that sends nothing within a slot still reads once.
 */
interface QuoteBook {
  readonly entries: Map<Address, CachedQuote>;
  /** Screen prices per token, outdated by the same rule as the quotes they derive from. */
  readonly screenPrices: Map<Address, CachedScreenPrice>;
  /**
   * Receipt waits finished this walk, or broadcasts for a sender that cannot wait; each
   * outdates every quote read before it.
   */
  settled: number;
  readonly now: () => number;
}

const MIN_DEBT_UNKNOWN_PARTIAL_DETAIL =
  'GoldVault.minDebt has not been readable since this keeper started, so no partial absorb was sized';

/** Per-tick state shared across the owner walk. */
interface TickState {
  params: Map<Address, CollateralParams>;
  /** quoteTokenPrice per collateral token, shared by its vaults while it stays current. */
  quotes: QuoteBook;
  /** Debt handed to the pool by this tick's sends; a fresh read may not show it yet. */
  poolCommitted: bigint;
  /** totalDeposits as first read this tick, the base the commitments count down from. */
  poolBaseline: bigint | undefined;
  /** GoldVault.minDebt for this tick; undefined while the watch has never read it. */
  minDebt: bigint | undefined;
}

const createTickState = (now: () => number, minDebt: bigint | undefined): TickState => ({
  params: new Map(),
  quotes: { entries: new Map(), screenPrices: new Map(), settled: 0, now },
  poolCommitted: 0n,
  poolBaseline: undefined,
  minDebt,
});

/**
 * The walk's sender: the same sends, one at a time and in the same order, except that each
 * receipt wait, however it ends, outdates the quotes read before it. A wait spans at least the
 * block that mines its send, and that block may move
 * the feeds too. Every send of the walk goes through it (the pool, the direct path with its
 * approve and revoke, the emergency path and the residual), so none of them can leave a later
 * decision priced from before its wait. A sender that cannot wait settles on each broadcast
 * instead, the last the walk hears of that send.
 */
const settlingQuotes = (tx: KeeperTxSender, book: QuoteBook): KeeperTxSender => {
  const settle = (): void => {
    book.settled += 1;
  };
  if (tx.waitForReceipt === undefined) {
    return {
      account: tx.account,
      simulateAndSend: async (call) => {
        const result = await tx.simulateAndSend(call);
        if (result.ok) settle();
        return result;
      },
    };
  }
  // The wait alone settles: it ends after its broadcast, so it outdates every quote read
  // before the broadcast as well as any read in between.
  const wait = tx.waitForReceipt.bind(tx);
  return {
    account: tx.account,
    simulateAndSend: (call) => tx.simulateAndSend(call),
    waitForReceipt: async (hash) => {
      try {
        return await wait(hash);
      } finally {
        settle();
      }
    },
  };
};

const expectDecimals = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 18) {
    throw new Error('decimals did not decode to an integer between 0 and 18');
  }
  return value;
};

// Known trade-off: the parameter cache lives for one tick, so a
// governance change to liquidationRatio mid-tick is picked up next tick. With
// a minute interval and a 48 hour parameter timelock this is acceptable; if
// the collateral set grows, revisit per-token invalidation.
const readCollateralParams = async (
  deps: KeeperJobDeps,
  config: KeeperConfig,
  collateralToken: Address,
  state: TickState
): Promise<CollateralParams> => {
  const cached = state.params.get(collateralToken);
  if (cached !== undefined) {
    return cached;
  }
  const raw = await readVaultContract(deps, config, 'collateralTypes', [
    collateralIdForToken(collateralToken),
  ]);
  // (token, minRatio, liquidationRatio, liquidationPenalty, debtCeiling,
  // totalDebt, active): liquidationRatio decodes at index 2, the penalty at 3.
  const tuple = expectTuple(raw, 7, 'collateralTypes');
  const decimals = expectDecimals(
    await deps.read.readContract({
      address: collateralToken,
      abi: erc20KeeperAbi,
      functionName: 'decimals',
    })
  );
  const params: CollateralParams = {
    active: expectBoolean(tuple[6], 'collateralTypes.active'),
    liquidationRatio: expectBigInt(tuple[2], 'collateralTypes.liquidationRatio'),
    liquidationPenalty: expectBigInt(tuple[3], 'collateralTypes.liquidationPenalty'),
    decimals,
  };
  state.params.set(collateralToken, params);
  return params;
};

/**
 * The pool balance this tick may still size against: the fresh read, or the first
 * read less everything already committed, whichever is lower. A lagging RPC can
 * return the pre-send balance after a send; a deposit can raise the fresh figure.
 */
const poolAvailable = (state: TickState, totalDeposits: bigint): bigint => {
  const baseline = state.poolBaseline ?? totalDeposits;
  const fromBaseline = baseline - state.poolCommitted;
  const available = totalDeposits < fromBaseline ? totalDeposits : fromBaseline;
  return available > 0n ? available : 0n;
};

interface PoolAttemptOutcome {
  state: TickState;
  /**
   * True when the pool handled the vault, or may have (its receipt could not be
   * read), so the direct path must not run for it.
   */
  done: boolean;
  /** A partial absorb whose receipt confirmed it: a residual debt stays behind. */
  residualLeft?: boolean;
}

/** What the pool path needs to size one vault. */
interface PoolSizing {
  debt: bigint;
  principal: bigint;
  /** Underwater: the vault accepts only a full liquidation. */
  fullOnly: boolean;
  /** What a full liquidation repays: the debt, or less once underwater. */
  fullRepay: bigint;
}

const attemptPoolLiquidation = async (
  deps: KeeperJobDeps,
  config: KeeperConfig,
  tx: KeeperTxSender,
  owner: Address,
  sizing: PoolSizing,
  state: TickState
): Promise<PoolAttemptOutcome> => {
  const { log } = deps;
  const { debt, principal, fullOnly, fullRepay } = sizing;
  // Operator-pinned: the pool address is config, never an RPC answer,
  // so a compromised endpoint cannot redirect liquidateViaPool reads.
  const poolAddress = config.stabilityPoolAddress;
  const totalDeposits = expectBigInt(
    await deps.read.readContract({
      address: poolAddress,
      abi: stabilityPoolKeeperAbi,
      functionName: 'totalDeposits',
    }),
    'totalDeposits'
  );
  const baselined: TickState = {
    ...state,
    poolBaseline: state.poolBaseline ?? totalDeposits,
  };
  // STRICT comparison: StabilityPool.absorbLiquidationPrefunded requires
  // debtToAbsorb < totalDeposits, so equality counts as underfunded.
  //
  // PARTIAL FILLS. Passing 0 means "full debt" (GoldVault rewrites it to
  // currentDebt), so an all-or-nothing call wasted a pool that could cover
  // most of a position: a 10k pool against a 39k vault did nothing at all,
  // even though absorbing 9,999 was both legal and useful.
  // SPECIFICATION.md (the StabilityPool section) routes the residual through
  // direct liquidate(). Absorb what the pool can, leaving 1 wei of headroom
  // for the strict inequality. Once the partial is confirmed mined, the direct
  // path, when armed, takes the remainder in the same tick after re-reading the
  // debt and the vault's standing (liquidateResidual);
  // before that fix the residual waited for the next tick.
  const available = poolAvailable(baselined, totalDeposits);
  const absorbable = available > 0n ? available - 1n : 0n;
  if (fullOnly && absorbable < fullRepay) {
    // Underwater the vault refuses a partial, so a sized send would only revert.
    log.warn(KEEPER_EVENTS.vaultFullLiquidationRequired, {
      owner,
      debt,
      repay: fullRepay,
      totalDeposits,
      absorbable,
      pool: poolAddress,
    });
    return { state: baselined, done: false };
  }
  // An underwater vault takes 0 (the whole debt) or nothing, and the gate above has
  // already checked the pool covers what that full liquidation repays.
  const debtToAbsorb = fullOnly ? 0n : sizePoolAbsorb(debt, principal, absorbable, state.minDebt);
  if (debtToAbsorb === undefined) {
    log.warn(KEEPER_EVENTS.vaultPoolUnderfunded, {
      owner,
      debt,
      totalDeposits,
      absorbable,
      pool: poolAddress,
      // The pool may hold enough for a partial that was not sized: say why.
      ...(state.minDebt === undefined ? { detail: MIN_DEBT_UNKNOWN_PARTIAL_DETAIL } : {}),
    });
    return { state: baselined, done: false };
  }
  if (debtToAbsorb !== 0n) {
    log.info(KEEPER_EVENTS.vaultPartialPoolAbsorb, {
      owner,
      debt,
      totalDeposits,
      absorbing: debtToAbsorb,
      residual: debt - debtToAbsorb,
    });
  }
  const result = await tx.simulateAndSend({
    address: config.goldVaultAddress,
    abi: goldVaultKeeperAbi,
    functionName: 'liquidateViaPool',
    args: [owner, debtToAbsorb],
  });
  if (!result.ok) {
    log.error(KEEPER_EVENTS.txFailed, {
      job: JOB,
      owner,
      functionName: 'liquidateViaPool',
      reason: result.reason,
    });
    // The pool could not take it (an underwater vault refuses partials, say); the direct
    // path, if the operator armed it, is the reason it was armed.
    return { state: baselined, done: false };
  }
  log.info(KEEPER_EVENTS.txSent, {
    job: JOB,
    owner,
    functionName: 'liquidateViaPool',
    hash: result.hash,
  });
  const committed = debtToAbsorb === 0n ? fullRepay : debtToAbsorb;
  const pending: TickState = {
    ...baselined,
    poolCommitted: baselined.poolCommitted + committed,
  };
  // Let the pool balance settle before the next vault is sized against it.
  const receipt = await confirmReceipt(tx, result.hash);
  switch (receipt.status) {
    case 'success':
      log.info(KEEPER_EVENTS.vaultLiquidatedViaPool, {
        owner,
        debt,
        repay: committed,
        hash: result.hash,
      });
      return { state: pending, done: true, residualLeft: debtToAbsorb !== 0n };
    case 'reverted':
      // The pool spent nothing, so its capacity is released for the next
      // vault and the direct path gets its chance at this one.
      log.error(KEEPER_EVENTS.txFailed, {
        job: JOB,
        owner,
        functionName: 'liquidateViaPool',
        hash: result.hash,
        reason: 'reverted on chain after passing simulation',
      });
      return { state: baselined, done: false };
    case 'unknown':
      // It may still mine. Keep the commitment so later vaults are not
      // sized against funds it may spend, and run nothing competing for this owner.
      logOutcomeUnknown(deps, owner, 'liquidateViaPool', result.hash, receipt.reason);
      return { state: pending, done: true };
    case 'unobserved':
      // A sender that cannot wait (never the production keeper) says only that it
      // broadcast; the commitment stands and no success is claimed.
      return { state: pending, done: true };
  }
};

/** What the pool sizing needs from a vault and the price its seizure is sized at. */
interface PricedVault {
  debt: bigint;
  principal: bigint;
  collateralAmount: bigint;
  decimals: number;
  penaltyPpm: bigint;
  price: bigint;
}

/**
 * The pool sizing at a price: an underwater vault takes only a full liquidation, which
 * repays the gold's value less the discount; a thin but solvent vault takes
 * a pro-rata partial, so it is sized like any other. Without the discount the
 * nominal debt stands, which errs towards not sending.
 */
const poolSizingAt = async (
  deps: KeeperJobDeps,
  config: KeeperConfig,
  vault: PricedVault
): Promise<PoolSizing> => {
  const input = {
    collateralAmount: vault.collateralAmount,
    decimals: vault.decimals,
    price: vault.price,
    debt: vault.debt,
    penaltyPpm: vault.penaltyPpm,
  };
  const fullOnly = requiresFullLiquidation(input);
  const discountPpm = fullOnly ? await readUnderwaterDiscount(deps, config) : undefined;
  return {
    debt: vault.debt,
    principal: vault.principal,
    fullOnly,
    fullRepay: discountPpm !== undefined ? fullLiquidationRepay({ ...input, discountPpm }) : vault.debt,
  };
};

/** GoldVault.underwaterDiscountPpm, or undefined when the read fails. */
const readUnderwaterDiscount = async (
  deps: KeeperJobDeps,
  config: KeeperConfig
): Promise<bigint | undefined> => {
  try {
    return expectBigInt(
      await readVaultContract(deps, config, 'underwaterDiscountPpm'),
      'underwaterDiscountPpm'
    );
  } catch {
    return undefined;
  }
};

/** Whether a cached read may decide another vault: young enough with nothing settled since it began. */
const isCurrent = (stamp: ReadStamp, book: QuoteBook): boolean => {
  const age = book.now() - stamp.readAt;
  // A clock that stepped back says nothing about the read's age, so it is read again.
  return stamp.settled === book.settled && age >= 0 && age <= QUOTE_MAX_AGE_MS;
};

const stampNow = (book: QuoteBook): ReadStamp => ({ readAt: book.now(), settled: book.settled });

/** quoteTokenPrice for a token, shared by its vaults while it stays current. */
const quoteForTick = async (
  deps: KeeperJobDeps,
  config: KeeperConfig,
  token: Address,
  state: TickState
): Promise<PriceQuote> => {
  const book = state.quotes;
  const cached = book.entries.get(token);
  if (cached !== undefined && isCurrent(cached, book)) return cached.quote;
  const stamp = stampNow(book);
  const quote = await quoteOraclePrice(deps.read, config.goldOracleAddress, 'quoteTokenPrice', token);
  book.entries.set(token, { quote, ...stamp });
  return quote;
};

/**
 * A token's screen price, shared by its vaults while it stays current. A read that fails
 * screens nothing, so every vault of the token takes the full decision, as before the screen.
 */
const screenPriceForTick = async (
  deps: KeeperJobDeps,
  config: KeeperConfig,
  token: Address,
  state: TickState
): Promise<bigint | undefined> => {
  const book = state.quotes;
  const cached = book.screenPrices.get(token);
  if (cached !== undefined && isCurrent(cached, book)) return cached.price;
  const stamp = stampNow(book);
  let price: bigint | undefined;
  try {
    price = await screenPrice(deps, config, token, await quoteForTick(deps, config, token, state));
  } catch {
    price = undefined;
  }
  book.screenPrices.set(token, { price, ...stamp });
  return price;
};

/**
 * quoteTokenPrice reverted for a vault that looks liquidatable: the contract would
 * refuse liquidate and liquidateViaPool for the same reason, so nothing is sent. Dry
 * run and live alike, since the alert is the product.
 */
const reportPriceBlocked = (
  deps: KeeperJobDeps,
  vault: { owner: Address; debt: bigint; collateralToken: Address },
  decision: LiquidationDecision,
  blocked: NonNullable<LiquidationDecision['blocked']>
): void => {
  if (!decision.liquidatable) return;
  deps.log.error(KEEPER_EVENTS.vaultLiquidationBlocked, {
    job: JOB,
    ...vault,
    priceSource: decision.priceSource,
    reason: blocked.reason,
    primaryPrice: blocked.primaryPrice,
    liquidationPrice: decision.liquidationPrice,
    ratio: decision.ratio,
    detail:
      'quoteTokenPrice refuses, so liquidate and liquidateViaPool would revert for the same reason; nothing was sent, and liquidation resumes by itself once both feeds answer. The oracle.price-refused alert for this token names the unhealthy feeds and what the guardian may do',
  });
};

const watchVault = async (
  deps: KeeperJobDeps,
  config: KeeperConfig,
  owner: Address,
  state: TickState,
  knownDebt?: bigint
): Promise<TickState> => {
  const { tx, log } = deps;

  const debt =
    knownDebt ??
    expectBigInt(
      await readVaultContract(deps, config, 'getVaultCurrentDebt', [owner]),
      'getVaultCurrentDebt'
    );
  if (debt === 0n) {
    return state;
  }

  const vaultTuple = expectTuple(
    await readVaultContract(deps, config, 'vaults', [owner]),
    3,
    'vaults'
  );
  const collateralToken = expectAddress(
    vaultTuple[0],
    'vaults.collateralToken'
  );
  const collateralAmount = expectBigInt(
    vaultTuple[1],
    'vaults.collateralAmount'
  );
  const principal = expectBigInt(vaultTuple[2], 'vaults.debtAmount');
  const params = await readCollateralParams(deps, config, collateralToken, state);
  if (!params.active) {
    // Not a vault collateral (XAUT on a PAXG-first launch): nothing to price or page.
    return state;
  }

  // Debt with zero collateral is already bad debt: getLiquidationPrice returns 0
  // and no liquidation can seize anything. Surface it rather than skip silently.
  if (collateralAmount === 0n) {
    log.error(KEEPER_EVENTS.vaultBadDebt, { owner, debt, collateralToken });
    return state;
  }

  const decision = await decideLiquidatability(
    deps,
    config,
    { owner, collateralToken, liquidationRatio: params.liquidationRatio },
    await quoteForTick(deps, config, collateralToken, state)
  );
  if (decision.blocked !== undefined) {
    reportPriceBlocked(deps, { owner, debt, collateralToken }, decision, decision.blocked);
    return state;
  }
  if (decision.degraded) {
    log.warn(KEEPER_EVENTS.liquidatabilityDegraded, {
      owner,
      collateralToken,
      detail: decision.detail,
    });
  }
  if (!decision.liquidatable) {
    return state;
  }

  const priced: PricedVault | undefined =
    decision.livePrice !== undefined
      ? {
          debt,
          principal,
          collateralAmount,
          decimals: params.decimals,
          penaltyPpm: params.liquidationPenalty,
          price: decision.livePrice,
        }
      : undefined;
  const fullOnly =
    priced !== undefined ? requiresFullLiquidation(priced) : requiresFullLiquidationByRatio(decision.ratio ?? 0n);

  // The alert is the primary product: emitted always, live and dry run.
  log.warn(KEEPER_EVENTS.vaultLiquidatable, {
    owner,
    debt,
    collateralToken,
    liquidationRatio: params.liquidationRatio,
    priceSource: decision.priceSource,
    livePrice: decision.livePrice,
    liquidationPrice: decision.liquidationPrice,
    ratio: decision.ratio,
    thinVault: priced !== undefined ? isThinVault(priced) : undefined,
    fullLiquidationRequired: fullOnly,
  });

  if (decision.alertOnly === true) {
    // No contract price to size at (an unreachable RPC): the alert above is all.
    return state;
  }

  if (config.dryRun || tx === undefined) {
    log.info(KEEPER_EVENTS.dryRun, {
      job: JOB,
      owner,
      to: config.goldVaultAddress,
      functionName: 'liquidateViaPool',
      // The exact calldata a live keeper would send (0 = full debt).
      calldata: encodeFunctionData({
        abi: goldVaultKeeperAbi,
        functionName: 'liquidateViaPool',
        args: [owner, 0n],
      }),
      note: 'debtToRepay 0 = full debt; a live keeper sizes this to the pool',
    });
    return state;
  }

  const pause = await readPauseState(deps, config, collateralToken);
  if (isPaused(pause)) {
    // Either pause leaves the pool path available, priced at getEmergencyPrice.
    let next = state;
    const tryPool = async (emergencyPrice: bigint): Promise<{ done: boolean; residualLeft?: boolean }> => {
      const sizing = await poolSizingAt(deps, config, {
        debt,
        principal,
        collateralAmount,
        decimals: params.decimals,
        penaltyPpm: params.liquidationPenalty,
        price: emergencyPrice,
      });
      const outcome = await attemptPoolLiquidation(deps, config, tx, owner, sizing, state);
      next = outcome.state;
      // The residual flag travels with the outcome so the paused path can settle a partial
      // fill in this tick too, through emergencyLiquidate at the emergency price.
      return { done: outcome.done, residualLeft: outcome.residualLeft };
    };
    await attemptEmergencyLiquidation(
      deps,
      config,
      tx,
      {
        owner,
        debt,
        collateralToken,
        collateralAmount,
        decimals: params.decimals,
        liquidationRatio: params.liquidationRatio,
        principal,
        penaltyPpm: params.liquidationPenalty,
        minDebt: state.minDebt,
      },
      pause,
      tryPool
    );
    return next;
  }

  const sizing =
    priced !== undefined
      ? await poolSizingAt(deps, config, priced)
      : { debt, principal, fullOnly, fullRepay: debt };
  const pool = await attemptPoolLiquidation(deps, config, tx, owner, sizing, state);
  if (!pool.done) {
    reportDirectBlocked(
      deps,
      config,
      { owner, debt, collateralToken },
      // A wallet short of the whole debt sends the largest partial the vault accepts.
      await attemptDirectLiquidation(deps, config, tx, owner, debt, 'liquidate', {
        principal,
        fullOnly: sizing.fullOnly,
        minDebt: state.minDebt,
      }),
      'the pool could not take the vault'
    );
  } else if (pool.residualLeft === true) {
    await liquidateResidual(
      deps,
      config,
      tx,
      { owner, collateralToken, liquidationRatio: params.liquidationRatio },
      params,
      pool.state
    );
  }
  return pool.state;
};

/**
 * The pool could not take a liquidatable vault, or left a residual, and the direct path
 * sent nothing because it is off or the keeper wallet cannot cover the debt. The paused
 * path always paged this; the unpaused and residual paths dropped it without a word, so a
 * float smaller than the vault left no error at all. A
 * send that failed or whose receipt is unknown is already reported where it happened.
 */
const reportDirectBlocked = (
  deps: KeeperJobDeps,
  config: KeeperConfig,
  vault: { owner: Address; debt: bigint; collateralToken: Address },
  outcome: DirectOutcome,
  poolOutcome: string
): void => {
  if (outcome !== 'disabled' && outcome !== 'unfunded') return;
  deps.log.error(KEEPER_EVENTS.vaultLiquidationBlocked, {
    job: JOB,
    ...vault,
    enableDirect: config.enableDirect,
    poolTried: true,
    requiredKeeperGsusd: outcome === 'unfunded' ? directLiquidationFloat(vault.debt) : undefined,
    reason:
      outcome === 'disabled'
        ? `${poolOutcome} and the direct path is disabled; set KEEPER_ENABLE_DIRECT=true and fund the keeper wallet to liquidate it directly`
        : `${poolOutcome} and the keeper wallet cannot cover the debt plus 1% headroom for a direct liquidation, nor a partial the vault would accept`,
  });
};

/**
 * The residual a confirmed partial pool fill leaves behind goes
 * to the direct path in the same tick rather than the next. The debt and the vault's
 * standing are read afresh first: a partial above the penalty band improves the ratio and
 * may have restored the vault, and a direct attempt on a healthy vault would only approve,
 * fail in simulation and revoke. The price is read afresh as well: the wait for the partial's
 * receipt outdated the quote that sized it, and the
 * feeds may have fallen meanwhile. A residual still liquidatable that the direct path cannot
 * take, because it is off or unfunded, is reported blocked, as on the paused path. A wallet
 * short of the residual sends the largest partial of it the vault accepts, sized from the
 * principal and the gold as they stand after the pool's fill.
 */
const liquidateResidual = async (
  deps: KeeperJobDeps,
  config: KeeperConfig,
  tx: KeeperTxSender,
  vault: { owner: Address; collateralToken: Address; liquidationRatio: bigint },
  params: CollateralParams,
  state: TickState
): Promise<void> => {
  const residual = expectBigInt(
    await readVaultContract(deps, config, 'getVaultCurrentDebt', [vault.owner]),
    'getVaultCurrentDebt'
  );
  if (residual === 0n) return;
  const decision = await decideLiquidatability(
    deps,
    config,
    vault,
    await quoteForTick(deps, config, vault.collateralToken, state)
  );
  if (!decision.liquidatable || decision.blocked !== undefined || decision.alertOnly === true) return;
  const vaultTuple = expectTuple(await readVaultContract(deps, config, 'vaults', [vault.owner]), 3, 'vaults');
  const fullOnly =
    decision.livePrice !== undefined
      ? requiresFullLiquidation({
          collateralAmount: expectBigInt(vaultTuple[1], 'vaults.collateralAmount'),
          decimals: params.decimals,
          price: decision.livePrice,
          debt: residual,
          penaltyPpm: params.liquidationPenalty,
        })
      : requiresFullLiquidationByRatio(decision.ratio ?? 0n);
  reportDirectBlocked(
    deps,
    config,
    { owner: vault.owner, debt: residual, collateralToken: vault.collateralToken },
    await attemptDirectLiquidation(deps, config, tx, vault.owner, residual, 'liquidate', {
      principal: expectBigInt(vaultTuple[2], 'vaults.debtAmount'),
      fullOnly,
      minDebt: state.minDebt,
    }),
    'a partial pool fill left this residual'
  );
};

/**
 * GoldVault.minDebt for one tick. It is governed (100 GSUSD on the testnet harness, 1,000 at
 * the mainnet launch), so no constant can stand in for it: a failed read is reported and the
 * tick gets `lastKnown`, the value the watch last read, which is undefined until one read
 * has succeeded.
 */
const readTickMinDebt = async (
  deps: KeeperJobDeps,
  config: KeeperConfig,
  lastKnown: bigint | undefined
): Promise<bigint | undefined> => {
  try {
    return expectBigInt(await readVaultContract(deps, config, 'minDebt'), 'minDebt');
  } catch (error) {
    deps.log.warn(KEEPER_EVENTS.minDebtUnreadable, {
      job: JOB,
      reason: describeError(error),
      lastKnownMinDebt: lastKnown,
    });
    return lastKnown;
  }
};

/** One vault's full decision and any send; a failing read for one owner never aborts the others. */
const watchOwner = async (
  deps: KeeperJobDeps,
  config: KeeperConfig,
  owner: Address,
  state: TickState,
  knownDebt?: bigint
): Promise<TickState> => {
  try {
    return await watchVault(deps, config, owner, state, knownDebt);
  } catch (error) {
    deps.log.error(KEEPER_EVENTS.jobError, {
      job: JOB,
      owner,
      reason: describeError(error),
    });
    return state;
  }
};

/**
 * One indebted vault judged from its screen: undefined when it is healthy at the token's
 * screen price or not an active collateral, otherwise a candidate for the full decision. No
 * screen, a failed read or a token whose price screens nothing makes a candidate, so the
 * screen can only spare a vault the sequential reads, never hide one.
 */
const screenOwner = async (
  deps: KeeperJobDeps,
  config: KeeperConfig,
  owner: Address,
  debt: bigint,
  screen: VaultScreen | undefined,
  state: TickState
): Promise<Candidate | undefined> => {
  const candidate: Candidate = { owner, debt, underwater: false };
  if (screen === undefined) return candidate;
  try {
    const params = await readCollateralParams(deps, config, screen.collateralToken, state);
    if (!params.active) return undefined;
    // Debt with no collateral is bad debt; watchVault reports it.
    if (screen.collateralAmount === 0n) return { ...candidate, underwater: true };
    const price = await screenPriceForTick(deps, config, screen.collateralToken, state);
    if (price === undefined) return candidate;
    if (screen.liquidationPrice === 0n || price >= screen.liquidationPrice) return undefined;
    return {
      ...candidate,
      underwater: requiresFullLiquidation({
        collateralAmount: screen.collateralAmount,
        decimals: params.decimals,
        price,
        debt,
        penaltyPpm: params.liquidationPenalty,
      }),
    };
  } catch {
    return candidate;
  }
};

/** Screens `owners` afresh and ranks the candidates, most urgent first. */
const screenPass = async (
  deps: KeeperJobDeps,
  config: KeeperConfig,
  owners: readonly Address[],
  debts: ReadonlyMap<Address, bigint>,
  state: TickState
): Promise<{ order: Address[]; stamp: ReadStamp }> => {
  const stamp = stampNow(state.quotes);
  const screens = await readVaultScreens(deps, config, owners);
  const candidates: Candidate[] = [];
  for (const owner of owners) {
    const candidate = await screenOwner(deps, config, owner, debts.get(owner) ?? 0n, screens.get(owner), state);
    if (candidate !== undefined) candidates.push(candidate);
  }
  return { order: rankCandidates(candidates), stamp };
};

/**
 * The walk over the vaults with debt, when the client can batch. Each pass screens the vaults not
 * yet visited and visits
 * the candidates most urgent first; each visit re-reads the vault and the price immediately
 * before any send. A pass ends early once a send settles, and the next pass screens what is
 * left again, so a vault that crossed its line while a receipt was awaited is still found in
 * the same walk. Age alone never cuts a pass short: each
 * visit takes a current quote before it decides, and a screen that outlives a slot (a large
 * book, or every vault a candidate while the price screens nothing) would otherwise be read
 * again after every visit. A pass that grew older than one slot screens the rest once more
 * after its last candidate. Every pass visits at least one candidate, so the walk ends.
 */
const walkScreened = async (
  deps: KeeperJobDeps,
  config: KeeperConfig,
  indebted: readonly Address[],
  debts: ReadonlyMap<Address, bigint>,
  initial: TickState
): Promise<void> => {
  let state = initial;
  let remaining = indebted;
  while (remaining.length > 0) {
    const pass = await screenPass(deps, config, remaining, debts, state);
    if (pass.order.length === 0) return;
    const visited = new Set<Address>();
    for (const owner of pass.order) {
      if (visited.size > 0 && state.quotes.settled !== pass.stamp.settled) break;
      visited.add(owner);
      state = await watchOwner(deps, config, owner, state, debts.get(owner));
    }
    // Every candidate visited and nothing outdated the screen: the rest are healthy.
    if (visited.size === pass.order.length && isCurrent(pass.stamp, state.quotes)) return;
    remaining = remaining.filter((owner) => !visited.has(owner));
  }
};

/**
 * Reads every owner's debt, runs the readiness preflight against it and works through the
 * vaults that carry any: screened and ranked when the client can batch, one by one in the
 * owner source's order otherwise.
 */
const walkOwners = async (
  deps: KeeperJobDeps,
  config: KeeperConfig,
  owners: readonly Address[],
  minDebt: bigint | undefined
): Promise<void> => {
  const sweep = await readDebtsInBatches(deps, config, owners);
  if (sweep !== undefined) {
    reportSweep(deps, JOB, owners, sweep);
  }
  let largestDebt: bigint | undefined;
  for (const debt of sweep?.debts.values() ?? []) {
    if (largestDebt === undefined || debt > largestDebt) largestDebt = debt;
  }
  await reportReadinessOrLog(deps, config, minDebt, largestDebt);
  const state = createTickState(deps.now ?? Date.now, minDebt);
  const walkDeps: KeeperJobDeps = {
    ...deps,
    tx: deps.tx === undefined ? undefined : settlingQuotes(deps.tx, state.quotes),
  };
  if (sweep !== undefined) {
    // A vault with no debt is not a liquidation candidate, and an unread owner is reported
    // by the sweep: neither is walked.
    const indebted = owners.filter((owner) => (sweep.debts.get(owner) ?? 0n) > 0n);
    await walkScreened(walkDeps, config, indebted, sweep.debts, state);
    return;
  }
  let walked = state;
  for (const owner of owners) {
    walked = await watchOwner(walkDeps, config, owner, walked);
  }
};

export type LiquidationWatch = (deps: KeeperJobDeps, config: KeeperConfig) => Promise<void>;

/**
 * A liquidation watch that remembers GoldVault.minDebt between ticks. Every sending tick
 * reads it afresh, so a governed change applies on the next tick; a tick whose read fails
 * warns and uses the remembered value. Nothing else is carried from one tick to the next.
 */
export const createLiquidationWatch = (): LiquidationWatch => {
  let lastMinDebt: bigint | undefined;
  return async (deps, config) => {
    try {
      const owners = await deps.owners.getOwners();
      if (owners.length === 0) {
        // No owners: an empty registry before launch, or a tick the owner union has already paged.
        deps.log.info(KEEPER_EVENTS.vaultNoOwners, { chainId: config.chainId });
        return;
      }
      // A dry run or a keeper without a key sizes nothing, so it has no use for minDebt.
      if (!config.dryRun && deps.tx !== undefined) {
        lastMinDebt = await readTickMinDebt(deps, config, lastMinDebt);
      }
      await walkOwners(deps, config, owners, lastMinDebt);
    } catch (error) {
      deps.log.error(KEEPER_EVENTS.jobError, {
        job: JOB,
        reason: describeError(error),
      });
    }
  };
};

/** One tick with no memory of earlier ticks; the keeper itself runs a createLiquidationWatch instance. */
export const runLiquidationWatch: LiquidationWatch = (deps, config) =>
  createLiquidationWatch()(deps, config);
