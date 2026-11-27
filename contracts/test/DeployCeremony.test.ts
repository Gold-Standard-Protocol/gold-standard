import { expect } from "chai";
import { artifacts, ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { TransactionResponse } from "ethers";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setValidPrice } from "./helpers/productionSystem";
import { parameterHash, parameterRecord, parseLaunchParameters } from "../scripts/lib/launchEnv";
import {
  CREATION_IDS,
  STABLECOIN_STEP,
  DeployConfig,
  DeployRefused,
  DeploymentSnapshot,
  ReadAt,
  WAIT_TIMEOUT_MINUTES,
  adoptReplacedCreation,
  ceremonyCreationTransactions,
  deployConfig,
  parseWaitTimeoutMinutes,
  pinnedRead,
  runDeployCeremony,
  waitTimeoutMessage,
} from "../scripts/lib/deployCeremony";
import {
  DeployJournal,
  deployFileGate,
  journalBindingProblems,
  newDeployJournal,
  parseDeployJournal,
  withCreation,
  withoutPending,
  writeSnapshot,
} from "../scripts/lib/deployJournal";
import { ceremonyFundsFindings, WIRING_TRANSACTIONS } from "../scripts/lib/preflight";
import { predictStablecoinAddress } from "../scripts/lib/stablecoinAddress";
import type { StablecoinAddressPlan } from "../scripts/lib/stablecoinAddress";

/**
 * scripts/deploy.ts journals every creation and wiring step and resumes from the journal
 *. These run the real ceremony on the Hardhat network, stop it part way in each
 * of the ways a mainnet run can stop, and resume it from the journal it left.
 */
describe("Deploy ceremony, journaled and resumable (scripts/lib/deployCeremony.ts)", function () {
  const NO_WAIT = { attempts: 2, delayMs: 0 };

  async function environment() {
    const [deployer, proposer, executor, guardian] = await ethers.getSigners();
    const MockToken = await ethers.getContractFactory("MockERC20");
    const MockAgg = await ethers.getContractFactory("MockAggregatorV3");
    const paxg = await MockToken.deploy("Pax Gold", "PAXG", 18);
    const xaut = await MockToken.deploy("Tether Gold", "XAUT", 6);
    const paxgFeed = await MockAgg.deploy(8);
    const anchorFeed = await MockAgg.deploy(8);
    await setValidPrice(paxgFeed, 200000000000n);
    await setValidPrice(anchorFeed, 200000000000n);
    // The mainnet profile: open caps, XAUT dormant on an InactiveFeed the ceremony creates.
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
    });
    if (!params) throw new Error(findings.map((f) => `${f.name}: ${f.detail}`).join("\n"));
    const cfg = deployConfig(params);
    const journal = newDeployJournal({
      network: "hardhat",
      chainId: 31337,
      deployer: deployer.address,
      parametersHash: parameterHash(parameterRecord(cfg)),
      startedAt: "2026-11-11T00:00:00.000Z",
      startBlock: await ethers.provider.getBlockNumber(),
    });
    return { deployer, guardian, cfg, journal };
  }

  type Env = Awaited<ReturnType<typeof environment>>;

  /** The journal as deploy.ts keeps it on disk: what the last save wrote, nothing more. */
  class Disk {
    text: string;
    constructor(journal: DeployJournal) {
      this.text = JSON.stringify(journal);
    }
    get journal(): DeployJournal {
      return parseDeployJournal(this.text);
    }
  }

  interface RunOptions {
    /** Throws before the transaction of this creation or step is sent. */
    stopBefore?: string;
    /** Throws instead of saving the first journal for which this returns true (a crash between a receipt and its record). */
    crashOnSave?: (journal: DeployJournal) => boolean;
    journal?: DeployJournal;
    /** How long each transaction is waited for; the ceremony's default when absent. */
    waitTimeoutMs?: number;
    /** The token's salt and the address it is meant to give. */
    stablecoin?: StablecoinAddressPlan;
    /** The chain id the ceremony is told it runs on; the Hardhat network's when absent. */
    chainId?: number;
  }

  /** One run of deploy.ts against `disk`. `sent` lists every creation and step that sent a transaction. */
  async function run(env: Env, disk: Disk, options: RunOptions = {}): Promise<{ snapshot?: DeploymentSnapshot; error?: unknown; sent: string[]; lines: string[] }> {
    const sent: string[] = [];
    const lines: string[] = [];
    try {
      const snapshot = await runDeployCeremony({
        cfg: env.cfg,
        chainId: options.chainId ?? 31337,
        networkName: "hardhat",
        deployer: env.deployer,
        journal: options.journal ?? disk.journal,
        save: (journal) => {
          if (options.crashOnSave?.(journal)) throw new Error("the process died before the journal was written");
          disk.text = JSON.stringify(journal);
        },
        log: (line) => lines.push(line),
        beforeSend: (id) => {
          if (id === options.stopBefore) throw new Error(`the gateway answered 502 before ${id}`);
          sent.push(id);
        },
        readRetry: NO_WAIT,
        waitTimeoutMs: options.waitTimeoutMs,
        stablecoin: options.stablecoin,
      });
      return { snapshot, sent, lines };
    } catch (error) {
      return { error, sent, lines };
    }
  }

  /** The snapshot of a run that finished; fails the test with the run's error otherwise. */
  function finished(result: { snapshot?: DeploymentSnapshot; error?: unknown }): DeploymentSnapshot {
    if (!result.snapshot) throw new Error(`the run did not finish: ${String(result.error)}`);
    return result.snapshot;
  }

  /** A value the test has just produced; fails the test when it is missing. */
  function present<T>(value: T | null | undefined, what: string): T {
    if (value === null || value === undefined) throw new Error(`${what} is missing`);
    return value;
  }

  const nonce = (env: Env): Promise<number> => ethers.provider.getTransactionCount(env.deployer.address);

  /** The wiring a finished ceremony leaves, read from the chain. */
  async function expectWired(env: Env, snapshot: DeploymentSnapshot): Promise<void> {
    const a = snapshot.addresses;
    const vault = await ethers.getContractAt("GoldVault", a.vault);
    const siloFactory = await ethers.getContractAt("SiloFactory", a.siloFactory);
    const pool = await ethers.getContractAt("StabilityPool", a.stabilityPool);
    const stablecoin = await ethers.getContractAt("GoldStablecoin", a.stablecoin);
    const oracle = await ethers.getContractAt("GoldOracle", a.oracle);
    expect(await vault.surplusBuffer()).to.equal(a.surplusBuffer);
    expect(await vault.stabilityReserve()).to.equal(a.reserve);
    expect(await vault.siloFactory()).to.equal(a.siloFactory);
    expect(await vault.vaultRegistry()).to.equal(a.vaultRegistry);
    expect(await vault.minDebt()).to.equal(env.cfg.minDebt);
    expect(await siloFactory.vaultRoleLocked()).to.equal(true);
    expect(await stablecoin.hasRole(await stablecoin.MINTER_ROLE(), a.vault)).to.equal(true);
    expect(await vault.hasRole(await vault.GUARDIAN_ROLE(), env.guardian.address)).to.equal(true);
    const paxgId = ethers.keccak256(ethers.solidityPacked(["address"], [env.cfg.paxgToken]));
    expect((await vault.collateralTypes(paxgId)).active).to.equal(true);
    expect(await pool.isCollateralToken(env.cfg.paxgToken)).to.equal(true);
    expect(await oracle.anchorFeed()).to.equal(env.cfg.anchorFeed);
    expect(await oracle.getLastKnownPrice(env.cfg.paxgToken)).to.not.equal(0n);
    for (const [name, address] of Object.entries(a)) expect(await ethers.provider.getCode(address), name).to.not.equal("0x");
  }

  it("journals every creation and every step of a ceremony that runs through", async function () {
    const env = await loadFixture(environment);
    const disk = new Disk(env.journal);
    const result = await run(env, disk);
    expect(result.error).to.equal(undefined);
    const snapshot = finished(result);
    const journal = disk.journal;
    expect(journal.pending).to.equal(undefined);
    expect(Object.keys(journal.creations)).to.have.members([...CREATION_IDS]);
    expect(journal.creations.vault.address).to.equal(snapshot.addresses.vault);
    expect(snapshot.deployBlock).to.equal(journal.creations.vault.block);
    expect(snapshot.creationBlocks.timelock).to.equal(journal.creations.governance.block);
    expect(Object.keys(journal.steps)).to.include.members(["siloFactory.lockVaultRole(vault)", "vault.addCollateralType(PAXG)", "oracle.seedLastKnownPrice(PAXG)"]);
    await expectWired(env, snapshot);
  });

  it("sends eleven creations and no more wiring transactions than the preflight budgets gas for", async function () {
    const env = await loadFixture(environment);
    const result = await run(env, new Disk(env.journal));
    expect(result.error).to.equal(undefined);
    const creations = result.sent.filter((id) => (CREATION_IDS as readonly string[]).includes(id));
    const wiring = result.sent.filter((id) => !(CREATION_IDS as readonly string[]).includes(id));
    expect(creations).to.have.length(11);
    // WIRING_TRANSACTIONS is what the preflight and deploy.ts multiply the per-transaction gas by: an upper bound, never less than what is sent.
    expect(BigInt(wiring.length)).to.be.at.most(WIRING_TRANSACTIONS);
    expect(WIRING_TRANSACTIONS).to.equal(35n);
  });

  describe("a transaction that is not mined in time (the wait timeout)", function () {
    afterEach(async function () {
      await ethers.provider.send("evm_setAutomine", [true]);
    });

    it("stops with the pending hash and nonce and how to resume, replaces nothing, and the resume carries on once it is mined", async function () {
      const env = await loadFixture(environment);
      const disk = new Disk(env.journal);
      const startNonce = await nonce(env);
      // The fee has risen above what the transaction pays: the network accepts it and does not mine it.
      await ethers.provider.send("evm_setAutomine", [false]);
      const first = await run(env, disk, { waitTimeoutMs: 150 });
      expect(first.error).to.be.instanceOf(DeployRefused);
      const pending = present(disk.journal.pending, "the pending transaction");
      expect(pending).to.include({ kind: "creation", id: "stablecoinDeployer", nonce: startNonce });
      const message = String(first.error);
      expect(message).to.include(pending.txHash);
      expect(message).to.include(`nonce ${startNonce}`);
      expect(message).to.include("DEPLOY_RESUME=1");
      expect(message).to.include("DEPLOY_REPLACED_CREATION");
      expect(message).to.include("never replaces a transaction by itself");
      // One transaction went out and nothing took its place.
      expect(first.sent).to.deep.equal(["stablecoinDeployer"]);
      expect(await ethers.provider.getTransactionCount(env.deployer.address, "pending")).to.equal(startNonce + 1);

      // A resume while it is still pending waits again and sends nothing.
      const second = await run(env, disk, { waitTimeoutMs: 150 });
      expect(second.error).to.be.instanceOf(DeployRefused);
      expect(second.sent).to.deep.equal([]);
      expect(present(disk.journal.pending, "the pending transaction").txHash).to.equal(pending.txHash);

      // The fee falls, the transaction is mined, and the resume adopts it.
      await ethers.provider.send("evm_mine", []);
      await ethers.provider.send("evm_setAutomine", [true]);
      const third = await run(env, disk);
      expect(third.error).to.equal(undefined);
      expect(third.sent).to.not.include("stablecoinDeployer");
      expect(disk.journal.creations.stablecoinDeployer.txHash).to.equal(pending.txHash);
      await expectWired(env, finished(third));
    });

    it("times out a wiring step the same way, and says a replaced step needs no flag", async function () {
      const env = await loadFixture(environment);
      const disk = new Disk(env.journal);
      const stepId = "vault.setSurplusBuffer";
      const first = await run(env, disk, { stopBefore: stepId });
      expect(String(first.error)).to.include("502");
      await ethers.provider.send("evm_setAutomine", [false]);
      const second = await run(env, disk, { waitTimeoutMs: 150 });
      expect(second.error).to.be.instanceOf(DeployRefused);
      const pending = present(disk.journal.pending, "the pending transaction");
      expect(pending).to.include({ kind: "step", id: stepId });
      expect(String(second.error)).to.include(pending.txHash);
      expect(String(second.error)).to.include("reads the setting from the chain");
      expect(String(second.error)).to.not.include("DEPLOY_REPLACED_CREATION");
      await ethers.provider.send("evm_mine", []);
      await ethers.provider.send("evm_setAutomine", [true]);
      const third = await run(env, disk);
      expect(third.error).to.equal(undefined);
      expect(third.sent).to.not.include(stepId);
      await expectWired(env, finished(third));
    });

    it("reads DEPLOY_WAIT_TIMEOUT_MINUTES as whole minutes from 1 to 1440 and refuses anything else", function () {
      expect(WAIT_TIMEOUT_MINUTES).to.equal(20);
      expect(parseWaitTimeoutMinutes(undefined)).to.equal(20);
      expect(parseWaitTimeoutMinutes(" 45 ")).to.equal(45);
      expect(parseWaitTimeoutMinutes("1440")).to.equal(1440);
      for (const bad of ["", "0", "1441", "-1", "2.5", "forever", "1e2"]) expect(() => parseWaitTimeoutMinutes(bad), bad).to.throw("DEPLOY_WAIT_TIMEOUT_MINUTES");
      expect(waitTimeoutMessage({ kind: "creation", id: "oracle", hashes: ["0xaa", "0xbb"], nonce: 3 }, 20 * 60_000)).to.include("transactions 0xaa, 0xbb (deployer nonce 3) were not mined within 20 minutes");
    });
  });

  describe("the token's address (GoldStablecoinDeployer, CREATE2)", function () {
    const SALT = "0x" + "5a".repeat(32);
    const initCodeHash = async (): Promise<string> => ethers.keccak256((await artifacts.readArtifact("GoldStablecoin")).bytecode);

    it("creates the deployer contract first and the token where the salt puts it, with the deployer as its only admin", async function () {
      const env = await loadFixture(environment);
      const startNonce = await nonce(env);
      const predicted = predictStablecoinAddress(env.deployer.address, startNonce, SALT, await initCodeHash());
      const disk = new Disk(env.journal);
      const result = await run(env, disk, { stablecoin: { salt: SALT, expected: predicted.token } });
      expect(result.error).to.equal(undefined);
      const snapshot = finished(result);
      expect(result.sent[0]).to.equal("stablecoinDeployer");
      expect(result.sent.filter((id) => id === STABLECOIN_STEP)).to.have.length(1);
      expect(snapshot.stablecoinDeployer).to.deep.equal({ address: predicted.deployerContract, salt: SALT });
      expect(disk.journal.creations.stablecoinDeployer.address).to.equal(predicted.deployerContract);
      expect(snapshot.addresses.stablecoin).to.equal(predicted.token);
      expect(snapshot.creationBlocks.stablecoin).to.equal(disk.journal.steps[STABLECOIN_STEP].block);
      expect(snapshot.build.runtimeCodeHashes.stablecoin).to.equal(ethers.keccak256(await ethers.provider.getCode(predicted.token)));
      const token = await ethers.getContractAt("GoldStablecoin", predicted.token);
      const admin = await token.DEFAULT_ADMIN_ROLE();
      expect(await token.getRoleMemberCount(admin)).to.equal(1n);
      expect(await token.getRoleMember(admin, 0)).to.equal(env.deployer.address);
      expect(await token.hasRole(admin, predicted.deployerContract)).to.equal(false);
      await expectWired(env, snapshot);
    });

    it("uses the zero salt and expects nothing when no address was asked for", async function () {
      const env = await loadFixture(environment);
      const predicted = predictStablecoinAddress(env.deployer.address, await nonce(env), ethers.ZeroHash, await initCodeHash());
      const snapshot = finished(await run(env, new Disk(env.journal)));
      expect(snapshot.addresses.stablecoin).to.equal(predicted.token);
      expect(snapshot.stablecoinDeployer.salt).to.equal(ethers.ZeroHash);
    });

    it("stops before the token exists when the salt does not give the expected address, and a corrected salt resumes", async function () {
      const env = await loadFixture(environment);
      const predicted = predictStablecoinAddress(env.deployer.address, await nonce(env), SALT, await initCodeHash());
      const disk = new Disk(env.journal);
      const wrong = await run(env, disk, { stablecoin: { salt: SALT, expected: env.guardian.address } });
      expect(wrong.error).to.be.instanceOf(DeployRefused);
      const message = String(wrong.error);
      expect(message).to.include(env.guardian.address);
      expect(message).to.include(predicted.token);
      expect(message).to.include(`cast create2 --deployer ${predicted.deployerContract} --init-code-hash ${await initCodeHash()}`);
      expect(message).to.include("DEPLOY_RESUME=1");
      expect(wrong.sent).to.not.include(STABLECOIN_STEP);
      const deployerContract = await ethers.getContractAt("GoldStablecoinDeployer", predicted.deployerContract);
      expect(await deployerContract.token()).to.equal(ethers.ZeroAddress);
      expect(await ethers.provider.getCode(predicted.token)).to.equal("0x");

      const resumed = await run(env, disk, { stablecoin: { salt: SALT, expected: predicted.token } });
      expect(resumed.error).to.equal(undefined);
      expect(resumed.sent).to.not.include("stablecoinDeployer");
      expect(resumed.sent.filter((id) => id === STABLECOIN_STEP)).to.have.length(1);
      expect(finished(resumed).addresses.stablecoin).to.equal(predicted.token);
    });

    it("does not create the token twice: a run stopped right after it resumes on the token it has", async function () {
      const env = await loadFixture(environment);
      const disk = new Disk(env.journal);
      const plan = { salt: SALT, expected: undefined };
      // The process dies after the token's transaction is mined and before the journal records it.
      const first = await run(env, disk, { stablecoin: plan, crashOnSave: (journal) => journal.steps[STABLECOIN_STEP]?.txHash !== undefined });
      expect(String(first.error)).to.include("died before the journal was written");
      expect(first.sent).to.include(STABLECOIN_STEP);
      const second = await run(env, disk, { stablecoin: plan });
      expect(second.error).to.equal(undefined);
      expect(second.sent).to.not.include(STABLECOIN_STEP);
      const snapshot = finished(second);
      const deployerContract = await ethers.getContractAt("GoldStablecoinDeployer", snapshot.stablecoinDeployer.address);
      expect(await deployerContract.token()).to.equal(snapshot.addresses.stablecoin);
      expect(snapshot.creationBlocks.stablecoin).to.equal(Number(await deployerContract.tokenBlock()));
      await expectWired(env, snapshot);
    });

    it("says the token already exists when a resume names another address for it", async function () {
      const env = await loadFixture(environment);
      const disk = new Disk(env.journal);
      const first = await run(env, disk, { stablecoin: { salt: SALT, expected: undefined }, stopBefore: "stabilityModule" });
      expect(String(first.error)).to.include("502");
      const created = await (await ethers.getContractAt("GoldStablecoinDeployer", disk.journal.creations.stablecoinDeployer.address)).token();
      const other = await run(env, disk, { stablecoin: { salt: ethers.ZeroHash, expected: env.guardian.address } });
      expect(other.error).to.be.instanceOf(DeployRefused);
      expect(String(other.error)).to.include(`has already created the token, at ${created}`);
      expect(String(other.error)).to.not.include("Find the salt again");
      expect(other.sent).to.deep.equal([]);
    });

    it("refuses a mainnet ceremony that names no address for the token, before anything is sent", async function () {
      const env = await loadFixture(environment);
      const startNonce = await nonce(env);
      for (const stablecoin of [undefined, { salt: SALT, expected: undefined }]) {
        const result = await run(env, new Disk(env.journal), { chainId: 1, stablecoin });
        expect(result.error).to.be.instanceOf(DeployRefused);
        expect(String(result.error)).to.include("GSUSD_SALT and GSUSD_ADDRESS");
        expect(result.sent).to.deep.equal([]);
      }
      expect(await nonce(env)).to.equal(startNonce);
    });

    it("runs a mainnet ceremony that names the token's address", async function () {
      const env = await loadFixture(environment);
      const predicted = predictStablecoinAddress(env.deployer.address, await nonce(env), SALT, await initCodeHash());
      const result = await run(env, new Disk(env.journal), { chainId: 1, stablecoin: { salt: SALT, expected: predicted.token } });
      expect(result.error).to.equal(undefined);
      expect(finished(result).addresses.stablecoin).to.equal(predicted.token);
    });

    it("refuses a journal that holds a creation this version does not make, such as a token created directly", async function () {
      const env = await loadFixture(environment);
      const startNonce = await nonce(env);
      const journal: DeployJournal = { ...env.journal, creations: { stablecoin: { address: env.guardian.address, txHash: "0x" + "ab".repeat(32), block: 1 } } };
      const result = await run(env, new Disk(journal));
      expect(result.error).to.be.instanceOf(DeployRefused);
      expect(String(result.error)).to.include("stablecoin").and.include("another version");
      expect(result.sent).to.deep.equal([]);
      expect(await nonce(env)).to.equal(startNonce);
    });

    it("refuses to go on with a token another salt created", async function () {
      const env = await loadFixture(environment);
      const disk = new Disk(env.journal);
      const first = await run(env, disk, { stablecoin: { salt: SALT, expected: undefined }, stopBefore: "stabilityModule" });
      expect(String(first.error)).to.include("502");
      const other = await run(env, disk, { stablecoin: { salt: ethers.ZeroHash, expected: undefined } });
      expect(other.error).to.be.instanceOf(DeployRefused);
      expect(String(other.error)).to.include("an earlier run used another salt");
      expect(other.sent).to.deep.equal([]);
    });
  });

  it("resumes a ceremony stopped mid-wiring: nothing is created twice and only the steps still owed are sent", async function () {
    const env = await loadFixture(environment);
    const disk = new Disk(env.journal);
    const first = await run(env, disk, { stopBefore: "vault.setStabilityReserve" });
    expect(String(first.error)).to.include("502");
    const stopped = disk.journal;
    expect(Object.keys(stopped.creations)).to.include.members(["stablecoinDeployer", "oracle", "vault", "governance"]);
    expect(Object.keys(stopped.steps)).to.include(STABLECOIN_STEP);
    const nonceAtStop = await nonce(env);

    const second = await run(env, disk);
    expect(second.error).to.equal(undefined);
    expect(second.sent[0]).to.equal("vault.setStabilityReserve");
    // Of the creations only the registry, which comes after the stop, is sent.
    expect(second.sent.filter((id) => (CREATION_IDS as readonly string[]).includes(id))).to.deep.equal(["vaultRegistry"]);
    expect(second.sent.some((id) => id.startsWith("stablecoin.grantRole") || id === "vault.setSurplusBuffer")).to.equal(false);
    // Every transaction of the resumed run is one the ceremony chose to send.
    expect((await nonce(env)) - nonceAtStop).to.equal(second.sent.length);
    for (const [id, entry] of Object.entries(stopped.creations)) {
      if (id !== "xautInactiveFeed" && id !== "stablecoinDeployer") expect(finished(second).addresses[id], id).to.equal(entry.address);
    }
    expect(finished(second).config.xautFeed).to.equal(stopped.creations.xautInactiveFeed.address);
    expect(finished(second).stablecoinDeployer.address).to.equal(stopped.creations.stablecoinDeployer.address);
    expect(second.sent).to.not.include(STABLECOIN_STEP);
    await expectWired(env, finished(second));
  });

  it("resumes a ceremony stopped between two creations, reusing the contracts already created", async function () {
    const env = await loadFixture(environment);
    const disk = new Disk(env.journal);
    expect(String((await run(env, disk, { stopBefore: "siloFactory" })).error)).to.include("502");
    const before = disk.journal.creations;
    const second = await run(env, disk);
    expect(second.error).to.equal(undefined);
    expect(second.sent[0]).to.equal("siloFactory");
    expect(finished(second).addresses.reserve).to.equal(before.reserve.address);
    expect(finished(second).addresses.oracle).to.equal(before.oracle.address);
    await expectWired(env, finished(second));
  });

  it("adopts a step that was mined but never recorded, instead of sending it again", async function () {
    const env = await loadFixture(environment);
    const disk = new Disk(env.journal);
    // addCollateralType cannot be sent twice ("Already exists"): a resend would fail the resume.
    const first = await run(env, disk, { crashOnSave: (j) => j.steps["vault.addCollateralType(PAXG)"] !== undefined });
    expect(String(first.error)).to.include("process died");
    expect(disk.journal.pending).to.deep.include({ kind: "step", id: "vault.addCollateralType(PAXG)" });

    const second = await run(env, disk);
    expect(second.error).to.equal(undefined);
    expect(second.sent).to.not.include("vault.addCollateralType(PAXG)");
    expect(second.lines.join("\n")).to.include("it landed in block");
    expect(disk.journal.steps["vault.addCollateralType(PAXG)"].txHash).to.match(/^0x[0-9a-f]{64}$/);
    await expectWired(env, finished(second));
  });

  it("adopts a contract whose creation was mined but never recorded, so no second copy is deployed", async function () {
    const env = await loadFixture(environment);
    const disk = new Disk(env.journal);
    const first = await run(env, disk, { crashOnSave: (j) => j.creations.governance !== undefined });
    expect(String(first.error)).to.include("process died");
    const pending = present(disk.journal.pending, "the pending transaction");
    const created = present(await ethers.provider.getTransactionReceipt(pending.txHash), "its receipt").contractAddress;

    const second = await run(env, disk);
    expect(second.error).to.equal(undefined);
    expect(second.sent).to.not.include("governance");
    expect(finished(second).addresses.governance).to.equal(created);
    await expectWired(env, finished(second));
  });

  describe("a resume on an endpoint behind the pending creation", function () {
    interface Lag {
      /** Calls for the hidden transaction answered with null before the endpoint catches up; Infinity never does. */
      unknownFor: number;
      /** The deployer's mined nonce the endpoint reports, when it is behind on that too. */
      deployerNonce?: number;
    }

    /** Runs `body` against an endpoint that does not know `hash` yet, as a load-balanced node one block behind answers. */
    async function behind<T>(hash: string, deployer: string, lag: Lag, body: () => Promise<T>): Promise<T> {
      const provider = ethers.provider;
      const { getTransaction, getTransactionReceipt, getTransactionCount } = provider;
      // Each getTransaction for the hash is one look at the endpoint; the receipt read after it agrees with it.
      let looks = 0;
      const unknown = (): boolean => looks <= lag.unknownFor;
      provider.getTransaction = async (h) => (h === hash && ++looks <= lag.unknownFor ? null : getTransaction.call(provider, h));
      provider.getTransactionReceipt = async (h) => (h === hash && unknown() ? null : getTransactionReceipt.call(provider, h));
      provider.getTransactionCount = async (address, blockTag) =>
        lag.deployerNonce !== undefined && typeof address === "string" && address.toLowerCase() === deployer.toLowerCase()
          ? lag.deployerNonce
          : getTransactionCount.call(provider, address, blockTag);
      try {
        return await body();
      } finally {
        // The stand-ins shadow the provider's prototype methods; deleting them restores those.
        for (const name of ["getTransaction", "getTransactionReceipt", "getTransactionCount"]) Reflect.deleteProperty(provider, name);
      }
    }

    /** A run that stopped after the governance creation was mined but before its receipt was recorded. */
    async function stoppedOnGovernance(env: Env, disk: Disk): Promise<{ hash: string; sentAt: number; created: string }> {
      const first = await run(env, disk, { crashOnSave: (j) => j.creations.governance !== undefined });
      expect(String(first.error)).to.include("process died");
      const pending = present(disk.journal.pending, "the pending transaction");
      const created = present(present(await ethers.provider.getTransactionReceipt(pending.txHash), "its receipt").contractAddress, "the created address");
      const sentAt = present(await ethers.provider.getTransaction(pending.txHash), "the pending transaction").nonce;
      return { hash: pending.txHash, sentAt, created };
    }

    it("waits for the endpoint to learn the transaction instead of creating the contract again", async function () {
      const env = await loadFixture(environment);
      const disk = new Disk(env.journal);
      const { hash, created } = await stoppedOnGovernance(env, disk);
      const second = await behind(hash, env.deployer.address, { unknownFor: 1 }, () => run(env, disk));
      expect(second.error).to.equal(undefined);
      expect(second.sent).to.not.include("governance");
      expect(finished(second).addresses.governance).to.equal(created);
    });

    it("sends a creation the endpoint never learns again at its own nonce, so the original and the copy cannot both land", async function () {
      const env = await loadFixture(environment);
      const disk = new Disk(env.journal);
      const { hash, sentAt, created } = await stoppedOnGovernance(env, disk);
      expect(disk.journal.pending).to.deep.include({ kind: "creation", id: "governance", txHash: hash, nonce: sentAt });
      // The endpoint is behind on the nonce too: the creation looks never mined. The resend at
      // the same nonce is refused, and the journal still holds the original's hash.
      const second = await behind(hash, env.deployer.address, { unknownFor: Infinity, deployerNonce: sentAt }, () => run(env, disk));
      expect(String(second.error)).to.match(/nonce/i);
      expect(second.sent.filter((id) => (CREATION_IDS as readonly string[]).includes(id))).to.deep.equal(["governance"]);
      expect(present(disk.journal.pending, "the pending transaction").txHash).to.equal(hash);
      // Once the endpoint catches up, the original is adopted and nothing is created twice.
      const third = await run(env, disk);
      expect(third.error).to.equal(undefined);
      expect(third.sent).to.not.include("governance");
      expect(finished(third).addresses.governance).to.equal(created);
      await expectWired(env, finished(third));
    });

    /** The hash of a copy the endpoint accepted but that can never be mined: the original took its nonce. */
    const COPY_HASH = ethers.id("the copy of the governance creation");

    /**
     * Runs `body` with an endpoint that accepts the copy of `original` sent at its nonce without
     * mining it, as a node whose mempool never saw the original does; `accepted` runs when it has.
     */
    async function acceptingCopy<T>(env: Env, original: TransactionResponse, accepted: () => void, body: () => Promise<T>): Promise<T> {
      const signer = env.deployer;
      const { sendTransaction } = signer;
      signer.sendTransaction = async (tx) => {
        if (tx.nonce !== original.nonce) return sendTransaction.call(signer, tx);
        accepted();
        return new TransactionResponse({ ...original, hash: COPY_HASH, blockNumber: null, blockHash: null }, ethers.provider);
      };
      try {
        return await body();
      } finally {
        Reflect.deleteProperty(signer, "sendTransaction");
      }
    }

    it("stops waiting on an accepted copy once the nonce is spent, and the next resume adopts the original", async function () {
      const env = await loadFixture(environment);
      const disk = new Disk(env.journal);
      const { hash, created } = await stoppedOnGovernance(env, disk);
      const original = present(await ethers.provider.getTransaction(hash), "the original");
      // The endpoint knows neither the original nor its nonce, accepts the copy, then shows the nonce spent.
      const lag: Lag = { unknownFor: Infinity, deployerNonce: original.nonce };
      const second = await behind(hash, env.deployer.address, lag, () => acceptingCopy(env, original, () => (lag.deployerNonce = undefined), () => run(env, disk)));
      expect(second.error).to.be.instanceOf(DeployRefused);
      expect(String(second.error)).to.include(`nonce ${original.nonce} is spent`);
      const pending = present(disk.journal.pending, "the pending transaction");
      expect(pending).to.deep.include({ kind: "creation", id: "governance", txHash: COPY_HASH, nonce: original.nonce });
      expect(pending.earlier).to.deep.equal([hash]);

      const third = await run(env, disk);
      expect(third.error).to.equal(undefined);
      expect(third.sent).to.not.include("governance");
      expect(finished(third).addresses.governance).to.equal(created);
      expect(disk.journal.creations.governance.txHash).to.equal(hash);
      await expectWired(env, finished(third));
    });

    it("adopts the original when the endpoint learns it while the run waits on an accepted copy", async function () {
      const env = await loadFixture(environment);
      const disk = new Disk(env.journal);
      const { hash, created } = await stoppedOnGovernance(env, disk);
      const original = present(await ethers.provider.getTransaction(hash), "the original");
      const lag: Lag = { unknownFor: Infinity, deployerNonce: original.nonce };
      // The endpoint catches up just after it accepts the copy.
      const caughtUp = (): void => {
        lag.unknownFor = 0;
        lag.deployerNonce = undefined;
      };
      const second = await behind(hash, env.deployer.address, lag, () => acceptingCopy(env, original, caughtUp, () => run(env, disk)));
      expect(second.error).to.equal(undefined);
      expect(second.sent.filter((id) => (CREATION_IDS as readonly string[]).includes(id))).to.deep.equal(["governance", "vaultRegistry"]);
      expect(finished(second).addresses.governance).to.equal(created);
      expect(disk.journal.creations.governance.txHash).to.equal(hash);
      await expectWired(env, finished(second));
    });

    it("refuses a creation the network does not show at a nonce the chain shows as spent, naming the address that nonce created", async function () {
      const env = await loadFixture(environment);
      const disk = new Disk(env.journal);
      const { hash, created } = await stoppedOnGovernance(env, disk);
      const before = await nonce(env);
      const second = await behind(hash, env.deployer.address, { unknownFor: Infinity }, () => run(env, disk));
      expect(second.error).to.be.instanceOf(DeployRefused);
      expect(String(second.error)).to.include(created);
      expect(second.sent).to.deep.equal([]);
      expect(await nonce(env)).to.equal(before);
      expect(present(disk.journal.pending, "the pending transaction").txHash).to.equal(hash);
    });
  });

  describe("a creation replaced by hand (DEPLOY_REPLACED_CREATION)", function () {
    /** The hash the journal waits on: the creation as first sent, which the network dropped when its replacement was mined. */
    const DROPPED = ethers.id("the governance creation as first sent");

    /**
     * A ceremony stopped waiting on the governance creation, which the operator then replaced
     * from a wallet: the chain holds `replacement` at the creation's nonce and knows nothing of
     * the hash in the journal.
     */
    async function replacedByHand(env: Env, disk: Disk): Promise<{ replacement: string; created: string; sentAt: number }> {
      const first = await run(env, disk, { crashOnSave: (j) => j.creations.governance !== undefined });
      expect(String(first.error)).to.include("process died");
      const pending = present(disk.journal.pending, "the pending transaction");
      const replacement = pending.txHash;
      const created = present(present(await ethers.provider.getTransactionReceipt(replacement), "its receipt").contractAddress, "the created address");
      disk.text = JSON.stringify({ ...disk.journal, pending: { ...pending, txHash: DROPPED } });
      return { replacement, created, sentAt: present(pending.nonce, "the pending nonce") };
    }

    it("refuses the resume without the flag, then adopts the replacement the chain confirms and finishes", async function () {
      const env = await loadFixture(environment);
      const disk = new Disk(env.journal);
      const { replacement, created } = await replacedByHand(env, disk);
      const before = await nonce(env);
      const refused = await run(env, disk);
      expect(refused.error).to.be.instanceOf(DeployRefused);
      expect(String(refused.error)).to.include("DEPLOY_REPLACED_CREATION");
      expect(refused.sent).to.deep.equal([]);

      const adopted = await adoptReplacedCreation(ethers.provider, disk.journal, replacement);
      expect(present(adopted.pending, "the pending transaction")).to.deep.include({ txHash: DROPPED, earlier: [replacement] });
      // Naming it twice changes nothing.
      expect(await adoptReplacedCreation(ethers.provider, adopted, replacement)).to.deep.equal(adopted);
      disk.text = JSON.stringify(adopted);

      const resumed = await run(env, disk);
      expect(resumed.error).to.equal(undefined);
      expect(resumed.sent).to.not.include("governance");
      expect(finished(resumed).addresses.governance).to.equal(created);
      expect(disk.journal.creations.governance.txHash).to.equal(replacement);
      // The governance creation was never sent twice: every nonce after it went to what was still owed.
      expect(await nonce(env)).to.equal(before + resumed.sent.length);
      await expectWired(env, finished(resumed));
    });

    it("refuses a hash the chain does not confirm in every part: sender, nonce, a creation, the same data, mined", async function () {
      const env = await loadFixture(environment);
      const disk = new Disk(env.journal);
      const { replacement, sentAt } = await replacedByHand(env, disk);
      const journal = disk.journal;
      const refusal = async (hash: string, from: DeployJournal = journal): Promise<string> => {
        try {
          await adoptReplacedCreation(ethers.provider, from, hash);
        } catch (error) {
          expect(error).to.be.instanceOf(DeployRefused);
          return String(error);
        }
        throw new Error(`${hash} was adopted`);
      };

      expect(await refusal("0x1234")).to.include("not a transaction hash");
      expect(await refusal(ethers.id("never sent"))).to.include("does not know this transaction");

      // Another sender's creation of the very same contract.
      const [, , , , stranger] = await ethers.getSigners();
      const original = present(await ethers.provider.getTransaction(replacement), "the replacement");
      const strangers = await stranger.sendTransaction({ data: original.data });
      await strangers.wait();
      expect(await refusal(strangers.hash)).to.include(`sent by ${stranger.address}, not by the deployer`);

      // The deployer's own earlier creation: another nonce and other data.
      const oracleCreation = journal.creations.oracle.txHash;
      const other = await refusal(oracleCreation);
      expect(other).to.include(`${journal.pending?.id} was sent at nonce ${sentAt}`);
      expect(other).to.include("creation data differs");

      // A call, not a creation.
      const call = await env.deployer.sendTransaction({ to: stranger.address, value: 1n });
      await call.wait();
      expect(await refusal(call.hash)).to.include("not a contract creation");

      // Right in every part but not mined yet.
      const provider = ethers.provider;
      const { getTransactionReceipt } = provider;
      provider.getTransactionReceipt = async (h) => (h === replacement ? null : getTransactionReceipt.call(provider, h));
      try {
        expect(await refusal(replacement)).to.include("not mined yet");
      } finally {
        Reflect.deleteProperty(provider, "getTransactionReceipt");
      }
      // Every refusal left the journal as it was.
      expect(disk.journal).to.deep.equal(journal);
    });

    it("refuses when the journal is not waiting on a creation", async function () {
      const env = await loadFixture(environment);
      const disk = new Disk(env.journal);
      const done = await run(env, disk, { stopBefore: "vault.setSurplusBuffer" });
      expect(String(done.error)).to.include("502");
      const hash = disk.journal.creations.oracle.txHash;
      await expect(adoptReplacedCreation(ethers.provider, disk.journal, hash)).to.be.rejectedWith(DeployRefused, "not waiting on any transaction");
      const onStep = { ...disk.journal, pending: { kind: "step" as const, id: "vault.setSurplusBuffer", txHash: hash, nonce: 1 } };
      await expect(adoptReplacedCreation(ethers.provider, onStep, hash)).to.be.rejectedWith(DeployRefused, "a replaced step needs no flag");
    });
  });

  it("finds a step in place on chain when the journal lost even the transaction's hash", async function () {
    const env = await loadFixture(environment);
    const disk = new Disk(env.journal);
    await run(env, disk, { crashOnSave: (j) => j.steps["siloFactory.lockVaultRole(vault)"] !== undefined });
    // The lock landed; the journal knows nothing about it.
    const second = await run(env, disk, { journal: withoutPending(disk.journal) });
    expect(second.error).to.equal(undefined);
    expect(second.sent).to.not.include("siloFactory.lockVaultRole(vault)");
    expect(second.lines).to.include("  siloFactory.lockVaultRole(vault): already in place on chain");
    expect(disk.journal.steps["siloFactory.lockVaultRole(vault)"]).to.deep.equal({});
  });

  it("refuses a journal the chain contradicts and sends nothing", async function () {
    const env = await loadFixture(environment);
    const disk = new Disk(env.journal);
    await run(env, disk, { stopBefore: "vault.setSurplusBuffer" });
    const stopped = disk.journal;
    // A vault address whose creation receipt names another contract (an edited file, another chain).
    const tampered = withCreation(stopped, "vault", { ...stopped.creations.vault, address: stopped.creations.oracle.address });
    const before = await nonce(env);
    const second = await run(env, disk, { journal: tampered });
    expect(second.error).to.be.instanceOf(DeployRefused);
    expect(String(second.error)).to.include("places vault");
    expect(second.sent).to.deep.equal([]);
    expect(await nonce(env)).to.equal(before);
  });

  it("refuses a journal step whose transaction the chain shows as another sender's", async function () {
    const env = await loadFixture(environment);
    const disk = new Disk(env.journal);
    await run(env, disk, { stopBefore: "vault.setSurplusBuffer" });
    const stopped = disk.journal;
    const stranger = await env.guardian.sendTransaction({ to: env.guardian.address, value: 0n });
    const tampered = { ...stopped, steps: { ...stopped.steps, "stablecoin.grantRole(MINTER_ROLE, vault)": { txHash: stranger.hash, block: present(await stranger.wait(), "the stranger's receipt").blockNumber } } };
    const second = await run(env, disk, { journal: tampered });
    expect(second.error).to.be.instanceOf(DeployRefused);
    expect(String(second.error)).to.include(`sent by ${env.guardian.address}`);
    expect(second.sent).to.deep.equal([]);
  });

  describe("pinned reads", function () {
    it("reads at the pinned block and retries while the endpoint is behind it", async function () {
      const tags: number[] = [];
      let calls = 0;
      const value = await pinnedRead(
        async (at: ReadAt) => {
          tags.push(at.blockTag);
          if (++calls < 3) throw new Error("header not found");
          return "0xtimelock";
        },
        { blockTag: 1234 },
        { attempts: 3, delayMs: 0 },
        "getTimelockAddress"
      );
      expect(value).to.equal("0xtimelock");
      expect(tags).to.deep.equal([1234, 1234, 1234]);
    });

    it("refuses once the retries are spent, naming the read and the block", async function () {
      const read = pinnedRead(async () => Promise.reject(new Error("header not found")), { blockTag: 99 }, { attempts: 2, delayMs: 0 }, "vault.minDebt");
      await expect(read).to.be.rejectedWith(DeployRefused, /vault\.minDebt: the read at block 99 failed 2 times/);
    });
  });

  describe("the journal file and the gates around it (scripts/lib/deployJournal.ts)", function () {
    const binding = { chainId: 1, deployer: "0x00000000000000000000000000000000000000aa", parametersHash: "0x01" };
    const journal = newDeployJournal({ ...binding, network: "mainnet", startedAt: "2026-11-11T00:00:00.000Z", startBlock: 100 });

    it("binds a journal to its chain, its deployer and its parameters", function () {
      expect(journalBindingProblems(journal, binding)).to.deep.equal([]);
      expect(journalBindingProblems(journal, { ...binding, deployer: binding.deployer.toUpperCase().replace("0X", "0x") })).to.deep.equal([]);
      expect(journalBindingProblems(journal, { ...binding, chainId: 31337 })[0]).to.include("chain 1");
      expect(journalBindingProblems(journal, { ...binding, parametersHash: "0x02" })[0]).to.include("parameters hash");
    });

    it("round-trips and refuses a malformed journal", function () {
      expect(parseDeployJournal(JSON.stringify(journal))).to.deep.equal(journal);
      expect(() => parseDeployJournal(JSON.stringify({ ...journal, schema: "other" }))).to.throw("schema");
      expect(() => parseDeployJournal(JSON.stringify({ ...journal, creations: { vault: { address: "0x1" } } }))).to.throw("vault");
      expect(() => parseDeployJournal(JSON.stringify({ ...journal, pending: { kind: "other", id: "x", txHash: "0x" } }))).to.throw("pending");
      const resent = { ...journal, pending: { kind: "creation", id: "vault", txHash: "0x2", nonce: 7, earlier: ["0x1"] } };
      expect(parseDeployJournal(JSON.stringify(resent))).to.deep.equal(resent);
      expect(() => parseDeployJournal(JSON.stringify({ ...resent, pending: { ...resent.pending, earlier: "0x1" } }))).to.throw("pending");
    });

    it("on mainnet refuses to replace the address book or to start over a stopped ceremony without the operator's word", function () {
      const base = { mandatory: true, snapshotExists: false, allowExistingSnapshot: false, journalExists: false, resume: false };
      expect(deployFileGate(base)).to.deep.equal({ start: "fresh", problems: [] });
      expect(deployFileGate({ ...base, snapshotExists: true }).problems[0]).to.include("already exists");
      expect(deployFileGate({ ...base, snapshotExists: true, allowExistingSnapshot: true }).problems).to.deep.equal([]);
      expect(deployFileGate({ ...base, journalExists: true }).problems[0]).to.include("DEPLOY_RESUME=1");
      expect(deployFileGate({ ...base, journalExists: true, resume: true })).to.deep.equal({ start: "resume", problems: [] });
      expect(deployFileGate({ ...base, resume: true }).problems[0]).to.include("no deployments/<network>.inprogress.json");
    });

    it("elsewhere replaces a snapshot and a journal from an earlier run unless asked to resume", function () {
      const base = { mandatory: false, snapshotExists: true, allowExistingSnapshot: false, journalExists: true, resume: false };
      expect(deployFileGate(base)).to.deep.equal({ start: "fresh-discarding-journal", problems: [] });
      expect(deployFileGate({ ...base, resume: true })).to.deep.equal({ start: "resume", problems: [] });
    });

    it("keeps a dated copy of a snapshot it replaces and writes through a rename", function () {
      const dir = mkdtempSync(join(tmpdir(), "deploy-journal-"));
      const file = join(dir, "mainnet.json");
      writeFileSync(file, "old");
      const kept = writeSnapshot(file, "new", true, new Date("2026-11-11T09:30:00.000Z"));
      expect(kept).to.equal(join(dir, "mainnet.replaced-2026-11-11T09-30-00-000Z.json"));
      expect(readFileSync(present(kept, "the kept copy"), "utf8")).to.equal("old");
      expect(readFileSync(file, "utf8")).to.equal("new");
      expect(writeSnapshot(file, "newer", false)).to.equal(undefined);
      expect(readdirSync(dir).sort()).to.deep.equal(["mainnet.json", "mainnet.replaced-2026-11-11T09-30-00-000Z.json"]);
    });
  });

  describe("the balance check deploy.ts repeats before its first transaction", function () {
    it("fails for a deployer that cannot pay for what is still owed at the current fee, and passes for one that can", async function () {
      const env = await loadFixture(environment);
      const creations = await ceremonyCreationTransactions(env.cfg as DeployConfig);
      // Every creation, and a plain creation of the token standing in for the call that creates it.
      expect(creations).to.have.length(CREATION_IDS.length + 1);
      const empty = ethers.Wallet.createRandom().address;
      const short = await ceremonyFundsFindings(ethers.provider, empty, creations, WIRING_TRANSACTIONS);
      expect(short.find((f) => f.name === "deployer:balance")?.verdict).to.equal("fail");
      const funded = await ceremonyFundsFindings(ethers.provider, env.deployer.address, creations, WIRING_TRANSACTIONS);
      expect(funded.find((f) => f.name === "deployer:balance")?.verdict).to.equal("pass");
    });

    it("estimates only the creations a resumed run still owes", async function () {
      const env = await loadFixture(environment);
      const owed = await ceremonyCreationTransactions(env.cfg, new Set(["xautInactiveFeed", "oracle", STABLECOIN_STEP]));
      expect(owed).to.have.length(CREATION_IDS.length - 2);
      // While the step that creates the token is still owed, its stand-in is counted.
      expect(await ceremonyCreationTransactions(env.cfg, new Set(["xautInactiveFeed", "oracle"]))).to.have.length(CREATION_IDS.length - 1);
    });
  });
});
