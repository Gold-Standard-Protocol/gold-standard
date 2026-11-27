/**
 * Testnet only: ramp a fresh deployment's debt ceilings so testers can mint.
 *
 * deploy.ts ships every ceiling at 0 (the safe value is the one you get by
 * omission) and docs/LAUNCH.md ramps it by governance. On a testnet the deployer
 * still holds GOVERNANCE_ROLE, so this script performs that step directly through
 * GoldVault.setDebtCeiling, which changes nothing but the ceiling: no ratio is re-sent,
 * so none can be restored to a stale value.
 *
 *   CEILING_GSUSD=250000 npx hardhat run scripts/ramp-testnet-ceiling.ts --network sepolia
 */
import { ethers, network } from "hardhat";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { assertDebtCeilingSupported } from "./lib/ceilingProposal";
import { describeErrorStack } from "./lib/redact";
import { refuseOnMainnet } from "./lib/testnetGuard";

async function main() {
  const { chainId } = await ethers.provider.getNetwork();
  refuseOnMainnet(chainId, network.name, "Refusing to ramp ceilings on mainnet: use governance.");
  const snapshotPath = resolve(__dirname, "../deployments", `${network.name}.json`);
  const snap = JSON.parse(readFileSync(snapshotPath, "utf8"));
  const ceiling = ethers.parseEther(process.env.CEILING_GSUSD ?? "250000");
  const [signer] = await ethers.getSigners();
  // Before anything is sent: a deployment from before 2026-11-06 has no setDebtCeiling, and
  // the first transaction would revert without a reason.
  await assertDebtCeilingSupported(ethers.provider, { vault: snap.addresses.vault, token: snap.config.paxgToken });
  const vault = await ethers.getContractAt("GoldVault", snap.addresses.vault, signer);

  const targets = [
    ["paxg", snap.config.paxgToken],
    ["xaut", snap.config.xautToken],
  ] as const;
  for (const [key, token] of targets) {
    const tx = await vault.setDebtCeiling(token, ceiling);
    await tx.wait();
    console.log(`${key.toUpperCase()} ceiling -> ${ethers.formatEther(ceiling)} GSUSD (${tx.hash})`);
  }
  console.log("Next: npx hardhat run scripts/refresh-deployment-snapshot.ts --network", network.name);
}

main().catch((error) => {
  console.error(describeErrorStack(error));
  process.exit(1);
});
