import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { SurplusBuffer, MockGsusd, TimelockController } from "../typechain-types";
import { minReserveSalt, MinReserveRequest, policyFloor, runSetMinReserve } from "../scripts/lib/minReserve";

type HardhatEthersSigner = Awaited<ReturnType<typeof ethers.getSigners>>[number];

/**
 * The optional governed reserve minimum, as driven by scripts/set-min-reserve.ts: direct
 * before the handover, through the timelock after it, with the guard before every step that
 * would send. The 2% policy floor itself is automatic (docs/BUSINESS_MODEL.md section 5), so
 * no value set here can take the effective floor below it.
 */
describe("Governed reserve minimum (scripts/set-min-reserve.ts)", function () {
  const MIN_DELAY = 48 * 60 * 60;
  const SUPPLY = ethers.parseEther("100000");
  const POLICY = ethers.parseEther("2000");
  const INITIAL = ethers.parseEther("1000");
  const TARGET = ethers.parseEther("5000");

  let buffer: SurplusBuffer;
  let gsusd: MockGsusd;
  let timelock: TimelockController;
  let deployer: HardhatEthersSigner;
  let proposer: HardhatEthersSigner;
  let executor: HardhatEthersSigner;
  let holder: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  beforeEach(async function () {
    [deployer, proposer, executor, holder, stranger] = await ethers.getSigners();
    gsusd = await (await ethers.getContractFactory("MockGsusd")).deploy();
    await gsusd.mint(holder.address, SUPPLY);
    buffer = await (await ethers.getContractFactory("SurplusBuffer")).deploy(await gsusd.getAddress());
    timelock = await (
      await ethers.getContractFactory("TimelockController")
    ).deploy(MIN_DELAY, [proposer.address], [executor.address], ethers.ZeroAddress);
    await buffer.setMinGsusdReserve(INITIAL);
  });

  function request(signer: HardhatEthersSigner, overrides: Partial<MinReserveRequest> = {}): MinReserveRequest {
    return {
      buffer,
      timelock,
      signer,
      floor: TARGET,
      memo: "ramp week 3",
      confirm: true,
      ...overrides,
    };
  }

  it("computes the policy floor as 2% of supply, rounded down like verify-deployment", function () {
    expect(policyFloor(SUPPLY)).to.equal(POLICY);
    expect(policyFloor(0n)).to.equal(0n);
    expect(policyFloor(49n)).to.equal(0n);
    expect(policyFloor(50n)).to.equal(1n);
  });

  it("derives a distinct salt per floor and memo", function () {
    const base = minReserveSalt(TARGET, "a");
    expect(minReserveSalt(TARGET, "a")).to.equal(base);
    expect(minReserveSalt(TARGET, "b")).to.not.equal(base);
    expect(minReserveSalt(TARGET + 1n, "a")).to.not.equal(base);
  });

  describe("before the handover (signer holds GOVERNANCE_ROLE)", function () {
    it("sets the floor in one direct call", async function () {
      const outcome = await runSetMinReserve(request(deployer));
      expect(outcome.step).to.equal("set");
      expect(outcome.path).to.equal("direct");
      expect(await buffer.minGsusdReserve()).to.equal(TARGET);
    });

    it("sends nothing on a dry run", async function () {
      const outcome = await runSetMinReserve(request(deployer, { confirm: false }));
      expect(outcome.step).to.equal("dry-run");
      expect(await buffer.minGsusdReserve()).to.equal(INITIAL);
    });

    it("allows a value at or below the automatic floor, noting that it changes nothing today", async function () {
      const lines: string[] = [];
      const outcome = await runSetMinReserve(request(deployer, { floor: POLICY - 1n, log: (line) => lines.push(line) }));
      expect(outcome.step).to.equal("set");
      expect(await buffer.minGsusdReserve()).to.equal(POLICY - 1n);
      expect(await buffer.effectiveMinGsusdReserve()).to.equal(POLICY);
      expect(lines.some((line) => /Automatic floor 2000\.0 GSUSD/.test(line))).to.equal(true);
      expect(lines.some((line) => /changes nothing today/.test(line))).to.equal(true);
    });

    it("clears the governed minimum with zero, leaving the automatic floor in force", async function () {
      const lines: string[] = [];
      const outcome = await runSetMinReserve(request(deployer, { floor: 0n, log: (line) => lines.push(line) }));
      expect(outcome.step).to.equal("set");
      expect(await buffer.minGsusdReserve()).to.equal(0n);
      expect(await buffer.effectiveMinGsusdReserve()).to.equal(POLICY);
      expect(lines.some((line) => /automatic 2% floor alone/.test(line))).to.equal(true);
    });

    it("lets a governed minimum above the automatic floor raise the effective floor", async function () {
      await runSetMinReserve(request(deployer));
      expect(await buffer.effectiveMinGsusdReserve()).to.equal(TARGET);
    });

    it("refuses the value already set and a negative value", async function () {
      await expect(runSetMinReserve(request(deployer, { floor: INITIAL }))).to.be.rejectedWith(/already 1000\.0 GSUSD/);
      await expect(runSetMinReserve(request(deployer, { floor: -1n }))).to.be.rejectedWith(/negative/);
    });
  });

  describe("after the handover (timelock holds GOVERNANCE_ROLE)", function () {
    beforeEach(async function () {
      await buffer.transferGovernance(await timelock.getAddress());
    });

    it("schedules, reports the wait, executes, then reports done", async function () {
      const first = await runSetMinReserve(request(proposer));
      expect(first.step).to.equal("scheduled");
      expect(first.readyAt).to.equal((await time.latest()) + MIN_DELAY);

      const second = await runSetMinReserve(request(executor));
      expect(second.step).to.equal("waiting");
      expect(second.operationId).to.equal(first.operationId);
      expect(await buffer.minGsusdReserve()).to.equal(INITIAL);

      await time.increase(MIN_DELAY + 1);
      const third = await runSetMinReserve(request(executor));
      expect(third.step).to.equal("executed");
      expect(await buffer.minGsusdReserve()).to.equal(TARGET);

      const fourth = await runSetMinReserve(request(executor));
      expect(fourth.step).to.equal("done");
    });

    it("hands a non-proposer the exact schedule call for the proposer Safe", async function () {
      const outcome = await runSetMinReserve(request(stranger));
      expect(outcome.step).to.equal("awaiting-proposer");
      const op = outcome.operation;
      if (!op) throw new Error("operation missing");
      expect(op.target).to.equal(await buffer.getAddress());
      expect(op.data).to.equal(buffer.interface.encodeFunctionData("setMinGsusdReserve", [TARGET]));
      expect(await timelock.hashOperation(op.target, 0n, op.data, op.predecessor, op.salt)).to.equal(
        outcome.operationId
      );
      expect(await timelock.getOperationState(outcome.operationId ?? ethers.ZeroHash)).to.equal(0n);
    });

    it("executes a lowering, and the effective floor still never falls below 2% of supply", async function () {
      const high = ethers.parseEther("8000");
      const fresh = await (await ethers.getContractFactory("SurplusBuffer")).deploy(await gsusd.getAddress());
      await fresh.setMinGsusdReserve(high);
      await fresh.transferGovernance(await timelock.getAddress());
      const lines: string[] = [];
      expect((await runSetMinReserve(request(proposer, { buffer: fresh, floor: 0n }))).step).to.equal("scheduled");
      await time.increase(MIN_DELAY + 1);
      const outcome = await runSetMinReserve(request(executor, { buffer: fresh, floor: 0n, log: (line) => lines.push(line) }));
      expect(outcome.step).to.equal("executed");
      expect(await fresh.minGsusdReserve()).to.equal(0n);
      expect(await fresh.effectiveMinGsusdReserve()).to.equal(POLICY);
      expect(lines.some((line) => /never falls below 2% of supply/.test(line))).to.equal(true);
      // Supply growth after the change raises the floor with no further governance step.
      await gsusd.mint(holder.address, SUPPLY);
      expect(await fresh.effectiveMinGsusdReserve()).to.equal(2n * POLICY);
    });

    it("executes a value set in the meantime as a no-op so the operation closes", async function () {
      const a = await runSetMinReserve(request(proposer, { memo: "first" }));
      const b = await runSetMinReserve(request(proposer, { memo: "second" }));
      await time.increase(MIN_DELAY + 1);
      expect((await runSetMinReserve(request(executor, { memo: "first" }))).step).to.equal("executed");
      expect(await buffer.minGsusdReserve()).to.equal(TARGET);
      const second = await runSetMinReserve(request(executor, { memo: "second" }));
      expect(second.step).to.equal("executed");
      expect(second.operationId).to.equal(b.operationId);
      expect(second.operationId).to.not.equal(a.operationId);
      expect((await runSetMinReserve(request(executor, { memo: "second" }))).step).to.equal("done");
    });

    it("keeps otherwise identical changes apart by memo", async function () {
      const a = await runSetMinReserve(request(proposer, { memo: "first" }));
      const b = await runSetMinReserve(request(proposer, { memo: "second" }));
      expect(a.step).to.equal("scheduled");
      expect(b.step).to.equal("scheduled");
      expect(a.operationId).to.not.equal(b.operationId);
    });
  });
});
