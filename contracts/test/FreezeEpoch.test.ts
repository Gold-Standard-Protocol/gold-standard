import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { GOLD_PRICE, productionSystem, setValidPrice } from "./helpers/productionSystem";

/**
 * The token freeze counterpart of the pause epochs. guardianUnfreezeToken accepts governance, so the
 * timelock can schedule it, and a freeze lapses by itself after FREEZE_DURATION. An unfreeze
 * that matured after its freeze had lapsed reverts "Not frozen" and stays executable for the
 * grace period; without a freeze number an open executor could run it inside that period to lift
 * a later freeze for a different incident and liquidate the token. Every unfreeze now names the
 * freeze it was approved for: freezeEpoch(token), and every freezeToken call takes a new number,
 * a re-freeze of a frozen token included, so an unfreeze lands only if nobody has re-asserted the
 * freeze since it was scheduled. Foundry repeats the replay with a same transaction liquidation
 * (test-foundry/FreezeEpoch.t.sol).
 */
describe("Freeze epochs: an unfreeze lifts only the freeze it was approved for", function () {
  const DAY = 24 * 3600;
  const DELAY = 48 * 3600;

  /** productionSystem with the oracle handed to a GoldGovernance whose timelock has the open executor. */
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
    await s.oracle.transferGovernance(await timelock.getAddress());
    return { ...s, openGovernance: governance, timelock };
  }

  async function freshPrices(s: Awaited<ReturnType<typeof productionSystem>>, price: bigint) {
    await setValidPrice(s.paxgFeed, price);
    await setValidPrice(s.xautFeed, price);
  }

  async function walkTo(s: Awaited<ReturnType<typeof productionSystem>>, target: bigint) {
    const paxg = await s.paxg.getAddress();
    const xaut = await s.xaut.getAddress();
    let current = await s.oracle.getLastKnownPrice(paxg);
    while (current !== target) {
      let next = target < current ? (current * 91n) / 100n : (current * 109n) / 100n;
      if ((target < current && next < target) || (target > current && next > target)) next = target;
      await freshPrices(s, next);
      await s.oracle.getTokenPrice(paxg);
      await s.oracle.getTokenPrice(xaut);
      current = next;
    }
  }

  it("refuses an unfreeze approved for an earlier freeze, inside the timelock grace period", async function () {
    const s = await loadFixture(openExecutorSystem);
    const oracleAddr = await s.oracle.getAddress();
    const paxg = await s.paxg.getAddress();
    const t0 = await time.latest();

    // 1 PAXG against 1,300 GSUSD: 153.8% at $2,000.
    await s.vault.connect(s.alice).deposit(paxg, ethers.parseEther("1"));
    await s.vault.connect(s.alice).mint(ethers.parseEther("1300"));

    // Freeze 1: governance schedules the unfreeze late in the freeze.
    await s.oracle.connect(s.guardian).freezeToken(paxg);
    expect(await s.oracle.freezeEpoch(paxg)).to.equal(1n);
    expect(await s.oracle.freezeEpoch(await s.xaut.getAddress())).to.equal(0n);
    const stale = s.oracle.interface.encodeFunctionData("guardianUnfreezeToken", [paxg, 1n]);
    const salt = ethers.id("unfreeze freeze 1");
    await time.increaseTo(t0 + 12 * DAY + 12 * 3600);
    await s.timelock.connect(s.proposer).schedule(oracleAddr, 0, stale, ethers.ZeroHash, salt, DELAY);
    const id = await s.timelock.hashOperation(oracleAddr, 0, stale, ethers.ZeroHash, salt);

    // The freeze lapses first, so the matured unfreeze reverts and stays Ready.
    await time.increaseTo(t0 + 14 * DAY + 12 * 3600 + 1);
    expect(await s.oracle.tokenFrozen(paxg)).to.equal(false);
    await expect(s.timelock.connect(s.charlie).execute(oracleAddr, 0, stale, ethers.ZeroHash, salt)).to.be.revertedWith(
      "Not frozen"
    );
    expect(await s.timelock.isOperationReady(id)).to.equal(true);

    // Gold falls while the token is free: the vault is now under the liquidation ratio.
    expect(await s.oracle.getLastKnownPrice(paxg)).to.equal(GOLD_PRICE);
    await walkTo(s, 1400n * 10n ** 8n);

    // Freeze 2, inside the grace period of the stale operation.
    await time.increaseTo(t0 + 16 * DAY);
    await s.oracle.connect(s.guardian).freezeToken(paxg);
    expect(await s.oracle.freezeEpoch(paxg)).to.equal(2n);
    expect(await s.timelock.isOperationExpired(id)).to.equal(false);
    await freshPrices(s, 1400n * 10n ** 8n);

    await expect(s.timelock.connect(s.charlie).execute(oracleAddr, 0, stale, ethers.ZeroHash, salt)).to.be.revertedWith(
      "Different freeze"
    );
    expect(await s.oracle.tokenFrozen(paxg)).to.equal(true);
    await expect(s.vault.connect(s.bob).liquidate(s.alice.address, 0)).to.be.revertedWith("Token frozen");
  });

  it("refuses an unfreeze scheduled before the guardian froze the token again for a new incident", async function () {
    const s = await loadFixture(openExecutorSystem);
    const oracleAddr = await s.oracle.getAddress();
    const paxg = await s.paxg.getAddress();

    // 1 PAXG against 1,300 GSUSD, then gold falls to $1,400: under the liquidation ratio.
    await s.vault.connect(s.alice).deposit(paxg, ethers.parseEther("1"));
    await s.vault.connect(s.alice).mint(ethers.parseEther("1300"));
    await walkTo(s, 1400n * 10n ** 8n);

    await s.oracle.connect(s.guardian).freezeToken(paxg);
    const call = s.oracle.interface.encodeFunctionData("guardianUnfreezeToken", [paxg, await s.oracle.freezeEpoch(paxg)]);
    const salt = ethers.id("unfreeze freeze 1");
    await s.timelock.connect(s.proposer).schedule(oracleAddr, 0, call, ethers.ZeroHash, salt, DELAY);

    // A second incident a day later, while the first freeze is still in force.
    await time.increase(DAY);
    await expect(s.oracle.connect(s.guardian).freezeToken(paxg)).to.emit(s.oracle, "TokenFrozen");
    expect(await s.oracle.freezeEpoch(paxg)).to.equal(2n);

    await time.increase(DELAY);
    await freshPrices(s, 1400n * 10n ** 8n);
    await expect(s.timelock.connect(s.charlie).execute(oracleAddr, 0, call, ethers.ZeroHash, salt)).to.be.revertedWith(
      "Different freeze"
    );
    expect(await s.oracle.tokenFrozen(paxg)).to.equal(true);
    await expect(s.vault.connect(s.bob).liquidate(s.alice.address, 0)).to.be.revertedWith("Token frozen");

    // An unfreeze scheduled after the last freezeToken, naming it, lifts the freeze.
    const fresh = s.oracle.interface.encodeFunctionData("guardianUnfreezeToken", [paxg, 2n]);
    const freshSalt = ethers.id("unfreeze freeze 2");
    await s.timelock.connect(s.proposer).schedule(oracleAddr, 0, fresh, ethers.ZeroHash, freshSalt, DELAY);
    await time.increase(DELAY);
    await freshPrices(s, 1400n * 10n ** 8n);
    await expect(s.timelock.connect(s.charlie).execute(oracleAddr, 0, fresh, ethers.ZeroHash, freshSalt)).to.emit(
      s.oracle,
      "TokenUnfrozen"
    );
    expect(await s.oracle.tokenFrozen(paxg)).to.equal(false);
    expect(await s.oracle.freezeEpoch(paxg)).to.equal(2n);
  });

  it("refuses a wrong number and lets the guardian lift the freeze with the right one", async function () {
    const s = await loadFixture(productionSystem);
    const paxg = await s.paxg.getAddress();
    await s.oracle.connect(s.guardian).freezeToken(paxg);

    for (const wrong of [0n, 2n]) {
      await expect(s.oracle.connect(s.guardian).guardianUnfreezeToken(paxg, wrong)).to.be.revertedWith("Different freeze");
      await expect(s.oracle.guardianUnfreezeToken(paxg, wrong)).to.be.revertedWith("Different freeze");
    }
    expect(await s.oracle.tokenFrozen(paxg)).to.equal(true);
    await expect(s.oracle.connect(s.charlie).guardianUnfreezeToken(paxg, 1n)).to.be.revertedWith(
      "Not guardian or governance"
    );

    await expect(s.oracle.connect(s.guardian).guardianUnfreezeToken(paxg, 1n))
      .to.emit(s.oracle, "TokenUnfrozen")
      .withArgs(paxg, s.guardian.address, GOLD_PRICE);
    expect(await s.oracle.tokenFrozen(paxg)).to.equal(false);
  });
});
