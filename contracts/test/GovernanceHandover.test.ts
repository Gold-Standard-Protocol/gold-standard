import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { productionSystem } from "./helpers/productionSystem";
import {
  HANDOVER_ORDER,
  HandoverAdmins,
  HandoverContracts,
  HandoverParties,
  HandoverStates,
  RoleReader,
  SentTransaction,
  TransferLabel,
  TransferableContract,
  adminsHandedOver,
  handoverStates,
  planHandover,
  readHandoverAdmins,
  runHandover,
} from "../scripts/lib/governanceHandover";
import { CensusStage, HandoverCeremony, HandoverRefused, carryOutHandover } from "../scripts/lib/handoverCeremony";
import { CensusAddresses, CensusCheck, HandoverLabel, censusTargets, takeRoleCensus, timelockGracePeriodCheck } from "../scripts/lib/roleCensus";

/**
 * Runs the real handover sequence (scripts/transfer-governance.ts) on the production fixture
 * and enumerates every role the deployer, proposer, executor and guardian hold afterwards.
 * The deployer must hold nothing; the timelock holds the governance of every contract.
 */
describe("Governance handover", function () {
  const ROLE_NAMES = [
    "DEFAULT_ADMIN_ROLE", "GOVERNANCE_ROLE", "GUARDIAN_ROLE", "VAULT_ROLE", "MINTER_ROLE",
    "PROPOSER_ROLE", "EXECUTOR_ROLE", "CANCELLER_ROLE", "LOCKED_ROLE",
  ];
  const roleHash = (name: string) => (name === "DEFAULT_ADMIN_ROLE" ? ethers.ZeroHash : ethers.id(name));

  const ACCESS_CONTROL_ABI = ["function hasRole(bytes32 role, address account) view returns (bool)"];

  type System = Awaited<ReturnType<typeof productionSystem>>;

  /** `plant` runs as the deployer after deployment and before the handover. */
  async function handedOver(plant?: (s: System) => Promise<void>) {
    const s = await productionSystem();
    // The real deploy never gives the deployer MINTER_ROLE; the fixture does. Mirror reality.
    await s.stablecoin.revokeRole(await s.stablecoin.MINTER_ROLE(), s.deployer.address);
    if (plant) await plant(s);
    const governed = [s.stablecoin, s.oracle, s.vault, s.stabilityModule, s.surplusBuffer, s.stabilityPool, s.reserve, s.governance];
    for (const c of governed) await c.transferGovernance(s.timelockAddr);
    const ADMIN = await s.vault.DEFAULT_ADMIN_ROLE();
    await s.siloFactory.grantRole(ADMIN, s.timelockAddr);
    await s.siloFactory.renounceRole(ADMIN, s.deployer.address);
    const timelock = await ethers.getContractAt("TimelockController", s.timelockAddr);
    const contracts: Record<string, string> = {
      stablecoin: await s.stablecoin.getAddress(), oracle: await s.oracle.getAddress(), vault: await s.vault.getAddress(),
      stabilityModule: await s.stabilityModule.getAddress(), surplusBuffer: await s.surplusBuffer.getAddress(),
      stabilityPool: await s.stabilityPool.getAddress(), reserve: await s.reserve.getAddress(),
      siloFactory: await s.siloFactory.getAddress(), governance: await s.governance.getAddress(), timelock: s.timelockAddr,
    };
    return { s, timelock, contracts };
  }

  /** Every `name.ROLE` that `account` holds across the deployment, read through the AccessControl ABI. */
  async function rolesHeldBy(contracts: Record<string, string>, account: string): Promise<string[]> {
    const held: string[] = [];
    for (const [name, address] of Object.entries(contracts)) {
      const access = new ethers.Contract(address, ACCESS_CONTROL_ABI, ethers.provider);
      for (const role of ROLE_NAMES) {
        const has: boolean = await access.hasRole(roleHash(role), account);
        if (has) held.push(`${name}.${role}`);
      }
    }
    return held;
  }

  it("leaves the deployer with no role anywhere", async function () {
    const { s, contracts } = await handedOver();
    expect(await rolesHeldBy(contracts, s.deployer.address)).to.deep.equal([]);
  });

  it("gives the timelock governance of every contract and nobody else the guardian powers", async function () {
    const { s, contracts } = await handedOver();
    const timelockRoles = await rolesHeldBy(contracts, s.timelockAddr);
    for (const name of ["stablecoin", "oracle", "vault", "stabilityModule", "surplusBuffer", "stabilityPool", "reserve", "governance"]) {
      expect(timelockRoles, name).to.include(`${name}.DEFAULT_ADMIN_ROLE`);
    }
    expect(timelockRoles).to.include("siloFactory.DEFAULT_ADMIN_ROLE");
    const guardianRoles = await rolesHeldBy(contracts, s.guardian.address);
    expect(guardianRoles).to.deep.equal(["oracle.GUARDIAN_ROLE", "vault.GUARDIAN_ROLE", "stabilityPool.GUARDIAN_ROLE", "reserve.GUARDIAN_ROLE"]);
    // The wrapper's PROPOSER_ROLE gates its bounded proposal helpers; the timelock's lets the
    // same key schedule raw calldata, which the vault's own bounds still police.
    expect(await rolesHeldBy(contracts, s.proposer.address)).to.deep.equal([
      "governance.PROPOSER_ROLE", "timelock.PROPOSER_ROLE", "timelock.CANCELLER_ROLE",
    ]);
    expect(await rolesHeldBy(contracts, s.executor.address)).to.deep.equal(["governance.EXECUTOR_ROLE", "timelock.EXECUTOR_ROLE"]);
  });

  it("lets a proposer schedule raw calldata, but the vault's own bounds still reject it at execution", async function () {
    const { s, timelock } = await handedOver();
    const vaultAddr = await s.vault.getAddress();
    const bad = s.vault.interface.encodeFunctionData("setMinDebt", [1n]);
    await timelock.connect(s.proposer).schedule(vaultAddr, 0, bad, ethers.ZeroHash, ethers.id("x"), 48 * 3600);
    await time.increase(48 * 3600 + 1);
    await expect(timelock.connect(s.executor).execute(vaultAddr, 0, bad, ethers.ZeroHash, ethers.id("x"))).to.be.reverted;
  });

  // Roles planted before the governance handover used to survive it:
  // transferGovernance revokes the caller only, so a key the deployer granted beforehand stays.
  // lockMinters used to freeze whatever minter set it found; it now refuses unless the vault is
  // the only minter and the timelock the only admin, so the step that ends the guarded ramp
  // cannot pass with a planted key inside the lock.
  describe("lockMinters through the timelock", function () {
    async function lockThroughTimelock(s: System, timelock: Awaited<ReturnType<typeof handedOver>>["timelock"]) {
      const coin = await s.stablecoin.getAddress();
      const data = s.stablecoin.interface.encodeFunctionData("lockMinters", [await s.vault.getAddress()]);
      const salt = ethers.id("lock-minters");
      await timelock.connect(s.proposer).schedule(coin, 0, data, ethers.ZeroHash, salt, 48 * 3600);
      await time.increase(48 * 3600 + 1);
      return timelock.connect(s.executor).execute(coin, 0, data, ethers.ZeroHash, salt);
    }

    it("locks the minter set in the ceremony's normal order", async function () {
      const { s, timelock } = await handedOver();
      await expect(lockThroughTimelock(s, timelock)).to.emit(s.stablecoin, "MintersLocked").withArgs(s.timelockAddr);
      expect(await s.stablecoin.mintersLocked()).to.equal(true);
      expect(await s.stablecoin.getRoleMembers(await s.stablecoin.MINTER_ROLE())).to.deep.equal([await s.vault.getAddress()]);
    });

    it("refuses while a minter planted before the handover survives beside the vault", async function () {
      const signers = await ethers.getSigners();
      const planted = signers[9];
      const { s, timelock } = await handedOver(async (sys) => {
        await sys.stablecoin.grantRole(await sys.stablecoin.MINTER_ROLE(), planted.address);
      });
      const MINTER_ROLE = await s.stablecoin.MINTER_ROLE();
      expect(await s.stablecoin.hasRole(MINTER_ROLE, planted.address)).to.equal(true);

      await expect(lockThroughTimelock(s, timelock)).to.be.revertedWith("MINTER_ROLE must have a sole holder");
      expect(await s.stablecoin.mintersLocked()).to.equal(false);
      // Enumerable, so the planted key is visible to anyone reading the role.
      expect([...(await s.stablecoin.getRoleMembers(MINTER_ROLE))]).to.have.members([await s.vault.getAddress(), planted.address]);
    });

    it("refuses while a second DEFAULT_ADMIN_ROLE holder planted before the handover survives", async function () {
      const signers = await ethers.getSigners();
      const planted = signers[10];
      const { s, timelock } = await handedOver(async (sys) => {
        await sys.stablecoin.grantRole(await sys.stablecoin.DEFAULT_ADMIN_ROLE(), planted.address);
      });
      const ADMIN = await s.stablecoin.DEFAULT_ADMIN_ROLE();

      await expect(lockThroughTimelock(s, timelock)).to.be.revertedWith("DEFAULT_ADMIN_ROLE must have a sole holder");
      expect(await s.stablecoin.mintersLocked()).to.equal(false);
      expect([...(await s.stablecoin.getRoleMembers(ADMIN))]).to.have.members([s.timelockAddr, planted.address]);
    });
  });
});

/**
 * The handover as scripts/transfer-governance.ts sends it (scripts/lib/governanceHandover.ts),
 * stopped part way and run again. The handover once could not be resumed
 * or re-verified after a partial failure: the census before the first transaction expected the
 * deployer on every contract, and transferGovernance reverts for a deployer that is no longer
 * admin, so a run that died after its first confirmation could neither continue nor record
 * itself in the snapshot.
 */
describe("Governance handover, run again (scripts/lib/governanceHandover.ts)", function () {
  type System = Awaited<ReturnType<typeof productionSystem>>;

  interface Ceremony {
    s: System;
    fromBlock: number;
    addresses: CensusAddresses;
    contracts: HandoverContracts;
    parties: HandoverParties;
  }

  /** The system as deploy.ts leaves it, then `plant` as the deployer. Nothing is handed over yet. */
  async function deployed(plant?: (s: System) => Promise<void>): Promise<Ceremony> {
    const fromBlock = (await ethers.provider.getBlockNumber()) + 1;
    const s = await productionSystem();
    await s.stablecoin.revokeRole(await s.stablecoin.MINTER_ROLE(), s.deployer.address);
    await s.siloFactory.lockVaultRole(await s.vault.getAddress());
    if (plant) await plant(s);
    const contracts: HandoverContracts = {
      stablecoin: s.stablecoin,
      oracle: s.oracle,
      vault: s.vault,
      stabilityModule: s.stabilityModule,
      surplusBuffer: s.surplusBuffer,
      stabilityPool: s.stabilityPool,
      reserve: s.reserve,
      governance: s.governance,
      siloFactory: s.siloFactory,
    };
    const addresses: CensusAddresses = {
      stablecoin: await s.stablecoin.getAddress(),
      oracle: await s.oracle.getAddress(),
      vault: await s.vault.getAddress(),
      stabilityModule: await s.stabilityModule.getAddress(),
      surplusBuffer: await s.surplusBuffer.getAddress(),
      stabilityPool: await s.stabilityPool.getAddress(),
      reserve: await s.reserve.getAddress(),
      siloFactory: await s.siloFactory.getAddress(),
      governance: await s.governance.getAddress(),
      timelock: s.timelockAddr,
    };
    return { s, fromBlock, addresses, contracts, parties: { deployer: s.deployer.address, timelock: s.timelockAddr } };
  }

  const readStates = async (c: Ceremony): Promise<HandoverStates> => handoverStates(await readHandoverAdmins(c.contracts, c.parties));

  /** The census transfer-governance.ts takes: with `handover` before it sends, with `transferred` after. */
  async function census(c: Ceremony, policy: CensusStage, toBlock?: number): Promise<CensusCheck[]> {
    const targets = censusTargets({
      addresses: c.addresses,
      deployer: c.s.deployer.address,
      proposers: [c.s.proposer.address],
      executors: [c.s.executor.address],
      guardian: c.s.guardian.address,
      ...policy,
    });
    return takeRoleCensus(ethers.provider, targets, { fromBlock: c.fromBlock, toBlock, deployer: c.s.deployer.address });
  }
  const handedOver = async (c: Ceremony): Promise<boolean> => adminsHandedOver(await readHandoverAdmins(c.contracts, c.parties));

  const failing = (checks: CensusCheck[]): string[] => checks.filter((check) => !check.pass).map((check) => check.name);
  const detail = (checks: CensusCheck[], name: string): string => checks.find((check) => check.name === name)?.detail ?? "";
  const report = (checks: CensusCheck[]): string => checks.map((check) => `${check.name}: ${check.detail}`).join("\n");

  /** Runs what is still owed, then asserts what transfer-governance.ts asserts before it writes the flag. */
  async function finishAndVerify(c: Ceremony): Promise<void> {
    await runHandover(c.contracts, c.parties, planHandover(await readStates(c)));
    const admins = await readHandoverAdmins(c.contracts, c.parties);
    expect(adminsHandedOver(admins), JSON.stringify(admins)).to.equal(true);
    const after = await census(c, { transferred: true });
    expect(failing(after), report(after)).to.deep.equal([]);
    expect(detail(after, "census:deployer")).to.include("holds no role on any governed contract");
  }

  it("plans every transaction of a handover that has not started, the stablecoin first and the SiloFactory in two", async function () {
    const c = await deployed();
    const states = await readStates(c);
    expect(HANDOVER_ORDER.map((label) => states[label])).to.deep.equal(HANDOVER_ORDER.map(() => "pending"));
    expect(await handedOver(c)).to.equal(false);

    const steps = planHandover(states);
    expect(steps.map((step) => `${step.label}.${step.action}`)).to.deep.equal([
      "stablecoin.transferGovernance",
      "oracle.transferGovernance",
      "vault.transferGovernance",
      "stabilityModule.transferGovernance",
      "surplusBuffer.transferGovernance",
      "stabilityPool.transferGovernance",
      "reserve.transferGovernance",
      "governance.transferGovernance",
      "siloFactory.grantRole",
      "siloFactory.renounceRole",
    ]);

    const before = await census(c, { transferred: false, handover: states });
    expect(failing(before), report(before)).to.deep.equal([]);
    const lines: string[] = [];
    await runHandover(c.contracts, c.parties, steps, (line) => lines.push(line));
    expect(lines).to.have.length(10);
    expect(lines[0]).to.include("[1/10] GoldStablecoin.transferGovernance");
    expect(lines[9]).to.include("[10/10] SiloFactory.renounceRole");
    await finishAndVerify(c);
  });

  it("continues a handover that stopped after three transfers, sending only what is still owed", async function () {
    const c = await deployed();
    for (const contract of [c.s.stablecoin, c.s.oracle, c.s.vault]) await contract.transferGovernance(c.s.timelockAddr);

    const states = await readStates(c);
    expect(states.stablecoin).to.equal("done");
    expect(states.oracle).to.equal("done");
    expect(states.vault).to.equal("done");
    expect(states.stabilityModule).to.equal("pending");
    expect(states.siloFactory).to.equal("pending");

    // What the script used to ask before sending: the deployer on every contract. It fails on
    // each contract the first run handed over, which is what made the run impossible to repeat.
    const asIfUntouched = await census(c, { transferred: false });
    expect(failing(asIfUntouched)).to.include("census:stablecoin.DEFAULT_ADMIN_ROLE");
    expect(failing(asIfUntouched)).to.include("census:vault.GOVERNANCE_ROLE");

    // The census of the state the chain shows: the timelock where a transfer landed and the
    // deployer where it did not.
    const before = await census(c, { transferred: false, handover: states });
    expect(failing(before), report(before)).to.deep.equal([]);
    expect(detail(before, "census:stablecoin.DEFAULT_ADMIN_ROLE")).to.include("timelock");
    expect(detail(before, "census:reserve.DEFAULT_ADMIN_ROLE")).to.include("deployer");

    expect(planHandover(states).map((step) => `${step.label}.${step.action}`)).to.deep.equal([
      "stabilityModule.transferGovernance",
      "surplusBuffer.transferGovernance",
      "stabilityPool.transferGovernance",
      "reserve.transferGovernance",
      "governance.transferGovernance",
      "siloFactory.grantRole",
      "siloFactory.renounceRole",
    ]);
    await finishAndVerify(c);
  });

  it("continues a SiloFactory whose grant landed and whose renounce did not", async function () {
    const c = await deployed();
    const { s } = c;
    for (const contract of [s.stablecoin, s.oracle, s.vault, s.stabilityModule, s.surplusBuffer, s.stabilityPool, s.reserve, s.governance]) {
      await contract.transferGovernance(s.timelockAddr);
    }
    await s.siloFactory.grantRole(await s.siloFactory.DEFAULT_ADMIN_ROLE(), s.timelockAddr);

    const states = await readStates(c);
    expect(states.siloFactory).to.equal("granted");
    expect(await handedOver(c)).to.equal(false);
    const before = await census(c, { transferred: false, handover: states });
    expect(failing(before), report(before)).to.deep.equal([]);
    expect(planHandover(states).map((step) => `${step.label}.${step.action}`)).to.deep.equal(["siloFactory.renounceRole"]);
    await finishAndVerify(c);
  });

  it("sends nothing when every transaction landed and only the snapshot flag was never written", async function () {
    const c = await deployed();
    await runHandover(c.contracts, c.parties, planHandover(await readStates(c)));

    const states = await readStates(c);
    expect(await handedOver(c)).to.equal(true);
    expect(planHandover(states)).to.deep.equal([]);
    // Nothing left to send, so the run goes straight to the checks that let it write the flag.
    await finishAndVerify(c);
  });

  it("still stops on a role planted before a handover that stopped part way, on either side of the stop", async function () {
    const signers = await ethers.getSigners();
    const planted = signers[9];
    const c = await deployed(async (s) => {
      await s.oracle.grantRole(await s.oracle.GOVERNANCE_ROLE(), planted.address);
      await s.reserve.grantRole(await s.reserve.DEFAULT_ADMIN_ROLE(), planted.address);
    });
    for (const contract of [c.s.stablecoin, c.s.oracle, c.s.vault]) await contract.transferGovernance(c.s.timelockAddr);

    const states = await readStates(c);
    const before = await census(c, { transferred: false, handover: states });
    expect(failing(before)).to.have.members(["census:oracle.GOVERNANCE_ROLE", "census:reserve.DEFAULT_ADMIN_ROLE"]);
    expect(detail(before, "census:oracle.GOVERNANCE_ROLE")).to.include(`unexpected holder ${planted.address}`);
    expect(detail(before, "census:reserve.DEFAULT_ADMIN_ROLE")).to.include(`unexpected holder ${planted.address}`);
  });

  it("refuses an admin state the handover never leaves, naming the contract", async function () {
    const c = await deployed();
    const ADMIN = await c.s.oracle.DEFAULT_ADMIN_ROLE();
    // Both keys on a contract that hands over in one transaction: somebody granted the timelock by hand.
    await c.s.oracle.grantRole(ADMIN, c.s.timelockAddr);
    // Neither key: the deployer gave its role up without the timelock holding it.
    await c.s.surplusBuffer.renounceRole(ADMIN, c.s.deployer.address);

    const admins = await readHandoverAdmins(c.contracts, c.parties);
    expect(admins.oracle).to.deep.equal({ deployer: true, timelock: true });
    expect(admins.surplusBuffer).to.deep.equal({ deployer: false, timelock: false });
    expect(() => handoverStates(admins))
      .to.throw()
      .with.property("message")
      .that.includes("GoldOracle")
      .and.includes("SurplusBuffer")
      .and.does.not.include("GoldVault");
  });

  it("reads both keys on the SiloFactory as its grant without its renounce, and refuses to plan around a contract it cannot place", function () {
    const untouched = { deployer: true, timelock: false };
    const admins = {
      stablecoin: untouched,
      oracle: untouched,
      vault: untouched,
      stabilityModule: untouched,
      surplusBuffer: untouched,
      stabilityPool: untouched,
      reserve: untouched,
      governance: untouched,
      siloFactory: { deployer: true, timelock: true },
    };
    const states = handoverStates(admins);
    expect(states.siloFactory).to.equal("granted");
    expect(planHandover(states).map((step) => `${step.label}.${step.action}`).slice(-2)).to.deep.equal([
      "governance.transferGovernance",
      "siloFactory.renounceRole",
    ]);
    expect(() => planHandover({ ...states, vault: "granted" })).to.throw("GoldVault");
  });

  // ----- The whole ceremony (scripts/lib/handoverCeremony.ts), as the script runs it -----

  interface CeremonyRecord {
    transferred: number;
    lines: string[];
    censusAt: number[];
  }

  /** The ceremony over the production fixture, with a count where the script writes the snapshot. */
  function ceremonyOf(c: Ceremony): { ceremony: HandoverCeremony; record: CeremonyRecord } {
    const record: CeremonyRecord = { transferred: 0, lines: [], censusAt: [] };
    const ceremony: HandoverCeremony = {
      contracts: c.contracts,
      parties: c.parties,
      headBlock: () => ethers.provider.getBlockNumber(),
      census: (stage: CensusStage, block: number) => {
        record.censusAt.push(block);
        return census(c, stage, block);
      },
      gracePeriod: () => timelockGracePeriodCheck(ethers.provider, c.s.timelockAddr),
      recordTransferred: () => {
        record.transferred += 1;
      },
      log: (line) => record.lines.push(line),
    };
    return { ceremony, record };
  }

  it("carries a handover that has not started through to the record", async function () {
    const c = await deployed();
    const { ceremony, record } = ceremonyOf(c);
    await carryOutHandover(ceremony);
    expect(await handedOver(c)).to.equal(true);
    expect(record.transferred).to.equal(1);
    expect(record.lines.join("\n")).to.include("[10/10] SiloFactory.renounceRole");
  });

  it("resumes a handover that stopped part way, says what it found and records it", async function () {
    const c = await deployed();
    for (const contract of [c.s.stablecoin, c.s.oracle, c.s.vault]) await contract.transferGovernance(c.s.timelockAddr);
    const { ceremony, record } = ceremonyOf(c);
    await carryOutHandover(ceremony);
    const said = record.lines.join("\n");
    expect(said).to.include("Already handed over: GoldStablecoin, GoldOracle, GoldVault.");
    expect(said).to.include("Continuing with the 7 transaction(s) still owed.");
    expect(said).to.include("[1/7] StabilityModule.transferGovernance");
    expect(await handedOver(c)).to.equal(true);
    expect(record.transferred).to.equal(1);
  });

  // The other half of the fault: the first run sent everything and died before the write.
  it("sends nothing and still records a handover whose every transaction landed", async function () {
    const c = await deployed();
    await runHandover(c.contracts, c.parties, planHandover(await readStates(c)));
    const sentBefore = await ethers.provider.getTransactionCount(c.s.deployer.address);
    const { ceremony, record } = ceremonyOf(c);
    await carryOutHandover(ceremony);
    expect(await ethers.provider.getTransactionCount(c.s.deployer.address)).to.equal(sentBefore);
    expect(record.lines.join("\n")).to.include("nothing is left to send");
    expect(record.transferred).to.equal(1);
  });

  it("refuses before its first transaction on a planted role, and records nothing", async function () {
    const planted = (await ethers.getSigners())[9];
    const c = await deployed(async (s) => {
      await s.reserve.grantRole(await s.reserve.DEFAULT_ADMIN_ROLE(), planted.address);
    });
    const sentBefore = await ethers.provider.getTransactionCount(c.s.deployer.address);
    const { ceremony, record } = ceremonyOf(c);
    await expect(carryOutHandover(ceremony)).to.be.rejectedWith(HandoverRefused, /This run sent nothing/);
    expect(await ethers.provider.getTransactionCount(c.s.deployer.address)).to.equal(sentBefore);
    expect(record.transferred).to.equal(0);
  });

  it("takes the plan and the census before sending at one block, and verifies after its last transaction", async function () {
    const c = await deployed();
    const plannedAt = await ethers.provider.getBlockNumber();
    const { ceremony, record } = ceremonyOf(c);
    await carryOutHandover(ceremony);
    // Ten transactions, one block each on this node.
    expect(record.censusAt).to.deep.equal([plannedAt, plannedAt + 10]);
  });

  // ----- The same ceremony over an in-memory chain, where a transaction can be made to fail -----

  const DEPLOYER = "0x00000000000000000000000000000000000000d1";
  const TIMELOCK = "0x00000000000000000000000000000000000000d2";

  interface FakeChain {
    head: number;
    /** Every transaction sent, in order, whether or not it was mined. */
    sent: string[];
    /** The block each hasRole read was pinned to. */
    readsAt: Array<number | undefined>;
    /** The position in `sent` of a transaction that is never mined. */
    failAt?: number;
    admins: HandoverAdmins;
    contracts: HandoverContracts;
  }

  /** Nine contracts the deployer administers; an admin moves when its transaction is mined. */
  function fakeChain(): FakeChain {
    const untouched = (): { deployer: boolean; timelock: boolean } => ({ deployer: true, timelock: false });
    const admins: HandoverAdmins = {
      stablecoin: untouched(),
      oracle: untouched(),
      vault: untouched(),
      stabilityModule: untouched(),
      surplusBuffer: untouched(),
      stabilityPool: untouched(),
      reserve: untouched(),
      governance: untouched(),
      siloFactory: untouched(),
    };
    const chain: FakeChain = { head: 100, sent: [], readsAt: [], admins, contracts: undefined as unknown as HandoverContracts };
    const send = (name: string, apply: () => void): Promise<SentTransaction> => {
      const position = chain.sent.push(name) - 1;
      return Promise.resolve({
        wait: async () => {
          if (position === chain.failAt) throw new Error(`${name} was not mined`);
          apply();
          chain.head += 1;
          return { blockNumber: chain.head };
        },
      });
    };
    const reader = (label: HandoverLabel): RoleReader => ({
      hasRole: async (_role, account, at) => {
        chain.readsAt.push(at.blockTag);
        return account === DEPLOYER ? admins[label].deployer : admins[label].timelock;
      },
    });
    const transferable = (label: TransferLabel): TransferableContract => ({
      ...reader(label),
      transferGovernance: () =>
        send(`${label}.transferGovernance`, () => {
          admins[label] = { deployer: false, timelock: true };
        }),
    });
    chain.contracts = {
      stablecoin: transferable("stablecoin"),
      oracle: transferable("oracle"),
      vault: transferable("vault"),
      stabilityModule: transferable("stabilityModule"),
      surplusBuffer: transferable("surplusBuffer"),
      stabilityPool: transferable("stabilityPool"),
      reserve: transferable("reserve"),
      governance: transferable("governance"),
      siloFactory: {
        ...reader("siloFactory"),
        grantRole: () =>
          send("siloFactory.grantRole", () => {
            admins.siloFactory = { ...admins.siloFactory, timelock: true };
          }),
        renounceRole: () =>
          send("siloFactory.renounceRole", () => {
            admins.siloFactory = { ...admins.siloFactory, deployer: false };
          }),
      },
    };
    return chain;
  }

  function fakeCeremony(chain: FakeChain, overrides: Partial<HandoverCeremony> = {}): { ceremony: HandoverCeremony; record: CeremonyRecord } {
    const record: CeremonyRecord = { transferred: 0, lines: [], censusAt: [] };
    const ceremony: HandoverCeremony = {
      contracts: chain.contracts,
      parties: { deployer: DEPLOYER, timelock: TIMELOCK },
      headBlock: async () => chain.head,
      census: async (_stage, block) => {
        record.censusAt.push(block);
        return [{ pass: true }];
      },
      gracePeriod: async () => ({ name: "timelock:GRACE_PERIOD", pass: true, detail: "7 days" }),
      recordTransferred: () => {
        record.transferred += 1;
      },
      log: (line) => record.lines.push(line),
      ...overrides,
    };
    return { ceremony, record };
  }

  it("stops at the transaction that fails, whichever of the ten it is, sends nothing after it and finishes on the next run", async function () {
    for (let failAt = 0; failAt < 10; failAt++) {
      const chain = fakeChain();
      chain.failAt = failAt;
      const { ceremony, record } = fakeCeremony(chain);

      const failure = await carryOutHandover(ceremony).then(
        () => undefined,
        (err: unknown) => err
      );
      expect(failure, `transaction ${failAt + 1}`).to.be.instanceOf(Error);
      expect(failure).not.to.be.instanceOf(HandoverRefused);
      expect(String(failure)).to.include("was not mined");
      // Nothing follows the transaction that failed, and nothing is recorded.
      expect(chain.sent, `transaction ${failAt + 1}`).to.have.length(failAt + 1);
      expect(record.transferred).to.equal(0);
      expect(record.lines.join("\n")).to.include("The handover stopped part way");

      chain.failAt = undefined;
      await carryOutHandover(ceremony);
      // The failed transaction again, then the rest: eleven sends for ten transactions.
      expect(chain.sent, `transaction ${failAt + 1}`).to.have.length(11);
      expect(adminsHandedOver(chain.admins)).to.equal(true);
      expect(record.transferred).to.equal(1);
    }
  });

  // The deployer giving up the SiloFactory while nobody else holds it would be final.
  it("never sends the SiloFactory renounce after a grant that was not mined", async function () {
    const chain = fakeChain();
    chain.failAt = 8;
    const { ceremony } = fakeCeremony(chain);
    await expect(carryOutHandover(ceremony)).to.be.rejectedWith("siloFactory.grantRole was not mined");
    expect(chain.sent[chain.sent.length - 1]).to.equal("siloFactory.grantRole");
    expect(chain.admins.siloFactory).to.deep.equal({ deployer: true, timelock: false });
  });

  it("pins every admin read of the plan to one block and every read of the verification to another", async function () {
    const chain = fakeChain();
    const { ceremony, record } = fakeCeremony(chain);
    await carryOutHandover(ceremony);
    expect(chain.readsAt.slice(0, 18)).to.deep.equal(new Array(18).fill(100));
    expect(chain.readsAt.slice(18)).to.deep.equal(new Array(18).fill(110));
    expect(record.censusAt).to.deep.equal([100, 110]);
  });

  // A load-balanced endpoint can answer the head from a node that has not seen the last block.
  it("verifies at its last transaction's block when the endpoint's head is still behind it", async function () {
    const chain = fakeChain();
    let asked = 0;
    const { ceremony, record } = fakeCeremony(chain, { headBlock: async () => (asked++ === 0 ? chain.head : 100) });
    await carryOutHandover(ceremony);
    expect(record.censusAt).to.deep.equal([100, 110]);
    expect(chain.readsAt[chain.readsAt.length - 1]).to.equal(110);
  });

  it("records nothing when the census after the handover fails", async function () {
    const chain = fakeChain();
    const { ceremony, record } = fakeCeremony(chain, { census: async (stage) => [{ pass: stage.transferred !== true }] });
    await expect(carryOutHandover(ceremony)).to.be.rejectedWith(HandoverRefused, /Verification FAILED/);
    expect(chain.sent).to.have.length(10);
    expect(record.transferred).to.equal(0);
  });

  it("records nothing when a contract still shows the deployer as admin after the last transaction", async function () {
    const chain = fakeChain();
    // The vault's transfer is mined and changes nothing: the verification must name it.
    chain.contracts.vault.transferGovernance = async () => ({ wait: async () => ({ blockNumber: (chain.head += 1) }) });
    const { ceremony, record } = fakeCeremony(chain);
    await expect(carryOutHandover(ceremony)).to.be.rejectedWith(HandoverRefused, /Verification FAILED/);
    expect(record.lines.join("\n")).to.include("[FAIL] vault: deployer=STILL ADMIN, timelock=MISSING");
    expect(record.transferred).to.equal(0);
  });

  it("sends nothing when the timelock would let a matured operation wait forever", async function () {
    const chain = fakeChain();
    const { ceremony, record } = fakeCeremony(chain, {
      gracePeriod: async () => ({ name: "timelock:GRACE_PERIOD", pass: false, detail: "no grace period" }),
    });
    await expect(carryOutHandover(ceremony)).to.be.rejectedWith(HandoverRefused, /redeploy/);
    expect(chain.sent).to.deep.equal([]);
    expect(record.transferred).to.equal(0);
  });
});
