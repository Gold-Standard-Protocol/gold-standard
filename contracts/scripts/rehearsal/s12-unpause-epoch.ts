/**
 * Scenario 12, after the handover: lifting a guardian pause through the 48 hour timelock on the
 * three contracts whose unpause names a pause number, and the race the number exists for.
 *
 *   oracle    GoldOracle.emergencyPause / extendPause / unpause(pauseEpoch)
 *   pool      StabilityPool.emergencyPause / extendPause / unpause(pauseEpoch)
 *   reserve   GoldStabilityReserve.pauseAsset(PAXG) / pauseAsset again / unpauseAsset(PAXG, assetPauseEpoch)
 *
 *   clean     the guardian Safe pauses all three; the proposer Safe schedules one unpause per
 *             contract, each naming the number read at scheduling; the executor Safe runs them
 *             after 48 hours and each hold lifts
 *   race      the same three unpauses are scheduled; half way through the delay the guardian
 *             re-asserts each hold (extendPause on the oracle and the pool, pauseAsset again on
 *             the reserve), which takes a new number; the matured unpauses revert
 *             "Different pause" and every hold stands; governance schedules again naming the
 *             current number and that one lifts; the voided operations are cancelled
 *   lapsed    an extension after the 14 day window has closed takes a new number too, so an
 *             unpause approved for the lapsed pause cannot lift it
 *
 *   LOCAL_RPC_URL=http://127.0.0.1:8547 npx hardhat run --no-compile scripts/rehearsal/s12-unpause-epoch.ts --network localhost
 */
import { Contract, ZeroHash, id } from "ethers";
import type { ContractTransactionResponse, JsonRpcSigner } from "ethers";
import { ADDR, E18, MAX, actors, advance, assert, at, exec, expectRevert, impersonate, latestTs, quote, restamp, rewind, scenario, snapshot } from "./lib";
import type { System } from "./lib";

interface Hold {
  name: string;
  target: string;
  /** How the guardian re-asserts it, for the report. */
  renewal: string;
  pause(by: JsonRpcSigner): Promise<unknown>;
  renew(by: JsonRpcSigner): Promise<unknown>;
  epoch(): Promise<bigint>;
  paused(): Promise<boolean>;
  /** When the hold in force lapses without anyone acting. */
  lapsesAt(): Promise<bigint>;
  unpauseData(epoch: bigint): string;
  /** A direct unpause attempt by `by`, which holds no governance role. */
  directUnpause(by: JsonRpcSigner, epoch: bigint): Promise<unknown>;
}

function holds(sys: System): Hold[] {
  const pausable = (name: string, c: Contract): Hold => ({
    name,
    target: c.target as string,
    renewal: "extendPause()",
    pause: (by) => exec((c.connect(by) as Contract).emergencyPause()),
    renew: (by) => exec((c.connect(by) as Contract).extendPause()),
    epoch: () => c.pauseEpoch(),
    paused: () => c.paused(),
    lapsesAt: () => c.pauseExpiresAt(),
    unpauseData: (epoch) => c.interface.encodeFunctionData("unpause", [epoch]),
    directUnpause: (by, epoch) => (c.connect(by) as Contract).unpause(epoch),
  });
  const reserve: Hold = {
    name: "reserve PAXG",
    target: sys.a.reserve,
    renewal: "pauseAsset(PAXG) again",
    pause: (by) => exec((sys.reserve.connect(by) as Contract).pauseAsset(ADDR.PAXG)),
    renew: (by) => exec((sys.reserve.connect(by) as Contract).pauseAsset(ADDR.PAXG)),
    epoch: () => sys.reserve.assetPauseEpoch(ADDR.PAXG),
    paused: () => sys.reserve.assetPaused(ADDR.PAXG),
    lapsesAt: async () => (await sys.reserve.assets(ADDR.PAXG)).pausedUntil,
    unpauseData: (epoch) => sys.reserve.interface.encodeFunctionData("unpauseAsset", [ADDR.PAXG, epoch]),
    directUnpause: (by, epoch) => (sys.reserve.connect(by) as Contract).unpauseAsset(ADDR.PAXG, epoch),
  };
  return [pausable("oracle", sys.oracle), pausable("pool", sys.pool), reserve];
}

scenario("Scenario 12: unpause(epoch) through the 48 h timelock, and the extension race", async (sys, r) => {
  const GOV = id("GOVERNANCE_ROLE");
  const proposer = await impersonate(sys.c.proposers[0]);
  const executor = await impersonate(sys.c.executors[0]);
  const guardian = await impersonate(sys.c.guardian);
  const keeper = await actors.keeper();
  const bank = await actors.bank();
  const timelock = await at("ExpiringTimelockController", sys.a.timelock);
  const delay: bigint = await timelock.getMinDelay();
  const all = holds(sys);

  const schedule = async (h: Hold, epoch: bigint, label: string): Promise<{ data: string; salt: string; opId: string }> => {
    const data = h.unpauseData(epoch);
    const salt = id(`s12-${label}-${h.name}-${epoch}`);
    await exec((timelock.connect(proposer) as Contract).schedule(h.target, 0, data, ZeroHash, salt, delay));
    return { data, salt, opId: await timelock.hashOperation(h.target, 0, data, ZeroHash, salt) };
  };
  const execute = (h: Hold, op: { data: string; salt: string }, by: JsonRpcSigner = executor): Promise<ContractTransactionResponse> =>
    (timelock.connect(by) as Contract).execute(h.target, 0, op.data, ZeroHash, op.salt);
  /** What each hold stops, read from the outside. */
  const effects = async (): Promise<{ oracle: string; pool: string; reserve: string }> => {
    const tok = await quote(sys, "token");
    let pool = "open";
    try {
      await (sys.pool.connect(bank) as Contract).deposit.staticCall(1_000n * E18);
    } catch (e) {
      pool = (e as { revert?: { name?: string }; reason?: string }).revert?.name ?? (e as { reason?: string }).reason ?? "refused";
    }
    let reserve = "open";
    try {
      await (sys.reserve.connect(bank) as Contract).swapGsusdForGold.staticCall(ADDR.PAXG, 100n * E18, 0);
    } catch (e) {
      reserve = (e as { reason?: string }).reason ?? (e as { revert?: { name?: string } }).revert?.name ?? "refused";
    }
    return { oracle: tok.ok ? "open" : tok.why, pool, reserve };
  };
  await exec((sys.gsusd.connect(bank) as Contract).approve(sys.a.reserve, MAX));

  const epoch0 = await Promise.all(all.map((h) => h.epoch()));

  await r.check("pause:guardian-pauses-oracle-pool-and-reserve-asset", async () => {
    assert(delay === 48n * 3600n, `timelock delay ${delay} s; this scenario rehearses the 48 h launch delay`);
    for (const c of [sys.oracle, sys.pool, sys.reserve]) {
      assert(await c.hasRole(GOV, sys.a.timelock), `the timelock does not govern ${c.target}`);
      assert(await c.hasRole(id("GUARDIAN_ROLE"), sys.c.guardian), `the guardian Safe holds no GUARDIAN_ROLE on ${c.target}`);
    }
    const before = await effects();
    assert(before.oracle === "open" && before.pool === "open", `not open before the pause: ${JSON.stringify(before)}`);
    const stranger = await expectRevert((sys.oracle.connect(keeper) as Contract).emergencyPause(), "Not guardian or governance");
    for (const h of all) await h.pause(guardian);
    const pausedAt = await latestTs();
    const lines: string[] = [];
    for (const [i, h] of all.entries()) {
      const e = await h.epoch();
      assert(await h.paused(), `${h.name} is not paused`);
      assert(e === epoch0[i] + 1n, `${h.name} pause number ${epoch0[i]} -> ${e}; expected one more`);
      const lapse = await h.lapsesAt();
      // The three pauses are three blocks, a second apart on the fork.
      const window = lapse - BigInt(pausedAt);
      assert(window <= 14n * 86_400n && window > 14n * 86_400n - 10n, `${h.name} lapses ${window} s after the pauses, not 14 days`);
      lines.push(`${h.name} number ${epoch0[i]} -> ${e}`);
    }
    const after = await effects();
    assert(after.oracle !== "open" && after.pool !== "open" && after.reserve === "Asset paused", `a hold stops nothing: ${JSON.stringify(after)}`);
    return `keeper emergencyPause: "${stranger}"; guardian Safe paused all three (${lines.join(", ")}), each lapsing 14 days on; price read "${after.oracle}", pool deposit "${after.pool}", reserve swap "${after.reserve}" (before: reserve swap "${before.reserve}")`;
  });

  await r.check("unpause:only-governance-and-only-through-the-timelock", async () => {
    const out: string[] = [];
    for (const h of all) {
      const e = await h.epoch();
      const g = await expectRevert(h.directUnpause(guardian, e), "AccessControlUnauthorizedAccount");
      assert(g.includes(GOV), `${h.name}: guardian unpause refused for another role: ${g}`);
      await expectRevert(h.directUnpause(proposer, e), "AccessControlUnauthorizedAccount");
      await expectRevert(h.directUnpause(executor, e), "AccessControlUnauthorizedAccount");
      const s = await expectRevert((timelock.connect(guardian) as Contract).schedule(h.target, 0, h.unpauseData(e), ZeroHash, id("s12-guardian"), delay), "AccessControlUnauthorizedAccount");
      assert(s.includes(id("PROPOSER_ROLE")), `${h.name}: guardian schedule refused for another role: ${s}`);
      out.push(h.name);
    }
    return `${out.join(", ")}: a direct unpause by the guardian, the proposer and the executor Safe refused for GOVERNANCE_ROLE; the guardian cannot schedule (PROPOSER_ROLE)`;
  });

  let paused = await snapshot();

  await r.check("clean:scheduled-per-contract-executed-after-48h", async () => {
    const ops = [];
    for (const h of all) ops.push(await schedule(h, await h.epoch(), "clean"));
    await advance(Number(delay) - 3600);
    for (const [i, h] of all.entries()) {
      await expectRevert(execute(h, ops[i]), "TimelockUnexpectedOperationState");
      assert(await h.paused(), `${h.name} lifted before the delay`);
    }
    await advance(3_601);
    await restamp();
    const stranger = await expectRevert(execute(all[0], ops[0], keeper as unknown as JsonRpcSigner), "AccessControlUnauthorizedAccount");
    assert(stranger.includes(id("EXECUTOR_ROLE")), `keeper execute refused for another role: ${stranger}`);
    const gas: string[] = [];
    for (const [i, h] of all.entries()) {
      const before = await h.epoch();
      const receipt = await exec(execute(h, ops[i]));
      assert(!(await h.paused()), `${h.name} still paused`);
      assert((await h.epoch()) === before, `${h.name}: lifting changed the pause number`);
      assert(await timelock.isOperationDone(ops[i].opId), `${h.name}: operation not done`);
      gas.push(`${h.name} ${receipt.gasUsed} gas`);
    }
    const after = await effects();
    assert(after.oracle === "open" && after.pool === "open" && after.reserve !== "Asset paused", `still held: ${JSON.stringify(after)}`);
    // A second run of an executed unpause is refused by the timelock, and a fresh one has nothing to lift.
    await expectRevert(execute(all[0], ops[0]), "TimelockUnexpectedOperationState");
    return `47 h in: all three refused "TimelockUnexpectedOperationState" and still paused; after 48 h the keeper is refused (EXECUTOR_ROLE) and the executor Safe lifted each (${gas.join(", ")}); pause numbers unchanged by the lift; price read, pool deposit and reserve swap open again ("${after.reserve}"); an executed unpause cannot run twice`;
  });

  paused = await rewind(paused);
  await r.check("race:extension-during-the-delay-voids-the-scheduled-unpause", async () => {
    const stale = [];
    const named: bigint[] = [];
    for (const h of all) {
      const e = await h.epoch();
      named.push(e);
      stale.push(await schedule(h, e, "race"));
    }
    await advance(Number(delay) / 2);
    const lapseBefore = await Promise.all(all.map((h) => h.lapsesAt()));
    for (const h of all) await h.renew(guardian);
    const lines: string[] = [];
    for (const [i, h] of all.entries()) {
      const e = await h.epoch();
      assert(e === named[i] + 1n, `${h.name}: ${h.renewal} took number ${e}, expected ${named[i] + 1n}`);
      const lapse = await h.lapsesAt();
      assert(lapse > lapseBefore[i], `${h.name}: the window did not restart (${lapseBefore[i]} -> ${lapse})`);
      lines.push(`${h.name} ${h.renewal}: number ${named[i]} -> ${e}`);
    }
    await advance(Number(delay) / 2 + 1);
    await restamp();
    const refusals: string[] = [];
    for (const [i, h] of all.entries()) {
      assert(await timelock.isOperationReady(stale[i].opId), `${h.name}: the stale unpause is not ready`);
      refusals.push(await expectRevert(execute(h, stale[i]), "Different pause"));
      assert(await h.paused(), `${h.name}: the stale unpause lifted the renewed hold`);
      assert(await timelock.isOperationPending(stale[i].opId), `${h.name}: the reverted unpause is no longer pending`);
    }
    const held = await effects();
    assert(held.oracle !== "open" && held.pool !== "open" && held.reserve === "Asset paused", `a hold lifted: ${JSON.stringify(held)}`);

    // Governance schedules again, naming the number in force; the same race is open to a live
    // guardian again, so this is one more full delay.
    const fresh = [];
    for (const h of all) fresh.push(await schedule(h, await h.epoch(), "race-again"));
    await advance(Number(delay) + 1);
    await restamp();
    for (const [i, h] of all.entries()) {
      // The stale approval is still refused, and stays refused once the hold is lifted.
      await expectRevert(execute(h, stale[i]), "Different pause");
      await exec(execute(h, fresh[i]));
      assert(!(await h.paused()), `${h.name} still paused after the second unpause`);
      await expectRevert(execute(h, stale[i]), "Different pause");
    }
    // The voided operations stay pending until they expire; the proposer Safe clears them.
    for (const [i, h] of all.entries()) {
      await exec((timelock.connect(proposer) as Contract).cancel(stale[i].opId));
      assert(!(await timelock.isOperation(stale[i].opId)), `${h.name}: stale unpause still recorded after cancel`);
    }
    const open = await effects();
    assert(open.oracle === "open" && open.pool === "open" && open.reserve !== "Asset paused", `still held: ${JSON.stringify(open)}`);
    return `unpauses scheduled naming ${named.join(", ")}; 24 h in the guardian re-asserted each hold (${lines.join("; ")}), restarting its 14 day window; after 48 h each matured unpause reverted "${refusals[0]}" and every hold stood; a second round naming the new numbers lifted all three ${(2n * delay) / 3600n} h after the first was scheduled; the voided operations cancelled by the proposer Safe`;
  });

  paused = await rewind(paused);
  await r.check("lapsed:an-extension-after-the-window-closed-takes-a-new-number", async () => {
    const h = all[0];
    const named = await h.epoch();
    // Scheduled so that it matures only after the 14 day window has closed.
    const lapse = await h.lapsesAt();
    await advance(Number(lapse) - (await latestTs()) - 3600);
    const op = await schedule(h, named, "lapsed");
    await advance(Number(delay) + 1);
    await restamp();
    assert(await h.paused(), "the oracle pause lifted by itself");
    assert(BigInt(await latestTs()) > lapse, "the window has not closed");
    await h.renew(guardian);
    const e = await h.epoch();
    assert(e === named + 1n, `number ${named} -> ${e}`);
    const refused = await expectRevert(execute(h, op), "Different pause");
    const tooEarly = await expectRevert((sys.oracle.connect(keeper) as Contract).unpauseExpired(), "Pause not expired");
    await advance(14 * 86_400 + 1);
    await restamp();
    await exec((sys.oracle.connect(keeper) as Contract).unpauseExpired());
    assert(!(await h.paused()) && (await h.epoch()) === e, "the lapse did not lift the pause, or changed its number");
    const tok = await quote(sys, "token");
    assert(tok.ok, `price read after the lapse: ${tok.why}`);
    return `oracle unpause naming ${named} matured after the 14 day window closed; the guardian's extendPause() then took number ${e} and restarted the window, so the unpause reverted "${refused}" and unpauseExpired() "${tooEarly}"; 14 days later the keeper lifted it with unpauseExpired(), no key needed; price reads open`;
  });
});
