import { expect } from "chai";
import { ethers, network } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { productionSystem, setValidPrice, GOLD_PRICE } from "./helpers/productionSystem";

// Runtime that returns the supplied bytes, including deliberately malformed ABI data.
function returning(data: string): string {
  const size = ethers.getBytes(data).length.toString(16).padStart(4, "0");
  return `0x61${size}600e60003961${size}6000f3${data.slice(2)}`;
}

/** The production fixture with the XAU/USD gold reference G set, as on mainnet. */
async function anchoredSystem() {
  const s = await productionSystem();
  const anchor = await (await ethers.getContractFactory("MockAggregatorV3")).deploy(8);
  await setValidPrice(anchor, GOLD_PRICE);
  await s.oracle.setAnchorFeed(await anchor.getAddress());
  return { ...s, anchor };
}

// Adapted to variant C (docs/ORACLE_IMPLEMENTATION_PLAN.md sections 3
// and 4): a malformed or extreme answer reads as an unhealthy source, and an unhealthy source
// refuses every priced path, the emergency price included, instead of falling back to a record.
describe("Oracle fault tolerance", function () {
  for (const [name, code] of [
    ["a reverting feed", "0x60006000fd"],
    ["empty return data", "0x60006000f3"],
    ["short return data", returning(ethers.toBeHex(1, 32))],
    ["a missing contract", "0x"],
  ]) {
    it(`reports ${name} as unhealthy instead of reverting, and refuses to price on it`, async function () {
      const s = await loadFixture(anchoredSystem);
      const token = await s.paxg.getAddress();
      await network.provider.send("hardhat_setCode", [await s.paxgFeed.getAddress(), code]);
      expect(await s.oracle.getValidatedPrice(token)).to.deep.equal([0n, false]);
      expect(await s.oracle.quoteValuationPrice(token)).to.equal(0n);
      await expect(s.oracle.quoteTokenPrice(token)).to.be.revertedWith("No reliable price");
      await expect(s.oracle.getEmergencyPrice(token, true)).to.be.revertedWith("No price");
    });
  }

  for (const field of [0, 4]) {
    it(`rejects an out-of-range uint80 in round field ${field} without an ABI panic`, async function () {
      const s = await loadFixture(anchoredSystem);
      const now = BigInt(await time.latest());
      const fields = [1n, GOLD_PRICE, now, now, 1n];
      fields[field] = 1n << 80n;
      const data = ethers.AbiCoder.defaultAbiCoder().encode(
        ["uint256", "int256", "uint256", "uint256", "uint256"], fields
      );
      await network.provider.send("hardhat_setCode", [await s.paxgFeed.getAddress(), returning(data)]);
      expect(await s.oracle.getValidatedPrice(await s.paxg.getAddress())).to.deep.equal([0n, false]);
    });
  }

  it("refuses an emergency liquidation during a feed outage and resumes by itself once the feed answers", async function () {
    const s = await loadFixture(productionSystem);
    const token = await s.paxg.getAddress();
    await s.vault.connect(s.alice).deposit(token, ethers.parseEther("1"));
    await s.vault.connect(s.alice).mint(ethers.parseEther("1300"));
    await setValidPrice(s.paxgFeed, 1400n * 100_000_000n);
    await s.vault.emergencyPause();
    const feed = await s.paxgFeed.getAddress();
    const runtime = await network.provider.send("eth_getCode", [feed, "latest"]);
    await network.provider.send("hardhat_setCode", [feed, "0x60006000fd"]);
    await expect(s.vault.connect(s.bob).emergencyLiquidate(s.alice.address, 0)).to.be.revertedWith("No price");
    // The mock's storage survives the code swap, so restoring it restores the last answer.
    await network.provider.send("hardhat_setCode", [feed, runtime]);
    await setValidPrice(s.paxgFeed, 1400n * 100_000_000n);
    await expect(s.vault.connect(s.bob).emergencyLiquidate(s.alice.address, 0)).to.emit(s.vault, "Liquidated");
  });

  it("refuses a future-dated C on every path, with a clear reason on the legacy read", async function () {
    const s = await loadFixture(anchoredSystem);
    const token = await s.paxg.getAddress();
    const future = (await time.latest()) + 10_000;
    await s.paxgFeed.setLatestRoundData(1, GOLD_PRICE, future, future, 1);
    expect(await s.oracle.getValidatedPrice(token)).to.deep.equal([0n, false]);
    await expect(s.oracle.getTokenPrice(token)).to.be.revertedWith("No reliable price");
    await expect(s.oracle.getPaxgPrice()).to.be.revertedWith("Future oracle timestamp");
  });

  it("refuses a future-dated G on every priced path", async function () {
    const s = await loadFixture(anchoredSystem);
    const token = await s.paxg.getAddress();
    const future = (await time.latest()) + 10_000;
    await s.anchor.setLatestRoundData(1, GOLD_PRICE, future, future, 1);
    await expect(s.oracle.getTokenPrice(token)).to.be.revertedWith("No reliable price");
    await expect(s.oracle.getBorrowPrice(token)).to.be.revertedWith("No reliable price");
    await expect(s.oracle.getReservePrice(token)).to.be.revertedWith("No reliable price");
    expect(await s.oracle.quoteValuationPrice(token)).to.equal(0n);
  });

  for (const both of [false, true]) {
    it(`prices an extreme positive answer from ${both ? "C and G" : "C alone"} without overflowing`, async function () {
      const s = await loadFixture(anchoredSystem);
      const token = await s.paxg.getAddress();
      const huge = (1n << 255n) - 1n;
      await setValidPrice(s.paxgFeed, huge);
      if (both) await setValidPrice(s.anchor, huge);
      const gold = both ? huge : GOLD_PRICE;
      // C at or below G values at G; C above G is capped at G x (1 + 2%), rounded down.
      expect(await s.oracle.quoteTokenPrice(token)).to.equal(both ? huge : (gold * 1_020_000n) / 1_000_000n);
      expect(await s.oracle.quoteValuationPrice(token)).to.equal(gold);
      if (both) {
        expect(await s.oracle.quoteBorrowPrice(token)).to.equal(huge);
        expect(await s.oracle.quoteReservePrice(token)).to.equal(huge);
      } else {
        await expect(s.oracle.quoteBorrowPrice(token)).to.be.revertedWith("Off gold band");
        await expect(s.oracle.quoteReservePrice(token)).to.be.revertedWith("Off gold band");
      }
    });
  }

  it("does not count unavailable gold toward a healthy asset's reserve spread", async function () {
    const s = await loadFixture(productionSystem);
    const reserve = await s.reserve.getAddress();
    await s.paxg.connect(s.alice).approve(reserve, ethers.MaxUint256);
    await s.reserve.connect(s.alice).seedCollateral(await s.paxg.getAddress(), ethers.parseEther("1"));
    await s.xaut.connect(s.charlie).approve(reserve, ethers.MaxUint256);
    await s.reserve.connect(s.charlie).seedCollateral(await s.xaut.getAddress(), 100_000_000n);
    await s.reserve.setSpreadCurve([{ coverageAtLeastPpm: 100_000n, spreadPpm: 5_000n }], 20_000n);
    await network.provider.send("hardhat_setCode", [await s.xautFeed.getAddress(), "0x60006000fd"]);
    expect(await s.reserve.reserveValueUsd()).to.equal(ethers.parseEther("2000"));
    expect(await s.reserve.currentSpreadPpm()).to.equal(20_000n);
    await expect(s.reserve.connect(s.alice).swapGsusdForGold(await s.paxg.getAddress(), ethers.parseEther("100"), 0))
      .to.emit(s.reserve, "Swapped");
  });
});
