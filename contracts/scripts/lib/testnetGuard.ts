/**
 * The first check of every testnet-only script that writes as the deployer. It reads the
 * chain id the RPC reports, as open-throwaway-vault.ts and seed-testnet-position.ts do, and
 * keeps the network name check too: a Hardhat network entry pointing at chain 1 under
 * another name used to pass a name-only guard.
 */
import { MAINNET_CHAIN_ID } from "./mainnetAddresses";

export function refuseOnMainnet(chainId: bigint | number, networkName: string, refusal: string): void {
  if (BigInt(chainId) === BigInt(MAINNET_CHAIN_ID) || networkName === "mainnet") throw new Error(refusal);
}
