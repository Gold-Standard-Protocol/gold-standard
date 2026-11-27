import { artifacts, ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";
import {
  LaunchParameters,
  mainnetLaunchProblems,
  parameterHash,
  parameterRecord,
  parseLaunchParameters,
  parsePreflightMaxAgeMinutes,
  parsePreflightRecord,
  preflightGateProblems,
  preflightRecordName,
} from "./lib/launchEnv";
import { formatFindings, hasFailures } from "./lib/findings";
import { isInactiveFeed, readPythFeed, readTwapFeed } from "./lib/marketFeeds";
import { describeError } from "./lib/redact";
import {
  DeployConfig,
  DeploymentSnapshot,
  adoptReplacedCreation,
  ceremonyCreationTransactions,
  deployConfig,
  parseWaitTimeoutMinutes,
  runDeployCeremony,
} from "./lib/deployCeremony";
import {
  DeployJournal,
  deployFileGate,
  deployJournalName,
  journalBindingProblems,
  newDeployJournal,
  parseDeployJournal,
  writeFileAtomic,
  writeSnapshot,
} from "./lib/deployJournal";
import { keyReminderLines } from "./lib/keyHygiene";
import { WIRING_TRANSACTIONS, ceremonyFundsFindings, readSafeRecords } from "./lib/preflight";
import { parseStablecoinAddressEnv, stablecoinAddressFindings } from "./lib/stablecoinAddress";

/**
 * Full-system deployment for the gold-backed stablecoin vault.
 *
 * Deployment order is important: dependencies must exist before dependents reference them.
 * After deploying, governance wiring grants roles and transfers admin power to the timelock.
 *
 * The environment is read by lib/launchEnv.ts, the same parser scripts/preflight-mainnet.ts
 * uses: every knob (tokens, feeds, Safes, ratios, caps, fees, floors) is trimmed, refused
 * when empty and bounded by the contracts' own limits, and the effective set is printed as
 * the ceremony record. On mainnet (or with REQUIRE_PREFLIGHT_RECORD=1) the deploy refuses to
 * run unless deployments/<network>.preflight.json exists and its parameters hash matches
 * what this script parsed; wherever the record exists it is checked.
 *
 * The ceremony itself (creations, wiring, registration, the snapshot) is lib/deployCeremony.ts.
 * It journals every creation and wiring step to deployments/<network>.inprogress.json as it
 * goes, so a run that stops part way (a gateway error, a fee spike, the deployer running dry)
 * keeps its address book. Run the same command again with DEPLOY_RESUME=1: every journaled entry
 * is verified against the chain and only what is still owed is sent. On mainnet (or with
 * REQUIRE_PREFLIGHT_RECORD=1) the deploy also refuses to start over a journal without that flag,
 * refuses to replace deployments/<network>.json without PREFLIGHT_ALLOW_EXISTING_SNAPSHOT=1 (and
 * then keeps a dated copy), starts a fresh ceremony only at the deployer nonce the preflight
 * recorded and within 60 minutes of chain time of it (PREFLIGHT_MAX_AGE_MINUTES), refuses when a
 * Safe's threshold or owners differ from what the preflight recorded (on a resume too), and
 * refuses to start when the deployer cannot pay for what is still owed at the fee quoted now.
 *
 * A transaction that is not mined within 20 minutes (DEPLOY_WAIT_TIMEOUT_MINUTES) stops the run
 * with its hash and nonce printed; the journal keeps it and DEPLOY_RESUME=1 waits for it again.
 * The ceremony never replaces a transaction by itself. A creation replaced by hand from a wallet
 * (same nonce, same creation data, a higher fee) is adopted with
 * DEPLOY_RESUME=1 DEPLOY_REPLACED_CREATION=<hash>, once it is mined and after it is checked
 * against the chain. docs/MAINNET.md section 3.3 is the operator's account of all this.
 *
 * Outputs:
 *   deployments/<network>.json - full address book + config snapshot,
 *                                consumed by scripts/verify-deployment.ts
 */

export type { LaunchCaps } from "./lib/launchEnv";

const DEPLOYMENTS = path.resolve(__dirname, "..", "deployments");

function loadConfig(): DeployConfig {
  const { params, findings } = parseLaunchParameters(process.env);
  if (!params) {
    console.error(formatFindings(findings));
    throw new Error("The environment is not usable; fix the FAIL lines above.");
  }
  return deployConfig(params);
}

/**
 * The gate between the preflight and the ceremony: the record must exist on mainnet and must match
 * wherever it exists. The chain's clock and the three Safes are read here, now, so a record that
 * has aged past its limit or a Safe that changed since the preflight stops the deploy before its
 * first transaction.
 */
async function assertPreflightRecord(
  cfg: LaunchParameters,
  gate: { networkName: string; chainId: number; deployer: string; deployerNonce: number; mandatory: boolean; resuming: boolean }
): Promise<void> {
  const recordPath = path.join(DEPLOYMENTS, preflightRecordName(gate.networkName));
  const record = fs.existsSync(recordPath) ? parsePreflightRecord(fs.readFileSync(recordPath, "utf8")) : undefined;
  const maxAgeMinutes = parsePreflightMaxAgeMinutes(process.env.PREFLIGHT_MAX_AGE_MINUTES);
  if (record === undefined) {
    const problems = preflightGateProblems({ ...gate, record, params: cfg, chainTime: 0, maxAgeMinutes, safes: [] });
    if (problems.length > 0) throw new Error(`Refusing to deploy:\n  - ${problems.join("\n  - ")}`);
    console.log("No preflight record for this network; proceeding without one (not permitted on mainnet).");
    return;
  }
  const head = await ethers.provider.getBlock("latest");
  if (!head) throw new Error("Refusing to deploy: the endpoint returned no latest block, so the preflight record's age cannot be measured.");
  const safes = await readSafeRecords(ethers.provider, cfg);
  const problems = preflightGateProblems({ ...gate, record, params: cfg, chainTime: head.timestamp, maxAgeMinutes, safes });
  if (problems.length > 0) throw new Error(`Refusing to deploy:\n  - ${problems.join("\n  - ")}`);
  console.log(`Preflight record ${recordPath} matches (parameters hash ${record.parametersHash}).`);
  if (record.chainTime !== undefined) {
    console.log(`  written ${Math.floor((head.timestamp - record.chainTime) / 60)} minutes ago by the chain's clock (limit ${maxAgeMinutes}); the Safes' thresholds and owners are unchanged.`);
  }
}

/**
 * On-chain probes of the mainnet feed set: Chainlink only, so no Pyth or Uniswap TWAP adapter
 * anywhere (neither is in the production path). The preflight makes the same checks with more
 * detail; these keep the deploy safe even if its record were stale.
 */
async function productionFeedProblems(cfg: LaunchParameters): Promise<string[]> {
  const problems: string[] = [];
  const configured: Array<[string, string]> = [
    ["PAXG_FEED", cfg.paxgFeed],
    ["XAUT_FEED", cfg.xautFeed],
    ["XAU_USD_ANCHOR_FEED", cfg.anchorFeed],
  ];
  for (const [key, address] of configured) {
    if (address === "") continue;
    if (await readPythFeed(ethers.provider, address)) problems.push(`${key} is a PythMarketFeed; Pyth is outside the production path`);
    if (await readTwapFeed(ethers.provider, address)) problems.push(`${key} is a UniswapV3TwapFeed; pool prices are outside the production path`);
  }
  if (cfg.xautFeed !== "" && !(await isInactiveFeed(ethers.provider, cfg.xautFeed))) {
    problems.push("XAUT_FEED is set but is not an InactiveFeed; leave it unset and deploy.ts creates one");
  }
  return problems;
}

/** The journal a stopped run left, or undefined. */
function readJournal(file: string): DeployJournal | undefined {
  return fs.existsSync(file) ? parseDeployJournal(fs.readFileSync(file, "utf8")) : undefined;
}

/**
 * The deployer's balance against what is still owed, at the fee quoted now (the
 * preflight's estimate may be days old). A refusal on a mandatory network, a warning elsewhere.
 */
async function assertFunds(cfg: LaunchParameters, deployer: string, journal: DeployJournal | undefined, mandatory: boolean): Promise<void> {
  // Creations and steps share the set: the token's creation is a step, and its stand-in estimate is owed until it is done.
  const created = new Set([...Object.keys(journal?.creations ?? {}), ...Object.keys(journal?.steps ?? {})]);
  const stepsDone = BigInt(Object.keys(journal?.steps ?? {}).length);
  const wiringOwed = WIRING_TRANSACTIONS > stepsDone ? WIRING_TRANSACTIONS - stepsDone : 0n;
  const findings = await ceremonyFundsFindings(ethers.provider, deployer, await ceremonyCreationTransactions(cfg, created), wiringOwed);
  console.log(formatFindings(findings));
  if (hasFailures(findings)) {
    if (mandatory) throw new Error("Refusing to deploy: the deployer cannot pay for the ceremony at the current fee. Fund it and run again.");
    console.log("WARNING: the deployer may run dry part way; the journal lets the run resume once it is funded.");
  }
}

async function main() {
  const cfg = loadConfig();
  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);
  const profileText: Record<typeof cfg.launchCaps, string> = {
    backstop: `Launch caps: BACKSTOP, for forks and local rehearsals only and refused on mainnet (PAXG under a ${ethers.formatEther(cfg.paxg.debtCeiling)} GSUSD ceiling; XAUT registered in the oracle and otherwise dormant)`,
    open: "Launch caps: OPEN, the mainnet launch (no PAXG debt ceiling, no per-block mint cap; XAUT registered in the oracle and otherwise dormant)",
    guarded: "Launch caps: guarded (both tokens active, ceilings zero, raised through the timelock; testnets only)",
  };
  console.log(profileText[cfg.launchCaps]);

  const network = await ethers.provider.getNetwork();
  const chainId = Number(network.chainId);
  const mandatory = chainId === 1 || process.env.REQUIRE_PREFLIGHT_RECORD === "1";
  const record = parameterRecord(cfg);
  const parametersHash = parameterHash(record);
  console.log("\n--- Effective parameters (ceremony record) ---");
  for (const [key, value] of Object.entries(record)) console.log(`  ${key}=${value}`);
  console.log(`  parameters hash ${parametersHash}`);

  // The address book and the journal of a stopped run.
  fs.mkdirSync(DEPLOYMENTS, { recursive: true });
  const outFile = path.join(DEPLOYMENTS, `${network.name}.json`);
  const journalFile = path.join(DEPLOYMENTS, deployJournalName(network.name));
  const snapshotExists = fs.existsSync(outFile);
  const allowExistingSnapshot = process.env.PREFLIGHT_ALLOW_EXISTING_SNAPSHOT === "1";
  const files = deployFileGate({
    mandatory,
    snapshotExists,
    allowExistingSnapshot,
    journalExists: fs.existsSync(journalFile),
    resume: process.env.DEPLOY_RESUME === "1",
  });
  if (files.problems.length > 0) throw new Error(`Refusing to deploy:\n  - ${files.problems.join("\n  - ")}`);
  const waitTimeoutMs = parseWaitTimeoutMinutes(process.env.DEPLOY_WAIT_TIMEOUT_MINUTES) * 60_000;
  const replacedCreation = process.env.DEPLOY_REPLACED_CREATION?.trim();
  if (replacedCreation !== undefined && files.start !== "resume") {
    throw new Error("Refusing to deploy: DEPLOY_REPLACED_CREATION names a transaction for a stopped ceremony to adopt, so it needs DEPLOY_RESUME=1 and the journal of that ceremony.");
  }
  let stopped = files.start === "resume" ? readJournal(journalFile) : undefined;
  if (stopped) {
    const binding = journalBindingProblems(stopped, { chainId, deployer: deployer.address, parametersHash });
    if (binding.length > 0) throw new Error(`Refusing to resume:\n  - ${binding.join("\n  - ")}`);
    console.log(`\nResuming the ceremony journaled in ${journalFile}.`);
    if (replacedCreation !== undefined) {
      // Validated against the chain (same sender, same nonce, a contract creation with the same
      // data, mined) before the journal takes it; a refusal leaves the journal as it was.
      stopped = await adoptReplacedCreation(ethers.provider, stopped, replacedCreation);
      writeFileAtomic(journalFile, `${JSON.stringify(stopped, null, 2)}\n`);
      console.log(`The journal now lists ${replacedCreation} as a replacement of ${stopped.pending?.id ?? "the pending creation"}; the resume adopts whichever was mined.`);
    }
  } else if (files.start === "fresh-discarding-journal") {
    console.log(`\nWARNING: ${journalFile} from an earlier run is replaced (set DEPLOY_RESUME=1 to resume it instead).`);
  }

  await assertPreflightRecord(cfg, {
    networkName: network.name,
    chainId,
    deployer: deployer.address,
    deployerNonce: await ethers.provider.getTransactionCount(deployer.address),
    mandatory,
    resuming: stopped !== undefined,
  });

  // Hard gate: a mainnet deploy without the anchor feed
  // ships with the oracle's cross-feed consistency check fully disabled. A
  // console warning is not enough for a ceremony; abort instead.
  if (chainId === 1 && (!cfg.anchorFeed || cfg.anchorFeed === ethers.ZeroAddress)) {
    throw new Error(
      "XAU_USD_ANCHOR_FEED is required on mainnet (XAU/USD: 0x214eD9Da11D2fbe465a6fc601a91E62EbEc1a0D6). " +
        "Deploying without it disables the oracle anchor consistency check."
    );
  }

  // Hard gate (docs/ORACLE_IMPLEMENTATION_PLAN.md, PAXG-first): on mainnet the open profile alone
  // (no ceiling, no per-block cap; backstop is refused, its maximum being derived under the
  // retired pool design), PAXG on Chainlink PAXG/USD, XAU/USD as the gold reference only and XAUT
  // dormant. Checked before the first transaction.
  if (chainId === 1) {
    const problems = [...mainnetLaunchProblems(cfg), ...(await productionFeedProblems(cfg))];
    if (problems.length > 0) {
      throw new Error(`Refusing to deploy on mainnet:\n  - ${problems.join("\n  - ")}`);
    }
  }

  // The token's address. GSUSD_SALT and GSUSD_ADDRESS are required on mainnet. A fresh start
  // computes the address the salt gives before the first transaction; a resume leaves the
  // check to the ceremony, which asks the deployer contract itself.
  const token = parseStablecoinAddressEnv(process.env, chainId === 1);
  if (!token.plan) throw new Error(`Refusing to deploy:\n${formatFindings(token.findings)}`);
  if (stopped === undefined) {
    const initCodeHash = ethers.keccak256((await artifacts.readArtifact("GoldStablecoin")).bytecode);
    const findings = stablecoinAddressFindings(token.plan, deployer.address, await ethers.provider.getTransactionCount(deployer.address, "pending"), initCodeHash);
    console.log("\n--- Token address ---");
    console.log(formatFindings(findings));
    if (hasFailures(findings)) throw new Error("Refusing to deploy: GSUSD_SALT does not give GSUSD_ADDRESS. Nothing was sent.");
  }

  console.log("\n--- Deployer funds ---");
  await assertFunds(cfg, deployer.address, stopped, mandatory);

  const journal =
    stopped ??
    newDeployJournal({
      network: network.name,
      chainId,
      deployer: deployer.address,
      parametersHash,
      startedAt: new Date().toISOString(),
      startBlock: await ethers.provider.getBlockNumber(),
    });
  const save = (next: DeployJournal): void => writeFileAtomic(journalFile, `${JSON.stringify(next, null, 2)}\n`);
  save(journal);
  let deployment: DeploymentSnapshot;
  try {
    deployment = await runDeployCeremony({ cfg, chainId, networkName: network.name, deployer, journal, save, stablecoin: token.plan, log: (line) => console.log(line), waitTimeoutMs });
  } catch (err) {
    console.error(
      `\nThe ceremony stopped part way. Every contract created so far is in ${journalFile}.\n` +
        "Wait for any transaction still pending to confirm, fix the cause, then run the same command\n" +
        "again with DEPLOY_RESUME=1: it verifies the journal against the chain and sends only what is still owed.\n" +
        "Do not speed up or cancel a ceremony transaction from a wallet. If a contract creation was replaced\n" +
        "by hand all the same, wait until the replacement is mined, then resume with\n" +
        "DEPLOY_RESUME=1 DEPLOY_REPLACED_CREATION=<its hash>."
    );
    throw err;
  }
  const timelockAddr = deployment.addresses.timelock;

  // 9. The governance handover is its own irreversible step, never part of the deploy. One
  // command carries it out for every contract, the GoldGovernance wrapper included: a deployer
  // left as the wrapper's admin could grant itself PROPOSER_ROLE and drive the timelock,
  // so the calls are not listed here for anyone to send by hand.
  console.log("\n--- Governance handover (not done by this script) ---");
  console.log("Timelock address:", timelockAddr);
  console.log("The deployer still administers every contract. After verify-deployment.ts passes and the");
  console.log("Safes have been checked against the timelock above, hand over with the one command:");
  console.log(`  CONFIRM=YES npx hardhat run scripts/transfer-governance.ts --network ${network.name}`);
  console.log("It transfers the stablecoin, oracle, vault, stability module, surplus buffer, stability pool,");
  console.log("reserve, the GoldGovernance wrapper and the silo factory to the timelock, sends only what is");
  console.log("still owed and verifies every role afterwards. It is irreversible. Do not send these calls by hand.");

  console.log("\n--- Deployment complete ---");
  console.log(deployment);

  // Persist to disk so verify-deployment.ts can consume it; then the journal has served its purpose.
  const kept = writeSnapshot(outFile, JSON.stringify(deployment, null, 2), mandatory && snapshotExists);
  if (kept) console.log(`The replaced snapshot is kept as ${kept}`);
  fs.rmSync(journalFile, { force: true });
  console.log(`\nDeployment snapshot: ${outFile}`);
  console.log(`Next step: npx hardhat run scripts/verify-deployment.ts --network ${network.name}`);
  if (mandatory) console.log(`\n${keyReminderLines("deployed").join("\n")}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(describeError(error));
    process.exit(1);
  });
