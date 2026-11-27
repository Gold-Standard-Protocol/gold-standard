import type { Address } from 'viem';
import { goldOracleKeeperAbi, goldVaultKeeperAbi } from './abis';
import type { KeeperConfig } from './config';
import { describeError, expectBigInt, expectBoolean, expectTuple } from './decode';
import { isPaused, readPauseState, type PauseState } from './emergencyLiquidation';
import type { PriceQuote } from './oracleReads';
import type { KeeperJobDeps } from './ports';

/**
 * Where the liquidation decision took its price from:
 *   - quoteTokenPrice: the view twin of getTokenPrice, the price GoldVault.liquidate and
 *     liquidateViaPool trigger on and size the seizure at: min(max(C, G), G x (1 + m))
 *     with C and G both healthy, refused otherwise (the oracle plan, section 3). The only
 *     price the keeper ever sizes a liquidation from outside a pause;
 *   - getEmergencyPrice: the same settlement rule while the vault or oracle is paused.
 *     C alone can be above its liquidation cap, so it must not filter this price;
 *   - primary-feed: getValidatedPrice, C alone. Only an alert filter when the emergency
 *     quote is unavailable or a token is frozen outside a pause; and while
 *     quoteTokenPrice refuses it picks which blocked vaults are worth an alert;
 *   - last-known: the stale getCollateralisationRatio, when the RPC cannot be reached.
 *     Alert only: nothing is sent on it.
 */
export type PriceSource = 'quoteTokenPrice' | 'getEmergencyPrice' | 'primary-feed' | 'last-known';

export interface LiquidationDecision {
  /**
   * Whether to act on (or, while blocked, to report) this vault. While blocked it means
   * the vault looks liquidatable at the primary feed, or the primary is unreadable too.
   */
  liquidatable: boolean;
  /** True when the contract's own price was unusable and a weaker one stood in. */
  degraded: boolean;
  detail?: string;
  priceSource: PriceSource;
  livePrice?: bigint;
  liquidationPrice?: bigint;
  ratio?: bigint;
  /**
   * quoteTokenPrice reverted outside any pause or freeze (or answered no data), so
   * liquidate and liquidateViaPool would revert or the keeper has no price to size at:
   * nothing may be sent.
   */
  blocked?: { reason: string; primaryPrice: bigint | undefined };
  /**
   * Set when the decision rests on no contract price (an unreachable RPC): the vault is
   * alerted but nothing is sent, since the keeper sizes only from quoteTokenPrice.
   */
  alertOnly?: boolean;
}

export interface VaultUnderTest {
  owner: Address;
  collateralToken: Address;
  liquidationRatio: bigint;
}

const readVault = (
  deps: KeeperJobDeps,
  config: KeeperConfig,
  functionName: string,
  args: readonly unknown[]
): Promise<unknown> =>
  deps.read.readContract({ address: config.goldVaultAddress, abi: goldVaultKeeperAbi, functionName, args });

const readLiquidationPrice = async (
  deps: KeeperJobDeps,
  config: KeeperConfig,
  owner: Address
): Promise<bigint> =>
  expectBigInt(await readVault(deps, config, 'getLiquidationPrice', [owner]), 'getLiquidationPrice');

/** The primary feed alone, or why it is unusable: an invalid round or a failed read. */
const readPrimaryPrice = async (
  deps: KeeperJobDeps,
  config: KeeperConfig,
  token: Address
): Promise<{ price: bigint } | { failure: string }> => {
  try {
    const tuple = expectTuple(
      await deps.read.readContract({
        address: config.goldOracleAddress,
        abi: goldOracleKeeperAbi,
        functionName: 'getValidatedPrice',
        args: [token],
      }),
      2,
      'getValidatedPrice'
    );
    const price = expectBigInt(tuple[0], 'getValidatedPrice.price');
    const ok = expectBoolean(tuple[1], 'getValidatedPrice.ok');
    return ok && price > 0n ? { price } : { failure: 'getValidatedPrice returned ok = false' };
  } catch (error) {
    return { failure: `getValidatedPrice reverted: ${describeError(error)}` };
  }
};

/** The stale ratio gate, always flagged degraded so blindness is never silent. */
const decideAtLastKnown = async (
  deps: KeeperJobDeps,
  config: KeeperConfig,
  owner: Address,
  liquidationRatio: bigint,
  detail: string
): Promise<LiquidationDecision> => {
  const ratio = expectBigInt(
    await readVault(deps, config, 'getCollateralisationRatio', [owner]),
    'getCollateralisationRatio'
  );
  return {
    liquidatable: ratio < liquidationRatio,
    degraded: true,
    detail,
    priceSource: 'last-known',
    ratio,
  };
};

/**
 * getLiquidationPrice is oracle free: the 8 decimal gold price at which this vault
 * crosses its liquidation ratio. Against a price in the same units, `price < threshold`
 * is an exact test, and the ratio follows linearly with no further read.
 */
const decideAtPrice = async (
  deps: KeeperJobDeps,
  config: KeeperConfig,
  owner: Address,
  liquidationRatio: bigint,
  priced: { price: bigint; source: PriceSource; degradedDetail?: string }
): Promise<LiquidationDecision> => {
  const { price, source, degradedDetail } = priced;
  const base = {
    degraded: degradedDetail !== undefined,
    ...(degradedDetail !== undefined ? { detail: degradedDetail } : {}),
    priceSource: source,
    livePrice: price,
  };
  const liquidationPrice = await readLiquidationPrice(deps, config, owner);
  if (liquidationPrice === 0n) {
    // No collateral or no debt; the caller already handles the bad-debt case.
    return { ...base, liquidatable: false };
  }
  return {
    ...base,
    liquidatable: price < liquidationPrice,
    liquidationPrice,
    // ratio_live = liquidationRatio * price / liquidationPrice: not stale, unlike
    // getCollateralisationRatio, which matters because an on-call human reads it.
    ratio: (liquidationRatio * price) / liquidationPrice,
  };
};

const decideAtPrimary = async (
  deps: KeeperJobDeps,
  config: KeeperConfig,
  vault: VaultUnderTest,
  degradedDetail?: string
): Promise<LiquidationDecision> => {
  const primary = await readPrimaryPrice(deps, config, vault.collateralToken);
  if ('failure' in primary) {
    const detail = degradedDetail === undefined ? primary.failure : `${degradedDetail}; ${primary.failure}`;
    return decideAtLastKnown(deps, config, vault.owner, vault.liquidationRatio, detail);
  }
  return decideAtPrice(deps, config, vault.owner, vault.liquidationRatio, {
    price: primary.price,
    source: 'primary-feed',
    ...(degradedDetail !== undefined ? { degradedDetail } : {}),
  });
};

/** A pause changes the entry point, never the settlement price used to select a vault. */
const decideAtEmergency = async (
  deps: KeeperJobDeps,
  config: KeeperConfig,
  vault: VaultUnderTest,
  pause: PauseState
): Promise<LiquidationDecision> => {
  // A freeze alone deliberately stops every seizure. Keep the primary as an alert
  // filter there; attemptEmergencyLiquidation will report the contract's refusal.
  if (!pause.vaultPaused && !pause.oraclePaused) return decideAtPrimary(deps, config, vault);
  let price: bigint;
  try {
    price = expectBigInt(
      await deps.read.readContract({
        address: config.goldOracleAddress,
        abi: goldOracleKeeperAbi,
        functionName: 'getEmergencyPrice',
        args: [vault.collateralToken, pause.vaultPaused],
      }),
      'getEmergencyPrice'
    );
    if (price <= 0n) throw new Error('getEmergencyPrice returned a non-positive price');
  } catch (error) {
    // The execution path still re-reads and validates the emergency quote before
    // any transaction; this weaker price only selects a candidate for that assessment.
    return decideAtPrimary(deps, config, vault, `getEmergencyPrice unavailable: ${describeError(error)}`);
  }
  return decideAtPrice(deps, config, vault.owner, vault.liquidationRatio, {
    price,
    source: 'getEmergencyPrice',
  });
};

/**
 * quoteTokenPrice reverted with no pause or freeze behind it ("No reliable price": C or G
 * is unhealthy), or answered no data. Nothing is sent. C, when it is still valid, filters
 * which vaults are worth an alert: the rule price sits at gold or above it and within m of
 * gold, so while PAXG trades near gold a vault healthy at C would be healthy at the price
 * the rule gives once both feeds answer again. A vault is reported blocked otherwise, and
 * every vault is while C itself is invalid.
 */
const assessBlocked = async (
  deps: KeeperJobDeps,
  config: KeeperConfig,
  vault: VaultUnderTest,
  reason: string
): Promise<LiquidationDecision> => {
  const primary = await readPrimaryPrice(deps, config, vault.collateralToken);
  const primaryPrice = 'price' in primary ? primary.price : undefined;
  const liquidationPrice = await readLiquidationPrice(deps, config, vault.owner);
  const liquidatable =
    liquidationPrice > 0n && (primaryPrice === undefined || primaryPrice < liquidationPrice);
  return {
    liquidatable,
    degraded: false,
    priceSource: 'quoteTokenPrice',
    liquidationPrice,
    ...(primaryPrice !== undefined && liquidationPrice > 0n
      ? { ratio: (vault.liquidationRatio * primaryPrice) / liquidationPrice }
      : {}),
    blocked: { reason, primaryPrice },
  };
};

/**
 * The price the walk screens a token's vaults against, or undefined when every vault must
 * take the full decision. A vault whose
 * liquidation price is zero or not above it is one decideLiquidatability would call not
 * liquidatable, and would report nothing for:
 *   - a quote: decideAtPrice compares the same two figures;
 *   - a refusal outside any pause, or no data: assessBlocked reports only a vault that
 *     looks liquidatable at C, so a valid primary price screens; an invalid one does not;
 *   - a pause, or an unreachable RPC: the emergency price or the stale ratio decides, so
 *     nothing screens.
 * Read once per token while its quote is current, so a refusal costs its pause and primary
 * reads once rather than for every vault.
 */
export const screenPrice = async (
  deps: KeeperJobDeps,
  config: KeeperConfig,
  token: Address,
  quote: PriceQuote
): Promise<bigint | undefined> => {
  switch (quote.kind) {
    case 'ok':
      return quote.price;
    case 'unreachable':
      return undefined;
    case 'revert':
      if (isPaused(await readPauseState(deps, config, token))) return undefined;
      break;
    case 'no-data':
      break;
  }
  const primary = await readPrimaryPrice(deps, config, token);
  return 'price' in primary ? primary.price : undefined;
};

/**
 * Decide liquidatability at the price the CONTRACT will use.
 *
 * `quote` is quoteTokenPrice for the vault's token, read by the caller and shared with the
 * token's other vaults only while it is current:
 *   - a price: the decision and the sizing are exact at it;
 *   - a revert while the oracle or vault is paused or the token frozen: the normal paths
 *     revert anyway and the emergency path judges and sizes at getEmergencyPrice, so the
 *     emergency quote also selects the vault; a raw primary above the liquidation cap
 *     must not hide a vault that is liquidatable at the contract's settlement price;
 *   - any other revert ("No reliable price": C or G is unhealthy): blocked, nothing is
 *     sent, and liquidation resumes by itself on the first healthy pair;
 *   - no data: an oracle from before the final pricing rules: blocked, nothing is sent;
 *   - an unreachable RPC: the stale ratio decides the alert, flagged degraded, and
 *     nothing is sent.
 */
export const decideLiquidatability = async (
  deps: KeeperJobDeps,
  config: KeeperConfig,
  vault: VaultUnderTest,
  quote: PriceQuote
): Promise<LiquidationDecision> => {
  switch (quote.kind) {
    case 'ok':
      return decideAtPrice(deps, config, vault.owner, vault.liquidationRatio, {
        price: quote.price,
        source: 'quoteTokenPrice',
      });
    case 'unreachable':
      return {
        ...(await decideAtLastKnown(
          deps,
          config,
          vault.owner,
          vault.liquidationRatio,
          `quoteTokenPrice unreachable: ${quote.detail}; nothing is sent, since the keeper sizes liquidations only from quoteTokenPrice`
        )),
        alertOnly: true,
      };
    case 'no-data':
      return assessBlocked(
        deps,
        config,
        vault,
        `quoteTokenPrice answered no data, so the oracle predates the final pricing rules: ${quote.detail}`
      );
    case 'revert': {
      const pause = await readPauseState(deps, config, vault.collateralToken);
      if (isPaused(pause)) {
        return decideAtEmergency(deps, config, vault, pause);
      }
      return assessBlocked(deps, config, vault, quote.reason);
    }
  }
};
