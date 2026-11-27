import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { productionSystem } from "./helpers/productionSystem";
import { readVaultRegistryHook, VAULT_REGISTRY_SELECTOR } from "../scripts/lib/vaultRegistryHook";

/**
 * scripts/wire-vault-registry.ts step 3: a vault without the registry hook is told apart
 * from a failed read by its runtime code, so a rate limit or a timeout on the read stops
 * the script instead of passing for a legacy vault.
 */
describe("wire-vault-registry hook detection", function () {
  const getCode = (address: string) => ethers.provider.getCode(address);

  it("names the selector the vault exposes", async function () {
    const { vault } = await loadFixture(productionSystem);
    expect(VAULT_REGISTRY_SELECTOR).to.equal(vault.interface.getFunction("vaultRegistry").selector);
  });

  it("reads where a hooked vault points", async function () {
    const { vault } = await loadFixture(productionSystem);
    expect(await readVaultRegistryHook(vault, getCode)).to.equal(await vault.vaultRegistry());
  });

  it("reports a vault whose code has no vaultRegistry() as one that predates the hook", async function () {
    const { paxg } = await loadFixture(productionSystem);
    // Any contract without the function stands in for the 2026-09-26 Sepolia vault.
    const legacy = { getAddress: () => paxg.getAddress(), vaultRegistry: () => Promise.reject(new Error("execution reverted")) };
    expect(await readVaultRegistryHook(legacy, getCode)).to.equal(null);
  });

  it("rethrows a transport failure on a hooked vault instead of calling it a legacy vault", async function () {
    const { vault } = await loadFixture(productionSystem);
    const flaky = { getAddress: () => vault.getAddress(), vaultRegistry: () => Promise.reject(new Error("request timeout (429)")) };
    await expect(readVaultRegistryHook(flaky, getCode)).to.be.rejectedWith("request timeout (429)");
  });

  it("rethrows a failed code read", async function () {
    const { vault } = await loadFixture(productionSystem);
    const failing = () => Promise.reject(new Error("header not found"));
    await expect(readVaultRegistryHook(vault, failing)).to.be.rejectedWith("header not found");
  });

  it("refuses an address with no code at all", async function () {
    const empty = { getAddress: async () => ethers.ZeroAddress.replace(/0$/, "1"), vaultRegistry: () => Promise.resolve(ethers.ZeroAddress) };
    await expect(readVaultRegistryHook(empty, getCode)).to.be.rejectedWith("No contract code");
  });
});
