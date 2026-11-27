/**
 * Scenario 16, after the handover: scripts/withdraw-surplus.ts on the final contracts, run as
 * docs/LAUNCH.md describes for a fork (FORK_OF and IMPERSONATE), with a stand-in operations Safe
 * as WITHDRAW_TO. Every run is the script itself in its own Hardhat process; this file only sets
 * the scene, lets the delay pass and reads the chain afterwards.
 *
 * The buffer holds less than its 2% floor at the baseline, so the scene first lets two years of
 * stability fee accrue and has the bank repay, which banks the fee (the only way GSUSD reaches
 * the buffer's counted balance).
 *
 *   refusals   WITHDRAW_TO equal to the deployer, the proposer, executor or guardian Safe, the
 *              timelock, the buffer or an address without code is refused before anything is
 *              read or sent; so are a missing memo and an amount above the headroom
 *   dry run    without CONFIRM=YES nothing is sent
 *   no role    a key holding no role is handed the proposer Safe's call and sends nothing
 *   schedule   IMPERSONATE=<proposer Safe> CONFIRM=YES schedules; a second run waits
 *   execute    48 hours later IMPERSONATE=<executor Safe> CONFIRM=YES executes: the operations
 *              Safe receives the amount, the buffer stays at or above its floor; a further run
 *              reports the withdrawal as done
 *
 *   LOCAL_RPC_URL=http://127.0.0.1:8547 npx hardhat run --no-compile scripts/rehearsal/s16-withdraw-surplus.ts --network localhost
 */
import { Contract, Wallet } from "ethers";
import { YEAR_SECONDS, actors, advance, assert, deploy, exec, g18, identity, ledger, provider, restamp, runScript, scenario, wallet } from "./lib";
import type { ScriptRun } from "./lib";

const SCRIPT = "scripts/withdraw-surplus.ts";
const MEMO = "s16 rehearsal";

scenario("Scenario 16: withdraw-surplus.ts with FORK_OF and IMPERSONATE, to the operations Safe", async (sys, r) => {
  const proposerSafe: string = sys.c.proposers[0];
  const executorSafe: string = sys.c.executors[0];
  const guardianSafe: string = sys.c.guardian;
  const deployer: string = sys.snap.deployer;
  const bank = await actors.bank();
  const keeper = await actors.keeper();
  const opsSafe = await deploy("MockSafe", await wallet("s16-safe-deployer"), Array.from({ length: 3 }, () => Wallet.createRandom().address), 2);
  const ops = await opsSafe.getAddress();
  const delay: bigint = await sys.timelock.getMinDelay();

  const run = (as: string, to: string, gsusd: string, extra: Record<string, string> = {}): ScriptRun =>
    runScript(SCRIPT, { FORK_OF: "localhost", IMPERSONATE: as, WITHDRAW_TO: to, WITHDRAW_GSUSD: gsusd, WITHDRAW_MEMO: MEMO, CONFIRM: "", WITHDRAW_TO_EOA: "", ...extra });
  const lastLine = (o: ScriptRun): string => o.out.trim().split("\n").pop()!.trim();
  const headroom = async (): Promise<{ counted: bigint; floor: bigint; free: bigint }> => {
    const [counted, floor]: bigint[] = await Promise.all([sys.buffer.gsusdBalance(), sys.buffer.effectiveMinGsusdReserve()]);
    return { counted, floor, free: counted > floor ? counted - floor : 0n };
  };

  let amount = "";
  let amountWei = 0n;

  await r.check("scene:fees-banked-above-the-floor", async () => {
    const before = await headroom();
    // Two years of stability fee, then a repayment: the fee part goes to the buffer.
    await advance(2 * YEAR_SECONDS);
    await restamp();
    const float: bigint = await sys.gsusd.balanceOf(bank.address);
    await exec((sys.vault.connect(bank) as Contract).repay(float - 1_000n * 10n ** 18n));
    // The floor follows the one-day smoothed supply, so let the repayment's burn age out.
    await advance(86_400 + 60);
    await restamp();
    const after = await headroom();
    assert(after.free >= 2_000n * 10n ** 18n, `only ${g18(after.free)} GSUSD above the floor after the fees were banked`);
    // Half the headroom, in whole GSUSD.
    amountWei = (after.free / 2n / 10n ** 18n) * 10n ** 18n;
    amount = (amountWei / 10n ** 18n).toString();
    return `baseline buffer ${g18(before.counted, 2)} GSUSD against a ${g18(before.floor, 2)} floor (${g18(before.free, 2)} withdrawable); two years on the bank repaid ${g18(float - 1_000n * 10n ** 18n, 0)} GSUSD: buffer ${g18(after.counted, 2)}, floor ${g18(after.floor, 2)}, withdrawable ${g18(after.free, 2)}; this scenario withdraws ${amount}`;
  });

  await r.check("refusals:recipient-is-the-deployer-or-a-governance-safe", async () => {
    const block = await provider.getBlockNumber();
    const cases: Array<[string, string, RegExp, Record<string, string>]> = [
      ["the deployer", deployer, /is the deployer\./, {}],
      ["the deployer with WITHDRAW_TO_EOA=YES", deployer, /is the deployer\./, { WITHDRAW_TO_EOA: "YES" }],
      ["the proposer Safe", proposerSafe, /is the proposer Safe\./, {}],
      ["the executor Safe", executorSafe, /is the executor Safe\./, {}],
      ["the guardian Safe", guardianSafe, /is the guardian Safe\./, {}],
      ["the timelock", sys.a.timelock, /Recipient is the timelock\./, {}],
      ["the buffer", sys.a.surplusBuffer, /Recipient is the buffer itself\./, {}],
      ["an address without code", keeper.address, /has no code\./, {}],
    ];
    const seen: string[] = [];
    for (const [label, to, want, extra] of cases) {
      for (const as of [proposerSafe, executorSafe]) {
        const o = run(as, to, amount, { CONFIRM: "YES", ...extra });
        assert(o.code !== 0 && want.test(o.out), `WITHDRAW_TO = ${label} as ${as}: exit ${o.code}\n${o.out}`);
        assert(!/Scheduled|Withdrawal complete|schedule\(/.test(o.out), `WITHDRAW_TO = ${label}: something was scheduled or handed out\n${o.out}`);
      }
      seen.push(label);
    }
    const noMemo = run(proposerSafe, ops, amount, { CONFIRM: "YES", WITHDRAW_MEMO: "" });
    assert(noMemo.code !== 0 && /WITHDRAW_MEMO/.test(noMemo.out), `no memo: exit ${noMemo.code}\n${noMemo.out}`);
    const tooMuch = run(proposerSafe, ops, ((await headroom()).free / 10n ** 18n + 1n).toString(), { CONFIRM: "YES" });
    assert(tooMuch.code !== 0 && /exceeds the .* above the floor/.test(tooMuch.out), `above the headroom: exit ${tooMuch.code}\n${tooMuch.out}`);
    const notFork = runScript(SCRIPT, { FORK_OF: "", IMPERSONATE: proposerSafe, WITHDRAW_TO: ops, WITHDRAW_GSUSD: amount, WITHDRAW_MEMO: MEMO, CONFIRM: "YES" });
    assert(notFork.code !== 0 && /IMPERSONATE only works on a fork/.test(notFork.out), `IMPERSONATE without FORK_OF: exit ${notFork.code}\n${notFork.out}`);
    assert((await provider.getBlockNumber()) === block, "a refused run sent a transaction");
    return `with CONFIRM=YES, as the proposer Safe and as the executor Safe, each refused with exit 1 and nothing sent: WITHDRAW_TO = ${seen.join(", ")}; also refused: no WITHDRAW_MEMO, an amount one GSUSD above the headroom ("${lastLine(tooMuch).slice(0, 90)}"), IMPERSONATE without FORK_OF`;
  });

  await r.check("dry-run-and-a-key-without-a-role-send-nothing", async () => {
    const block = await provider.getBlockNumber();
    const dry = run(proposerSafe, ops, amount);
    assert(dry.code === 0 && /Dry run: nothing sent/.test(dry.out), `dry run: exit ${dry.code}\n${dry.out}`);
    const noRole = run(keeper.address, ops, amount, { CONFIRM: "YES" });
    assert(noRole.code === 0 && /Waiting on the proposer Safe to schedule/.test(noRole.out), `no role: exit ${noRole.code}\n${noRole.out}`);
    assert((await provider.getBlockNumber()) === block, "a dry run or a key without a role sent a transaction");
    return `as the proposer Safe without CONFIRM=YES: "${lastLine(dry)}"; as the keeper (no role) with CONFIRM=YES: "${lastLine(noRole)}"; no transaction either time`;
  });

  await r.check("schedule:by-the-proposer-safe-then-wait", async () => {
    const byExecutor = run(executorSafe, ops, amount, { CONFIRM: "YES" });
    assert(byExecutor.code === 0 && /Waiting on the proposer Safe to schedule/.test(byExecutor.out), `the executor Safe before a schedule: exit ${byExecutor.code}\n${byExecutor.out}`);
    const scheduled = run(proposerSafe, ops, amount, { CONFIRM: "YES" });
    assert(scheduled.code === 0 && /^Scheduled\. Run the same command again after the delay to execute\.$/m.test(scheduled.out), `schedule: exit ${scheduled.code}\n${scheduled.out}`);
    const waiting = run(executorSafe, ops, amount, { CONFIRM: "YES" });
    assert(waiting.code === 0 && /Still inside the delay/.test(waiting.out), `inside the delay: exit ${waiting.code}\n${waiting.out}`);
    assert((await sys.gsusd.balanceOf(ops)) === 0n, "the operations Safe was paid before the delay");
    return `the executor Safe first: "${lastLine(byExecutor)}"; IMPERSONATE=<proposer Safe> CONFIRM=YES: "${lastLine(scheduled)}"; the executor Safe at once: "${lastLine(waiting)}"`;
  });

  await r.check("execute:by-the-executor-safe-after-48h-the-operations-safe-is-paid", async () => {
    await advance(Number(delay) + 1);
    await restamp();
    const before = await headroom();
    const supply0: bigint = await sys.gsusd.totalSupply();
    const byProposer = run(proposerSafe, ops, amount, { CONFIRM: "YES" });
    assert(byProposer.code === 0 && /Waiting on the executor Safe to execute/.test(byProposer.out), `the proposer Safe after the delay: exit ${byProposer.code}\n${byProposer.out}`);
    const executed = run(executorSafe, ops, amount, { CONFIRM: "YES" });
    assert(executed.code === 0 && /^Withdrawal complete\.$/m.test(executed.out), `execute: exit ${executed.code}\n${executed.out}`);
    const paid: bigint = await sys.gsusd.balanceOf(ops);
    const after = await headroom();
    assert(paid === amountWei, `the operations Safe holds ${paid}, the withdrawal was ${amountWei}`);
    assert(before.counted - after.counted === amountWei, `the buffer's counted balance fell ${before.counted - after.counted}`);
    assert(after.counted >= after.floor, `the buffer ${after.counted} is under its floor ${after.floor}`);
    assert((await sys.gsusd.totalSupply()) === supply0, "supply changed on a withdrawal");
    const done = run(executorSafe, ops, amount, { CONFIRM: "YES" });
    assert(done.code === 0 && /Nothing to do: this withdrawal already executed/.test(done.out), `after execution: exit ${done.code}\n${done.out}`);
    assert((await sys.gsusd.balanceOf(ops)) === amountWei, "a second run paid again");
    identity(await ledger(sys));
    return `${delay / 3600n} h later the proposer Safe: "${lastLine(byProposer)}"; IMPERSONATE=<executor Safe> CONFIRM=YES: "${lastLine(executed)}"; the operations Safe ${ops} holds exactly ${amount} GSUSD; buffer ${g18(before.counted, 2)} -> ${g18(after.counted, 2)}, floor ${g18(after.floor, 2)}; supply unchanged; the same command again: "${lastLine(done)}"; identity holds`;
  });
});
