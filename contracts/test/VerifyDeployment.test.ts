import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { setValidPrice } from "./helpers/productionSystem";
import { parameterHash, parameterRecord, parseLaunchParameters, snapshotRecordMismatches } from "../scripts/lib/launchEnv";
import { DeploymentSnapshot, deployConfig, runDeployCeremony } from "../scripts/lib/deployCeremony";
import { newDeployJournal } from "../scripts/lib/deployJournal";
import { LaunchParameterReading, ParameterCheck, launchParameterChecks, readLaunchParameters, stabilityFeeBpsOf, stabilityFeeRateOf } from "../scripts/lib/launchParameterChecks";
import { ChainParameters, refreshSnapshotConfig } from "../scripts/lib/snapshotRefresh";

/**
 * verify-deployment.ts compares every recorded launch parameter with the chain by equality
 * (scripts/lib/launchParameterChecks.ts). These run the real ceremony on the
 * Hardhat network, then move one value at a time behind the snapshot's back, the way a wiring
 * call with the wrong argument would, and require the comparison to name it.
 */
describe("verify-deployment's launch parameter comparison", function () {
  async function deployed() {
    const [deployer, proposer, executor, guardian] = await ethers.getSigners();
    const MockToken = await ethers.getContractFactory("MockERC20");
    const MockAgg = await ethers.getContractFactory("MockAggregatorV3");
    const paxg = await MockToken.deploy("Pax Gold", "PAXG", 18);
    const xaut = await MockToken.deploy("Tether Gold", "XAUT", 6);
    const paxgFeed = await MockAgg.deploy(8);
    const anchorFeed = await MockAgg.deploy(8);
    await setValidPrice(paxgFeed, 200000000000n);
    await setValidPrice(anchorFeed, 200000000000n);
    // The mainnet profile, with a reserve minimum and a buffer floor so neither compares 0 with 0.
    const { params, findings } = parseLaunchParameters({
      LAUNCH_CAPS: "open",
      PAXG_TOKEN: await paxg.getAddress(),
      XAUT_TOKEN: await xaut.getAddress(),
      PAXG_FEED: await paxgFeed.getAddress(),
      XAU_USD_ANCHOR_FEED: await anchorFeed.getAddress(),
      TIMELOCK_PROPOSER: proposer.address,
      TIMELOCK_EXECUTOR: executor.address,
      TIMELOCK_GUARDIAN: guardian.address,
      MIN_DEBT_GSUSD: "1000",
      RESERVE_MIN_RESERVE_PAXG: "3",
      MIN_COLLATERAL_RESERVE: "4",
      RESERVE_AGGREGATE_DAILY_CAP_USD: "5000000",
    });
    if (!params) throw new Error(findings.map((f) => `${f.name}: ${f.detail}`).join("\n"));
    const cfg = deployConfig(params);
    let journal = newDeployJournal({
      network: "hardhat",
      chainId: 31337,
      deployer: deployer.address,
      parametersHash: parameterHash(parameterRecord(cfg)),
      startedAt: "2026-11-11T00:00:00.000Z",
      startBlock: await ethers.provider.getBlockNumber(),
    });
    const snapshot = await runDeployCeremony({
      cfg,
      chainId: 31337,
      networkName: "hardhat",
      deployer,
      journal,
      save: (next) => {
        journal = next;
      },
      log: () => undefined,
      readRetry: { attempts: 2, delayMs: 0 },
    });
    return { cfg, snapshot };
  }

  const failures = (checks: ParameterCheck[]): string[] => checks.filter((c) => !c.pass).map((c) => c.name);
  const failureOf = (checks: ParameterCheck[], name: string): ParameterCheck | undefined => checks.find((c) => !c.pass && c.name === name);
  const contracts = async (snapshot: DeploymentSnapshot) => ({
    vault: await ethers.getContractAt("GoldVault", snapshot.addresses.vault),
    stabilityModule: await ethers.getContractAt("StabilityModule", snapshot.addresses.stabilityModule),
    reserve: await ethers.getContractAt("GoldStabilityReserve", snapshot.addresses.reserve),
    surplusBuffer: await ethers.getContractAt("SurplusBuffer", snapshot.addresses.surplusBuffer),
    siloFactory: await ethers.getContractAt("SiloFactory", snapshot.addresses.siloFactory),
  });

  it("passes every comparison on the snapshot the ceremony wrote, which also agrees with the preflight record", async function () {
    const { cfg, snapshot } = await loadFixture(deployed);
    const checks = launchParameterChecks(snapshot, await readLaunchParameters(snapshot));
    expect(failures(checks)).to.deep.equal([]);
    // Every launch parameter and every address is compared.
    expect(checks.filter((c) => c.name.startsWith("param:"))).to.have.length(16);
    expect(checks.filter((c) => c.name.startsWith("code:"))).to.have.length(Object.keys(snapshot.addresses).length);
    expect(snapshotRecordMismatches(snapshot.config, parameterRecord(cfg))).to.deep.equal([]);
  });

  it("names each value that differs on chain from what the snapshot records", async function () {
    const { cfg, snapshot } = await loadFixture(deployed);
    const c = await contracts(snapshot);
    const paxgId = ethers.keccak256(ethers.solidityPacked(["address"], [cfg.paxgToken]));
    // The deployer still holds governance before the handover: each call stands in for a wiring
    // call that passed the wrong variable or unit.
    await (await c.stabilityModule.setStabilityFee(paxgId, 300)).wait();
    await (await c.vault.setReservePenaltyShare(5_000)).wait();
    await (await c.vault.setBadDebtPauseThreshold(1n)).wait();
    await (await c.reserve.setAggregateDailyCap(0n)).wait();
    await (await c.reserve.setAssetConfig(cfg.paxgToken, true, 9n, cfg.reserveDailyCapPpm + 1n)).wait();
    await (await c.reserve.setSpreadCurve([{ coverageAtLeastPpm: 100_000n, spreadPpm: 7_500n }], cfg.reserveRestrictedSpreadPpm + 1n)).wait();
    await (await c.surplusBuffer.setMinCollateralReserve(cfg.paxgToken, 5n)).wait();
    await (await c.surplusBuffer.setMinGsusdReserve(6n)).wait();
    await (await c.siloFactory.setSiloCap(cfg.siloCap / 2n)).wait();
    await (await c.vault.setMinDebt(ethers.parseEther("500"))).wait();
    await (await c.vault.setUnderwaterDiscount(10_000n)).wait();
    await (await c.vault.setOriginationFeeBps(10n)).wait();

    const checks = launchParameterChecks(snapshot, await readLaunchParameters(snapshot));
    expect(failures(checks)).to.have.members([
      "param:stabilityModule.paxg.stabilityFeeRate",
      "param:vault.reservePenaltyShareBps",
      "param:vault.badDebtPauseThreshold",
      "param:reserve.aggregateDailyCapUsd",
      "param:reserve.paxg.minReserve",
      "param:reserve.paxg.dailyCapPpm",
      "param:reserve.spreadCurve",
      "param:reserve.restrictedSpreadPpm",
      "param:surplusBuffer.paxg.minCollateralReserve",
      "param:surplusBuffer.minGsusdReserve",
      "param:siloFactory.siloCap",
      "param:vault.minDebt",
      "param:vault.underwaterDiscountPpm",
      "param:vault.originationFeeBps",
    ]);
    expect(failureOf(checks, "param:stabilityModule.paxg.stabilityFeeRate")?.detail).to.equal(`the chain charges 300 bps, the snapshot records ${cfg.paxg.stabilityFeeBps} bps`);
    expect(failureOf(checks, "param:reserve.aggregateDailyCapUsd")?.detail).to.equal(`got 0, the snapshot records ${cfg.reserveAggregateDailyCapUsd}`);
    expect(failureOf(checks, "param:reserve.spreadCurve")?.detail).to.include("got 100000:7500");

    // A governed change is recorded by refresh-deployment-snapshot.ts, after which nothing differs.
    const { runtimeCodeHashes: _hashes, ...launch } = await readLaunchParameters(snapshot);
    void _hashes;
    const vault = c.vault;
    const collateral = async (token: string) => {
      const t = await vault.collateralTypes(ethers.keccak256(ethers.solidityPacked(["address"], [token])));
      return { active: t.active, minRatio: t.minRatio, liquidationRatio: t.liquidationRatio, liquidationPenalty: t.liquidationPenalty, debtCeiling: t.debtCeiling };
    };
    const oracle = await ethers.getContractAt("GoldOracle", snapshot.addresses.oracle);
    const chain: ChainParameters = {
      ...launch,
      paxg: await collateral(cfg.paxgToken),
      xaut: await collateral(cfg.xautToken),
      paxgGoldBandPpm: await oracle.goldBandPpm(cfg.paxgToken),
      paxgLiquidationClampPpm: await oracle.liquidationClampPpm(cfg.paxgToken),
      stalenessThreshold: await oracle.stalenessThreshold(),
    };
    const refreshed = { ...snapshot, config: refreshSnapshotConfig(snapshot.config as Parameters<typeof refreshSnapshotConfig>[0], chain).config };
    expect(failures(launchParameterChecks(refreshed, await readLaunchParameters(refreshed)))).to.deep.equal([]);
  });

  it("fails a value the snapshot does not record instead of skipping it", async function () {
    const { snapshot } = await loadFixture(deployed);
    const reading = await readLaunchParameters(snapshot);
    const { minDebt: _a, underwaterDiscountPpm: _b, originationFeeBps: _c, reserveSpreadCurve: _d, badDebtPauseThreshold: _e, ...config } = snapshot.config;
    void [_a, _b, _c, _d, _e];
    const paxg = { ...(snapshot.config.paxg as Record<string, unknown>), stabilityFeeBps: undefined };
    const checks = launchParameterChecks({ ...snapshot, config: { ...config, paxg } }, reading);
    expect(failures(checks)).to.have.members([
      "param:vault.minDebt",
      "param:vault.underwaterDiscountPpm",
      "param:vault.originationFeeBps",
      "param:reserve.spreadCurve",
      "param:vault.badDebtPauseThreshold",
      "param:stabilityModule.paxg.stabilityFeeRate",
    ]);
    expect(failureOf(checks, "param:vault.minDebt")?.detail).to.match(/^the snapshot records no config\.minDebt; .*refresh-deployment-snapshot\.ts/);
  });

  it("fails an address whose runtime code differs from the recorded build, and a snapshot with no code hashes", async function () {
    const { snapshot } = await loadFixture(deployed);
    const reading: LaunchParameterReading = await readLaunchParameters(snapshot);
    const swapped = { ...snapshot, build: { ...snapshot.build, runtimeCodeHashes: { ...snapshot.build.runtimeCodeHashes, vault: snapshot.build.runtimeCodeHashes.oracle } } };
    expect(failures(launchParameterChecks(swapped, reading))).to.deep.equal(["code:vault.runtime-hash"]);
    const unbuilt = { addresses: snapshot.addresses, config: snapshot.config };
    expect(failures(launchParameterChecks(unbuilt, reading))).to.have.length(Object.keys(snapshot.addresses).length);
  });

  it("maps a stability fee to the contract's per-second rate and back", function () {
    for (const bps of [0n, 1n, 5n, 200n, 4_999n, 5_000n]) expect(stabilityFeeBpsOf(stabilityFeeRateOf(bps))).to.equal(bps);
    expect(stabilityFeeBpsOf(stabilityFeeRateOf(200n) + 1n)).to.equal(undefined);
    expect(stabilityFeeBpsOf(0n)).to.equal(undefined);
  });
});
