import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LedgerIntegrityError } from './errors';
import {
  anchor,
  compounded,
  depositAfterClaim,
  depositAfterDeposit,
  depositAfterWithdraw,
  EMPTY_DEPOSIT,
  GENESIS_POOL,
  poolAfterAbsorption,
  poolAfterDeposit,
  poolAfterWithdraw,
} from './poolMirror';
import type { DepositSnapshot, PoolState } from './poolMirror';

interface VectorStep {
  event: { kind: string; account?: string; amount?: string; debt?: string };
  pool: { P: string; scale: string; epoch: string; total: string };
  deposits: Record<string, string>;
}

const vectors = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'poolMirrorVectors.json'), 'utf8')) as {
  steps: VectorStep[];
};
const steps = vectors.steps;

const asStrings = (pool: PoolState): VectorStep['pool'] => ({
  P: pool.P.toString(),
  scale: pool.scale.toString(),
  epoch: pool.epoch.toString(),
  total: pool.total.toString(),
});

// The vectors were recorded from StabilityPool.sol on a Hardhat network by
// fixtures/generate-pool-vectors.cjs: after every step, P, currentScale, currentEpoch,
// totalDeposits and getEffectiveDeposit of every depositor.
describe('pool mirror against vectors recorded from the contract', () => {
  it('covers a scale change, a depositor two scales behind, an epoch reset and re-anchoring claims', () => {
    const scales = new Set(steps.map((step) => step.pool.scale));
    const epochs = new Set(steps.map((step) => step.pool.epoch));
    expect(scales).toEqual(new Set(['0', '1', '2']));
    expect(epochs).toEqual(new Set(['0', '1']));
    expect(steps.filter((step) => step.event.kind === 'claim').length).toBeGreaterThanOrEqual(3);
  });

  it('equals the contract after every step', () => {
    let pool = GENESIS_POOL;
    const deposits = new Map<string, DepositSnapshot>();
    steps.forEach((step, index) => {
      const { event } = step;
      const name = event.account ?? '';
      const current = deposits.get(name) ?? EMPTY_DEPOSIT;
      if (event.kind === 'deposit') {
        deposits.set(name, depositAfterDeposit(current, pool, BigInt(event.amount ?? '0')));
        pool = poolAfterDeposit(pool, BigInt(event.amount ?? '0'));
      } else if (event.kind === 'withdraw') {
        deposits.set(name, depositAfterWithdraw(current, pool, BigInt(event.amount ?? '0')));
        pool = poolAfterWithdraw(pool, BigInt(event.amount ?? '0'));
      } else if (event.kind === 'claim') {
        deposits.set(name, depositAfterClaim(current, pool));
      } else {
        pool = poolAfterAbsorption(pool, BigInt(event.debt ?? '0'));
      }
      expect({ step: index, ...asStrings(pool) }).toEqual({ step: index, ...step.pool });
      for (const [depositor, expected] of Object.entries(step.deposits)) {
        const mirrored = compounded(deposits.get(depositor) ?? EMPTY_DEPOSIT, pool);
        expect({ step: index, depositor, value: mirrored.toString() }).toEqual({ step: index, depositor, value: expected });
      }
    });
  });
});

describe('pool mirror rules', () => {
  const pool: PoolState = { P: 5n * 10n ** 17n, scale: 3n, epoch: 2n, total: 1_000n };

  it('anchors a zero balance to the empty snapshot', () => {
    expect(anchor(pool, 0n)).toEqual(EMPTY_DEPOSIT);
    expect(anchor(pool, 7n)).toEqual({ stored: 7n, snapP: pool.P, snapScale: 3n, snapEpoch: 2n });
  });

  it('compounds to zero for an empty record, an older epoch and two scales behind', () => {
    expect(compounded(EMPTY_DEPOSIT, pool)).toBe(0n);
    expect(compounded({ stored: 10n, snapP: 0n, snapScale: 3n, snapEpoch: 2n }, pool)).toBe(0n);
    expect(compounded({ stored: 10n, snapP: pool.P, snapScale: 3n, snapEpoch: 1n }, pool)).toBe(0n);
    expect(compounded({ stored: 10n ** 30n, snapP: pool.P, snapScale: 1n, snapEpoch: 2n }, pool)).toBe(0n);
  });

  it('divides by the scale factor one scale behind', () => {
    expect(compounded({ stored: 4n * 10n ** 9n, snapP: pool.P, snapScale: 2n, snapEpoch: 2n }, pool)).toBe(4n);
  });

  it('clamps a withdrawal above the compounded balance at zero', () => {
    const deposit = anchor(pool, 5n);
    expect(depositAfterWithdraw(deposit, pool, 9n)).toEqual(EMPTY_DEPOSIT);
  });

  it('does not mutate its inputs', () => {
    const frozenPool = Object.freeze({ ...pool });
    const frozenDeposit = Object.freeze(anchor(frozenPool, 100n));
    depositAfterDeposit(frozenDeposit, frozenPool, 1n);
    depositAfterWithdraw(frozenDeposit, frozenPool, 1n);
    depositAfterClaim(frozenDeposit, frozenPool);
    poolAfterDeposit(frozenPool, 1n);
    poolAfterWithdraw(frozenPool, 1n);
    poolAfterAbsorption(frozenPool, 1n);
    expect(frozenPool).toEqual(pool);
  });

  it('refuses an absorption the contract could not have made', () => {
    expect(() => poolAfterAbsorption(pool, 1_000n)).toThrow(LedgerIntegrityError);
    expect(() => poolAfterAbsorption(pool, 1_001n)).toThrow(LedgerIntegrityError);
    expect(() => poolAfterAbsorption({ ...pool, total: 0n }, 0n)).toThrow(LedgerIntegrityError);
  });

  it('refuses a withdrawal above the mirrored total', () => {
    expect(() => poolAfterWithdraw(pool, 1_001n)).toThrow(LedgerIntegrityError);
  });
});
