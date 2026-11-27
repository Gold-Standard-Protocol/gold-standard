/**
 * Fork rehearsal, before the preflight: three stand-in Safes (src/test/mocks/MockSafe.sol, the two
 * views the preflight reads) with distinct owner sets and the plan's thresholds: proposer 2-of-3,
 * executor 2-of-3, guardian 2-of-3. Deployed from a throwaway wallet, so the deployer key stays
 * as fresh as the ceremony allows. Prints the three TIMELOCK_* lines for the fork environment.
 *
 *   LOCAL_RPC_URL=http://127.0.0.1:8547 npx hardhat run --no-compile scripts/rehearsal/setup-safes.ts --network localhost
 */
import { Wallet } from "ethers";
import { assertFork, deploy, wallet } from "./lib";
import { describeErrorStack } from "../lib/redact";

async function main(): Promise<void> {
  const fork = await assertFork();
  const from = await wallet("safe-deployer");
  const owners = (n: number): string[] => Array.from({ length: n }, () => Wallet.createRandom().address);
  const proposer = await deploy("MockSafe", from, owners(3), 2);
  const executor = await deploy("MockSafe", from, owners(3), 2);
  const guardian = await deploy("MockSafe", from, owners(3), 2);
  console.log(`Stand-in Safes on the fork (chain ${fork.chainId}, block ${fork.block}):`);
  console.log(`TIMELOCK_PROPOSER=${await proposer.getAddress()}`);
  console.log(`TIMELOCK_EXECUTOR=${await executor.getAddress()}`);
  console.log(`TIMELOCK_GUARDIAN=${await guardian.getAddress()}`);
}

main().catch((e) => {
  console.error(describeErrorStack(e));
  process.exit(1);
});
