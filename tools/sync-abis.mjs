#!/usr/bin/env node
// Regenerate libs/constants/src/lib/abis/*.ts from the compiled Hardhat artifacts, so the
// dapp and the keeper always carry the ABI of the contracts in this tree. Run after
// `npx hardhat compile` in contracts/:
//   node tools/sync-abis.mjs
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const targets = [
  ["GoldVault", "src/core/GoldVault.sol/GoldVault.json", "goldVaultAbi"],
  ["GoldOracle", "src/core/GoldOracle.sol/GoldOracle.json", "goldOracleAbi"],
  ["StabilityPool", "src/core/StabilityPool.sol/StabilityPool.json", "stabilityPoolAbi"],
  ["GoldStabilityReserve", "src/core/GoldStabilityReserve.sol/GoldStabilityReserve.json", "goldStabilityReserveAbi"],
  ["StabilityModule", "src/core/StabilityModule.sol/StabilityModule.json", "stabilityModuleAbi"],
  ["SurplusBuffer", "src/core/SurplusBuffer.sol/SurplusBuffer.json", "surplusBufferAbi"],
  // The liquidations page reads open vault owners from the registry when the API owner index is
  // unavailable.
  ["VaultRegistry", "src/core/VaultRegistry.sol/VaultRegistry.json", "vaultRegistryAbi"],
];

// Match the hand-written style: tabs, unquoted keys, single-quoted strings, `as const`.
export function render(value, depth) {
  const pad = "\t".repeat(depth);
  const inner = "\t".repeat(depth + 1);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return `[\n${value.map((v) => `${inner}${render(v, depth + 1)},`).join("\n")}\n${pad}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value);
    return `{\n${entries.map(([k, v]) => `${inner}${k}: ${render(v, depth + 1)},`).join("\n")}\n${pad}}`;
  }
  if (typeof value === "string") return `'${value.replace(/'/g, "\\'")}'`;
  return String(value);
}

/**
 * The module text for one ABI. An existing file keeps its export name; a target with no
 * file yet (a contract newly added to the list) is created under its default name.
 */
export function abiModule(abi, exportName, current) {
  const match = current?.match(/export const (\w+) = /);
  const actualExport = match ? match[1] : exportName;
  return `export const ${actualExport} = ${render(abi, 0)} as const;\n`;
}

export function syncAbis({ abisDir, artifactsDir, log = console.log }) {
  for (const [name, artifactPath, exportName] of targets) {
    const file = resolve(abisDir, `${name}.ts`);
    const current = existsSync(file) ? readFileSync(file, "utf8") : undefined;
    const { abi } = JSON.parse(readFileSync(resolve(artifactsDir, artifactPath), "utf8"));
    const next = abiModule(abi, exportName, current);
    if (next !== current) {
      writeFileSync(file, next);
      log(`${current === undefined ? "created" : "updated"} ${name}.ts (${abi.length} entries)`);
    } else {
      log(`unchanged ${name}.ts`);
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  syncAbis({
    abisDir: resolve(root, "libs/constants/src/lib/abis"),
    artifactsDir: resolve(root, "contracts/artifacts"),
  });
}
