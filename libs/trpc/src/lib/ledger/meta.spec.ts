import { decodeMeta, encodeMeta } from './codec';
import { ledgerKeys } from './keys';
import { KEY_NAMESPACE } from '../config/redisConfig';
import { REBUILD_WINDOW_MS } from './limits';
import { decodePool, encodePool, genesisMeta, newStateId, ledgerFingerprint, recentRebuilds } from './meta';
import { GENESIS_POOL } from './poolMirror';
import { TEST_LIQUIDITY, testConfig } from './testSupport';

describe('ledger meta', () => {
  const config = testConfig();

  it('fingerprints everything a stored figure depends on', () => {
    const base = ledgerFingerprint(config);
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(ledgerFingerprint(testConfig())).toBe(base);
    expect(ledgerFingerprint(testConfig({ chainId: 1 }))).not.toBe(base);
    expect(ledgerFingerprint(testConfig({ vault: '0x00000000000000000000000000000000000000dD' }))).not.toBe(base);
    expect(ledgerFingerprint(testConfig({ pool: '0x00000000000000000000000000000000000000dD' }))).not.toBe(base);
    expect(ledgerFingerprint(testConfig({ deployBlock: 101n }))).not.toBe(base);
    expect(ledgerFingerprint(testConfig({ startTimestamp: config.startTimestamp + 1 }))).not.toBe(base);
  });

  it('is pinned for the test configuration, so a change to what it covers is deliberate', () => {
    expect(ledgerFingerprint(config)).toBe('60e9f5c6eaa6f17f910c7fb94c9fafa0a63104fb3d4369566c6705b5bb38c7c7');
  });

  it('includes the liquidity dimension, and is unchanged for a ledger without it', () => {
    const base = ledgerFingerprint(config);
    expect(ledgerFingerprint(testConfig({ liquidity: undefined }))).toBe(base);
    const on = ledgerFingerprint(testConfig({ liquidity: TEST_LIQUIDITY }));
    expect(on).not.toBe(base);
    expect(ledgerFingerprint(testConfig({ liquidity: { ...TEST_LIQUIDITY } }))).toBe(on);
    const otherPool = { ...TEST_LIQUIDITY, pool: '0x00000000000000000000000000000000000000dD' as const };
    const otherManager = { ...TEST_LIQUIDITY, positionManager: '0x00000000000000000000000000000000000000dD' as const };
    expect(ledgerFingerprint(testConfig({ liquidity: otherPool }))).not.toBe(on);
    expect(ledgerFingerprint(testConfig({ liquidity: otherManager }))).not.toBe(on);
    const lowercase = { pool: TEST_LIQUIDITY.pool.toLowerCase() as `0x${string}`, positionManager: TEST_LIQUIDITY.positionManager };
    expect(ledgerFingerprint(testConfig({ liquidity: lowercase }))).toBe(on);
  });

  it('gives the genesis meta a liquidity record only while the source is on', () => {
    expect(genesisMeta(config, [])).not.toHaveProperty('lp');
    const meta = genesisMeta(testConfig({ liquidity: TEST_LIQUIDITY }), []);
    expect(meta.lp).toEqual({ tick: null, positions: 0 });
    expect(decodeMeta(encodeMeta(meta))).toEqual(meta);
  });

  it('includes the address cap, so raising it recomputes the ledger in full', () => {
    const base = ledgerFingerprint(config);
    expect(ledgerFingerprint(testConfig({ maxAddresses: config.maxAddresses }))).toBe(base);
    expect(ledgerFingerprint(testConfig({ maxAddresses: config.maxAddresses + 1 }))).not.toBe(base);
  });

  it('does not depend on the RPC endpoint, the confirmation depth or the address case', () => {
    const base = ledgerFingerprint(config);
    expect(ledgerFingerprint(testConfig({ rpcUrl: 'https://other.example.org' }))).toBe(base);
    expect(ledgerFingerprint(testConfig({ confirmations: 64 }))).toBe(base);
    expect(ledgerFingerprint(testConfig({ vault: config.vault.toLowerCase() as `0x${string}` }))).toBe(base);
  });

  it('starts an index at the genesis pool with no cursor and the syncing stamp', () => {
    const meta = genesisMeta(config, [5]);
    expect(meta).toMatchObject({ v: 1, cursor: null, asOfTimestamp: 0, accounts: 0, truncated: false, syncedAt: 'syncing', rebuilds: [5] });
    expect(decodePool(meta.pool)).toEqual(GENESIS_POOL);
    expect(decodeMeta(encodeMeta(meta))).toEqual(meta);
  });

  it('makes a new 16 hex state id each time', () => {
    const ids = new Set(Array.from({ length: 50 }, () => newStateId()));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{16}$/);
  });

  it('round trips a pool', () => {
    const pool = { P: 123n, scale: 4n, epoch: 5n, total: 2n ** 130n };
    expect(decodePool(encodePool(pool))).toEqual(pool);
  });

  it('keeps only the rebuilds of the last 24 hours', () => {
    const now = 1_900_000_000_000;
    expect(recentRebuilds([now - REBUILD_WINDOW_MS, now - REBUILD_WINDOW_MS + 1, now - 5, now + 10], now)).toEqual([
      now - REBUILD_WINDOW_MS + 1,
      now - 5,
    ]);
  });
});

describe('ledgerKeys', () => {
  it('scopes every key by namespace, chain and lowercase vault', () => {
    const keys = ledgerKeys(1, '0x5FbDB2315678afecb367f032d93F642f64180aa3');
    const scope = `${KEY_NAMESPACE}:ledger:v1:1:0x5fbdb2315678afecb367f032d93f642f64180aa3`;
    expect(keys).toEqual({
      meta: `${scope}:meta`,
      accounts: `${scope}:accounts`,
      positions: `${scope}:positions`,
    });
    expect(ledgerKeys(11155111, '0x5FbDB2315678afecb367f032d93F642f64180aa3').meta).not.toBe(keys.meta);
  });
});
