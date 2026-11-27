import { randomBytes } from 'node:crypto';
import type { Redis } from 'ioredis';
import { newAccount } from './account';
import type { LedgerAccount } from './account';
import type { LedgerMeta } from './codec';
import { LedgerIntegrityError } from './errors';
import { ledgerKeys } from './keys';
import type { LedgerKeys } from './keys';
import { LEDGER_STATE_TTL_MS } from './limits';
import { genesisMeta, newStateId } from './meta';
import { createLedgerRedis } from './redis';
import { createLedgerStore } from './store';
import type { LedgerStore } from './store';
import { testConfig } from './testSupport';

// Runs against a real Redis when REDIS_HOST is set (REDIS_HOST=127.0.0.1 npx nx test trpc);
// skipped otherwise. Every key sits under a vault scope made for this run and is deleted after.
const describeWithRedis = process.env['REDIS_HOST'] ? describe : describe.skip;

const addr = (n: number): string => `0x${n.toString(16).padStart(40, '0')}`;
const account = (debt: bigint): LedgerAccount => ({ ...newAccount(1_800_000_000), debt });
const position = (owner: number, liquidity: bigint) => ({
  owner: addr(owner),
  liquidity,
  tickLower: -276_330,
  tickUpper: -276_320,
  value: liquidity * 2n,
});

describeWithRedis('ledger store on Redis', () => {
  const config = testConfig({ vault: `0x${randomBytes(20).toString('hex')}` });
  let redis: Redis;
  let second: Redis;
  let keys: LedgerKeys;
  let store: LedgerStore;
  let base: LedgerMeta;

  const nextMeta = (meta: LedgerMeta, overrides: Partial<LedgerMeta> = {}): LedgerMeta => ({
    ...meta,
    stateId: newStateId(),
    ...overrides,
  });

  beforeAll(() => {
    redis = createLedgerRedis('ledger store spec');
    second = createLedgerRedis('ledger store spec, second writer');
    keys = ledgerKeys(config.chainId, config.vault);
    store = createLedgerStore(redis, keys);
  });

  beforeEach(async () => {
    await redis.del(...Object.values(keys));
    base = genesisMeta(config, []);
    await store.reset(base);
  });

  afterAll(async () => {
    await redis.del(...Object.values(keys));
    redis.disconnect();
    second.disconnect();
  });

  it('holds three keys and nothing that cannot be recomputed from the chain', () => {
    expect(Object.keys(keys).sort()).toEqual(['accounts', 'meta', 'positions']);
  });

  it('reads back the meta it was reset with, and undefined for an unreadable one', async () => {
    expect(await store.readMeta()).toEqual(base);
    expect(await store.readMetaRaw()).toBe(await redis.get(keys.meta));
    await redis.set(keys.meta, '{"v":1}');
    expect(await store.readMeta()).toBeUndefined();
    await redis.del(keys.meta);
    expect(await store.readMeta()).toBeUndefined();
    expect(await store.readMetaRaw()).toBeNull();
  });

  it('commits accounts and meta together and reads them back', async () => {
    const meta = nextMeta(base, { cursor: '10', accounts: 2 });
    const accepted = await store.commit(base.stateId, {
      meta,
      accounts: new Map([
        [addr(1), account(5n)],
        [addr(2), { ...account(2n ** 200n), liquidity: 9n, liquidityRaw: 2n ** 150n }],
      ]),
    });
    expect(accepted).toBe(true);
    expect(await store.readMeta()).toEqual(meta);
    const accounts = await store.loadAccounts();
    expect(accounts.size).toBe(2);
    expect(accounts.get(addr(2))).toEqual({ ...account(2n ** 200n), liquidity: 9n, liquidityRaw: 2n ** 150n });
    const view = await store.readAccountView(addr(1));
    expect(view.meta).toBe(await redis.get(keys.meta));
    expect(view.account).toBe(await redis.hget(keys.accounts, addr(1)));
    expect(await store.readAccountView(addr(3))).toEqual({ meta: view.meta, account: null });
  });

  it('lists every address and reads records as stored, in the order asked, for the download', async () => {
    const many = new Map(Array.from({ length: 1_250 }, (_, n) => [addr(n + 1), account(BigInt(n))] as const));
    await store.commit(base.stateId, { meta: nextMeta(base, { accounts: many.size }), accounts: many });
    const addresses = await store.listAddresses();
    expect(addresses).toHaveLength(1_250);
    expect([...addresses].sort()[0]).toBe(addr(1));
    const raw = await store.readAccountsRaw([addr(700), addr(999_999), addr(2)]);
    expect(raw[0]).toBe(await redis.hget(keys.accounts, addr(700)));
    expect(raw[1]).toBeNull();
    expect(raw[2]).toBe(await redis.hget(keys.accounts, addr(2)));
    expect(await store.readAccountsRaw([])).toEqual([]);
  });

  it('writes many accounts in one commit and scans them all back', async () => {
    const many = new Map(Array.from({ length: 1_250 }, (_, n) => [addr(n + 1), account(BigInt(n))] as const));
    expect(await store.commit(base.stateId, { meta: nextMeta(base, { accounts: many.size }), accounts: many })).toBe(true);
    const loaded = await store.loadAccounts();
    expect(loaded.size).toBe(1_250);
    expect(loaded.get(addr(1_250))?.debt).toBe(1_249n);
  });

  it('refuses a commit, writing nothing, when the state id moved', async () => {
    const stale = await store.commit('0000000000000000', {
      meta: nextMeta(base),
      accounts: new Map([[addr(1), account(1n)]]),
      positions: new Map([['9', position(4, 1n)]]),
    });
    expect(stale).toBe(false);
    expect((await store.loadAccounts()).size).toBe(0);
    expect((await store.loadPositions()).size).toBe(0);
    expect(await store.readMeta()).toEqual(base);
  });

  it('refuses a commit whose meta another connection replaced between the read and the write', async () => {
    const other = createLedgerStore(second, keys);
    const get = redis.get.bind(redis);
    let raced = false;
    jest.spyOn(redis, 'get').mockImplementation(async (key) => {
      const value = await get(key as string);
      if (!raced) {
        raced = true;
        await other.commit(base.stateId, { meta: nextMeta(base, { cursor: '99' }), accounts: new Map() });
      }
      return value;
    });
    const accepted = await store.commit(base.stateId, { meta: nextMeta(base), accounts: new Map([[addr(1), account(1n)]]) });
    jest.restoreAllMocks();
    expect(accepted).toBe(false);
    expect((await store.readMeta())?.cursor).toBe('99');
    expect((await store.loadAccounts()).size).toBe(0);
  });

  it('refreshes the seven day TTL of every key on every commit', async () => {
    const first = nextMeta(base);
    await store.commit(base.stateId, { meta: first, accounts: new Map([[addr(1), account(1n)]]), positions: new Map([['7', position(1, 5n)]]) });
    for (const key of Object.values(keys)) await redis.pexpire(key, 1_000_000);
    await store.commit(first.stateId, { meta: nextMeta(first), accounts: new Map() });
    for (const key of Object.values(keys)) {
      expect(await redis.pttl(key)).toBeGreaterThan(LEDGER_STATE_TTL_MS - 60_000);
    }
  });

  it('has no way to delete an address record: a commit only adds and replaces them', async () => {
    const first = nextMeta(base, { accounts: 2 });
    await store.commit(base.stateId, {
      meta: first,
      accounts: new Map([
        [addr(1), account(1n)],
        [addr(2), account(2n)],
      ]),
    });
    // A field the store once honoured is ignored now.
    const withRemoved = { meta: nextMeta(first, { accounts: 3 }), accounts: new Map([[addr(3), account(3n)]]), removed: [addr(1)] };
    await store.commit(first.stateId, withRemoved);
    expect([...(await store.loadAccounts()).keys()].sort()).toEqual([addr(1), addr(2), addr(3)]);
  });

  it('commits liquidity positions with the meta, deletes the ones a commit removes and resets them', async () => {
    const first = nextMeta(base, { cursor: '10', lp: { tick: -276_325, positions: 2 } });
    expect(
      await store.commit(base.stateId, {
        meta: first,
        accounts: new Map(),
        positions: new Map([
          ['7', position(1, 5n)],
          ['12345678901234567890', position(2, 2n ** 127n)],
        ]),
      })
    ).toBe(true);
    expect(await store.loadPositions()).toEqual(
      new Map([
        ['7', position(1, 5n)],
        ['12345678901234567890', position(2, 2n ** 127n)],
      ])
    );
    expect((await store.readMeta())?.lp).toEqual({ tick: -276_325, positions: 2 });

    const second = nextMeta(first, { lp: { tick: -276_325, positions: 1 } });
    await store.commit(first.stateId, { meta: second, accounts: new Map(), positions: new Map([['7', position(3, 6n)]]), positionsRemoved: ['12345678901234567890'] });
    expect(await store.loadPositions()).toEqual(new Map([['7', position(3, 6n)]]));

    await store.reset(genesisMeta(config, []));
    expect((await store.loadPositions()).size).toBe(0);
  });

  it('resets every key and installs the new meta with its TTL', async () => {
    const first = nextMeta(base, { accounts: 1 });
    await store.commit(base.stateId, { meta: first, accounts: new Map([[addr(1), account(1n)]]) });
    const fresh = genesisMeta(config, [7]);
    await store.reset(fresh);
    expect(await store.readMeta()).toEqual(fresh);
    expect(await redis.exists(keys.accounts, keys.positions)).toBe(0);
    expect(await redis.pttl(keys.meta)).toBeGreaterThan(LEDGER_STATE_TTL_MS - 60_000);
  });

  it('fails loudly on an unreadable account record or liquidity position', async () => {
    await redis.hset(keys.accounts, addr(1), '{"d":"oops"}');
    await expect(store.loadAccounts()).rejects.toThrow(LedgerIntegrityError);
    await redis.hset(keys.positions, '7', '{"o":"nobody"}');
    await expect(store.loadPositions()).rejects.toThrow(LedgerIntegrityError);
  });
});
