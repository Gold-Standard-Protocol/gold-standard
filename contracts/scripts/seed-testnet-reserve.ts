import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";
import { describeErrorStack } from "./lib/redact";

/**
 * Seed the Gold Stability Reserve on a testnet.
 *
 * The reserve is empty at deploy: it fills from liquidation penalties, from seeding,
 * and (Phase 2) from above-peg recycling. Until it holds gold, GSUSD has NO conversion
 * floor, and verify-deployment says so. This puts a modelled amount in so the swap
 * path can be exercised end to end.
 *
 *   SEED_PAXG=20 npx hardhat run scripts/seed-testnet-reserve.ts --network sepolia
 *
 * seedCollateral is permissionless; this script only needs the signer to hold PAXG.
 * Testnet only: on mainnet the seed is a treasury decision sized from libs/peg-sim.
 */
async function main() {
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  if (chainId === 1) throw new Error("Refusing to seed the reserve on mainnet from a script.");

  const snapshotPath = path.join(__dirname, "..", "deployments", `${network.name}.json`);
  const dep = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
  const reserveAddr: string = dep.addresses.reserve;
  const paxgAddr: string = dep.config.paxgToken;

  const [signer] = await ethers.getSigners();
  const amount = ethers.parseUnits(process.env.SEED_PAXG ?? "20", 18);

  const paxg = await ethers.getContractAt("MockERC20", paxgAddr, signer);
  const reserve = await ethers.getContractAt("GoldStabilityReserve", reserveAddr, signer);

  let bal = await paxg.balanceOf(signer.address);
  console.log(`Signer ${signer.address} holds ${ethers.formatUnits(bal, 18)} PAXG`);
  if (bal < amount) {
    // Testnet mocks are mintable by anyone; a fresh local node starts every account at
    // zero. Mint the shortfall rather than fail, and let a real token's revert surface.
    try {
      await (await paxg.mint(signer.address, amount - bal)).wait();
      bal = await paxg.balanceOf(signer.address);
      console.log(`Minted test PAXG; signer now holds ${ethers.formatUnits(bal, 18)}`);
    } catch {
      throw new Error("Not enough PAXG to seed, and the token is not a mintable mock.");
    }
  }

  const before = await reserve.collateralBalance(paxgAddr);
  console.log(`Approving and seeding ${ethers.formatUnits(amount, 18)} PAXG...`);
  await (await paxg.approve(reserveAddr, amount)).wait();
  await (await reserve.seedCollateral(paxgAddr, amount)).wait();

  const after = await reserve.collateralBalance(paxgAddr);
  const redeemable = await reserve.redeemableCollateral(paxgAddr);
  const coverage = await reserve.coveragePpm();
  console.log(`\nReserve PAXG: ${ethers.formatUnits(before, 18)} -> ${ethers.formatUnits(after, 18)}`);
  console.log(`Redeemable:   ${ethers.formatUnits(redeemable, 18)} PAXG`);
  console.log(`Coverage:     ${Number(coverage) / 10_000}% of circulating GSUSD`);
  console.log(`Spread now:   ${Number(await reserve.currentSpreadPpm()) / 10_000}%`);
}

main().catch((e) => {
  console.error(describeErrorStack(e));
  process.exitCode = 1;
});
