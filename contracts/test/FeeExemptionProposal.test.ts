import { expect } from "chai";
import { ethers } from "hardhat";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import type { ExpiringTimelockController, GoldGovernance, GoldVault, MockAggregatorV3 } from "../typechain-types";
import {
  FeeExemption,
  encodeCancel,
  encodeExecute,
  encodeSchedule,
  encodeVaultCall,
  executionWindow,
  exemptionSalt,
  expiredSince,
  operationId,
  parseExempt,
  readExemption,
  timelockRoleHolders,
} from "../scripts/lib/feeExemptionProposal";
import { operationSalt } from "../scripts/lib/timelockStep";

type HardhatEthersSigner = Awaited<ReturnType<typeof ethers.getSigners>>[number];

/**
 * The origination fee exemption calldata (scripts/print-fee-exemption-proposal.ts), proven
 * against the real GoldGovernance, its ExpiringTimelockController and the real vault: a proposer
 * that submits exactly the schedule bytes and an executor that submits exactly the execute bytes
 * 48 hours later exempt the account, and nothing else does.
 */
describe("Fee exemption proposal calldata (scripts/print-fee-exemption-proposal.ts)", function () {
  const MIN_DELAY = 48 * 60 * 60;
  const GRACE = 7 * 24 * 60 * 60;

  let proposer: HardhatEthersSigner;
  let executor: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;
  let seedVaultOwner: HardhatEthersSigner;
  let vault: GoldVault;
  let governance: GoldGovernance;
  let timelock: ExpiringTimelockController;

  beforeEach(async function () {
    [, proposer, executor, stranger, seedVaultOwner] = await ethers.getSigners();
    const paxg = await (await ethers.getContractFactory("MockERC20")).deploy("Paxos Gold", "PAXG", 18);
    const xaut = await (await ethers.getContractFactory("MockERC20")).deploy("Tether Gold", "XAUt", 6);
    const feed = (await (await ethers.getContractFactory("MockAggregatorV3")).deploy(8)) as MockAggregatorV3;
    const now = await time.latest();
    await feed.setLatestRoundData(1, 4_150_00000000n, now, now, 1);
    const oracle = await (await ethers.getContractFactory("GoldOracle")).deploy(await feed.getAddress(), await feed.getAddress(), await paxg.getAddress(), await xaut.getAddress(), 90000);
    const stablecoin = await (await ethers.getContractFactory("GoldStablecoin")).deploy();
    const module = await (await ethers.getContractFactory("StabilityModule")).deploy();
    vault = (await (await ethers.getContractFactory("GoldVault")).deploy(await oracle.getAddress(), await stablecoin.getAddress(), await module.getAddress())) as GoldVault;
    // The real wiring: the wrapper creates the timelock and names the proposer and executor on it.
    governance = (await (await ethers.getContractFactory("GoldGovernance")).deploy(
      [proposer.address],
      [executor.address],
      await vault.getAddress(),
      await oracle.getAddress(),
      await module.getAddress()
    )) as GoldGovernance;
    timelock = (await ethers.getContractAt("ExpiringTimelockController", await governance.getTimelockAddress())) as ExpiringTimelockController;
    // The handover: the timelock governs the vault, the deployer no longer does.
    await vault.transferGovernance(await timelock.getAddress());
  });

  async function proposal(overrides: Partial<FeeExemption> = {}): Promise<FeeExemption> {
    return { timelock: await timelock.getAddress(), vault: await vault.getAddress(), account: seedVaultOwner.address, exempt: true, memo: "", ...overrides };
  }

  const send = (signer: HardhatEthersSigner, tx: { to: string; data: string }) => signer.sendTransaction({ to: tx.to, data: tx.data });

  it("computes the operation id the timelock computes, and the timelock announces it when scheduled", async function () {
    const p = await proposal();
    const id = operationId(p);
    expect(id).to.equal(await timelock.hashOperation(p.vault, 0, encodeVaultCall(p), ethers.ZeroHash, exemptionSalt(p)));
    const schedule = encodeSchedule(p, BigInt(MIN_DELAY));
    expect(schedule.to).to.equal(await timelock.getAddress());
    await expect(send(proposer, schedule))
      .to.emit(timelock, "CallScheduled")
      .withArgs(id, 0, p.vault, 0, encodeVaultCall(p), ethers.ZeroHash, MIN_DELAY);
    expect((await readExemption(ethers.provider, p)).operationId).to.equal(id);
  });

  it("schedules from the proposer alone: a stranger, the executor and the deployer are refused", async function () {
    const schedule = encodeSchedule(await proposal(), BigInt(MIN_DELAY));
    const [deployer] = await ethers.getSigners();
    for (const signer of [stranger, executor, deployer]) {
      await expect(send(signer, schedule)).to.be.revertedWithCustomError(timelock, "AccessControlUnauthorizedAccount");
    }
    await send(proposer, schedule);
  });

  it("exempts the account once the executor submits the execute bytes after the delay, and not before", async function () {
    const p = await proposal();
    expect(await vault.originationFeeExempt(p.account)).to.equal(false);
    await send(proposer, encodeSchedule(p, BigInt(MIN_DELAY)));
    const execute = encodeExecute(p);
    expect(execute.to).to.equal(await timelock.getAddress());
    await expect(send(executor, execute)).to.be.revertedWithCustomError(timelock, "TimelockUnexpectedOperationState");
    await time.increase(MIN_DELAY - 60);
    await expect(send(executor, execute)).to.be.revertedWithCustomError(timelock, "TimelockUnexpectedOperationState");
    await time.increase(60);
    // The proposer cannot execute and neither can a stranger: the executor Safe alone.
    await expect(send(proposer, execute)).to.be.revertedWithCustomError(timelock, "AccessControlUnauthorizedAccount");
    await expect(send(stranger, execute)).to.be.revertedWithCustomError(timelock, "AccessControlUnauthorizedAccount");
    await expect(send(executor, execute)).to.emit(vault, "OriginationFeeExemptSet").withArgs(p.account, true);
    expect(await vault.originationFeeExempt(p.account)).to.equal(true);
    expect((await readExemption(ethers.provider, p)).state).to.equal("done");
  });

  it("refuses a schedule whose delay is below the timelock's minimum, the value the printer reads", async function () {
    const p = await proposal();
    const reading = await readExemption(ethers.provider, p);
    expect(reading.delay).to.equal(BigInt(MIN_DELAY));
    expect(reading.gracePeriod).to.equal(BigInt(GRACE));
    await expect(send(proposer, encodeSchedule(p, reading.delay - 1n))).to.be.revertedWithCustomError(timelock, "TimelockInsufficientDelay");
    await send(proposer, encodeSchedule(p, reading.delay));
  });

  it("reports the state, the exact ready time and the window at each stage", async function () {
    const p = await proposal();
    const before = await readExemption(ethers.provider, p);
    expect(before).to.include({ state: "unset", exemptNow: false, timelockGoverns: true, readyAt: undefined });
    // Not scheduled yet: the estimate assumes the schedule lands in the latest block, and says it is no more than that.
    expect(executionWindow(before)).to.deep.equal({ earliest: before.chainTime + MIN_DELAY, latest: before.chainTime + MIN_DELAY + GRACE, exact: false });

    const tx = await send(proposer, encodeSchedule(p, before.delay));
    const minedAt = (await ethers.provider.getBlock((await tx.wait())?.blockNumber ?? 0))?.timestamp ?? 0;
    const waiting = await readExemption(ethers.provider, p);
    expect(waiting.state).to.equal("waiting");
    expect(waiting.readyAt).to.equal(minedAt + MIN_DELAY);
    expect(executionWindow(waiting)).to.deep.equal({ earliest: minedAt + MIN_DELAY, latest: minedAt + MIN_DELAY + GRACE, exact: true });

    await time.increaseTo(minedAt + MIN_DELAY);
    expect((await readExemption(ethers.provider, p)).state).to.equal("ready");
  });

  it("is refused by the timelock once the grace period has passed, and the proposer's cancel clears it for a fresh schedule", async function () {
    const p = await proposal();
    await send(proposer, encodeSchedule(p, BigInt(MIN_DELAY)));
    await time.increase(MIN_DELAY + GRACE + 1);
    await expect(send(executor, encodeExecute(p))).to.be.revertedWithCustomError(timelock, "TimelockOperationExpired").withArgs(operationId(p));
    expect(await vault.originationFeeExempt(p.account)).to.equal(false);
    await expect(send(executor, encodeCancel(p))).to.be.revertedWithCustomError(timelock, "AccessControlUnauthorizedAccount");
    await send(proposer, encodeCancel(p));
    expect((await readExemption(ethers.provider, p)).state).to.equal("unset");
    await send(proposer, encodeSchedule(p, BigInt(MIN_DELAY)));
    await time.increase(MIN_DELAY);
    await send(executor, encodeExecute(p));
    expect(await vault.originationFeeExempt(p.account)).to.equal(true);
  });

  it("reads an operation past the grace period as expired, with no window left, until the cancel clears it", async function () {
    const p = await proposal();
    const tx = await send(proposer, encodeSchedule(p, BigInt(MIN_DELAY)));
    const minedAt = (await ethers.provider.getBlock((await tx.wait())?.blockNumber ?? 0))?.timestamp ?? 0;
    const readyAt = minedAt + MIN_DELAY;

    // The last second of the window: still ready, not expired, the window exact.
    await time.increaseTo(readyAt + GRACE - 1);
    const lastSecond = await readExemption(ethers.provider, p);
    expect(lastSecond).to.include({ state: "ready", expired: false, readyAt });
    expect(expiredSince(lastSecond)).to.equal(undefined);
    expect(executionWindow(lastSecond)).to.deep.equal({ earliest: readyAt, latest: readyAt + GRACE, exact: true });

    await time.increaseTo(readyAt + GRACE + 1);
    const expired = await readExemption(ethers.provider, p);
    // The timelock itself still says Ready; only the expired flag tells the two apart.
    expect(await timelock.getOperationState(operationId(p))).to.equal(2n);
    expect(await timelock.isOperationExpired(operationId(p))).to.equal(true);
    expect(expired).to.include({ state: "ready", expired: true, readyAt });
    expect(expiredSince(expired)).to.equal(readyAt + GRACE);
    // No window is left on the old schedule: the times are an estimate for the fresh one, never a time already past.
    const window = executionWindow(expired);
    expect(window).to.deep.equal({ earliest: expired.chainTime + MIN_DELAY, latest: expired.chainTime + MIN_DELAY + GRACE, exact: false });
    expect(window.latest).to.be.greaterThan(expired.chainTime);
    await expect(send(executor, encodeExecute(p))).to.be.revertedWithCustomError(timelock, "TimelockOperationExpired");

    await send(proposer, encodeCancel(p));
    expect(await readExemption(ethers.provider, p)).to.include({ state: "unset", expired: false, readyAt: undefined });
  });

  it("never reads a waiting, done or unset operation as expired, however old", async function () {
    const p = await proposal();
    expect((await readExemption(ethers.provider, p)).expired).to.equal(false);
    await send(proposer, encodeSchedule(p, BigInt(MIN_DELAY)));
    expect(await readExemption(ethers.provider, p)).to.include({ state: "waiting", expired: false });
    await time.increase(MIN_DELAY);
    await send(executor, encodeExecute(p));
    await time.increase(GRACE * 2);
    expect(await readExemption(ethers.provider, p)).to.include({ state: "done", expired: false });
  });

  it("reads a timelock without a grace period (deployed before 2026-11-06) as never expired", async function () {
    const [deployer] = await ethers.getSigners();
    const stock = await (await ethers.getContractFactory("TimelockController")).deploy(MIN_DELAY, [proposer.address], [executor.address], deployer.address);
    const p = await proposal({ timelock: await stock.getAddress() });
    await send(proposer, encodeSchedule(p, BigInt(MIN_DELAY)));
    await time.increase(MIN_DELAY + GRACE * 4);
    const reading = await readExemption(ethers.provider, p);
    expect(reading).to.include({ state: "ready", expired: false, gracePeriod: undefined });
    expect(executionWindow(reading).latest).to.equal(undefined);
  });

  it("the printer branches on the expired flag: the cancel first, and never \"Already scheduled\" for an expired operation", function () {
    const source = readFileSync(resolve(__dirname, "..", "scripts", "print-fee-exemption-proposal.ts"), "utf8");
    const expiredBranch = source.indexOf("if (reading.expired) {");
    const alreadyScheduled = source.indexOf("Already scheduled");
    expect(expiredBranch).to.be.greaterThan(-1);
    expect(alreadyScheduled).to.be.greaterThan(expiredBranch);
    expect(source).to.include("cancels the expired operation");
    expect(source).to.include("await printExpired(proposal, reading, snap.governanceSafes.proposers)");
  });

  it("removes an exemption through its own operation, and keeps repeats apart by memo", async function () {
    const grant = await proposal();
    const revoke = await proposal({ exempt: false });
    const again = await proposal({ memo: "second seed vault" });
    expect(new Set([operationId(grant), operationId(revoke), operationId(again)]).size).to.equal(3);
    await send(proposer, encodeSchedule(grant, BigInt(MIN_DELAY)));
    await time.increase(MIN_DELAY);
    await send(executor, encodeExecute(grant));
    await send(proposer, encodeSchedule(revoke, BigInt(MIN_DELAY)));
    await time.increase(MIN_DELAY);
    await send(executor, encodeExecute(revoke));
    expect(await vault.originationFeeExempt(grant.account)).to.equal(false);
    // The executed grant cannot be scheduled a second time under the same memo; a new memo is a new operation.
    await expect(send(proposer, encodeSchedule(grant, BigInt(MIN_DELAY)))).to.be.revertedWithCustomError(timelock, "TimelockUnexpectedOperationState");
    await send(proposer, encodeSchedule(again, BigInt(MIN_DELAY)));
  });

  it("uses the salt convention of the other direct timelock operations and the vault's own call", async function () {
    const p = await proposal({ memo: "seed vault" });
    expect(exemptionSalt(p)).to.equal(operationSalt("origination-fee-exempt", ["address", "bool", "string"], [p.account, true, "seed vault"]));
    expect(encodeVaultCall(p)).to.equal(vault.interface.encodeFunctionData("setOriginationFeeExempt", [p.account, true]));
    const schedule = encodeSchedule(p, BigInt(MIN_DELAY));
    expect(schedule.data).to.equal(timelock.interface.encodeFunctionData("schedule", [p.vault, 0, encodeVaultCall(p), ethers.ZeroHash, exemptionSalt(p), MIN_DELAY]));
    expect(encodeExecute(p).data).to.equal(timelock.interface.encodeFunctionData("execute", [p.vault, 0, encodeVaultCall(p), ethers.ZeroHash, exemptionSalt(p)]));
    expect(schedule.decoded).to.include(`GoldVault.setOriginationFeeExempt(account ${p.account}, exempt true)`);
    expect(schedule.decoded).to.include(`delay ${MIN_DELAY}`);
    expect(schedule.value).to.equal("0");
  });

  it("names who holds each timelock role: the configured proposer and executor, never a stranger", async function () {
    const address = await timelock.getAddress();
    const candidates = [proposer.address, executor.address, stranger.address, await governance.getAddress()];
    // The wrapper is a proposer and an executor too, but has no helper for this call.
    expect(await timelockRoleHolders(ethers.provider, address, "proposer", candidates)).to.deep.equal([proposer.address, await governance.getAddress()]);
    expect(await timelockRoleHolders(ethers.provider, address, "executor", candidates)).to.deep.equal([executor.address, await governance.getAddress()]);
    expect(await timelockRoleHolders(ethers.provider, address, "executor", [ethers.ZeroAddress])).to.deep.equal([]);
  });

  it("the wrapper has no helper for this call, so the timelock is the only route", async function () {
    const names = governance.interface.fragments.filter((f) => f.type === "function").map((f) => f.format("sighash"));
    expect(names.some((name) => /exempt/i.test(name))).to.equal(false);
    // And the deployer, after the handover, cannot make the call directly.
    await expect(vault.setOriginationFeeExempt(seedVaultOwner.address, true)).to.be.revertedWithCustomError(vault, "AccessControlUnauthorizedAccount");
  });

  it("refuses shapes the vault would revert on, and reads EXEMPT strictly", async function () {
    const p = await proposal();
    expect(() => encodeSchedule({ ...p, account: ethers.ZeroAddress }, 1n)).to.throw("zero address");
    expect(() => encodeExecute({ ...p, account: ethers.ZeroAddress })).to.throw("zero address");
    expect(() => encodeSchedule(p, -1n)).to.throw("negative");
    expect(parseExempt(undefined)).to.equal(true);
    expect(parseExempt(" false ")).to.equal(false);
    for (const bad of ["yes", "1", "TRUE", ""]) expect(() => parseExempt(bad), bad).to.throw("EXEMPT must be true or false");
  });

  it("says when the handover has not run: the timelock does not govern the vault yet", async function () {
    const fresh = (await (await ethers.getContractFactory("GoldVault")).deploy(await vault.oracle(), await vault.stablecoin(), await vault.stabilityModule())) as GoldVault;
    const reading = await readExemption(ethers.provider, await proposal({ vault: await fresh.getAddress() }));
    expect(reading.timelockGoverns).to.equal(false);
  });
});
