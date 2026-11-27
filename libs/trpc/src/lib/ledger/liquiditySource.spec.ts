import { LedgerLiquiditySourceError } from './errors';
import { resolveLiquiditySource } from './liquiditySource';
import { TEST_DOLLAR, TEST_GSUSD, TEST_LIQUIDITY, TEST_LIQUIDITY_FACTS, TEST_LIQUIDITY_POOL } from './testSupport';

const OTHER = '0x00000000000000000000000000000000000000dD';

describe('resolveLiquiditySource', () => {
  it('answers the pool as the chain describes it', () => {
    expect(resolveLiquiditySource(TEST_LIQUIDITY, TEST_LIQUIDITY_FACTS)).toEqual({
      ...TEST_LIQUIDITY,
      token0: TEST_GSUSD,
      token1: TEST_DOLLAR,
      fee: 500,
      decimals0: 18,
      decimals1: 6,
    });
  });

  it('accepts GSUSD as either token, in any address case', () => {
    const second = { ...TEST_LIQUIDITY_FACTS, token0: TEST_DOLLAR, token1: TEST_GSUSD, decimals0: 6, decimals1: 18 };
    expect(resolveLiquiditySource(TEST_LIQUIDITY, second)).toMatchObject({ token1: TEST_GSUSD, decimals0: 6 });
    const lowercase = { ...TEST_LIQUIDITY_FACTS, stablecoin: TEST_GSUSD.toLowerCase() as `0x${string}` };
    expect(resolveLiquiditySource(TEST_LIQUIDITY, lowercase).token0).toBe(TEST_GSUSD);
  });

  it('refuses a pool in which neither token is the GSUSD of the deployment, and names both', () => {
    const facts = { ...TEST_LIQUIDITY_FACTS, stablecoin: OTHER as `0x${string}` };
    expect(() => resolveLiquiditySource(TEST_LIQUIDITY, facts)).toThrow(LedgerLiquiditySourceError);
    expect(() => resolveLiquiditySource(TEST_LIQUIDITY, facts)).toThrow(/neither is the GSUSD token of this deployment/);
    expect(() => resolveLiquiditySource(TEST_LIQUIDITY, facts)).toThrow(TEST_DOLLAR);
  });

  it("refuses a pool that is not the position manager's factory's pool for the pair", () => {
    const facts = { ...TEST_LIQUIDITY_FACTS, factoryPool: OTHER as `0x${string}` };
    expect(() => resolveLiquiditySource(TEST_LIQUIDITY, facts)).toThrow(LedgerLiquiditySourceError);
    expect(() => resolveLiquiditySource(TEST_LIQUIDITY, facts)).toThrow(TEST_LIQUIDITY_POOL);
    const none = { ...TEST_LIQUIDITY_FACTS, factoryPool: '0x0000000000000000000000000000000000000000' as const };
    expect(() => resolveLiquiditySource(TEST_LIQUIDITY, none)).toThrow(/is not the pool that the factory/);
  });

  it('refuses a token with more than 18 decimals', () => {
    expect(() => resolveLiquiditySource(TEST_LIQUIDITY, { ...TEST_LIQUIDITY_FACTS, decimals1: 19 })).toThrow(
      /19 decimals; the liquidity dimension supports at most 18/
    );
    expect(() => resolveLiquiditySource(TEST_LIQUIDITY, { ...TEST_LIQUIDITY_FACTS, decimals1: 18 })).not.toThrow();
    expect(() => resolveLiquiditySource(TEST_LIQUIDITY, { ...TEST_LIQUIDITY_FACTS, decimals1: 0 })).not.toThrow();
  });
});
