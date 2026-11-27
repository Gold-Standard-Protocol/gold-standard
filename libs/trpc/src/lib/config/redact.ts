// Redaction for anything that reaches a log line. It lives here rather than in the keeper
// because the indexer logs RPC failures as well.

/**
 * HTTP and websocket RPC endpoints and Redis connection strings (the
 * pattern used to stop at http and https, so a wss RPC key or a rediss password in an
 * error message reached the log). Case-insensitive, since a scheme may arrive in capitals.
 */
const URL_PATTERN = /(?:https?|wss?|rediss?):\/\/[^\s"'<>)\]]+/gi;

/**
 * Replaces every URL in `text` with its scheme and host plus /<redacted>. RPC URLs carry
 * provider keys in their path or query, Redis URLs a password, and viem embeds the request
 * URL in the messages of its errors, so anything that reaches a log line goes through
 * here. The host is rebuilt from its parts because a redis: URL has no web origin.
 */
export const redactUrls = (text: string): string =>
  text.replace(URL_PATTERN, (match) => {
    try {
      const url = new URL(match);
      return url.username === '' && url.password === ''
        ? `${url.protocol}//${url.host}/<redacted>`
        : `${url.protocol}//<redacted>@${url.host}/<redacted>`;
    } catch {
      return '<redacted-url>';
    }
  });

export const describeError = (error: unknown): string =>
  redactUrls(error instanceof Error ? error.message : String(error));
