/**
 * Open the liquidation victim's vault on the local end-to-end chain (apps/dapp-e2e).
 *
 * The victim is the node's account #2, so the node signs for it. It deposits a little
 * PAXG and mints close to the minimum ratio, so that the price walk the liquidation suite
 * performs later (scripts/walk-testnet-price.ts down to $3,000 from the mocks' $4,000)
 * takes it under the 110% liquidation ratio without taking it under 100%. Refuses to run
 * anywhere but e2e.
 *
 *   E2E_VICTIM=0x3C44... VICTIM_PAXG=0.5 VICTIM_DEBT=1400 \
 *     npx hardhat run scripts/e2e-victim.ts --network e2e
 */
import { ethers, network } from "hardhat";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describeError } from "./lib/redact";

// Hardhat's deterministic account #2; #0 deploys, #1 is the dapp's wallet.
const HARDHAT_ACCOUNT_2 = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";

async function main() {
  if (network.name !== "e2e") {
    throw new Error(`Refusing on ${network.name}: this opens a throwaway vault on the local end-to-end chain only.`);
  }
  const snap = JSON.parse(readFileSync(resolve(__dirname, "../deployments/e2e.json"), "utf8"));
  const victim = await ethers.getSigner(ethers.getAddress(process.env.E2E_VICTIM ?? HARDHAT_ACCOUNT_2));
  const collateral = ethers.parseUnits(process.env.VICTIM_PAXG ?? "0.5", 18);
  const debt = ethers.parseUnits(process.env.VICTIM_DEBT ?? "1400", 18);

  const paxg = await ethers.getContractAt("MockERC20", snap.config.paxgToken, victim);
  const vault = await ethers.getContractAt("GoldVault", snap.addresses.vault, victim);

  await (await paxg.mint(victim.address, collateral)).wait();
  await (await paxg.approve(snap.addresses.vault, collateral)).wait();
  await (await vault.deposit(snap.config.paxgToken, collateral)).wait();
  await (await vault.mint(debt)).wait();

  const ratio: bigint = await vault.getCollateralisationRatio(victim.address);
  console.log(
    `Victim ${victim.address}: ${ethers.formatUnits(collateral, 18)} PAXG against ${ethers.formatEther(debt)} GSUSD, ` +
      `ratio ${Number(ratio) / 10_000}%`
  );
}

main().catch((error) => {
  console.error(describeError(error));
  process.exit(1);
});
