import { expect } from "chai";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import type { GoldGovernance, GoldOracle, GoldStablecoin, GoldVault, MockAggregatorV3, MockERC20, StabilityModule } from "../typechain-types";
import {
  assertDebtCeilingSupported,
  encodeExecute,
  encodeSchedule,
  encodeVaultCall,
  executeWindowText,
  parseCeiling,
  proposalSalt,
  readExecuteWindow,
  revealsGuardedFunction,
  revertDataOf,
  scheduleDelay,
  spanText,
  UNLIMITED_CEILING,
} from "../scripts/lib/ceilingProposal";

type HardhatEthersSigner = Awaited<ReturnType<typeof ethers.getSigners>>[number];

/**
 * The ceiling proposal calldata (scripts/print-ceiling-proposal.ts), proven against the real
 * wrapper: a Safe that submits exactly these bytes schedules the raise, and the execute bytes
 * land it 48 hours later.
 */
describe("Ceiling proposal calldata (scripts/print-ceiling-proposal.ts)", function () {
  const MIN_DELAY = 48 * 60 * 60;
  const RATIOS = { minRatio: 1_300_000n, liquidationRatio: 1_100_000n, liquidationPenalty: 50_000n };
  const CEILING = ethers.parseEther("250000");

  let proposer: HardhatEthersSigner;
  let executor: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;
  let vault: GoldVault;
  let governance: GoldGovernance;
  let paxg: MockERC20;

  beforeEach(async function () {
    [, proposer, executor, stranger] = await ethers.getSigners();
    paxg = await (await ethers.getContractFactory("MockERC20")).deploy("Paxos Gold", "PAXG", 18);
    const xaut = await (await ethers.getContractFactory("MockERC20")).deploy("Tether Gold", "XAUt", 6);
    const feed = (await (await ethers.getContractFactory("MockAggregatorV3")).deploy(8)) as MockAggregatorV3;
    const now = await time.latest();
    await feed.setLatestRoundData(1, 4_150_00000000n, now, now, 1);
    const oracle = (await (await ethers.getContractFactory("GoldOracle")).deploy(
      await feed.getAddress(),
      await feed.getAddress(),
      await paxg.getAddress(),
      await xaut.getAddress(),
      90000
    )) as GoldOracle;
    const stablecoin = (await (await ethers.getContractFactory("GoldStablecoin")).deploy()) as GoldStablecoin;
    const module = (await (await ethers.getContractFactory("StabilityModule")).deploy()) as StabilityModule;
    vault = (await (await ethers.getContractFactory("GoldVault")).deploy(
      await oracle.getAddress(),
      await stablecoin.getAddress(),
      await module.getAddress()
    )) as GoldVault;
    await vault.addCollateralType(await paxg.getAddress(), RATIOS.minRatio, RATIOS.liquidationRatio, RATIOS.liquidationPenalty, 0);
    governance = (await (await ethers.getContractFactory("GoldGovernance")).deploy(
      [proposer.address],
      [executor.address],
      await vault.getAddress(),
      await oracle.getAddress(),
      await module.getAddress()
    )) as GoldGovernance;
    // The handover: the timelock governs the vault, the deployer no longer does.
    await vault.transferGovernance(await governance.getTimelockAddress());
  });

  async function proposal() {
    return {
      governance: await governance.getAddress(),
      vault: await vault.getAddress(),
      token: await paxg.getAddress(),
      debtCeiling: CEILING,
    };
  }

  it("encodes a schedule that the proposer can submit and a stranger cannot", async function () {
    const schedule = encodeSchedule(await proposal());
    expect(schedule.to).to.equal(await governance.getAddress());
    await expect(stranger.sendTransaction({ to: schedule.to, data: schedule.data })).to.be.reverted;
    await expect(proposer.sendTransaction({ to: schedule.to, data: schedule.data })).to.emit(governance, "ProposalCreated");
    expect(await governance.proposalNonce()).to.equal(1n);
  });

  it("encodes an execute that lands the raise after the delay and not before", async function () {
    const p = await proposal();
    const nonce = await governance.proposalNonce();
    const schedule = encodeSchedule(p);
    await proposer.sendTransaction({ to: schedule.to, data: schedule.data });
    const execute = encodeExecute(p, nonce);
    await expect(executor.sendTransaction({ to: execute.to, data: execute.data })).to.be.reverted;
    await time.increase(MIN_DELAY + 1);
    await executor.sendTransaction({ to: execute.to, data: execute.data });
    const collateral = await vault.collateralTypes(ethers.solidityPackedKeccak256(["address"], [await paxg.getAddress()]));
    expect(collateral.debtCeiling).to.equal(CEILING);
    expect(collateral.minRatio).to.equal(RATIOS.minRatio);
    expect(collateral.liquidationRatio).to.equal(RATIOS.liquidationRatio);
    expect(collateral.liquidationPenalty).to.equal(RATIOS.liquidationPenalty);
  });

  it("matches the wrapper's salt convention and the vault's inner call", async function () {
    expect(proposalSalt(0n)).to.equal(ethers.ZeroHash);
    expect(proposalSalt(7n)).to.equal("0x0000000000000000000000000000000000000000000000000000000000000007");
    const p = await proposal();
    const inner = encodeVaultCall(p);
    expect(inner).to.equal(vault.interface.encodeFunctionData("setDebtCeiling", [p.token, CEILING]));
    expect(encodeSchedule(p).data).to.equal(governance.interface.encodeFunctionData("proposeDebtCeilingUpdate", [p.token, CEILING]));
  });

  // The ceiling operation carries no ratios any more, so the ratio bounds the printer used to
  // mirror no longer apply to it; the wrapper's one guard on a ceiling proposal is the token.
  it("refuses shapes the wrapper would revert on", async function () {
    const p = await proposal();
    expect(() => encodeSchedule({ ...p, token: ethers.ZeroAddress })).to.throw("zero address");
    expect(() => encodeSchedule({ ...p, debtCeiling: -1n })).to.throw("negative");
    expect(() => encodeSchedule({ ...p, debtCeiling: 0n })).not.to.throw();
    expect(() => encodeSchedule({ ...p, debtCeiling: UNLIMITED_CEILING })).not.to.throw();
  });

  it("matches the wrapper's own guard, so a shape the printer allows does not revert", async function () {
    const p = await proposal();
    await expect(governance.connect(proposer).proposeDebtCeilingUpdate(ethers.ZeroAddress, p.debtCeiling)).to.be.revertedWith("Zero address");
    await expect(governance.connect(proposer).proposeDebtCeilingUpdate(p.token, 0n)).to.emit(governance, "ProposalCreated");
  });

  // A ceiling operation used to re-send the ratios read when it was
  // printed, so executing it after a ratio change made while it waited undid that change.
  describe("a pending ceiling operation and a ratio change made while it waits", function () {
    const TIGHT = { minRatio: 1_600_000n, liquidationRatio: 1_350_000n, liquidationPenalty: 60_000n };

    async function scheduleCeilingThenTightenRatios() {
      const token = await paxg.getAddress();
      const timelock = await ethers.getContractAt("TimelockController", await governance.getTimelockAddress());
      const printed = await proposal();
      const nonceAtSchedule = await governance.proposalNonce();
      const schedule = encodeSchedule(printed);
      const receipt = await (await proposer.sendTransaction({ to: schedule.to, data: schedule.data })).wait();
      const scheduled = receipt!.logs
        .map((log) => timelock.interface.parseLog(log))
        .find((event) => event?.name === "CallScheduled");
      expect(scheduled, "CallScheduled").to.not.equal(undefined);

      // An hour later governance tightens the same collateral.
      await time.increase(3600);
      await governance.connect(proposer).proposeCollateralRatioUpdate(token, TIGHT.minRatio, TIGHT.liquidationRatio, TIGHT.liquidationPenalty);
      const ratioCall = vault.interface.encodeFunctionData("updateCollateralRatios", [token, TIGHT.minRatio, TIGHT.liquidationRatio, TIGHT.liquidationPenalty]);
      await time.increase(MIN_DELAY + 1);
      return { token, printed, nonceAtSchedule, scheduled: scheduled!, ratioCall, ratioSalt: proposalSalt(nonceAtSchedule + 1n) };
    }

    async function collateral(token: string) {
      return vault.collateralTypes(ethers.solidityPackedKeccak256(["address"], [token]));
    }

    it("leaves the tightened ratios in place when the stale ceiling operation executes last", async function () {
      const op = await scheduleCeilingThenTightenRatios();
      await governance.connect(executor).executeProposal(await vault.getAddress(), op.ratioCall, op.ratioSalt);

      // The ceiling operation, still pending, executes afterwards from its public CallScheduled data.
      await governance.connect(executor).executeProposal(op.scheduled.args.target, op.scheduled.args.data, proposalSalt(op.nonceAtSchedule));
      const final = await collateral(op.token);
      expect(final.minRatio).to.equal(TIGHT.minRatio);
      expect(final.liquidationRatio).to.equal(TIGHT.liquidationRatio);
      expect(final.liquidationPenalty).to.equal(TIGHT.liquidationPenalty);
      expect(final.debtCeiling).to.equal(CEILING);
    });

    it("leaves the raised ceiling in place when the ratio operation executes last", async function () {
      const op = await scheduleCeilingThenTightenRatios();
      const execute = encodeExecute(op.printed, op.nonceAtSchedule);
      await executor.sendTransaction({ to: execute.to, data: execute.data });
      await governance.connect(executor).executeProposal(await vault.getAddress(), op.ratioCall, op.ratioSalt);
      const final = await collateral(op.token);
      expect(final.debtCeiling).to.equal(CEILING);
      expect(final.liquidationRatio).to.equal(TIGHT.liquidationRatio);
    });

    it("a reprint with NONCE_AT_SCHEDULE still matches the scheduled operation after the ratio change", async function () {
      const op = await scheduleCeilingThenTightenRatios();
      await governance.connect(executor).executeProposal(await vault.getAddress(), op.ratioCall, op.ratioSalt);
      // The reprint carries nothing read from the vault, so it is the same operation.
      const reprinted = encodeExecute(await proposal(), op.nonceAtSchedule);
      await executor.sendTransaction({ to: reprinted.to, data: reprinted.data });
      const final = await collateral(op.token);
      expect(final.debtCeiling).to.equal(CEILING);
      expect(final.minRatio).to.equal(TIGHT.minRatio);
    });
  });

  // The Sepolia deployment of 2026-11-03 predates setDebtCeiling and proposeDebtCeilingUpdate.
  // Both scripts probe before printing or sending: an eth_call from the zero address must come
  // back as the function's own role refusal, which a contract without the function cannot give.
  describe("deployment probe", function () {
    const GOVERNANCE_ROLE = ethers.id("GOVERNANCE_ROLE");
    const errors = new ethers.Interface(["error AccessControlUnauthorizedAccount(address account, bytes32 neededRole)"]);
    const refusal = (account: string, role: string) => errors.encodeErrorResult("AccessControlUnauthorizedAccount", [account, role]);

    it("accepts only the role refusal of the zero address for the expected role", function () {
      expect(refusal(ethers.ZeroAddress, GOVERNANCE_ROLE).slice(0, 10)).to.equal("0xe2517d3f");
      expect(revealsGuardedFunction(refusal(ethers.ZeroAddress, GOVERNANCE_ROLE), GOVERNANCE_ROLE)).to.equal(true);
      expect(revealsGuardedFunction(refusal(stranger.address, GOVERNANCE_ROLE), GOVERNANCE_ROLE)).to.equal(false);
      expect(revealsGuardedFunction(refusal(ethers.ZeroAddress, ethers.id("PROPOSER_ROLE")), GOVERNANCE_ROLE)).to.equal(false);
      expect(revealsGuardedFunction(refusal(ethers.ZeroAddress, GOVERNANCE_ROLE).slice(0, 74), GOVERNANCE_ROLE)).to.equal(false);
      expect(revealsGuardedFunction("0x", GOVERNANCE_ROLE)).to.equal(false);
      expect(revealsGuardedFunction(undefined, GOVERNANCE_ROLE)).to.equal(false);
      const reason = new ethers.Interface(["error Error(string)"]).encodeErrorResult("Error", ["Unsupported token"]);
      expect(revealsGuardedFunction(reason, GOVERNANCE_ROLE)).to.equal(false);
    });

    it("finds the revert data wherever a provider puts it", function () {
      const data = refusal(ethers.ZeroAddress, GOVERNANCE_ROLE);
      expect(revertDataOf({ data })).to.equal(data);
      expect(revertDataOf({ error: { data } })).to.equal(data);
      expect(revertDataOf({ info: { error: { data } } })).to.equal(data);
      expect(revertDataOf({ data: { data } })).to.equal(data);
      expect(revertDataOf(new Error("socket hang up"))).to.equal(undefined);
      expect(revertDataOf({ data: "not hex" })).to.equal(undefined);
    });

    it("passes a deployment that has both functions", async function () {
      const p = await proposal();
      await assertDebtCeilingSupported(ethers.provider, { vault: p.vault, governance: p.governance, token: p.token });
      await assertDebtCeilingSupported(ethers.provider, { vault: p.vault, token: p.token });
    });

    it("stops on a vault or wrapper without the function, and on an address without code", async function () {
      const p = await proposal();
      // A contract without the function and without a fallback stands in for the 2026-11-03 vault.
      const old = await (await ethers.getContractFactory("MockERC20")).deploy("Old", "OLD", 18);
      const missing = /predates setDebtCeiling; redeploy required/;
      await expect(assertDebtCeilingSupported(ethers.provider, { vault: await old.getAddress(), token: p.token })).to.be.rejectedWith(missing);
      await expect(assertDebtCeilingSupported(ethers.provider, { vault: stranger.address, token: p.token })).to.be.rejectedWith(missing);
      await expect(
        assertDebtCeilingSupported(ethers.provider, { vault: p.vault, governance: await old.getAddress(), token: p.token })
      ).to.be.rejectedWith(/proposeDebtCeilingUpdate/);
    });

    // An endpoint that drops revert data looks exactly like a deployment without the function.
    it("says that an RPC without revert data looks the same, on both messages", async function () {
      const p = await proposal();
      const old = await (await ethers.getContractFactory("MockERC20")).deploy("Old", "OLD", 18);
      const retry = "(or the RPC returned no revert data; retry on another endpoint)";
      await expect(assertDebtCeilingSupported(ethers.provider, { vault: await old.getAddress(), token: p.token })).to.be.rejectedWith(retry);
      await expect(
        assertDebtCeilingSupported(ethers.provider, { vault: p.vault, governance: await old.getAddress(), token: p.token })
      ).to.be.rejectedWith(retry);
    });

    // The probe stands on two facts about the 2026-11-03 deployment, recorded in a committed
    // fixture taken from apps/dapp/public/abi at b4414d2: neither contract has either function,
    // and neither has a fallback or receive function that could answer for it.
    it("matches the 2026-11-03 deployment: neither function, no fallback and no receive", function () {
      type Recorded = { fallback: boolean; receive: boolean; functions: Record<string, string> };
      const fixture = JSON.parse(
        readFileSync(resolve(__dirname, "fixtures", "deployment-2026-11-03-selectors.json"), "utf8")
      ) as { commit: string; contracts: Record<"GoldVault" | "GoldGovernance", Recorded> };
      expect(fixture.commit).to.equal("b4414d2");
      const probed = [
        ethers.id("setDebtCeiling(address,uint256)").slice(0, 10),
        ethers.id("proposeDebtCeilingUpdate(address,uint256)").slice(0, 10),
      ];
      for (const name of ["GoldVault", "GoldGovernance"] as const) {
        const recorded = fixture.contracts[name];
        const selectors = Object.values(recorded.functions);
        expect(selectors.length, `${name} records its functions`).to.be.greaterThan(20);
        for (const [signature, selector] of Object.entries(recorded.functions)) {
          expect(ethers.id(signature).slice(0, 10), `${name} ${signature}`).to.equal(selector);
        }
        for (const selector of probed) expect(selectors, `${name} must not carry ${selector}`).to.not.include(selector);
        expect(recorded.fallback, `${name} fallback`).to.equal(false);
        expect(recorded.receive, `${name} receive`).to.equal(false);
      }
      // Today's contracts carry both, so the probe tells the two apart.
      expect(vault.interface.getFunction("setDebtCeiling")?.selector).to.equal(probed[0]);
      expect(governance.interface.getFunction("proposeDebtCeilingUpdate")?.selector).to.equal(probed[1]);
    });
  });

  // GoldGovernance._schedule waits max(MIN_DELAY, timelock.getMinDelay()); the printer says so
  // instead of a fixed 48 hours, and names the timelock's grace period.
  describe("the execute window", function () {
    it("takes the larger of the wrapper's MIN_DELAY and the timelock's minimum delay", function () {
      expect(scheduleDelay(172_800n, 172_800n)).to.equal(172_800n);
      expect(scheduleDelay(172_800n, 259_200n)).to.equal(259_200n);
      expect(scheduleDelay(172_800n, 86_400n)).to.equal(172_800n);
    });

    it("words the window in hours and days", function () {
      expect(executeWindowText({ delay: 172_800n, gracePeriod: 604_800n })).to.equal(
        "from 48 hours after step 1 confirms and within the 7 days after that"
      );
      expect(executeWindowText({ delay: 3_600n, gracePeriod: 86_400n })).to.equal(
        "from 1 hour after step 1 confirms and within the day after that"
      );
      expect(executeWindowText({ delay: 3_600n, gracePeriod: 3_600n })).to.equal(
        "from 1 hour after step 1 confirms and within the hour after that"
      );
      expect(executeWindowText({ delay: 172_801n, gracePeriod: 90_000n })).to.equal(
        "from 172801 seconds after step 1 confirms and within the 25 hours after that"
      );
      expect(executeWindowText({ delay: 172_800n, gracePeriod: undefined })).to.equal(
        "from 48 hours after step 1 confirms, with no closing time (this timelock has no grace period)"
      );
    });

    it("names a single day or hour without a count, so the closing line reads naturally", function () {
      expect(spanText(604_800n, "that", "those")).to.equal("those 7 days");
      expect(spanText(86_400n, "that", "those")).to.equal("that day");
      expect(spanText(3_600n, "that", "those")).to.equal("that hour");
      expect(spanText(90_000n, "that", "those")).to.equal("those 25 hours");
      expect(spanText(1n, "the", "the")).to.equal("the second");
    });

    it("reads the delay the wrapper will use once governance has raised the timelock's", async function () {
      const timelock = await ethers.getContractAt("ExpiringTimelockController", await governance.timelock());
      expect(await readExecuteWindow(ethers.provider, await governance.getAddress())).to.deep.equal({
        delay: BigInt(MIN_DELAY),
        gracePeriod: 7n * 86_400n,
      });

      const raised = 72n * 3600n;
      const salt = ethers.id("raise the delay");
      const call = timelock.interface.encodeFunctionData("updateDelay", [raised]);
      await timelock.connect(proposer).schedule(await timelock.getAddress(), 0, call, ethers.ZeroHash, salt, MIN_DELAY);
      await time.increase(MIN_DELAY + 1);
      await timelock.connect(executor).execute(await timelock.getAddress(), 0, call, ethers.ZeroHash, salt);

      const window = await readExecuteWindow(ethers.provider, await governance.getAddress());
      expect(window).to.deep.equal({ delay: raised, gracePeriod: 7n * 86_400n });
      expect(executeWindowText(window)).to.equal("from 72 hours after step 1 confirms and within the 7 days after that");

      // The wrapper schedules at exactly that delay.
      const schedule = encodeSchedule(await proposal());
      const receipt = await (await proposer.sendTransaction({ to: schedule.to, data: schedule.data })).wait();
      const block = await ethers.provider.getBlock(receipt?.blockNumber ?? 0);
      const created = receipt?.logs
        .map((log) => {
          try {
            return governance.interface.parseLog(log);
          } catch {
            return null;
          }
        })
        .find((event) => event?.name === "ProposalCreated");
      expect(created?.args[3]).to.equal(BigInt(block?.timestamp ?? 0) + raised);
    });
  });

  describe("parseCeiling", function () {
    it("reads whole and fractional GSUSD and the unlimited spelling", function () {
      expect(parseCeiling("250000")).to.equal(ethers.parseEther("250000"));
      expect(parseCeiling("1.5")).to.equal(ethers.parseEther("1.5"));
      expect(parseCeiling("unlimited")).to.equal(UNLIMITED_CEILING);
      expect(parseCeiling(" MAX ")).to.equal(UNLIMITED_CEILING);
      expect(UNLIMITED_CEILING).to.equal(ethers.MaxUint256);
    });

    it("refuses an empty or malformed ceiling", function () {
      expect(() => parseCeiling(undefined)).to.throw("Set CEILING_GSUSD");
      expect(() => parseCeiling("250k")).to.throw("must be a number");
    });

    it("refuses more than 18 decimal places instead of truncating them", function () {
      expect(() => parseCeiling("1.0000000000000000001")).to.throw("19 decimal places");
      expect(parseCeiling("1.000000000000000001")).to.equal(ethers.parseEther("1.000000000000000001"));
    });

    it("lands an unlimited ceiling through the wrapper and the timelock", async function () {
      const proposal = { governance: await governance.getAddress(), vault: await vault.getAddress(), token: await paxg.getAddress(), debtCeiling: UNLIMITED_CEILING };
      const nonce = await governance.proposalNonce();
      const schedule = encodeSchedule(proposal);
      await proposer.sendTransaction({ to: schedule.to, data: schedule.data });
      await time.increase(MIN_DELAY);
      const execute = encodeExecute(proposal, nonce);
      await executor.sendTransaction({ to: execute.to, data: execute.data });
      const type = await vault.collateralTypes(ethers.solidityPackedKeccak256(["address"], [await paxg.getAddress()]));
      expect(type.debtCeiling).to.equal(ethers.MaxUint256);
    });
  });
});
