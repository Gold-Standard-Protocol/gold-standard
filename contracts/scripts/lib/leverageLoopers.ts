/**
 * Looping and unwinding for scripts/rehearse-leverage-loop.ts: a looper deposits PAXG, mints
 * GSUSD, buys PAXG with it through the reserve, the pool or both, deposits that and repeats; an
 * unwind withdraws the PAXG the ratio allows, sells it in the pool and repays. Fork only.
 */
import {
  BPS, DEX, E18, E8, GAS, MAX, MAX_SLIPPAGE_PPM, MIN_LEG, PPM,
  borrowPrice, ceilDiv, g, market, maxPoolBuyInput, maxPoolSellInput, maxReserveInput, min, pct,
  poolGsusdPpm, quotePaxgForGsusd, quotePoolBuy, quotePoolSell, quoteReserve, ratioText, reason,
  restorePool, section, send, table, times, usd, valueUsd, vaultState,
  type Ctx, type Signer,
} from "./leverageMarket";

const MAX_UNWIND_COST_PPM = 500_000n; // with no arbitrage, an unwind sale that loses more than half is not made
const MAX_UNWIND_STEPS = 60;
const MAX_UNWIND_STEPS_ARB = 400; // 3% sales into a restored 5 PAXG pool take many small steps

// ---------------------------------------------------------------- looping

export type Route = "pool" | "reserve" | "best" | "pool-nocap";

export interface LoopRow {
  loop: number;
  venue: string;
  minted: bigint;
  fee: bigint;
  swapped: bigint;
  bought: bigint;
  premiumPpm: bigint;
  gsusdPpm: bigint;
  reservePaxg: bigint;
  capLeft: bigint;
  ratioPpm: bigint | null;
  exposurePpm: bigint;
  netLevPpm: bigint;
  liqPrice: bigint;
  cumFee: bigint;
  cumPoolFee: bigint;
  cumImpact: bigint;
  cumSpread: bigint;
  gas: bigint;
}

export interface Looper {
  owner: Signer;
  equity: bigint;
  startPrice: bigint;
  startBuffer: bigint;
  startReserve: bigint;
  startFees: bigint;
  rows: LoopRow[];
  totals: { fee: bigint; poolFee: bigint; impact: bigint; spread: bigint; spreadResidual: bigint; gas: bigint; fromReserve: bigint; fromPool: bigint };
}

export async function openLooper(ctx: Ctx, owner: Signer, equity: bigint): Promise<Looper> {
  await send(ctx.paxg.connect(owner).mint(owner.address, equity, { gasLimit: GAS.token }));
  const vaultAddress = await ctx.vault.getAddress();
  for (const spender of [vaultAddress, DEX.router]) {
    await send(ctx.paxg.connect(owner).approve(spender, MAX, { gasLimit: GAS.token }));
  }
  for (const spender of [await ctx.reserve.getAddress(), DEX.router, vaultAddress]) {
    await send(ctx.gsusd.connect(owner).approve(spender, MAX, { gasLimit: GAS.token }));
  }
  const looper: Looper = {
    owner,
    equity,
    startPrice: await borrowPrice(ctx),
    startBuffer: await ctx.buffer.gsusdBalance(),
    startReserve: await ctx.reserve.collateralBalance(ctx.PAXG),
    startFees: await ctx.vault.totalOriginationFees(),
    rows: [],
    totals: { fee: 0n, poolFee: 0n, impact: 0n, spread: 0n, spreadResidual: 0n, gas: 0n, fromReserve: 0n, fromPool: 0n },
  };
  looper.totals.gas += await send(ctx.vault.connect(owner).deposit(ctx.PAXG, equity, { gasLimit: GAS.vault }));
  return looper;
}

async function planLeg(ctx: Ctx, route: Route, budget: bigint): Promise<{ resIn: bigint; poolIn: bigint; why: string }> {
  if (route === "reserve") {
    const resIn = await maxReserveInput(ctx, budget);
    return { resIn, poolIn: 0n, why: "reserve daily cap reached" };
  }
  if (route === "pool-nocap") return { resIn: 0n, poolIn: budget, why: "" };
  if (route === "pool") {
    const poolIn = await maxPoolBuyInput(ctx, budget, MAX_SLIPPAGE_PPM);
    return { resIn: 0n, poolIn, why: "pool cost above 3%" };
  }
  const resMax = await maxReserveInput(ctx, budget);
  const poolMax = await maxPoolBuyInput(ctx, budget, MAX_SLIPPAGE_PPM);
  if (resMax === budget && poolMax === budget) {
    const viaReserve = (await quoteReserve(ctx, budget)).goldOut;
    const viaPool = await quotePoolBuy(ctx, budget);
    return viaPool > viaReserve ? { resIn: 0n, poolIn: budget, why: "" } : { resIn: budget, poolIn: 0n, why: "" };
  }
  return { resIn: resMax, poolIn: min(budget - resMax, poolMax), why: "reserve daily cap reached and pool cost above 3%" };
}

/** Loop until the route stops; returns the stop reason. Rows are appended to the looper. */
export async function loopPhase(ctx: Ctx, looper: Looper, route: Route, targetPpm: bigint, convergedPpm: bigint, maxLoops: number): Promise<string> {
  const owner = looper.owner;
  const fresh = async () => ({ paxg: await ctx.paxg.balanceOf(owner.address), gsusd: await ctx.gsusd.balanceOf(owner.address) });
  for (let i = 0; i < maxLoops; i++) {
    const price = await borrowPrice(ctx);
    const before = await vaultState(ctx, owner.address);
    const room = (valueUsd(before.collateral, price) * PPM) / targetPpm;
    const maxMint = room > before.debt ? room - before.debt : 0n;
    const budget = maxMint - (maxMint * ctx.originationBps) / BPS;
    if (budget < (valueUsd(looper.equity, looper.startPrice) * convergedPpm) / PPM) return `converged (next step below ${pct(convergedPpm, 1)} of equity)`;
    const plan = await planLeg(ctx, route, budget);
    if (plan.resIn + plan.poolIn < MIN_LEG) return plan.why || "nothing to buy";
    const mintAmount = min(maxMint, ceilDiv((plan.resIn + plan.poolIn) * BPS, BPS - ctx.originationBps));
    if (before.principal === 0n && mintAmount < ctx.minDebt) return "first mint below minDebt";

    const held0 = await fresh();
    let gas = await send(ctx.vault.connect(owner).mint(mintAmount, { gasLimit: GAS.vault }));
    const held1 = await fresh();
    const received = held1.gsusd - held0.gsusd;
    const fee = mintAmount - received;
    // Spend no more than the wallet holds (the fee rounds; leftover dust stays in the wallet).
    const resIn = min(plan.resIn, held1.gsusd);
    const poolIn = min(plan.poolIn, held1.gsusd - resIn);

    let fromReserve = 0n;
    let spread = 0n;
    if (resIn > 0n) {
      const q = await quoteReserve(ctx, resIn);
      const p0 = await ctx.paxg.balanceOf(owner.address);
      gas += await send(ctx.reserve.connect(owner).swapGsusdForGold(ctx.PAXG, resIn, (q.goldOut * 999n) / 1000n, { gasLimit: GAS.swap }));
      fromReserve = (await ctx.paxg.balanceOf(owner.address)) - p0;
      spread = (resIn * q.spreadPpm) / PPM;
      looper.totals.spread += spread;
      looper.totals.spreadResidual += resIn - spread - valueUsd(fromReserve, price);
      looper.totals.fromReserve += fromReserve;
    }
    let fromPool = 0n;
    if (poolIn > 0n) {
      const q = await quotePoolBuy(ctx, poolIn);
      const p0 = await ctx.paxg.balanceOf(owner.address);
      gas += await send(ctx.router.connect(owner).getFunction("exactInputSingle")(
        { tokenIn: ctx.GSUSD, tokenOut: ctx.PAXG, fee: ctx.poolFee, recipient: owner.address, amountIn: poolIn, amountOutMinimum: (q * 999n) / 1000n, sqrtPriceLimitX96: 0n },
        { gasLimit: GAS.swap }
      ));
      fromPool = (await ctx.paxg.balanceOf(owner.address)) - p0;
      const poolFee = (poolIn * ctx.poolFee) / PPM;
      looper.totals.poolFee += poolFee;
      looper.totals.impact += poolIn - poolFee - valueUsd(fromPool, price);
      looper.totals.fromPool += fromPool;
    }
    const bought = fromReserve + fromPool;
    if (bought === 0n) return "a leg returned no PAXG";
    gas += await send(ctx.vault.connect(owner).deposit(ctx.PAXG, bought, { gasLimit: GAS.vault }));
    looper.totals.fee += fee;
    looper.totals.gas += gas;

    const after = await vaultState(ctx, owner.address);
    const m = await market(ctx);
    const value = valueUsd(after.collateral, price);
    const swapped = resIn + poolIn;
    looper.rows.push({
      loop: looper.rows.length + 1,
      venue: resIn > 0n && poolIn > 0n ? "reserve+pool" : resIn > 0n ? "reserve" : "pool",
      minted: mintAmount,
      fee,
      swapped,
      bought,
      // The premium of the GSUSD swapped over the oracle, so the spread alone on a reserve leg;
      // the origination fee is the separate fee column.
      premiumPpm: (swapped * E8 * PPM) / (bought * price) - PPM, // bought is non-zero here
      gsusdPpm: m.gsusdPpm,
      reservePaxg: m.reservePaxg,
      capLeft: m.capLeft,
      ratioPpm: after.ratioPpm,
      exposurePpm: (after.collateral * PPM) / looper.equity,
      netLevPpm: value > after.debt ? (value * PPM) / (value - after.debt) : 0n,
      liqPrice: after.liqPrice,
      cumFee: looper.totals.fee,
      cumPoolFee: looper.totals.poolFee,
      cumImpact: looper.totals.impact,
      cumSpread: looper.totals.spread,
      gas,
    });
  }
  return `loop limit (${maxLoops}) reached`;
}

export interface LoopSummary {
  label: string;
  stop: string;
  loops: number;
  collateral: bigint;
  debt: bigint;
  ratioPpm: bigint | null;
  exposurePpm: bigint;
  netLevPpm: bigint;
  liqPrice: bigint;
  liqFallPpm: bigint;
  netEquity: bigint;
  keptPpm: bigint;
  cost: bigint;
  bufferDelta: bigint;
  originationDelta: bigint;
  reserveTaken: bigint;
  capLeft: bigint;
  gsusdPpm: bigint;
  gas: bigint;
}
export async function summarise(ctx: Ctx, looper: Looper, label: string, stop: string): Promise<LoopSummary> {
  const price = await borrowPrice(ctx);
  const v = await vaultState(ctx, looper.owner.address);
  const m = await market(ctx);
  const value = valueUsd(v.collateral, price);
  const startEquity = valueUsd(looper.equity, looper.startPrice);
  const netEquity = value - v.debt;
  const t = looper.totals;
  return {
    label,
    stop,
    loops: looper.rows.length,
    collateral: v.collateral,
    debt: v.debt,
    ratioPpm: v.ratioPpm,
    exposurePpm: (v.collateral * PPM) / looper.equity,
    netLevPpm: netEquity > 0n ? (value * PPM) / netEquity : 0n,
    liqPrice: v.liqPrice,
    liqFallPpm: v.liqPrice === 0n ? 0n : PPM - (v.liqPrice * PPM) / price,
    netEquity,
    keptPpm: (netEquity * PPM) / startEquity,
    // Execution costs only; the stability fee accrued while looping is in the net equity.
    cost: t.fee + t.poolFee + t.impact + t.spread + t.spreadResidual,
    bufferDelta: m.bufferGsusd - looper.startBuffer,
    originationDelta: (await ctx.vault.totalOriginationFees()) - looper.startFees,
    reserveTaken: looper.startReserve - m.reservePaxg,
    capLeft: m.capLeft,
    gsusdPpm: m.gsusdPpm,
    gas: t.gas,
  };
}

export function loopTable(rows: LoopRow[]): void {
  table(
    ["loop", "venue", "GSUSD minted", "origination fee", "GSUSD swapped", "PAXG bought", "GSUSD swapped per PAXG vs oracle (spread, fee excluded)", "pool GSUSD after (USD)", "reserve PAXG left", "daily cap left (PAXG)", "vault ratio", "exposure on equity", "leverage on net equity", "liquidation price (USD)", "cum. origination fee", "cum. pool fee", "cum. pool impact", "cum. reserve spread", "gas"],
    rows.map((r) => [
      String(r.loop), r.venue, g(r.minted), g(r.fee, 4), g(r.swapped), g(r.bought, 6), `+${pct(r.premiumPpm, 3)}`, g(r.gsusdPpm, 4, 6),
      g(r.reservePaxg, 4), g(r.capLeft, 4), ratioText(r.ratioPpm), times(r.exposurePpm), times(r.netLevPpm), usd(r.liqPrice),
      g(r.cumFee, 4), g(r.cumPoolFee, 4), g(r.cumImpact, 4), g(r.cumSpread, 4), r.gas.toString(),
    ])
  );
}
export const SUMMARY_HEADERS = ["run", "loops", "stop reason", "PAXG held", "debt (GSUSD)", "ratio", "exposure", "leverage on net equity", "liquidation price", "fall to liquidation", "net equity (USD)", "equity kept", "execution cost, stability fee excluded (USD)", "buffer change (GSUSD)", "origination fees (GSUSD)", "reserve PAXG taken", "daily cap left", "pool GSUSD (USD)", "gas"];
export const summaryRow = (s: LoopSummary): string[] => [
  s.label, String(s.loops), s.stop, g(s.collateral, 4), g(s.debt), ratioText(s.ratioPpm), times(s.exposurePpm), times(s.netLevPpm), usd(s.liqPrice),
  pct(s.liqFallPpm), g(s.netEquity), pct(s.keptPpm), g(s.cost), g(s.bufferDelta, 4), g(s.originationDelta, 4), g(s.reserveTaken, 4), g(s.capLeft, 4),
  g(s.gsusdPpm, 4, 6), s.gas.toString(),
];

// ---------------------------------------------------------------- unwinding

interface UnwindRow {
  step: number;
  sold: bigint;
  received: bigint;
  lossPpm: bigint;
  gsusdPpm: bigint;
  repaid: bigint;
  debtLeft: bigint;
  ratioPpm: bigint | null;
  cumLoss: bigint;
  arbSold: bigint;
  gsusdPpmAfterArb: bigint;
}
export interface Unwind {
  rows: UnwindRow[];
  stop: string;
  startNet: bigint;
  endNet: bigint;
  startDebt: bigint;
  endDebt: bigint;
  gsusdPpmEnd: bigint;
  arbMinted: bigint;
}

/**
 * Step out of a looped vault: withdraw the PAXG the minimum ratio allows, sell it in the pool,
 * repay, repeat. With `arb`, an arbitrageur restores the pool after every step (restorePool),
 * as open minting would on a live market, so the unwinder sells in slices whose average cost
 * stays within 3%, as a loop's pool purchase does. With null the pool is left as each sale
 * leaves it and a sale may lose up to half.
 */
export async function unwind(ctx: Ctx, owner: Signer, arb: Signer | null): Promise<Unwind> {
  const rows: UnwindRow[] = [];
  const price = await borrowPrice(ctx);
  const s0 = await vaultState(ctx, owner.address);
  const heldStart = await ctx.gsusd.balanceOf(owner.address);
  const startNet = valueUsd(s0.collateral, price) - s0.debt + heldStart;
  let cumLoss = 0n;
  let arbMinted = 0n;
  const saleCapPpm = arb ? MAX_SLIPPAGE_PPM : MAX_UNWIND_COST_PPM;
  const maxSteps = arb ? MAX_UNWIND_STEPS_ARB : MAX_UNWIND_STEPS;
  let stop = `step limit (${maxSteps}) reached`;
  for (let step = 1; step <= maxSteps; step++) {
    const v = await vaultState(ctx, owner.address);
    const held = await ctx.gsusd.balanceOf(owner.address);
    if (v.principal === 0n) {
      if (v.collateral > 0n) await send(ctx.vault.connect(owner).withdraw(v.collateral, { gasLimit: GAS.close }));
      stop = "closed: all debt repaid and all PAXG withdrawn";
      break;
    }
    if (held >= v.debt + v.debt / 100_000n) {
      await send(ctx.vault.connect(owner).repay(v.debt + E18, { gasLimit: GAS.close }));
      continue;
    }
    // The withdrawal must leave minRatio at the borrowing price on the fee-inclusive debt.
    const minCollateral = ceilDiv(v.debt * ctx.minRatio * E8, PPM * price);
    let spare = v.collateral > minCollateral ? v.collateral - minCollateral : 0n;
    // The debt accrues every second between this read and the withdrawal (the quotes below
    // take a while), so hold back 0.1% of the spare plus 0.001% of the minimum collateral
    // (about four hours of fee).
    spare -= min(spare, spare / 1_000n + minCollateral / 100_000n);
    const needGsusd = v.debt - held + v.debt / 1_000n;
    const needPaxg = await quotePaxgForGsusd(ctx, needGsusd);
    let sell = needPaxg === null ? spare : min(spare, needPaxg);
    sell = await maxPoolSellInput(ctx, sell, saleCapPpm);
    if (sell < 10n ** 12n) {
      stop = spare < 10n ** 12n ? "no spare collateral above the minimum ratio" : `pool sale would lose more than ${pct(saleCapPpm, 0)}`;
      break;
    }
    try {
      await send(ctx.vault.connect(owner).withdraw(sell, { gasLimit: GAS.vault }));
    } catch (error) {
      stop = `withdrawal refused: ${reason(error)}`;
      break;
    }
    const quote = await quotePoolSell(ctx, sell);
    const g0 = await ctx.gsusd.balanceOf(owner.address);
    await send(ctx.router.connect(owner).getFunction("exactInputSingle")(
      { tokenIn: ctx.PAXG, tokenOut: ctx.GSUSD, fee: ctx.poolFee, recipient: owner.address, amountIn: sell, amountOutMinimum: (quote * 999n) / 1000n, sqrtPriceLimitX96: 0n },
      { gasLimit: GAS.swap }
    ));
    const g1 = await ctx.gsusd.balanceOf(owner.address);
    const received = g1 - g0;
    const loss = valueUsd(sell, price) - received;
    cumLoss += loss;
    const debtNow = await ctx.vault.getVaultCurrentDebt(owner.address);
    // A partial repay must leave the principal at zero or at least minDebt.
    let repay = g1 >= debtNow ? debtNow + E18 : g1;
    if (g1 < debtNow && debtNow - g1 < ctx.minDebt + E18) repay = debtNow > ctx.minDebt + E18 ? debtNow - ctx.minDebt - E18 : 0n;
    const repaid = repay > debtNow ? debtNow : repay;
    if (repay > 0n) await send(ctx.vault.connect(owner).repay(repay, { gasLimit: GAS.close }));
    const after = await vaultState(ctx, owner.address);
    const gsusdPpm = await poolGsusdPpm(ctx);
    const restored = arb ? await restorePool(ctx, arb) : null;
    arbMinted += restored?.gsusdMinted ?? 0n;
    rows.push({
      step,
      sold: sell,
      received,
      lossPpm: (loss * PPM) / valueUsd(sell, price),
      gsusdPpm,
      repaid,
      debtLeft: after.debt,
      ratioPpm: after.ratioPpm,
      cumLoss,
      arbSold: restored?.gsusdSold ?? 0n,
      gsusdPpmAfterArb: restored ? await poolGsusdPpm(ctx) : gsusdPpm,
    });
  }
  const end = await vaultState(ctx, owner.address);
  const paxgHeld = await ctx.paxg.balanceOf(owner.address);
  const gsusdHeld = await ctx.gsusd.balanceOf(owner.address);
  const endNet = valueUsd(end.collateral + paxgHeld, price) - end.debt + gsusdHeld;
  return { rows, stop, startNet, endNet, startDebt: s0.debt, endDebt: end.debt, gsusdPpmEnd: await poolGsusdPpm(ctx), arbMinted };
}

export function unwindReport(label: string, u: Unwind): void {
  section(label);
  table(
    ["step", "PAXG withdrawn and sold", "GSUSD received", "sale loss vs oracle", "pool GSUSD after the sale (USD)", "GSUSD repaid", "debt left", "vault ratio", "cumulative sale loss (USD)", "arbitrageur GSUSD sold into the pool", "pool GSUSD after arbitrage (USD)"],
    u.rows.map((r) => [
      String(r.step), g(r.sold, 6), g(r.received), pct(r.lossPpm, 3), g(r.gsusdPpm, 4, 6), g(r.repaid), g(r.debtLeft), ratioText(r.ratioPpm), g(r.cumLoss),
      g(r.arbSold), g(r.gsusdPpmAfterArb, 4, 6),
    ])
  );
  table(
    ["measure", "value"],
    [
      ["stop reason", u.stop],
      ["debt at start (GSUSD)", g(u.startDebt)],
      ["debt at end (GSUSD)", g(u.endDebt)],
      ["share of debt repaid", u.startDebt === 0n ? "n/a" : pct(((u.startDebt - u.endDebt) * PPM) / u.startDebt)],
      ["net equity at start, oracle value (USD)", g(u.startNet)],
      ["net equity at end, oracle value (USD)", g(u.endNet)],
      ["cost of the unwind so far (USD)", g(u.startNet - u.endNet)],
      ["cost as share of starting net equity", pct(((u.startNet - u.endNet) * PPM) / u.startNet)],
      ["pool GSUSD at the end (USD)", g(u.gsusdPpmEnd, 4, 6)],
      ["GSUSD the arbitrageur minted to restore the pool", g(u.arbMinted)],
    ]
  );
}
