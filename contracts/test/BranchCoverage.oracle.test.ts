import { expect } from "chai";
import { ethers, network } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { productionSystem, setValidPrice, GOLD_PRICE } from "./helpers/productionSystem";

/**
 * Branch coverage for GoldOracle, StabilityModule and GoldStablecoin: the non-reverting
 * validated read, the gold reference faults, the resync paths, the role gates and the
 * governance handover guards.
 */

type System = Awaited<ReturnType<typeof productionSystem>>;

const PRECISION = 10n ** 18n;
const SECONDS_PER_YEAR = 365n * 86400n;
const STALENESS = 3600;

/** Deploys a valid 8 decimal XAU/USD anchor and registers it on the fixture oracle. */
async function anchoredOracle(s: System) {
  const MockAgg = await ethers.getContractFactory("MockAggregatorV3");
  const anchor = await MockAgg.deploy(8);
  await setValidPrice(anchor, GOLD_PRICE);
  await s.oracle.setAnchorFeed(await anchor.getAddress());
  return anchor;
}


describe("GoldOracle branch coverage", function () {
  describe("getValidatedPrice", function () {
    it("returns not ok for an unregistered token", async function () {
      const s = await loadFixture(productionSystem);
      const [price, ok] = await s.oracle.getValidatedPrice(s.charlie.address);
      expect(price).to.equal(0n);
      expect(ok).to.equal(false);
    });

    it("returns not ok when the answer is zero", async function () {
      const s = await loadFixture(productionSystem);
      const ts = await time.latest();
      await s.paxgFeed.setLatestRoundData(1, 0n, ts, ts, 1);
      const [price, ok] = await s.oracle.getValidatedPrice(await s.paxg.getAddress());
      expect(price).to.equal(0n);
      expect(ok).to.equal(false);
    });

    it("returns not ok when the round has not completed", async function () {
      const s = await loadFixture(productionSystem);
      const ts = await time.latest();
      await s.paxgFeed.setLatestRoundData(1, GOLD_PRICE, ts, 0, 1);
      const [price, ok] = await s.oracle.getValidatedPrice(await s.paxg.getAddress());
      expect(price).to.equal(0n);
      expect(ok).to.equal(false);
    });

    it("returns not ok when the answer comes from an earlier round", async function () {
      const s = await loadFixture(productionSystem);
      const ts = await time.latest();
      await s.paxgFeed.setLatestRoundData(5, GOLD_PRICE, ts, ts, 4);
      const [price, ok] = await s.oracle.getValidatedPrice(await s.paxg.getAddress());
      expect(price).to.equal(0n);
      expect(ok).to.equal(false);
    });

    it("returns not ok when the update stamp is in the future", async function () {
      const s = await loadFixture(productionSystem);
      const ts = await time.latest();
      await s.paxgFeed.setLatestRoundData(1, GOLD_PRICE, ts, ts + 86400, 1);
      const [price, ok] = await s.oracle.getValidatedPrice(await s.paxg.getAddress());
      expect(price).to.equal(0n);
      expect(ok).to.equal(false);
    });

    it("returns not ok when the round is stale", async function () {
      const s = await loadFixture(productionSystem);
      const ts = await time.latest();
      await s.paxgFeed.setLatestRoundData(1, GOLD_PRICE, ts - STALENESS, ts - STALENESS, 1);
      const [price, ok] = await s.oracle.getValidatedPrice(await s.paxg.getAddress());
      expect(price).to.equal(0n);
      expect(ok).to.equal(false);
    });

    it("returns the live price when every field validates", async function () {
      const s = await loadFixture(productionSystem);
      const [price, ok] = await s.oracle.getValidatedPrice(await s.paxg.getAddress());
      expect(price).to.equal(GOLD_PRICE);
      expect(ok).to.equal(true);
    });
  });

  describe("gold reference", function () {
    it("setAnchorFeed rejects a feed that is not 8 decimals", async function () {
      const s = await loadFixture(productionSystem);
      const MockAgg = await ethers.getContractFactory("MockAggregatorV3");
      const wide = await MockAgg.deploy(18);
      await expect(s.oracle.setAnchorFeed(await wide.getAddress())).to.be.revertedWith("Must be 8 decimals");
    });

    // Every fault in the gold reference is a stopped source; with no pool to corroborate C,
    // no rule applies and the read refuses with one reason.
    const faults: Array<[string, (anchor: Awaited<ReturnType<typeof anchoredOracle>>, ts: number) => Promise<unknown>]> = [
      ["the answer is zero", (anchor, ts) => anchor.setLatestRoundData(1, 0n, ts, ts, 1)],
      ["the round has not completed", (anchor, ts) => anchor.setLatestRoundData(1, GOLD_PRICE, ts, 0, 1)],
      ["the answer comes from an earlier round", (anchor, ts) => anchor.setLatestRoundData(5, GOLD_PRICE, ts, ts, 4)],
      ["the round is stale", (anchor, ts) => anchor.setLatestRoundData(1, GOLD_PRICE, ts - STALENESS, ts - STALENESS, 1)],
      ["the stamp is in the future", (anchor, ts) => anchor.setLatestRoundData(1, GOLD_PRICE, ts, ts + 86400, 1)],
    ];
    for (const [name, fault] of faults) {
      it(`refuses when ${name}`, async function () {
        const s = await loadFixture(productionSystem);
        const anchor = await anchoredOracle(s);
        await fault(anchor, await time.latest());
        await expect(s.oracle.getTokenPrice(await s.paxg.getAddress())).to.be.revertedWith("No reliable price");
        await expect(s.oracle.getBorrowPrice(await s.paxg.getAddress())).to.be.revertedWith("No reliable price");
        await expect(s.oracle.getReservePrice(await s.paxg.getAddress())).to.be.revertedWith("No reliable price");
      });
    }

    it("refuses borrowing and the reserve and caps liquidation when the token price sits above the gold band", async function () {
      const s = await loadFixture(productionSystem);
      const anchor = await anchoredOracle(s);
      const gold = (GOLD_PRICE * 8n) / 10n;
      await setValidPrice(anchor, gold);
      await expect(s.oracle.getBorrowPrice(await s.paxg.getAddress())).to.be.revertedWith("Off gold band");
      await expect(s.oracle.getReservePrice(await s.paxg.getAddress())).to.be.revertedWith("Off gold band");
      expect(await s.oracle.quoteTokenPrice(await s.paxg.getAddress())).to.equal((gold * 102n) / 100n);
    });

    it("accepts a token price inside the gold band", async function () {
      const s = await loadFixture(productionSystem);
      const anchor = await anchoredOracle(s);
      await setValidPrice(anchor, (GOLD_PRICE * 1015n) / 1000n);
      await expect(s.oracle.getTokenPrice(await s.paxg.getAddress())).to.not.be.reverted;
    });
  });

  describe("GOVERNANCE_ROLE setters", function () {
    const setters: Array<[string, (s: System, addr: string) => Promise<unknown>]> = [
      ["setPaxgFeed", (s, addr) => s.oracle.connect(s.alice).setPaxgFeed(addr)],
      ["setXautFeed", (s, addr) => s.oracle.connect(s.alice).setXautFeed(addr)],
      ["setStalenessThreshold", (s) => s.oracle.connect(s.alice).setStalenessThreshold(3600)],
      ["setGoldBand", (s) => s.oracle.connect(s.alice).setGoldBand(s.paxg.getAddress(), 20_000)],
      ["setLiquidationClamp", (s) => s.oracle.connect(s.alice).setLiquidationClamp(s.paxg.getAddress(), 20_000)],
      ["addFeed", (s, addr) => s.oracle.connect(s.alice).addFeed(s.charlie.address, addr)],
      ["setFeed", (s, addr) => s.oracle.connect(s.alice).setFeed(s.paxg.getAddress(), addr)],
      ["setAnchorFeed", (s, addr) => s.oracle.connect(s.alice).setAnchorFeed(addr)],
      ["unpause", (s) => s.oracle.connect(s.alice).unpause(0n)],
    ];

    for (const [name, call] of setters) {
      it(`${name} reverts for a caller without GOVERNANCE_ROLE`, async function () {
        const s = await loadFixture(productionSystem);
        await expect(call(s, await s.paxgFeed.getAddress())).to.be.revertedWithCustomError(
          s.oracle,
          "AccessControlUnauthorizedAccount"
        );
      });
    }

    it("setStalenessThreshold rejects values outside 300 to 90000 seconds", async function () {
      const s = await loadFixture(productionSystem);
      await expect(s.oracle.setStalenessThreshold(299)).to.be.revertedWith("Threshold out of range");
      await expect(s.oracle.setStalenessThreshold(90001)).to.be.revertedWith("Threshold out of range");
      await expect(s.oracle.setStalenessThreshold(300)).to.emit(s.oracle, "StalenessThresholdUpdated").withArgs(300);
    });
  });

  describe("resyncLastKnownPrice", function () {
    it("reverts for a caller without GOVERNANCE_ROLE", async function () {
      const s = await loadFixture(productionSystem);
      await expect(
        s.oracle.connect(s.guardian).resyncLastKnownPrice(await s.paxg.getAddress())
      ).to.be.revertedWithCustomError(s.oracle, "AccessControlUnauthorizedAccount");
    });

    it("reverts for an unregistered token", async function () {
      const s = await loadFixture(productionSystem);
      await expect(s.oracle.resyncLastKnownPrice(s.charlie.address)).to.be.revertedWith("Unsupported token");
    });

    it("reverts while no rule gives a price", async function () {
      const s = await loadFixture(productionSystem);
      const ts = await time.latest();
      await s.paxgFeed.setLatestRoundData(1, 0n, ts, ts, 1);
      await expect(s.oracle.resyncLastKnownPrice(await s.paxg.getAddress())).to.be.revertedWith("No reliable price");
    });

    it("re-records the live price after a large move", async function () {
      const s = await loadFixture(productionSystem);
      const paxg = await s.paxg.getAddress();
      const moved = (GOLD_PRICE * 15n) / 10n;
      await setValidPrice(s.paxgFeed, moved);
      await expect(s.oracle.resyncLastKnownPrice(paxg))
        .to.emit(s.oracle, "LastKnownPriceResynced")
        .withArgs(paxg, GOLD_PRICE, moved);
      expect(await s.oracle.getLastKnownPrice(paxg)).to.equal(moved);
      await expect(s.oracle.getTokenPrice(paxg)).to.not.be.reverted;
    });
  });

  describe("guardianResyncLastKnownPrice", function () {
    it("reverts for a caller that is neither guardian nor governance", async function () {
      const s = await loadFixture(productionSystem);
      await expect(
        s.oracle.connect(s.alice).guardianResyncLastKnownPrice(await s.paxg.getAddress())
      ).to.be.revertedWith("Not guardian or governance");
    });

    it("reverts for an unregistered token", async function () {
      const s = await loadFixture(productionSystem);
      await expect(
        s.oracle.connect(s.guardian).guardianResyncLastKnownPrice(s.charlie.address)
      ).to.be.revertedWith("Unsupported token");
    });

    it("reverts while the live feed is invalid", async function () {
      const s = await loadFixture(productionSystem);
      const ts = await time.latest();
      await s.paxgFeed.setLatestRoundData(1, GOLD_PRICE, ts, 0, 1);
      await expect(
        s.oracle.connect(s.guardian).guardianResyncLastKnownPrice(await s.paxg.getAddress())
      ).to.be.revertedWith("No reliable price");
    });

    it("lets the guardian re-anchor to the live price", async function () {
      const s = await loadFixture(productionSystem);
      const paxg = await s.paxg.getAddress();
      const moved = (GOLD_PRICE * 15n) / 10n;
      await setValidPrice(s.paxgFeed, moved);
      await expect(s.oracle.connect(s.guardian).guardianResyncLastKnownPrice(paxg))
        .to.emit(s.oracle, "LastKnownPriceResynced")
        .withArgs(paxg, GOLD_PRICE, moved);
      expect(await s.oracle.getLastKnownPrice(paxg)).to.equal(moved);
    });

    it("lets governance use the guardian path as well", async function () {
      const s = await loadFixture(productionSystem);
      const paxg = await s.paxg.getAddress();
      const moved = (GOLD_PRICE * 15n) / 10n;
      await setValidPrice(s.paxgFeed, moved);
      expect(await s.oracle.hasRole(await s.oracle.GUARDIAN_ROLE(), s.deployer.address)).to.equal(false);
      await expect(s.oracle.guardianResyncLastKnownPrice(paxg))
        .to.emit(s.oracle, "LastKnownPriceResynced")
        .withArgs(paxg, GOLD_PRICE, moved);
    });

    it("holds the guardian and governance to the same rules off the gold band", async function () {
      const s = await loadFixture(productionSystem);
      await anchoredOracle(s);
      const paxg = await s.paxg.getAddress();
      const moved = (GOLD_PRICE * 15n) / 10n;
      await setValidPrice(s.paxgFeed, moved);
      // Both paths record the capped price, never C itself.
      const edge = (GOLD_PRICE * 102n) / 100n;
      await expect(s.oracle.connect(s.guardian).guardianResyncLastKnownPrice(paxg))
        .to.emit(s.oracle, "LastKnownPriceResynced")
        .withArgs(paxg, GOLD_PRICE, edge);
      await expect(s.oracle.resyncLastKnownPrice(paxg))
        .to.emit(s.oracle, "LastKnownPriceResynced")
        .withArgs(paxg, edge, edge);
    });
  });

  describe("emergencyPause", function () {
    it("reverts for a caller that is neither guardian nor governance", async function () {
      const s = await loadFixture(productionSystem);
      await expect(s.oracle.connect(s.alice).emergencyPause()).to.be.revertedWith("Not guardian or governance");
    });

    it("lets governance pause", async function () {
      const s = await loadFixture(productionSystem);
      await s.oracle.emergencyPause();
      expect(await s.oracle.paused()).to.equal(true);
    });

    it("lets the guardian pause", async function () {
      const s = await loadFixture(productionSystem);
      await s.oracle.connect(s.guardian).emergencyPause();
      expect(await s.oracle.paused()).to.equal(true);
    });
  });

  describe("grantGuardianRole", function () {
    it("reverts for a caller without DEFAULT_ADMIN_ROLE", async function () {
      const s = await loadFixture(productionSystem);
      await expect(
        s.oracle.connect(s.alice).grantGuardianRole(s.alice.address)
      ).to.be.revertedWithCustomError(s.oracle, "AccessControlUnauthorizedAccount");
    });

    it("reverts on the zero address", async function () {
      const s = await loadFixture(productionSystem);
      await expect(s.oracle.grantGuardianRole(ethers.ZeroAddress)).to.be.revertedWith("Zero address");
    });
  });

  describe("transferGovernance", function () {
    it("reverts for a caller without DEFAULT_ADMIN_ROLE", async function () {
      const s = await loadFixture(productionSystem);
      await expect(
        s.oracle.connect(s.alice).transferGovernance(s.timelockAddr)
      ).to.be.revertedWithCustomError(s.oracle, "AccessControlUnauthorizedAccount");
    });

    it("reverts on the zero address", async function () {
      const s = await loadFixture(productionSystem);
      await expect(s.oracle.transferGovernance(ethers.ZeroAddress)).to.be.revertedWith("Zero address");
    });

    it("reverts when the admin would hand over to itself", async function () {
      const s = await loadFixture(productionSystem);
      await expect(s.oracle.transferGovernance(s.deployer.address)).to.be.revertedWith("Would self-revoke");
    });

    it("reverts when the destination is not a contract", async function () {
      const s = await loadFixture(productionSystem);
      await expect(s.oracle.transferGovernance(s.alice.address)).to.be.revertedWith("Timelock must be a contract");
    });

    it("hands both roles to the timelock and strips the deployer", async function () {
      const s = await loadFixture(productionSystem);
      const ADMIN = await s.oracle.DEFAULT_ADMIN_ROLE();
      const GOV = await s.oracle.GOVERNANCE_ROLE();
      await s.oracle.transferGovernance(s.timelockAddr);
      expect(await s.oracle.hasRole(ADMIN, s.timelockAddr)).to.equal(true);
      expect(await s.oracle.hasRole(GOV, s.timelockAddr)).to.equal(true);
      expect(await s.oracle.hasRole(ADMIN, s.deployer.address)).to.equal(false);
      expect(await s.oracle.hasRole(GOV, s.deployer.address)).to.equal(false);
    });
  });
});

describe("StabilityModule branch coverage", function () {
  const UNKNOWN_ID = ethers.keccak256(ethers.toUtf8Bytes("never initialised"));

  async function moduleAsVault(s: System) {
    const sm = s.stabilityModule;
    await sm.grantRole(await sm.VAULT_ROLE(), s.deployer.address);
    return sm;
  }

  describe("VAULT_ROLE gates", function () {
    it("recordDebt reverts for a caller without VAULT_ROLE", async function () {
      const s = await loadFixture(productionSystem);
      await expect(
        s.stabilityModule.connect(s.alice).recordDebt(s.alice.address, s.paxgId, 1n)
      ).to.be.revertedWithCustomError(s.stabilityModule, "AccessControlUnauthorizedAccount");
    });

    it("reduceDebt reverts for a caller without VAULT_ROLE", async function () {
      const s = await loadFixture(productionSystem);
      await expect(
        s.stabilityModule.connect(s.alice).reduceDebt(s.alice.address, s.paxgId, 1n)
      ).to.be.revertedWithCustomError(s.stabilityModule, "AccessControlUnauthorizedAccount");
    });

    it("clearDebt reverts for a caller without VAULT_ROLE", async function () {
      const s = await loadFixture(productionSystem);
      await expect(
        s.stabilityModule.connect(s.alice).clearDebt(s.alice.address, s.paxgId)
      ).to.be.revertedWithCustomError(s.stabilityModule, "AccessControlUnauthorizedAccount");
    });
  });

  describe("uninitialised collateral", function () {
    it("recordDebt reverts on a collateral id that was never initialised", async function () {
      const s = await loadFixture(productionSystem);
      const sm = await moduleAsVault(s);
      await expect(sm.recordDebt(s.alice.address, UNKNOWN_ID, 1n)).to.be.revertedWith("Collateral not initialised");
    });

    it("reduceDebt reverts on a collateral id that was never initialised", async function () {
      const s = await loadFixture(productionSystem);
      const sm = await moduleAsVault(s);
      await expect(sm.reduceDebt(s.alice.address, UNKNOWN_ID, 1n)).to.be.revertedWith("Collateral not initialised");
    });

    it("accrueInterest is a no-op on a collateral id that was never initialised", async function () {
      const s = await loadFixture(productionSystem);
      await expect(s.stabilityModule.accrueInterest(UNKNOWN_ID)).to.not.emit(s.stabilityModule, "FeesAccrued");
      expect(await s.stabilityModule.rateAccumulator(UNKNOWN_ID)).to.equal(0n);
      expect(await s.stabilityModule.lastAccrualTimestamp(UNKNOWN_ID)).to.equal(0n);
    });
  });

  describe("clearDebt", function () {
    it("zeroes the normalised debt the vault recorded", async function () {
      const s = await loadFixture(productionSystem);
      const sm = await moduleAsVault(s);
      await sm.recordDebt(s.alice.address, s.paxgId, ethers.parseEther("1000"));
      expect(await sm.normalisedDebt(s.alice.address, s.paxgId)).to.be.gt(0n);
      await sm.clearDebt(s.alice.address, s.paxgId);
      expect(await sm.normalisedDebt(s.alice.address, s.paxgId)).to.equal(0n);
    });
  });

  describe("getOutstandingAccruedFee", function () {
    it("returns zero when the principal is at or above the current debt", async function () {
      const s = await loadFixture(productionSystem);
      const sm = await moduleAsVault(s);
      const principal = ethers.parseEther("1000");
      await sm.recordDebt(s.alice.address, s.paxgId, principal);
      expect(await sm.getOutstandingAccruedFee(s.alice.address, s.paxgId, principal * 2n)).to.equal(0n);
      expect(await sm.getAccruedFees(s.alice.address, s.paxgId, principal * 2n)).to.equal(0n);
      expect(await sm.getOutstandingAccruedFee(s.bob.address, s.paxgId, 0n)).to.equal(0n);
    });

    it("returns the excess of the current debt over the principal once fees have accrued", async function () {
      const s = await loadFixture(productionSystem);
      const sm = await moduleAsVault(s);
      const principal = ethers.parseEther("1000");
      await sm.recordDebt(s.alice.address, s.paxgId, principal);
      await time.increase(Number(SECONDS_PER_YEAR));
      const outstanding = await sm.getOutstandingAccruedFee(s.alice.address, s.paxgId, principal);
      expect(outstanding).to.be.gt(0n);
      const current = await sm.getCurrentDebt(s.alice.address, s.paxgId);
      expect(outstanding).to.equal(current - principal);
    });
  });

  describe("accrual within a single block", function () {
    it("the second accrual in the same block returns early without a second FeesAccrued", async function () {
      const s = await loadFixture(productionSystem);
      const sm = s.stabilityModule;
      // Pin lastAccrualTimestamp to the latest block so the next block accrues exactly once.
      await sm.accrueInterest(s.paxgId);

      await network.provider.send("evm_setAutomine", [false]);
      try {
        const first = await sm.accrueInterest(s.paxgId);
        const second = await sm.accrueInterest(s.paxgId);
        await network.provider.send("evm_mine", []);
        const firstReceipt = await first.wait();
        const secondReceipt = await second.wait();
        if (!firstReceipt || !secondReceipt) throw new Error("accrual receipts missing");
        expect(firstReceipt.blockNumber).to.equal(secondReceipt.blockNumber);
        expect(firstReceipt.logs.length).to.equal(1);
        expect(secondReceipt.logs.length).to.equal(0);
        const latest = await time.latest();
        expect(await sm.lastAccrualTimestamp(s.paxgId)).to.equal(BigInt(latest));
      } finally {
        await network.provider.send("evm_setAutomine", [true]);
      }
    });
  });

  describe("transferGovernance", function () {
    it("reverts for a caller without DEFAULT_ADMIN_ROLE", async function () {
      const s = await loadFixture(productionSystem);
      await expect(
        s.stabilityModule.connect(s.alice).transferGovernance(s.timelockAddr)
      ).to.be.revertedWithCustomError(s.stabilityModule, "AccessControlUnauthorizedAccount");
    });

    it("reverts on the zero address", async function () {
      const s = await loadFixture(productionSystem);
      await expect(s.stabilityModule.transferGovernance(ethers.ZeroAddress)).to.be.revertedWith("Zero address");
    });

    it("reverts when the admin would hand over to itself", async function () {
      const s = await loadFixture(productionSystem);
      await expect(
        s.stabilityModule.transferGovernance(s.deployer.address)
      ).to.be.revertedWith("Would self-revoke");
    });

    it("reverts when the destination is not a contract", async function () {
      const s = await loadFixture(productionSystem);
      await expect(
        s.stabilityModule.transferGovernance(s.alice.address)
      ).to.be.revertedWith("Timelock must be a contract");
    });

    it("hands both roles to the timelock and strips the deployer", async function () {
      const s = await loadFixture(productionSystem);
      const sm = s.stabilityModule;
      const ADMIN = await sm.DEFAULT_ADMIN_ROLE();
      const GOV = await sm.GOVERNANCE_ROLE();
      await sm.transferGovernance(s.timelockAddr);
      expect(await sm.hasRole(ADMIN, s.timelockAddr)).to.equal(true);
      expect(await sm.hasRole(GOV, s.timelockAddr)).to.equal(true);
      expect(await sm.hasRole(ADMIN, s.deployer.address)).to.equal(false);
      expect(await sm.hasRole(GOV, s.deployer.address)).to.equal(false);
    });
  });

  it("the per second rate formula matches the initialised 200 bps", async function () {
    const s = await loadFixture(productionSystem);
    const expected = PRECISION + (200n * PRECISION) / (10000n * SECONDS_PER_YEAR);
    expect(await s.stabilityModule.stabilityFeeRate(s.paxgId)).to.equal(expected);
  });
});

describe("GoldStablecoin branch coverage", function () {
  describe("transferGovernance", function () {
    it("reverts when the admin would hand over to itself", async function () {
      const s = await loadFixture(productionSystem);
      await expect(s.stablecoin.transferGovernance(s.deployer.address)).to.be.revertedWith("Would self-revoke");
    });

    it("reverts on the zero address", async function () {
      const s = await loadFixture(productionSystem);
      await expect(s.stablecoin.transferGovernance(ethers.ZeroAddress)).to.be.revertedWith("Zero address");
    });

    it("reverts when the destination is not a contract", async function () {
      const s = await loadFixture(productionSystem);
      await expect(s.stablecoin.transferGovernance(s.alice.address)).to.be.revertedWith("Timelock must be a contract");
    });

    it("reverts for a caller without DEFAULT_ADMIN_ROLE", async function () {
      const s = await loadFixture(productionSystem);
      await expect(
        s.stablecoin.connect(s.alice).transferGovernance(s.timelockAddr)
      ).to.be.revertedWithCustomError(s.stablecoin, "AccessControlUnauthorizedAccount");
    });

    it("hands admin to the timelock and strips the deployer", async function () {
      const s = await loadFixture(productionSystem);
      const ADMIN = await s.stablecoin.DEFAULT_ADMIN_ROLE();
      await s.stablecoin.transferGovernance(s.timelockAddr);
      expect(await s.stablecoin.hasRole(ADMIN, s.timelockAddr)).to.equal(true);
      expect(await s.stablecoin.hasRole(ADMIN, s.deployer.address)).to.equal(false);
    });
  });
});
