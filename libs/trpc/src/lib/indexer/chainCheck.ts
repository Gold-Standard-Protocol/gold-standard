import { describeError } from '../config/redact';

/**
 * Asks the RPC endpoint which chain it serves before the first run indexes it. Whole-project
 * The viem chain object only labels the client, so an endpoint
 * for another chain than INDEXER_CHAIN_ID was scanned and its answer stored under the
 * configured chain's keys (SEPOLIA_RPC_URL names the endpoint for whichever chain is
 * selected, which makes the pairing easy to get wrong by hand). A mismatch refuses every
 * run with an error naming both ids, so the index never gets a fresh sync stamp and the API
 * keeps reporting it unavailable. A failed check skips that run only, and the next run asks
 * again; once the endpoint has answered with the configured chain it is not asked again.
 * `subject` names the job in the log lines, for the other indexers that share this check.
 */
export const createChainCheck = (
  getChainId: () => Promise<number>,
  expectedChainId: number,
  subject = 'Vault owner indexing'
): (() => Promise<boolean>) => {
  let confirmed = false;
  return async () => {
    if (confirmed) {
      return true;
    }
    try {
      const actual = await getChainId();
      if (actual !== expectedChainId) {
        console.error(
          `${subject} refused: the RPC endpoint in SEPOLIA_RPC_URL serves chain ${actual}, but INDEXER_CHAIN_ID is ${expectedChainId}; point SEPOLIA_RPC_URL at a chain ${expectedChainId} endpoint or correct INDEXER_CHAIN_ID.`
        );
        return false;
      }
      confirmed = true;
      return true;
    } catch (error) {
      // The description, never the error: viem carries the request URL, and with it the
      // provider key, in the message and as a property of its own.
      console.error(
        `${subject} skipped: the RPC endpoint did not say which chain it serves; the next run asks again:`,
        describeError(error)
      );
      return false;
    }
  };
};
