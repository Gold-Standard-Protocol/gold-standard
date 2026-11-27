/**
 * Scenario 13, after the handover: replacing PAXG's market feed (source C) through the
 * GoldGovernance wrapper, GoldGovernance.proposeOracleFeedUpdate("PAXG", feed), and what the
 * oracle answers before, during and after the 48 hour delay.
 *
 * The replacement is a stand-in (MockChainlinkFeed "PAXG / USD replacement"): this rehearses the
 * procedure, not a source. It answers 0.3% above the feed in place, so every price path shows
 * which feed it read.
 *
 *   before   the oracle reads the feed in place; only the proposer Safe can propose; an unknown
 *            feed name and the zero address are refused at proposal time
 *   during   the proposal is pending: the oracle still follows the old feed and ignores the new
 *            one; executeProposal is refused before 48 hours and to anyone but the executor Safe
 *   after    the executor Safe runs executeProposal on the wrapper: feeds(PAXG) names the new
 *            feed, every price path follows it and ignores the old one, lastKnownPrice and the
 *            PAXG positions are untouched, and a replacement that goes stale stops the reads
 *   refused  a proposal naming the gold reference as PAXG's feed is accepted by the wrapper and
 *            refused by the oracle at execution ("Feed not independent")
 *
 *   LOCAL_RPC_URL=http://127.0.0.1:8547 npx hardhat run --no-compile scripts/rehearsal/s13-feed-replacement.ts --network localhost
 */
import { Contract, ZeroAddress, id, toBeHex } from "ethers";
import type { TransactionReceipt } from "ethers";
import {
  ADDR, E18, FEEDS, actors, advance, assert, at, colId, deploy, exec, expectRevert, identity, impersonate, latestTs, ledger, market,
  quote, readFeed, restamp, scale, scenario, showQuote, usd8, variantC, wallet,
} from "./lib";
import type { System } from "./lib";

interface Prices { token: string; borrow: string; reserve: string; valuation: string }

async function prices(sys: System): Promise<Prices> {
  const [token, borrow, reserve, valuation] = await Promise.all([quote(sys, "token"), quote(sys, "borrow"), quote(sys, "reserve"), quote(sys, "valuation")]);
  return { token: showQuote(token), borrow: showQuote(borrow), reserve: showQuote(reserve), valuation: showQuote(valuation) };
}

function expected(c: bigint, g: bigint, band: bigint, clamp: bigint): Prices {
  const v = variantC(c, g, band, clamp);
  const show = (x: bigint | undefined): string => (x === undefined ? "refused" : usd8(x));
  return { token: show(v.liq), borrow: show(v.borrow), reserve: show(v.reserve), valuation: show(v.valuation) };
}

const same = (a: Prices, b: Prices): boolean => a.token === b.token && a.borrow === b.borrow && a.reserve === b.reserve && a.valuation === b.valuation;
const line = (p: Prices): string => `liquidation ${p.token}, borrowing ${p.borrow}, reserve ${p.reserve}, valuation ${p.valuation}`;

scenario("Scenario 13: PAXG feed replacement through the governance wrapper (48 h)", async (sys, r) => {
  const proposer = await impersonate(sys.c.proposers[0]);
  const executor = await impersonate(sys.c.executors[0]);
  const keeper = await actors.keeper();
  const bank = await actors.bank();
  const wrapper = await at("GoldGovernance", sys.a.governance);
  const timelock = await at("ExpiringTimelockController", sys.a.timelock);
  const delay: bigint = await timelock.getMinDelay();
  const band: bigint = await sys.oracle.goldBandPpm(ADDR.PAXG);
  const clamp: bigint = await sys.oracle.liquidationClampPpm(ADDR.PAXG);
  const operator = await wallet("s13-feed-operator", 100n);
  const replacement = await deploy("MockChainlinkFeed", operator, 8, "PAXG / USD replacement");
  const newFeed = await replacement.getAddress();
  const stampNew = async (answer: bigint, age = 0): Promise<void> => {
    const [rid] = await replacement.latestRoundData();
    const stamp = BigInt(await latestTs()) - BigInt(age);
    await exec(replacement.setLatestRoundData(rid + 1n, answer, stamp, stamp, rid + 1n));
  };
  const base = await market({});
  const NEW_RATIO = 1_003_000n;
  await stampNew(scale(base.C, NEW_RATIO));

  const proposed = (receipt: TransactionReceipt): { opId: string; target: string; data: string } => {
    for (const log of receipt.logs) {
      try {
        const parsed = wrapper.interface.parseLog(log);
        if (parsed?.name === "ProposalCreated") return { opId: parsed.args[0], target: parsed.args[1], data: parsed.args[2] };
      } catch {
        /* the timelock's own log */
      }
    }
    throw new Error("no ProposalCreated event");
  };

  let feedBefore = "";
  let lastKnownBefore = 0n;
  let op = { opId: "", target: "", data: "" };
  let salt = "";
  let rejected = { opId: "", target: "", data: "" };
  let rejectedSalt = "";

  await r.check("before:the-oracle-reads-the-feed-in-place", async () => {
    assert(delay === 48n * 3600n, `timelock delay ${delay} s; this scenario rehearses the 48 h launch delay`);
    assert((await wrapper.oracle()).toLowerCase() === sys.a.oracle.toLowerCase(), "the wrapper governs another oracle");
    feedBefore = (await sys.oracle.feeds(ADDR.PAXG))[0];
    assert(feedBefore.toLowerCase() === FEEDS.C.toLowerCase(), `PAXG's feed is ${feedBefore}, not the Chainlink PAXG/USD proxy`);
    // Refresh the oracle's record so its survival is observable.
    await exec((sys.oracle.connect(keeper) as Contract).getTokenPrice(ADDR.PAXG));
    lastKnownBefore = (await sys.oracle.feeds(ADDR.PAXG)).lastKnownPrice ?? 0n;
    const now = await prices(sys);
    const want = expected(base.C, base.G, band, clamp);
    assert(same(now, want), `oracle ${line(now)}; the rules give ${line(want)}`);
    return `feeds(PAXG) = ${feedBefore} (Chainlink PAXG/USD proxy), C ${usd8(base.C)}, G ${usd8(base.G)}: ${line(now)}; replacement ${newFeed} answers ${usd8(scale(base.C, NEW_RATIO))}`;
  });

  await r.check("propose:only-the-proposer-and-only-a-known-feed", async () => {
    const stranger = await expectRevert((wrapper.connect(keeper) as Contract).proposeOracleFeedUpdate("PAXG", newFeed), "AccessControlUnauthorizedAccount");
    assert(stranger.includes(id("PROPOSER_ROLE")), `keeper propose refused for another role: ${stranger}`);
    const byExecutor = await expectRevert((wrapper.connect(executor) as Contract).proposeOracleFeedUpdate("PAXG", newFeed), "AccessControlUnauthorizedAccount");
    const unknown = await expectRevert((wrapper.connect(proposer) as Contract).proposeOracleFeedUpdate("GOLD", newFeed), "Unknown feed");
    const zero = await expectRevert((wrapper.connect(proposer) as Contract).proposeOracleFeedUpdate("PAXG", ZeroAddress), "Zero address");
    const nonce: bigint = await wrapper.proposalNonce();
    salt = toBeHex(nonce, 32);
    op = proposed(await exec((wrapper.connect(proposer) as Contract).proposeOracleFeedUpdate("PAXG", newFeed)));
    assert(op.target.toLowerCase() === sys.a.oracle.toLowerCase(), `the proposal targets ${op.target}`);
    assert(op.data === sys.oracle.interface.encodeFunctionData("setPaxgFeed", [newFeed]), "the proposal is not setPaxgFeed(replacement)");
    assert(op.opId === (await timelock.hashOperation(op.target, 0, op.data, toBeHex(0, 32), salt)), "the operation id is not the timelock's hash under the wrapper's nonce salt");
    assert(await timelock.isOperationPending(op.opId), "the timelock holds no pending operation");
    // A second proposal, accepted by the wrapper, that the oracle itself will refuse.
    rejectedSalt = toBeHex(await wrapper.proposalNonce(), 32);
    rejected = proposed(await exec((wrapper.connect(proposer) as Contract).proposeOracleFeedUpdate("PAXG", FEEDS.G)));
    return `keeper: "${stranger.slice(0, 40)}…" (PROPOSER_ROLE); executor Safe: "${byExecutor.slice(0, 40)}…"; name "GOLD": "${unknown}"; zero address: "${zero}"; proposer Safe proposed setPaxgFeed(${newFeed}) as operation ${op.opId.slice(0, 10)}… (salt = proposalNonce ${nonce}), ready at ${await timelock.getTimestamp(op.opId)}`;
  });

  await r.check("during:the-oracle-still-follows-the-old-feed", async () => {
    await advance(Number(delay) - 3600);
    // Both feeds move apart: the old one up 0.4%, the new one down 0.4%.
    const m = await market({ C: scale(base.C, 1_004_000n) });
    await stampNew(scale(base.C, 996_000n));
    assert(((await sys.oracle.feeds(ADDR.PAXG))[0] as string).toLowerCase() === feedBefore.toLowerCase(), "the feed changed before execution");
    const now = await prices(sys);
    const want = expected(m.C, m.G, band, clamp);
    assert(same(now, want), `oracle ${line(now)}; the old feed gives ${line(want)}`);
    const early = await expectRevert((wrapper.connect(executor) as Contract).executeProposal(op.target, op.data, salt), "TimelockUnexpectedOperationState");
    const direct = await expectRevert((sys.oracle.connect(proposer) as Contract).setPaxgFeed(newFeed), "AccessControlUnauthorizedAccount");
    await market({ C: base.C });
    await stampNew(scale(base.C, NEW_RATIO));
    return `47 h in, old feed moved to ${usd8(m.C)} and the replacement to ${usd8(scale(base.C, 996_000n))}: ${line(now)}, the old feed's prices; executeProposal "${early.slice(0, 40)}…"; a direct setPaxgFeed by the proposer Safe "${direct.slice(0, 40)}…"`;
  });

  await r.check("after:executed-by-the-executor-the-oracle-follows-the-new-feed", async () => {
    await advance(3_601);
    const m = await restamp();
    await stampNew(scale(base.C, NEW_RATIO));
    const state = async (): Promise<string> => JSON.stringify([(await sys.vault.vaults(bank.address)).map(String), String((await sys.vault.collateralTypes(colId(ADDR.PAXG))).liquidationRatio), String(await sys.oracle.goldBandPpm(ADDR.PAXG)), String(await sys.oracle.liquidationClampPpm(ADDR.PAXG)), String(await sys.oracle.stalenessThreshold())]);
    const before = await state();
    const stranger = await expectRevert((wrapper.connect(keeper) as Contract).executeProposal(op.target, op.data, salt), "Not executor");
    const byProposer = await expectRevert((wrapper.connect(proposer) as Contract).executeProposal(op.target, op.data, salt), "Not executor");
    const receipt = await exec((wrapper.connect(executor) as Contract).executeProposal(op.target, op.data, salt));
    assert(await timelock.isOperationDone(op.opId), "operation not done");
    const feed = await sys.oracle.feeds(ADDR.PAXG);
    assert((feed[0] as string).toLowerCase() === newFeed.toLowerCase(), `feeds(PAXG) is ${feed[0]}`);
    assert((feed.lastKnownPrice ?? 0n) === lastKnownBefore, `lastKnownPrice ${lastKnownBefore} -> ${feed.lastKnownPrice}`);
    assert((await state()) === before, "the bank's vault or the oracle's parameters changed");
    const cNew = scale(base.C, NEW_RATIO);
    const now = await prices(sys);
    const want = expected(cNew, m.G, band, clamp);
    assert(same(now, want), `oracle ${line(now)}; the new feed gives ${line(want)}`);
    // The old proxy no longer moves anything.
    await market({ C: scale(base.C, 900_000n) });
    const ignored = await prices(sys);
    assert(same(ignored, want), `the old feed still moves the oracle: ${line(ignored)}`);
    await market({ C: base.C });
    // The new one does, on every path.
    await stampNew(scale(base.C, 990_000n));
    const moved = await prices(sys);
    const wantMoved = expected(scale(base.C, 990_000n), m.G, band, clamp);
    assert(same(moved, wantMoved), `after the new feed moved: ${line(moved)}; the rules give ${line(wantMoved)}`);
    await stampNew(cNew);
    await exec((sys.vault.connect(bank) as Contract).mint(1_000n * E18));
    identity(await ledger(sys));
    return `keeper and proposer Safe executeProposal: "${stranger}" / "${byProposer}"; executor Safe executed through the wrapper (block ${receipt.blockNumber}, ${receipt.gasUsed} gas); feeds(PAXG) = ${newFeed}, lastKnownPrice kept at ${usd8(lastKnownBefore)}; ${line(now)} (C now ${usd8(cNew)}); the old proxy pushed 10% down changed nothing; the replacement moved 1% down gave ${line(moved)}; a 1,000 GSUSD mint priced by the new feed went through; identity holds`;
  });

  await r.check("after:a-stale-replacement-stops-the-reads", async () => {
    const threshold: bigint = await sys.oracle.stalenessThreshold();
    await advance(Number(threshold) + 60);
    // The old proxy and the gold reference are fresh; only the replacement has aged.
    await restamp();
    const old = await readFeed(FEEDS.C);
    assert(old.age < 10n, "the old proxy was not restamped");
    const stale = await prices(sys);
    assert(stale.token.startsWith("refused") && stale.borrow.startsWith("refused"), `a stale replacement still prices: ${line(stale)}`);
    const mint = await expectRevert((sys.vault.connect(bank) as Contract).mint(1_000n * E18));
    await stampNew(scale(base.C, NEW_RATIO));
    const fresh = await prices(sys);
    assert(!fresh.token.startsWith("refused") && !fresh.borrow.startsWith("refused"), `still refused after a fresh round: ${line(fresh)}`);
    return `replacement left ${threshold + 60n} s old (limit ${threshold} s) while the old proxy was fresh: liquidation ${stale.token}, borrowing ${stale.borrow}, mint "${mint.slice(0, 40)}"; one fresh round on the replacement: ${line(fresh)}`;
  });

  await r.check("refused:the-gold-reference-as-PAXG-feed-fails-at-execution", async () => {
    assert(await timelock.isOperationReady(rejected.opId), "the second proposal is not ready");
    const why = await expectRevert((wrapper.connect(executor) as Contract).executeProposal(rejected.target, rejected.data, rejectedSalt), "Feed not independent");
    assert(((await sys.oracle.feeds(ADDR.PAXG))[0] as string).toLowerCase() === newFeed.toLowerCase(), "the feed changed");
    await exec((timelock.connect(proposer) as Contract).cancel(rejected.opId));
    assert(!(await timelock.isOperation(rejected.opId)), "still recorded after cancel");
    return `proposeOracleFeedUpdate("PAXG", XAU/USD proxy) was accepted by the wrapper; at execution the oracle refused "${why}"; the feed is unchanged; the operation cancelled by the proposer Safe`;
  });
});
