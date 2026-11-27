import { describeError, redactUrls } from './redact';

describe('redactUrls', () => {
  it('keeps the origin and drops the path, query and fragment', () => {
    expect(
      redactUrls('request to https://eth-sepolia.g.alchemy.com/v2/abc123DEF?x=1#frag failed')
    ).toBe('request to https://eth-sepolia.g.alchemy.com/<redacted> failed');
  });

  it('hides embedded credentials as well as the path', () => {
    expect(redactUrls('http://user:secret@rpc.example.net:8545/key')).toBe(
      'http://<redacted>@rpc.example.net:8545/<redacted>'
    );
  });

  it('redacts every URL in a message and leaves other text alone', () => {
    const text =
      'HTTP request failed. URL: https://a.example.com/k1 Retrying https://b.example.com/k2 "quoted"';
    expect(redactUrls(text)).toBe(
      'HTTP request failed. URL: https://a.example.com/<redacted> Retrying https://b.example.com/<redacted> "quoted"'
    );
  });

  describe('websocket and Redis URLs', () => {
    it('redacts a wss or ws RPC endpoint, whose key sits in the path', () => {
      expect(redactUrls('socket to wss://eth-mainnet.g.alchemy.com/v2/abc123DEF closed')).toBe(
        'socket to wss://eth-mainnet.g.alchemy.com/<redacted> closed'
      );
      expect(redactUrls('ws://127.0.0.1:8546/key')).toBe('ws://127.0.0.1:8546/<redacted>');
    });

    it('hides the password of a redis or rediss URL and keeps its host', () => {
      expect(redactUrls('connect rediss://default:hunter2@cache.example.net:6380/0 failed')).toBe(
        'connect rediss://<redacted>@cache.example.net:6380/<redacted> failed'
      );
      expect(redactUrls('redis://:secret@127.0.0.1:6379')).toBe('redis://<redacted>@127.0.0.1:6379/<redacted>');
    });

    it('keeps the host of a Redis URL without credentials, which has no web origin', () => {
      expect(redactUrls('redis://cache.internal:6379/2')).toBe('redis://cache.internal:6379/<redacted>');
    });

    it('matches a scheme in capitals as well', () => {
      expect(redactUrls('HTTPS://rpc.example.net/v2/KEY and REDISS://u:p@h:1/0')).toBe(
        'https://rpc.example.net/<redacted> and rediss://<redacted>@h:1/<redacted>'
      );
    });
  });

  it('returns text without URLs unchanged', () => {
    expect(redactUrls('execution reverted: Not undercollateralised')).toBe(
      'execution reverted: Not undercollateralised'
    );
  });
});

describe('describeError', () => {
  it('redacts URLs inside an Error message', () => {
    expect(describeError(new Error('fetch https://rpc.example.net/v2/KEY timed out'))).toBe(
      'fetch https://rpc.example.net/<redacted> timed out'
    );
  });

  it('redacts URLs inside a thrown non-Error value', () => {
    expect(describeError('https://rpc.example.net/v2/KEY')).toBe(
      'https://rpc.example.net/<redacted>'
    );
  });
});
