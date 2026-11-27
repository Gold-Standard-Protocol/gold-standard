import { createPublicClient, fallback, http } from 'viem';
import type { Chain } from 'viem';

import { describeError, KEEPER_EVENTS } from '@goldstandard/trpc/keeper';
import type { KeeperLogger, ReadRpcUrl } from '@goldstandard/trpc/keeper';

// Read endpoints. Every read the jobs make
// (owner lists, vault and oracle state, balances) used KEEPER_RPC_URL, often a private
// relay that exists for submission, so its rate limit or an outage blinded the keeper as
// well as silencing it. KEEPER_READ_RPC_URLS adds endpoints for those reads only, tried
// in order with KEEPER_RPC_URL last. Nonces, fee and gas estimates, simulations, sends and
// receipts stay on KEEPER_RPC_URL: the pending transaction guard must read the mempool
// its own sends went to, or it misreads a privately relayed transaction.
// No URL is logged: an entry is named by its position in the variable as written (kept by
// parseKeeperConfig through the blanks and repeats it drops), and an error that quotes one
// passes through describeError, which keeps only the scheme and host.

export type ReadRpcCheck = { ok: true; urls: readonly string[] } | { ok: false; reason: string };

/**
 * Asks every read endpoint for its chain before the keeper relies on it. One that answers
 * another chain stops the start, as KEEPER_RPC_URL does: a keeper reading the wrong network
 * would find nothing to liquidate. One that does not answer is reported and left out until
 * the next restart, so an outage at a spare provider never keeps the keeper down.
 */
export const checkReadRpcUrls = async (
  urls: readonly ReadRpcUrl[],
  chainId: number,
  getChainId: (url: string) => Promise<number>,
  log: KeeperLogger
): Promise<ReadRpcCheck> => {
  const answers = await Promise.all(
    urls.map(async ({ url, entry }) => {
      try {
        return { url, entry, chainId: await getChainId(url) };
      } catch (error) {
        return { url, entry, reason: describeError(error) };
      }
    })
  );
  const usable: string[] = [];
  for (const answer of answers) {
    const { entry } = answer;
    if ('reason' in answer) {
      log.warn(KEEPER_EVENTS.readRpcUnavailable, { entry, reason: answer.reason });
      continue;
    }
    if (answer.chainId !== chainId) {
      return {
        ok: false,
        reason: `KEEPER_READ_RPC_URLS entry ${entry} answers eth_chainId ${answer.chainId} but KEEPER_CHAIN_ID is ${chainId}; refusing to start.`,
      };
    }
    usable.push(answer.url);
  }
  return { ok: true, urls: usable };
};

/**
 * The client the jobs read through: the checked read endpoints in order, then the send
 * endpoint. viem's fallback moves to the next endpoint on a transport failure (an HTTP
 * error, a rate limit, a timeout) and never on a contract revert, which every endpoint
 * would give alike. With no read endpoint it is a plain client on the send endpoint.
 */
export const createReadPublicClient = (
  chain: Chain,
  readUrls: readonly string[],
  sendUrl: string
): ReturnType<typeof createPublicClient> => {
  const urls = [...readUrls, sendUrl];
  return createPublicClient({
    chain,
    transport: urls.length === 1 ? http(sendUrl) : fallback(urls.map((url) => http(url))),
  });
};
