import type { LiquidityFacts } from './chainClient';
import { LedgerLiquiditySourceError } from './errors';
import type { LiquidityConfig, LiquiditySource } from './liquidity';

const DOLLAR_DECIMALS = 18;

const same = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();

/**
 * Checks what the chain says about the configured pool and answers the pool the index
 * records. The pool must be the one the position manager's factory holds for its two tokens
 * and fee, so the positions the manager reports really are positions of this pool; one of
 * the two tokens must be the deployment's GSUSD; and neither token may have more than 18
 * decimals, the precision the value at the peg is kept in. The other token is taken to be
 * worth one dollar: that is the operator's statement in naming this pool, not something the
 * chain can confirm.
 */
export const resolveLiquiditySource = (config: LiquidityConfig, facts: LiquidityFacts): LiquiditySource => {
  if (!same(facts.factoryPool, config.pool)) {
    throw new LedgerLiquiditySourceError(
      `LEDGER_LIQUIDITY_POOL_ADDRESS ${config.pool} is not the pool that the factory of LEDGER_LIQUIDITY_POSITION_MANAGER ${config.positionManager} holds for its tokens and fee (that pool is ${facts.factoryPool})`
    );
  }
  if (!same(facts.token0, facts.stablecoin) && !same(facts.token1, facts.stablecoin)) {
    throw new LedgerLiquiditySourceError(
      `LEDGER_LIQUIDITY_POOL_ADDRESS ${config.pool} pairs ${facts.token0} with ${facts.token1}; neither is the GSUSD token of this deployment (${facts.stablecoin})`
    );
  }
  for (const [token, decimals] of [
    [facts.token0, facts.decimals0],
    [facts.token1, facts.decimals1],
  ] as const) {
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > DOLLAR_DECIMALS) {
      throw new LedgerLiquiditySourceError(
        `the pool token ${token} has ${String(decimals)} decimals; the liquidity dimension supports at most ${DOLLAR_DECIMALS}`
      );
    }
  }
  return {
    pool: config.pool,
    positionManager: config.positionManager,
    token0: facts.token0,
    token1: facts.token1,
    fee: facts.fee,
    decimals0: facts.decimals0,
    decimals1: facts.decimals1,
  };
};
