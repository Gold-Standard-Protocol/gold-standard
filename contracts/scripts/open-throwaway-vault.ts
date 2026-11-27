/**
 * Testnet only: open a throwaway borrower vault near the liquidation line so a keeper
 * exercise has a target that is not the deployer's own vault.
 *
 * A fresh random wallet is funded with gas and mock PAXG by the deployer, deposits the
 * collateral and mints up to RATIO_PCT (default 140; the minimum ratio to mint is 130). The script
 * prints the wallet, its ratio and the price below which it becomes liquidatable, next to
 * the deployer's own line, because the keeper takes whichever vault crosses first. Walk the
 * price under the line with walk-testnet-price.ts, watch the keeper, then walk it back.
 *
 *   COLLATERAL_PAXG=0.2 RATIO_PCT=140 VICTIM_OUT=/tmp/victim.txt \
 *     RPC_URL=http://127.0.0.1:8555 npx hardhat run scripts/open-throwaway-vault.ts --network sepolia
 */
import { ethers } from "hardhat";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describeError } from "./lib/redact";

const PPM = 1_000_000n;
const ONE = 10n ** 18n;

async function main() {
  const net = await ethers.provider.getNetwork();
  if (net.chainId === 1n) throw new Error("Testnet only: this script mints mock collateral");
  const snapshotPath = resolve(__dirname, `../deployments/${process.env.DEPLOYMENT ?? "sepolia"}.json`);
  const snap = JSON.parse(readFileSync(snapshotPath, "utf8"));
  const [deployer] = await ethers.getSigners();

  const collateral = ethers.parseEther(process.env.COLLATERAL_PAXG ?? "0.2");
  const ratioPct = BigInt(process.env.RATIO_PCT ?? "140");
  if (ratioPct < 100n) throw new Error("RATIO_PCT must be at least 100");

  const vault = await ethers.getContractAt("GoldVault", snap.addresses.vault);
  const oracle = await ethers.getContractAt("GoldOracle", snap.addresses.oracle);
  const paxgAddr: string = snap.config.paxgToken;
  const paxg = await ethers.getContractAt("MockERC20", paxgAddr, deployer);

  const colType = await vault.collateralTypes(ethers.keccak256(ethers.solidityPacked(["address"], [paxgAddr])));
  if (!colType.active) throw new Error("PAXG is not an active collateral type on this deployment");
  const ratioPpm = ratioPct * PPM / 100n;
  if (ratioPpm < colType.minRatio) {
    throw new Error(`RATIO_PCT ${ratioPct} is below the deployment's minimum of ${Number(colType.minRatio) / 10_000}%`);
  }
  const liquidationPct = Number(colType.liquidationRatio) / 10_000;

  const price: bigint = await oracle.getTokenPrice.staticCall(paxgAddr);
  if (price === 0n) throw new Error("Oracle returned no price; refresh the feeds first");
  const valueUsd = (collateral * price) / 10n ** 8n;
  const debt = (valueUsd * 100n / ratioPct / ONE) * ONE;
  const minDebt: bigint = await vault.minDebt();
  if (debt < minDebt) throw new Error(`Debt of ${ethers.formatEther(debt)} GSUSD is under MIN_DEBT; raise COLLATERAL_PAXG`);

  const victim = ethers.Wallet.createRandom().connect(ethers.provider);
  await (await deployer.sendTransaction({ to: victim.address, value: ethers.parseEther("0.02") })).wait();
  await (await paxg.mint(victim.address, collateral)).wait();
  await (await paxg.connect(victim).approve(snap.addresses.vault, collateral)).wait();
  await (await vault.connect(victim).deposit(paxgAddr, collateral)).wait();
  await (await vault.connect(victim).mint(debt)).wait();

  const line = async (who: string) => {
    const position = await vault.vaults(who);
    const currentDebt: bigint = await vault.getVaultCurrentDebt(who);
    const ratio = Number(await vault.getCollateralisationRatio(who)) / 10_000;
    const col = Number(ethers.formatEther(position.collateralAmount));
    const threshold = col === 0 ? 0 : (Number(ethers.formatEther(currentDebt)) * liquidationPct) / 100 / col;
    return { ratio, col, debt: Number(ethers.formatEther(currentDebt)), threshold };
  };
  const v = await line(victim.address);
  const d = await line(deployer.address);
  const px = Number(ethers.formatUnits(price, 8));
  console.log(`price $${px.toFixed(2)}, liquidation ratio ${liquidationPct}%`);
  console.log(`victim   ${victim.address}: ${v.col} PAXG, ${v.debt.toFixed(2)} GSUSD, ratio ${v.ratio.toFixed(2)}%, liquidatable below $${v.threshold.toFixed(2)}`);
  console.log(`deployer ${deployer.address}: ${d.col.toFixed(4)} PAXG, ${d.debt.toFixed(2)} GSUSD, ratio ${d.ratio.toFixed(2)}%, liquidatable below $${d.threshold.toFixed(2)}`);
  if (d.threshold >= v.threshold) {
    console.log("WARNING: the deployer's vault crosses the line first; repay some of its debt before walking the price");
  } else {
    console.log(`walk the price to anything between $${d.threshold.toFixed(0)} and $${v.threshold.toFixed(0)}, for example TARGET_PRICE_USD=${Math.floor((v.threshold * 0.985) / 10) * 10}`);
  }
  if (process.env.VICTIM_OUT) writeFileSync(process.env.VICTIM_OUT, `${victim.address}\n`);
}

main().catch((e) => {
  console.error(describeError(e));
  process.exit(1);
});
