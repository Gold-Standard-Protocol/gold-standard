/**
 * Withdraw GSUSD surplus above the reserve floor to the operations Safe, to cover
 * infrastructure costs (docs/BUSINESS_MODEL.md section 5, item 4).
 *
 * Works before and after the governance handover. Before it, the signer holds
 * GOVERNANCE_ROLE and one call moves the funds. After it, the timelock holds the role:
 * run once to schedule, again after the 48 hour delay to execute. If the signer is not a
 * timelock proposer or executor (the mainnet Safes are), the script prints the exact
 * transaction for the Safe instead and keeps tracking the operation on later runs. Any
 * funded key can run it; the roles decide what it may do.
 *
 * Without CONFIRM=YES nothing is sent: the run reports the headroom, the step it would
 * take and the operation id. Any amount above (gsusdBalance - effectiveMinGsusdReserve) is
 * refused: the floor is the automatic 2% of supply, or the governed minGsusdReserve if higher.
 * The recipient must be a contract (the Safe) unless WITHDRAW_TO_EOA=YES, and is refused when it
 * is the deployer or the proposer, executor or guardian Safe the snapshot records: the operations
 * Safe is a separate Safe. GSUSD only;
 * collateral held from liquidation penalties stays in the buffer.
 *
 *   WITHDRAW_TO=<ops safe> WITHDRAW_GSUSD=2500 WITHDRAW_MEMO="2026-Q4 infrastructure" \
 *     CONFIRM=YES npx hardhat run scripts/withdraw-surplus.ts --network <net>
 *
 * The memo is required and keeps otherwise identical withdrawals apart; an executed
 * operation cannot be scheduled again under the same recipient, amount and memo.
 *
 * Fork rehearsal (against `npx hardhat node --fork <rpc>`): add FORK_OF=<net> to load that
 * network's snapshot and IMPERSONATE=<address> to act as a proposer, executor or the
 * pre-handover deployer. Both are refused on a real chain.
 *
 *   LOCAL_RPC_URL=http://127.0.0.1:8546 FORK_OF=sepolia IMPERSONATE=<proposer> \
 *     WITHDRAW_TO=... WITHDRAW_GSUSD=... WITHDRAW_MEMO=... CONFIRM=YES \
 *     npx hardhat run scripts/withdraw-surplus.ts --network localhost
 */
import { ethers } from "hardhat";
import { connectDeployment } from "./lib/deploymentContext";
import { runSurplusWithdrawal } from "./lib/surplusWithdrawal";
import { parseWithdrawalEnv, refusedRecipients, summarise } from "./lib/withdrawSurplusCli";
import { describeError } from "./lib/redact";

async function main() {
  const input = parseWithdrawalEnv(process.env);
  const { snapName, snap, signer, fork } = await connectDeployment(input);
  const buffer = await ethers.getContractAt("SurplusBuffer", snap.addresses.surplusBuffer, signer);
  const timelock = await ethers.getContractAt("TimelockController", snap.addresses.timelock, signer);

  console.log(`${snapName}${fork ? " (fork)" : ""}: signer ${await signer.getAddress()}${input.confirm ? "" : " (dry run)"}`);
  const outcome = await runSurplusWithdrawal({
    buffer,
    timelock,
    signer,
    to: input.to,
    amount: input.amount,
    memo: input.memo,
    confirm: input.confirm,
    allowEoaRecipient: input.allowEoaRecipient,
    // The deployer and the governance Safes the snapshot records are never paid, EOA override or not.
    refuseRecipients: refusedRecipients(snap),
    log: (line) => console.log(`  ${line}`),
  });
  console.log(summarise(outcome));
}

main().catch((error) => {
  console.error(describeError(error));
  process.exit(1);
});
