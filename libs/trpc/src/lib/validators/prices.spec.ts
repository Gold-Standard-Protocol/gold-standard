import { pricesSchema } from './prices';

/** The ids TOKEN_LIST carries today (libs/constants/src/lib/tokens.ts). */
const KNOWN_IDS = ['pax-gold', 'tether-gold', 'gold-standard-usd'];

describe('pricesSchema', () => {
  it('accepts every price id the token list uses', () => {
    expect(pricesSchema.safeParse({ priceIds: KNOWN_IDS }).success).toBe(true);
    expect(pricesSchema.safeParse({ priceIds: [] }).success).toBe(true);
  });

  it('rejects ids that are not lowercase slugs, oversized ids and oversized lists', () => {
    expect(pricesSchema.safeParse({ priceIds: ['PAX-GOLD'] }).success).toBe(false);
    expect(pricesSchema.safeParse({ priceIds: ['pax gold'] }).success).toBe(false);
    expect(pricesSchema.safeParse({ priceIds: ['__proto__'] }).success).toBe(false);
    expect(pricesSchema.safeParse({ priceIds: ['a'.repeat(65)] }).success).toBe(false);
    expect(pricesSchema.safeParse({ priceIds: Array.from({ length: 51 }, () => 'pax-gold') }).success).toBe(false);
    expect(pricesSchema.safeParse({ priceIds: 'pax-gold' }).success).toBe(false);
  });

  it('rejects an oversized invalid collection without allocating an error per entry', () => {
    const result = pricesSchema.safeParse({ priceIds: Array(5_000).fill(null) });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues).toHaveLength(1);
  });
});
