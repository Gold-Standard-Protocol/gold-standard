import { z } from 'zod';
import type { LedgerAccount } from './account';
import type { LiquidityPosition } from './liquidity';
import { MAX_TICK, MIN_TICK } from './liquidityMath';

/**
 * The JSON shapes kept in Redis. Bigints travel as decimal strings. A stored value that
 * fails its schema is never used: decode answers undefined, the reader then reports the
 * index unavailable and the worker rebuilds.
 */

const MAX_DIGITS = 120;
const decimal = z.string().regex(/^\d+$/).max(MAX_DIGITS);
const lowercaseAddress = z.string().regex(/^0x[0-9a-f]{40}$/);
const seconds = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

const tick = z.number().int().min(MIN_TICK).max(MAX_TICK);

export const SYNCING = 'syncing';

const poolSchema = z.strictObject({ P: decimal, scale: decimal, epoch: decimal, total: decimal });

const metaSchema = z.strictObject({
  v: z.literal(1),
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  stateId: z.string().regex(/^[0-9a-f]{16}$/),
  cursor: decimal.nullable(),
  asOfTimestamp: seconds,
  pool: poolSchema,
  accounts: count,
  truncated: z.boolean(),
  syncedAt: z.union([z.literal(SYNCING), z.string().regex(/^\d{1,16}$/)]),
  rebuilds: z.array(count).max(64),
  /**
   * Present while the liquidity dimension is on: the pool's tick (null before the pool is
   * initialized) and how many positions the store holds.
   */
  lp: z.strictObject({ tick: tick.nullable(), positions: count }).optional(),
});

export type LedgerMeta = z.infer<typeof metaSchema>;

const accountSchema = z.strictObject({
  d: decimal,
  s: decimal,
  sp: decimal,
  ss: decimal,
  se: decimal,
  b: decimal,
  p: decimal,
  t: seconds,
  // Liquidity value in range and liquidity held over time: absent on a record that has neither.
  l: decimal.optional(),
  lr: decimal.optional(),
});

const positionSchema = z.strictObject({ o: lowercaseAddress, l: decimal, a: tick, b: tick, v: decimal });

const parseJson = (raw: string | null | undefined): unknown => {
  if (raw === null || raw === undefined) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
};

const decodeWith = <Stored, Value>(
  schema: z.ZodType<Stored>,
  build: (stored: Stored) => Value
): ((raw: string | null | undefined) => Value | undefined) =>
  (raw) => {
    const parsed = schema.safeParse(parseJson(raw));
    return parsed.success ? build(parsed.data) : undefined;
  };

export const encodeMeta = (meta: LedgerMeta): string => JSON.stringify(meta);
export const decodeMeta = decodeWith(metaSchema, (stored): LedgerMeta => stored);

export const encodeAccount = (account: LedgerAccount): string =>
  JSON.stringify({
    d: account.debt.toString(),
    s: account.stored.toString(),
    sp: account.snapP.toString(),
    ss: account.snapScale.toString(),
    se: account.snapEpoch.toString(),
    b: account.debtRaw.toString(),
    p: account.poolRaw.toString(),
    t: account.ts,
    ...(account.liquidity === 0n ? {} : { l: account.liquidity.toString() }),
    ...(account.liquidityRaw === 0n ? {} : { lr: account.liquidityRaw.toString() }),
  });

export const decodeAccount = decodeWith(
  accountSchema,
  (stored): LedgerAccount => ({
    debt: BigInt(stored.d),
    stored: BigInt(stored.s),
    snapP: BigInt(stored.sp),
    snapScale: BigInt(stored.ss),
    snapEpoch: BigInt(stored.se),
    liquidity: BigInt(stored.l ?? '0'),
    debtRaw: BigInt(stored.b),
    poolRaw: BigInt(stored.p),
    liquidityRaw: BigInt(stored.lr ?? '0'),
    ts: stored.t,
  })
);

export const encodePosition = (position: LiquidityPosition): string =>
  JSON.stringify({
    o: position.owner,
    l: position.liquidity.toString(),
    a: position.tickLower,
    b: position.tickUpper,
    v: position.value.toString(),
  });

export const decodePosition = decodeWith(
  positionSchema,
  (stored): LiquidityPosition => ({
    owner: stored.o,
    liquidity: BigInt(stored.l),
    tickLower: stored.a,
    tickUpper: stored.b,
    value: BigInt(stored.v),
  })
);
