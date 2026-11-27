import { expect } from "chai";
import { ZeroAddress } from "ethers";
import { siloImplementationJob, TIMELOCK_MIN_DELAY_SECONDS, verificationJobs, VerificationSnapshot } from "../scripts/lib/etherscanArgs";

/** scripts/verify-etherscan.ts rebuilds every constructor from the snapshot; these pin the shapes. */
describe("Etherscan verification jobs (scripts/verify-etherscan.ts)", function () {
  const addr = (n: number): string => `0x${n.toString(16).padStart(40, "0")}`;
  const snapshot: VerificationSnapshot = {
    addresses: {
      oracle: addr(1),
      stablecoin: addr(2),
      stabilityModule: addr(3),
      vault: addr(4),
      surplusBuffer: addr(5),
      stabilityPool: addr(6),
      reserve: addr(7),
      siloFactory: addr(8),
      governance: addr(9),
      timelock: addr(10),
    },
    config: {
      paxgToken: addr(21),
      xautToken: addr(22),
      paxgFeed: addr(23),
      xautFeed: addr(24),
      stalenessThreshold: 90000,
      siloCap: "100000000000000000000",
      proposers: [addr(31)],
      executors: [ZeroAddress],
    },
  };

  it("covers the twelve contracts of the mainnet launch: the ten below, XAUT's InactiveFeed and the VaultRegistry", function () {
    const launch: VerificationSnapshot = {
      ...snapshot,
      addresses: { ...snapshot.addresses, vaultRegistry: addr(11) },
      config: { ...snapshot.config, xautFeedDeployed: true },
    };
    const labels = verificationJobs(launch).map((j) => j.label);
    expect(labels).to.have.length(12);
    expect(labels).to.include.members(["InactiveFeed", "VaultRegistry", "GoldGovernance", "TimelockController"]);
    expect(new Set(labels).size).to.equal(12);
  });

  it("adds the CollateralSilo implementation after its factory when given the address the factory reports: thirteen", function () {
    const launch: VerificationSnapshot = {
      ...snapshot,
      addresses: { ...snapshot.addresses, vaultRegistry: addr(11) },
      config: { ...snapshot.config, xautFeedDeployed: true },
    };
    const jobs = verificationJobs(launch, addr(40));
    expect(jobs).to.have.length(13);
    const at = jobs.findIndex((j) => j.label === "SiloFactory");
    expect(jobs[at + 1]).to.deep.equal({
      label: "CollateralSilo",
      address: addr(40),
      contract: "src/core/CollateralSilo.sol:CollateralSilo",
      constructorArguments: [],
    });
    // Every other job is the one the snapshot alone gives.
    expect(jobs.filter((j) => j.label !== "CollateralSilo")).to.deep.equal(verificationJobs(launch));
  });

  it("refuses an implementation address that is zero or malformed", function () {
    expect(() => siloImplementationJob(ZeroAddress)).to.throw("not a contract address");
    expect(() => siloImplementationJob("0x1234")).to.throw("not a contract address");
    expect(() => verificationJobs(snapshot, ZeroAddress)).to.throw("siloImplementation()");
  });

  it("covers the ten contracts of an older snapshot, with no registry and no InactiveFeed, in deploy order", function () {
    const jobs = verificationJobs(snapshot);
    expect(jobs.map((j) => j.label)).to.deep.equal([
      "GoldOracle",
      "GoldStablecoin",
      "StabilityModule",
      "GoldVault",
      "SurplusBuffer",
      "StabilityPool",
      "GoldStabilityReserve",
      "SiloFactory",
      "GoldGovernance",
      "TimelockController",
    ]);
    expect(jobs.every((j) => j.contract.includes(":"))).to.equal(true);
  });

  it("adds the VaultRegistry job after SiloFactory when the snapshot has one", function () {
    const withRegistry: VerificationSnapshot = {
      ...snapshot,
      addresses: { ...snapshot.addresses, vaultRegistry: addr(11) },
    };
    const jobs = verificationJobs(withRegistry);
    expect(jobs.map((j) => j.label).slice(7, 10)).to.deep.equal(["SiloFactory", "VaultRegistry", "GoldGovernance"]);
    const registry = jobs.find((j) => j.label === "VaultRegistry");
    expect(registry?.address).to.equal(addr(11));
    expect(registry?.contract).to.equal("src/core/VaultRegistry.sol:VaultRegistry");
    expect(registry?.constructorArguments).to.deep.equal([addr(4)]);
  });

  it("rebuilds each constructor from the snapshot", function () {
    const byLabel = Object.fromEntries(verificationJobs(snapshot).map((j) => [j.label, j]));
    expect(byLabel.GoldOracle.constructorArguments).to.deep.equal([addr(23), addr(24), addr(21), addr(22), 90000]);
    expect(byLabel.GoldVault.constructorArguments).to.deep.equal([addr(1), addr(2), addr(3)]);
    expect(byLabel.GoldStabilityReserve.constructorArguments).to.deep.equal([addr(2), addr(1)]);
    expect(byLabel.SiloFactory.constructorArguments).to.deep.equal(["100000000000000000000"]);
    expect(byLabel.GoldGovernance.constructorArguments).to.deep.equal([[addr(31)], [ZeroAddress], addr(4), addr(1), addr(3)]);
  });

  it("appends the wrapper to the timelock's proposers and executors, with no admin", function () {
    const timelock = verificationJobs(snapshot).find((j) => j.label === "TimelockController");
    expect(timelock?.address).to.equal(addr(10));
    // GoldGovernance deploys the grace period subclass, not the stock OpenZeppelin controller.
    expect(timelock?.contract).to.equal("src/governance/ExpiringTimelockController.sol:ExpiringTimelockController");
    expect(timelock?.constructorArguments).to.deep.equal([TIMELOCK_MIN_DELAY_SECONDS, [addr(31), addr(9)], [ZeroAddress, addr(9)], ZeroAddress]);
    expect(TIMELOCK_MIN_DELAY_SECONDS).to.equal(172800);
  });

  it("names what a malformed snapshot lacks", function () {
    expect(() => verificationJobs({ ...snapshot, addresses: { ...snapshot.addresses, timelock: undefined } })).to.throw("timelock");
    expect(() => verificationJobs({ ...snapshot, config: { ...snapshot.config, siloCap: "" } })).to.throw("siloCap");
  });
});
