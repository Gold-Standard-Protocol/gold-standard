/**
 * The closing reminder the ceremony scripts print about the deployer key. Loading the ceremony
 * environment with `set -a; source .env.mainnet; set +a` exports PRIVATE_KEY, RPC_URL and
 * ETHERSCAN_API_KEY to every process started from that shell, and deleting the file afterwards
 * does not unset them. The reminder names the variables; it never prints a value.
 */
export type KeyStage = "deployed" | "handed-over";

const EXPORTED = ["PRIVATE_KEY", "RPC_URL", "ETHERSCAN_API_KEY"] as const;

/** The ceremony steps that still run from the deploy shell, in order; the handover is the last. */
export const REMAINING_CEREMONY_SCRIPTS = ["scripts/verify-deployment.ts", "scripts/verify-etherscan.ts", "scripts/transfer-governance.ts"] as const;

/** The verification the handover names as its next step; it reads through RPC_URL, so it runs before the unset. */
export const POST_HANDOVER_VERIFICATION = "EXPECT_GOVERNANCE_TRANSFERRED=1 npx hardhat run scripts/verify-deployment.ts";

/**
 * Whether the reminder belongs in a script's output: on mainnet, or wherever the ceremony gates
 * are forced on with REQUIRE_PREFLIGHT_RECORD=1. Elsewhere (Sepolia, a fork rehearsal) there is
 * no .env.mainnet in play and telling the operator to delete it would be wrong.
 */
export function keyReminderApplies(chainId: number, requirePreflightRecord: string | undefined): boolean {
  return chainId === 1 || requirePreflightRecord === "1";
}

/** The lines to print once `stage` is complete. */
export function keyReminderLines(stage: KeyStage): string[] {
  const unset = `unset ${EXPORTED.join(" ")}`;
  if (stage === "deployed") {
    const [verify, etherscan, handover] = REMAINING_CEREMONY_SCRIPTS;
    return [
      "Deployer key: this shell still exports PRIVATE_KEY, and the governance handover",
      `(${handover}) is the last step that signs with it. From this shell run only`,
      `the remaining ceremony steps, in this order: ${verify},`,
      `${etherscan} and ${handover}, then the verification the`,
      "handover names. No installs, no builds, nothing else.",
    ];
  }
  return [
    "Deployer key: the handover was the last transaction it signs. Run the verification above",
    `(${POST_HANDOVER_VERIFICATION}) first:`,
    "it still reads through RPC_URL from this shell. Once it has passed, and before anything else:",
    `  1. ${unset}`,
    "  2. delete .env.mainnet",
    "  3. close this shell and open a new one for the services",
    "Deleting the file alone leaves the key exported to every command run from this shell.",
    "The deployer now holds no role; move any ETH left on it from a wallet, then retire the key.",
  ];
}
