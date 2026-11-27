import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";
import { describeErrorStack } from "./lib/redact";

/**
 * Opens a modest vault on a testnet deployment so the protocol is not empty.
 *
 * A fresh deployment has no vaults, which means redemption has no target and the
 * redeem page cannot be exercised at all. This also gives the stability pool
 * something to be pointed at and puts real numbers on the reserves page.
 * Testnet only.
 */
async function main() {
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  if (chainId === 1) throw new Error("Refusing to seed a position on mainnet.");

  const snapshotPath = path.join(__dirname, "..", "deployments", `${network.name}.json`);
  const dep = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
  const { vault } = dep.addresses;
  const paxg = dep.config.paxgToken;

  const [signer] = await ethers.getSigners();
  const collateral = ethers.parseUnits(process.env.SEED_COLLATERAL ?? "40", 18);
  const debt = ethers.parseUnits(process.env.SEED_DEBT ?? "40000", 18);

  const token = await ethers.getContractAt("MockERC20", paxg, signer);
  const goldVault = await ethers.getContractAt("GoldVault", vault, signer);

  const bal = await token.balanceOf(signer.address);
  console.log(`Signer ${signer.address} holds ${ethers.formatUnits(bal, 18)} PAXG`);
  if (bal < collateral) throw new Error("Not enough PAXG to seed.");

  console.log(`Approving ${ethers.formatUnits(collateral, 18)} PAXG...`);
  await (await token.approve(vault, collateral)).wait();

  console.log(`Depositing...`);
  await (await goldVault.deposit(paxg, collateral)).wait();

  console.log(`Minting ${ethers.formatUnits(debt, 18)} GSUSD...`);
  await (await goldVault.mint(debt)).wait();

  const pos = await goldVault.vaults(signer.address);
  const ratio = await goldVault.getCollateralisationRatio(signer.address);
  console.log(`\nVault: ${ethers.formatUnits(pos[1], 18)} PAXG / ${ethers.formatUnits(pos[2], 18)} GSUSD`);
  console.log(`Ratio: ${Number(ratio) / 10000}%`);
}

main().catch((e) => {
  console.error(describeErrorStack(e));
  process.exitCode = 1;
});
