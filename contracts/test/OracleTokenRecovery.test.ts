import { expect } from "chai";
import type { Interface } from "ethers";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";
import type { GoldOracle, MockAggregatorV3 } from "../typechain-types";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

/**
 * Sections 3 and 4 of the oracle plan, at the oracle: the guardian's manual freeze (there is no
 * permissionless trip; it lapses after 14 days unless extended), the unfreeze and both resyncs
 * (each needs a normal liquidation read) and the emergency price (only in a pause). The Foundry suites (TokenIsolatedRecovery, TokenIsolation
 * invariants) drive the same surface through the vault.
 */
describe("GoldOracle per-token freeze and emergency price", function () {
  const GOLD = 400_000_000_000n; // $4000, 8 decimals
  const pct = (x: bigint, per1000: bigint) => (x * per1000) / 1000n;
  const STALE = 100_000;
  let oracle: GoldOracle;
  let paxgFeed: MockAggregatorV3;
  let xautFeed: MockAggregatorV3;
  let anchor: MockAggregatorV3;
  let guardian: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;
  const paxg = ethers.getAddress("0x000000000000000000000000000000000000ba76");
  const xaut = ethers.getAddress("0x0000000000000000000000000000000000007a07");

  async function push(feed: MockAggregatorV3, price: bigint, age = 0) {
    const now = BigInt(await time.latest());
    await feed.setLatestRoundData(1, price, now - BigInt(age), now - BigInt(age), 1);
  }

  async function xautAt(c: bigint) {
    await push(xautFeed, c);
    await push(anchor, GOLD);
    await push(paxgFeed, GOLD);
  }

  beforeEach(async function () {
    [, guardian, stranger] = await ethers.getSigners();
    const Agg = await ethers.getContractFactory("MockAggregatorV3");
    paxgFeed = await Agg.deploy(8);
    xautFeed = await Agg.deploy(8);
    anchor = await Agg.deploy(8);
    for (const f of [paxgFeed, xautFeed, anchor]) await push(f, GOLD);
    oracle = await (await ethers.getContractFactory("GoldOracle")).deploy(
      await paxgFeed.getAddress(),
      await xautFeed.getAddress(),
      paxg,
      xaut,
      90_000
    );
    await oracle.setAnchorFeed(await anchor.getAddress());
    await oracle.getTokenPrice(paxg);
    await oracle.getTokenPrice(xaut);
    await oracle.grantGuardianRole(guardian.address);
  });

  describe("freezeToken", function () {
    it("is guardian or governance only and freezes that token alone", async function () {
      await expect(oracle.connect(stranger).freezeToken(xaut)).to.be.revertedWith("Not guardian or governance");
      await expect(oracle.connect(guardian).freezeToken(stranger.address)).to.be.revertedWith("Unsupported token");
      await expect(oracle.connect(guardian).freezeToken(xaut))
        .to.emit(oracle, "TokenFrozen")
        .withArgs(xaut, guardian.address, anyValue);
      expect(await oracle.frozenUntil(xaut)).to.equal(BigInt(await time.latest()) + 14n * 86400n);
      expect(await oracle.tokenFrozen(xaut)).to.equal(true);
      expect(await oracle.tokenFrozen(paxg)).to.equal(false);
      expect(await oracle.paused()).to.equal(false);
      await expect(oracle.getTokenPrice(xaut)).to.be.revertedWith("Token frozen");
      await expect(oracle.getBorrowPrice(xaut)).to.be.revertedWith("Token frozen");
      expect(await oracle.getTokenPrice.staticCall(paxg)).to.equal(GOLD);
      await oracle.freezeToken(paxg); // governance may as well
      expect(await oracle.tokenFrozen(paxg)).to.equal(true);
    });

    it("lapses after 14 days unless the guardian extends it", async function () {
      await oracle.connect(guardian).freezeToken(xaut);
      await time.increase(13 * 86400);
      await oracle.connect(guardian).freezeToken(xaut); // the extension
      await time.increase(2 * 86400);
      expect(await oracle.tokenFrozen(xaut)).to.equal(true);
      await time.increase(12 * 86400 + 1);
      expect(await oracle.tokenFrozen(xaut)).to.equal(false);
      await xautAt(GOLD);
      expect(await oracle.getTokenPrice.staticCall(xaut)).to.equal(GOLD);
      await expect(oracle.connect(guardian).guardianUnfreezeToken(xaut, await oracle.freezeEpoch(xaut))).to.be.revertedWith("Not frozen");
    });

    it("leaves no permissionless way to freeze: the old trip is gone", async function () {
      expect((oracle as unknown as Record<string, unknown>).tripCircuitBreaker).to.equal(undefined);
      expect((oracle.interface as Interface).getFunction("tripCircuitBreaker")).to.equal(null);
    });
  });

  describe("guardianUnfreezeToken", function () {
    it("needs a frozen token, the right role and a normal liquidation read", async function () {
      await expect(oracle.connect(guardian).guardianUnfreezeToken(xaut, await oracle.freezeEpoch(xaut))).to.be.revertedWith("Not frozen");
      await oracle.connect(guardian).freezeToken(xaut);
      await expect(oracle.connect(stranger).guardianUnfreezeToken(xaut, await oracle.freezeEpoch(xaut))).to.be.revertedWith("Not guardian or governance");
      await xautAt(GOLD);
      await push(xautFeed, GOLD, STALE);
      await expect(oracle.connect(guardian).guardianUnfreezeToken(xaut, await oracle.freezeEpoch(xaut))).to.be.revertedWith("No reliable price");
      await xautAt(pct(GOLD, 1010n));
      await expect(oracle.connect(guardian).guardianUnfreezeToken(xaut, await oracle.freezeEpoch(xaut)))
        .to.emit(oracle, "TokenUnfrozen")
        .withArgs(xaut, guardian.address, pct(GOLD, 1010n));
      expect(await oracle.tokenFrozen(xaut)).to.equal(false);
      expect(await oracle.getLastKnownPrice(xaut)).to.equal(pct(GOLD, 1010n));
    });

    it("works while the oracle is paused", async function () {
      await oracle.connect(guardian).freezeToken(xaut);
      await oracle.connect(guardian).emergencyPause();
      await xautAt(pct(GOLD, 700n)); // a depeg
      await oracle.connect(guardian).guardianUnfreezeToken(xaut, await oracle.freezeEpoch(xaut));
      expect(await oracle.getLastKnownPrice(xaut)).to.equal(GOLD); // valued at gold
    });
  });

  describe("resyncLastKnownPrice and guardianResyncLastKnownPrice", function () {
    it("governance re-records the normal liquidation price, frozen or paused", async function () {
      await expect(oracle.connect(stranger).resyncLastKnownPrice(xaut)).to.be.reverted;
      await expect(oracle.resyncLastKnownPrice(stranger.address)).to.be.revertedWith("Unsupported token");
      await oracle.freezeToken(xaut);
      await oracle.emergencyPause();
      await xautAt(pct(GOLD, 1015n)); // above gold, under the cap: C
      await expect(oracle.resyncLastKnownPrice(xaut))
        .to.emit(oracle, "LastKnownPriceResynced")
        .withArgs(xaut, GOLD, pct(GOLD, 1015n));
    });

    it("the guardian path has identical terms and refuses without a normal price", async function () {
      await expect(oracle.connect(stranger).guardianResyncLastKnownPrice(xaut)).to.be.revertedWith("Not guardian or governance");
      await xautAt(GOLD);
      await push(xautFeed, GOLD, STALE);
      await expect(oracle.connect(guardian).guardianResyncLastKnownPrice(xaut)).to.be.revertedWith("No reliable price");
      await xautAt(pct(GOLD, 700n));
      await oracle.connect(guardian).guardianResyncLastKnownPrice(xaut);
      expect(await oracle.getLastKnownPrice(xaut)).to.equal(GOLD); // valued at gold
    });
  });

  describe("getEmergencyPrice", function () {
    it("reverts outside a pause, and answers 0 for an unknown token inside one", async function () {
      await expect(oracle.getEmergencyPrice(xaut, false)).to.be.revertedWith("Not in emergency");
      await expect(oracle.getEmergencyPrice(stranger.address, false)).to.be.revertedWith("Not in emergency");
      expect(await oracle.getEmergencyPrice(stranger.address, true)).to.equal(0n); // the vault reports "No debt"
    });

    it("a frozen token is stopped in and out of a pause, and priced by the rules in one once unfrozen", async function () {
      await oracle.connect(guardian).freezeToken(xaut);
      await xautAt(pct(GOLD, 990n));
      await expect(oracle.getEmergencyPrice(xaut, false)).to.be.revertedWith("Token frozen");
      // The guardian's freeze stops seizures during a pause too.
      await expect(oracle.getEmergencyPrice(xaut, true)).to.be.revertedWith("Token frozen");
      await oracle.connect(guardian).guardianUnfreezeToken(xaut, await oracle.freezeEpoch(xaut));
      expect(await oracle.getEmergencyPrice(xaut, true)).to.equal(GOLD); // C below gold: gold
      await xautAt(pct(GOLD, 1010n));
      expect(await oracle.getEmergencyPrice(xaut, true)).to.equal(pct(GOLD, 1010n)); // C under the cap
      await push(xautFeed, GOLD, STALE);
      await expect(oracle.getEmergencyPrice(xaut, true)).to.be.revertedWith("No price"); // never a stale C
    });

    it("while paused, prices by the rules and never on a stale C or the last known price alone", async function () {
      await xautAt(pct(GOLD, 1200n));
      expect(await oracle.getEmergencyPrice(xaut, true)).to.equal(pct(GOLD, 1020n)); // capped
      await oracle.emergencyPause();
      expect(await oracle.getEmergencyPrice(xaut, false)).to.equal(pct(GOLD, 1020n)); // the oracle's own pause
      await oracle.connect(guardian).freezeToken(xaut);
      await xautAt(pct(GOLD, 995n));
      // Frozen and paused: refused. The guardian can still lift the
      // freeze while the oracle is paused.
      await expect(oracle.getEmergencyPrice(xaut, false)).to.be.revertedWith("Token frozen");
      await oracle.connect(guardian).guardianUnfreezeToken(xaut, await oracle.freezeEpoch(xaut));
      expect(await oracle.getEmergencyPrice(xaut, false)).to.equal(GOLD);
      await push(xautFeed, pct(GOLD, 995n), STALE);
      await expect(oracle.getEmergencyPrice(xaut, false)).to.be.revertedWith("No price");
      await oracle.unpause(await oracle.pauseEpoch());
      expect(await oracle.paused()).to.equal(false);
    });

    it("reverts with no price at all", async function () {
      const Agg = await ethers.getContractFactory("MockAggregatorV3");
      const fresh = await Agg.deploy(8);
      await push(fresh, GOLD, STALE);
      await oracle.addFeed(stranger.address, await fresh.getAddress()); // never read: lastKnown 0
      await expect(oracle.getEmergencyPrice(stranger.address, true)).to.be.revertedWith("No price");
    });
  });
});
