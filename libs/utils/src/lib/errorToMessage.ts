import { UserRejectedRequestError } from "./errors";

type WalletError = {
  reason?: string;
  message?: string;
  code?: number | string;
  error?: unknown;
  data?: { originalError?: unknown };
};

function asWalletError(error: unknown): WalletError | undefined {
  return typeof error === "object" && error !== null
    ? (error as WalletError)
    : undefined;
}

function getReason(error: unknown): string | undefined {
  let reason: string | undefined;
  let current = asWalletError(error);
  while (current) {
    reason = current.reason ?? current.message ?? reason;
    current = asWalletError(current.error ?? current.data?.originalError);
  }
  return reason;
}

export function didUserReject(error: unknown): boolean {
  const wallet = asWalletError(error);
  const reason = getReason(error);
  if (
    wallet?.code === 4001 ||
    // ethers v5.7.0 wrapped error
    wallet?.code === "ACTION_REJECTED" ||
    // For Rainbow :
    (reason?.match(/request/i) && reason?.match(/reject/i)) ||
    // For Frame:
    reason?.match(/declined/i) ||
    // For SafePal:
    reason?.match(/cancell?ed by user/i) ||
    // For Trust:
    reason?.match(/user cancell?ed/i) ||
    // For Coinbase:
    reason?.match(/user denied/i) ||
    // For Fireblocks
    reason?.match(/user rejected/i) ||
    error instanceof UserRejectedRequestError
  ) {
    return true;
  }
  return false;
}
