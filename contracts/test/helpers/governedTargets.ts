import { ethers } from "hardhat";

/**
 * Real replacement targets for the governance wrapper. setGovernedContract accepts only an
 * address that holds code and answers its kind's read, so a test
 * that repoints the wrapper needs an actual vault, oracle or stability module.
 */
export async function replacementOracle(): Promise<string> {
  const Agg = await ethers.getContractFactory("MockAggregatorV3");
  const Token = await ethers.getContractFactory("MockERC20");
  const [paxgFeed, xautFeed] = [await Agg.deploy(8), await Agg.deploy(8)];
  const [paxg, xaut] = [await Token.deploy("Pax Gold", "PAXG", 18), await Token.deploy("Tether Gold", "XAUT", 6)];
  const oracle = await (await ethers.getContractFactory("GoldOracle")).deploy(
    await paxgFeed.getAddress(),
    await xautFeed.getAddress(),
    await paxg.getAddress(),
    await xaut.getAddress(),
    3600
  );
  return oracle.getAddress();
}

export async function replacementStabilityModule(): Promise<string> {
  return (await (await ethers.getContractFactory("StabilityModule")).deploy()).getAddress();
}

export async function replacementVault(): Promise<string> {
  const stablecoin = await (await ethers.getContractFactory("GoldStablecoin")).deploy();
  const vault = await (await ethers.getContractFactory("GoldVault")).deploy(
    await replacementOracle(),
    await stablecoin.getAddress(),
    await replacementStabilityModule()
  );
  return vault.getAddress();
}
