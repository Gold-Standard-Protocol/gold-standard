/**
 * Testnet only: drive docs/LAUNCH.md step 2.5 end to end against a LIVE deployment
 * (Sepolia, or a Hardhat fork of it) and assert the exact numbers the contracts promise.
 *
 * Actors: the deployer (governance, guardian, liquidator, pool depositor), the dedicated
 * liquidity wallet (the vault that gets liquidated) and two throwaway borrowers funded by
 * the deployer. Every scenario records PASS or FAIL and the run continues, so one failure
 * does not hide the rest. The run ends by restoring the feeds to the starting price,
 * unpausing everything and re-seeding the reserve.
 *
 *   # Sepolia (contracts/.env.sepolia exported; LP_PRIVATE_KEY funded with a little ETH)
 *   npx hardhat run scripts/rehearse-testnet-flow.ts --network sepolia
 *
 *   # Fork rehearsal first (npx hardhat node --fork $RPC_URL --port 8546 in another shell)
 *   LOCAL_RPC_URL=http://127.0.0.1:8546 DRIVE_DEPLOYMENT=sepolia LP_ADDRESS=0x... \
 *     npx hardhat run scripts/rehearse-testnet-flow.ts --network localhost
 *
 * After the governance handover the deployer no longer holds GOVERNANCE_ROLE. On a fork the
 * run impersonates the timelock for those steps, so every scenario still runs; on live
 * Sepolia the scenarios that need governance, or that would leave a pause only the timelock
 * can lift, are reported as SKIP and the rest run unchanged.
 *
 * REFUSES to run on mainnet.
 */
import { ethers, network } from "hardhat";
import { BufferedWallet, freshBufferedWallet } from "./lib/bufferedWallet";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describeError, describeErrorStack } from "./lib/redact";

type Signer = import("ethers").Signer & { address: string };
const freshWallet = () => freshBufferedWallet(ethers.provider);

// Baseline price: the oracle's current PAXG anchor at start (a fresh deploy seeds it from the
// live feed), falling back to $2,800. Every move below is RELATIVE to it, so the run reads
// the same at any gold price.
let PRICE_START = 2800_00000000n;
const MAX_STEP_BPS = 900n;          // a gradual walk, so the keeper sees each step; every feed moves together
const PPM = 1_000_000n;
const PRICE_DECIMALS = 100_000_000n;
const E18 = 10n ** 18n;

const results: { name: string; status: "PASS" | "FAIL" | "SKIP"; detail: string }[] = [];
const fmt = (v: bigint, d = 18) => ethers.formatUnits(v, d);
const abs = (v: bigint) => (v < 0n ? -v : v);
const mulDiv = (a: bigint, b: bigint, c: bigint) => (a * b) / c;

async function scenario(name: string, fn: () => Promise<string | void>) {
  try {
    const detail = (await fn()) ?? "";
    results.push({ name, status: "PASS", detail });
    console.log(`  PASS  ${name}${detail ? `: ${detail}` : ""}`);
  } catch (error) {
    const detail = describeError(error).slice(0, 400);
    results.push({ name, status: "FAIL", detail });
    console.log(`  FAIL  ${name}: ${detail}`);
  }
}
function skip(name: string, why: string) {
  results.push({ name, status: "SKIP", detail: why });
  console.log(`  SKIP  ${name}: ${why}`);
}
function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}
function assertClose(actual: bigint, expected: bigint, tolerance: bigint, label: string) {
  assert(abs(actual - expected) <= tolerance, `${label}: got ${actual} expected ${expected} (tolerance ${tolerance})`);
}
async function expectRevert(p: Promise<unknown>, contains?: string): Promise<string> {
  let message: string;
  try {
    const result = await p;
    // A transaction that should have reverted but was accepted is now in flight; wait for it
    // so the next transaction does not reuse its nonce on a node that has not seen it yet.
    if (result && typeof (result as { wait?: unknown }).wait === "function") {
      await (result as { wait: () => Promise<unknown> }).wait();
    }
    throw new Error("__no_revert__");
  } catch (error) {
    message = describeError(error);
    if (message === "__no_revert__") throw new Error("did not revert");
  }
  if (contains && !message.includes(contains)) {
    throw new Error(`reverted with "${message.slice(0, 200)}" instead of "${contains}"`);
  }
  return contains ?? message.slice(0, 120);
}

async function main() {
  const chainId = (await ethers.provider.getNetwork()).chainId;
  if (chainId === 1n || network.name === "mainnet") throw new Error("Refusing on mainnet.");
  const isFork = network.name === "localhost";
  const snapName = process.env.DRIVE_DEPLOYMENT ?? network.name;
  const snap = JSON.parse(readFileSync(resolve(__dirname, "../deployments", `${snapName}.json`), "utf8"));
  const a = snap.addresses;
  const cfg = snap.config;

  // ---- actors ----
  let deployer: Signer, lp: Signer, carol: Signer, dave: Signer;
  if (isFork) {
    const lpAddress = process.env.LP_ADDRESS;
    if (!lpAddress) throw new Error("Set LP_ADDRESS for a fork run");
    const fund = async (addr: string) => network.provider.send("hardhat_setBalance", [addr, "0x56BC75E2D63100000"]);
    await fund(snap.deployer);
    await fund(lpAddress);
    deployer = await ethers.getImpersonatedSigner(snap.deployer);
    lp = await ethers.getImpersonatedSigner(lpAddress);
    // Fresh wallets, not the node's shared accounts: the soak and other rehearsals leave
    // state on those, and a lifecycle check needs an empty vault to start from.
    carol = freshWallet();
    dave = freshWallet();
    await fund(carol.address);
    await fund(dave.address);
  } else {
    const signers = await ethers.getSigners();
    deployer = signers[0];
    if (!process.env.LP_PRIVATE_KEY) throw new Error("Set LP_PRIVATE_KEY");
    lp = new BufferedWallet(process.env.LP_PRIVATE_KEY, ethers.provider);
    carol = freshWallet();
    dave = freshWallet();
    for (const w of [carol, dave]) {
      await (await deployer.sendTransaction({ to: w.address, value: ethers.parseEther("0.02") })).wait();
    }
  }
  console.log(`\nRehearsal — ${network.name} (chainId ${chainId}), deployment ${snapName}`);
  console.log(`deployer ${deployer.address}\nlp       ${lp.address}\ncarol    ${carol.address}\ndave     ${dave.address}`);

  // ---- contracts ----
  const vault = await ethers.getContractAt("GoldVault", a.vault, deployer);
  const oracle = await ethers.getContractAt("GoldOracle", a.oracle, deployer);
  const gsusd = await ethers.getContractAt("GoldStablecoin", a.stablecoin, deployer);
  const pool = await ethers.getContractAt("StabilityPool", a.stabilityPool, deployer);
  const reserve = await ethers.getContractAt("GoldStabilityReserve", a.reserve, deployer);
  const buffer = await ethers.getContractAt("SurplusBuffer", a.surplusBuffer, deployer);
  const paxg = await ethers.getContractAt("MockERC20", cfg.paxgToken, deployer);
  const xaut = await ethers.getContractAt("MockERC20", cfg.xautToken, deployer);
  // Under the open launch profile XAUT is dormant: registered in the oracle on an
  // InactiveFeed and refused as collateral. Its feed cannot be stamped and its price cannot
  // be read, so the drive leaves it out and reports the XAUT lifecycle as SKIP.
  const xautActive: boolean = (
    await vault.collateralTypes(ethers.solidityPackedKeccak256(["address"], [cfg.xautToken]))
  ).active;
  const feeds = await Promise.all(
    (xautActive ? [cfg.paxgFeed, cfg.xautFeed, cfg.anchorFeed] : [cfg.paxgFeed, cfg.anchorFeed]).map((f: string) =>
      ethers.getContractAt("MockAggregatorV3", f, deployer)
    )
  );
  const [paxgFeed] = feeds;
  const tokens = xautActive ? [cfg.paxgToken, cfg.xautToken] : [cfg.paxgToken];
  if (!xautActive) console.log("collateral: XAUT is dormant on this deployment; its scenarios will be skipped");
  // ---- governance ----
  // Before the handover the deployer governs; after it the timelock does. A fork can
  // impersonate the timelock; live Sepolia cannot, and a pause it leaves behind would wait
  // 48 hours for a timelock cycle (or 14 days to lapse), so those scenarios are skipped there.
  const GOVERNANCE_ROLE: string = await vault.GOVERNANCE_ROLE();
  let governor: Signer | null = (await vault.hasRole(GOVERNANCE_ROLE, deployer.address)) ? deployer : null;
  if (!governor && isFork) {
    await network.provider.send("hardhat_setBalance", [a.timelock, "0x56BC75E2D63100000"]);
    governor = await ethers.getImpersonatedSigner(a.timelock);
    console.log(`governance: impersonating the timelock ${a.timelock} on the fork`);
  }
  const gov = governor
    ? { vault: vault.connect(governor), oracle: oracle.connect(governor), reserve: reserve.connect(governor) }
    : null;
  if (!gov) console.log("governance: held by the timelock; governance scenarios will be skipped (run the fork for those)");
  const GOV_SKIP = "needs GOVERNANCE_ROLE, which the timelock holds; the fork rehearsal covers it";
  const governed = (name: string, fn: () => Promise<string | void>) => (gov ? scenario(name, fn) : Promise.resolve(skip(name, GOV_SKIP)));
  const XAUT_SKIP = "XAUT is dormant under the open launch profile, so it cannot be deposited";
  const withXaut = (name: string, fn: () => Promise<string | void>) => (xautActive ? scenario(name, fn) : Promise.resolve(skip(name, XAUT_SKIP)));
  const PAXG = cfg.paxgToken as string;
  const XAUT = cfg.xautToken as string;

  const colId = (token: string) => ethers.solidityPackedKeccak256(["address"], [token]);
  // Baseline: the oracle's current PAXG anchor (a fresh deploy seeds it from the live feed).
  // Read BEFORE any size derived from it below, so the whole run scales with the gold price.
  {
    const anchored: bigint = await oracle.getLastKnownPrice(PAXG);
    if (anchored > 0n) PRICE_START = anchored;
    console.log(`baseline price ${fmt(PRICE_START, 8)} (oracle anchor)`);
  }
  const penaltyPpm: bigint = (await vault.collateralTypes(colId(PAXG))).liquidationPenalty;
  const liqRatio: bigint = (await vault.collateralTypes(colId(PAXG))).liquidationRatio;
  const incentive: bigint = await vault.liquidatorIncentiveShare();
  const reserveShareBps: bigint = await vault.reservePenaltyShareBps();
  const MIN_DEBT: bigint = await vault.minDebt();
  const discountPpm: bigint = await vault.underwaterDiscountPpm();
  const originationBps: bigint = await vault.originationFeeBps();
  const thresholdBefore: bigint = await vault.badDebtPauseThreshold();

  // ---- feed helpers ----
  const stamp = async () => {
    if (!isFork) return BigInt(Math.floor(Date.now() / 1000) - 30);
    await network.provider.send("evm_mine", []);
    return BigInt((await ethers.provider.getBlock("latest"))!.timestamp);
  };
  async function setFeeds(price: bigint, which = feeds) {
    const now = await stamp();
    for (const feed of which) {
      const round = ((await feed.latestRoundData())[0] as bigint) + 1n;
      await (await feed.setLatestRoundData(round, price, now, now, round)).wait();
    }
  }
  async function poke() {
    for (const token of tokens) await (await oracle.getTokenPrice(token)).wait();
  }
  let price = PRICE_START;
  const pct = (bps: bigint) => (PRICE_START * bps) / 10_000n; // basis points of the baseline
  // Debt that puts a position at ~186.67% (the $2,800 baseline shape), in whole GSUSD.
  const debtAt18667 = (collateralValue18: bigint) => ((collateralValue18 * 5357n) / 10_000n / E18) * E18;
  const paxgLifecycleDebt = debtAt18667(2n * PRICE_START * 10n ** 10n); // 2 PAXG
  const xautLifecycleDebt = debtAt18667(PRICE_START * 10n ** 10n);      // 1 XAUT
  async function walkTo(target: bigint) {
    while (price !== target) {
      const maxMove = (price * MAX_STEP_BPS) / 10_000n;
      const diff = target > price ? target - price : price - target;
      const step = diff < maxMove ? diff : maxMove;
      price = target > price ? price + step : price - step;
      await setFeeds(price);
      await poke();
      console.log(`    feeds @ $${fmt(price, 8)}`);
    }
  }
  const vaultOf = async (who: string) => {
    const v = await vault.vaults(who);
    return { token: v[0] as string, collateral: v[1] as bigint, debt: v[2] as bigint };
  };
  const ratioOf = async (who: string) => Number(await vault.getCollateralisationRatio(who)) / 10_000;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  // ---- 0. starting state ----
  price = PRICE_START;
  await setFeeds(PRICE_START);
  await poke();
  // The reserve scenarios assume gold to swap for; a fresh or drained deployment gets the
  // seed shape (20 PAXG) from the deployer, exactly as seed-testnet-reserve.ts would.
  if ((await reserve.collateralBalance(PAXG)) < ethers.parseEther("5")) {
    await (await paxg.mint(deployer.address, ethers.parseEther("20"))).wait();
    await (await paxg.approve(a.reserve, ethers.parseEther("20"))).wait();
    await (await reserve.seedCollateral(PAXG, ethers.parseEther("20"))).wait();
    console.log("reserve seeded with 20 PAXG for the run");
  }
  // Every run leaves some GSUSD in circulation (reserve swaps, the pool deposit), so repeated
  // rehearsals walk the PAXG debt towards its ceiling. Fail here, with the remedy, rather than
  // midway through the liquidation section with "Debt ceiling reached".
  {
    const ct = await vault.collateralTypes(colId(PAXG));
    const headroom: bigint = ct.debtCeiling - ct.totalDebt;
    const runNeeds = ((PRICE_START * 12n) / PRICE_DECIMALS) * E18; // about 12 PAXG worth of new debt per run
    console.log(`PAXG debt ${fmt(ct.totalDebt)} of ${fmt(ct.debtCeiling)} ceiling (${fmt(headroom)} headroom; a run needs about ${fmt(runNeeds)})`);
    if (headroom < runNeeds) {
      throw new Error(`PAXG debt ceiling headroom ${fmt(headroom)} GSUSD is below a run's needs; raise it with scripts/ramp-testnet-ceiling.ts or repay circulating debt before rehearsing`);
    }
  }
  // The run spends about 36k GSUSD from the deployer (swaps, the partial liquidation, the pool
  // deposit, the emergency liquidation). Top up from the deployer's own vault so reruns after a
  // previous rehearsal do not fail on balance.
  {
    const budget = ((PRICE_START * 15n) / PRICE_DECIMALS) * E18; // 15 PAXG worth of GSUSD (42k at $2,800)
    const held = await gsusd.balanceOf(deployer.address);
    if (held < budget) {
      const shortfall = budget - held;
      const dv = await vaultOf(deployer.address);
      const minRatio: bigint = (await vault.collateralTypes(colId(PAXG))).minRatio;
      const currentDebt: bigint = dv.debt === 0n ? 0n : await vault.getVaultCurrentDebt(deployer.address);
      const value18 = mulDiv(dv.collateral, PRICE_START, PRICE_DECIMALS);
      const headroom = (value18 * PPM) / minRatio - currentDebt;
      if (dv.collateral === 0n || headroom < shortfall) {
        // No deployer vault yet, or repeated runs have used its headroom: add mock gold so the
        // top-up stays above the minimum ratio (mocks mint on demand; never the case on mainnet).
        const needed18 = ((shortfall - (headroom > 0n ? headroom : 0n)) * minRatio) / PPM;
        const extra = mulDiv(needed18, PRICE_DECIMALS, PRICE_START) * 11n / 10n + E18;
        await (await paxg.mint(deployer.address, extra)).wait();
        await (await paxg.approve(a.vault, extra)).wait();
        await (await vault.deposit(PAXG, extra)).wait();
        console.log(`deployer added ${fmt(extra)} PAXG of collateral to fund the run`);
      }
      // The vault caps minting per block (50k GSUSD); a fresh deployer needs more than that, so
      // mint in chunks, one block each.
      const perBlockCap: bigint = await vault.perBlockMintCap();
      const chunk = perBlockCap === 0n ? shortfall : perBlockCap - perBlockCap / 5n;
      for (let remaining = shortfall; remaining > 0n; remaining -= remaining < chunk ? remaining : chunk) {
        await (await vault.mint(remaining < chunk ? remaining : chunk)).wait();
      }
      console.log(`deployer minted ${fmt(budget - held)} GSUSD from its vault to fund the run`);
    }
  }
  console.log(`\nStart: reserve ${fmt(await reserve.collateralBalance(PAXG))} PAXG, pool ${fmt(await pool.getTotalDeposits())} GSUSD, supply ${fmt(await gsusd.totalSupply())} GSUSD`);
  console.log(`deployer vault ${(await ratioOf(deployer.address)).toFixed(2)}%, lp vault ${(await ratioOf(lp.address)).toFixed(2)}%`);

  // A run that stopped midway can leave a throwaway borrower with collateral and no debt (a
  // withdraw that never landed). Empty such vaults first so the lifecycle starts from zero.
  const emptyLeftoverVault = async (who: typeof dave, label: string) => {
    const v = await vaultOf(who.address);
    if (v.collateral === 0n) return;
    if (v.debt !== 0n) throw new Error(`${label} still owes ${fmt(v.debt)} GSUSD from a previous run; repay it before rehearsing`);
    await (await vault.connect(who).withdraw(v.collateral)).wait();
    console.log(`${label}: withdrew ${v.collateral} leftover collateral units from a previous run`);
  };
  await emptyLeftoverVault(dave, "dave");
  await emptyLeftoverVault(carol, "carol");

  // ---- 1. PAXG lifecycle (dave) ----
  console.log("\n[1] PAXG vault lifecycle");
  let davePaxgAtStart = 0n;
  let carolXautAtStart = 0n;
  await scenario("paxg:deposit-mint", async () => {
    const heldPaxg: bigint = await paxg.balanceOf(dave.address);
    if (heldPaxg < ethers.parseEther("2")) await (await paxg.mint(dave.address, ethers.parseEther("2") - heldPaxg)).wait();
    davePaxgAtStart = await paxg.balanceOf(dave.address);
    await (await paxg.connect(dave).approve(a.vault, ethers.parseEther("2"))).wait();
    await (await vault.connect(dave).deposit(PAXG, ethers.parseEther("2"))).wait();
    const before = await gsusd.balanceOf(dave.address);
    await (await vault.connect(dave).mint(paxgLifecycleDebt)).wait();
    const got = (await gsusd.balanceOf(dave.address)) - before;
    const fee = originationBps === 0n ? 0n : (paxgLifecycleDebt * originationBps) / 10_000n;
    assert(got === paxgLifecycleDebt - fee, `minted ${fmt(got)} GSUSD, expected ${fmt(paxgLifecycleDebt - fee)}`);
    const r = await ratioOf(dave.address);
    assert(r > 186 && r < 188, `ratio ${r}% expected ~186.67%`);
    return `2 PAXG / ${fmt(paxgLifecycleDebt)} GSUSD at ${r.toFixed(2)}%`;
  });
  await scenario("paxg:over-mint-blocked", () => expectRevert(vault.connect(dave).mint((paxgLifecycleDebt * 2n) / 3n), "Below min collateralisation ratio"));
  await scenario("paxg:withdraw-below-ratio-blocked", () => expectRevert(vault.connect(dave).withdraw(ethers.parseEther("1")), "Below min ratio"));
  await scenario("paxg:dust-repay-blocked", () => expectRevert(vault.connect(dave).repay(paxgLifecycleDebt - ethers.parseEther("50")), "Remaining debt below minimum"));
  await scenario("paxg:repay-withdraw-close", async () => {
    // The mint delivered the debt less the origination fee, so the top-up covers that fee
    // as well as the interest accrued since.
    const fee = (paxgLifecycleDebt * originationBps) / 10_000n;
    await (await gsusd.transfer(dave.address, ethers.parseEther("2") + fee)).wait();
    const debt: bigint = await vault.getVaultCurrentDebt(dave.address);
    const overshoot = debt + ethers.parseEther("1");
    await (await gsusd.connect(dave).approve(a.vault, overshoot)).wait();
    const balBefore = await gsusd.balanceOf(dave.address);
    await (await vault.connect(dave).repay(overshoot)).wait();
    const paid = balBefore - (await gsusd.balanceOf(dave.address));
    assert(paid >= debt && paid < overshoot, `paid ${fmt(paid)} for a debt of ${fmt(debt)} (overshoot must be capped)`);
    const v = await vaultOf(dave.address);
    assert(v.debt === 0n, `debt left ${fmt(v.debt)}`);
    await (await vault.connect(dave).withdraw(ethers.parseEther("2"))).wait();
    const after = await vaultOf(dave.address);
    assert(after.collateral === 0n && after.debt === 0n, "vault not empty");
    assert((await paxg.balanceOf(dave.address)) === davePaxgAtStart, "PAXG not returned in full");
    return `paid ${fmt(paid)} GSUSD (fee ${fmt(paid - paxgLifecycleDebt)}), vault empty`;
  });

  // ---- 2. XAUT lifecycle (carol, 6 decimals) ----
  console.log("\n[2] XAUT vault lifecycle (6 decimals)");
  await withXaut("xaut:deposit-mint", async () => {
    const one = 1_000_000n; // 1 XAUT
    const heldXaut: bigint = await xaut.balanceOf(carol.address);
    if (heldXaut < one) await (await xaut.mint(carol.address, one - heldXaut)).wait();
    carolXautAtStart = await xaut.balanceOf(carol.address);
    await (await xaut.connect(carol).approve(a.vault, one)).wait();
    await (await vault.connect(carol).deposit(XAUT, one)).wait();
    await (await vault.connect(carol).mint(xautLifecycleDebt)).wait();
    const v = await vaultOf(carol.address);
    assert(v.collateral === one, `collateral recorded ${v.collateral}, expected ${one}`);
    const r = await ratioOf(carol.address);
    assert(r > 186 && r < 188, `ratio ${r}% expected ~186.67% (decimals handling)`);
    const liqPrice: bigint = await vault.getLiquidationPrice(carol.address);
    return `1 XAUT / ${fmt(xautLifecycleDebt)} GSUSD at ${r.toFixed(2)}%, liquidation price ${fmt(liqPrice, 8)}`;
  });
  await withXaut("xaut:over-mint-blocked", () => expectRevert(vault.connect(carol).mint((xautLifecycleDebt * 2n) / 3n), "Below min collateralisation ratio"));
  await withXaut("xaut:repay-withdraw-close", async () => {
    await (await gsusd.transfer(carol.address, ethers.parseEther("2"))).wait();
    const debt: bigint = await vault.getVaultCurrentDebt(carol.address);
    await (await gsusd.connect(carol).approve(a.vault, debt + E18)).wait();
    await (await vault.connect(carol).repay(debt + E18)).wait();
    await (await vault.connect(carol).withdraw(1_000_000n)).wait();
    const after = await vaultOf(carol.address);
    assert(after.collateral === 0n && after.debt === 0n, "vault not empty");
    assert((await xaut.balanceOf(carol.address)) === carolXautAtStart, "XAUT not returned in full");
    return "1 XAUT returned in full";
  });

  // ---- 3. Reserve swap ----
  console.log("\n[3] Stability reserve swap");
  await scenario("reserve:swap-exact-accounting", async () => {
    const gsusdIn = ethers.parseEther("1000");
    const [quote, spread] = await reserve.quoteGoldOut(PAXG, gsusdIn);
    const fee = mulDiv(gsusdIn, spread, PPM);
    const net = gsusdIn - fee;
    const expectedGold = mulDiv(net, E18, price * 10n ** 10n);
    assert(quote === expectedGold, `quote ${quote} vs formula ${expectedGold}`);
    const dv = await vaultOf(deployer.address);
    const lv = await vaultOf(lp.address);
    const resBefore = await reserve.collateralBalance(PAXG);
    const bufBefore: bigint = await buffer.gsusdBalance();
    const invBefore: bigint = await reserve.gsusdInventory();
    const goldBefore = await paxg.balanceOf(deployer.address);
    await (await gsusd.approve(a.reserve, gsusdIn)).wait();
    await (await reserve.swapGsusdForGold(PAXG, gsusdIn, (quote * 99n) / 100n)).wait();
    const goldOut = (await paxg.balanceOf(deployer.address)) - goldBefore;
    assert(goldOut === quote, `received ${goldOut} vs quote ${quote}`);
    assert(resBefore - (await reserve.collateralBalance(PAXG)) === goldOut, "reserve balance did not fall by goldOut");
    assert((await buffer.gsusdBalance()) - bufBefore === fee, `buffer grew by ${fmt((await buffer.gsusdBalance()) - bufBefore)} not the spread ${fmt(fee)}`);
    assert((await reserve.gsusdInventory()) - invBefore === net, "inventory did not grow by net");
    const dv2 = await vaultOf(deployer.address);
    const lv2 = await vaultOf(lp.address);
    assert(dv.collateral === dv2.collateral && dv.debt === dv2.debt && lv.collateral === lv2.collateral && lv.debt === lv2.debt, "a vault changed during the swap");
    return `1000 GSUSD -> ${fmt(goldOut)} PAXG at spread ${Number(spread) / 10_000}%, buffer +${fmt(fee)} GSUSD, vaults untouched`;
  });
  await scenario("reserve:daily-cap", async () => {
    const remaining: bigint = await reserve.remainingDailyCapacity(PAXG);
    const tooMuch = mulDiv(remaining + ethers.parseEther("0.5"), price * 10n ** 10n, E18) + ethers.parseEther("50");
    await (await gsusd.approve(a.reserve, tooMuch)).wait();
    const reason = await expectRevert(reserve.swapGsusdForGold(PAXG, tooMuch, 0), "Daily cap reached");
    return `${fmt(remaining)} PAXG left today; ${fmt(tooMuch)} GSUSD -> ${reason}`;
  });
  await governed("reserve:empty-refuses-then-reseed", async () => {
    const bal: bigint = await reserve.collateralBalance(PAXG);
    await (await gov!.reserve.withdrawCollateral(PAXG, deployer.address, bal)).wait();
    await (await gsusd.approve(a.reserve, ethers.parseEther("100"))).wait();
    const reason = await expectRevert(reserve.swapGsusdForGold(PAXG, ethers.parseEther("100"), 0), "Reserve insufficient");
    await (await paxg.approve(a.reserve, bal)).wait();
    await (await reserve.seedCollateral(PAXG, bal)).wait();
    assert((await reserve.collateralBalance(PAXG)) === bal, "re-seed did not restore the balance");
    return `${reason}; re-seeded ${fmt(bal)} PAXG`;
  });

  // ---- 6. Liquidations (LP vault) ----
  console.log("\n[4] Liquidation: keeper detection, direct partial, pool full");
  let lpDebtTarget = 0n;
  await scenario("liq:push-lp-vault-to-131pct", async () => {
    let v = await vaultOf(lp.address);
    if (v.debt === 0n) {
      // A previous run liquidated the LP vault away; reopen the seed shape (7.5 PAXG / 14k GSUSD).
      await (await paxg.mint(lp.address, ethers.parseEther("7.5"))).wait();
      await (await paxg.connect(lp).approve(a.vault, ethers.parseEther("7.5"))).wait();
      await (await vault.connect(lp).deposit(PAXG, ethers.parseEther("7.5"))).wait();
      await (await vault.connect(lp).mint(ethers.parseEther("14000"))).wait();
      v = await vaultOf(lp.address);
    }
    const value = mulDiv(v.collateral, price, PRICE_DECIMALS);
    lpDebtTarget = (value * PPM) / 1_310_000n;
    const extra = lpDebtTarget - (await vault.getVaultCurrentDebt(lp.address));
    assert(extra > 0n, "LP vault already below 131%");
    await (await vault.connect(lp).mint(extra)).wait();
    return `minted ${fmt(extra)} GSUSD, ratio ${(await ratioOf(lp.address)).toFixed(2)}%`;
  });
  await scenario("liq:price-walk-makes-lp-liquidatable", async () => {
    await walkTo(pct(8281n));
    const r = await ratioOf(lp.address);
    assert(r < Number(liqRatio) / 10_000, `ratio ${r}% still above ${Number(liqRatio) / 10_000}%`);
    if (!isFork) {
      console.log("    holding 80s so the keeper's next pass can log vault.liquidatable");
      await sleep(80_000);
    }
    return `lp ${r.toFixed(2)}%, deployer ${(await ratioOf(deployer.address)).toFixed(2)}%`;
  });
  await scenario("liq:direct-partial-exact-seizure", async () => {
    const before = await vaultOf(lp.address);
    const currentDebt: bigint = await vault.getVaultCurrentDebt(lp.address);
    const repay = ((currentDebt / 2n) / E18) * E18; // half the debt, whole GSUSD
    const seize = mulDiv(repay * (PPM + penaltyPpm), PRICE_DECIMALS, price * PPM);
    const debtEq = mulDiv(repay, PRICE_DECIMALS, price);
    const bonus = mulDiv(seize - debtEq, incentive, PPM);
    const liquidatorPayout = debtEq + bonus;
    const protocolPayout = seize - liquidatorPayout;
    const toReserve = mulDiv(protocolPayout, reserveShareBps, 10_000n);
    const toBuffer = protocolPayout - toReserve;
    const goldBefore = await paxg.balanceOf(deployer.address);
    const gsusdBefore = await gsusd.balanceOf(deployer.address);
    const resBefore = await reserve.collateralBalance(PAXG);
    const bufGoldBefore = await paxg.balanceOf(a.surplusBuffer);
    await (await gsusd.approve(a.vault, repay)).wait();
    await (await vault.liquidate(lp.address, repay)).wait();
    const after = await vaultOf(lp.address);
    assert(before.collateral - after.collateral === seize, `seized ${before.collateral - after.collateral} expected ${seize}`);
    assert((await paxg.balanceOf(deployer.address)) - goldBefore === liquidatorPayout, "liquidator payout mismatch");
    assert(gsusdBefore - (await gsusd.balanceOf(deployer.address)) === repay, "liquidator paid a different GSUSD amount");
    assert((await reserve.collateralBalance(PAXG)) - resBefore === toReserve, "reserve penalty share mismatch");
    assert((await paxg.balanceOf(a.surplusBuffer)) - bufGoldBefore === toBuffer, "buffer penalty share mismatch");
    const principalExpected = mulDiv(before.debt, repay, currentDebt);
    // Fees accrue every second, so on a live network the on-chain currentDebt at inclusion differs
    // from the pre-read by the blocks in between; 0.01 GSUSD covers a few minutes of drift.
    assertClose(before.debt - after.debt, principalExpected, 10n ** 16n, "principal repaid");
    assert(after.debt >= MIN_DEBT, "residual below MIN_DEBT was allowed");
    return `seized ${fmt(seize)} PAXG for ${fmt(repay)} GSUSD (liquidator ${fmt(liquidatorPayout)}, reserve ${fmt(toReserve)}, buffer ${fmt(toBuffer)}); lp now ${(await ratioOf(lp.address)).toFixed(2)}%`;
  });
  await scenario("liq:healthy-after-partial-refuses", () => expectRevert(vault.liquidate(lp.address, ethers.parseEther("100")), "Not undercollateralised"));
  await scenario("liq:pool-full-liquidation", async () => {
    await walkTo(pct(7536n));
    const r = await ratioOf(lp.address);
    assert(r < Number(liqRatio) / 10_000, `ratio ${r}% not liquidatable at ${fmt(price, 8)}`);
    const deposit = ethers.parseEther("20000");
    await (await gsusd.approve(a.stabilityPool, deposit)).wait();
    await (await pool.deposit(deposit)).wait();
    const before = await vaultOf(lp.address);
    const currentDebt: bigint = await vault.getVaultCurrentDebt(lp.address);
    // Thin collateral: the seizure is capped at the vault and the penalty gives way.
    let seize = mulDiv(currentDebt * (PPM + penaltyPpm), PRICE_DECIMALS, price * PPM);
    let repay = currentDebt;
    if (seize > before.collateral) {
      seize = before.collateral;
      const coverable = mulDiv(before.collateral, price, PRICE_DECIMALS);
      // Underwater gold sells at the governed discount; the shortfall is bad debt.
      if (coverable < currentDebt) repay = mulDiv(coverable, PPM - discountPpm, PPM);
    }
    const debtEq = mulDiv(repay, PRICE_DECIMALS, price);
    const bounty = mulDiv(seize - debtEq, incentive / 2n, PPM);
    const goldBefore = await paxg.balanceOf(deployer.address);
    const poolBefore: bigint = await pool.getTotalDeposits();
    const badBeforePool: bigint = await vault.totalBadDebt();
    // Gains carried from earlier pool liquidations (a keeper exercise, an aborted run) stay
    // pending across deposits, so the depositor's gain from THIS liquidation is a delta.
    const gainBefore: bigint = await pool.getCollateralGain(deployer.address, PAXG);
    await (await vault.liquidateViaPool(lp.address, 0)).wait();
    const after = await vaultOf(lp.address);
    assert(after.debt === 0n && after.collateral === 0n, `lp vault left with ${fmt(after.collateral)} PAXG / ${fmt(after.debt)} GSUSD`);
    assertClose((await paxg.balanceOf(deployer.address)) - goldBefore, bounty, 10n ** 12n, "keeper bounty");
    assertClose(poolBefore - (await pool.getTotalDeposits()), repay, 10n ** 16n, "pool GSUSD absorbed");
    const gain: bigint = await pool.getCollateralGain(deployer.address, PAXG);
    assertClose(gain - gainBefore, seize - bounty, 10n ** 12n, "depositor collateral gain");
    const claimReceipt = await (await pool.claimCollateral(PAXG)).wait();
    // Public gateways balance across nodes that can lag a block; pin both reads to the claim's block.
    const atClaim = { blockTag: claimReceipt!.blockNumber };
    const beforeClaim = { blockTag: claimReceipt!.blockNumber - 1 };
    const claimed = (await paxg.balanceOf(deployer.address, atClaim)) - (await paxg.balanceOf(deployer.address, beforeClaim));
    assert(claimed === gain, `claimed ${claimed} differs from the view ${gain} by ${claimed - gain} wei`);
    assert((await vault.totalBadDebt()) === badBeforePool, "bad debt recorded on a covered liquidation");
    return `pool absorbed ${fmt(repay)} GSUSD for ${fmt(seize)} PAXG (bounty ${fmt(bounty)}, depositor gain ${fmt(gain)}); seizure ${seize === before.collateral ? "capped at the vault (penalty gave way)" : "full penalty"}`;
  });
  await scenario("liq:price-restored", async () => {
    await walkTo(PRICE_START);
    return `feeds back at $${fmt(price, 8)}`;
  });

  // ---- 7. Circuit breaker + emergency liquidation (dave) ----
  console.log("\n[5] Gold band, guardian freeze, emergency liquidation, bad debt");
  await governed("emergency:open-dave-vault", async () => {
    await (await paxg.connect(dave).approve(a.vault, ethers.parseEther("2"))).wait();
    await (await vault.connect(dave).deposit(PAXG, ethers.parseEther("2"))).wait();
    const crashCoverable = 2n * pct(7143n) * 10n ** 10n; // 2 PAXG valued at the crash price, 18 dec
    const daveDebt = ((crashCoverable / E18) * E18) + ethers.parseEther("10");
    await (await vault.connect(dave).mint(daveDebt)).wait();
    return `2 PAXG / ${fmt(daveDebt)} GSUSD at ${(await ratioOf(dave.address)).toFixed(2)}%`;
  });
  await governed("breaker:single-feed-glitch-cannot-seize", async () => {
    // +15% on Chainlink PAXG/USD alone, XAU/USD unchanged: outside the gold band. Borrowing and
    // reserve swaps stop and liquidation is capped 2% above gold.
    await setFeeds(pct(11500n), [paxgFeed]);
    const clamped: bigint = await oracle.getTokenPrice.staticCall(PAXG);
    const clampPpm: bigint = await oracle.liquidationClampPpm(PAXG);
    const edge = (PRICE_START * (1_000_000n + clampPpm)) / 1_000_000n;
    assert(clamped === edge, `getTokenPrice read ${fmt(clamped, 8)}, not the cap ${fmt(edge, 8)}`);
    const borrow = await expectRevert(oracle.getBorrowPrice.staticCall(PAXG), "Off gold band");
    // The guardian's manual stop: freezeToken is guardian or governance only, lasts
    // FREEZE_DURATION (14 days) and lapses by itself; calling it again extends it. XAUT keeps
    // pricing and nothing is paused.
    const freezeFor: bigint = await oracle.FREEZE_DURATION();
    const frozenAt = async (receipt: Awaited<ReturnType<Awaited<ReturnType<typeof oracle.freezeToken>>["wait"]>>) => {
      const event = receipt!.logs
        .map((l) => { try { return oracle.interface.parseLog({ topics: [...l.topics], data: l.data }); } catch { return null; } })
        .find((parsed) => parsed && parsed.name === "TokenFrozen");
      assert(event !== undefined && event !== null, "no TokenFrozen event");
      const block = await ethers.provider.getBlock(receipt!.blockNumber);
      const until: bigint = event!.args[2];
      assert(until === BigInt(block!.timestamp) + freezeFor, `TokenFrozen until ${until}, expected the block time plus ${freezeFor}`);
      assert((await oracle.frozenUntil(PAXG)) === until, "frozenUntil differs from the event");
      return until;
    };
    const firstUntil = await frozenAt(await (await gov!.oracle.freezeToken(PAXG)).wait());
    assert(await oracle.tokenFrozen(PAXG), "PAXG not frozen after freezeToken");
    assert(!(await oracle.paused()), "freezing PAXG paused the whole oracle");
    await stamp(); // a later block, so the extension is measurable on a fork
    const extendedUntil = await frozenAt(await (await gov!.oracle.freezeToken(PAXG)).wait());
    assert(extendedUntil > firstUntil, `a second freezeToken did not extend the freeze (${firstUntil} then ${extendedUntil})`);
    // A frozen token has no emergency path outside a pause: emergency seizures need the vault
    // or the oracle paused, so a freeze alone stops every liquidation of the token.
    const emerg = await expectRevert(vault.emergencyLiquidate(dave.address, 0), "Token frozen");
    const normal = await expectRevert(vault.liquidate(dave.address, 0), "Token frozen");
    // Unfreezing needs a normal read, which the clamped price is; PAXG returns inside the band.
    await setFeeds(PRICE_START, [paxgFeed]);
    // An unfreeze names the freeze it lifts (freezeEpoch); read it now, just before the call.
    await (await gov!.oracle.guardianUnfreezeToken(PAXG, await oracle.freezeEpoch(PAXG))).wait();
    await poke();
    return `getTokenPrice: capped at ${fmt(clamped, 8)}; getBorrowPrice: ${borrow}; frozen for ${freezeFor / 86_400n} days and extended by a second call; emergencyLiquidate: ${emerg}; liquidate: ${normal.slice(0, 60)}`;
  });
  await governed("breaker:gold-wide-crash-then-emergency-liquidate", async () => {
    const CRASH = pct(7143n);
    // -28.6% in one move on every feed: a gold-wide crash. XAU/USD corroborates it, so the
    // oracle prices it at once (plan section 3, row 1); there is no deviation gate to wedge on.
    await setFeeds(CRASH);
    const crashed: bigint = await oracle.getTokenPrice.staticCall(PAXG);
    assert(crashed === CRASH, `a gold-wide crash read ${fmt(crashed, 8)}, not ${fmt(CRASH, 8)}`);
    await poke();
    assert((await oracle.getLastKnownPrice(PAXG)) === CRASH, "the permissionless poke did not re-anchor lastKnown");
    // The guardian may still pause the whole oracle in a market-wide emergency; emergency
    // seizures then price at the rule's price when it gives one, here the crash price.
    await (await gov!.oracle.emergencyPause()).wait();
    assert(await oracle.paused(), "oracle not paused");
    await (await gov!.vault.setBadDebtPauseThreshold(E18)).wait();
    const before = await vaultOf(dave.address);
    const currentDebt: bigint = await vault.getVaultCurrentDebt(dave.address);
    const coverable = mulDiv(before.collateral, CRASH, PRICE_DECIMALS);
    assert(coverable < currentDebt, `dave is not actually underwater at ${fmt(CRASH, 8)}`);
    // The discount never exceeds the shortfall, so a vault barely under water repays
    // twice its gold's value less its debt when that is more than the discounted value.
    const discounted = mulDiv(coverable, PPM - discountPpm, PPM);
    const floorAtShortfall = 2n * coverable > currentDebt ? 2n * coverable - currentDebt : 0n;
    const expectedRepay = floorAtShortfall > discounted ? floorAtShortfall : discounted;
    const bufBefore: bigint = await buffer.gsusdBalance();
    const badBefore: bigint = await vault.totalBadDebt();
    const goldBefore = await paxg.balanceOf(deployer.address);
    const gsusdBefore = await gsusd.balanceOf(deployer.address);
    await (await gsusd.approve(a.vault, currentDebt)).wait();
    const receipt = await (await vault.emergencyLiquidate(dave.address, 0)).wait();
    const after = await vaultOf(dave.address);
    assert(after.collateral === 0n && after.debt === 0n, "dave vault not cleared");
    // Underwater gold sells at the discount and the discount is split like a penalty: the
    // liquidator takes the debt's worth plus its incentive share of the rest, the protocol the
    // remainder, so the liquidator no longer walks away with every unit.
    const debtEqGold = mulDiv(expectedRepay, PRICE_DECIMALS, CRASH);
    const expectedGold = debtEqGold + mulDiv(before.collateral - debtEqGold, incentive, PPM);
    assertClose((await paxg.balanceOf(deployer.address)) - goldBefore, expectedGold, 10n ** 12n, "liquidator gold: the debt's worth plus its share of the discount");
    assertClose(gsusdBefore - (await gsusd.balanceOf(deployer.address)), expectedRepay, 10n ** 16n, "liquidator paid other than the discounted collateral value");
    // The chain is the source of truth for the shortfall: the BadDebt event carries the
    // principal left after the pro-rata split at the on-chain currentDebt (fees accrue every
    // second, so the pre-read only bounds it). The accrued fee inside the 4000 GSUSD payment
    // is banked in the buffer in the SAME transaction and absorbed straight back, so it is
    // part of what the buffer absorbed.
    const badEvent = receipt!.logs
      .map((l) => { try { return vault.interface.parseLog({ topics: [...l.topics], data: l.data }); } catch { return null; } })
      .find((p) => p && p.name === "BadDebt");
    assert(badEvent !== undefined && badEvent !== null, "no BadDebt event emitted");
    const shortfall: bigint = badEvent!.args[1];
    const paid = gsusdBefore - (await gsusd.balanceOf(deployer.address));
    const principalRepaid = before.debt - shortfall;
    const feeBanked = paid - principalRepaid;
    const absorbed = bufBefore + feeBanked - (await buffer.gsusdBalance());
    const bad: bigint = (await vault.totalBadDebt()) - badBefore;
    assert(bad + absorbed === shortfall, `bad ${bad} + absorbed ${absorbed} != shortfall ${shortfall}`);
    assertClose(shortfall, before.debt - mulDiv(before.debt, expectedRepay, currentDebt), 10n ** 16n, "shortfall vs pre-read model");
    // The auto-pause fires on the vault's CUMULATIVE bad debt above the threshold (1 GSUSD
    // here), so bad debt carried over from an earlier run counts as much as this
    // liquidation's residual.
    const totalBadAfter: bigint = await vault.totalBadDebt();
    const aboveThreshold = totalBadAfter > E18;
    assert((await vault.paused()) === aboveThreshold, aboveThreshold
      ? `total bad debt ${fmt(totalBadAfter)} (this run ${fmt(bad)}) above the 1 GSUSD threshold but the vault did not auto-pause`
      : `total bad debt ${fmt(totalBadAfter)} within the threshold yet the vault paused`);
    return `shortfall ${fmt(shortfall)} GSUSD: buffer absorbed ${fmt(absorbed)}, ${fmt(bad)} recorded, ${aboveThreshold ? `total ${fmt(totalBadAfter)} above the threshold so the vault auto-paused` : "within the threshold so no auto-pause"}`;
  });
  await governed("breaker:recovery-unpause-and-walk-back", async () => {
    // An unpause names the pause it lifts (pauseEpoch); read it now, just before the call.
    if (await vault.paused()) await (await gov!.vault.unpause(await vault.pauseEpoch())).wait();
    await (await gov!.vault.setBadDebtPauseThreshold(thresholdBefore)).wait();
    if (await oracle.paused()) await (await gov!.oracle.unpause(await oracle.pauseEpoch())).wait();
    for (const t of tokens) {
      if (await oracle.tokenFrozen(t)) await (await gov!.oracle.guardianUnfreezeToken(t, await oracle.freezeEpoch(t))).wait();
    }
    // If the crash scenario stopped midway, a token's anchor may sit far from its feed; a
    // governance resync (bounded to the live feed) brings it back before any poke.
    const live = (await paxgFeed.latestRoundData())[1] as bigint;
    for (const t of tokens) {
      const known: bigint = await oracle.getLastKnownPrice(t);
      const gap = known > live ? known - live : live - known;
      if (gap * 10_000n / live > 900n) await (await gov!.oracle.resyncLastKnownPrice(t)).wait();
    }
    price = live;
    await poke();
    await walkTo(PRICE_START);
    return `vault and oracle unpaused, feeds walked back to ${fmt(price, 8)}`;
  });
  await governed("baddebt:retry-absorption-after-buffer-refills", async () => {
    const bad: bigint = await vault.totalBadDebt();
    if (bad === 0n) return "nothing to retry";
    // A swap's spread refills the buffer; 2000 GSUSD at the floor spread yields 10 GSUSD. Bad
    // debt left by earlier interrupted runs can exceed one swap's fee, so refill and retry until
    // it is gone, within a small bound.
    let left: bigint = bad;
    for (let round = 0; round < 5 && left > 0n; round++) {
      const gsusdIn = ethers.parseEther("2000");
      const [quote] = await reserve.quoteGoldOut(PAXG, gsusdIn);
      await (await gsusd.approve(a.reserve, gsusdIn)).wait();
      await (await reserve.swapGsusdForGold(PAXG, gsusdIn, (quote * 99n) / 100n)).wait();
      await (await vault.retryBadDebtAbsorption()).wait();
      left = await vault.totalBadDebt();
    }
    if (left > 0n) {
      // The underwater discount books a hole the spread of five capped swaps cannot fill on a
      // fresh fork; refill the buffer with protocol revenue the way a quiet week would, under
      // the role the buffer gives the vault, then retry once more.
      const role = await buffer.VAULT_ROLE();
      await (await buffer.connect(governor).grantRole(role, deployer.address)).wait();
      await (await gsusd.approve(a.surplusBuffer, left)).wait();
      await (await buffer.depositFee(left)).wait();
      await (await vault.retryBadDebtAbsorption()).wait();
      left = await vault.totalBadDebt();
    }
    assert(left === 0n, `${fmt(left)} GSUSD of bad debt still recorded`);
    return `${fmt(bad)} GSUSD cleared from the refilled buffer`;
  });

  // ---- 8. Guardian pause ----
  console.log("\n[6] Guardian pause and governance unpause");
  await governed("guardian:pause-blocks-deposit-and-mint", async () => {
    // The deployer is the guardian on Sepolia; on a fork run by a local account it is not, so
    // governance (also allowed to pause) stands in.
    const guardian = (await vault.hasRole(await vault.GUARDIAN_ROLE(), deployer.address)) ? vault : gov!.vault;
    await (await guardian.emergencyPause()).wait();
    assert(await vault.paused(), "vault not paused");
    await (await paxg.mint(carol.address, E18)).wait();
    await (await paxg.connect(carol).approve(a.vault, E18)).wait();
    // deposit() carries no whenNotPaused guard (collateral top-ups stay possible during a pause);
    // docs/LAUNCH.md step 2.5 item 8 says deposits revert, so record what actually happens.
    let dep = "ALLOWED while paused";
    try { await (await vault.connect(carol).deposit(PAXG, E18)).wait(); } catch (e) { dep = `reverted: ${describeError(e).slice(0, 40)}`; }
    const mint = await expectRevert(vault.connect(dave).mint(ethers.parseEther("100")));
    // Liveness: a vault with no debt may withdraw while paused, so carol takes her gold back now.
    await (await vault.connect(carol).withdraw(E18)).wait();
    assert((await vaultOf(carol.address)).collateral === 0n, "debt-free withdrawal during pause failed");
    const expiry: bigint = await vault.pauseExpiresAt();
    assert(expiry > 0n, "pauseExpiresAt not set");
    await (await gov!.vault.unpause(await vault.pauseEpoch())).wait();
    assert(!(await vault.paused()), "vault still paused");
    return `deposit: ${dep.slice(0, 50)}; mint: ${mint.slice(0, 50)}; debt-free withdraw while paused OK; pause would have lapsed at ${new Date(Number(expiry) * 1000).toISOString()}`;
  });

  // ---- cleanup ----
  console.log("\n[7] Cleanup");
  await scenario("cleanup:pool-leaves-5000", async () => {
    const eff: bigint = await pool.getEffectiveDeposit(deployer.address);
    const keep = ethers.parseEther("5000");
    if (eff > keep) await (await pool.withdraw(eff - keep)).wait();
    return `deployer pool deposit ${fmt(await pool.getEffectiveDeposit(deployer.address))} GSUSD`;
  });
  await scenario("cleanup:final-state", async () => {
    if (gov) {
      if (await oracle.paused()) await (await gov.oracle.unpause(await oracle.pauseEpoch())).wait();
      if (await vault.paused()) await (await gov.vault.unpause(await vault.pauseEpoch())).wait();
      if ((await vault.badDebtPauseThreshold()) !== thresholdBefore) await (await gov.vault.setBadDebtPauseThreshold(thresholdBefore)).wait();
    }
    await setFeeds(PRICE_START);
    for (const t of tokens) {
      if ((await oracle.getLastKnownPrice(t)) === PRICE_START) continue;
      if (gov) await (await gov.oracle.resyncLastKnownPrice(t)).wait();
      else console.log(`    anchor for ${t} sits off the baseline and only governance can resync it`);
    }
    price = PRICE_START;
    await poke();
    const lines = [
      `oracle paused ${await oracle.paused()}, vault paused ${await vault.paused()}, badDebt ${fmt(await vault.totalBadDebt())}`,
      `reserve ${fmt(await reserve.collateralBalance(PAXG))} PAXG, pool ${fmt(await pool.getTotalDeposits())} GSUSD, supply ${fmt(await gsusd.totalSupply())} GSUSD`,
      `deployer vault ${(await ratioOf(deployer.address)).toFixed(2)}%, buffer ${fmt(await buffer.gsusdBalance())} GSUSD`,
    ];
    console.log(lines.map((l) => `    ${l}`).join("\n"));
    return "restored";
  });

  const passed = results.filter((r) => r.status === "PASS").length;
  const failed = results.filter((r) => r.status === "FAIL");
  console.log(`\nRehearsal: ${passed}/${results.length - results.filter((r) => r.status === "SKIP").length} checks passed`);
  if (failed.length) {
    console.log("FAILED:");
    for (const f of failed) console.log(`  ✗ ${f.name}: ${f.detail}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(describeErrorStack(error));
  process.exit(1);
});
