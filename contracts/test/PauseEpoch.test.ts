import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { GOLD_PRICE, productionSystem, setValidPrice } from "./helpers/productionSystem";

/**
 * What the timelock grace period alone leaves open. ExpiringTimelockController ends a matured operation 7 days after it becomes ready,
 * but inside those 7 days an open executor could still run an unpause that had reverted
 * ExpectedPause for one incident and lift a new guardian pause for another. Every unpause now
 * names the pause it was approved for: pauseEpoch() on GoldVault, GoldOracle and StabilityPool,
 * assetPauseEpoch(token) on GoldStabilityReserve. Every re-assertion of a hold takes a new number:
 * a new pause, an extension (extendPause, or pauseAsset on a paused asset) and a bad-debt breaker
 * trip, whether the contract was paused or not. An unpause therefore lands only if nothing has
 * re-asserted the hold since it was scheduled. Foundry repeats these with a same transaction mint
 * (test-foundry/PauseEpoch.t.sol).
 */
describe("Pause epochs: an unpause lifts only the pause it was approved for", function () {
  const DAY = 24 * 3600;
  const DELAY = 48 * 3600;

  /** productionSystem with the vault handed to a GoldGovernance whose timelock has the open executor. */
  async function openExecutorSystem() {
    const s = await productionSystem();
    const governance = await (await ethers.getContractFactory("GoldGovernance")).deploy(
      [s.proposer.address],
      [ethers.ZeroAddress],
      await s.vault.getAddress(),
      await s.oracle.getAddress(),
      await s.stabilityModule.getAddress()
    );
    const timelock = await ethers.getContractAt("ExpiringTimelockController", await governance.getTimelockAddress());
    await s.vault.transferGovernance(await timelock.getAddress());
    return { ...s, openGovernance: governance, timelock };
  }

  /**
   * openExecutorSystem with the bad-debt breaker armed at 1 GSUSD and alice holding 1 PAXG
   * against 1,000 GSUSD, which goes underwater once gold falls to $500.
   */
  async function breakerSystem() {
    const s = await productionSystem();
    await s.vault.connect(s.alice).deposit(await s.paxg.getAddress(), ethers.parseEther("1"));
    await s.vault.connect(s.alice).mint(ethers.parseEther("1000"));
    await s.vault.setBadDebtPauseThreshold(ethers.parseEther("1"));
    const governance = await (await ethers.getContractFactory("GoldGovernance")).deploy(
      [s.proposer.address],
      [ethers.ZeroAddress],
      await s.vault.getAddress(),
      await s.oracle.getAddress(),
      await s.stabilityModule.getAddress()
    );
    const timelock = await ethers.getContractAt("ExpiringTimelockController", await governance.getTimelockAddress());
    await s.vault.transferGovernance(await timelock.getAddress());
    return { ...s, openGovernance: governance, timelock };
  }

  /** Gold falls to $500 and bob liquidates alice while the vault is paused: bad debt over the threshold. */
  async function tripTheBreakerWhilePaused(s: Awaited<ReturnType<typeof breakerSystem>>) {
    await walkTo(s, 500n * 10n ** 8n);
    await s.vault.connect(s.bob).emergencyLiquidate(s.alice.address, 0);
    expect(await s.vault.totalBadDebt()).to.be.greaterThan(await s.vault.badDebtPauseThreshold());
  }

  async function walkTo(s: Awaited<ReturnType<typeof productionSystem>>, target: bigint) {
    const paxg = await s.paxg.getAddress();
    const xaut = await s.xaut.getAddress();
    let current = await s.oracle.getLastKnownPrice(paxg);
    while (current !== target) {
      let next = target < current ? (current * 91n) / 100n : (current * 109n) / 100n;
      if ((target < current && next < target) || (target > current && next > target)) next = target;
      await setValidPrice(s.paxgFeed, next);
      await setValidPrice(s.xautFeed, next);
      await s.oracle.getTokenPrice(paxg);
      await s.oracle.getTokenPrice(xaut);
      current = next;
    }
  }

  it("refuses an unpause approved for an earlier pause, inside the timelock grace period", async function () {
    const s = await loadFixture(openExecutorSystem);
    const vaultAddr = await s.vault.getAddress();
    const t0 = await time.latest();

    // Incident 1: the guardian pauses; governance schedules the unpause late in the pause.
    await s.vault.connect(s.guardian).emergencyPause();
    expect(await s.vault.pauseEpoch()).to.equal(1n);
    const stale = s.vault.interface.encodeFunctionData("unpause", [await s.vault.pauseEpoch()]);
    const salt = ethers.id("unpause incident 1");
    await time.increaseTo(t0 + 12 * DAY + 12 * 3600);
    await s.timelock.connect(s.proposer).schedule(vaultAddr, 0, stale, ethers.ZeroHash, salt, DELAY);
    const id = await s.timelock.hashOperation(vaultAddr, 0, stale, ethers.ZeroHash, salt);

    // The pause lapses first and anyone lifts it, so the matured unpause reverts and stays Ready.
    await time.increaseTo(t0 + 14 * DAY);
    await s.vault.connect(s.charlie).unpauseExpired();
    await time.increaseTo(t0 + 14 * DAY + 12 * 3600 + 1);
    await expect(s.openGovernance.connect(s.charlie).executeProposal(vaultAddr, stale, salt)).to.be.revertedWithCustomError(
      s.vault,
      "ExpectedPause"
    );
    expect(await s.timelock.isOperationReady(id)).to.equal(true);

    // Incident 2, two days on: the stale operation is still inside its grace period.
    await time.increaseTo(t0 + 16 * DAY);
    await s.vault.connect(s.guardian).emergencyPause();
    expect(await s.vault.pauseEpoch()).to.equal(2n);
    expect(await s.timelock.isOperationExpired(id)).to.equal(false);

    await expect(s.openGovernance.connect(s.charlie).executeProposal(vaultAddr, stale, salt)).to.be.revertedWith(
      "Different pause"
    );
    await expect(s.timelock.connect(s.charlie).execute(vaultAddr, 0, stale, ethers.ZeroHash, salt)).to.be.revertedWith(
      "Different pause"
    );
    expect(await s.vault.paused()).to.equal(true);
    await expect(s.vault.connect(s.alice).mint(1n)).to.be.revertedWithCustomError(s.vault, "EnforcedPause");
  });

  it("refuses an unpause scheduled before the guardian extended the pause for a new incident", async function () {
    const s = await loadFixture(openExecutorSystem);
    const vaultAddr = await s.vault.getAddress();
    const t0 = await time.latest();
    await s.vault.connect(s.alice).deposit(await s.paxg.getAddress(), ethers.parseEther("1"));
    await s.vault.connect(s.guardian).emergencyPause();
    const call = s.vault.interface.encodeFunctionData("unpause", [await s.vault.pauseEpoch()]);
    const salt = ethers.id("unpause incident 1");
    await s.timelock.connect(s.proposer).schedule(vaultAddr, 0, call, ethers.ZeroHash, salt, DELAY);

    // Incident 2 on day 3, inside the window: a new pause is refused, so the guardian extends.
    await time.increaseTo(t0 + 3 * DAY);
    await expect(s.vault.connect(s.guardian).emergencyPause()).to.be.revertedWithCustomError(s.vault, "EnforcedPause");
    await expect(s.vault.connect(s.guardian).extendPause()).to.emit(s.vault, "PauseExtended");

    await expect(s.openGovernance.connect(s.charlie).executeProposal(vaultAddr, call, salt)).to.be.revertedWith(
      "Different pause"
    );
    await expect(s.timelock.connect(s.charlie).execute(vaultAddr, 0, call, ethers.ZeroHash, salt)).to.be.revertedWith(
      "Different pause"
    );
    expect(await s.vault.paused()).to.equal(true);
    expect(await s.vault.pauseEpoch()).to.equal(2n);
    await expect(s.vault.connect(s.alice).mint(1n)).to.be.revertedWithCustomError(s.vault, "EnforcedPause");
  });

  it("lifts the pause with an unpause scheduled after the last extension, however many came before", async function () {
    const s = await loadFixture(openExecutorSystem);
    const vaultAddr = await s.vault.getAddress();
    await s.vault.connect(s.guardian).emergencyPause();
    for (let day = 0; day < 3; day++) {
      await time.increase(DAY);
      await s.vault.connect(s.guardian).extendPause();
    }
    expect(await s.vault.pauseEpoch()).to.equal(4n);

    const call = s.vault.interface.encodeFunctionData("unpause", [await s.vault.pauseEpoch()]);
    const salt = ethers.id("unpause after the last extension");
    await s.timelock.connect(s.proposer).schedule(vaultAddr, 0, call, ethers.ZeroHash, salt, DELAY);
    await time.increase(DELAY);
    await s.openGovernance.connect(s.charlie).executeProposal(vaultAddr, call, salt);
    expect(await s.vault.paused()).to.equal(false);
    expect(await s.vault.pauseEpoch()).to.equal(4n);
  });

  it("numbers an extension of a lapsed pause as a new pause, so a stale unpause cannot lift it", async function () {
    const s = await loadFixture(openExecutorSystem);
    const vaultAddr = await s.vault.getAddress();
    const t0 = await time.latest();

    await s.vault.connect(s.guardian).emergencyPause();
    const stale = s.vault.interface.encodeFunctionData("unpause", [await s.vault.pauseEpoch()]);
    const salt = ethers.id("unpause incident 1");
    await time.increaseTo(t0 + 12 * DAY + 12 * 3600);
    await s.timelock.connect(s.proposer).schedule(vaultAddr, 0, stale, ethers.ZeroHash, salt, DELAY);
    const id = await s.timelock.hashOperation(vaultAddr, 0, stale, ethers.ZeroHash, salt);

    // The pause lapses at t0 + 14 days; nobody lifts it, so it still reads paused.
    await time.increaseTo(t0 + 16 * DAY);
    expect(await s.vault.paused()).to.equal(true);

    // Incident 2: a fresh pause is refused, so the guardian extends the lapsed one.
    await expect(s.vault.connect(s.guardian).emergencyPause()).to.be.revertedWithCustomError(s.vault, "EnforcedPause");
    await s.vault.connect(s.guardian).extendPause();
    expect(await s.vault.pauseEpoch()).to.equal(2n);
    expect(await s.timelock.isOperationReady(id)).to.equal(true);
    expect(await s.timelock.isOperationExpired(id)).to.equal(false);

    await expect(s.openGovernance.connect(s.charlie).executeProposal(vaultAddr, stale, salt)).to.be.revertedWith(
      "Different pause"
    );
    await expect(s.timelock.connect(s.charlie).execute(vaultAddr, 0, stale, ethers.ZeroHash, salt)).to.be.revertedWith(
      "Different pause"
    );
    expect(await s.vault.paused()).to.equal(true);

    // An extension inside the new window is a fresh decision too, with a new number.
    await time.increase(4 * DAY);
    await s.vault.connect(s.guardian).extendPause();
    expect(await s.vault.pauseEpoch()).to.equal(3n);
  });

  it("numbers the bad-debt breaker's pause like any other", async function () {
    const s = await loadFixture(productionSystem);
    await s.vault.connect(s.guardian).emergencyPause();
    await s.vault.unpause(1n);

    await s.vault.connect(s.alice).deposit(await s.paxg.getAddress(), ethers.parseEther("1"));
    await s.vault.connect(s.alice).mint(ethers.parseEther("1000"));
    await s.vault.setBadDebtPauseThreshold(ethers.parseEther("1"));
    expect(await s.oracle.getLastKnownPrice(await s.paxg.getAddress())).to.equal(GOLD_PRICE);
    await walkTo(s, 500n * 10n ** 8n);
    await s.vault.connect(s.bob).liquidate(s.alice.address, 0);
    expect(await s.vault.paused()).to.equal(true);
    expect(await s.vault.pauseEpoch()).to.equal(2n);

    await expect(s.vault.unpause(1n)).to.be.revertedWith("Different pause");
    await s.vault.unpause(2n);
    expect(await s.vault.paused()).to.equal(false);
  });

  it("numbers a breaker trip during an active pause, so an unpause approved before the bad debt cannot lift it (probe A)", async function () {
    const s = await loadFixture(breakerSystem);
    const vaultAddr = await s.vault.getAddress();
    const t0 = await time.latest();
    await s.vault.connect(s.guardian).emergencyPause();
    const call = s.vault.interface.encodeFunctionData("unpause", [1n]);
    const salt = ethers.id("unpause incident 1");
    await s.timelock.connect(s.proposer).schedule(vaultAddr, 0, call, ethers.ZeroHash, salt, DELAY);

    await time.increaseTo(t0 + DAY);
    await tripTheBreakerWhilePaused(s);
    const trippedAt = BigInt(await time.latest());

    await time.increaseTo(t0 + DELAY + 1);
    await expect(s.timelock.connect(s.charlie).execute(vaultAddr, 0, call, ethers.ZeroHash, salt)).to.be.revertedWith(
      "Different pause"
    );
    await expect(s.openGovernance.connect(s.charlie).executeProposal(vaultAddr, call, salt)).to.be.revertedWith(
      "Different pause"
    );
    expect(await s.vault.paused()).to.equal(true);
    expect(await s.vault.pauseEpoch()).to.equal(2n);
    expect(await s.vault.pausedAt()).to.equal(trippedAt);

    // An unpause scheduled after the trip, naming it, lifts the breaker's hold.
    const fresh = s.vault.interface.encodeFunctionData("unpause", [2n]);
    const freshSalt = ethers.id("unpause after the trip");
    await s.timelock.connect(s.proposer).schedule(vaultAddr, 0, fresh, ethers.ZeroHash, freshSalt, DELAY);
    await time.increase(DELAY);
    await s.openGovernance.connect(s.charlie).executeProposal(vaultAddr, fresh, freshSalt);
    expect(await s.vault.paused()).to.equal(false);
  });

  it("restarts the window when the breaker trips in a lapsed pause, so nobody can lift it at once (probe B)", async function () {
    const s = await loadFixture(breakerSystem);
    const t0 = await time.latest();
    await s.vault.connect(s.guardian).emergencyPause();

    await time.increaseTo(t0 + 15 * DAY);
    expect(await s.vault.paused()).to.equal(true);
    await tripTheBreakerWhilePaused(s);
    const trippedAt = BigInt(await time.latest());
    expect(await s.vault.pausedAt()).to.equal(trippedAt);
    expect(await s.vault.pauseEpoch()).to.equal(2n);

    await expect(s.vault.connect(s.charlie).unpauseExpired()).to.be.revertedWith("Pause not expired");
    expect(await s.vault.paused()).to.equal(true);

    // Once the breaker's own window closes, anyone lifts it, and no number is needed.
    await time.increaseTo(trippedAt + 14n * BigInt(DAY));
    await expect(s.vault.connect(s.charlie).unpauseExpired()).to.emit(s.vault, "PauseExpired");
    expect(await s.vault.paused()).to.equal(false);
    expect(await s.vault.pauseEpoch()).to.equal(2n);
  });

  it("refuses a stale unpause for a lapsed pause once the breaker has tripped in it (probe B2)", async function () {
    const s = await loadFixture(breakerSystem);
    const vaultAddr = await s.vault.getAddress();
    const t0 = await time.latest();
    await s.vault.connect(s.guardian).emergencyPause();
    const stale = s.vault.interface.encodeFunctionData("unpause", [1n]);
    const salt = ethers.id("unpause incident 1");
    await time.increaseTo(t0 + 12 * DAY + 12 * 3600);
    await s.timelock.connect(s.proposer).schedule(vaultAddr, 0, stale, ethers.ZeroHash, salt, DELAY);

    await time.increaseTo(t0 + 15 * DAY);
    await tripTheBreakerWhilePaused(s);

    await expect(s.timelock.connect(s.charlie).execute(vaultAddr, 0, stale, ethers.ZeroHash, salt)).to.be.revertedWith(
      "Different pause"
    );
    expect(await s.vault.paused()).to.equal(true);
    await expect(s.vault.connect(s.charlie).unpauseExpired()).to.be.revertedWith("Pause not expired");
  });

  it("leaves unpauseExpired as it was: no number needed, and the count only moves on a new pause", async function () {
    const s = await loadFixture(productionSystem);
    const pausables = [s.vault, s.oracle, s.stabilityPool] as const;
    for (const c of pausables) await c.connect(s.guardian).emergencyPause();
    await time.increase(14 * DAY);
    for (const c of pausables) {
      await expect(c.connect(s.charlie).unpauseExpired()).to.emit(c, "PauseExpired");
      expect(await c.paused()).to.equal(false);
      expect(await c.pauseEpoch()).to.equal(1n);
    }
    for (const c of pausables) {
      await c.connect(s.guardian).emergencyPause();
      expect(await c.pauseEpoch()).to.equal(2n);
    }
  });

  it("numbers every reserve asset pause: a pause while paused and a pause after a lapse each take a new number", async function () {
    const s = await loadFixture(productionSystem);
    const paxg = await s.paxg.getAddress();
    const xaut = await s.xaut.getAddress();
    await s.reserve.connect(s.guardian).pauseAsset(paxg);
    expect(await s.reserve.assetPauseEpoch(paxg)).to.equal(1n);
    expect(await s.reserve.assetPauseEpoch(xaut)).to.equal(0n);

    // A re-assertion while paused: a fresh decision with a new number.
    await time.increase(7 * DAY);
    await s.reserve.connect(s.guardian).pauseAsset(paxg);
    expect(await s.reserve.assetPauseEpoch(paxg)).to.equal(2n);
    await expect(s.reserve.unpauseAsset(paxg, 1n)).to.be.revertedWith("Different pause");
    expect(await s.reserve.assetPaused(paxg)).to.equal(true);

    await time.increase(14 * DAY);
    expect(await s.reserve.assetPaused(paxg)).to.equal(false);
    await s.reserve.connect(s.guardian).pauseAsset(paxg);
    expect(await s.reserve.assetPauseEpoch(paxg)).to.equal(3n);

    await expect(s.reserve.unpauseAsset(paxg, 2n)).to.be.revertedWith("Different pause");
    expect(await s.reserve.assetPaused(paxg)).to.equal(true);
    await expect(s.reserve.unpauseAsset(paxg, 3n)).to.emit(s.reserve, "AssetUnpaused").withArgs(paxg);
    expect(await s.reserve.assetPaused(paxg)).to.equal(false);
  });

  it("lifts every hold with the current number after any number of re-assertions, and refuses each earlier one", async function () {
    const s = await loadFixture(productionSystem);
    const paxg = await s.paxg.getAddress();
    const pausables = [s.vault, s.oracle, s.stabilityPool] as const;
    for (const c of pausables) await c.connect(s.guardian).emergencyPause();
    await s.reserve.connect(s.guardian).pauseAsset(paxg);
    for (let day = 0; day < 3; day++) {
      await time.increase(DAY);
      for (const c of pausables) await c.connect(s.guardian).extendPause();
      await s.reserve.connect(s.guardian).pauseAsset(paxg);
    }

    for (const c of pausables) {
      expect(await c.pauseEpoch()).to.equal(4n);
      for (const earlier of [1n, 2n, 3n]) await expect(c.unpause(earlier)).to.be.revertedWith("Different pause");
      expect(await c.paused()).to.equal(true);
      await c.unpause(4n);
      expect(await c.paused()).to.equal(false);
      expect(await c.pauseEpoch()).to.equal(4n);
    }
    expect(await s.reserve.assetPauseEpoch(paxg)).to.equal(4n);
    for (const earlier of [1n, 2n, 3n]) await expect(s.reserve.unpauseAsset(paxg, earlier)).to.be.revertedWith("Different pause");
    expect(await s.reserve.assetPaused(paxg)).to.equal(true);
    await s.reserve.unpauseAsset(paxg, 4n);
    expect(await s.reserve.assetPaused(paxg)).to.equal(false);
  });

  it("refuses a wrong number on all four unpause functions", async function () {
    const s = await loadFixture(productionSystem);
    const paxg = await s.paxg.getAddress();
    await s.vault.connect(s.guardian).emergencyPause();
    await s.oracle.connect(s.guardian).emergencyPause();
    await s.stabilityPool.connect(s.guardian).emergencyPause();
    await s.reserve.connect(s.guardian).pauseAsset(paxg);

    for (const wrong of [0n, 2n]) {
      await expect(s.vault.unpause(wrong)).to.be.revertedWith("Different pause");
      await expect(s.oracle.unpause(wrong)).to.be.revertedWith("Different pause");
      await expect(s.stabilityPool.unpause(wrong)).to.be.revertedWith("Different pause");
      await expect(s.reserve.unpauseAsset(paxg, wrong)).to.be.revertedWith("Different pause");
    }
    // The role check comes first: the guardian is refused whatever the number.
    await expect(s.vault.connect(s.guardian).unpause(1n)).to.be.revertedWithCustomError(s.vault, "AccessControlUnauthorizedAccount");

    await s.vault.unpause(1n);
    await s.oracle.unpause(1n);
    await s.stabilityPool.unpause(1n);
    await s.reserve.unpauseAsset(paxg, 1n);
    expect(await s.vault.paused()).to.equal(false);
    expect(await s.oracle.paused()).to.equal(false);
    expect(await s.stabilityPool.paused()).to.equal(false);
    expect(await s.reserve.assetPaused(paxg)).to.equal(false);
  });
});
