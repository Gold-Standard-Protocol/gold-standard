import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";
import { HandoverContracts, HandoverParties } from "./lib/governanceHandover";
import { CensusStage, HandoverRefused, carryOutHandover } from "./lib/handoverCeremony";
import {
  CensusAddresses,
  CensusCheck,
  CensusPolicy,
  censusAddresses,
  censusFromBlock,
  censusNames,
  censusTargets,
  takeRoleCensus,
  timelockGracePeriodCheck,
} from "./lib/roleCensus";
import { POST_HANDOVER_VERIFICATION, keyReminderApplies, keyReminderLines } from "./lib/keyHygiene";
import { describeErrorStack } from "./lib/redact";

/**
 * Irreversible governance handover.
 *
 * Transfers DEFAULT_ADMIN_ROLE (and GOVERNANCE_ROLE where applicable) on every
 * governed contract from the deployer EOA to the timelock. After this script
 * runs successfully:
 *
 *   - Deployer holds zero admin roles anywhere in the system.
 *   - Timelock holds DEFAULT_ADMIN_ROLE on every contract.
 *   - Every privileged role has exactly its intended holders (the role census,
 *     scripts/lib/roleCensus.ts), and the deployer holds no role at all beyond
 *     any the configuration names it for on a testnet.
 *   - All parameter changes must wait out the timelock delay (48h at launch;
 *     governable, THREAT_MODEL G10).
 *
 * Safety gates:
 *   - Refuses to run unless CONFIRM=YES is set in the environment.
 *   - Refuses if `governanceTransferred` is already true in the snapshot.
 *   - Refuses if the connected signer is not the deployer recorded at deploy time.
 *   - Reads who administers each contract, at one block, before it sends anything and
 *     sends only the transactions still owed (scripts/lib/handoverCeremony.ts and
 *     governanceHandover.ts). Refuses an admin state the handover never leaves behind,
 *     naming the contract.
 *   - Refuses before the first transaction it sends if the role census finds a holder
 *     the ceremony did not intend: transferGovernance revokes the caller alone, so a key
 *     granted a role beforehand would survive the handover.
 *     While the deployer is still admin it can revoke that key itself.
 *   - Verifies every admin after the last transaction confirms, then takes the census
 *     again with the timelock as the authority.
 *   - Updates `deployments/<network>.json` with `governanceTransferred: true`
 *     only after every check passes.
 *
 * A run that stops part way (a dropped endpoint, a fee spike, an empty wallet) is finished
 * by running the same command again once any pending transaction has confirmed. The census
 * then expects the timelock on the contracts already handed over and the deployer on the
 * rest, and a run that finds nothing left to send verifies and records the handover.
 *
 * Usage:
 *   CONFIRM=YES npx hardhat run scripts/transfer-governance.ts --network <net>
 *
 * After success:
 *   EXPECT_GOVERNANCE_TRANSFERRED=1 npx hardhat run scripts/verify-deployment.ts --network <net>
 */

interface Deployment {
  chainId: number;
  network: string;
  deployer: string;
  /** The vault's creation block. */
  deployBlock?: number;
  /** Every contract's creation block; recorded by deploy.ts from 2026-11-06, absent before. */
  creationBlocks?: Record<string, number>;
  addresses: Record<string, string>;
  config: { proposers: string[]; executors: string[]; guardian: string };
  governanceTransferred: boolean;
}

function abort(msg: string): never {
  console.error(`\n  ABORT: ${msg}\n`);
  process.exit(1);
}

/**
 * The role census as of `block`; prints every line. `stage` names the authority: the timelock on
 * every contract (after), or the deployer on each contract the handover has not reached yet (before).
 */
async function census(dep: Deployment, addresses: CensusAddresses, stage: CensusStage, block: number): Promise<CensusCheck[]> {
  const start = await censusFromBlock(ethers.provider, { addresses, deployBlock: dep.deployBlock, creationBlocks: dep.creationBlocks }, block);
  const { proposers, executors, guardian } = dep.config;
  const policy: CensusPolicy = { addresses, deployer: dep.deployer, proposers, executors, guardian, ...stage };
  const checks = await takeRoleCensus(ethers.provider, censusTargets(policy), {
    fromBlock: start.fromBlock,
    toBlock: block,
    deployer: dep.deployer,
    names: censusNames(policy),
  });
  console.log(`    logs replayed from block ${start.fromBlock} (${start.source})`);
  if (start.warning !== undefined) console.log(`    [WARN] ${start.warning}`);
  for (const check of checks) console.log(`    [${check.pass ? "OK" : "FAIL"}] ${check.name}: ${check.detail}`);
  return checks;
}

async function main() {
  if (process.env.CONFIRM !== "YES") {
    abort(
      "This action is IRREVERSIBLE. Set CONFIRM=YES to proceed.\n" +
      "  After this script:\n" +
      "    - Deployer EOA loses ALL admin roles on every contract.\n" +
      "    - Timelock holds DEFAULT_ADMIN_ROLE on every contract.\n" +
      "    - Every parameter change waits out the timelock delay (48h at launch; governable, THREAT_MODEL G10).\n" +
      "  Run on Sepolia first."
    );
  }

  const network = await ethers.provider.getNetwork();
  const file = path.resolve(__dirname, "..", "deployments", `${network.name}.json`);
  if (!fs.existsSync(file)) {
    abort(`No deployment snapshot at ${file}. Run scripts/deploy.ts first.`);
  }

  const dep: Deployment = JSON.parse(fs.readFileSync(file, "utf8"));

  if (dep.governanceTransferred) {
    abort("Governance already transferred according to the snapshot. Nothing to do.");
  }

  if (dep.chainId !== Number(network.chainId)) {
    abort(`Chain mismatch: snapshot=${dep.chainId}, connected=${network.chainId}`);
  }

  // Fork rehearsal only (chainId 31337): impersonate the recorded deployer so the REAL
  // handover sequence below runs against a Hardhat fork of the live deployment first.
  const rehearseAs = process.env.REHEARSE_AS;
  const signer =
    rehearseAs && Number(network.chainId) === 31337
      ? await ethers.getImpersonatedSigner(rehearseAs)
      : (await ethers.getSigners())[0];
  if (signer.address.toLowerCase() !== dep.deployer.toLowerCase()) {
    abort(`Wrong signer. Snapshot deployer=${dep.deployer}, connected=${signer.address}`);
  }

  const a = dep.addresses;
  const timelockAddr = a.timelock;
  if (!timelockAddr || timelockAddr === ethers.ZeroAddress) {
    abort("No timelock address in deployment snapshot.");
  }
  if (timelockAddr.toLowerCase() === signer.address.toLowerCase()) {
    abort("Timelock equals deployer — refusing self-transfer.");
  }

  console.log("=".repeat(68));
  console.log("  IRREVERSIBLE: governance handover");
  console.log("=".repeat(68));
  console.log(`  Network:   ${network.name} (chainId ${network.chainId})`);
  console.log(`  Deployer:  ${dep.deployer}`);
  console.log(`  Timelock:  ${timelockAddr}`);
  console.log("");

  const contracts: HandoverContracts = {
    stablecoin: await ethers.getContractAt("GoldStablecoin", a.stablecoin, signer),
    oracle: await ethers.getContractAt("GoldOracle", a.oracle, signer),
    vault: await ethers.getContractAt("GoldVault", a.vault, signer),
    stabilityModule: await ethers.getContractAt("StabilityModule", a.stabilityModule, signer),
    surplusBuffer: await ethers.getContractAt("SurplusBuffer", a.surplusBuffer, signer),
    stabilityPool: await ethers.getContractAt("StabilityPool", a.stabilityPool, signer),
    reserve: await ethers.getContractAt("GoldStabilityReserve", a.reserve, signer),
    governance: await ethers.getContractAt("GoldGovernance", a.governance, signer),
    siloFactory: await ethers.getContractAt("SiloFactory", a.siloFactory, signer),
  };
  const parties: HandoverParties = { deployer: dep.deployer, timelock: timelockAddr };

  // Plan, census, send, verify, record: scripts/lib/handoverCeremony.ts, where it is tested.
  const addresses = censusAddresses(a);
  try {
    await carryOutHandover({
      contracts,
      parties,
      headBlock: () => ethers.provider.getBlockNumber(),
      census: (stage, block) => census(dep, addresses, stage, block),
      gracePeriod: () => timelockGracePeriodCheck(ethers.provider, timelockAddr),
      recordTransferred: () => {
        dep.governanceTransferred = true;
        fs.writeFileSync(file, JSON.stringify(dep, null, 2));
      },
      log: (line) => console.log(line),
    });
  } catch (err) {
    if (err instanceof HandoverRefused) abort(err.message);
    throw err;
  }

  console.log("\n  Governance transfer complete and verified.");
  console.log(`  Snapshot updated: ${file}`);
  console.log("");
  console.log("  Next step:");
  console.log(`    ${POST_HANDOVER_VERIFICATION} --network ${network.name}`);
  // The same condition under which deploy.ts prints its reminder: not on Sepolia or a plain fork rehearsal.
  if (keyReminderApplies(Number(network.chainId), process.env.REQUIRE_PREFLIGHT_RECORD)) {
    console.log("");
    for (const line of keyReminderLines("handed-over")) console.log(`  ${line}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(describeErrorStack(err));
    process.exit(1);
  });
