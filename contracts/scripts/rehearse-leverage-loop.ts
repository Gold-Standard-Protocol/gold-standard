/**
 * Fork only: measure leverage looping (deposit PAXG, mint GSUSD, buy PAXG with it, deposit
 * that and mint again) on a Hardhat fork of the current Sepolia deployment, against the real
 * Uniswap v3 GSUSD/PAXG pool, the real GoldStabilityReserve and the real vault state.
 *
 *   npx hardhat node --fork <sepolia rpc> --fork-block-number <head minus 3> --port 8548
 *   LOCAL_RPC_URL=http://127.0.0.1:8548 LOOP_REPORT=/path/to/report.md \
 *     npx hardhat run scripts/rehearse-leverage-loop.ts --network localhost
 *
 * Every scenario starts from the same evm_snapshot, so the runs never see each other.
 *
 *   A  Loopers with 1, 5 and 20 PAXG of equity loop to 160% and to 140% through the pool only,
 *      the reserve only and the better venue on each leg (plus an informational pool run with
 *      no slippage cap). A route stops when it has no capacity left, when the average cost of
 *      the next purchase against the oracle borrowing price would exceed 3% or when the next
 *      step is below 1% of the equity.
 *   B  One large looper loops towards 130% through the better venue on each leg, day after
 *      day, until the reserve and the pool allow no more. Gold then walks down 5%, 10%, 15%,
 *      20% (and 25%, beyond the brief). At each level an arbitrageur first brings the pool
 *      back to the oracle price; the script then lists which vaults are liquidatable and,
 *      from a snapshot, runs liquidateViaPool, a direct liquidation by a liquidator who must
 *      buy its GSUSD in the pool, one by a liquidator with inventory and one by a liquidator
 *      who mints its GSUSD against its own PAXG.
 *   C  Unwinding by stepping out: withdraw the PAXG the ratio allows, sell it in the pool,
 *      repay, repeat. Between steps an arbitrageur mints GSUSD and sells it into the pool
 *      until the pool prices PAXG at the oracle less its costs, and each sale is held to 3%
 *      average cost (UNWIND_ARB=0 leaves the pool as each sale leaves it, which only a pool
 *      with no arbitrage would do, and lets a sale lose up to half).
 *
 * Env:
 *   LOOP_REPORT   path for the markdown report, rewritten after every addition (the report is
 *                 always printed)
 *   LP_ADDRESS    the liquidity wallet whose vault is watched (default: the Sepolia LP wallet)
 *   SCENARIOS     comma list of A, B and C (default: all three)
 *   B_EQUITY      PAXG of equity for scenario B (default 5)
 *   B_DAYS        UTC days scenario B may loop across (default 10)
 *   UNWIND_ARB    0 to run scenario C with no arbitrage between unwind steps (default 1)
 *   DEX_POOL, DEX_ROUTER, DEX_QUOTER
 *                 override the Sepolia GSUSD/PAXG pool, SwapRouter02 and QuoterV2 addresses
 *
 * Wallets are the fork node's own unlocked accounts and impersonated addresses; no key is
 * configured or read. REFUSES to run anywhere but chainId 31337 with the current Sepolia
 * deployment's vault code at its recorded address.
 */
import { ethers, network } from "hardhat";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  BPS, DEX, E18, MAX, POOL_ABI, PPM, QUOTER_ABI, ROUTER_ABI,
  advanceToNextUtcDay, alignPool, contracts, g, heading, market, note, pct, poolGsusdPpm, ratioText,
  reason, revertTo, section, setFeeds, short, snapshot, table, times, usd, vaultState, walkTo,
  writeReportTo,
  type Ctx, type Signer, type Snapshot,
} from "./lib/leverageMarket";
import {
  SUMMARY_HEADERS, loopPhase, loopTable, openLooper, summarise, summaryRow, unwind, unwindReport,
  type LoopRow, type LoopSummary, type Route,
} from "./lib/leverageLoopers";
import {
  LIQ_HEADERS, band, inventoryLiquidation, marketLiquidation, mintHeadroom, mintLiquidation, poolLiquidation,
} from "./lib/leverageLiquidation";
import { describeErrorStack } from "./lib/redact";

const DEPLOYMENT = "sepolia";
const DEPLOY_BLOCK = 12_213_256;
const DEFAULT_LP = "0x2c8DBd8e7530a28d207183D1F372e40bB3F0073B";

const MAX_LOOPS = 30;
const MAX_LOOPS_NOCAP = 10;
const CONVERGED_PPM_A = 10_000n; // stop when the next purchase is below 1% of the equity
const CONVERGED_PPM_B = 1_000n; // B pushes on to 0.1%
const TARGET_A = [1_600_000n, 1_400_000n];
const EQUITY_A = [1n, 5n, 20n];
const TARGET_B = 1_300_500n; // 130.05%: as close to the 130% floor as a fee accruing per second allows
const WALK_LEVELS_BPS = [500n, 1_000n, 1_500n, 2_000n, 2_500n];
const LIQUIDATION_SIZES = [100n, 500n, 1_000n, 2_500n, 5_000n, 10_000n].map((n) => n * E18);
const NA = (n: number): string[] => Array<string>(n).fill("n/a");

async function main(): Promise<void> {
  const chainId = (await ethers.provider.getNetwork()).chainId;
  if (chainId !== 31337n || network.name !== "localhost") throw new Error(`Refusing: chainId ${chainId} on ${network.name}; this script runs only on a local fork (31337).`);
  const snap = JSON.parse(readFileSync(resolve(__dirname, "../deployments", `${DEPLOYMENT}.json`), "utf8")) as Snapshot;
  if (snap.deployBlock !== DEPLOY_BLOCK) throw new Error(`Refusing: deployments/${DEPLOYMENT}.json is not the current deployment (block ${snap.deployBlock}).`);
  const vaultCode = await ethers.provider.getCode(snap.addresses.vault);
  if (vaultCode === "0x") throw new Error(`Refusing: no vault code at ${snap.addresses.vault}; is this a fork of Sepolia after block ${DEPLOY_BLOCK}?`);
  if (ethers.keccak256(vaultCode) !== snap.build.runtimeCodeHashes.vault) throw new Error("Refusing: vault runtime code differs from the deployment's recorded hash.");
  const forkBlock = await ethers.provider.getBlockNumber();
  const scenarios = new Set((process.env.SCENARIOS ?? "A,B,C").split(",").map((s) => s.trim().toUpperCase()));
  const unwindArb = process.env.UNWIND_ARB !== "0";
  writeReportTo(process.env.LOOP_REPORT);

  const c = await contracts(snap);
  const signers = await ethers.getSigners();
  const PAXG = ethers.getAddress(snap.config.paxgToken);
  const GSUSD = ethers.getAddress(snap.addresses.stablecoin);
  const colId = ethers.solidityPackedKeccak256(["address"], [PAXG]);
  const ct = await c.vault.collateralTypes(colId);
  const pool = new ethers.Contract(DEX.pool, POOL_ABI, ethers.provider);
  // Loopers, keepers and liquidators: the node's own accounts with no vault and no tokens here.
  const clean: Signer[] = [];
  for (const s of signers.slice(1)) {
    const v = await c.vault.vaults(s.address);
    if (v.collateralAmount === 0n && (await c.paxg.balanceOf(s.address)) === 0n && (await c.gsusd.balanceOf(s.address)) === 0n) clean.push(s);
    if (clean.length === 6) break;
  }
  if (clean.length < 6) throw new Error("Not enough clean node accounts for the run.");
  const ctx: Ctx = {
    ...c,
    quoter: new ethers.Contract(DEX.quoter, QUOTER_ABI, ethers.provider),
    router: new ethers.Contract(DEX.router, ROUTER_ABI, ethers.provider),
    pool,
    PAXG,
    GSUSD,
    poolFee: BigInt(await pool.getFunction("fee")()),
    paxgIsToken0: ethers.getAddress(await pool.getFunction("token0")()) === PAXG,
    originationBps: await c.vault.originationFeeBps(),
    minRatio: ct.minRatio,
    liqRatio: ct.liquidationRatio,
    minDebt: await c.vault.minDebt(),
    operator: signers[0],
    spares: clean,
  };
  const lpAddress = ethers.getAddress(process.env.LP_ADDRESS ?? DEFAULT_LP);
  await network.provider.send("hardhat_setBalance", [snap.deployer, "0x56BC75E2D63100000"]);
  const deployer = await ethers.getImpersonatedSigner(snap.deployer);

  // Restamp both price sources at their current answers, so staleness never decides a result.
  const startPrice = (await c.feeds[0].latestRoundData())[1];
  const anchorPrice = (await c.feeds[1].latestRoundData())[1];
  if (startPrice !== anchorPrice) note(`Note: PAXG/USD ${usd(startPrice)} and XAU/USD ${usd(anchorPrice)} differ at the fork; both are restamped at the PAXG answer.`);
  await setFeeds(ctx, startPrice);

  const m = await market(ctx);
  const block = await ethers.provider.getBlock("latest");
  if (!block) throw new Error("no latest block");
  heading("Leverage loop rehearsal on a fork of the current Sepolia deployment");
  section("Starting state");
  table(["measure", "value"], [
    ["fork block (Sepolia)", String(forkBlock)],
    ["fork time (UTC)", new Date(Number(block.timestamp) * 1000).toISOString()],
    ["vault code hash matches deployments/sepolia.json", "yes"],
    ["oracle borrowing price (USD)", usd(m.price)],
    ["pool price (GSUSD per PAXG)", usd(m.poolPrice)],
    ["pool GSUSD value (USD)", g(m.gsusdPpm, 4, 6)],
    ["pool holdings", `${g(m.poolPaxg, 4)} PAXG and ${g(m.poolGsusd)} GSUSD at the ${pct(ctx.poolFee, 2)} tier`],
    ["PAXG minRatio / liquidation ratio / penalty", `${pct(ct.minRatio)} / ${pct(ct.liquidationRatio)} / ${pct(ct.liquidationPenalty)}`],
    ["PAXG debt ceiling", ct.debtCeiling === MAX ? "none (uint256 max)" : g(ct.debtCeiling)],
    ["origination fee", `${ctx.originationBps} bps`],
    ["minDebt (GSUSD)", g(ctx.minDebt)],
    ["per-block mint cap", String(await c.vault.perBlockMintCap())],
    ["GSUSD supply", g(m.supply)],
    ["reserve PAXG / daily cap left / spread / coverage", `${g(m.reservePaxg, 4)} / ${g(m.capLeft, 4)} / ${pct(m.spreadPpm)} / ${pct(m.coveragePpm)}`],
    ["reserve GSUSD inventory", g(m.inventory)],
    ["stability pool deposits (GSUSD)", g(m.stabilityPool)],
    ["SurplusBuffer GSUSD / PAXG", `${g(m.bufferGsusd, 4)} / ${g(m.bufferPaxg, 6)}`],
    ["total bad debt", g(m.badDebt)],
    ["deployer GSUSD in wallet", g(await c.gsusd.balanceOf(snap.deployer))],
  ]);
  const watch: [string, string][] = [["deployer", snap.deployer], ["LP wallet", lpAddress]];
  table(["vault", "address", "PAXG", "debt (GSUSD)", "ratio", "liquidation price"], await Promise.all(watch.map(async ([name, address]) => {
    const v = await vaultState(ctx, address);
    return [name, short(address), g(v.collateral, 4), g(v.debt), ratioText(v.ratioPpm), usd(v.liqPrice)];
  })));

  // Hardhat drops a snapshot once it is reverted to, so the base is taken again after each
  // return. The feeds are restamped after every return across a time jump (scenario B moves
  // the clock), so a stale feed never decides a result.
  let base = await snapshot();
  const resetToBase = async (): Promise<void> => {
    await revertTo(base);
    await setFeeds(ctx, startPrice);
    base = await snapshot();
  };
  const looperSigner = clean[0];

  // ------------------------------------------------------------ A
  if (scenarios.has("A")) {
    section("A. Loops to 160% and 140% by route", "Cost columns are in GSUSD, valued at par. The per loop premium is the GSUSD swapped per PAXG against the oracle borrowing price, so on a reserve leg it is the spread alone; the 5 bps origination fee is its own column. A pool purchase is capped at 3% average cost against the oracle; pool-nocap is the same pool with no cap, for comparison, limited to 10 loops.");
    const summaries: LoopSummary[] = [];
    const details: { label: string; rows: LoopRow[] }[] = [];
    for (const target of TARGET_A) {
      for (const equityUnits of EQUITY_A) {
        for (const route of ["pool", "reserve", "best", "pool-nocap"] as Route[]) {
          const id = await snapshot();
          const label = `${equityUnits} PAXG to ${pct(target, 0)} via ${route}`;
          try {
            const looper = await openLooper(ctx, looperSigner, equityUnits * E18);
            const stop = await loopPhase(ctx, looper, route, target, CONVERGED_PPM_A, route === "pool-nocap" ? MAX_LOOPS_NOCAP : MAX_LOOPS);
            summaries.push(await summarise(ctx, looper, label, stop));
            details.push({ label, rows: looper.rows });
            console.log(`  done: ${label} (${looper.rows.length} loops, ${stop})`);
          } catch (error) {
            note(`${label}: FAILED ${reason(error)}`);
          }
          await revertTo(id);
        }
      }
    }
    section("A summary");
    table(SUMMARY_HEADERS, summaries.map(summaryRow));
    for (const d of details) {
      section(`A per loop: ${d.label}`);
      if (d.rows.length === 0) note("No loop was possible.");
      else loopTable(d.rows);
    }
  }

  // ------------------------------------------------------------ B
  let bLooped: string | null = null;
  const bOwner = clean[1];
  if (scenarios.has("B") || scenarios.has("C")) {
    await resetToBase();
    const equity = BigInt(process.env.B_EQUITY ?? "5") * E18;
    const days = Number(process.env.B_DAYS ?? "10");
    section("B. One large looper takes what the pool and the reserve allow", `Equity ${g(equity, 0)} PAXG, target ${pct(TARGET_B)}, the better venue on each leg (pool capped at 3% average cost). When both venues are exhausted for the UTC day the fork moves to the next UTC day (feeds restamped at the same price) and the looper carries on, for at most ${days} days.`);
    const looper = await openLooper(ctx, bOwner, equity);
    const dayRows: string[][] = [];
    let stop = "";
    try {
      for (let day = 1; day <= days; day++) {
        const rowsBefore = looper.rows.length;
        const reserveBefore = looper.totals.fromReserve;
        const poolBefore = looper.totals.fromPool;
        stop = await loopPhase(ctx, looper, "best", TARGET_B, CONVERGED_PPM_B, MAX_LOOPS);
        const v = await vaultState(ctx, bOwner.address);
        const mm = await market(ctx);
        dayRows.push([
          String(day), String(looper.rows.length - rowsBefore), g(looper.totals.fromReserve - reserveBefore, 4), g(looper.totals.fromPool - poolBefore, 4),
          g(mm.reservePaxg, 4), pct(mm.spreadPpm), pct(mm.coveragePpm), g(mm.inventory), ratioText(v.ratioPpm), times((v.collateral * PPM) / equity), g(v.debt), usd(v.liqPrice), stop,
        ]);
        if (stop.startsWith("converged") || stop.startsWith("loop limit")) break;
        if (day < days) await advanceToNextUtcDay(ctx, startPrice);
      }
    } catch (error) {
      stop = `FAILED ${reason(error)}`;
      note(`B looping stopped early: ${stop}. The tables below show the vault as the failure left it.`);
    }
    table(["day", "loops", "PAXG from reserve", "PAXG from pool", "reserve PAXG left", "reserve spread", "reserve coverage", "reserve GSUSD inventory", "vault ratio", "exposure", "debt (GSUSD)", "liquidation price", "stop reason"], dayRows);
    const summary = await summarise(ctx, looper, `B: ${g(equity, 0)} PAXG towards ${pct(TARGET_B)}`, stop);
    table(SUMMARY_HEADERS, [summaryRow(summary)]);
    section("B per loop");
    loopTable(looper.rows);
    bLooped = await snapshot();

    if (scenarios.has("B")) {
      section("B walk: gold falls and liquidations", "Each level is reached from the previous one with both feeds moving together. At each level an arbitrageur first sells PAXG into the Uniswap pool until its price meets the oracle (the arbitrage carries forward from level to level). Liquidations then run from a snapshot at that level and are undone, so each level shows the untouched book. A full liquidation of an under water vault repays the gold's value less the 2% discount (GoldVault._sizeSeizure), not the nominal debt; the 'debt to repay asked' column shows what each full liquidation repays.");
      const watchB: [string, string][] = [["large looper", bOwner.address], ...watch];
      const arb = clean[5];
      const walkLevel = async (fallBps: bigint, target: bigint): Promise<void> => {
        await walkTo(ctx, target);
        const gsusdBefore = await poolGsusdPpm(ctx);
        const arbitrage = await alignPool(ctx, arb);
        const mm = await market(ctx);
        section(`B at a ${pct(fallBps * 100n, 0)} fall (feeds at ${usd(target)} USD)${fallBps > 2_000n ? ", beyond the brief" : ""}`);
        table(["pool arbitrage", "value"], [
          ["pool GSUSD before arbitrage (USD)", g(gsusdBefore, 4, 6)],
          ["PAXG sold into the pool", g(arbitrage.paxgSold, 6)],
          ["GSUSD taken out of the pool", g(arbitrage.gsusdBought)],
          ["pool GSUSD after arbitrage (USD)", g(mm.gsusdPpm, 4, 6)],
          ["pool holdings after", `${g(mm.poolPaxg, 4)} PAXG and ${g(mm.poolGsusd)} GSUSD`],
          ["note", arbitrage.note],
        ]);
        const states = await Promise.all(watchB.map(async ([name, address]) => ({ name, address, v: await vaultState(ctx, address) })));
        table(["vault", "PAXG", "debt (GSUSD)", "ratio", "liquidation price", "state"], states.map((s) => [s.name, g(s.v.collateral, 4), g(s.v.debt), ratioText(s.v.ratioPpm), usd(s.v.liqPrice), band(s.v.ratioPpm, ctx.liqRatio)]));
        table(["GSUSD a liquidator could use", "amount"], [
          ["stability pool deposits", g(mm.stabilityPool)],
          ["Uniswap pool GSUSD balance", g(mm.poolGsusd)],
          ["deployer wallet", g(await c.gsusd.balanceOf(snap.deployer))],
          ["LP wallet", g(await c.gsusd.balanceOf(lpAddress))],
          ["pool arbitrageur (bought on the way down)", g(await c.gsusd.balanceOf(arb.address))],
          ["deployer vault could still mint at the borrowing price, after the fee", g(await mintHeadroom(ctx, snap.deployer))],
          ["LP wallet vault could still mint at the borrowing price, after the fee", g(await mintHeadroom(ctx, lpAddress))],
          ["any other PAXG holder", "can mint at 130% while minting is open (the 'mints its GSUSD' row)"],
          ["reserve inventory (locked behind governance)", g(mm.inventory)],
          ["SurplusBuffer GSUSD", g(mm.bufferGsusd, 4)],
        ]);
        for (const s of states) {
          if (s.v.ratioPpm === null || s.v.ratioPpm >= ctx.liqRatio) continue;
          const rows: string[][] = [];
          const attempt = async (fallback: string[], run: () => Promise<string[]>): Promise<void> => {
            const id = await snapshot();
            try {
              rows.push(await run());
            } catch (error) {
              rows.push([fallback[0], `failed: ${reason(error)}`, ...fallback.slice(1)]);
            }
            await revertTo(id);
          };
          await attempt(["liquidateViaPool", "n/a", ...NA(11), "n/a"], () => poolLiquidation(ctx, clean[2], s.address));
          const sizes = s.v.ratioPpm < PPM ? [0n] : [...LIQUIDATION_SIZES.filter((x) => x < s.v.debt), 0n];
          for (const size of sizes) {
            await attempt(["direct, buys GSUSD in the pool", size === 0n ? "full" : g(size), ...NA(11), "n/a"], () => marketLiquidation(ctx, clean[3], s.address, size));
          }
          await attempt(["direct, own GSUSD inventory", "n/a", ...NA(11), "n/a"], () => inventoryLiquidation(ctx, deployer, s.address));
          await attempt(["direct, mints its GSUSD against own PAXG", "full", ...NA(11), "n/a"], () => mintLiquidation(ctx, clean[4], s.address, TARGET_B));
          note(`Liquidation of the ${s.name} vault (${ratioText(s.v.ratioPpm)}, debt ${g(s.v.debt)} GSUSD):`);
          table(LIQ_HEADERS, rows);
        }
      };
      for (const fallBps of WALK_LEVELS_BPS) {
        const target = (startPrice * (BPS - fallBps)) / BPS;
        try {
          await walkLevel(fallBps, target);
        } catch (error) {
          note(`B at a ${pct(fallBps * 100n, 0)} fall: FAILED ${reason(error)}; the walk stops here.`);
          break;
        }
      }
    }
    await revertTo(bLooped);
    await setFeeds(ctx, startPrice);
    bLooped = await snapshot();
  }

  // ------------------------------------------------------------ C
  if (scenarios.has("C")) {
    const poolNote = unwindArb ? "pool restored by minting arbitrage after each step" : "Sepolia pool, no arbitrage";
    const arb = unwindArb ? clean[5] : null;
    if (bLooped) {
      await revertTo(bLooped);
      await setFeeds(ctx, startPrice);
      try {
        unwindReport(`C1. Unwind of the scenario B looper through the pool (${poolNote})`, await unwind(ctx, bOwner, arb));
      } catch (error) {
        note(`C1 unwind: FAILED ${reason(error)}`);
      }
    }
    await resetToBase();
    try {
      const looper = await openLooper(ctx, clean[4], 5n * E18);
      const stop = await loopPhase(ctx, looper, "reserve", 1_400_000n, CONVERGED_PPM_A, MAX_LOOPS);
      note(`C2 set-up: 5 PAXG looped to 140% through the reserve (${looper.rows.length} loops, ${stop}); the pool is untouched, so the unwind meets it at par.`);
      unwindReport(`C2. Unwind of a 5 PAXG reserve looper (140%) through the pool (${poolNote})`, await unwind(ctx, clean[4], arb));
    } catch (error) {
      note(`C2: FAILED ${reason(error)}`);
    }
  }

  await resetToBase();
}

main().catch((error) => {
  console.error(describeErrorStack(error));
  process.exit(1);
});
