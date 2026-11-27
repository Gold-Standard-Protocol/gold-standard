/**
 * Whether a deployed GoldVault has the registry hook, and where it points. A vault deployed
 * before the hook existed (Sepolia, 2026-09-26) has no vaultRegistry() in its runtime code.
 * That is read from the code itself and never inferred from a failed call: a rate limit, a
 * timeout or a lagging node fails the call the same way, and must stop the script with a
 * non-zero exit instead of passing for a legacy vault that needs no wiring.
 */
import { id } from "ethers";

/** The 4-byte selector of GoldVault.vaultRegistry(), as the dispatcher in the runtime code holds it. */
export const VAULT_REGISTRY_SELECTOR = id("vaultRegistry()").slice(0, 10);

export interface RegistryHookVault {
  getAddress(): Promise<string>;
  vaultRegistry(): Promise<string>;
}

/**
 * The registry the vault points at, or null when the vault's code has no vaultRegistry().
 * Every failure (the code read, or the call on a vault that has the function) is rethrown.
 */
export async function readVaultRegistryHook(vault: RegistryHookVault, getCode: (address: string) => Promise<string>): Promise<string | null> {
  const address = await vault.getAddress();
  const code = (await getCode(address)).toLowerCase();
  if (code === "0x" || code === "") throw new Error(`No contract code at the vault address ${address}`);
  if (!code.includes(VAULT_REGISTRY_SELECTOR.slice(2))) return null;
  return vault.vaultRegistry();
}
