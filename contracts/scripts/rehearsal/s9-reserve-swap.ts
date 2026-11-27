/**
 * Scenario 9: a reserve swap of GSUSD for real PAXG, priced at the coverage the swap leaves
 * behind. The reserve is seeded to just above the 10% coverage step (0.5% spread) and a swap is
 * sized to leave it near 9.5% (the 5% step, 0.75% spread): the swap must pay 0.75%, not the 0.5%
 * the pre-swap coverage shows. The spread goes to the buffer, the net GSUSD stays in the reserve's
 * inventory (supply unchanged, identity intact), and the PAXG that leaves is measured on arrival.
 * Variant C (vi): the swap prices at max(C, G) inside the band and is refused off it. A second swap
 * beyond the day's 20% outflow cap is refused.
 *
 *   LOCAL_RPC_URL=http://127.0.0.1:8547 npx hardhat run --no-compile scripts/rehearsal/s9-reserve-swap.ts --network localhost
 */
import { Contract } from "ethers";
import {
  ADDR, E18, E8, MAX, PPM, actors, assert, exec, expectRevert, fundPaxg, g18, identity, ledger, market, pct, quote, readFeed, scale, scenario,
  usd8, wallet,
} from "./lib";
import type { System } from "./lib";

async function tierFor(sys: System, coverage: bigint): Promise<bigint> {
  const n: bigint = await sys.reserve.spreadCurveLength();
  for (let i = 0n; i < n; i++) {
    const [atLeast, spread] = await sys.reserve.spreadCurve(i);
    if (coverage >= atLeast) return spread;
  }
  return sys.reserve.restrictedSpreadPpm();
}

scenario("Scenario 9: reserve swap GSUSD -> PAXG at the post-swap coverage tier", async (sys, r) => {
  const bank = await actors.bank();
  const swapper = await wallet("s9-swapper");
  // variant C: swaps price at max(C, G) inside the band; set C 1% under gold so the max is G
  const base = await market({});
  await market({ C: scale(base.G, 990_000n), G: base.G });
  const price = (await quote(sys, "reserve")).price;
  let gsusdIn = 0n;

  await r.check("setup:seed-to-just-above-10pct-coverage", async () => {
    const supply: bigint = await sys.reserve.dampedCirculatingSupply();
    const value0: bigint = await sys.reserve.reserveValueUsd();
    const target = (supply * 108_000n) / PPM;
    const seed = ((target - value0) * E8) / price;
    const got = await fundPaxg(sys, bank.address, seed);
    await exec((sys.paxg.connect(bank) as Contract).approve(sys.a.reserve, MAX));
    await exec((sys.reserve.connect(bank) as Contract).seedCollateral(ADDR.PAXG, got));
    const cov: bigint = await sys.reserve.dampedCoveragePpm();
    const value: bigint = await sys.reserve.reserveValueUsd();
    gsusdIn = value - (supply * 95_000n) / PPM;
    await exec((sys.gsusd.connect(bank) as Contract).transfer(swapper.address, gsusdIn * 2n));
    await exec((sys.gsusd.connect(swapper) as Contract).approve(sys.a.reserve, MAX));
    return `damped circulating supply ${g18(supply, 0)} GSUSD; seeded ${g18(got, 6)} PAXG; reserve ${g18(await sys.reserve.collateralBalance(ADDR.PAXG), 6)} PAXG worth $${g18(value, 0)}: coverage ${pct(cov / 1n, 2)}, pre-swap spread ${pct(await sys.reserve.currentSpreadPpm(), 2)}`;
  });

  await r.check("swap:priced-at-the-post-swap-tier", async () => {
    const supply: bigint = await sys.reserve.dampedCirculatingSupply();
    const value: bigint = await sys.reserve.reserveValueUsd();
    const pre: bigint = await sys.reserve.currentSpreadPpm();
    const postCoverage = ((value - gsusdIn) * PPM) / supply;
    const expected = await tierFor(sys, postCoverage);
    assert(expected !== pre, `the test does not straddle a step (pre ${pre}, post ${expected})`);
    const [quoted, quotedSpread] = await sys.reserve.quoteGoldOut(ADDR.PAXG, gsusdIn);
    const before = await ledger(sys);
    const paxgBefore: bigint = await sys.paxg.balanceOf(swapper.address);
    const receipt = await exec((sys.reserve.connect(swapper) as Contract).swapGsusdForGold(ADDR.PAXG, gsusdIn, (quoted * 999n) / 1000n));
    const ev = receipt.logs.map((l) => { try { return sys.reserve.interface.parseLog(l); } catch { return null; } }).find((e) => e?.name === "Swapped");
    assert(ev, "no Swapped event");
    const [, , inAmt, goldOut, spread, fee] = ev.args as unknown as [string, string, bigint, bigint, bigint, bigint];
    const after = await ledger(sys);
    const received = (await sys.paxg.balanceOf(swapper.address)) - paxgBefore;
    assert(spread === expected && quotedSpread === expected, `charged ${spread} (quoted ${quotedSpread}), post-swap tier ${expected}`);
    assert(fee === (inAmt * spread) / PPM, "fee is not gsusdIn x spread");
    assert(goldOut === ((inAmt - fee) * E18) / (price * 10n ** 10n), `goldOut ${goldOut} not net / price`);
    assert(received === goldOut, `received ${received} of ${goldOut}`);
    assert(after.bufferGsusd - before.bufferGsusd === fee, "spread not banked in the buffer");
    assert(after.reserveGsusd - before.reserveGsusd === inAmt - fee, "net GSUSD not held as inventory");
    assert(before.reservePaxg - after.reservePaxg === goldOut, "reserve balance did not fall by goldOut");
    assert(after.supply === before.supply, "supply changed");
    identity(after);
    return `${g18(inAmt, 2)} GSUSD in at ${usd8(price)}: pre-swap coverage tier ${pct(pre, 2)}, post-swap coverage ${pct(postCoverage, 2)} -> charged ${pct(spread, 2)} (fee ${g18(fee, 4)} to the buffer); ${g18(goldOut, 6)} PAXG out and ${g18(received, 6)} arrived; ${g18(inAmt - fee, 2)} GSUSD held as inventory; supply unchanged; identity holds`;
  });

  await r.check("vi:swap-price-is-max-C-G", async () => {
    const [c, g] = await Promise.all([readFeed(ADDR.PAXG_USD), readFeed(ADDR.XAU_USD)]);
    assert(price === (c.answer > g.answer ? c.answer : g.answer) && price === g.answer, `reserve price ${usd8(price)}`);
    const [goldOut] = await sys.reserve.quoteGoldOut(ADDR.PAXG, 1_000n * E18);
    return `C ${usd8(c.answer)} (1% under gold), G ${usd8(g.answer)}: reserve price ${usd8(price)} = max(C, G) (gold is never sold below gold or the market); quoteGoldOut(1,000) ${g18(goldOut, 6)} PAXG`;
  });

  await r.check("vi:swap-refused-off-the-band", async () => {
    const g = (await readFeed(ADDR.XAU_USD)).answer;
    await market({ C: scale(g, 970_000n), G: g });
    const res = await quote(sys, "reserve");
    const why = await expectRevert((sys.reserve.connect(swapper) as Contract).swapGsusdForGold(ADDR.PAXG, 1_000n * E18, 0), "Off gold band");
    const [goldOut, spread] = await sys.reserve.quoteGoldOut(ADDR.PAXG, 1_000n * E18);
    await market({ C: scale(g, 1_030_000n), G: g });
    const up = await expectRevert((sys.reserve.connect(swapper) as Contract).swapGsusdForGold(ADDR.PAXG, 1_000n * E18, 0), "Off gold band");
    await market({ C: scale(g, 990_000n), G: g });
    return `C 3% under gold: quote "${res.why}", swap "${why}", quoteGoldOut (${goldOut}, ${spread}); C 3% over gold: swap "${up}"`;
  });

  await r.check("swap:daily-outflow-cap", async () => {
    const left: bigint = await sys.reserve.remainingDailyCapacity(ADDR.PAXG);
    const tooMuch = ((left + E18) * price * 10n ** 10n) / E18;
    const why = await expectRevert((sys.reserve.connect(swapper) as Contract).swapGsusdForGold(ADDR.PAXG, tooMuch, 0), "Daily cap reached");
    return `${g18(left, 6)} PAXG of today's 20% cap left; a swap for one PAXG more: "${why}"`;
  });
});
