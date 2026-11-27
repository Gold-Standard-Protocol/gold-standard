import { JsonRpcProvider } from "ethers";
import type { JsonRpcError, JsonRpcPayload } from "ethers";

/** The JSON-RPC error body a node returns for a failed eth_call. */
export type NodeCallError = JsonRpcError["error"];

/** A rate limited request, as Infura and other gateways answer it. */
export const RATE_LIMITED: NodeCallError = { code: -32005, message: "rate limit exceeded" };

/** A node that has not yet seen the block it was asked about, as geth answers it. */
export const HEADER_NOT_FOUND: NodeCallError = { code: -32000, message: "header not found" };

/** An empty revert as geth answers it: no data field at all. */
export const EMPTY_REVERT_NO_DATA: NodeCallError = { code: -32000, message: "execution reverted" };

/** An empty revert as nodes that always send revert data answer it. */
export const EMPTY_REVERT_EMPTY_DATA: NodeCallError = { code: 3, message: "execution reverted", data: "0x" };

/**
 * What ethers v6 throws for an eth_call to `data` whose JSON-RPC response carried `error`.
 * JsonRpcApiProvider.getRpcError turns every such body into a CALL_EXCEPTION, a rate limit or a
 * missing header included, and fills its data only when the node's message says it reverted and
 * carries hex data. Built offline: the provider is never asked to send anything.
 */
export function ethersCallError(data: string, error: NodeCallError): Error {
  const provider = new JsonRpcProvider("http://127.0.0.1:1", 31337, { staticNetwork: true });
  try {
    const payload: JsonRpcPayload = { id: 1, jsonrpc: "2.0", method: "eth_call", params: [{ data }, "latest"] };
    return provider.getRpcError(payload, { id: 1, error });
  } finally {
    provider.destroy();
  }
}
