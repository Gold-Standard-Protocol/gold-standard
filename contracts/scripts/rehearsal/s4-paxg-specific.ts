/**
 * Scenario 4 (variant C, plan section 3): a move specific to PAXG against a gold-wide move.
 *
 *   (iii) A genuine 30% PAXG depeg with gold steady: liquidation values PAXG at gold (max(C, G)),
 *         so no healthy vault is liquidated; borrowing and reserve swaps are refused "Off gold
 *         band"; coverage values PAXG at its market price (min(C, G)); repay and deposit work.
 *         Held for six hours, nothing changes: no time based override exists.
 *   (iv)  A gold-wide 15% fall (C and G together): liquidation follows at once, at C.
 *
 *   LOCAL_RPC_URL=http://127.0.0.1:8547 npx hardhat run --no-compile scripts/rehearsal/s4-paxg-specific.ts --network localhost
 */
import { Contract } from "ethers";
import {
  ADDR, E18, MAX, actors, advance, assert, exec, expectRevert, fundPaxg, liquidate, market, openVault, quote, ratioAt,
  rewind, samePrice, scale, scenario, showQuote, snapshot, usd8, variantC,
} from "./lib";

scenario("Scenario 4: PAXG-specific depeg (gold steady) against a gold-wide fall", async (sys, r) => {
  const keeper = await actors.keeper();
  const bank = await actors.bank();
  const victim = await openVault(sys, "s4-vault", 5n * E18, 1_310_000n);
  await exec((sys.paxg.connect(victim.w) as Contract).approve(sys.a.vault, MAX));
  await exec((sys.gsusd.connect(bank) as Contract).approve(sys.a.reserve, MAX));
  const base = await market({});
  let start = await snapshot();

  await r.check("iii:30pct-depeg-gold-steady-no-liquidation-borrow-and-swaps-refused", async () => {
    const c = scale(base.C, 700_000n);
    await market({ C: c });
    const lines: string[] = [];
    for (let h = 0; h <= 6; h++) {
      if (h > 0) {
        await advance(3600);
        await market({ C: c, G: base.G });
      }
      const [tok, bor, res, val] = await Promise.all([quote(sys, "token"), quote(sys, "borrow"), quote(sys, "reserve"), quote(sys, "valuation")]);
      const want = variantC(c, base.G);
      assert(tok.price === want.liq && !bor.ok && bor.why === "Off gold band" && !res.ok && res.why === "Off gold band" && val.price === c, `t+${h}h: liquidation ${showQuote(tok)}, borrowing ${showQuote(bor)}, reserve ${showQuote(res)}, valuation ${showQuote(val)}`);
      if (h === 0 || h === 6) lines.push(`t+${h}h liquidation ${usd8(tok.price)} (= G), borrowing "${bor.why}", reserve "${res.why}", valuation ${usd8(val.price)} (= C)`);
    }
    const ratio = await ratioAt(sys, victim.w.address, base.G);
    const liq = await expectRevert((sys.vault.connect(keeper) as Contract).liquidateViaPool(victim.w.address, 0), "Not undercollateralised");
    const mint = await expectRevert((sys.vault.connect(victim.w) as Contract).mint(1_000n * E18), "Off gold band");
    const swap = await expectRevert((sys.reserve.connect(bank) as Contract).swapGsusdForGold(ADDR.PAXG, 1_000n * E18, 0), "Off gold band");
    const q = await sys.reserve.quoteGoldOut(ADDR.PAXG, 1_000n * E18);
    await exec((sys.vault.connect(victim.w) as Contract).repay(100n * E18));
    const got = await fundPaxg(sys, victim.w.address, E18 / 10n);
    await exec((sys.vault.connect(victim.w) as Contract).deposit(ADDR.PAXG, got));
    return `C ${usd8(base.C)} -> ${usd8(c)} (-30%), G ${usd8(base.G)}: ${lines.join("; ")}; vault at ${(Number(ratio) / 10_000).toFixed(1)}% at gold: liquidateViaPool "${liq}"; mint "${mint}"; swap "${swap}" (quoteGoldOut ${q[0]}, ${q[1]}); repay 100 and deposit 0.1 PAXG went through`;
  });

  start = await rewind(start);
  await r.check("iv:gold-wide-15pct-fall-liquidates-at-C", async () => {
    // a vault opened at 130.05% of min(C, G) carries a year of 2% fee, so a 15% gold-wide fall takes it under 110%
    const v = await openVault(sys, "s4-v15", 5n * E18, 1_300_500n);
    await advance(365 * 86_400);
    await market({});
    const m0 = await market({});
    const c = scale(m0.C, 850_000n), g = scale(m0.G, 850_000n);
    await market({ C: c, G: g });
    const tok = await quote(sys, "token");
    const want = variantC(c, g);
    assert(tok.ok && tok.price === want.liq && want.liq === (c > g ? c : g), `liquidation ${showQuote(tok)}, expected ${usd8(want.liq)}`);
    const ratio = await ratioAt(sys, v.w.address, tok.price);
    assert(ratio < 1_100_000n, `vault at ${ratio}`);
    const l = await liquidate(sys, keeper, v.w.address, "pool");
    assert(samePrice(l.impliedPrice, want.liq), `liquidated at ${usd8(l.impliedPrice)}`);
    const bor = await quote(sys, "borrow");
    return `C ${usd8(m0.C)} -> ${usd8(c)}, G ${usd8(m0.G)} -> ${usd8(g)} (-15%, gold-wide): liquidation ${usd8(tok.price)} = C (C ${c >= g ? "at or above" : "below"} G, inside the 2% cap); a vault at ${(Number(ratio) / 10_000).toFixed(2)}% liquidated via the pool at ${usd8(l.impliedPrice)} the moment the feeds moved; borrowing ${showQuote(bor)}`;
  });
});
