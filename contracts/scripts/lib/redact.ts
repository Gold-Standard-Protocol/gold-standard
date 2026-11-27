/**
 * Error text that is safe to print. An RPC URL carries the provider key in its path, and
 * ethers and Hardhat embed the request URL in the errors they throw, so every top-level
 * catch in the launch scripts goes through here before anything reaches a terminal or a
 * ceremony log. Same rule as the keeper's describeError.
 */
const URL_PATTERN = /https?:\/\/[^\s"'<>)\]]+/g;

export const redactUrls = (text: string): string =>
  text.replace(URL_PATTERN, (match) => {
    try {
      const url = new URL(match);
      return url.username === "" && url.password === ""
        ? `${url.origin}/<redacted>`
        : `${url.protocol}//<redacted>@${url.host}/<redacted>`;
    } catch {
      return "<redacted-url>";
    }
  });

/** One line for an unknown thrown value: the message of an Error, the string of anything else, URLs redacted. */
export const describeError = (error: unknown): string =>
  redactUrls(error instanceof Error ? error.message : String(error));

/** The stack of an Error (its message included) for a script that prints one, URLs redacted. */
export const describeErrorStack = (error: unknown): string =>
  redactUrls(error instanceof Error && error.stack ? error.stack : String(error));
