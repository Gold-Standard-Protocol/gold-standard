/**
 * Liquidation paths for scripts/rehearse-leverage-loop.ts: liquidateViaPool, a direct
 * liquidation by a liquidator who buys its GSUSD in the pool, one by a liquidator holding GSUSD
 * and one by a liquidator who mints its GSUSD against its own PAXG. Each returns one row of
 * LIQ_HEADERS. Fork only.
 */
import {
  BPS, DEX, E18, GAS, MAX, MIN_LEG, PPM,
  borrowPrice, g, market, max, min, mintFromOwnVault, poolGsusdPpm, quotePaxgForGsusd, ratioText,
  reason, send, valueUsd, vaultState,
  type Ctx, type OwnMint, type Signer, type VaultState,
} from "./leverageMarket";

export const LIQ_HEADERS = ["path", "outcome", "debt to repay asked", "stability pool GSUSD absorbed", "vault debt cleared", "PAXG seized", "PAXG to caller", "to pool / note", "buffer GSUSD change", "buffer PAXG change", "reserve PAXG change", "bad debt booked", "victim ratio after", "vault paused", "pool price note"];
const NA = (n: number): string[] => Array<string>(n).fill("n/a");

export const band = (ratio: bigint | null, liqRatio: bigint): string => {
  if (ratio === null) return "no debt";
  if (ratio >= liqRatio) return "healthy";
  if (ratio >= 1_050_000n) return "liquidatable, full penalty fits";
  if (ratio >= PPM) return "liquidatable, thin (pro rata)";
  return "under water (full liquidation only)";
};

/**
 * GSUSD a full liquidation of `v` repays now: GoldVault._sizeSeizure (GoldVault.sol:820-836),
 * the arithmetic the keeper's fullLiquidationRepay mirrors (libs/trpc/src/lib/keeper/
 * liquidationSizing.ts; the contracts project may not import a library across the Nx module
 * boundary, so it is repeated here). While the gold covers the debt it is the debt. Under
 * water it is the gold's value at the liquidation price less underwaterDiscountPpm, raised to
 * 2 x coverable - debt when that is larger, so the discount never exceeds the shortfall.
 */
export async function fullRepayment(ctx: Ctx, v: VaultState): Promise<bigint> {
  const coverable = valueUsd(v.collateral, await ctx.oracle.quoteTokenPrice(ctx.PAXG));
  if (coverable >= v.debt) return v.debt;
  const discountPpm = await ctx.vault.underwaterDiscountPpm();
  const discounted = (coverable * (PPM - discountPpm)) / PPM;
  return max(discounted, 2n * coverable > v.debt ? 2n * coverable - v.debt : 0n);
}
const fullLabel = (need: bigint): string => `full (repays ${g(need)})`;

/** GSUSD `owner`'s vault could still mint and receive at the borrowing price, after the origination fee. */
export async function mintHeadroom(ctx: Ctx, owner: string): Promise<bigint> {
  const v = await vaultState(ctx, owner);
  const room = (valueUsd(v.collateral, await borrowPrice(ctx)) * PPM) / ctx.minRatio;
  const gross = room > v.debt ? room - v.debt : 0n;
  return gross - (gross * ctx.originationBps) / BPS;
}

export async function poolLiquidation(ctx: Ctx, keeper: Signer, victim: string): Promise<string[]> {
  const v = await vaultState(ctx, victim);
  const need = await fullRepayment(ctx, v);
  const m0 = await market(ctx);
  const reserve0 = m0.reservePaxg;
  const keeper0 = await ctx.paxg.balanceOf(keeper.address);
  // Under water only a full liquidation is allowed; otherwise a pool short of the debt takes a partial.
  const repay = need < v.debt || m0.stabilityPool > need ? 0n : m0.stabilityPool - E18;
  let outcome = "absorbed";
  try {
    await send(ctx.vault.connect(keeper).liquidateViaPool(victim, repay, { gasLimit: GAS.liquidation }));
  } catch (error) {
    outcome = `refused: ${reason(error)}`;
  }
  const a = await vaultState(ctx, victim);
  const m1 = await market(ctx);
  const bounty = (await ctx.paxg.balanceOf(keeper.address)) - keeper0;
  const seized = v.collateral - a.collateral;
  return [
    "liquidateViaPool", outcome, repay === 0n ? fullLabel(need) : g(repay), g(m0.stabilityPool - m1.stabilityPool), g(v.debt - a.debt), g(seized, 6),
    g(bounty, 6), g(seized - bounty, 6), g(m1.bufferGsusd - m0.bufferGsusd, 4), g(m1.bufferPaxg - m0.bufferPaxg, 6), g(m1.reservePaxg - reserve0, 6),
    g(m1.badDebt - m0.badDebt), ratioText(a.ratioPpm), m1.paused ? "yes" : "no", "n/a",
  ];
}

/** A liquidator holding only PAXG buys the GSUSD it needs in the pool, then liquidates `size` (0 for in full). */
export async function marketLiquidation(ctx: Ctx, liquidator: Signer, victim: string, size: bigint): Promise<string[]> {
  const path = "direct, buys GSUSD in the pool";
  const v = await vaultState(ctx, victim);
  const price = await ctx.oracle.quoteTokenPrice(ctx.PAXG);
  const need = size === 0n ? await fullRepayment(ctx, v) : min(size, v.debt);
  // A full liquidation buys 1 GSUSD over the requirement for the fee accrued before the call lands.
  const buy = size === 0n ? need + E18 : need;
  const label = size === 0n ? fullLabel(need) : g(need);
  const needPaxg = await quotePaxgForGsusd(ctx, buy);
  if (needPaxg === null) return [path, `pool cannot supply ${g(buy)} GSUSD`, label, ...NA(11), "no"];
  const m0 = await market(ctx);
  await send(ctx.paxg.connect(liquidator).mint(liquidator.address, needPaxg * 2n, { gasLimit: GAS.token }));
  await send(ctx.paxg.connect(liquidator).approve(DEX.router, MAX, { gasLimit: GAS.token }));
  await send(ctx.gsusd.connect(liquidator).approve(await ctx.vault.getAddress(), MAX, { gasLimit: GAS.token }));
  await send(ctx.router.connect(liquidator).getFunction("exactOutputSingle")(
    { tokenIn: ctx.PAXG, tokenOut: ctx.GSUSD, fee: ctx.poolFee, recipient: liquidator.address, amountOut: buy, amountInMaximum: (needPaxg * 1001n) / 1000n, sqrtPriceLimitX96: 0n },
    { gasLimit: GAS.swap }
  ));
  const gsusdAfterBuy = await poolGsusdPpm(ctx);
  const paxgBefore = await ctx.paxg.balanceOf(liquidator.address);
  let outcome = "liquidated";
  try {
    await send(ctx.vault.connect(liquidator).liquidate(victim, size === 0n ? 0n : need, { gasLimit: GAS.liquidation }));
  } catch (error) {
    outcome = `refused: ${reason(error)}`;
  }
  const received = (await ctx.paxg.balanceOf(liquidator.address)) - paxgBefore;
  const leftover = await ctx.gsusd.balanceOf(liquidator.address);
  const a = await vaultState(ctx, victim);
  const m1 = await market(ctx);
  // GSUSD left over after the call is the liquidator's, valued at par.
  const profit = valueUsd(received, price) + leftover - valueUsd(needPaxg, price);
  return [
    path, outcome, label, "n/a", g(v.debt - a.debt), g(v.collateral - a.collateral, 6), g(received, 6),
    `PAXG paid for ${g(buy)} GSUSD ${g(needPaxg, 6)}; profit ${g(profit)} USD`, g(m1.bufferGsusd - m0.bufferGsusd, 4), g(m1.bufferPaxg - m0.bufferPaxg, 6),
    g(m1.reservePaxg - m0.reservePaxg, 6), g(m1.badDebt - m0.badDebt), ratioText(a.ratioPpm), m1.paused ? "yes" : "no", `pool GSUSD ${g(gsusdAfterBuy, 4, 6)} USD after the buy`,
  ];
}

/** A liquidator that already holds GSUSD (the deployer wallet, impersonated). */
export async function inventoryLiquidation(ctx: Ctx, holder: Signer, victim: string): Promise<string[]> {
  const path = "direct, own GSUSD inventory";
  const v = await vaultState(ctx, victim);
  const held = await ctx.gsusd.balanceOf(holder.address);
  const price = await ctx.oracle.quoteTokenPrice(ctx.PAXG);
  const need = await fullRepayment(ctx, v);
  // 0.001% over the requirement covers the fee accrued before the call lands.
  const full = held > need + need / 100_000n;
  if (!full && need < v.debt) {
    return [path, `cannot: holds ${g(held)} GSUSD; an under water vault takes only a full liquidation, which repays ${g(need)}`, fullLabel(need), ...NA(11), "n/a"];
  }
  if (!full && held < MIN_LEG) return [path, `cannot: holds only ${g(held)} GSUSD`, "n/a", ...NA(11), "n/a"];
  const repay = full ? 0n : held - E18;
  const m0 = await market(ctx);
  await send(ctx.gsusd.connect(holder).approve(await ctx.vault.getAddress(), MAX, { gasLimit: GAS.token }));
  const p0 = await ctx.paxg.balanceOf(holder.address);
  let outcome = "liquidated";
  try {
    await send(ctx.vault.connect(holder).liquidate(victim, repay, { gasLimit: GAS.liquidation }));
  } catch (error) {
    outcome = `refused: ${reason(error)}`;
  }
  const received = (await ctx.paxg.balanceOf(holder.address)) - p0;
  const paid = held - (await ctx.gsusd.balanceOf(holder.address));
  const a = await vaultState(ctx, victim);
  const m1 = await market(ctx);
  return [
    path, outcome, full ? fullLabel(need) : g(repay), "n/a", g(v.debt - a.debt), g(v.collateral - a.collateral, 6), g(received, 6),
    `paid ${g(paid)} GSUSD; profit ${g(valueUsd(received, price) - paid)} USD on ${g(held)} GSUSD held`, g(m1.bufferGsusd - m0.bufferGsusd, 4), g(m1.bufferPaxg - m0.bufferPaxg, 6),
    g(m1.reservePaxg - m0.reservePaxg, 6), g(m1.badDebt - m0.badDebt), ratioText(a.ratioPpm), m1.paused ? "yes" : "no", "n/a",
  ];
}

/**
 * A liquidator with PAXG and no GSUSD mints what a full liquidation needs: it deposits PAXG,
 * mints at `ratioPpm` of the borrowing price (paying the origination fee), liquidates in full
 * and keeps its own vault. The reference keeper does not do this, but anyone may while minting
 * is open. Profit counts the PAXG received less the GSUSD paid and the origination fee; GSUSD
 * left over is the liquidator's against its own debt. The buffer change includes that fee.
 */
export async function mintLiquidation(ctx: Ctx, liquidator: Signer, victim: string, ratioPpm: bigint): Promise<string[]> {
  const path = "direct, mints its GSUSD against own PAXG";
  const v = await vaultState(ctx, victim);
  const price = await ctx.oracle.quoteTokenPrice(ctx.PAXG);
  const need = await fullRepayment(ctx, v);
  const m0 = await market(ctx);
  let own: OwnMint;
  try {
    own = await mintFromOwnVault(ctx, liquidator, need + E18, ratioPpm);
  } catch (error) {
    return [path, `cannot mint: ${reason(error)}`, fullLabel(need), ...NA(11), "n/a"];
  }
  await send(ctx.gsusd.connect(liquidator).approve(await ctx.vault.getAddress(), MAX, { gasLimit: GAS.token }));
  const p0 = await ctx.paxg.balanceOf(liquidator.address);
  const g0 = await ctx.gsusd.balanceOf(liquidator.address);
  let outcome = "liquidated";
  try {
    await send(ctx.vault.connect(liquidator).liquidate(victim, 0n, { gasLimit: GAS.liquidation }));
  } catch (error) {
    outcome = `refused: ${reason(error)}`;
  }
  const received = (await ctx.paxg.balanceOf(liquidator.address)) - p0;
  const paid = g0 - (await ctx.gsusd.balanceOf(liquidator.address));
  const a = await vaultState(ctx, victim);
  const mine = await vaultState(ctx, liquidator.address);
  const m1 = await market(ctx);
  const profit = valueUsd(received, price) - paid - own.fee;
  return [
    path, outcome, fullLabel(need), "n/a", g(v.debt - a.debt), g(v.collateral - a.collateral, 6), g(received, 6),
    `deposited ${g(own.deposited, 6)} PAXG, minted ${g(own.minted)} GSUSD (fee ${g(own.fee, 4)}), paid ${g(paid)}; profit ${g(profit)} USD; own vault at ${ratioText(mine.ratioPpm)}`,
    g(m1.bufferGsusd - m0.bufferGsusd, 4), g(m1.bufferPaxg - m0.bufferPaxg, 6), g(m1.reservePaxg - m0.reservePaxg, 6), g(m1.badDebt - m0.badDebt),
    ratioText(a.ratioPpm), m1.paused ? "yes" : "no", "buffer change includes the liquidator's origination fee",
  ];
}
