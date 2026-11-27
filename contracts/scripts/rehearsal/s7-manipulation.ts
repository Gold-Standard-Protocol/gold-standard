/**
 * Scenario 7 (variant C): C (Chainlink PAXG/USD) pushed alone, gold steady.
 *
 *   (i)  C pushed 3% below G cannot liquidate a vault priced just above the threshold at gold:
 *        liquidation values PAXG at max(C, G) = G, so a downward push of C moves nothing. The
 *        vault sits at about 111% at gold, so at C it would be about 108% and liquidatable if C
 *        were used. Inside the band (-1.9%) the same holds; borrowing follows min(C, G).
 *   (ii) C pushed 5% above G is valued at G x 1.02 (the liquidation cap), not at C; a vault under
 *        water at gold is still liquidated. Borrowing and reserve swaps are refused off the band.
 *   Also +1.9% (inside the band): liquidation at C, borrowing at G (no over-borrowing), reserve at C.
 *
 *   LOCAL_RPC_URL=http://127.0.0.1:8547 npx hardhat run --no-compile scripts/rehearsal/s7-manipulation.ts --network localhost
 */
import { Contract } from "ethers";
import {
  actors, assert, expectRevert, g18, liquidate, market, openVault, quote, ratioAt, rewind, scale, scenario, showQuote,
  snapshot, usd8, variantC, E18,
} from "./lib";

scenario("Scenario 7: C pushed alone (variant C)", async (sys, r) => {
  const keeper = await actors.keeper();
  const near = await openVault(sys, "s7-near", 5n * E18, 1_302_000n);
  const deep = await openVault(sys, "s7-deep", 5n * E18, 1_302_000n);
  const base = await market({});
  // a gold-wide drift puts the near vault about 111% at gold
  const g0 = scale(base.G, 853_000n);
  const c0 = g0; // C exactly at gold, so every push below is measured from gold
  await market({ C: c0, G: g0 });
  const rNear = await ratioAt(sys, near.w.address, g0);
  r.info("setup", `C and G moved gold-wide to ${usd8(g0)}; the near vault sits at ${(Number(rNear) / 10_000).toFixed(2)}% at gold`);
  let start = await snapshot();

  const read = async (): Promise<string[]> => (await Promise.all([quote(sys, "token"), quote(sys, "borrow"), quote(sys, "reserve")])).map(showQuote);

  await r.check("i:C-3pct-below-G-cannot-liquidate-the-near-vault", async () => {
    const c = scale(g0, 970_000n);
    await market({ C: c, G: g0 });
    const tok = await quote(sys, "token");
    assert(tok.ok && tok.price === g0, `liquidation ${showQuote(tok)}`);
    const atC = await ratioAt(sys, near.w.address, c);
    const why = await expectRevert((sys.vault.connect(keeper) as Contract).liquidateViaPool(near.w.address, 0), "Not undercollateralised");
    const [, bor, res] = await read();
    return `C ${usd8(c)} (-3%): liquidation ${usd8(tok.price)} = G; near vault ${(Number(rNear) / 10_000).toFixed(2)}% at gold (it would be ${(Number(atC) / 10_000).toFixed(2)}% at C): liquidateViaPool "${why}"; borrowing ${bor}, reserve ${res}`;
  });

  start = await rewind(start);
  await r.check("i:C-1.9pct-below-inside-the-band-same", async () => {
    const c = scale(g0, 981_000n);
    await market({ C: c, G: g0 });
    const [tok, bor, res] = await Promise.all([quote(sys, "token"), quote(sys, "borrow"), quote(sys, "reserve")]);
    assert(tok.price === g0 && bor.price === c && res.price === g0, `${showQuote(tok)} / ${showQuote(bor)} / ${showQuote(res)}`);
    await expectRevert((sys.vault.connect(keeper) as Contract).liquidateViaPool(near.w.address, 0), "Not undercollateralised");
    return `C -1.9%: liquidation ${usd8(tok.price)} = G (no liquidation of the near vault), borrowing ${usd8(bor.price)} = C (lower), reserve ${usd8(res.price)} = G (higher)`;
  });

  start = await rewind(start);
  await r.check("C+1.9pct-inside-the-band-no-over-borrowing", async () => {
    const c = scale(g0, 1_019_000n);
    await market({ C: c, G: g0 });
    const [tok, bor, res] = await Promise.all([quote(sys, "token"), quote(sys, "borrow"), quote(sys, "reserve")]);
    assert(tok.price === c && bor.price === g0 && res.price === c, `${showQuote(tok)} / ${showQuote(bor)} / ${showQuote(res)}`);
    return `C +1.9%: liquidation ${usd8(tok.price)} = C (fewer liquidations), borrowing ${usd8(bor.price)} = G (no over-borrowing), reserve ${usd8(res.price)} = C`;
  });

  start = await rewind(start);
  await r.check("ii:C-5pct-above-G-capped-at-1.02G-underwater-vault-still-liquidated", async () => {
    // the deep vault under water at gold: gold falls a further 25%, then C is pushed 5% above it
    const g = scale(g0, 750_000n);
    const c = scale(g, 1_050_000n);
    await market({ C: c, G: g });
    const tok = await quote(sys, "token");
    const want = variantC(c, g);
    assert(tok.ok && tok.price === want.liq && want.liq < c, `liquidation ${showQuote(tok)}, expected ${usd8(want.liq)}`);
    const atGold = await ratioAt(sys, deep.w.address, g);
    const atCap = await ratioAt(sys, deep.w.address, tok.price);
    assert(atGold < 1_000_000n, `deep vault at ${atGold} at gold, not under water`);
    const bad0: bigint = await sys.vault.totalBadDebt();
    const l = await liquidate(sys, keeper, deep.w.address, "pool");
    const bad: bigint = await sys.vault.totalBadDebt();
    const v = await sys.vault.vaults(deep.w.address);
    assert(v[2] === 0n && v[1] === 0n, "deep vault not cleared");
    const [, bor, res] = await read();
    assert(bor.includes("Off gold band") && res.includes("Off gold band"), `borrowing ${bor}, reserve ${res}`);
    void expectRevert;
    return `G ${usd8(g)}, C ${usd8(c)} (+5%): liquidation ${usd8(tok.price)} = G x 1.02, not C; deep vault ${(Number(atGold) / 10_000).toFixed(2)}% at gold (${(Number(atCap) / 10_000).toFixed(2)}% at the cap) liquidated in full via the pool (repaid ${g18(l.debtRepaid, 2)} for ${g18(l.seized, 4)} PAXG), bad debt booked ${g18(bad - bad0, 2)} GSUSD; borrowing ${bor}, reserve ${res}`;
  });
});
