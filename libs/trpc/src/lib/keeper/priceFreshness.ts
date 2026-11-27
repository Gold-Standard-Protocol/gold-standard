import type { Address } from 'viem';
import { goldOracleKeeperAbi } from './abis';
import { KEEPER_EVENTS } from './alerts';
import { configuredTokens, isActiveCollateral } from './collateral';
import type { KeeperConfig } from './config';
import { describeError, expectBigInt, expectBoolean } from './decode';
import { confirmReceipt } from './directLiquidation';
import { describeQuoteFailure, gapPpm, quoteOraclePrice } from './oracleReads';
import type { KeeperJobDeps } from './ports';

/**
 * Price-freshness watch.
 *
 * `GoldOracle.lastKnownPrice` is written only by the STATE-CHANGING reads (getTokenPrice,
 * getBorrowPrice, getReservePrice) and by the guardian's or governance's resync, so in a
 * quiet market it is simply the liquidation price of the last user transaction. It never
 * prices a seizure (the emergency path reads the live liquidation rule or refuses), but
 * GoldVault.getCollateralisationRatio, the registry's hints and the dapp read it, and a
 * record left high after a fall would make underwater vaults look healthy there.
 *
 * Each tick, per active collateral token, the job compares lastKnownPrice with
 * quoteTokenPrice (exactly what getTokenPrice would record) and, once they sit half the
 * token's gold band apart or more, calls the PERMISSIONLESS getTokenPrice to record it.
 * The band is read per token, so governance retuning goldBandPpm retunes the poke. This
 * is a convenience for the views: the oracle needs no call from the keeper to price,
 * and liquidation resumes by itself on the first healthy pair of feeds.
 *
 * The poke is deliberately silent, with nothing sent:
 *   - while the oracle is paused (getTokenPrice is whenNotPaused);
 *   - for a token that is not an active vault collateral (XAUT on a PAXG-first launch);
 *   - for a token the guardian or governance has frozen;
 *   - while quoteTokenPrice refuses ("No reliable price"): a poke would revert, and the
 *     oracle health watch reports the refusal once per tick, so a second alert here
 *     would only add noise.
 */
const JOB = 'price-freshness';

/**
 * The poke band as a divisor of the token's gold band: half of it (1% at the 2%
 * default). Wide enough that a calm market pokes rarely, tight enough that the record
 * never trails the market by more than half the distortion the rules already accept.
 */
export const POKE_THRESHOLD_DIVISOR = 2n;

const readOracle = async (
  deps: KeeperJobDeps,
  config: KeeperConfig,
  functionName: string,
  args?: readonly unknown[]
): Promise<unknown> =>
  deps.read.readContract({ address: config.goldOracleAddress, abi: goldOracleKeeperAbi, functionName, args });

/** quoteTokenPrice when it answers; undefined while it refuses. Throws on anything else. */
const readQuotedPrice = async (
  deps: KeeperJobDeps,
  config: KeeperConfig,
  token: Address
): Promise<bigint | undefined> => {
  const quote = await quoteOraclePrice(deps.read, config.goldOracleAddress, 'quoteTokenPrice', token);
  if (quote.kind === 'ok') return quote.price;
  if (quote.kind === 'revert') return undefined;
  throw new Error(`quoteTokenPrice ${quote.kind}: ${describeQuoteFailure(quote)}`);
};

const reanchor = async (
  deps: KeeperJobDeps,
  config: KeeperConfig,
  token: Address,
  move: { from: bigint; to: bigint }
): Promise<void> => {
  const { tx, log } = deps;
  if (config.dryRun || tx === undefined) {
    log.info(KEEPER_EVENTS.dryRun, { job: JOB, token, to: config.goldOracleAddress, functionName: 'getTokenPrice' });
    return;
  }
  const result = await tx.simulateAndSend({
    address: config.goldOracleAddress,
    abi: goldOracleKeeperAbi,
    functionName: 'getTokenPrice',
    args: [token],
  });
  if (!result.ok) {
    log.error(KEEPER_EVENTS.txFailed, { job: JOB, token, functionName: 'getTokenPrice', reason: result.reason });
    return;
  }
  log.info(KEEPER_EVENTS.txSent, { job: JOB, token, functionName: 'getTokenPrice', hash: result.hash });
  // Wait for the poke to mine before the tick moves on. The
  // liquidation watch runs next from the same account, and the sender refuses to sign while
  // a nonce is outstanding, so an unawaited poke turned away every liquidation of the very
  // tick in which the price had moved by half the band.
  const receipt = await confirmReceipt(tx, result.hash);
  switch (receipt.status) {
    case 'success':
    case 'unobserved':
      log.info(KEEPER_EVENTS.priceReanchored, { token, ...move, hash: result.hash });
      return;
    case 'reverted':
      log.error(KEEPER_EVENTS.txFailed, {
        job: JOB,
        token,
        functionName: 'getTokenPrice',
        hash: result.hash,
        reason: 'reverted on chain after passing simulation',
      });
      return;
    case 'unknown':
      log.error(KEEPER_EVENTS.txOutcomeUnknown, {
        job: JOB,
        token,
        functionName: 'getTokenPrice',
        hash: result.hash,
        reason: receipt.reason,
      });
      return;
  }
};

const watchToken = async (deps: KeeperJobDeps, config: KeeperConfig, token: Address): Promise<void> => {
  if (!(await isActiveCollateral(deps.read, config, token))) return;
  if (expectBoolean(await readOracle(deps, config, 'paused'), 'oracle.paused')) return;
  if (expectBoolean(await readOracle(deps, config, 'tokenFrozen', [token]), 'oracle.tokenFrozen')) return;

  const quotedPrice = await readQuotedPrice(deps, config, token);
  if (quotedPrice === undefined) return;

  const lastKnownPrice = expectBigInt(await readOracle(deps, config, 'getLastKnownPrice', [token]), 'getLastKnownPrice');
  const goldBandPpm = expectBigInt(await readOracle(deps, config, 'goldBandPpm', [token]), 'goldBandPpm');
  const pokeThreshold = goldBandPpm / POKE_THRESHOLD_DIVISOR;

  // lastKnownPrice == 0 means the token has never been read: poke unconditionally.
  const unseeded = lastKnownPrice === 0n;
  const drift = unseeded ? 0n : gapPpm(lastKnownPrice, quotedPrice);
  if (!unseeded && drift < pokeThreshold) return;

  deps.log.warn(KEEPER_EVENTS.priceStale, {
    job: JOB,
    token,
    lastKnownPrice,
    quotedPrice,
    drift,
    pokeThreshold,
    unseeded,
  });
  await reanchor(deps, config, token, { from: lastKnownPrice, to: quotedPrice });
};

export const runPriceFreshness = async (
  deps: KeeperJobDeps,
  config: KeeperConfig
): Promise<void> => {
  for (const token of configuredTokens(config)) {
    try {
      await watchToken(deps, config, token);
    } catch (error) {
      deps.log.error(KEEPER_EVENTS.jobError, {
        job: JOB,
        token,
        reason: describeError(error),
      });
    }
  }
};
