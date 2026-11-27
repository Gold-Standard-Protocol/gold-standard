/**
 * Scenario 3: a rapid gold-wide crash. Seven vaults open at 130% to 153% of the borrowing price;
 * the whole market (C, G and the pool, by a real swap) then drifts 15% lower and the pool's median
 * settles, which leaves the set between about 111% and 131% at C. Then C and G fall 10% together
 * within an hour, in twenty 0.5% steps three minutes apart, while the pool is left where it was (the
 * median lags, as in a real crash). After every step a keeper pass liquidates, in full, every vault
 * below 110% at the oracle's price, alternating the pool and the direct path. Expected (variant C): every read
 * prices at min(max(C, G), 1.02G) with no refusal, every liquidation settles there, and no bad debt.
 *
 *   LOCAL_RPC_URL=http://127.0.0.1:8547 npx hardhat run --no-compile scripts/rehearsal/s3-gold-crash.ts --network localhost
 */
import {
  ADDR, E18, PPM, actors, assert, driftMarket, g18, identity, ledger, liquidate, market, openVault, quote, ratioAt,
  readFeed, samePrice, scale, scenario, showQuote, trader, twapRead, usd8, advance, variantC,
} from "./lib";
import type { Opened } from "./lib";

const RATIOS = [1_302_000n, 1_330_000n, 1_370_000n, 1_410_000n, 1_450_000n, 1_500_000n, 1_530_000n];
const STEPS = 20, STEP_PPM = 5_000n, STEP_SECONDS = 180;

scenario("Scenario 3: rapid gold-wide crash, C and G -10% in an hour, pool lagging", async (sys, r) => {
  const bank = await actors.bank();
  const keeper = await actors.keeper();
  const set: Array<Opened & { label: string; open: boolean }> = [];
  const t = await trader(sys);

  await r.check("setup:vault-set-110-to-130pct", async () => {
    for (const [i, ratio] of RATIOS.entries()) set.push({ ...(await openVault(sys, `s3-v${i}`, 5n * E18, ratio)), label: `v${i}`, open: true });
    const drift = await driftMarket(sys, t, 850_000n);
    const c = (await quote(sys, "token")).price;
    const ratios = await Promise.all(set.map((v) => ratioAt(sys, v.w.address, c)));
    assert(ratios.every((x) => x >= 1_100_000n), "a vault is already liquidatable");
    return `${drift}; ratios at C ${ratios.map((x) => (Number(x) / 10_000).toFixed(1) + "%").join(", ")}`;
  });

  const bad0: bigint = await sys.vault.totalBadDebt();
  const start = await market({});
  const liquidations: string[] = [];
  let refusals = 0, mismatches = 0, n = 0;
  await r.check("crash:twenty-steps-keeper-passes", async () => {
    for (let k = 1; k <= STEPS; k++) {
      await advance(STEP_SECONDS);
      const factor = PPM - STEP_PPM * BigInt(k);
      await market({ C: scale(start.C, factor), G: scale(start.G, factor) });
      const c = (await readFeed(ADDR.PAXG_USD)).answer;
      const [tok, bor, p] = await Promise.all([quote(sys, "token"), quote(sys, "borrow"), twapRead(sys)]);
      if (!tok.ok) refusals++;
      const want = variantC(c, (await readFeed(ADDR.XAU_USD)).answer).liq;
      if (tok.ok && tok.price !== want) mismatches++;
      const done: string[] = [];
      for (const v of set.filter((x) => x.open)) {
        const ratio = await ratioAt(sys, v.w.address, tok.price);
        if (!tok.ok || ratio >= 1_100_000n) continue;
        const mode = n++ % 2 === 0 ? "pool" : "direct";
        const l = await liquidate(sys, mode === "pool" ? keeper : bank, v.w.address, mode);
        const cAt = (await readFeed(ADDR.PAXG_USD)).answer;
        if (!samePrice(l.impliedPrice, variantC(cAt, (await readFeed(ADDR.XAU_USD)).answer).liq)) mismatches++;
        v.open = false;
        done.push(`${v.label} ${mode} at ${(Number(ratio) / 10_000).toFixed(2)}% (implied ${usd8(l.impliedPrice)}, ${g18(l.seized, 4)} PAXG for ${g18(l.debtRepaid, 2)})`);
        liquidations.push(`${v.label}@-${(Number(STEP_PPM * BigInt(k)) / 10_000).toFixed(1)}%`);
      }
      console.log(`    t+${String((k * STEP_SECONDS) / 60).padStart(2)} min  C ${usd8(c)}  P ${p.status} ${usd8(p.answer)}  liquidation ${showQuote(tok)}  borrowing ${showQuote(bor)}${done.length ? "  -> " + done.join("; ") : ""}`);
    }
    assert(refusals === 0, `${refusals} liquidation reads refused`);
    assert(mismatches === 0, `${mismatches} reads or liquidations not at C`);
    return `${n} liquidations (${liquidations.join(", ")}), every read and every seizure at min(max(C, G), 1.02G) (variant C), no refusal`;
  });

  await r.check("crash:no-bad-debt", async () => {
    const bad: bigint = await sys.vault.totalBadDebt();
    assert(bad === bad0, `bad debt ${g18(bad - bad0)}`);
    const c = (await quote(sys, "token")).price;
    const left = await Promise.all(set.filter((v) => v.open).map(async (v) => `${v.label} ${(Number(await ratioAt(sys, v.w.address, c)) / 10_000).toFixed(1)}%`));
    return `totalBadDebt unchanged at ${g18(bad)}; still open above 110%: ${left.join(", ") || "none"}`;
  });

  await r.check("crash:accounting-identity", async () => identity(await ledger(sys)));
});
