import { ethers } from "hardhat";
import { time, loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { productionSystem, setValidPrice, LIQ_RATIO, LIQ_PENALTY } from "./productionSystem";

export type System = Awaited<ReturnType<typeof productionSystem>>;

/** Open-profile minimum ratio: 130%, the mainnet and Sepolia policy. */
export const OPEN_MIN_RATIO = 1_300_000n;

/**
 * The production fixture switched to the LAUNCH_CAPS=open profile: no debt ceilings, no
 * per-block mint cap, the production staleness window. This is the shape
 * mainnet launches with.
 */
export async function openSystem(): Promise<System> {
  const s = await productionSystem();
  const max = ethers.MaxUint256;
  for (const token of [await s.paxg.getAddress(), await s.xaut.getAddress()]) {
    await s.vault.updateCollateralRatios(token, OPEN_MIN_RATIO, LIQ_RATIO, LIQ_PENALTY);
    await s.vault.setDebtCeiling(token, max);
  }
  await s.vault.setPerBlockMintCap(0n);
  await s.oracle.setStalenessThreshold(90_000n);
  return s;
}

export async function loadOpen(): Promise<System> {
  return loadFixture(openSystem);
}

/**
 * Walk a feed to `target` in steps under the 10% deviation breaker, advancing the oracle's
 * lastKnownPrice after every step exactly as live traffic would.
 */
export async function walkPrice(s: System, token: string, feed: System["paxgFeed"], target: bigint) {
  let cur: bigint = await s.oracle.getLastKnownPrice(token);
  while (cur !== target) {
    const maxStep = (cur * 9n) / 100n;
    let next = target;
    if (target > cur && target - cur > maxStep) next = cur + maxStep;
    if (target < cur && cur - target > maxStep) next = cur - maxStep;
    await time.increase(60);
    await setValidPrice(feed, next);
    await s.oracle.getTokenPrice(token);
    cur = next;
  }
}

/** Open a PAXG vault for `who` with `oz` ounces in a single deposit, minted to `ratioPpm` at $2,000. */
export async function openPaxgVault(s: System, who: System["alice"], oz: bigint, ratioPpm = 1_310_000n) {
  const paxg = await s.paxg.getAddress();
  const amount = ethers.parseEther(oz.toString());
  await s.paxg.mint(who.address, amount);
  await s.paxg.connect(who).approve(await s.vault.getAddress(), amount);
  await s.vault.connect(who).deposit(paxg, amount, { gasLimit: 16_000_000n });
  const debt = (amount * 2000n * 1_000_000n) / ratioPpm;
  await s.vault.connect(who).mint(debt);
  return { amount, debt };
}

/** The PAXG price at which `who`'s vault sits at exactly `ratioPpm`, given its current debt. */
export async function priceForRatio(s: System, who: string, collateral: bigint, ratioPpm: bigint): Promise<bigint> {
  const debt = await s.vault.getVaultCurrentDebt(who);
  return (debt * ratioPpm * 100_000_000n) / (collateral * 1_000_000n);
}

/** Give `who` GSUSD from the fixture minter and approve the vault and the pool. */
export async function fundGsusd(s: System, who: System["alice"], amount: bigint) {
  await s.stablecoin.mint(who.address, amount);
  await s.stablecoin.connect(who).approve(await s.vault.getAddress(), ethers.MaxUint256);
  await s.stablecoin.connect(who).approve(await s.stabilityPool.getAddress(), ethers.MaxUint256);
}
