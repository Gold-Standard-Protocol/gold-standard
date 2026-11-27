/**
 * Write the agent surface the dapp serves: /agents.json from every deployment snapshot in
 * deployments/ (sepolia.json, mainnet.json), /llms.txt from the same manifest, and the ABI
 * of every listed contract as /abi/<Contract>.json from the Hardhat artifacts, so an
 * autonomous agent can discover the protocol's addresses, tokens, ratios, conventions and
 * interfaces without the front end and without a code host. Run it after every deployment
 * or parameter change and commit the result.
 *
 *   npx hardhat run scripts/print-agent-manifest.ts
 *
 * SITE_URL overrides the origin the links are built from (the first entry when it is a
 * comma-separated list, as print-service-env.ts accepts); SOURCE_URL adds a repository link.
 */
import { artifacts } from "hardhat";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { ABI_CONTRACTS, AgentManifestSnapshot, buildAgentManifest, buildLlmsTxt, manifestSiteUrl, publishableSnapshots } from "./lib/agentManifest";
import { describeError } from "./lib/redact";

function writeAbis(publicDir: string): string[] {
  const abiDir = resolve(publicDir, "abi");
  mkdirSync(abiDir, { recursive: true });
  return ABI_CONTRACTS.map((name) => {
    const artifact = artifacts.readArtifactSync(name);
    const out = resolve(abiDir, `${name}.json`);
    writeFileSync(out, `${JSON.stringify(artifact.abi, null, 2)}\n`);
    return out;
  });
}

function main(): void {
  const found = ["sepolia", "mainnet"]
    .map((name) => resolve(__dirname, "../deployments", `${name}.json`))
    .filter((path) => existsSync(path))
    .map((path) => JSON.parse(readFileSync(path, "utf8")) as AgentManifestSnapshot);
  const { publish: snapshots, rehearsals } = publishableSnapshots(found);
  for (const snap of rehearsals) {
    console.warn(`Skipping deployments/${snap.network}.json: chain ${snap.chainId} deployed by the development account ${snap.deployer}, a fork rehearsal, not a deployment to publish.`);
  }
  if (snapshots.length === 0) throw new Error("No deployment snapshot found in deployments/.");
  const manifest = buildAgentManifest(snapshots, {
    generatedAt: new Date().toISOString(),
    siteUrl: manifestSiteUrl(process.env.SITE_URL),
    repository: process.env.SOURCE_URL,
  });
  const publicDir = resolve(__dirname, "../../apps/dapp/public");
  const manifestPath = resolve(publicDir, "agents.json");
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(resolve(publicDir, "llms.txt"), buildLlmsTxt(manifest));
  const abis = writeAbis(publicDir);
  console.log(`Wrote ${manifestPath} for chain ids ${Object.keys(manifest.networks).join(", ")}, llms.txt and ${abis.length} ABI files under ${resolve(publicDir, "abi")}`);
}

try {
  main();
} catch (error) {
  console.error(describeError(error));
  process.exit(1);
}
