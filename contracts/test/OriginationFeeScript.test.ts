import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { TimelockController } from "../typechain-types";
import { GOLD_PRICE, productionSystem, setValidPrice } from "./helpers/productionSystem";
import {
  feePercent,
  OriginationFeeRequest,
  originationFeeSalt,
  pegCeiling,
  runSetOriginationFee,
} from "../scripts/lib/originationFee";

type System = Awaited<ReturnType<typeof productionSystem>>;
type HardhatEthersSigner = Awaited<ReturnType<typeof ethers.getSigners>>[number];

/**
 * The governed origination fee, as driven by scripts/set-origination-fee.ts: direct before
 * the handover, through the timelock after it, with the guard before every step that would
 * send. 5 bps at launch; this is how governance moves it within the 100 bps cap.
 */
describe("Governed origination fee (scripts/set-origination-fee.ts)", function () {
  let s: System;
  let timelock: TimelockController;

  beforeEach(async function () {
    s = await loadFixture(productionSystem);
    timelock = await ethers.getContractAt("TimelockController", s.timelockAddr);
  });

  function request(signer: HardhatEthersSigner, overrides: Partial<OriginationFeeRequest> = {}): OriginationFeeRequest {
    return { vault: s.vault, timelock, signer, bps: 5n, memo: "launch fee", confirm: true, ...overrides };
  }

  it("states the fee and the peg ceiling it implies", function () {
    expect(feePercent(5n)).to.equal("0.05%");
    expect(feePercent(100n)).to.equal("1%");
    expect(pegCeiling(5n)).to.equal("1.0005");
    expect(pegCeiling(100n)).to.equal("1.0101");
  });

  it("derives a distinct salt per value and memo", function () {
    const base = originationFeeSalt(5n, "a");
    expect(originationFeeSalt(5n, "b")).to.not.equal(base);
    expect(originationFeeSalt(6n, "a")).to.not.equal(base);
  });

  describe("before the handover (signer holds GOVERNANCE_ROLE)", function () {
    it("sets the fee in one direct call", async function () {
      const outcome = await runSetOriginationFee(request(s.deployer));
      expect(outcome.step).to.equal("set");
      expect(outcome.path).to.equal("direct");
      expect(await s.vault.originationFeeBps()).to.equal(5n);
    });

    it("sends nothing on a dry run", async function () {
      expect((await runSetOriginationFee(request(s.deployer, { confirm: false }))).step).to.equal("dry-run");
      expect(await s.vault.originationFeeBps()).to.equal(0n);
    });

    it("refuses a value above the cap and the value already set", async function () {
      await expect(runSetOriginationFee(request(s.deployer, { bps: 101n }))).to.be.rejectedWith(/between 0 and 100/);
      await expect(runSetOriginationFee(request(s.deployer, { bps: 0n }))).to.be.rejectedWith(/already 0/);
    });
  });

  describe("after the handover (timelock holds GOVERNANCE_ROLE)", function () {
    beforeEach(async function () {
      await s.vault.transferGovernance(s.timelockAddr);
    });

    it("schedules, reports the wait, executes, then reports done", async function () {
      const delay = Number(await timelock.getMinDelay());
      const first = await runSetOriginationFee(request(s.proposer));
      expect(first.step).to.equal("scheduled");

      const second = await runSetOriginationFee(request(s.executor));
      expect(second.step).to.equal("waiting");
      expect(await s.vault.originationFeeBps()).to.equal(0n);

      await time.increase(delay + 1);
      expect((await runSetOriginationFee(request(s.executor))).step).to.equal("executed");
      expect(await s.vault.originationFeeBps()).to.equal(5n);
      expect((await runSetOriginationFee(request(s.executor))).step).to.equal("done");
    });

    // ExpiringTimelockController refuses an operation more
    // than GRACE_PERIOD after it became ready, yet getOperationState still reads it as Ready.
    it("reports an operation past the grace period as expired, sends nothing and says how to start again", async function () {
      const delay = Number(await timelock.getMinDelay());
      const first = await runSetOriginationFee(request(s.proposer));
      expect(first.step).to.equal("scheduled");
      await time.increase(delay + 7 * 24 * 3600 + 2);

      const lines: string[] = [];
      const outcome = await runSetOriginationFee(request(s.executor, { log: (line) => lines.push(line) }));
      expect(outcome.step).to.equal("expired");
      expect(outcome.operationId).to.equal(first.operationId);
      expect(await s.vault.originationFeeBps()).to.equal(0n);
      // Still pending: nothing was sent, and the proposer can cancel it.
      expect(await timelock.getOperationState(first.operationId ?? ethers.ZeroHash)).to.equal(2n);
      const said = lines.join("\n");
      expect(said).to.match(/expired/i);
      expect(said).to.include(`cancel(${first.operationId})`);
      expect(said).to.include("CANCELLER_ROLE");
      // OpenZeppelin's cancel deletes the operation, so the same memo schedules it afresh.
      expect(said).to.include("once it is cancelled the same memo schedules it afresh");
      expect(said).to.match(/different memo schedules a new operation without the cancel/);

      await timelock.connect(s.proposer).cancel(first.operationId ?? ethers.ZeroHash);
      const again = await runSetOriginationFee(request(s.proposer));
      expect(again.step).to.equal("scheduled");
      expect(again.operationId).to.equal(first.operationId);
      expect(again.readyAt).to.equal((await time.latest()) + delay);
    });

    it("names the end of the grace period while the operation can still run", async function () {
      const delay = Number(await timelock.getMinDelay());
      await runSetOriginationFee(request(s.proposer));
      await time.increase(delay + 1);
      const lines: string[] = [];
      const outcome = await runSetOriginationFee(request(s.alice, { log: (line) => lines.push(line) }));
      expect(outcome.step).to.equal("awaiting-executor");
      expect(lines.join("\n")).to.match(/until \d{4}-\d{2}-\d{2}T/);
    });

    it("hands a non-proposer the exact schedule call for the proposer Safe", async function () {
      const outcome = await runSetOriginationFee(request(s.alice));
      expect(outcome.step).to.equal("awaiting-proposer");
      const op = outcome.operation;
      if (!op) throw new Error("operation missing");
      expect(op.target).to.equal(await s.vault.getAddress());
      expect(op.data).to.equal(s.vault.interface.encodeFunctionData("setOriginationFeeBps", [5n]));
    });

    it("charges the executed fee on the next mint", async function () {
      await runSetOriginationFee(request(s.proposer));
      await time.increase(Number(await timelock.getMinDelay()) + 1);
      await runSetOriginationFee(request(s.executor));
      // The 48 hour wait leaves the mock feed stale; a fresh round lets the mint price.
      await setValidPrice(s.paxgFeed, GOLD_PRICE);
      const before = await s.stablecoin.balanceOf(s.alice.address);
      await s.vault.connect(s.alice).deposit(await s.paxg.getAddress(), ethers.parseEther("10"));
      await s.vault.connect(s.alice).mint(ethers.parseEther("10000"));
      expect((await s.stablecoin.balanceOf(s.alice.address)) - before).to.equal(ethers.parseEther("9995"));
      expect(await s.vault.getVaultCurrentDebt(s.alice.address)).to.be.gte(ethers.parseEther("10000"));
    });
  });
});
