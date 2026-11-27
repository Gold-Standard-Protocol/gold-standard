/**
 * Shared pieces of scripts/rehearse-leverage-loop.ts: constants, the markdown report, the fork
 * context, market and vault reads, feed moves, minting from a wallet's own vault and the two
 * pool arbitrageurs. Fork only; nothing here reads a key or an RPC URL.
 */
import { ethers, network } from "hardhat";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import type { Contract, ContractTransactionResponse } from "ethers";
import { writeFileSync } from "node:fs";
import { describeError } from "./redact";

export type Signer = HardhatEthersSigner;

export const PPM = 1_000_000n;
export const BPS = 10_000n;
export const E18 = 10n ** 18n;
export const E8 = 10n ** 8n;
export const MAX = (1n << 256n) - 1n;
export const DAY = 86_400n;
const Q96 = 1n << 96n;

/** The Sepolia GSUSD/PAXG pool, SwapRouter02 and QuoterV2; DEX_POOL, DEX_ROUTER and DEX_QUOTER override them. */
export const DEX = {
  pool: process.env.DEX_POOL ?? "0x295b850f0aAb56b3c34276B5668FE2489f844188",
  router: process.env.DEX_ROUTER ?? "0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E",
  quoter: process.env.DEX_QUOTER ?? "0xEd1f6473345F45b75F8179591dd5bA1888cf2FB3",
};

export const MAX_SLIPPAGE_PPM = 30_000n; // 3% average cost against the oracle borrowing price
export const MIN_LEG = 10n * E18; // a purchase below 10 GSUSD is not worth a loop
const MAX_WALK_STEP_BPS = 900n; // every feed moves together, at most 9% a step

export const GAS = {
  vault: 3_000_000n,
  close: 5_000_000n,
  liquidation: 8_000_000n,
  swap: 1_500_000n,
  token: 250_000n,
  feed: 250_000n,
} as const;

export const QUOTER_ABI = [
  "function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
  "function quoteExactOutputSingle((address tokenIn, address tokenOut, uint256 amount, uint24 fee, uint160 sqrtPriceLimitX96) params) returns (uint256 amountIn, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
];
export const ROUTER_ABI = [
  "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)",
  "function exactOutputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountOut, uint256 amountInMaximum, uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountIn)",
];
export const POOL_ABI = [
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "function token0() view returns (address)",
  "function fee() view returns (uint24)",
  "function liquidity() view returns (uint128)",
];

// ---------------------------------------------------------------- formatting and report

export const num = (v: bigint, decimals = 18): number => Number(ethers.formatUnits(v, decimals));
export const g = (v: bigint, dp = 2, decimals = 18): string =>
  num(v, decimals).toLocaleString("en-GB", { minimumFractionDigits: dp, maximumFractionDigits: dp });
export const usd = (v8: bigint): string => g(v8, 2, 8);
export const pct = (ppm: bigint, dp = 2): string => `${(Number(ppm) / 10_000).toFixed(dp)}%`;
export const times = (ppm: bigint): string => `${(Number(ppm) / 1_000_000).toFixed(3)}x`;
export const ratioText = (ppm: bigint | null): string => (ppm === null ? "no debt" : pct(ppm));
export const min = (a: bigint, b: bigint): bigint => (a < b ? a : b);
export const max = (a: bigint, b: bigint): bigint => (a > b ? a : b);
export const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;
export const short = (address: string): string => `${address.slice(0, 6)}…${address.slice(-4)}`;

const report: string[] = [];
let reportPath: string | undefined;
function push(text: string): void {
  report.push(text);
  if (reportPath) writeFileSync(reportPath, report.join(""));
}
/** Write the report to `path` now and again after every addition, so a failure later in a long run loses nothing. */
export function writeReportTo(path: string | undefined): void {
  reportPath = path;
  if (reportPath) writeFileSync(reportPath, report.join(""));
}
export function heading(title: string): void {
  push(`# ${title}\n`);
  console.log(`# ${title}`);
}
export function section(title: string, body = ""): void {
  push(`\n## ${title}\n${body ? `\n${body}\n` : ""}`);
  console.log(`\n## ${title}`);
  if (body) console.log(body);
}
export function note(text: string): void {
  push(`\n${text}\n`);
  console.log(text);
}
export function table(headers: string[], rows: string[][]): void {
  const lines = [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((r) => `| ${r.join(" | ")} |`),
  ];
  const text = lines.join("\n");
  push(`\n${text}\n`);
  console.log(text);
}
export const reason = (error: unknown): string => {
  const message = describeError(error);
  return (
    message.match(/reverted with reason string '([^']+)'/)?.[1] ??
    message.match(/reason="([^"]+)"/)?.[1] ??
    message.match(/custom error '([^']+)'/)?.[1] ??
    message.slice(0, 120)
  );
};

// ---------------------------------------------------------------- context

export interface Snapshot {
  deployer: string;
  deployBlock: number;
  addresses: Record<string, string>;
  config: Record<string, string> & { paxgToken: string; paxgFeed: string; anchorFeed: string };
  build: { runtimeCodeHashes: Record<string, string> };
}

export async function contracts(snap: Snapshot) {
  const a = snap.addresses;
  const cfg = snap.config;
  return {
    vault: await ethers.getContractAt("GoldVault", a.vault),
    oracle: await ethers.getContractAt("GoldOracle", a.oracle),
    gsusd: await ethers.getContractAt("GoldStablecoin", a.stablecoin),
    reserve: await ethers.getContractAt("GoldStabilityReserve", a.reserve),
    buffer: await ethers.getContractAt("SurplusBuffer", a.surplusBuffer),
    stabilityPool: await ethers.getContractAt("StabilityPool", a.stabilityPool),
    paxg: await ethers.getContractAt("MockERC20", cfg.paxgToken),
    // XAUT is dormant on the current deployment: PAXG's two price sources are its market
    // feed (C) and the XAU/USD anchor (G), and they always move together here.
    feeds: await Promise.all([cfg.paxgFeed, cfg.anchorFeed].map((f: string) => ethers.getContractAt("MockAggregatorV3", f))),
  };
}
type Contracts = Awaited<ReturnType<typeof contracts>>;

export interface Ctx extends Contracts {
  quoter: Contract;
  router: Contract;
  pool: Contract;
  PAXG: string;
  GSUSD: string;
  poolFee: bigint;
  paxgIsToken0: boolean;
  originationBps: bigint;
  minRatio: bigint;
  liqRatio: bigint;
  minDebt: bigint;
  operator: Signer;
  spares: Signer[];
}

export const send = async (p: Promise<ContractTransactionResponse>): Promise<bigint> => {
  const receipt = await (await p).wait();
  if (!receipt) throw new Error("no receipt");
  return receipt.gasUsed;
};
export const snapshot = async (): Promise<string> => (await network.provider.send("evm_snapshot", [])) as string;
export const revertTo = async (id: string): Promise<void> => {
  const ok = (await network.provider.send("evm_revert", [id])) as boolean;
  if (!ok) throw new Error(`evm_revert ${id} failed`);
};
export async function latestTimestamp(): Promise<bigint> {
  const block = await ethers.provider.getBlock("latest");
  if (!block) throw new Error("no latest block");
  return BigInt(block.timestamp);
}

// ---------------------------------------------------------------- market reads

export const borrowPrice = (ctx: Ctx): Promise<bigint> => ctx.oracle.quoteBorrowPrice(ctx.PAXG);
export const valueUsd = (paxg: bigint, price8: bigint): bigint => (paxg * price8) / E8;

/** Pool price of PAXG in GSUSD, 8 decimals. Both tokens carry 18 decimals. */
export async function poolPrice(ctx: Ctx): Promise<bigint> {
  const sqrtP = BigInt((await ctx.pool.getFunction("slot0")())[0]);
  const raw = (sqrtP * sqrtP * E8) >> 192n; // token1 per token0, 8 decimals
  return ctx.paxgIsToken0 ? raw : (E8 * E8) / raw;
}
/** What one GSUSD is worth in the pool, in USD at the oracle price, as ppm of a dollar. */
export const poolGsusdPpm = async (ctx: Ctx): Promise<bigint> => ((await borrowPrice(ctx)) * PPM) / (await poolPrice(ctx));

export async function quotePoolBuy(ctx: Ctx, gsusdIn: bigint): Promise<bigint> {
  if (gsusdIn === 0n) return 0n;
  try {
    const r = await ctx.quoter.getFunction("quoteExactInputSingle").staticCall({
      tokenIn: ctx.GSUSD, tokenOut: ctx.PAXG, amountIn: gsusdIn, fee: ctx.poolFee, sqrtPriceLimitX96: 0n,
    });
    return BigInt(r[0]);
  } catch {
    return 0n;
  }
}
export async function quotePoolSell(ctx: Ctx, paxgIn: bigint): Promise<bigint> {
  if (paxgIn === 0n) return 0n;
  try {
    const r = await ctx.quoter.getFunction("quoteExactInputSingle").staticCall({
      tokenIn: ctx.PAXG, tokenOut: ctx.GSUSD, amountIn: paxgIn, fee: ctx.poolFee, sqrtPriceLimitX96: 0n,
    });
    return BigInt(r[0]);
  } catch {
    return 0n;
  }
}
/** PAXG needed to buy exactly `gsusdOut` in the pool; null when the pool cannot supply it. */
export async function quotePaxgForGsusd(ctx: Ctx, gsusdOut: bigint): Promise<bigint | null> {
  try {
    const r = await ctx.quoter.getFunction("quoteExactOutputSingle").staticCall({
      tokenIn: ctx.PAXG, tokenOut: ctx.GSUSD, amount: gsusdOut, fee: ctx.poolFee, sqrtPriceLimitX96: 0n,
    });
    return BigInt(r[0]);
  } catch {
    return null;
  }
}
export async function quoteReserve(ctx: Ctx, gsusdIn: bigint): Promise<{ goldOut: bigint; spreadPpm: bigint }> {
  if (gsusdIn === 0n) return { goldOut: 0n, spreadPpm: 0n };
  const [goldOut, spreadPpm] = await ctx.reserve.quoteGoldOut(ctx.PAXG, gsusdIn);
  return { goldOut, spreadPpm };
}
/** Average cost of a GSUSD to PAXG purchase against the oracle borrowing price, in ppm. */
const buyCostPpm = (gsusdIn: bigint, paxgOut: bigint, price8: bigint): bigint =>
  paxgOut === 0n ? PPM : PPM - (valueUsd(paxgOut, price8) * PPM) / gsusdIn;

/** Largest GSUSD purchase up to `limit` whose average cost stays within `capPpm`. */
export async function maxPoolBuyInput(ctx: Ctx, limit: bigint, capPpm: bigint): Promise<bigint> {
  if (limit === 0n) return 0n;
  const price = await borrowPrice(ctx);
  const ok = async (amount: bigint) => buyCostPpm(amount, await quotePoolBuy(ctx, amount), price) <= capPpm;
  if (await ok(limit)) return limit;
  let lo = 0n;
  let hi = limit;
  while (hi - lo > E18 / 100n) {
    const mid = (lo + hi) / 2n;
    if (await ok(mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}
/** Largest GSUSD purchase up to `limit` the reserve's daily capacity can fill. */
export async function maxReserveInput(ctx: Ctx, limit: bigint): Promise<bigint> {
  if (limit === 0n) return 0n;
  const cap = await ctx.reserve.remainingDailyCapacity(ctx.PAXG);
  if (cap === 0n) return 0n;
  const full = await quoteReserve(ctx, limit);
  if (full.goldOut === 0n) return 0n;
  if (full.goldOut <= cap) return limit;
  let lo = 0n;
  let hi = limit;
  while (hi - lo > E18 / 100n) {
    const mid = (lo + hi) / 2n;
    if ((await quoteReserve(ctx, mid)).goldOut <= cap) lo = mid;
    else hi = mid;
  }
  return (lo * 9_999n) / 10_000n;
}
/** Largest PAXG sale up to `limit` whose average loss against the oracle stays within `capPpm`. */
export async function maxPoolSellInput(ctx: Ctx, limit: bigint, capPpm: bigint): Promise<bigint> {
  if (limit === 0n) return 0n;
  const price = await borrowPrice(ctx);
  const ok = async (amount: bigint) => {
    const out = await quotePoolSell(ctx, amount);
    return out > 0n && PPM - (out * PPM) / valueUsd(amount, price) <= capPpm;
  };
  if (await ok(limit)) return limit;
  let lo = 0n;
  let hi = limit;
  while (hi - lo > E18 / 100_000n) {
    const mid = (lo + hi) / 2n;
    if (await ok(mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}

export interface Market {
  price: bigint;
  poolPrice: bigint;
  gsusdPpm: bigint;
  poolGsusd: bigint;
  poolPaxg: bigint;
  reservePaxg: bigint;
  capLeft: bigint;
  spreadPpm: bigint;
  coveragePpm: bigint;
  inventory: bigint;
  stabilityPool: bigint;
  bufferGsusd: bigint;
  bufferPaxg: bigint;
  supply: bigint;
  badDebt: bigint;
  paused: boolean;
}
export async function market(ctx: Ctx): Promise<Market> {
  const price = await borrowPrice(ctx);
  const pp = await poolPrice(ctx);
  return {
    price,
    poolPrice: pp,
    gsusdPpm: (price * PPM) / pp,
    poolGsusd: await ctx.gsusd.balanceOf(DEX.pool),
    poolPaxg: await ctx.paxg.balanceOf(DEX.pool),
    reservePaxg: await ctx.reserve.collateralBalance(ctx.PAXG),
    capLeft: await ctx.reserve.remainingDailyCapacity(ctx.PAXG),
    spreadPpm: await ctx.reserve.currentSpreadPpm(),
    coveragePpm: await ctx.reserve.coveragePpm(),
    inventory: await ctx.reserve.gsusdInventory(),
    stabilityPool: await ctx.stabilityPool.getTotalDeposits(),
    bufferGsusd: await ctx.buffer.gsusdBalance(),
    bufferPaxg: await ctx.buffer.collateralBalance(ctx.PAXG),
    supply: await ctx.gsusd.totalSupply(),
    badDebt: await ctx.vault.totalBadDebt(),
    paused: await ctx.vault.paused(),
  };
}

export interface VaultState {
  collateral: bigint;
  principal: bigint;
  debt: bigint;
  ratioPpm: bigint | null;
  liqPrice: bigint;
}
export async function vaultState(ctx: Ctx, owner: string): Promise<VaultState> {
  const v = await ctx.vault.vaults(owner);
  const debt = await ctx.vault.getVaultCurrentDebt(owner);
  const ratio = await ctx.vault.getCollateralisationRatio(owner);
  return {
    collateral: v.collateralAmount,
    principal: v.debtAmount,
    debt,
    ratioPpm: ratio > 10n ** 30n ? null : ratio,
    liqPrice: await ctx.vault.getLiquidationPrice(owner),
  };
}

// ---------------------------------------------------------------- feeds

export async function setFeeds(ctx: Ctx, price8: bigint): Promise<void> {
  await network.provider.send("evm_mine", []);
  const now = await latestTimestamp();
  for (const feed of ctx.feeds) {
    const round = (await feed.latestRoundData())[0] + 1n;
    await send(feed.connect(ctx.operator).setLatestRoundData(round, price8, now, now, round, { gasLimit: GAS.feed }));
  }
  // Advance lastKnownPrice so the vault's view ratio and the next step read this price.
  await send(ctx.oracle.connect(ctx.operator).getTokenPrice(ctx.PAXG, { gasLimit: GAS.feed }));
}
/** Walk both PAXG price sources together, at most 9% a step, as walk-testnet-price.ts does. */
export async function walkTo(ctx: Ctx, target8: bigint): Promise<void> {
  let price = (await ctx.feeds[0].latestRoundData())[1];
  while (price !== target8) {
    const maxMove = (price * MAX_WALK_STEP_BPS) / BPS;
    const diff = target8 > price ? target8 - price : price - target8;
    const step = diff < maxMove ? diff : maxMove;
    price = target8 > price ? price + step : price - step;
    await setFeeds(ctx, price);
  }
}
export async function advanceToNextUtcDay(ctx: Ctx, price8: bigint): Promise<bigint> {
  const now = await latestTimestamp();
  const next = (now / DAY + 1n) * DAY + 120n;
  await network.provider.send("evm_setNextBlockTimestamp", [Number(next)]);
  await network.provider.send("evm_mine", []);
  await setFeeds(ctx, price8);
  return next;
}

// ---------------------------------------------------------------- minting from a wallet's own vault

export interface OwnMint {
  minted: bigint;
  fee: bigint;
  deposited: bigint;
}
/**
 * Mint in `who`'s own vault so its wallet receives at least `net` GSUSD after the origination
 * fee, first depositing mock PAXG so the vault sits at `ratioPpm` or above at the borrowing
 * price. Any wallet holding PAXG can do this while the vault is unpaused, the borrowing price is
 * in band and the feeds are fresh (GoldVault.sol:409-466).
 */
export async function mintFromOwnVault(ctx: Ctx, who: Signer, net: bigint, ratioPpm: bigint): Promise<OwnMint> {
  const price = await borrowPrice(ctx);
  const v = await vaultState(ctx, who.address);
  let gross = ceilDiv(net * BPS, BPS - ctx.originationBps);
  if (v.principal === 0n && gross < ctx.minDebt) gross = ctx.minDebt;
  const needed = ceilDiv((v.debt + gross) * ratioPpm * E8, PPM * price);
  const deposited = needed > v.collateral ? needed - v.collateral : 0n;
  if (deposited > 0n) {
    await send(ctx.paxg.connect(who).mint(who.address, deposited, { gasLimit: GAS.token }));
    await send(ctx.paxg.connect(who).approve(await ctx.vault.getAddress(), MAX, { gasLimit: GAS.token }));
    await send(ctx.vault.connect(who).deposit(ctx.PAXG, deposited, { gasLimit: GAS.vault }));
  }
  const before = await ctx.gsusd.balanceOf(who.address);
  await send(ctx.vault.connect(who).mint(gross, { gasLimit: GAS.vault }));
  const received = (await ctx.gsusd.balanceOf(who.address)) - before;
  return { minted: gross, fee: gross - received, deposited };
}

// ---------------------------------------------------------------- pool arbitrage

/** Integer square root by Newton's method; exact floor for any non-negative bigint. */
function isqrt(n: bigint): bigint {
  if (n < 2n) return n;
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  return x;
}
/** The pool's sqrtPriceX96 when it prices PAXG at `price8` GSUSD. */
const sqrtPriceAt = (ctx: Ctx, price8: bigint): bigint =>
  ctx.paxgIsToken0 ? isqrt((price8 << 192n) / E8) : isqrt((E8 << 192n) / price8);

export interface Arbitrage {
  paxgSold: bigint;
  gsusdBought: bigint;
  note: string;
}
/**
 * After gold falls the pool still prices PAXG at the old level, so GSUSD there trades below
 * par against the oracle. An arbitrageur sells PAXG into the pool until its price meets the
 * oracle again, which is what a live market would do between blocks; without it a liquidator
 * would be buying stale, cheap GSUSD. The arbitrageur keeps the GSUSD it buys.
 */
export async function alignPool(ctx: Ctx, arb: Signer): Promise<Arbitrage> {
  const target = await borrowPrice(ctx);
  if ((await poolPrice(ctx)) <= target) return { paxgSold: 0n, gsusdBought: 0n, note: "pool at or below the oracle; nothing to sell" };
  const limit = sqrtPriceAt(ctx, target);
  const budget = 1_000n * E18;
  await send(ctx.paxg.connect(arb).mint(arb.address, budget, { gasLimit: GAS.token }));
  await send(ctx.paxg.connect(arb).approve(DEX.router, MAX, { gasLimit: GAS.token }));
  const p0 = await ctx.paxg.balanceOf(arb.address);
  const g0 = await ctx.gsusd.balanceOf(arb.address);
  await send(ctx.router.connect(arb).getFunction("exactInputSingle")(
    { tokenIn: ctx.PAXG, tokenOut: ctx.GSUSD, fee: ctx.poolFee, recipient: arb.address, amountIn: budget, amountOutMinimum: 0n, sqrtPriceLimitX96: limit },
    { gasLimit: GAS.swap }
  ));
  return {
    paxgSold: p0 - (await ctx.paxg.balanceOf(arb.address)),
    gsusdBought: (await ctx.gsusd.balanceOf(arb.address)) - g0,
    note: "sold PAXG into the pool down to the oracle price",
  };
}

export interface PoolRestore {
  gsusdMinted: bigint;
  gsusdSold: bigint;
  paxgBought: bigint;
}
/** An arbitrageur mints at 200% of the borrowing price: far from any ratio this script tests. */
const ARB_VAULT_RATIO_PPM = 2_000_000n;
/**
 * The reverse of alignPool, for unwinds. A sale of PAXG into the pool leaves it pricing PAXG
 * below the oracle, so GSUSD there trades above par. While minting is open an arbitrageur mints
 * GSUSD against its own PAXG and sells it into the pool for PAXG until the next GSUSD would no
 * longer cover the pool fee and the origination fee: the pool then prices PAXG at the oracle
 * less those two costs. Without this step every unwind sale lifts GSUSD in a 5 PAXG pool
 * further, which no live market with open minting allows.
 *
 * The GSUSD to send is the closed form for one full range position (the Sepolia pool holds one),
 * with a 1% margin; the swap stops at the price limit and any GSUSD left stays with the
 * arbitrageur.
 */
export async function restorePool(ctx: Ctx, arb: Signer): Promise<PoolRestore> {
  const nothing = { gsusdMinted: 0n, gsusdSold: 0n, paxgBought: 0n };
  const costPpm = ctx.poolFee + ctx.originationBps * 100n;
  const target = ((await borrowPrice(ctx)) * (PPM - costPpm)) / PPM;
  if ((await poolPrice(ctx)) >= target) return nothing;
  const limit = sqrtPriceAt(ctx, target);
  const sqrtNow = BigInt((await ctx.pool.getFunction("slot0")())[0]);
  const liquidity = BigInt(await ctx.pool.getFunction("liquidity")());
  // GSUSD in, after the pool fee, that moves the price to the limit: token1 in raises sqrtP,
  // token0 in lowers it.
  const netIn = ctx.paxgIsToken0
    ? (liquidity * (limit - sqrtNow)) / Q96
    : (liquidity * Q96 * (sqrtNow - limit)) / (sqrtNow * limit);
  if (netIn <= 0n) return nothing;
  const grossIn = ceilDiv(netIn * PPM, PPM - ctx.poolFee);
  const want = grossIn + grossIn / 100n + E18;
  const held = await ctx.gsusd.balanceOf(arb.address);
  const minted = held < want ? (await mintFromOwnVault(ctx, arb, want - held, ARB_VAULT_RATIO_PPM)).minted : 0n;
  await send(ctx.gsusd.connect(arb).approve(DEX.router, MAX, { gasLimit: GAS.token }));
  const g0 = await ctx.gsusd.balanceOf(arb.address);
  const p0 = await ctx.paxg.balanceOf(arb.address);
  await send(ctx.router.connect(arb).getFunction("exactInputSingle")(
    { tokenIn: ctx.GSUSD, tokenOut: ctx.PAXG, fee: ctx.poolFee, recipient: arb.address, amountIn: g0, amountOutMinimum: 0n, sqrtPriceLimitX96: limit },
    { gasLimit: GAS.swap }
  ));
  return {
    gsusdMinted: minted,
    gsusdSold: g0 - (await ctx.gsusd.balanceOf(arb.address)),
    paxgBought: (await ctx.paxg.balanceOf(arb.address)) - p0,
  };
}
