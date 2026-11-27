import { expect } from "chai";
import { ethers } from "hardhat";
import { time, takeSnapshot } from "@nomicfoundation/hardhat-network-helpers";
import { setValidPrice } from "./helpers/productionSystem";
import { loadOpen, openPaxgVault, fundGsusd, type System } from "./helpers/openProfile";

/**
 * Oracle edges under the production staleness window: the boundary at exactly 90,000 s,
 * zero, negative, incomplete and future-stamped answers, and a large gap: refused off the
 * gold band, liquidated once gold confirms it.
 */
describe("Oracle edges", function () {
  const P = 2000n * 100_000_000n;

  async function setRound(feed: System["paxgFeed"], answer: bigint, round: number, answered: number, started: number, updated: number) {
    await feed.setLatestRoundData(round, answer, started, updated, answered);
  }

  it("treats an age of 89,999 s as fresh and 90,000 s as stale", async function () {
    const s = await loadOpen();
    const paxg = await s.paxg.getAddress();
    const ts = await time.latest();
    await setRound(s.paxgFeed, P, 1, 1, ts, ts);
    const snap = await takeSnapshot();
    await time.setNextBlockTimestamp(ts + 89_999);
    await s.oracle.getTokenPrice(paxg);
    await snap.restore();
    await time.setNextBlockTimestamp(ts + 90_000);
    await expect(s.oracle.getTokenPrice(paxg)).to.be.revertedWith("No reliable price");
  });

  it("getPaxgPrice treats an age of threshold - 1 as fresh and the threshold as stale", async function () {
    const s = await loadOpen();
    const ts = await time.latest();
    await setRound(s.paxgFeed, P, 1, 1, ts, ts);
    const snap = await takeSnapshot();
    // Mine the block the view is read in, so the age is exact.
    await time.increaseTo(ts + 89_999);
    const [price, updatedAt] = await s.oracle.getPaxgPrice({ blockTag: "latest" });
    expect(price).to.equal(P);
    expect(updatedAt).to.equal(BigInt(ts));
    await snap.restore();
    await time.increaseTo(ts + 90_000);
    await expect(s.oracle.getPaxgPrice({ blockTag: "latest" })).to.be.revertedWith("Stale oracle");
  });

  it("rejects zero, negative, incomplete and future-stamped answers without reverting the validated read", async function () {
    const s = await loadOpen();
    const paxg = await s.paxg.getAddress();
    const ts = await time.latest();
    const cases: Array<[string, bigint, number, number, number, number, string]> = [
      ["zero answer", 0n, 3, 3, ts, ts, "Invalid price"],
      ["negative answer", -1n, 3, 3, ts, ts, "Invalid price"],
      ["updatedAt zero", P, 3, 3, ts, 0, "Round not complete"],
      ["answeredInRound below roundId", P, 3, 2, ts, ts, "Stale round"],
    ];
    for (const [name, answer, round, answered, started, updated, reason] of cases) {
      await setRound(s.paxgFeed, answer, round, answered, started, updated);
      // The pricing read treats every fault as a stopped source; the legacy read names it.
      await expect(s.oracle.getTokenPrice(paxg), name).to.be.revertedWith("No reliable price");
      await expect(s.oracle.getPaxgPrice(), name).to.be.revertedWith(reason);
      const validated = await s.oracle.getValidatedPrice(paxg);
      expect(validated[1], name).to.equal(false);
    }
    const now = await time.latest();
    await setRound(s.paxgFeed, P, 4, 4, now, now + 10_000);
    expect((await s.oracle.getValidatedPrice(paxg))[1]).to.equal(false);
  });

  it("liquidates across a gap wider than the old breaker, and values a lone move down at gold", async function () {
    const s = await loadOpen();
    const paxg = await s.paxg.getAddress();
    await openPaxgVault(s, s.charlie, 10n);
    await fundGsusd(s, s.bob, ethers.parseEther("50000"));
    const anchor = await (await ethers.getContractFactory("MockAggregatorV3")).deploy(8);
    await setValidPrice(anchor, P);
    await s.oracle.setAnchorFeed(await anchor.getAddress());

    // PAXG alone gaps down 20% with gold steady: liquidation values it at gold, so the healthy
    // vault is not seized, and the emergency path stays shut because nothing is paused or
    // frozen.
    await time.increase(60);
    await setValidPrice(s.paxgFeed, (P * 80n) / 100n);
    await setValidPrice(anchor, P);
    await expect(s.vault.connect(s.bob).liquidate(s.charlie.address, 0, { gasLimit: 16_000_000n })).to.be.revertedWith(
      "Not undercollateralised"
    );
    await expect(
      s.vault.connect(s.bob).emergencyLiquidate(s.charlie.address, 0, { gasLimit: 16_000_000n })
    ).to.be.revertedWith("Not in emergency");
    // The guardian freezes PAXG by hand; the freeze stops emergency seizures too, in a pause as well.
    await s.oracle.connect(s.guardian).freezeToken(paxg);
    await expect(
      s.vault.connect(s.bob).emergencyLiquidate(s.charlie.address, 0, { gasLimit: 16_000_000n })
    ).to.be.revertedWith("Token frozen");
    // The move is gold's own after all: XAU/USD confirms it, the guardian lifts the freeze at
    // the live price and liquidation runs in one step, with no step gate to resync.
    await setValidPrice(s.paxgFeed, (P * 80n) / 100n);
    await setValidPrice(anchor, (P * 80n) / 100n);
    await s.oracle.connect(s.guardian).guardianUnfreezeToken(paxg, await s.oracle.freezeEpoch(paxg));
    await expect(s.vault.connect(s.bob).liquidate(s.charlie.address, 0, { gasLimit: 16_000_000n })).to.emit(
      s.vault,
      "Liquidated"
    );
  });
});
