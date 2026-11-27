import { Wallet } from "ethers";
import type { Provider } from "ethers";

/**
 * A raw-signing wallet that sends 1.3x the node's gas estimate, as Hardhat's own signers
 * do through `gasMultiplier`. A plain ethers Wallet sends the exact estimate, and on a
 * Hardhat fork the estimate is taken in a context whose timestamp can differ from the
 * block the transaction lands in: a vault write that lands a few hundred gas short of
 * the registry hook's floor reverts with "Registry gas" (seen on the attack drill).
 * Unused gas is refunded, so the buffer costs nothing when the estimate was right.
 */
export class BufferedWallet extends Wallet {
  override async estimateGas(tx: Parameters<Wallet["estimateGas"]>[0]): Promise<bigint> {
    return ((await super.estimateGas(tx)) * 13n) / 10n;
  }
}

export const freshBufferedWallet = (provider: Provider): BufferedWallet =>
  new BufferedWallet(Wallet.createRandom().privateKey, provider);
