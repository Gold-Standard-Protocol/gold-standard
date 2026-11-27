/**
 * Add the VaultRegistry to a deployment that predates it. A fresh deploy.ts wires the
 * registry in the ceremony; this script is for an existing deployment, in three idempotent
 * steps, so it can be run again until everything is in place:
 *
 *   1. Registry: attach the one in the snapshot (or REGISTRY_ADDRESS), else deploy one and
 *      record it in deployments/<network>.json.
 *   2. Backfill: find every vault owner from the vault's CollateralDeposited events (from
 *      BACKFILL_FROM_BLOCK, default the snapshot's deployBlock) and `syncMany` the ones the
 *      registry has wrong. Permissionless, so it works before the vault is wired.
 *   3. Wiring: point the vault at the registry. Direct while the signer holds
 *      GOVERNANCE_ROLE; after the handover one timelock step per run (schedule, wait 48 h,
 *      execute), with the Safe call printed when the signer lacks the role. A vault deployed
 *      before the hook existed (Sepolia, 2026-09-26) cannot be wired; there the registry
 *      lives on step 2 alone, so run this again whenever the list may have drifted.
 *
 * Nothing is sent unless CONFIRM=YES. FORK_OF and IMPERSONATE rehearse it on a fork.
 *
 *   CONFIRM=YES npx hardhat run scripts/wire-vault-registry.ts --network sepolia
 */
import { ethers } from "hardhat";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { connectDeployment, parseForkEnv } from "./lib/deploymentContext";
import { describeError } from "./lib/redact";
import { advanceTimelock, operationSalt, resolveGovernancePath } from "./lib/timelockStep";
import { readVaultRegistryHook } from "./lib/vaultRegistryHook";
import type { GoldVault } from "../typechain-types";

interface RawSnapshot {
  deployBlock?: number;
  addresses: Record<string, string | undefined>;
  build?: { runtimeCodeHashes?: Record<string, string> };
}

const SYNC_BATCH = 50;

async function collectOwners(vault: GoldVault, fromBlock: number, toBlock: number): Promise<string[]> {
  const owners = new Set<string>();
  let chunk = 50_000;
  let from = fromBlock;
  while (from <= toBlock) {
    const to = Math.min(from + chunk - 1, toBlock);
    try {
      const logs = await vault.queryFilter(vault.filters.CollateralDeposited(), from, to);
      for (const log of logs) owners.add(ethers.getAddress(log.args.user));
      from = to + 1;
    } catch (error) {
      if (chunk <= 1_000) throw error;
      chunk = Math.floor(chunk / 2); // the gateway refused the range; narrow it and retry
    }
  }
  return [...owners];
}

async function main() {
  const confirm = process.env.CONFIRM === "YES";
  const { snapName, signer, fork } = await connectDeployment(parseForkEnv(process.env));
  const signerAddress = await signer.getAddress();
  const file = resolve(__dirname, "../deployments", `${snapName}.json`);
  const raw = JSON.parse(readFileSync(file, "utf8")) as RawSnapshot;
  const vaultAddress = raw.addresses.vault;
  const timelockAddress = raw.addresses.timelock;
  if (!vaultAddress || !timelockAddress) throw new Error(`${file} lacks the vault or the timelock address`);
  const vault = await ethers.getContractAt("GoldVault", vaultAddress, signer);
  const timelock = await ethers.getContractAt("TimelockController", timelockAddress, signer);
  console.log(`${snapName}${fork ? " (fork)" : ""}: signer ${signerAddress}${confirm ? "" : " (dry run)"}`);

  // 1. Registry
  let registryAddress = process.env.REGISTRY_ADDRESS ?? raw.addresses.vaultRegistry;
  if (!registryAddress) {
    if (!confirm) {
      console.log("  would deploy VaultRegistry(vault) and record it in the snapshot");
    } else {
      const factory = await ethers.getContractFactory("VaultRegistry", signer);
      const deployed = await factory.deploy(vaultAddress);
      await deployed.waitForDeployment();
      registryAddress = await deployed.getAddress();
      console.log(`  deployed VaultRegistry ${registryAddress}`);
      if (!fork) {
        raw.addresses.vaultRegistry = registryAddress;
        // verify-deployment compares the code at every snapshot address with its recorded hash.
        const codeHash = ethers.keccak256(await ethers.provider.getCode(registryAddress));
        raw.build = { ...raw.build, runtimeCodeHashes: { ...raw.build?.runtimeCodeHashes, vaultRegistry: codeHash } };
        writeFileSync(file, JSON.stringify(raw, null, 2) + "\n");
        console.log(`  recorded in ${file}`);
      }
    }
  } else {
    console.log(`  registry ${registryAddress}`);
  }
  if (!registryAddress) {
    console.log("Dry run ends here: deploy first.");
    return;
  }
  const registry = await ethers.getContractAt("VaultRegistry", registryAddress, signer);
  if ((await registry.vault()).toLowerCase() !== vaultAddress.toLowerCase()) {
    throw new Error(`Registry ${registryAddress} mirrors ${await registry.vault()}, not this vault`);
  }

  // 2. Backfill
  const fromBlock = Number(process.env.BACKFILL_FROM_BLOCK ?? raw.deployBlock ?? 0);
  const toBlock = await ethers.provider.getBlockNumber();
  const owners = await collectOwners(vault, fromBlock, toBlock);
  const stale: string[] = [];
  for (const owner of owners) {
    const position = await vault.vaults(owner);
    const open = position.collateralAmount > 0n || position.debtAmount > 0n;
    if ((await registry.isVaultOwner(owner)) !== open) stale.push(owner);
  }
  console.log(`  ${owners.length} owners in the deposit events from block ${fromBlock}; ${stale.length} to sync; registry lists ${await registry.vaultOwnerCount()}`);
  if (stale.length > 0 && confirm) {
    for (let i = 0; i < stale.length; i += SYNC_BATCH) {
      await (await registry.syncMany(stale.slice(i, i + SYNC_BATCH))).wait();
    }
    console.log(`  synced; registry now lists ${await registry.vaultOwnerCount()}`);
  }

  // 3. Wiring
  // Legacy is read from the vault's code: a failed read is an error, never a legacy vault.
  const wired = await readVaultRegistryHook(vault, (address) => ethers.provider.getCode(address));
  if (wired === null) {
    console.log(
      "  this vault predates the registry hook (no setVaultRegistry): the registry is kept current by\n" +
        "  VaultRegistry.sync alone until the next redeploy. Run this script again whenever the list may\n" +
        "  have drifted; it backfills from the deposit events every time."
    );
    return;
  }
  if (wired.toLowerCase() === registryAddress.toLowerCase()) {
    console.log("  vault already points at this registry; nothing to wire");
    return;
  }
  const data = vault.interface.encodeFunctionData("setVaultRegistry", [registryAddress]);
  const route = await resolveGovernancePath(vault, signerAddress, timelock);
  if (route.path === "direct") {
    if (!confirm) {
      console.log("  would call vault.setVaultRegistry directly (signer holds GOVERNANCE_ROLE)");
      return;
    }
    await (await vault.setVaultRegistry(registryAddress)).wait();
    console.log("  vault.setVaultRegistry sent; verify with scripts/verify-deployment.ts");
    return;
  }
  const outcome = await advanceTimelock({
    timelock,
    signer,
    target: vaultAddress,
    data,
    salt: operationSalt("vault-registry", ["address"], [registryAddress]),
    label: "GoldVault.setVaultRegistry",
    confirm,
    guard: async () => {
      if ((await registry.vault()).toLowerCase() !== vaultAddress.toLowerCase()) throw new Error("Registry no longer mirrors this vault");
    },
    log: (line) => console.log(`  ${line}`),
    // The salt is keyed by the registry address alone, and a cancel clears the operation.
    restartAdvice: "Then run this script again: once cancelled, the same operation schedules afresh and waits out the full delay.",
  });
  console.log(`  timelock step: ${outcome.step}${outcome.txHash ? ` (${outcome.txHash})` : ""}${outcome.readyAt ? `, ready at ${new Date(outcome.readyAt * 1000).toISOString()}` : ""}`);
}

main().catch((error) => {
  console.error(describeError(error));
  process.exit(1);
});
