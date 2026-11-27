/**
 * Etherscan source verification for a whole deployment, from its snapshot.
 *
 *   ETHERSCAN_API_KEY=<key> npx hardhat run scripts/verify-etherscan.ts --network mainnet
 *
 * Reads deployments/<network>.json, rebuilds every constructor (scripts/lib/etherscanArgs.ts),
 * reads the CollateralSilo implementation's address from the SiloFactory and submits each
 * contract in turn. Already-verified contracts are reported and skipped, so
 * the script can be re-run until everything shows the green tick. ONLY=<label> verifies a
 * single contract (for example ONLY=TimelockController). Exit code 1 if any contract fails.
 */
import { ethers, network, run } from "hardhat";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { verificationJobs, VerificationSnapshot } from "./lib/etherscanArgs";
import { describeError } from "./lib/redact";

async function main(): Promise<void> {
  if (!process.env.ETHERSCAN_API_KEY?.trim()) throw new Error("ETHERSCAN_API_KEY is not set.");
  const path = resolve(__dirname, "../deployments", `${network.name}.json`);
  const snapshot = JSON.parse(readFileSync(path, "utf8")) as VerificationSnapshot;
  const only = process.env.ONLY?.trim();
  // The implementation the silos are cloned from is created by the factory's constructor, so the
  // snapshot does not hold its address: the factory does.
  const factory = new ethers.Contract(snapshot.addresses.siloFactory ?? ethers.ZeroAddress, ["function siloImplementation() view returns (address)"], ethers.provider);
  const siloImplementation = (await factory.siloImplementation()) as string;
  const jobs = verificationJobs(snapshot, siloImplementation).filter((job) => !only || job.label === only);
  if (jobs.length === 0) throw new Error(`No contract labelled "${only}".`);

  const failed: string[] = [];
  for (const job of jobs) {
    process.stdout.write(`${job.label} at ${job.address}: `);
    try {
      await run("verify:verify", { address: job.address, contract: job.contract, constructorArguments: job.constructorArguments });
      console.log("verified");
    } catch (error) {
      const message = describeError(error);
      if (/already verified/i.test(message)) {
        console.log("already verified");
      } else {
        console.log(`FAILED: ${message.split("\n")[0]}`);
        failed.push(job.label);
      }
    }
  }
  if (failed.length > 0) throw new Error(`Verification failed for: ${failed.join(", ")}. Re-run with ONLY=<label> after fixing.`);
  console.log(`\nAll ${jobs.length} contracts verified on ${network.name}.`);
}

main().catch((error) => {
  console.error(describeError(error));
  process.exit(1);
});
