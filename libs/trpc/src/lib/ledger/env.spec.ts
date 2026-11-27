import { DEFAULT_LEDGER_CONFIRMATIONS, getLedgerConfig, parseLedgerConfig, resetLedgerConfigForTests } from './env';

const VAULT = '0x5FbDB2315678afecb367f032d93F642f64180aa3';
const POOL = '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512';

const indexerEnv = {
  SEPOLIA_RPC_URL: 'https://rpc.example.org/v1',
  GOLD_VAULT_ADDRESS: VAULT,
  GOLD_VAULT_DEPLOY_BLOCK: '100',
  INDEXER_CHAIN_ID: '1',
};
const onEnv = {
  ...indexerEnv,
  LEDGER_START_TIMESTAMP: '1800000000',
  LEDGER_STABILITY_POOL_ADDRESS: POOL.toLowerCase(),
};

const reasonOf = (env: Record<string, string | undefined>): string => {
  const result = parseLedgerConfig(env);
  if (result.ok || !('reason' in result)) throw new Error('expected a dormant result with a reason');
  return result.reason;
};

describe('parseLedgerConfig', () => {
  it('is off, with no reason, when the start is unset or blank', () => {
    expect(parseLedgerConfig(indexerEnv)).toEqual({ ok: false, disabled: true });
    expect(parseLedgerConfig({ ...onEnv, LEDGER_START_TIMESTAMP: '' })).toEqual({ ok: false, disabled: true });
    expect(parseLedgerConfig({ ...onEnv, LEDGER_START_TIMESTAMP: '   ' })).toEqual({ ok: false, disabled: true });
    expect(parseLedgerConfig({})).toEqual({ ok: false, disabled: true });
  });

  it('is on with the indexer settings reused and the default confirmations', () => {
    expect(parseLedgerConfig(onEnv)).toEqual({
      ok: true,
      config: {
        rpcUrl: 'https://rpc.example.org/v1',
        chainId: 1,
        vault: VAULT,
        pool: POOL,
        deployBlock: 100n,
        startTimestamp: 1_800_000_000,
        confirmations: DEFAULT_LEDGER_CONFIRMATIONS,
        maxAddresses: 125_000,
      },
    });
    expect(DEFAULT_LEDGER_CONFIRMATIONS).toBe(12);
  });

  it('takes LEDGER_CONFIRMATIONS from 0 to 1000', () => {
    const confirmations = (raw: string): unknown => {
      const result = parseLedgerConfig({ ...onEnv, LEDGER_CONFIRMATIONS: raw });
      return result.ok ? result.config.confirmations : undefined;
    };
    expect(confirmations('0')).toBe(0);
    expect(confirmations('1000')).toBe(1000);
    expect(confirmations(' 30 ')).toBe(30);
  });

  it.each(['abc', '-5', '1.5', '1599999999', '4102444801', '1e9', '0x6b49d200', '18000000000000000000000'])(
    'is dormant with a reason for the start %p',
    (raw) => {
      expect(reasonOf({ ...onEnv, LEDGER_START_TIMESTAMP: raw })).toContain('LEDGER_START_TIMESTAMP');
    }
  );

  it('accepts the bounds of the start range', () => {
    expect(parseLedgerConfig({ ...onEnv, LEDGER_START_TIMESTAMP: '1600000000' }).ok).toBe(true);
    expect(parseLedgerConfig({ ...onEnv, LEDGER_START_TIMESTAMP: '4102444800' }).ok).toBe(true);
  });

  it.each([undefined, '', '0x1234', 'not an address', '0x0000000000000000000000000000000000000000', `${POOL}00`])(
    'is dormant with a reason for the pool address %p',
    (raw) => {
      expect(reasonOf({ ...onEnv, LEDGER_STABILITY_POOL_ADDRESS: raw })).toContain('LEDGER_STABILITY_POOL_ADDRESS');
    }
  );

  it.each(['-1', '1001', '2.5', 'many'])('is dormant with a reason for the confirmations %p', (raw) => {
    expect(reasonOf({ ...onEnv, LEDGER_CONFIRMATIONS: raw })).toContain('LEDGER_CONFIRMATIONS');
  });

  it('is dormant with a reason when the indexer environment is absent or invalid', () => {
    expect(reasonOf({ ...onEnv, SEPOLIA_RPC_URL: undefined })).toContain('indexer environment');
    expect(reasonOf({ ...onEnv, GOLD_VAULT_ADDRESS: 'nope' })).toContain('indexer environment');
    expect(reasonOf({ ...onEnv, GOLD_VAULT_DEPLOY_BLOCK: undefined })).toContain('indexer environment');
  });

  it('never throws, whatever the values', () => {
    const junk = ['', ' ', 'x', '-1', '{}', '\n', '9'.repeat(400), '0x', 'null'];
    for (const start of junk) {
      for (const pool of junk) {
        expect(() =>
          parseLedgerConfig({ ...indexerEnv, LEDGER_START_TIMESTAMP: start, LEDGER_STABILITY_POOL_ADDRESS: pool, LEDGER_CONFIRMATIONS: start, SEPOLIA_RPC_URL: pool })
        ).not.toThrow();
      }
    }
  });
});

describe('getLedgerConfig', () => {
  const saved = { ...process.env };
  let errorLog: jest.SpyInstance;

  beforeEach(() => {
    resetLedgerConfigForTests();
    for (const name of Object.keys(onEnv)) delete process.env[name];
    delete process.env['LEDGER_CONFIRMATIONS'];
    errorLog = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    errorLog.mockRestore();
    process.env = { ...saved };
    resetLedgerConfigForTests();
  });

  it('is undefined and silent while the ledger is off', () => {
    expect(getLedgerConfig()).toBeUndefined();
    expect(getLedgerConfig()).toBeUndefined();
    expect(errorLog).not.toHaveBeenCalled();
  });

  it('is undefined and logs the reason once while dormant', () => {
    process.env['LEDGER_START_TIMESTAMP'] = 'soon';
    expect(getLedgerConfig()).toBeUndefined();
    expect(getLedgerConfig()).toBeUndefined();
    expect(errorLog).toHaveBeenCalledTimes(1);
    expect(errorLog).toHaveBeenCalledWith(expect.stringContaining('Usage ledger dormant: LEDGER_START_TIMESTAMP'));
  });

  it('returns the configuration when everything is set', () => {
    Object.assign(process.env, onEnv);
    expect(getLedgerConfig()?.startTimestamp).toBe(1_800_000_000);
    expect(errorLog).not.toHaveBeenCalled();
  });
});

describe('parseLedgerConfig: no end', () => {
  it('ignores a leftover end variable: the ledger records for as long as it is on', () => {
    const plain = parseLedgerConfig(onEnv);
    const result = parseLedgerConfig({ ...onEnv, LEDGER_END_TIMESTAMP: '1900000000' });
    expect(result).toEqual(plain);
    expect(result.ok && 'endTimestamp' in result.config).toBe(false);
  });

  it('is turned on by the LEDGER_ variables alone', () => {
    const renamed = Object.fromEntries(Object.entries(onEnv).map(([name, value]) => [name.replace(/^LEDGER_/, 'USAGE_'), value]));
    expect(parseLedgerConfig(renamed)).toEqual({ ok: false, disabled: true });
  });
});

describe('parseLedgerConfig: LEDGER_MAX_ADDRESSES', () => {
  const capOf = (raw: string | undefined): number | undefined => {
    const result = parseLedgerConfig({ ...onEnv, LEDGER_MAX_ADDRESSES: raw });
    return result.ok ? result.config.maxAddresses : undefined;
  };

  it('is 125,000 when unset or blank', () => {
    expect(capOf(undefined)).toBe(125_000);
    expect(capOf('  ')).toBe(125_000);
  });

  it('takes a whole number from 1,000 to 2,000,000', () => {
    expect(capOf('1000')).toBe(1_000);
    expect(capOf(' 600000 ')).toBe(600_000);
    expect(capOf('2000000')).toBe(2_000_000);
  });

  it.each(['999', '2000001', '0', '-5', '1e6', '250000.5', 'many', '0x3d090'])('is dormant with a reason for %p', (raw) => {
    expect(reasonOf({ ...onEnv, LEDGER_MAX_ADDRESSES: raw })).toBe('LEDGER_MAX_ADDRESSES must be a whole number from 1000 to 2000000.');
  });
});

describe('parseLedgerConfig, liquidity dimension', () => {
  const LIQUIDITY_POOL = '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0';
  const MANAGER = '0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9';
  const liquidityOf = (env: Record<string, string | undefined>): unknown => {
    const result = parseLedgerConfig({ ...onEnv, ...env });
    if (!result.ok) throw new Error('expected a usable configuration');
    return result.config.liquidity;
  };

  it('is off, with no liquidity key at all, when neither variable is set or both are blank', () => {
    const result = parseLedgerConfig(onEnv);
    expect(result.ok && 'liquidity' in result.config).toBe(false);
    expect(liquidityOf({ LEDGER_LIQUIDITY_POOL_ADDRESS: '', LEDGER_LIQUIDITY_POSITION_MANAGER: '  ' })).toBeUndefined();
  });

  it('is on with both addresses, checksummed, whatever case they were written in', () => {
    expect(
      liquidityOf({
        LEDGER_LIQUIDITY_POOL_ADDRESS: LIQUIDITY_POOL.toLowerCase(),
        LEDGER_LIQUIDITY_POSITION_MANAGER: ` ${MANAGER} `,
      })
    ).toEqual({ pool: LIQUIDITY_POOL, positionManager: MANAGER });
  });

  it('is dormant, naming both variables, when exactly one is set', () => {
    expect(reasonOf({ ...onEnv, LEDGER_LIQUIDITY_POOL_ADDRESS: LIQUIDITY_POOL })).toBe(
      'LEDGER_LIQUIDITY_POOL_ADDRESS is set but LEDGER_LIQUIDITY_POSITION_MANAGER is not: the liquidity dimension needs both, or neither to stay off.'
    );
    expect(reasonOf({ ...onEnv, LEDGER_LIQUIDITY_POSITION_MANAGER: MANAGER, LEDGER_LIQUIDITY_POOL_ADDRESS: ' ' })).toBe(
      'LEDGER_LIQUIDITY_POSITION_MANAGER is set but LEDGER_LIQUIDITY_POOL_ADDRESS is not: the liquidity dimension needs both, or neither to stay off.'
    );
  });

  it.each(['0x1234', 'pool', '0x0000000000000000000000000000000000000000', `${LIQUIDITY_POOL}00`])(
    'is dormant with a reason for the pool address %p',
    (raw) => {
      expect(reasonOf({ ...onEnv, LEDGER_LIQUIDITY_POOL_ADDRESS: raw, LEDGER_LIQUIDITY_POSITION_MANAGER: MANAGER })).toBe(
        'LEDGER_LIQUIDITY_POOL_ADDRESS must be a 20 byte hex address other than the zero address.'
      );
    }
  );

  it('is dormant with a reason for a position manager that is not an address', () => {
    expect(reasonOf({ ...onEnv, LEDGER_LIQUIDITY_POOL_ADDRESS: LIQUIDITY_POOL, LEDGER_LIQUIDITY_POSITION_MANAGER: 'npm' })).toBe(
      'LEDGER_LIQUIDITY_POSITION_MANAGER must be a 20 byte hex address other than the zero address.'
    );
  });

  it('is dormant when both variables name the same address', () => {
    expect(
      reasonOf({ ...onEnv, LEDGER_LIQUIDITY_POOL_ADDRESS: LIQUIDITY_POOL, LEDGER_LIQUIDITY_POSITION_MANAGER: LIQUIDITY_POOL.toLowerCase() })
    ).toMatch(/name the same address/);
  });

  it('stays off, whatever the liquidity variables say, while the ledger itself is off', () => {
    expect(parseLedgerConfig({ ...indexerEnv, LEDGER_LIQUIDITY_POOL_ADDRESS: 'nonsense' })).toEqual({ ok: false, disabled: true });
  });
});
