/**
 * Fund the dapp end-to-end wallet on the local e2e node (apps/dapp-e2e).
 *
 * The wallet is the node's own account #1, so no private key exists anywhere: the node
 * signs for it. This gives it what the suite spends: mock PAXG and XAUT (the mocks mint
 * to anyone) and GSUSD transferred from the signer, which seed-testnet-position.ts has
 * just minted from the deployer's own vault. Refuses to run anywhere but the e2e network.
 *
 *   E2E_WALLET=0x7099... FUND_PAXG=100 FUND_XAUT=100 FUND_GSUSD=5000 \
 *     npx hardhat run scripts/fund-e2e-wallet.ts --network e2e
 */
import { ethers, network } from "hardhat";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describeError } from "./lib/redact";

// Hardhat's deterministic account #1; account #0 is the deployer.
const HARDHAT_ACCOUNT_1 = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

async function main() {
  if (network.name !== "e2e") {
    throw new Error(`Refusing on ${network.name}: this funds the local end-to-end wallet only.`);
  }
  const snap = JSON.parse(readFileSync(resolve(__dirname, "../deployments/e2e.json"), "utf8"));
  const wallet = ethers.getAddress(process.env.E2E_WALLET ?? HARDHAT_ACCOUNT_1);
  const [signer] = await ethers.getSigners();

  const paxg = await ethers.getContractAt("MockERC20", snap.config.paxgToken, signer);
  const xaut = await ethers.getContractAt("MockERC20", snap.config.xautToken, signer);
  const gsusd = await ethers.getContractAt("GoldStablecoin", snap.addresses.stablecoin, signer);

  const paxgAmount = ethers.parseUnits(process.env.FUND_PAXG ?? "100", 18);
  const xautAmount = ethers.parseUnits(process.env.FUND_XAUT ?? "100", 6);
  const gsusdAmount = ethers.parseUnits(process.env.FUND_GSUSD ?? "5000", 18);

  await (await paxg.mint(wallet, paxgAmount)).wait();
  await (await xaut.mint(wallet, xautAmount)).wait();
  const held: bigint = await gsusd.balanceOf(signer.address);
  if (held < gsusdAmount) {
    throw new Error(
      `Signer holds ${ethers.formatEther(held)} GSUSD but the wallet needs ${ethers.formatEther(gsusdAmount)}: ` +
        "run seed-testnet-position.ts first."
    );
  }
  await (await gsusd.transfer(wallet, gsusdAmount)).wait();

  console.log(`E2E wallet ${wallet}`);
  console.log(`  PAXG  ${ethers.formatUnits(await paxg.balanceOf(wallet), 18)}`);
  console.log(`  XAUT  ${ethers.formatUnits(await xaut.balanceOf(wallet), 6)}`);
  console.log(`  GSUSD ${ethers.formatEther(await gsusd.balanceOf(wallet))}`);
  console.log(`  ETH   ${ethers.formatEther(await ethers.provider.getBalance(wallet))}`);
}

main().catch((error) => {
  console.error(describeError(error));
  process.exit(1);
});
