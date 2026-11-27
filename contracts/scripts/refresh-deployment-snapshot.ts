import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";
import { ChainParameters, CollateralReading, refreshSnapshotConfig, xautActivationPending } from "./lib/snapshotRefresh";
import { readLaunchParameters } from "./lib/launchParameterChecks";
import { describeErrorStack } from "./lib/redact";

/**
 * Re-read live governance parameters into the deployment snapshot.
 *
 * verify-deployment.ts compares chain state against `deployments/<net>.json`, which
 * deploy.ts wrote once. Every legitimate governance change (a ceiling raise on the
 * guarded ramp, a ratio change, a fee change, a governed reserve minimum) therefore makes it
 * fail forever, and a gate that fails every week stops being read. No runbook step refreshed the snapshot.
 *
 * Run this AFTER a governance parameter change lands, and re-run verify-deployment to
 * confirm the only remaining differences are ones you intend; then regenerate the agent
 * manifest (print-agent-manifest.ts), which reads the same snapshot. It deliberately
 * refreshes ONLY the risk parameters (see scripts/lib/snapshotRefresh.ts for the list):
 * addresses, roles and the guardian are never touched, so it cannot be used to paper over a
 * wiring or handover fault, and a dormant XAUT keeps its recorded configuration.
 *
 *   npx hardhat run scripts/refresh-deployment-snapshot.ts --network sepolia
 *
 * After governance activates XAUT, the vault shows an active XAUT collateral type while the
 * snapshot still records it dormant. The refresh refuses that until told it is intended:
 *
 *   XAUT_ACTIVATED=1 npx hardhat run scripts/refresh-deployment-snapshot.ts --network mainnet
 *
 * records the activation (xautActive, xautActivatedAt and xautMarketFeed, the feed the oracle now
 * prices XAUT on) together with XAUT's ratios, ceiling, stability fee and reserve minimum, after
 * which verify-deployment.ts accepts an active XAUT on mainnet. Then run verify-deployment.ts
 * with EXPECT_GOVERNANCE_TRANSFERRED=1 and regenerate the agent manifest.
 */

/** XAUT_ACTIVATED is 1 or unset: recording an activation is written out, never inferred from "true" or "yes". */
function parseXautActivated(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  if (raw.trim() !== "1") throw new Error(`XAUT_ACTIVATED is "${raw}"; set XAUT_ACTIVATED=1 to record XAUT's activation, or unset it.`);
  return true;
}

async function main() {
  const net = await ethers.provider.getNetwork();
  const file = path.resolve(__dirname, "..", "deployments", `${network.name}.json`);
  if (!fs.existsSync(file)) throw new Error(`No snapshot at ${file}`);
  const dep = JSON.parse(fs.readFileSync(file, "utf8"));
  if (dep.chainId !== Number(net.chainId)) {
    throw new Error(`Chain mismatch: snapshot ${dep.chainId}, connected ${net.chainId}`);
  }

  const vault = await ethers.getContractAt("GoldVault", dep.addresses.vault);
  const oracle = await ethers.getContractAt("GoldOracle", dep.addresses.oracle);
  const surplusBuffer = await ethers.getContractAt("SurplusBuffer", dep.addresses.surplusBuffer);
  const idFor = (token: string) =>
    ethers.keccak256(ethers.solidityPacked(["address"], [token]));
  const collateral = async (token: string): Promise<CollateralReading> => {
    const t = await vault.collateralTypes(idFor(token));
    return {
      active: t.active,
      minRatio: t.minRatio,
      liquidationRatio: t.liquidationRatio,
      liquidationPenalty: t.liquidationPenalty,
      debtCeiling: t.debtCeiling,
    };
  };

  // Every launch parameter verify-deployment compares by equality, less the code hashes, which
  // are never refreshed. Only the governed reserve minimum is a parameter there: the automatic
  // 2% floor follows supply on chain, so it is reported below, never written; a snapshot would
  // be stale within a block.
  const xautActivated = parseXautActivated(process.env.XAUT_ACTIVATED);
  const xaut = await collateral(dep.config.xautToken);
  // An activation being recorded reads XAUT's stability fee and reserve minimum as an active
  // token's, which the dormant snapshot would otherwise have the reader skip (issue 75).
  const activating = xautActivated && xautActivationPending(dep.config, { xaut });
  const { runtimeCodeHashes: _codeHashes, ...launch } = await readLaunchParameters(activating ? { ...dep, config: { ...dep.config, xautActive: true } } : dep);
  void _codeHashes;
  const chain: ChainParameters = {
    ...launch,
    paxg: await collateral(dep.config.paxgToken),
    xaut,
    xautFeed: (await oracle.feeds(dep.config.xautToken)).feed,
    paxgGoldBandPpm: await oracle.goldBandPpm(dep.config.paxgToken),
    paxgLiquidationClampPpm: await oracle.liquidationClampPpm(dep.config.paxgToken),
    stalenessThreshold: await oracle.stalenessThreshold(),
  };
  console.log(`oracle staleness threshold ${chain.stalenessThreshold} s  reserve daily cap (PAXG) ${chain.reserveDailyCapPpm} ppm`);

  for (const key of ["paxg", "xaut"] as const) {
    const t = chain[key];
    console.log(
      `${key}: minRatio ${Number(t.minRatio) / 10000}%  liq ${Number(t.liquidationRatio) / 10000}%  ` +
        `penalty ${Number(t.liquidationPenalty) / 10000}%  ceiling ${ethers.formatEther(t.debtCeiling)}${t.active ? "" : "  (inactive)"}`
    );
  }
  console.log(`minGsusdReserve (governed minimum) ${ethers.formatEther(chain.minGsusdReserve)} GSUSD`);
  try {
    const effective: bigint = await surplusBuffer.effectiveMinGsusdReserve();
    console.log(`effective reserve floor ${ethers.formatEther(effective)} GSUSD (automatic 2% of supply or the minimum)`);
  } catch {
    console.log("effective reserve floor: unavailable, this SurplusBuffer predates the automatic floor");
  }
  console.log(
    `minDebt ${ethers.formatEther(chain.minDebt)} GSUSD  underwater discount ${chain.underwaterDiscountPpm} ppm  ` +
      `origination fee ${chain.originationFeeBps} bps`
  );
  console.log(`PAXG gold band ${chain.paxgGoldBandPpm} ppm  liquidation clamp ${chain.paxgLiquidationClampPpm} ppm`);

  const { config, changed, kept } = refreshSnapshotConfig(dep.config, chain, { xautActivated });
  if (changed.includes("xautActive")) console.log(`XAUT activation recorded: live feed ${config.xautMarketFeed}, stamped ${config.xautActivatedAt}.`);
  for (const note of kept) console.log(`kept: ${note}`);
  if (changed.length === 0) {
    console.log("\nNo drift: snapshot already matches chain.");
    return;
  }
  const next = { ...dep, config, parametersRefreshedAt: new Date().toISOString() };
  fs.writeFileSync(file, JSON.stringify(next, null, 2));
  console.log(`\nSnapshot refreshed (${changed.join(", ")}): ${file}`);
  console.log("Re-run verify-deployment.ts; any remaining failure is a real one. Then regenerate agents.json with print-agent-manifest.ts.");
}

main().catch((e) => {
  console.error(describeErrorStack(e));
  process.exitCode = 1;
});
