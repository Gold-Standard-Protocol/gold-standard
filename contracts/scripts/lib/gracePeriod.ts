/**
 * ExpiringTimelockController.GRACE_PERIOD, read so that a timelock without one (a stock
 * TimelockController, deployed before 2026-11-06) is told apart from a read that failed.
 */
import { isError } from "ethers";

/**
 * A call that reverted with no revert data: what a contract answers for a function it lacks
 * when it has no fallback.
 *
 * Through a JSON-RPC endpoint ethers v6 (JsonRpcApiProvider.getRpcError) turns every error body
 * an eth_call returns into a CALL_EXCEPTION: a rate limit (-32005), "header not found", an
 * internal error or an upstream timeout all arrive as one, with data null. It fills the data only
 * when the node's message says it reverted and carries hex data, so data "0x" is an empty revert
 * (and the contract layer may have rebuilt that error without the node's body). Data null is an
 * empty revert only when the node's own error, which ethers keeps at info.error, says it reverted
 * (geth answers an empty revert with -32000 "execution reverted" and no data field); otherwise
 * it is a failed read and must not be taken for a missing function. The in-process Hardhat
 * network throws its own revert error, with no ethers code and data "0x".
 */
export function revertedWithoutData(error: unknown): boolean {
  if (isError(error, "CALL_EXCEPTION")) {
    if (error.data === "0x") return true;
    return error.data === null && nodeSaysReverted(error.info?.error);
  }
  if (typeof error !== "object" || error === null) return false;
  const { code, data } = error as { code?: unknown; data?: unknown };
  return code === undefined && data === "0x";
}

/** True when the node's JSON-RPC error body mentions a revert anywhere in it (message or data). */
function nodeSaysReverted(nodeError: unknown): boolean {
  if (nodeError === undefined || nodeError === null) return false;
  try {
    return /revert/i.test(JSON.stringify(nodeError));
  } catch {
    return false;
  }
}

/**
 * The timelock's GRACE_PERIOD in seconds, or undefined when it has none. Call it only once the
 * same address has answered another timelock read, so that a revert with no data can only mean
 * the function is missing. Any other failure is rethrown: taking it for "no grace period" would
 * treat a matured operation as executable for ever.
 */
export async function readGracePeriod(read: () => Promise<bigint>): Promise<bigint | undefined> {
  try {
    return await read();
  } catch (error: unknown) {
    if (revertedWithoutData(error)) return undefined;
    throw error;
  }
}
