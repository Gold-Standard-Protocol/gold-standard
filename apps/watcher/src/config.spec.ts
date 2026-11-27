import { parseWatcherConfig } from './config';

const base = {
  WATCHER_RPC_URL: 'https://rpc.example/one, https://rpc.example/two',
  WATCHER_DEPLOYMENT_FILE: '/srv/deployment.json',
  WATCHER_STATE_FILE: '/var/lib/watcher/state.json',
  TELEGRAM_BOT_TOKEN: '123456789:AAAbbbCCCdddEEEfffGGGhhhIIIjjjKKKll',
  TELEGRAM_CHAT_ID: '-1001234567890',
};

describe('parseWatcherConfig', () => {
  it('reads the required values and fills the defaults', () => {
    const config = parseWatcherConfig(base);
    expect(config.rpcUrls).toEqual(['https://rpc.example/one', 'https://rpc.example/two']);
    expect(config.telegram).toEqual({ botToken: base.TELEGRAM_BOT_TOKEN, chatId: '-1001234567890' });
    expect(config).toMatchObject({
      dryRun: false,
      pollSeconds: 60,
      vaultOwners: [],
      vaultRatioFloor: 1_250_000n,
      reserveCoverageFloor: 50_000n,
      repeatSeconds: 21_600,
      heartbeatUrl: undefined,
    });
  });

  it('checksums the vault owners and refuses one that is no address', () => {
    const owner = '0xa30072ad3e6b5a62ba86655128985d40cb681a5f';
    expect(parseWatcherConfig({ ...base, WATCHER_VAULT_OWNERS: ` ${owner} ,` }).vaultOwners).toEqual([
      '0xa30072Ad3E6B5A62ba86655128985D40cb681a5f',
    ]);
    expect(() => parseWatcherConfig({ ...base, WATCHER_VAULT_OWNERS: '0x1234' })).toThrow('not an address');
  });

  it.each(['WATCHER_RPC_URL', 'WATCHER_DEPLOYMENT_FILE', 'WATCHER_STATE_FILE'])('refuses to start without %s', (name) => {
    expect(() => parseWatcherConfig({ ...base, [name]: ' ' })).toThrow(`${name} is not set`);
  });

  it('needs the bot token and the chat unless it is a dry run', () => {
    expect(() => parseWatcherConfig({ ...base, TELEGRAM_CHAT_ID: undefined })).toThrow('TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID');
    const dry = parseWatcherConfig({ ...base, TELEGRAM_BOT_TOKEN: undefined, TELEGRAM_CHAT_ID: undefined, WATCHER_DRY_RUN: 'true' });
    expect(dry.dryRun).toBe(true);
    expect(dry.telegram).toBeUndefined();
  });

  it('refuses an RPC or heartbeat URL that is not https or carries credentials, without repeating it', () => {
    const attempt = (env: Record<string, string>): string => {
      try {
        parseWatcherConfig({ ...base, ...env });
      } catch (error) {
        return (error as Error).message;
      }
      return 'accepted';
    };
    expect(attempt({ WATCHER_RPC_URL: 'http://rpc.example/secret-key' })).toBe('WATCHER_RPC_URL must be an https URL');
    expect(attempt({ WATCHER_HEARTBEAT_URL: 'https://user:pass@hc.example/ping' })).toBe(
      'WATCHER_HEARTBEAT_URL must carry no user name or password'
    );
    expect(attempt({ WATCHER_HEARTBEAT_URL: 'not a url' })).toBe('WATCHER_HEARTBEAT_URL holds a value that is not a URL');
  });

  it('refuses a malformed token, chat, flag or number', () => {
    expect(() => parseWatcherConfig({ ...base, TELEGRAM_BOT_TOKEN: 'nonsense' })).toThrow('shape of a bot token');
    expect(() => parseWatcherConfig({ ...base, TELEGRAM_CHAT_ID: '@channel' })).toThrow('must be a number');
    expect(() => parseWatcherConfig({ ...base, WATCHER_DRY_RUN: 'yes' })).toThrow('true or false');
    expect(() => parseWatcherConfig({ ...base, WATCHER_POLL_SECONDS: '1' })).toThrow('at least 5');
    expect(() => parseWatcherConfig({ ...base, WATCHER_VAULT_RATIO_FLOOR: '1.25' })).toThrow('whole number');
  });
});
