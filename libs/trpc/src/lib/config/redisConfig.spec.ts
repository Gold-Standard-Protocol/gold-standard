import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { parseRedisConfig } from './redisConfig';

describe('parseRedisConfig', () => {
  it('falls back to localhost and reports Redis as not configured', () => {
    const parsed = parseRedisConfig({});
    expect(parsed.configured).toBe(false);
    expect(parsed.options).toEqual({
      host: '127.0.0.1',
      port: 6379,
      maxRetriesPerRequest: null,
    });
  });

  it('reads the host and port pair with the optional password and TLS flag', () => {
    const parsed = parseRedisConfig({
      REDIS_HOST: 'cache.internal',
      REDIS_PORT: '6380',
      REDIS_PASSWORD: 'hunter2',
      REDIS_TLS: 'true',
    });
    expect(parsed.configured).toBe(true);
    expect(parsed.options).toEqual({
      host: 'cache.internal',
      port: 6380,
      password: 'hunter2',
      tls: {},
      maxRetriesPerRequest: null,
    });
  });

  it('prefers REDIS_URL and carries its credentials, database and TLS scheme', () => {
    const parsed = parseRedisConfig({
      REDIS_URL: 'rediss://keeper:p%40ss@redis.example.net:6400/2',
      REDIS_HOST: 'ignored',
      REDIS_PORT: '1',
    });
    expect(parsed.configured).toBe(true);
    expect(parsed.options).toEqual({
      host: 'redis.example.net',
      port: 6400,
      username: 'keeper',
      password: 'p@ss',
      db: 2,
      tls: {},
      maxRetriesPerRequest: null,
    });
  });

  it('accepts a bare redis:// URL without TLS or credentials', () => {
    const parsed = parseRedisConfig({ REDIS_URL: 'redis://10.0.0.5' });
    expect(parsed.options).toEqual({
      host: '10.0.0.5',
      port: 6379,
      maxRetriesPerRequest: null,
    });
  });

  it('rejects a URL with another scheme', () => {
    expect(() => parseRedisConfig({ REDIS_URL: 'http://redis.example.net' })).toThrow(
      /redis:\/\/ or rediss:\/\//
    );
  });

  it('ignores an unusable port and keeps the default', () => {
    expect(parseRedisConfig({ REDIS_HOST: 'h', REDIS_PORT: 'eighty' }).options.port).toBe(6379);
    expect(parseRedisConfig({ REDIS_HOST: 'h', REDIS_PORT: '70000' }).options.port).toBe(6379);
  });

  describe('a REDIS_URL that does not parse', () => {
    // An unescaped / or # ends the authority early, so the URL parser refuses the rest.
    const PASSWORD = 'pa/ss#word';
    const MALFORMED = `rediss://default:${PASSWORD}@cache.example.net:6380/0`;

    const thrownBy = (run: () => unknown): unknown => {
      try {
        run();
      } catch (error) {
        return error;
      }
      return undefined;
    };

    it('names the variable and the likely cause', () => {
      expect(() => parseRedisConfig({ REDIS_URL: MALFORMED })).toThrow(
        'REDIS_URL is not a valid URL (percent-encode special characters in the password)'
      );
    });

    it('carries the value nowhere in the error, which node prints in full when nothing catches it', () => {
      const thrown = thrownBy(() => parseRedisConfig({ REDIS_URL: MALFORMED }));
      expect(thrown).toBeDefined();
      // The parser's own error keeps the whole input as a property; that must not survive.
      const shown = inspect(thrown, { depth: null, showHidden: true });
      expect(shown).not.toContain(PASSWORD);
      expect(shown).not.toContain('cache.example.net');
    });
  });
});

describe('redisConfig loads libs/trpc/.env first', () => {
  const VARIABLES = ['REDIS_URL', 'REDIS_HOST', 'REDIS_PORT', 'REDIS_NAMESPACE'] as const;
  let saved: Partial<Record<(typeof VARIABLES)[number], string>>;
  let directory: string;

  beforeEach(() => {
    saved = Object.fromEntries(VARIABLES.map((name) => [name, process.env[name]]));
    for (const name of VARIABLES) delete process.env[name];
    directory = mkdtempSync(join(tmpdir(), 'redis-config-'));
    mkdirSync(join(directory, 'libs', 'trpc'), { recursive: true });
    writeFileSync(
      join(directory, 'libs', 'trpc', '.env'),
      'REDIS_URL=redis://from-dotenv.test:6390\nREDIS_NAMESPACE=from-dotenv\n'
    );
    jest.spyOn(process, 'cwd').mockReturnValue(directory);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    for (const name of VARIABLES) {
      const value = saved[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(directory, { recursive: true, force: true });
  });

  it('reads REDIS_URL and REDIS_NAMESPACE from the local file when the module is the first to load', () => {
    jest.isolateModules(() => {
      const loaded = require('./redisConfig') as typeof import('./redisConfig');
      expect(loaded.redisConfig.host).toBe('from-dotenv.test');
      expect(loaded.redisConfig.port).toBe(6390);
      expect(loaded.isRedisConfigured).toBe(true);
      expect(loaded.KEY_NAMESPACE).toBe('from-dotenv');
    });
  });

  it('never overrides a variable the environment already sets', () => {
    process.env['REDIS_URL'] = 'redis://from-environment.test:6391';
    jest.isolateModules(() => {
      const loaded = require('./redisConfig') as typeof import('./redisConfig');
      expect(loaded.redisConfig.host).toBe('from-environment.test');
    });
  });
});
