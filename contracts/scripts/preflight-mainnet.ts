/**
 * Mainnet launch preflight. Read-only on chain: it sends nothing and can be run as often as
 * you like. Its one side effect is the ceremony record.
 *
 * Checks the ceremony environment (.env.mainnet) and the live chain before deploy.ts spends
 * anything: every knob deploy.ts applies, parsed by the same code and bounded by the
 * contracts' own limits; the chain id; every address against the published inventory; the
 * tokens' decimals and symbols; the feeds' decimals, descriptions, freshness and gold band;
 * the three Safes' thresholds, role split and signer overlap, that the deployer is an owner of
 * none of them, and the operations Safe when OPERATIONS_SAFE names one (a warning on mainnet
 * when it does not); the deployer's balance against
 * a gas estimate of the whole ceremony; and that no deployment snapshot would be overwritten.
 *
 *   set -a; source .env.mainnet; set +a
 *   npx hardhat run scripts/preflight-mainnet.ts --network mainnet
 *
 * On success it writes deployments/<network>.preflight.json: every effective parameter and
 * their hash. deploy.ts refuses to run on mainnet unless that record exists and hashes to
 * what it parses itself, so nothing can be deployed that the preflight did not see.
 *
 * Exit code 1 on any FAIL. On a Hardhat fork of mainnet set PREFLIGHT_EXPECT_CHAIN_ID=31337.
 * PREFLIGHT_ALLOW_EXISTING_SNAPSHOT=1 turns an existing deployments/<network>.json into a
 * warning for a deliberate redeploy (deploy.ts honours the same flag and keeps a dated copy).
 *
 * The record also carries the deployer's nonce: deploy.ts starts a ceremony only at that nonce,
 * so a record cannot be replayed once the key has sent anything. It carries the chain's clock at
 * the moment it passed and each Safe's threshold and owners as well: deploy.ts starts a ceremony
 * only within 60 minutes of chain time (PREFLIGHT_MAX_AGE_MINUTES changes the limit, for the
 * preflight's printout and the deploy alike), and reads the Safes again and refuses if one
 * differs. Run the preflight, then the deploy, in one sitting; deploy.ts re-checks the balance at
 * the fee current when it starts.
 */
import { artifacts, ethers, network } from "hardhat";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { MAINNET, MAINNET_CHAIN_ID } from "./lib/mainnetAddresses";
import { buildPreflightRecord, parsePreflightMaxAgeMinutes, preflightRecordName } from "./lib/launchEnv";
import { parseStablecoinAddressEnv, stablecoinAddressFindings } from "./lib/stablecoinAddress";
import { ceremonyCreationTransactions } from "./lib/deployCeremony";
import { formatFindings, hasFailures, parseLaunchEnv, readSafeRecords, runPreflight } from "./lib/preflight";
import { describeError } from "./lib/redact";

async function main(): Promise<void> {
  console.log(`Launch preflight on network "${network.name}". Read-only on chain: nothing is sent.\n`);
  // Parsed first, so a bad override stops the run before any check is printed.
  const maxAgeMinutes = parsePreflightMaxAgeMinutes(process.env.PREFLIGHT_MAX_AGE_MINUTES);
  const { env, findings } = parseLaunchEnv(process.env);
  if (!env) {
    console.log(formatFindings(findings));
    throw new Error("The environment is not ready; fix the FAIL lines above.");
  }
  const expectedChainId = Number(process.env.PREFLIGHT_EXPECT_CHAIN_ID ?? MAINNET_CHAIN_ID);
  const deployments = resolve(__dirname, "../deployments");
  const snapshot = resolve(deployments, `${network.name}.json`);
  const onChain = await runPreflight({
    provider: ethers.provider,
    env,
    expectedChainId,
    known: MAINNET,
    creations: await ceremonyCreationTransactions(env),
    snapshotExists: existsSync(snapshot),
    allowExistingSnapshot: process.env.PREFLIGHT_ALLOW_EXISTING_SNAPSHOT === "1",
  });
  // The token's address: required on mainnet, and computed here from the deployer's nonce, the
  // salt and the token's creation code, so a salt that gives another address fails before anything is sent.
  const token = parseStablecoinAddressEnv(process.env, expectedChainId === MAINNET_CHAIN_ID);
  const tokenFindings = token.plan
    ? stablecoinAddressFindings(token.plan, env.deployer, await ethers.provider.getTransactionCount(env.deployer, "pending"), ethers.keccak256((await artifacts.readArtifact("GoldStablecoin")).bytecode))
    : token.findings;
  const all = [...findings, ...onChain, ...tokenFindings];
  console.log(formatFindings(all));
  if (hasFailures(all)) throw new Error("Preflight failed. Do not deploy.");

  const head = await ethers.provider.getBlock("latest");
  if (!head) throw new Error("The endpoint returned no latest block; the record needs the chain's clock. Run the preflight again.");
  const record = buildPreflightRecord({
    network: network.name,
    chainId: expectedChainId,
    deployer: env.deployer,
    // deploy.ts starts a ceremony only at this nonce, so the record cannot be replayed after a deploy.
    deployerNonce: await ethers.provider.getTransactionCount(env.deployer),
    createdAt: new Date().toISOString(),
    // Age is measured against the chain's clock, on this side and in deploy.ts.
    chainTime: head.timestamp,
    safes: await readSafeRecords(ethers.provider, env),
    operationsSafe: env.operationsSafe,
    params: env,
    findings: all,
  });
  mkdirSync(deployments, { recursive: true });
  const recordPath = resolve(deployments, preflightRecordName(network.name));
  writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`);
  console.log(`\nPreflight passed. Ceremony record ${recordPath} (parameters hash ${record.parametersHash}).`);
  console.log(
    `The record opens the deploy for ${maxAgeMinutes} minutes of chain time, until about ${new Date((head.timestamp + maxAgeMinutes * 60) * 1000).toISOString()}, ` +
      "and only while the three Safes keep the thresholds and owners read above."
  );
  console.log("Next: npx hardhat run scripts/deploy.ts --network", network.name);
}

main().catch((error) => {
  console.error(describeError(error));
  process.exit(1);
});
