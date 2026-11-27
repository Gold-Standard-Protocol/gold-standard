/**
 * Error text that is safe to log. RPC URLs carry provider keys and the Telegram URL carries
 * the bot token, so every URL is cut to its scheme and host and anything shaped like a bot
 * token is removed before the text reaches a log line or a message.
 */
const URL_PATTERN = /\b(https?:\/\/)([^\s/"'<>]+)[^\s"'<>]*/gi;
const BOT_TOKEN_PATTERN = /\b\d{6,}:[A-Za-z0-9_-]{20,}\b/g;

export const scrub = (text: string): string =>
  text
    .replace(BOT_TOKEN_PATTERN, '<token>')
    .replace(URL_PATTERN, (_match, scheme: string, authority: string) => `${scheme}${authority.replace(/^.*@/, '')}/…`);

export const describeError = (error: unknown): string => {
  const text = error instanceof Error ? error.message : String(error);
  return scrub(text).slice(0, 300);
};

const replacer = (_key: string, value: unknown): unknown => (typeof value === 'bigint' ? value.toString() : value);

export interface Logger {
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

/** One JSON line per event, with `level` and `event`, as the keeper writes them. */
export const createJsonLogger = (write: (line: string) => void): Logger => {
  const emit = (level: string, event: string, fields?: Record<string, unknown>): void =>
    write(`${JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields }, replacer)}\n`);
  return {
    info: (event, fields) => emit('info', event, fields),
    warn: (event, fields) => emit('warn', event, fields),
    error: (event, fields) => emit('error', event, fields),
  };
};
