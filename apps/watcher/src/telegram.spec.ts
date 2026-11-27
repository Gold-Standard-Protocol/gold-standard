import { createPrintingSender, createTelegramSender, TELEGRAM_MAX_LENGTH } from './telegram';
import type { SendFetch } from './telegram';

const TOKEN = '123456789:AAAbbbCCCdddEEEfffGGGhhhIIIjjjKKKll';
const credentials = { botToken: TOKEN, chatId: '-100123' };

const capture = (answer: { ok: boolean; status: number } = { ok: true, status: 200 }) => {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const fetch: SendFetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) as Record<string, unknown> });
    return answer;
  };
  return { calls, fetch };
};

describe('createTelegramSender', () => {
  it('posts a page with sound and a note silently, to the configured chat', async () => {
    const { calls, fetch } = capture();
    const send = createTelegramSender(credentials, { fetch });
    await send({ severity: 'page', text: 'PAGE: x' });
    await send({ severity: 'note', text: 'NOTE: y' });
    expect(calls[0].url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
    expect(calls[0].body).toEqual({ chat_id: '-100123', text: 'PAGE: x', disable_notification: false, disable_web_page_preview: true });
    expect(calls[1].body['disable_notification']).toBe(true);
  });

  it('cuts a message Telegram would refuse for its length', async () => {
    const { calls, fetch } = capture();
    await createTelegramSender(credentials, { fetch })({ severity: 'note', text: 'x'.repeat(5_000) });
    expect((calls[0].body['text'] as string).length).toBe(TELEGRAM_MAX_LENGTH);
  });

  it('rejects on an HTTP error with the status and no token', async () => {
    const { fetch } = capture({ ok: false, status: 401 });
    await expect(createTelegramSender(credentials, { fetch })({ severity: 'note', text: 'y' })).rejects.toThrow(
      /^Telegram answered HTTP 401$/
    );
  });

  it('rejects on a failed request without the token, even when the error quotes the URL', async () => {
    const fetch: SendFetch = async (url) => {
      throw new Error(`request to ${url} failed, token ${TOKEN}`);
    };
    const error = await createTelegramSender(credentials, { fetch })({ severity: 'note', text: 'y' }).catch((e: Error) => e);
    expect((error as Error).message).toContain('the request to Telegram failed');
    expect((error as Error).message).not.toContain(TOKEN);
    expect((error as Error).message).not.toContain('AAAbbb');
  });

  it('gives up after the timeout', async () => {
    const fetch: SendFetch = (_url, init) =>
      new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))));
    await expect(createTelegramSender(credentials, { fetch, timeoutMs: 20 })({ severity: 'note', text: 'y' })).rejects.toThrow(
      'Telegram did not answer within 20 ms'
    );
  });
});

describe('createPrintingSender', () => {
  it('writes the message and sends nothing', async () => {
    const written: string[] = [];
    await createPrintingSender((text) => written.push(text))({ severity: 'page', text: 'PAGE: x' });
    expect(written).toEqual(['----- page -----\nPAGE: x\n']);
  });
});
