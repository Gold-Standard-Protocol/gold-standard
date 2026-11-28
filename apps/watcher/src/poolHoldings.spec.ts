import { FULLY_HELD_PPM, lowestHeldShare } from './poolHoldings';

describe('lowestHeldShare', () => {
  it('reads as fully held with no token, nothing recorded, an exact match or a surplus', () => {
    expect(lowestHeldShare([])).toBe(FULLY_HELD_PPM);
    expect(lowestHeldShare([{ held: 0n, recorded: 0n }])).toBe(FULLY_HELD_PPM);
    expect(lowestHeldShare([{ held: 10n, recorded: 10n }])).toBe(FULLY_HELD_PPM);
    expect(lowestHeldShare([{ held: 14n, recorded: 10n }])).toBe(FULLY_HELD_PPM);
  });

  it('reads zero after a wipe of the whole balance', () => {
    expect(lowestHeldShare([{ held: 0n, recorded: 10n ** 19n }])).toBe(0n);
  });

  it('reports the token with the lowest share, rounded down', () => {
    expect(
      lowestHeldShare([
        { held: 10n, recorded: 10n },
        { held: 2n, recorded: 3n },
        { held: 9n, recorded: 10n },
      ])
    ).toBe(666_666n);
  });

  it('is below the floor when a single unit is missing', () => {
    expect(lowestHeldShare([{ held: 10n ** 18n - 1n, recorded: 10n ** 18n }])).toBeLessThan(FULLY_HELD_PPM);
  });
});
