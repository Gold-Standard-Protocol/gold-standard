import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { SurplusBuffer, MockGsusd, TimelockController } from "../typechain-types";
import { assertTimelockMatchesGovernance, resolveSigner } from "../scripts/lib/deploymentContext";
import { readHeadroom, runSurplusWithdrawal, withdrawalSalt, WithdrawalRequest } from "../scripts/lib/surplusWithdrawal";

// Derived rather than imported: the nested toolbox path the older tests use only resolves under
// transpile-only mode, and this file is meant to typecheck.
type HardhatEthersSigner = Awaited<ReturnType<typeof ethers.getSigners>>[number];

/**
 * The operating-cost withdrawal path (docs/BUSINESS_MODEL.md section 5, item 4), as driven
 * by scripts/withdraw-surplus.ts. Before the handover the deployer holds GOVERNANCE_ROLE and
 * one call moves the funds; after it the timelock holds the role and the same command
 * schedules, reports the wait, then executes.
 */
describe("Surplus withdrawal (scripts/withdraw-surplus.ts)", function () {
  const MIN_DELAY = 48 * 60 * 60;
  const DEPOSIT = ethers.parseEther("1000");
  const FLOOR = ethers.parseEther("600");
  const HEADROOM = DEPOSIT - FLOOR;
  const AMOUNT = ethers.parseEther("250");

  let buffer: SurplusBuffer;
  let gsusd: MockGsusd;
  let timelock: TimelockController;
  let deployer: HardhatEthersSigner;
  let vault: HardhatEthersSigner;
  let proposer: HardhatEthersSigner;
  let executor: HardhatEthersSigner;
  let opsSafe: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  beforeEach(async function () {
    [deployer, vault, proposer, executor, opsSafe, stranger] = await ethers.getSigners();

    gsusd = await (await ethers.getContractFactory("MockGsusd")).deploy();
    buffer = await (await ethers.getContractFactory("SurplusBuffer")).deploy(await gsusd.getAddress());
    timelock = await (
      await ethers.getContractFactory("TimelockController")
    ).deploy(MIN_DELAY, [proposer.address], [executor.address], ethers.ZeroAddress);

    await buffer.grantRole(await buffer.VAULT_ROLE(), vault.address);
    await gsusd.mint(vault.address, DEPOSIT);
    await gsusd.connect(vault).approve(await buffer.getAddress(), DEPOSIT);
    await buffer.connect(vault).depositFee(DEPOSIT);
    await buffer.setMinGsusdReserve(FLOOR);
  });

  function request(signer: HardhatEthersSigner, overrides: Partial<WithdrawalRequest> = {}): WithdrawalRequest {
    return {
      buffer,
      timelock,
      signer,
      to: opsSafe.address,
      amount: AMOUNT,
      memo: "2026-Q4 infrastructure",
      confirm: true,
      allowEoaRecipient: true,
      ...overrides,
    };
  }

  it("reports the headroom above the floor", async function () {
    const headroom = await readHeadroom(buffer);
    expect(headroom.balance).to.equal(DEPOSIT);
    expect(headroom.floor).to.equal(FLOOR);
    expect(headroom.governedMinimum).to.equal(FLOOR);
    // The whole 1,000 GSUSD supply sits in the buffer: the automatic floor is 2% of it.
    expect(headroom.automaticFloor).to.equal(ethers.parseEther("20"));
    expect(headroom.withdrawable).to.equal(HEADROOM);
  });

  it("measures headroom against the automatic floor once the governed minimum is below it", async function () {
    await buffer.setMinGsusdReserve(0n);
    const automatic = ethers.parseEther("20");
    const headroom = await readHeadroom(buffer);
    expect(headroom.floor).to.equal(automatic);
    expect(headroom.withdrawable).to.equal(DEPOSIT - automatic);
    await expect(runSurplusWithdrawal(request(deployer, { amount: DEPOSIT - automatic + 1n }))).to.be.rejectedWith(
      /exceeds the 980\.0 GSUSD above the floor \(balance 1000\.0 GSUSD, floor 20\.0 GSUSD\)/
    );
    const outcome = await runSurplusWithdrawal(request(deployer, { amount: DEPOSIT - automatic }));
    expect(outcome.step).to.equal("withdrawn");
    expect(await buffer.gsusdBalance()).to.equal(automatic);
  });

  it("derives a distinct salt per recipient, amount and memo", function () {
    const base = withdrawalSalt(opsSafe.address, AMOUNT, "a");
    expect(withdrawalSalt(opsSafe.address, AMOUNT, "a")).to.equal(base);
    expect(withdrawalSalt(opsSafe.address, AMOUNT, "b")).to.not.equal(base);
    expect(withdrawalSalt(opsSafe.address, AMOUNT + 1n, "a")).to.not.equal(base);
    expect(withdrawalSalt(stranger.address, AMOUNT, "a")).to.not.equal(base);
  });

  describe("script wiring", function () {
    it("checks the snapshot timelock against the governance wrapper on chain", async function () {
      const random = () => ethers.Wallet.createRandom().address;
      const governance = await (
        await ethers.getContractFactory("GoldGovernance")
      ).deploy([proposer.address], [executor.address], random(), random(), random());
      const governanceAddress = await governance.getAddress();
      const real = await governance.getTimelockAddress();
      await assertTimelockMatchesGovernance(governanceAddress, real.toLowerCase());
      await expect(
        assertTimelockMatchesGovernance(governanceAddress, await timelock.getAddress())
      ).to.be.rejectedWith(/differs from GoldGovernance.timelock\(\)/);
    });

    it("uses the configured signer, refuses to run without one, and impersonates only when asked", async function () {
      expect(await (await resolveSigner([deployer], undefined, "sepolia")).getAddress()).to.equal(deployer.address);
      await expect(resolveSigner([], undefined, "mainnet")).to.be.rejectedWith(/set PRIVATE_KEY/);
      const target = "0x000000000000000000000000000000000000dEaD";
      const impersonated = await resolveSigner([], target, "localhost");
      expect(await impersonated.getAddress()).to.equal(target);
      expect(await ethers.provider.getBalance(target)).to.equal(ethers.parseEther("100"));
    });
  });

  describe("before the handover (signer holds GOVERNANCE_ROLE)", function () {
    it("withdraws in one direct call", async function () {
      const outcome = await runSurplusWithdrawal(request(deployer));
      expect(outcome.step).to.equal("withdrawn");
      expect(outcome.path).to.equal("direct");
      expect(await gsusd.balanceOf(opsSafe.address)).to.equal(AMOUNT);
      expect(await buffer.gsusdBalance()).to.equal(DEPOSIT - AMOUNT);
      expect(await buffer.totalGsusdWithdrawn()).to.equal(AMOUNT);
    });

    it("sends nothing on a dry run", async function () {
      const outcome = await runSurplusWithdrawal(request(deployer, { confirm: false }));
      expect(outcome.step).to.equal("dry-run");
      expect(await gsusd.balanceOf(opsSafe.address)).to.equal(0n);
      expect(await buffer.gsusdBalance()).to.equal(DEPOSIT);
    });

    it("refuses an amount that would breach the floor", async function () {
      await expect(runSurplusWithdrawal(request(deployer, { amount: HEADROOM + 1n }))).to.be.rejectedWith(
        /exceeds the 400\.0 GSUSD above the floor/
      );
      expect(await buffer.gsusdBalance()).to.equal(DEPOSIT);
    });

    it("refuses a zero amount, a zero recipient and the buffer itself", async function () {
      await expect(runSurplusWithdrawal(request(deployer, { amount: 0n }))).to.be.rejectedWith(/Amount must be positive/);
      await expect(runSurplusWithdrawal(request(deployer, { to: ethers.ZeroAddress }))).to.be.rejectedWith(/recipient/i);
      await expect(
        runSurplusWithdrawal(request(deployer, { to: await buffer.getAddress() }))
      ).to.be.rejectedWith(/buffer itself/);
    });

    it("refuses the timelock as recipient", async function () {
      await expect(
        runSurplusWithdrawal(request(deployer, { to: await timelock.getAddress() }))
      ).to.be.rejectedWith(/Recipient is the timelock/);
    });

    it("refuses the deployer and a governance Safe as recipient, naming which, even with the EOA override", async function () {
      const [, , , , , proposerSafe, guardianSafe] = await ethers.getSigners();
      const refuseRecipients = [
        { label: "the deployer", address: deployer.address },
        { label: "the proposer Safe", address: proposerSafe.address },
        { label: "the guardian Safe", address: guardianSafe.address.toLowerCase() },
      ];
      for (const [to, label] of [[deployer.address, "the deployer"], [proposerSafe.address, "the proposer Safe"], [guardianSafe.address, "the guardian Safe"]] as const) {
        await expect(runSurplusWithdrawal(request(deployer, { to, allowEoaRecipient: true, refuseRecipients }))).to.be.rejectedWith(
          new RegExp(`Recipient ${to} is ${label}.*operations Safe`)
        );
      }
      // An address that is none of them is not held back by the list.
      const outcome = await runSurplusWithdrawal(request(deployer, { refuseRecipients, confirm: false }));
      expect(outcome.step).to.equal("dry-run");
    });

    it("requires a memo", async function () {
      await expect(runSurplusWithdrawal(request(deployer, { memo: "  " }))).to.be.rejectedWith(/Memo is required/);
    });

    it("refuses an externally owned recipient unless explicitly allowed", async function () {
      await expect(runSurplusWithdrawal(request(deployer, { allowEoaRecipient: false }))).to.be.rejectedWith(
        /has no code/
      );
      expect(await buffer.gsusdBalance()).to.equal(DEPOSIT);
    });

    it("pays a contract recipient without the override", async function () {
      const safeStandIn = await (await ethers.getContractFactory("MockERC20")).deploy("Safe", "SAFE", 18);
      const to = await safeStandIn.getAddress();
      const outcome = await runSurplusWithdrawal(request(deployer, { to, allowEoaRecipient: false }));
      expect(outcome.step).to.equal("withdrawn");
      expect(await gsusd.balanceOf(to)).to.equal(AMOUNT);
    });
  });

  describe("after the handover (timelock holds GOVERNANCE_ROLE)", function () {
    beforeEach(async function () {
      await buffer.transferGovernance(await timelock.getAddress());
    });

    it("schedules, reports the wait, executes, then reports done across four runs", async function () {
      const first = await runSurplusWithdrawal(request(proposer));
      expect(first.step).to.equal("scheduled");
      expect(first.path).to.equal("timelock");
      expect(first.readyAt).to.equal((await time.latest()) + MIN_DELAY);

      const second = await runSurplusWithdrawal(request(executor));
      expect(second.step).to.equal("waiting");
      expect(second.operationId).to.equal(first.operationId);
      expect(await gsusd.balanceOf(opsSafe.address)).to.equal(0n);

      await time.increase(MIN_DELAY + 1);

      const third = await runSurplusWithdrawal(request(executor));
      expect(third.step).to.equal("executed");
      expect(await gsusd.balanceOf(opsSafe.address)).to.equal(AMOUNT);
      expect(await buffer.gsusdBalance()).to.equal(DEPOSIT - AMOUNT);

      const fourth = await runSurplusWithdrawal(request(executor));
      expect(fourth.step).to.equal("done");
      expect(await gsusd.balanceOf(opsSafe.address)).to.equal(AMOUNT);
    });

    it("hands a non-proposer the exact schedule call for the proposer Safe", async function () {
      const outcome = await runSurplusWithdrawal(request(stranger));
      expect(outcome.step).to.equal("awaiting-proposer");
      const op = outcome.operation;
      if (!op) throw new Error("operation missing");
      expect(op.target).to.equal(await buffer.getAddress());
      expect(op.data).to.equal(buffer.interface.encodeFunctionData("withdrawGsusd", [opsSafe.address, AMOUNT]));
      expect(op.delay).to.equal(BigInt(MIN_DELAY));
      expect(await timelock.hashOperation(op.target, 0n, op.data, op.predecessor, op.salt)).to.equal(
        outcome.operationId
      );
      // Nothing was scheduled: the proposer's next run is the schedule step, not "waiting".
      expect(await timelock.getOperationState(outcome.operationId ?? ethers.ZeroHash)).to.equal(0n);
    });

    it("refuses to hand out a Safe call for an amount above the headroom", async function () {
      await expect(runSurplusWithdrawal(request(stranger, { amount: HEADROOM + 1n }))).to.be.rejectedWith(
        /exceeds the 400\.0 GSUSD above the floor/
      );
      const salt = withdrawalSalt(opsSafe.address, HEADROOM + 1n, "2026-Q4 infrastructure");
      const data = buffer.interface.encodeFunctionData("withdrawGsusd", [opsSafe.address, HEADROOM + 1n]);
      const id = await timelock.hashOperation(await buffer.getAddress(), 0n, data, ethers.ZeroHash, salt);
      expect(await timelock.getOperationState(id)).to.equal(0n);
    });

    // A timelock deployed before 2026-11-06 is the stock TimelockController: it has no
    // GRACE_PERIOD, so the step finds no expiry to check and executes however old the operation.
    it("executes a matured operation of any age on a timelock without a grace period", async function () {
      await runSurplusWithdrawal(request(proposer));
      await time.increase(MIN_DELAY + 30 * 24 * 3600);
      const outcome = await runSurplusWithdrawal(request(executor));
      expect(outcome.step).to.equal("executed");
      expect(await gsusd.balanceOf(opsSafe.address)).to.equal(AMOUNT);
    });

    it("hands a non-executor the execute call once the delay has passed", async function () {
      await runSurplusWithdrawal(request(proposer));
      await time.increase(MIN_DELAY + 1);
      const outcome = await runSurplusWithdrawal(request(stranger));
      expect(outcome.step).to.equal("awaiting-executor");
      expect(await gsusd.balanceOf(opsSafe.address)).to.equal(0n);
    });

    it("lets anyone execute under an open executor", async function () {
      const open = await (
        await ethers.getContractFactory("TimelockController")
      ).deploy(MIN_DELAY, [proposer.address], [ethers.ZeroAddress], ethers.ZeroAddress);
      const fresh = await (await ethers.getContractFactory("SurplusBuffer")).deploy(await gsusd.getAddress());
      await fresh.grantRole(await fresh.VAULT_ROLE(), vault.address);
      await gsusd.mint(vault.address, DEPOSIT);
      await gsusd.connect(vault).approve(await fresh.getAddress(), DEPOSIT);
      await fresh.connect(vault).depositFee(DEPOSIT);
      await fresh.transferGovernance(await open.getAddress());

      await runSurplusWithdrawal(request(proposer, { buffer: fresh, timelock: open }));
      await time.increase(MIN_DELAY + 1);
      const outcome = await runSurplusWithdrawal(request(stranger, { buffer: fresh, timelock: open }));
      expect(outcome.step).to.equal("executed");
      expect(await gsusd.balanceOf(opsSafe.address)).to.equal(AMOUNT);
    });

    it("does not schedule on a dry run", async function () {
      const dry = await runSurplusWithdrawal(request(proposer, { confirm: false }));
      expect(dry.step).to.equal("dry-run");
      const real = await runSurplusWithdrawal(request(proposer));
      expect(real.step).to.equal("scheduled");
    });

    it("keeps otherwise identical withdrawals apart by memo", async function () {
      const a = await runSurplusWithdrawal(request(proposer, { memo: "October invoices" }));
      const b = await runSurplusWithdrawal(request(proposer, { memo: "November invoices" }));
      expect(a.step).to.equal("scheduled");
      expect(b.step).to.equal("scheduled");
      expect(a.operationId).to.not.equal(b.operationId);
    });

    it("refuses to execute if the headroom has shrunk since scheduling", async function () {
      await runSurplusWithdrawal(request(proposer));
      // A bad-debt event takes 300 GSUSD: balance 700 against a 600 floor leaves 100 < 250.
      await buffer.connect(vault).absorbBadDebt(ethers.parseEther("300"));
      await time.increase(MIN_DELAY + 1);
      await expect(runSurplusWithdrawal(request(executor))).to.be.rejectedWith(
        /exceeds the 100\.0 GSUSD above the floor/
      );
      expect(await gsusd.balanceOf(opsSafe.address)).to.equal(0n);
    });

    it("refuses when neither the signer nor the given timelock holds GOVERNANCE_ROLE", async function () {
      const other = await (
        await ethers.getContractFactory("TimelockController")
      ).deploy(MIN_DELAY, [proposer.address], [executor.address], ethers.ZeroAddress);
      await expect(runSurplusWithdrawal(request(proposer, { timelock: other }))).to.be.rejectedWith(
        /Neither the signer nor the timelock/
      );
      await expect(runSurplusWithdrawal(request(proposer, { timelock: null }))).to.be.rejectedWith(
        /no timelock/
      );
    });
  });
});
