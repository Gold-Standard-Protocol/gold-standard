/**
 * Scenario 15, after the handover: the two read-only printers of docs/MAINNET.md section 5, run as
 * an operator runs them, and the transactions they print sent exactly as printed.
 *
 * Each printer runs in its own Hardhat process against the fork. The target and the calldata of
 * every transaction are read from the printed text (the lines an operator pastes into the Safe
 * Transaction Builder) and sent unchanged from the Safe the printer names; nothing is rebuilt here.
 * The stand-in Safes (src/test/mocks/MockSafe.sol) cannot execute, so each is impersonated.
 *
 *   exemption   print-fee-exemption-proposal.ts for a stand-in operations Safe: the proposer
 *               Safe's schedule, the printer run again while it waits, the executor Safe's
 *               execute after 48 hours, the printer run again once it is done; on chain the
 *               account is exempt and its mint pays no origination fee while another's does
 *   seed        print-reserve-seed.ts for 0.05 PAXG, the launch seed, held by the operations Safe: approve, then
 *               seedCollateral; the reserve counts exactly the seed and the allowance is spent
 *   transfer    a plain PAXG transfer to the reserve is NOT counted: collateralBalance and
 *               redeemableCollateral do not move, and governance cannot withdraw it
 *
 *   LOCAL_RPC_URL=http://127.0.0.1:8547 npx hardhat run --no-compile scripts/rehearsal/s15-launch-printers.ts --network localhost
 */
import { Contract, Wallet, id, parseEther } from "ethers";
import type { JsonRpcSigner, TransactionReceipt } from "ethers";
import {
  ADDR, E18, advance, assert, at, deploy, exec, expectRevert, fundPaxg, g18, identity, impersonate, ledger, mintChunks,
  printedTransactions, restamp, runScript, scenario, wallet,
} from "./lib";
import type { PrintedTransaction } from "./lib";

const EXEMPTION = "scripts/print-fee-exemption-proposal.ts";
const SEED = "scripts/print-reserve-seed.ts";
// The launch seed of docs/MAINNET.md section 5.
const SEED_AMOUNT = "0.05";

/** Send a printed transaction, unchanged, from `from`. */
const sendPrinted = (from: JsonRpcSigner, tx: PrintedTransaction): Promise<TransactionReceipt> =>
  exec(from.sendTransaction({ to: tx.to, data: tx.data, value: tx.value }));

function pick(txs: PrintedTransaction[], what: RegExp): PrintedTransaction {
  const hits = txs.filter((t) => what.test(t.title));
  assert(hits.length === 1, `${hits.length} printed transactions match ${what}; titles: ${txs.map((t) => t.title).join(" | ")}`);
  return hits[0];
}

scenario("Scenario 15: the fee exemption and reserve seed printers, sent as printed", async (sys, r) => {
  const proposerSafe: string = sys.c.proposers[0];
  const executorSafe: string = sys.c.executors[0];
  const proposer = await impersonate(proposerSafe);
  const executor = await impersonate(executorSafe);
  const timelock = await at("ExpiringTimelockController", sys.a.timelock);
  const delay: bigint = await timelock.getMinDelay();
  // The operations Safe: a fourth Safe that holds no role (docs/MAINNET.md section 1).
  const opsSafe = await deploy("MockSafe", await wallet("s15-safe-deployer"), Array.from({ length: 3 }, () => Wallet.createRandom().address), 2);
  const ops = await opsSafe.getAddress();
  const opsSigner = await impersonate(ops);
  const env = { EXEMPT_ACCOUNT: ops, EXEMPT_MEMO: "s15 rehearsal" };

  let schedule: PrintedTransaction | undefined;
  let execute: PrintedTransaction | undefined;

  await r.check("exemption:printer-is-read-only-and-names-the-safes", async () => {
    assert(!(await sys.vault.originationFeeExempt(ops)), "the operations Safe is exempt before the scenario");
    const block = await sys.vault.runner!.provider!.getBlockNumber();
    const run = runScript(EXEMPTION, env);
    assert(run.code === 0, `the printer exited ${run.code}: ${run.out.slice(-400)}`);
    assert((await sys.vault.runner!.provider!.getBlockNumber()) === block, "the printer sent a transaction");
    const txs = printedTransactions(run.out);
    schedule = pick(txs, /^1\. Now: .*schedules it:$/);
    execute = pick(txs, /^2\. Then: .*executes it:$/);
    assert(schedule.title.includes(proposerSafe), `transaction 1 does not name the proposer Safe ${proposerSafe}: ${schedule.title}`);
    assert(execute.title.includes(executorSafe), `transaction 2 does not name the executor Safe ${executorSafe}: ${execute.title}`);
    for (const t of [schedule, execute]) {
      assert(t.to.toLowerCase() === sys.a.timelock.toLowerCase() && t.value === 0n, `${t.title} goes to ${t.to} with value ${t.value}`);
    }
    assert(run.out.includes("does not exempt this account now"), "the printer does not report the current state");
    return `${EXEMPTION} for the stand-in operations Safe ${ops} exited 0 and sent nothing; it printed ${txs.length} transactions: "${schedule.title}" and "${execute.title}", both to the timelock with value 0, plus the cancel for an expired operation`;
  });

  await r.check("exemption:printed-schedule-sent-by-the-proposer-safe", async () => {
    assert(schedule && execute, "nothing was printed");
    const wrongSafe = await expectRevert(executor.sendTransaction({ to: schedule.to, data: schedule.data }), "AccessControlUnauthorizedAccount");
    assert(wrongSafe.includes(id("PROPOSER_ROLE")), `the executor Safe's schedule refused for another role: ${wrongSafe}`);
    const receipt = await sendPrinted(proposer, schedule);
    const early = await expectRevert(executor.sendTransaction({ to: execute.to, data: execute.data }), "TimelockUnexpectedOperationState");
    const again = runScript(EXEMPTION, env);
    assert(again.code === 0, `the printer exited ${again.code} while the operation waits: ${again.out.slice(-400)}`);
    assert(again.out.includes("Already scheduled") && /Scheduled\. Executable from /.test(again.out), `the second run does not report the operation as scheduled:\n${again.out}`);
    const reprinted = pick(printedTransactions(again.out), /^2\. Then: .*executes it:$/);
    assert(reprinted.data === execute.data && reprinted.to === execute.to, "the second run prints a different execute transaction");
    assert(!(await sys.vault.originationFeeExempt(ops)), "exempt before the delay");
    return `the printed schedule sent from the executor Safe is refused (PROPOSER_ROLE); sent unchanged from the proposer Safe it landed in block ${receipt.blockNumber} (${receipt.gasUsed} gas); the printed execute at once: "${early.slice(0, 40)}…"; the printer run again reports "Already scheduled" with the exact window and prints the same execute transaction`;
  });

  await r.check("exemption:printed-execute-sent-by-the-executor-safe-after-48h", async () => {
    assert(schedule && execute, "nothing was printed");
    await advance(Number(delay) + 1);
    await restamp();
    const wrongSafe = await expectRevert(proposer.sendTransaction({ to: execute.to, data: execute.data }), "AccessControlUnauthorizedAccount");
    const receipt = await sendPrinted(executor, execute);
    assert(await sys.vault.originationFeeExempt(ops), "originationFeeExempt(operations Safe) is false after the execute");
    const done = runScript(EXEMPTION, env);
    assert(done.code === 0 && done.out.includes("already executed"), `the printer after execution (exit ${done.code}):\n${done.out}`);
    assert(printedTransactions(done.out).length === 0, "the printer still prints transactions for an executed operation");
    return `${delay / 3600n} h later the printed execute from the proposer Safe is refused ("${wrongSafe.slice(0, 40)}…"); sent unchanged from the executor Safe it landed in block ${receipt.blockNumber} (${receipt.gasUsed} gas); GoldVault.originationFeeExempt(${ops}) reads true; the printer now reports the operation as already executed and prints nothing to sign`;
  });

  await r.check("exemption:the-exempt-safe-mints-without-the-fee-others-pay-it", async () => {
    const feeBps = BigInt(await sys.vault.originationFeeBps());
    assert(feeBps > 0n, "no origination fee is set; the exemption would show nothing");
    const amount = 10_000n * E18;
    const got = await fundPaxg(sys, ops, 10n * E18);
    await exec((sys.paxg.connect(opsSigner) as Contract).approve(sys.a.vault, got));
    await exec((sys.vault.connect(opsSigner) as Contract).deposit(ADDR.PAXG, got));
    const buffer0: bigint = await sys.buffer.gsusdBalance();
    await mintChunks(sys, opsSigner, amount);
    const received: bigint = await sys.gsusd.balanceOf(ops);
    assert(received === amount, `the exempt Safe received ${received} of a ${amount} mint`);
    assert((await sys.buffer.gsusdBalance()) === buffer0, "the buffer banked a fee from the exempt mint");
    const other = await wallet("s15-other");
    const otherGot = await fundPaxg(sys, other.address, 10n * E18);
    await exec((sys.paxg.connect(other) as Contract).approve(sys.a.vault, otherGot));
    await exec((sys.vault.connect(other) as Contract).deposit(ADDR.PAXG, otherGot));
    await mintChunks(sys, other, amount);
    const fee = (amount * feeBps) / 10_000n;
    const otherReceived: bigint = await sys.gsusd.balanceOf(other.address);
    assert(otherReceived === amount - fee, `another account received ${otherReceived}, expected ${amount - fee}`);
    assert((await sys.buffer.gsusdBalance()) === buffer0 + fee, "the buffer did not bank the other account's fee");
    identity(await ledger(sys));
    return `the operations Safe deposited 10 PAXG and minted 10,000 GSUSD: received exactly 10,000, the buffer banked nothing; another account minting the same received ${g18(otherReceived, 2)} and the buffer banked the ${g18(fee, 2)} GSUSD fee (${feeBps} bps); identity holds`;
  });

  let approve: PrintedTransaction | undefined;
  let seed: PrintedTransaction | undefined;
  const seedAmount = parseEther(SEED_AMOUNT);

  await r.check("seed:printer-refuses-a-safe-without-the-gold-then-prints-two-transactions", async () => {
    const seedEnv = { SEED_AMOUNT, SEED_FROM: ops };
    const short = runScript(SEED, seedEnv);
    assert(short.code !== 0 && /holds less than/.test(short.out) && printedTransactions(short.out).length === 0, `with no PAXG in the Safe the printer exited ${short.code}:\n${short.out}`);
    await fundPaxg(sys, ops, 30n * E18);
    const block = await sys.vault.runner!.provider!.getBlockNumber();
    const run = runScript(SEED, seedEnv);
    assert(run.code === 0, `the printer exited ${run.code}: ${run.out.slice(-400)}`);
    assert((await sys.vault.runner!.provider!.getBlockNumber()) === block, "the printer sent a transaction");
    const txs = printedTransactions(run.out);
    assert(txs.length === 2, `${txs.length} transactions printed, expected 2`);
    approve = pick(txs, /^1\. .*\(approve\):$/);
    seed = pick(txs, /^2\. .*\(seedCollateral\):$/);
    assert(approve.to.toLowerCase() === ADDR.PAXG.toLowerCase() && approve.value === 0n, `transaction 1 goes to ${approve.to}`);
    assert(seed.to.toLowerCase() === sys.a.reserve.toLowerCase() && seed.value === 0n, `transaction 2 goes to ${seed.to}`);
    assert(/plain transfer|directly/i.test(run.out), "the printer does not warn against a plain transfer");
    return `with no PAXG in SEED_FROM the printer exits ${short.code} and prints nothing to sign; with 30 PAXG there it exits 0, sends nothing, warns against a plain transfer and prints "${approve.title}" to the token and "${seed.title}" to the reserve`;
  });

  await r.check("seed:printed-transactions-sent-by-the-operations-safe-the-reserve-counts-the-seed", async () => {
    assert(approve && seed, "nothing was printed");
    const counted0: bigint = await sys.reserve.collateralBalance(ADDR.PAXG);
    const held0: bigint = await sys.paxg.balanceOf(sys.a.reserve);
    const redeemable0: bigint = await sys.reserve.redeemableCollateral(ADDR.PAXG);
    const seeded0: bigint = await sys.reserve.totalGoldSeeded(ADDR.PAXG);
    const ops0: bigint = await sys.paxg.balanceOf(ops);
    const unapproved = await expectRevert(opsSigner.sendTransaction({ to: seed.to, data: seed.data }));
    await sendPrinted(opsSigner, approve);
    const allowance: bigint = await new Contract(ADDR.PAXG, ["function allowance(address,address) view returns (uint256)"], sys.paxg.runner).allowance(ops, sys.a.reserve);
    assert(allowance === seedAmount, `the printed approve allows ${allowance}, not ${seedAmount}`);
    const receipt = await sendPrinted(opsSigner, seed);
    const counted: bigint = await sys.reserve.collateralBalance(ADDR.PAXG);
    const held: bigint = await sys.paxg.balanceOf(sys.a.reserve);
    assert(counted - counted0 === seedAmount, `the reserve counts ${counted - counted0} more, the seed was ${seedAmount}`);
    assert(held - held0 === seedAmount && ops0 - (await sys.paxg.balanceOf(ops)) === seedAmount, "the tokens moved do not match the seed");
    assert((await sys.reserve.redeemableCollateral(ADDR.PAXG)) - redeemable0 === seedAmount, "redeemableCollateral did not rise by the seed");
    assert((await sys.reserve.totalGoldSeeded(ADDR.PAXG)) - seeded0 === seedAmount, "totalGoldSeeded did not rise by the seed");
    const left: bigint = await new Contract(ADDR.PAXG, ["function allowance(address,address) view returns (uint256)"], sys.paxg.runner).allowance(ops, sys.a.reserve);
    assert(left === 0n, `allowance ${left} left after the seed`);
    assert(counted === held, `the reserve counts ${counted} and holds ${held}`);
    const verify = runScript("scripts/verify-deployment.ts", { EXPECT_GOVERNANCE_TRANSFERRED: "1" });
    assert(verify.code === 0, `verify-deployment.ts after the seed exited ${verify.code}:\n${verify.out.slice(-1200)}`);
    identity(await ledger(sys));
    return `the printed seedCollateral before the approve: "${unapproved.slice(0, 60)}"; both sent unchanged from the operations Safe (seed in block ${receipt.blockNumber}, ${receipt.gasUsed} gas): collateralBalance(PAXG) ${g18(counted0, 4)} -> ${g18(counted, 4)}, exactly +${SEED_AMOUNT}; redeemableCollateral and totalGoldSeeded +${SEED_AMOUNT}; allowance back to 0; counted = held; verify-deployment.ts passes afterwards; identity holds`;
  });

  await r.check("transfer:a-plain-transfer-to-the-reserve-is-not-counted", async () => {
    const stray = 5n * E18;
    const counted0: bigint = await sys.reserve.collateralBalance(ADDR.PAXG);
    const held0: bigint = await sys.paxg.balanceOf(sys.a.reserve);
    const redeemable0: bigint = await sys.reserve.redeemableCollateral(ADDR.PAXG);
    await exec((sys.paxg.connect(opsSigner) as Contract).transfer(sys.a.reserve, stray));
    const counted: bigint = await sys.reserve.collateralBalance(ADDR.PAXG);
    const held: bigint = await sys.paxg.balanceOf(sys.a.reserve);
    assert(held - held0 === stray, `the reserve's token balance rose ${held - held0}`);
    assert(counted === counted0, `collateralBalance moved ${counted0} -> ${counted} on a plain transfer`);
    assert((await sys.reserve.redeemableCollateral(ADDR.PAXG)) === redeemable0, "redeemableCollateral moved on a plain transfer");
    // Governance can withdraw counted gold only, so the stray tokens stay out of reach.
    const gov = await impersonate(sys.a.timelock);
    const all = await expectRevert((sys.reserve.connect(gov) as Contract).withdrawCollateral(ADDR.PAXG, ops, held), "Exceeds balance");
    const verify = runScript("scripts/verify-deployment.ts", { EXPECT_GOVERNANCE_TRANSFERRED: "1" });
    r.info("transfer:verify-deployment-after-a-stray-transfer", `exit ${verify.code}: ${(verify.out.match(/^.*(All verification|FAILED|failed).*$/m) ?? ["no summary line"])[0].trim().slice(0, 200)}`);
    return `5 PAXG sent to the reserve with a plain transfer: balanceOf +5 (${g18(held, 4)}), collateralBalance unchanged (${g18(counted, 4)}), redeemableCollateral unchanged; a timelock withdrawCollateral of the whole token balance: "${all}" (only counted gold can leave, so the 5 PAXG is stranded)`;
  });

});
