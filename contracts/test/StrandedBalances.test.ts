import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { GoldStabilityReserve, MockAggregatorV3, MockERC20 } from "../typechain-types";
import { readCountedBalance, strandedFinding, strandedFindings } from "../scripts/lib/strandedBalances";

/**
 * verify-deployment.ts lists a token balance the reserve or the buffer holds but does not
 * count (scripts/lib/strandedBalances.ts). In a fork rehearsal, after a
 * plain 5 PAXG transfer the verification passed without a word, and a withdrawal of the whole
 * token balance reverted "Exceeds balance".
 */
describe("Stranded balances (scripts/lib/strandedBalances.ts)", function () {
  const paxgOf = (counted: string, held: string) => ({
    label: "reserve.paxg",
    counted: ethers.parseEther(counted),
    held: ethers.parseEther(held),
    decimals: 18,
    symbol: "PAXG",
  });

  it("says nothing when the counted and the held balance agree", function () {
    expect(strandedFinding(paxgOf("29.7508", "29.7508"))).to.deep.equal({ name: "stranded:reserve.paxg" });
  });

  it("warns with the three figures when the contract holds more than it counts", function () {
    const finding = strandedFinding(paxgOf("29.7508", "34.7508"));
    expect(finding.failure).to.equal(undefined);
    expect(finding.warning).to.include("holds 34.7508 PAXG but counts 29.7508 PAXG: 5 PAXG arrived by a plain transfer");
    expect(finding.warning).to.include("no function recovers it");
  });

  it("formats a six decimal token in its own units", function () {
    const finding = strandedFinding({ label: "buffer.xaut", counted: 1_000_000n, held: 1_250_000n, decimals: 6, symbol: "XAUt" });
    expect(finding.warning).to.include("holds 1.25 XAUt but counts 1 XAUt: 0.25 XAUt");
  });

  it("fails when the contract counts more than it holds", function () {
    const finding = strandedFinding(paxgOf("10", "9"));
    expect(finding.warning).to.equal(undefined);
    expect(finding.failure).to.include("counts 10 PAXG but holds only 9 PAXG");
  });

  it("keeps one finding per balance, in order", function () {
    const names = strandedFindings([paxgOf("1", "1"), { ...paxgOf("1", "2"), label: "buffer.paxg" }]).map((f) => f.name);
    expect(names).to.deep.equal(["stranded:reserve.paxg", "stranded:buffer.paxg"]);
  });

  describe("against the real reserve", function () {
    let reserve: GoldStabilityReserve;
    let paxg: MockERC20;
    let holder: Awaited<ReturnType<typeof ethers.getSigners>>[number];

    beforeEach(async function () {
      [, holder] = await ethers.getSigners();
      paxg = await (await ethers.getContractFactory("MockERC20")).deploy("Paxos Gold", "PAXG", 18);
      const xaut = await (await ethers.getContractFactory("MockERC20")).deploy("Tether Gold", "XAUt", 6);
      const feed = (await (await ethers.getContractFactory("MockAggregatorV3")).deploy(8)) as MockAggregatorV3;
      const now = await time.latest();
      await feed.setLatestRoundData(1, 4_150_00000000n, now, now, 1);
      const oracle = await (await ethers.getContractFactory("GoldOracle")).deploy(await feed.getAddress(), await feed.getAddress(), await paxg.getAddress(), await xaut.getAddress(), 90000);
      const stablecoin = await (await ethers.getContractFactory("GoldStablecoin")).deploy();
      reserve = (await (await ethers.getContractFactory("GoldStabilityReserve")).deploy(await stablecoin.getAddress(), await oracle.getAddress())) as GoldStabilityReserve;
      await reserve.setAssetConfig(await paxg.getAddress(), true, 0, 200_000);
      await paxg.mint(holder.address, ethers.parseEther("100"));
      await paxg.connect(holder).approve(await reserve.getAddress(), ethers.parseEther("30"));
      await reserve.connect(holder).seedCollateral(await paxg.getAddress(), ethers.parseEther("30"));
    });

    const read = async () =>
      readCountedBalance({
        label: "reserve.paxg",
        token: paxg,
        holder: await reserve.getAddress(),
        counted: async () => reserve.collateralBalance(await paxg.getAddress()),
      });

    it("is quiet after a seed and warns after a plain transfer the reserve cannot release", async function () {
      expect(strandedFinding(await read()).warning).to.equal(undefined);

      await paxg.connect(holder).transfer(await reserve.getAddress(), ethers.parseEther("5"));
      const balance = await read();
      expect(balance.held - balance.counted).to.equal(ethers.parseEther("5"));
      expect(strandedFinding(balance).warning).to.include("holds 35 PAXG but counts 30 PAXG: 5 PAXG arrived by a plain transfer");
      // What the warning describes: governance cannot withdraw the whole token balance.
      await expect(reserve.withdrawCollateral(await paxg.getAddress(), holder.address, balance.held)).to.be.revertedWith("Exceeds balance");
    });
  });

  it("is wired into verify-deployment.ts for the reserve and the buffer, gold and GSUSD", function () {
    const source = readFileSync(resolve(__dirname, "..", "scripts", "verify-deployment.ts"), "utf8");
    for (const label of ['"reserve.gsusd"', '"buffer.gsusd"', "`reserve.${label}`", "`buffer.${label}`"]) expect(source).to.include(label);
    expect(source).to.include("checks.push(warn(finding.name, finding.warning))");
  });
});
