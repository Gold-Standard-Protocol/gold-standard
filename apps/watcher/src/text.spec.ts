import { createJsonLogger, describeError, scrub } from './text';

describe('scrub', () => {
  it('cuts a URL to its host, dropping the path, the query and any credentials', () => {
    expect(scrub('failed: https://eth-mainnet.example/v2/secret-key?x=1 again')).toBe('failed: https://eth-mainnet.example/… again');
    expect(scrub('https://user:pass@hc.example/ping/uuid')).toBe('https://hc.example/…');
  });

  it('removes anything shaped like a bot token', () => {
    expect(scrub('bot 123456789:AAAbbbCCCdddEEEfffGGGhhhIIIjjjKKKll said no')).toBe('bot <token> said no');
    expect(scrub('https://api.telegram.org/bot123456789:AAAbbbCCCdddEEEfffGGGhhhIIIjjjKKKll/sendMessage')).not.toContain('AAAbbb');
  });
});

describe('describeError', () => {
  it('takes the message of an error, scrubbed and bounded', () => {
    expect(describeError(new Error('URL: https://rpc.example/key'))).toBe('URL: https://rpc.example/…');
    expect(describeError('x'.repeat(1_000))).toHaveLength(300);
  });
});

describe('createJsonLogger', () => {
  it('writes one JSON line with level and event, and big integers as text', () => {
    const lines: string[] = [];
    createJsonLogger((line) => lines.push(line)).warn('watcher.test', { block: 12n });
    expect(lines).toHaveLength(1);
    expect(lines[0].endsWith('\n')).toBe(true);
    expect(JSON.parse(lines[0])).toMatchObject({ level: 'warn', event: 'watcher.test', block: '12' });
  });
});
