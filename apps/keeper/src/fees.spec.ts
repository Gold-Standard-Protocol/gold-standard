import { boundFees, replacementFees } from './fees';

const GWEI = 10n ** 9n;
const CEILINGS = { maxFeePerGasWei: 150n * GWEI, maxPriorityFeePerGasWei: 3n * GWEI };

describe('boundFees', () => {
  it('passes an estimate under both ceilings through unchanged', () => {
    const decision = boundFees(
      { maxFeePerGas: 40n * GWEI, maxPriorityFeePerGas: 1n * GWEI },
      CEILINGS
    );
    expect(decision).toEqual({
      ok: true,
      fees: { maxFeePerGas: 40n * GWEI, maxPriorityFeePerGas: 1n * GWEI },
    });
  });

  it('clamps the priority fee to its ceiling', () => {
    const decision = boundFees(
      { maxFeePerGas: 40n * GWEI, maxPriorityFeePerGas: 20n * GWEI },
      CEILINGS
    );
    expect(decision).toEqual({
      ok: true,
      fees: { maxFeePerGas: 40n * GWEI, maxPriorityFeePerGas: 3n * GWEI },
    });
  });

  it('refuses to send when the max fee exceeds its ceiling and says by how much', () => {
    const decision = boundFees(
      { maxFeePerGas: 151n * GWEI, maxPriorityFeePerGas: 1n * GWEI },
      CEILINGS
    );
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.reason).toContain('151 gwei');
      expect(decision.reason).toContain('150 gwei');
    }
  });

  it('never lets the priority fee exceed the max fee', () => {
    const decision = boundFees(
      { maxFeePerGas: 2n * GWEI, maxPriorityFeePerGas: 3n * GWEI },
      CEILINGS
    );
    expect(decision).toEqual({
      ok: true,
      fees: { maxFeePerGas: 2n * GWEI, maxPriorityFeePerGas: 2n * GWEI },
    });
  });

  // Viem pads the base fee by 1.2 in its
  // estimate, so the padded figure crossed a 150 gwei ceiling at a base fee near 122.5 gwei.
  it('sends at the ceiling when the padded estimate passes it but the base fee and tip fit under it', () => {
    // Base fee 130 gwei: viem estimates 130 x 1.2 + 2 = 158 gwei.
    const decision = boundFees(
      { maxFeePerGas: 158n * GWEI, maxPriorityFeePerGas: 2n * GWEI },
      CEILINGS,
      130n * GWEI
    );
    expect(decision).toEqual({
      ok: true,
      fees: { maxFeePerGas: 150n * GWEI, maxPriorityFeePerGas: 2n * GWEI },
    });
  });

  it('clamps the priority fee before fitting the base fee under the ceiling', () => {
    // A 20 gwei tip estimate is clamped to 3, and 147 + 3 fits exactly.
    const decision = boundFees(
      { maxFeePerGas: 196n * GWEI, maxPriorityFeePerGas: 20n * GWEI },
      CEILINGS,
      147n * GWEI
    );
    expect(decision).toEqual({
      ok: true,
      fees: { maxFeePerGas: 150n * GWEI, maxPriorityFeePerGas: 3n * GWEI },
    });
  });

  it('still refuses when the base fee and the tip pass the ceiling, and names the base fee', () => {
    const decision = boundFees(
      { maxFeePerGas: 180n * GWEI, maxPriorityFeePerGas: 1n * GWEI },
      CEILINGS,
      // One wei past the edge: 149 gwei and a wei, plus a 1 gwei tip.
      149n * GWEI + 1n
    );
    expect(decision.ok).toBe(false);
    expect(!decision.ok && decision.reason).toContain('base fee 149.000000001 gwei');
    expect(!decision.ok && decision.reason).toContain('150 gwei');
  });
});

describe('replacementFees', () => {
  it('raises both fees 12.5% over those the stuck transaction was sent with', () => {
    const decision = replacementFees(
      { maxFeePerGas: 40n * GWEI, maxPriorityFeePerGas: 1n * GWEI },
      { maxFeePerGas: 30n * GWEI, maxPriorityFeePerGas: 1n * GWEI },
      CEILINGS
    );
    expect(decision).toEqual({
      ok: true,
      fees: { maxFeePerGas: 45n * GWEI, maxPriorityFeePerGas: 1_125_000_000n },
    });
  });

  it('follows a network that has moved further than the bump', () => {
    const decision = replacementFees(
      { maxFeePerGas: 40n * GWEI, maxPriorityFeePerGas: 1n * GWEI },
      { maxFeePerGas: 100n * GWEI, maxPriorityFeePerGas: 2n * GWEI },
      CEILINGS
    );
    expect(decision).toEqual({
      ok: true,
      fees: { maxFeePerGas: 100n * GWEI, maxPriorityFeePerGas: 2n * GWEI },
    });
  });

  it('clamps a fresh priority estimate to its ceiling, as for any send', () => {
    const decision = replacementFees(
      { maxFeePerGas: 40n * GWEI, maxPriorityFeePerGas: 1n * GWEI },
      { maxFeePerGas: 100n * GWEI, maxPriorityFeePerGas: 20n * GWEI },
      CEILINGS
    );
    expect(decision).toEqual({
      ok: true,
      fees: { maxFeePerGas: 100n * GWEI, maxPriorityFeePerGas: 3n * GWEI },
    });
  });

  it('bumps the fresh estimate when the original fees are unknown after a restart', () => {
    const decision = replacementFees(
      undefined,
      { maxFeePerGas: 40n * GWEI, maxPriorityFeePerGas: 2n * GWEI },
      CEILINGS
    );
    expect(decision).toEqual({
      ok: true,
      fees: { maxFeePerGas: 45n * GWEI, maxPriorityFeePerGas: 2_250_000_000n },
    });
  });

  it('refuses a replacement whose max fee would pass KEEPER_MAX_FEE_GWEI', () => {
    const decision = replacementFees(
      { maxFeePerGas: 140n * GWEI, maxPriorityFeePerGas: 1n * GWEI },
      { maxFeePerGas: 100n * GWEI, maxPriorityFeePerGas: 1n * GWEI },
      CEILINGS
    );
    expect(decision.ok).toBe(false);
    expect(!decision.ok && decision.reason).toContain('KEEPER_MAX_FEE_GWEI');
    expect(!decision.ok && decision.reason).toContain('157.5 gwei');
  });

  it('allows the one bump a priority clamped to KEEPER_MAX_PRIORITY_FEE_GWEI needs', () => {
    // The usual stuck transaction went out at the priority ceiling itself (boundFees clamps
    // every send to it), so its replacement must be allowed one bump above the ceiling or
    // no replacement is ever possible.
    const decision = replacementFees(
      { maxFeePerGas: 40n * GWEI, maxPriorityFeePerGas: 3n * GWEI },
      { maxFeePerGas: 40n * GWEI, maxPriorityFeePerGas: 1n * GWEI },
      CEILINGS
    );
    expect(decision).toEqual({
      ok: true,
      fees: { maxFeePerGas: 45n * GWEI, maxPriorityFeePerGas: 3_375_000_000n },
    });
  });

  it('refuses a replacement whose priority fee would pass one bump over KEEPER_MAX_PRIORITY_FEE_GWEI', () => {
    const decision = replacementFees(
      { maxFeePerGas: 40n * GWEI, maxPriorityFeePerGas: 3_375_000_000n },
      { maxFeePerGas: 40n * GWEI, maxPriorityFeePerGas: 1n * GWEI },
      CEILINGS
    );
    expect(decision.ok).toBe(false);
    expect(!decision.ok && decision.reason).toContain('one bump over the KEEPER_MAX_PRIORITY_FEE_GWEI');
  });

  it('never offers a max fee below the priority fee', () => {
    const decision = replacementFees(
      { maxFeePerGas: 1n * GWEI, maxPriorityFeePerGas: 1n * GWEI },
      { maxFeePerGas: 1n * GWEI, maxPriorityFeePerGas: 3n * GWEI },
      CEILINGS
    );
    expect(decision).toEqual({
      ok: true,
      fees: { maxFeePerGas: 3n * GWEI, maxPriorityFeePerGas: 3n * GWEI },
    });
  });
});
