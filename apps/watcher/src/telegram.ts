import type { Notification } from './format';
import { describeError } from './text';

export const TELEGRAM_TIMEOUT_MS = 10_000;
/** Telegram refuses a message above 4,096 characters. */
export const TELEGRAM_MAX_LENGTH = 4_000;

export type SendFetch = (
  url: string,
  init: { method: 'POST'; headers: Record<string, string>; body: string; signal: AbortSignal }
) => Promise<{ ok: boolean; status: number }>;

/** Delivers one notification. Resolves on delivery and rejects with a scrubbed reason otherwise. */
export type Sender = (notification: Notification) => Promise<void>;

/**
 * Sends through the Telegram Bot API. A page rings; a note arrives silently. The bot token
 * sits in the request URL, so no error from here carries the URL: a failure is reported as
 * an HTTP status, a timeout or the error's scrubbed text.
 */
export const createTelegramSender = (
  credentials: { botToken: string; chatId: string },
  options: { fetch?: SendFetch; timeoutMs?: number } = {}
): Sender => {
  const request: SendFetch = options.fetch ?? ((url, init) => fetch(url, init));
  const timeoutMs = options.timeoutMs ?? TELEGRAM_TIMEOUT_MS;
  const url = `https://api.telegram.org/bot${credentials.botToken}/sendMessage`;

  return async (notification) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: { ok: boolean; status: number };
    try {
      response = await request(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: credentials.chatId,
          text: notification.text.slice(0, TELEGRAM_MAX_LENGTH),
          disable_notification: notification.severity !== 'page',
          disable_web_page_preview: true,
        }),
        signal: controller.signal,
      });
    } catch (error) {
      throw new Error(
        controller.signal.aborted
          ? `Telegram did not answer within ${timeoutMs} ms`
          : `the request to Telegram failed (${describeError(error).split(credentials.botToken).join('<token>')})`
      );
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) throw new Error(`Telegram answered HTTP ${response.status}`);
  };
};

/** The dry-run sender: the message goes to the given writer and nowhere else. */
export const createPrintingSender =
  (write: (text: string) => void): Sender =>
  async (notification) => {
    write(`----- ${notification.severity} -----\n${notification.text}\n`);
  };
