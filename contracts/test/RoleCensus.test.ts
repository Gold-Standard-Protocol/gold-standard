import { expect } from "chai";
import { ethers } from "hardhat";
import type { Provider, TransactionRequest } from "ethers";
import type { ExpiringTimelockController } from "../typechain-types";
import { productionSystem } from "./helpers/productionSystem";
import { ethersCallError, HEADER_NOT_FOUND, RATE_LIMITED } from "./helpers/rpcErrors";
import {
  CensusAddresses,
  CensusCheck,
  censusFromBlock,
  censusTargets,
  earliestCreationBlock,
  GRACE_PERIOD_SECONDS,
  takeRoleCensus,
  timelockGracePeriodCheck,
  WRAPPER_AGREEMENT_CHECK,
  wrapperAgreementCheck,
} from "../scripts/lib/roleCensus";

/**
 * The role census verify-deployment.ts and transfer-governance.ts run (scripts/lib/roleCensus.ts),
 * against the production fixture. Roles planted before the governance handover used to
 * survive transfer-governance, verify-deployment and lockMinters without detection: both
 * scripts asked only whether named keys held named roles, so a second minter, a
 * second governor on the oracle or a grant the deployer made itself on the wrapper passed every
 * check of the ceremony. The census rebuilds each role's whole holder set, from getRoleMember where
 * the contract is enumerable and from the RoleGranted and RoleRevoked logs everywhere, and compares
 * it with the set the ceremony intends.
 */
describe("Role census (scripts/lib/roleCensus.ts)", function () {
  type System = Awaited<ReturnType<typeof productionSystem>>;

  async function addressesOf(s: System): Promise<CensusAddresses> {
    return {
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
  }

  /**
   * The system as deploy.ts leaves it (no deployer minter, the silo factory locked), then `plant`
   * as the deployer, then the handover in the order transfer-governance.ts runs it.
   */
  async function ceremony(plant?: (s: System) => Promise<void>, handOver = true) {
    const fromBlock = (await ethers.provider.getBlockNumber()) + 1;
    const s = await productionSystem();
    await s.stablecoin.revokeRole(await s.stablecoin.MINTER_ROLE(), s.deployer.address);
    await s.siloFactory.lockVaultRole(await s.vault.getAddress());
    if (plant) await plant(s);
    if (handOver) {
      for (const c of [s.stablecoin, s.oracle, s.vault, s.stabilityModule, s.surplusBuffer, s.stabilityPool, s.reserve, s.governance]) {
        await c.transferGovernance(s.timelockAddr);
      }
      const ADMIN = await s.siloFactory.DEFAULT_ADMIN_ROLE();
      await s.siloFactory.grantRole(ADMIN, s.timelockAddr);
      await s.siloFactory.renounceRole(ADMIN, s.deployer.address);
    }
    return { s, fromBlock, addresses: await addressesOf(s) };
  }

  async function census(s: System, addresses: CensusAddresses, fromBlock: number, transferred = true, chunkSize?: number): Promise<CensusCheck[]> {
    const targets = censusTargets({
      addresses,
      deployer: s.deployer.address,
      proposers: [s.proposer.address],
      executors: [s.executor.address],
      guardian: s.guardian.address,
      transferred,
    });
    return takeRoleCensus(ethers.provider, targets, { fromBlock, deployer: s.deployer.address, chunkSize });
  }

  const failing = (checks: CensusCheck[]): string[] => checks.filter((c) => !c.pass).map((c) => c.name);
  const detail = (checks: CensusCheck[], name: string): string => checks.find((c) => c.name === name)?.detail ?? "";

  it("passes the ceremony deploy.ts and transfer-governance.ts perform, with every holder set exact", async function () {
    const { s, addresses, fromBlock } = await ceremony();
    const checks = await census(s, addresses, fromBlock);
    expect(failing(checks), checks.map((c) => `${c.name}: ${c.detail}`).join("\n")).to.deep.equal([]);
    for (const name of [
      "census:stablecoin.DEFAULT_ADMIN_ROLE",
      "census:stablecoin.MINTER_ROLE",
      "census:oracle.GOVERNANCE_ROLE",
      "census:vault.GUARDIAN_ROLE",
      "census:surplusBuffer.VAULT_ROLE",
      "census:siloFactory.VAULT_ROLE",
      "census:siloFactory.LOCKED_ROLE",
      "census:governance.PROPOSER_ROLE",
      "census:governance.EXECUTOR_ROLE",
      "census:timelock.PROPOSER_ROLE",
      "census:timelock.CANCELLER_ROLE",
      "census:timelock.EXECUTOR_ROLE",
      "census:timelock.DEFAULT_ADMIN_ROLE",
      "census:deployer",
    ]) {
      expect(checks.some((c) => c.name === name), name).to.equal(true);
    }
    expect(detail(checks, "census:stablecoin.MINTER_ROLE")).to.include(addresses.vault);
    expect(detail(checks, "census:siloFactory.LOCKED_ROLE")).to.include("nobody");
    expect(detail(checks, "census:deployer")).to.include("holds no role");
  });

  it("fails a second MINTER_ROLE holder planted before the handover, naming the role and the holder", async function () {
    const planted = (await ethers.getSigners())[9];
    const { s, addresses, fromBlock } = await ceremony(async (sys) => {
      await sys.stablecoin.grantRole(await sys.stablecoin.MINTER_ROLE(), planted.address);
    });
    const checks = await census(s, addresses, fromBlock);
    expect(failing(checks)).to.deep.equal(["census:stablecoin.MINTER_ROLE"]);
    expect(detail(checks, "census:stablecoin.MINTER_ROLE")).to.include("MINTER_ROLE");
    expect(detail(checks, "census:stablecoin.MINTER_ROLE")).to.include(`unexpected holder ${planted.address}`);
  });

  it("fails a GOVERNANCE_ROLE planted on GoldOracle, a role no earlier check read", async function () {
    const planted = (await ethers.getSigners())[9];
    const { s, addresses, fromBlock } = await ceremony(async (sys) => {
      await sys.oracle.grantRole(await sys.oracle.GOVERNANCE_ROLE(), planted.address);
    });
    const checks = await census(s, addresses, fromBlock);
    expect(failing(checks)).to.deep.equal(["census:oracle.GOVERNANCE_ROLE"]);
    expect(detail(checks, "census:oracle.GOVERNANCE_ROLE")).to.include(`unexpected holder ${planted.address}`);
  });

  it("fails an extra EXECUTOR_ROLE holder on the GoldGovernance wrapper", async function () {
    const planted = (await ethers.getSigners())[10];
    const { s, addresses, fromBlock } = await ceremony(async (sys) => {
      await sys.governance.grantRole(await sys.governance.EXECUTOR_ROLE(), planted.address);
    });
    const checks = await census(s, addresses, fromBlock);
    expect(failing(checks)).to.deep.equal(["census:governance.EXECUTOR_ROLE", WRAPPER_AGREEMENT_CHECK]);
    expect(detail(checks, WRAPPER_AGREEMENT_CHECK)).to.include(`${planted.address} (not a configured address) still holds EXECUTOR_ROLE on the wrapper but not on the timelock`);
    expect(detail(checks, "census:governance.EXECUTOR_ROLE")).to.include("EXECUTOR_ROLE");
    expect(detail(checks, "census:governance.EXECUTOR_ROLE")).to.include(`unexpected holder ${planted.address}`);
  });

  it("fails a deployer that granted itself the wrapper's PROPOSER_ROLE and EXECUTOR_ROLE before handing over", async function () {
    const { s, addresses, fromBlock } = await ceremony(async (sys) => {
      await sys.governance.grantRole(await sys.governance.PROPOSER_ROLE(), sys.deployer.address);
      await sys.governance.grantRole(await sys.governance.EXECUTOR_ROLE(), sys.deployer.address);
    });
    const checks = await census(s, addresses, fromBlock);
    expect(failing(checks)).to.have.members(["census:governance.PROPOSER_ROLE", "census:governance.EXECUTOR_ROLE", "census:deployer", WRAPPER_AGREEMENT_CHECK]);
    expect(detail(checks, "census:deployer")).to.include("governance.PROPOSER_ROLE");
    expect(detail(checks, "census:deployer")).to.include("governance.EXECUTOR_ROLE");
    expect(detail(checks, "census:governance.PROPOSER_ROLE")).to.include(`unexpected holder ${s.deployer.address} (deployer)`);
  });

  describe("the wrapper's role lists against the timelock's", function () {
    /** Sends `data` to the timelock as the timelock itself, which administers its own roles. */
    async function asTimelock(s: System, run: (timelock: ExpiringTimelockController) => Promise<unknown>): Promise<void> {
      await ethers.provider.send("hardhat_impersonateAccount", [s.timelockAddr]);
      await ethers.provider.send("hardhat_setBalance", [s.timelockAddr, "0x56BC75E2D63100000"]);
      const signer = await ethers.getSigner(s.timelockAddr);
      await run(await ethers.getContractAt("ExpiringTimelockController", s.timelockAddr, signer));
      await ethers.provider.send("hardhat_stopImpersonatingAccount", [s.timelockAddr]);
    }

    it("passes after the ceremony: the two lists hold the same Safes, the wrapper aside", async function () {
      const { s, addresses, fromBlock } = await ceremony();
      const checks = await census(s, addresses, fromBlock);
      const agreement = checks.find((c) => c.name === WRAPPER_AGREEMENT_CHECK);
      expect(agreement?.pass).to.equal(true);
      expect(agreement?.detail).to.include("exactly the timelock's");
    });

    it("fails a proposer revoked on the timelock alone, which still schedules through the wrapper", async function () {
      const { s, addresses, fromBlock } = await ceremony();
      await asTimelock(s, async (timelock) => timelock.revokeRole(await timelock.PROPOSER_ROLE(), s.proposer.address));
      // The revoked Safe still holds the wrapper's role, so a propose helper still schedules for it.
      expect(await s.governance.hasRole(await s.governance.PROPOSER_ROLE(), s.proposer.address)).to.equal(true);
      const checks = await census(s, addresses, fromBlock);
      expect(failing(checks)).to.include(WRAPPER_AGREEMENT_CHECK);
      const line = detail(checks, WRAPPER_AGREEMENT_CHECK);
      expect(line).to.include(`${s.proposer.address}`);
      expect(line).to.include("still holds PROPOSER_ROLE on the wrapper but not on the timelock");
      expect(line).to.include("schedule through the propose helpers");
    });

    it("fails an executor revoked on the wrapper alone, which still executes on the timelock", async function () {
      const { s, addresses, fromBlock } = await ceremony();
      await asTimelock(s, async () => {
        const signer = await ethers.getSigner(s.timelockAddr);
        await s.governance.connect(signer).revokeRole(await s.governance.EXECUTOR_ROLE(), s.executor.address);
      });
      const checks = await census(s, addresses, fromBlock);
      expect(detail(checks, WRAPPER_AGREEMENT_CHECK)).to.include(`${s.executor.address}`);
      expect(detail(checks, WRAPPER_AGREEMENT_CHECK)).to.include("still holds EXECUTOR_ROLE on the timelock but not on the wrapper");
    });

    it("passes a rotation made on both lists, and names each stale holder on its side otherwise", function () {
      const [wrapper, oldSafe, newSafe, executor] = ["0x00000000000000000000000000000000000000a1", "0x00000000000000000000000000000000000000b2", "0x00000000000000000000000000000000000000c3", "0x00000000000000000000000000000000000000d4"];
      const rotated = wrapperAgreementCheck(
        { PROPOSER_ROLE: [newSafe], EXECUTOR_ROLE: [executor] },
        { PROPOSER_ROLE: [newSafe.toUpperCase().replace("0X", "0x"), wrapper], EXECUTOR_ROLE: [executor, wrapper] },
        wrapper,
      );
      expect(rotated.pass).to.equal(true);
      const oneSided = wrapperAgreementCheck(
        { PROPOSER_ROLE: [oldSafe, newSafe], EXECUTOR_ROLE: [] },
        { PROPOSER_ROLE: [newSafe, wrapper], EXECUTOR_ROLE: [executor, wrapper] },
        wrapper,
        (address) => `${address} (named)`,
      );
      expect(oneSided.pass).to.equal(false);
      expect(oneSided.name).to.equal("gov:wrapper-roles-match-timelock");
      expect(oneSided.detail).to.include(`${oldSafe} (named) still holds PROPOSER_ROLE on the wrapper but not on the timelock`);
      expect(oneSided.detail).to.include(`${executor} (named) still holds EXECUTOR_ROLE on the timelock but not on the wrapper`);
      expect(oneSided.detail).not.to.include(newSafe + " (named) still");
      // The wrapper's own seat on the timelock is never a difference.
      expect(oneSided.detail).not.to.include(wrapper);
    });

    it("treats an open executor, the zero address on both lists, as agreement", function () {
      const zero = ethers.ZeroAddress;
      const open = wrapperAgreementCheck({ PROPOSER_ROLE: [], EXECUTOR_ROLE: [zero] }, { PROPOSER_ROLE: ["0x00000000000000000000000000000000000000a1"], EXECUTOR_ROLE: [zero, "0x00000000000000000000000000000000000000a1"] }, "0x00000000000000000000000000000000000000a1");
      expect(open.pass).to.equal(true);
    });
  });

  it("fails a second DEFAULT_ADMIN_ROLE holder that survives beside the timelock", async function () {
    const planted = (await ethers.getSigners())[11];
    const { s, addresses, fromBlock } = await ceremony(async (sys) => {
      await sys.stablecoin.grantRole(await sys.stablecoin.DEFAULT_ADMIN_ROLE(), planted.address);
      await sys.vault.grantRole(await sys.vault.DEFAULT_ADMIN_ROLE(), planted.address);
    });
    const checks = await census(s, addresses, fromBlock);
    expect(failing(checks)).to.have.members(["census:stablecoin.DEFAULT_ADMIN_ROLE", "census:vault.DEFAULT_ADMIN_ROLE"]);
    expect(detail(checks, "census:vault.DEFAULT_ADMIN_ROLE")).to.include(`unexpected holder ${planted.address}`);
  });

  it("fails a role the contracts never define as soon as anyone holds it, the deployer included", async function () {
    const planted = (await ethers.getSigners())[12];
    const BACKDOOR = ethers.id("BACKDOOR_ROLE");
    const { s, addresses, fromBlock } = await ceremony(async (sys) => {
      await sys.vault.grantRole(BACKDOOR, planted.address);
    });
    const checks = await census(s, addresses, fromBlock);
    expect(failing(checks)).to.deep.equal(["census:vault.unknown-roles"]);
    expect(detail(checks, "census:vault.unknown-roles")).to.include(BACKDOOR);
    expect(detail(checks, "census:vault.unknown-roles")).to.include(planted.address);

    const own = await ceremony(async (sys) => {
      await sys.oracle.grantRole(BACKDOOR, sys.deployer.address);
    });
    const ownChecks = await census(own.s, own.addresses, own.fromBlock);
    expect(failing(ownChecks)).to.have.members(["census:oracle.unknown-roles", "census:deployer"]);
    expect(detail(ownChecks, "census:deployer")).to.include(`oracle.${BACKDOOR}`);
  });

  it("forgets a grant revoked before the handover, replaying the logs in small chunks", async function () {
    const planted = (await ethers.getSigners())[9];
    const { s, addresses, fromBlock } = await ceremony(async (sys) => {
      const GOVERNANCE = await sys.reserve.GOVERNANCE_ROLE();
      await sys.reserve.grantRole(GOVERNANCE, planted.address);
      await sys.reserve.revokeRole(GOVERNANCE, planted.address);
    });
    const checks = await census(s, addresses, fromBlock, true, 3);
    expect(failing(checks)).to.deep.equal([]);
  });

  it("expects the deployer as the authority before the handover and the timelock after it", async function () {
    const { s, addresses, fromBlock } = await ceremony(undefined, false);
    expect(failing(await census(s, addresses, fromBlock, false))).to.deep.equal([]);
    const early = await census(s, addresses, fromBlock, true);
    expect(failing(early)).to.include("census:stablecoin.DEFAULT_ADMIN_ROLE");
    expect(failing(early)).to.include("census:oracle.GOVERNANCE_ROLE");
    expect(detail(early, "census:oracle.GOVERNANCE_ROLE")).to.include(`missing ${addresses.timelock} (timelock)`);
  });

  it("asserts the timelock's grace period and fails a stock TimelockController without one", async function () {
    const { s, addresses } = await ceremony();
    const check = await timelockGracePeriodCheck(ethers.provider, addresses.timelock);
    expect(check.pass, check.detail).to.equal(true);
    expect(GRACE_PERIOD_SECONDS).to.equal(7n * 24n * 3600n);
    const Stock = await ethers.getContractFactory("@openzeppelin/contracts/governance/TimelockController.sol:TimelockController");
    const stock = await Stock.deploy(48 * 3600, [s.proposer.address], [s.executor.address], ethers.ZeroAddress);
    const old = await timelockGracePeriodCheck(ethers.provider, await stock.getAddress());
    expect(old.pass).to.equal(false);
    expect(old.detail).to.include("has no GRACE_PERIOD()");
  });

  it("fails the grace period check and asks for a retry when the read itself fails, rather than calling the timelock old", async function () {
    const { addresses } = await ceremony();
    const selector = ethers.id("GRACE_PERIOD()").slice(0, 10);
    /** ethers.provider, except that GRACE_PERIOD() reads fail with `failure`. */
    const failingGracePeriod = (failure: Error): Provider =>
      new Proxy(ethers.provider, {
        get(target, prop) {
          if (prop === "call") {
            return async (tx: TransactionRequest): Promise<string> => {
              if (typeof tx.data === "string" && tx.data.startsWith(selector)) throw failure;
              return target.call(tx);
            };
          }
          const value: unknown = Reflect.get(target, prop, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    const failures = [
      ethersCallError(selector, RATE_LIMITED),
      ethersCallError(selector, HEADER_NOT_FOUND),
      ethers.makeError("the gateway dropped the request", "NETWORK_ERROR", { event: "test" }),
    ];
    for (const failure of failures) {
      const check = await timelockGracePeriodCheck(failingGracePeriod(failure), addresses.timelock);
      expect(check.pass).to.equal(false);
      expect(check.detail).to.include("could not read GRACE_PERIOD(); retry on another endpoint");
      expect(check.detail).to.not.include("predates");
    }
  });

  it("names the address, not the grace period, when the timelock itself cannot be read", async function () {
    const { addresses } = await ceremony();
    // The stablecoin is a contract with no getMinDelay(), as a mistyped timelock address would be.
    const check = await timelockGracePeriodCheck(ethers.provider, addresses.stablecoin);
    expect(check.pass).to.equal(false);
    expect(check.detail).to.include(`could not read getMinDelay() at ${addresses.stablecoin}: check that it is the timelock`);
    expect(check.detail).to.not.include("GRACE_PERIOD");
  });

  it("starts the replay at the first creation the snapshot records, or locates it on chain", async function () {
    const { s, addresses } = await ceremony();
    const oracleBlock = (await s.oracle.deploymentTransaction()?.wait())?.blockNumber;
    expect(oracleBlock).to.not.equal(undefined);
    const latest = await ethers.provider.getBlockNumber();
    expect(await earliestCreationBlock(ethers.provider, Object.values(addresses), latest)).to.equal(oracleBlock);

    const located = await censusFromBlock(ethers.provider, { addresses, deployBlock: latest }, latest);
    expect(located.fromBlock).to.equal(oracleBlock);
    expect(located.source).to.equal("located on chain");
    const creationBlocks = Object.fromEntries(Object.keys(addresses).map((label, i) => [label, 5 + i]));
    const recorded = await censusFromBlock(ethers.provider, { addresses, deployBlock: latest, creationBlocks }, latest);
    expect(recorded).to.deep.include({ fromBlock: 5, source: "recorded by deploy.ts" });
    // A record that misses a governed contract cannot bound the replay, so the block is located instead.
    const partial = await censusFromBlock(ethers.provider, { addresses, deployBlock: latest, creationBlocks: { stablecoin: 5 } }, latest);
    expect(partial.fromBlock).to.equal(oracleBlock);
  });
});
