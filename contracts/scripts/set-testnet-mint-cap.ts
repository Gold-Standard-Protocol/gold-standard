/**
 * Testnet only: set the per-block mint cap. 0 disarms the breaker.
 *
 * The cap bounds how much GSUSD can be minted in one block, so an oracle fault or a
 * flash-loan sized position cannot print an unbounded amount before anyone can react.
 * deploy.ts arms it at 50,000 GSUSD. On a testnet the deployer still holds
 * GOVERNANCE_ROLE, so this script adjusts it directly; on mainnet it is a governance
 * proposal, and the recommendation is to keep it armed and sized to the debt ceiling.
 *
 *   MINT_CAP_GSUSD=0 npx hardhat run scripts/set-testnet-mint-cap.ts --network sepolia
 */
import { ethers, network } from "hardhat";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describeErrorStack } from "./lib/redact";
import { refuseOnMainnet } from "./lib/testnetGuard";

async function main() {
  const { chainId } = await ethers.provider.getNetwork();
  refuseOnMainnet(chainId, network.name, "Refusing on mainnet: use governance.");
  const snap = JSON.parse(readFileSync(resolve(__dirname, "../deployments", `${network.name}.json`), "utf8"));
  const cap = ethers.parseEther(process.env.MINT_CAP_GSUSD ?? "0");
  const [signer] = await ethers.getSigners();
  const vault = await ethers.getContractAt("GoldVault", snap.addresses.vault, signer);
  const before = await vault.perBlockMintCap();
  const tx = await vault.setPerBlockMintCap(cap);
  await tx.wait();
  console.log(
    `perBlockMintCap ${ethers.formatEther(before)} -> ${ethers.formatEther(cap)} GSUSD` +
      `${cap === 0n ? " (breaker disarmed)" : ""} (${tx.hash})`
  );
}

main().catch((error) => {
  console.error(describeErrorStack(error));
  process.exit(1);
});
