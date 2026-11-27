import { expect } from "chai";
import { ethers } from "hardhat";
import { FunctionFragment, type Fragment } from "ethers";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import type { MockAggregatorV3 } from "../typechain-types";
import { runSetOriginationFee } from "../scripts/lib/originationFee";
import { fundGsusd, OPEN_MIN_RATIO, openSystem, type System } from "./helpers/openProfile";
import { LIQ_PENALTY, LIQ_RATIO, setValidPrice } from "./helpers/productionSystem";

/**
 * Leverage looping on the real contracts at the open launch profile: 130% minimum, 110%
 * liquidation, 5% penalty, 2% stability fee, 5 bps origination fee, no debt ceiling and no
 * per block cap. A looper deposits E PAXG, mints GSUSD to a target ratio, converts the GSUSD
 * into PAXG through GoldStabilityReserve.swapGsusdForGold (the only GSUSD to gold route in
 * the fixtures; there is no swap capable Uniswap mock) and deposits it again.
 *
 * Closed form, with f the origination fee, s the reserve spread, r the target ratio and
 * k = (1 - f)(1 - s) / r: collateral after n loops is E (1 - k^(n+1)) / (1 - k), debt is
 * E P (1 - k^n) / (r (1 - k)) and the limit is E r / (r - (1 - f)(1 - s)).
 *
 * Every write that moves a debt is pinned to a chosen second, so the 2% fee accrued between
 * blocks is replicated exactly from the StabilityModule state and the wall clock never enters
 * a figure. Section 4 alone jumps to the next UTC day, so its debts move by a few wei from run
 * to run with the fixture's time of day; its assertions are exact all the same. Gold moves C
 * (PAXG/USD) and G (XAU/USD) together; a move of C alone is the two source clamp's case and is
 * shown separately.
 */

const WAD = 10n ** 18n;
const PPM = 1_000_000n;
const PRICE_UNIT = 100_000_000n;
const BPS = 10_000n;
const FEED_TO_WAD = 10n ** 10n;
/** $3,942.37, the Sepolia feed stamp of 2 November 2026. */
const ENTRY_PRICE = 394_237_000_000n;
const ORIGINATION_FEE_BPS = 5n;
const RESERVE_DAILY_CAP_PPM = 200_000n;
const TOP_SPREAD_PPM = 5_000n;
const RESTRICTED_SPREAD_PPM = 20_000n;
const LAUNCH_SPREAD_CURVE = [
  { coverageAtLeastPpm: 150_000n, spreadPpm: 5_000n },
  { coverageAtLeastPpm: 100_000n, spreadPpm: 5_000n },
  { coverageAtLeastPpm: 50_000n, spreadPpm: 7_500n },
  { coverageAtLeastPpm: 20_000n, spreadPpm: 12_500n },
];
const LIQUIDATOR_SHARE_PPM = 600_000n;
const RESERVE_PENALTY_SHARE_BPS = 4_000n;
/** The market leg of an unwind sells PAXG at the oracle price less 0.30%, the Sepolia pool's fee tier. */
const MARKET_FEE_PPM = 3_000n;
const EQUITY = ethers.parseEther("10");
const EQUITY_VALUE = (EQUITY * ENTRY_PRICE) / PRICE_UNIT;
const DEEP_RESERVE = ethers.parseEther("1000");
const SEPOLIA_RESERVE = ethers.parseEther("20");
const DAY = 86_400;
const YEAR = 365 * DAY;

const FEE = Number(ORIGINATION_FEE_BPS) / Number(BPS);
const SPREAD = Number(TOP_SPREAD_PPM) / Number(PPM);
/**
 * Leverage and debt against the closed form, which ignores the stability fee. Each mint reads a
 * debt that has accrued for the three seconds since the previous mint (about 2e-9 of it at 2%),
 * which trims that mint; over the 40 loops of section 2 the trims add up to about 2e-7 of the
 * leverage. Integer rounding adds a few wei per step.
 */
const CLOSED_FORM_TOLERANCE = 1e-6;

type LeverageSystem = System & {
  anchorFeed: MockAggregatorV3;
  paxgAddr: string;
  loopers: HardhatEthersSigner[];
  liquidator: HardhatEthersSigner;
};

interface AccrualState {
  accumulator: bigint;
  lastAccrual: bigint;
  rate: bigint;
  normalised: bigint;
}

interface MintOutcome {
  amount: bigint;
  fee: bigint;
  debt: bigint;
  viewRatio: bigint;
}

interface Purchase {
  gsusdIn: bigint;
  spreadPpm: bigint;
  spreadFee: bigint;
  gold: bigint;
}

interface LoopRow {
  loop: number;
  minted: bigint;
  originationFee: bigint;
  spreadFee: bigint;
  goldBought: bigint;
  collateral: bigint;
  debt: bigint;
  ratioAfterMint: bigint;
  ratioAfterDeposit: bigint;
  leverage: number;
  debtPerEquity: number;
}

// ---------------------------------------------------------------------------------------
// Arithmetic replicas of the contracts

function ceilDiv(a: bigint, b: bigint): bigint {
  return (a + b - 1n) / b;
}

/** StabilityModule._rpow: exponentiation by squaring with half up rounding at 1e18. */
function rpow(base: bigint, exponent: bigint): bigint {
  const half = WAD / 2n;
  let x = base;
  let z = exponent % 2n === 0n ? WAD : x;
  for (let n = exponent / 2n; n > 0n; n /= 2n) {
    x = (x * x + half) / WAD;
    if (n % 2n === 1n) z = (z * x + half) / WAD;
  }
  return z;
}

function accumulatorAt(state: AccrualState, t: number): bigint {
  const elapsed = BigInt(t) - state.lastAccrual;
  return elapsed === 0n ? state.accumulator : (state.accumulator * rpow(state.rate, elapsed)) / WAD;
}

/** StabilityModule.getCurrentDebt as it reads in a block stamped `t`. */
function debtAt(state: AccrualState, t: number): bigint {
  return (state.normalised * accumulatorAt(state, t)) / WAD;
}

/** GoldVault._value for an 18 decimal token. */
function valueOf(collateral: bigint, price: bigint): bigint {
  return (collateral * price) / PRICE_UNIT;
}

/** The lowest price at which a vault with `collateral` and `debt` is not liquidatable (GoldVault._requireLiquidatable). */
function lowestSafePrice(collateral: bigint, debt: bigint): bigint {
  return ceilDiv(ceilDiv(LIQ_RATIO * debt, PPM) * PRICE_UNIT, collateral);
}

/** GoldStabilityReserve.swapGsusdForGold for an 18 decimal token. */
function goldFor(gsusdIn: bigint, spreadPpm: bigint, price: bigint): bigint {
  return ((gsusdIn - (gsusdIn * spreadPpm) / PPM) * WAD) / (price * FEED_TO_WAD);
}

function fraction(numerator: bigint, denominator: bigint): number {
  return Number((numerator * 10n ** 15n) / denominator) / 1e15;
}

function k(ratio: number, spread: number): number {
  return ((1 - FEE) * (1 - spread)) / ratio;
}

function leverageAfter(loops: number, ratio: number, spread: number): number {
  const q = k(ratio, spread);
  return (1 - q ** (loops + 1)) / (1 - q);
}

function debtPerEquityAfter(loops: number, ratio: number, spread: number): number {
  const q = k(ratio, spread);
  return (1 - q ** loops) / (ratio * (1 - q));
}

function leverageLimit(ratio: number, spread: number): number {
  return ratio / (ratio - (1 - FEE) * (1 - spread));
}

function asRatio(ppm: bigint): number {
  return Number(ppm) / Number(PPM);
}

/** The function names in a contract's ABI. */
function functionNames(contract: { interface: { fragments: readonly Fragment[] } }): string[] {
  return contract.interface.fragments
    .filter((fragment): fragment is FunctionFragment => FunctionFragment.isFragment(fragment))
    .map((fragment) => fragment.name);
}

// ---------------------------------------------------------------------------------------
// Fixtures

async function launchProfile(reserveSeed: bigint): Promise<LeverageSystem> {
  const base = await openSystem();
  const paxgAddr = await base.paxg.getAddress();
  const anchorFeed = await (await ethers.getContractFactory("MockAggregatorV3")).deploy(8);
  const signers = await ethers.getSigners();
  const s: LeverageSystem = { ...base, anchorFeed, paxgAddr, loopers: signers.slice(10, 13), liquidator: signers[13] };
  await stamp(anchorFeed, ENTRY_PRICE);
  await s.oracle.setAnchorFeed(await anchorFeed.getAddress());
  await setGold(s, ENTRY_PRICE);

  // The launch fee through the governed path of scripts/set-origination-fee.ts: the deployer
  // still holds GOVERNANCE_ROLE in the fixture, so it is the direct, pre-handover call.
  const timelock = await ethers.getContractAt("TimelockController", s.timelockAddr);
  const outcome = await runSetOriginationFee({
    vault: s.vault,
    timelock,
    signer: s.deployer,
    bps: ORIGINATION_FEE_BPS,
    memo: "launch fee",
    confirm: true,
  });
  if (outcome.step !== "set") throw new Error(`origination fee not set: ${outcome.step}`);

  // The reserve at the launch parameters: 20% of the day-start balance per UTC day, no floor,
  // the deploy.ts spread curve.
  const reserveAddr = await s.reserve.getAddress();
  await s.reserve.setAssetConfig(paxgAddr, true, 0n, RESERVE_DAILY_CAP_PPM);
  await s.reserve.setSpreadCurve(LAUNCH_SPREAD_CURVE, RESTRICTED_SPREAD_PPM);
  await s.paxg.mint(s.deployer.address, reserveSeed);
  await s.paxg.approve(reserveAddr, reserveSeed);
  await s.reserve.seedCollateral(paxgAddr, reserveSeed);

  const vaultAddr = await s.vault.getAddress();
  for (const looper of s.loopers) {
    await s.paxg.mint(looper.address, EQUITY);
    await s.paxg.connect(looper).approve(vaultAddr, ethers.MaxUint256);
    await s.stablecoin.connect(looper).approve(reserveAddr, ethers.MaxUint256);
    await s.stablecoin.connect(looper).approve(vaultAddr, ethers.MaxUint256);
  }
  return s;
}

/** A reserve deep enough that neither its daily cap nor its coverage binds a 10 PAXG looper. */
async function deepReserveSystem(): Promise<LeverageSystem> {
  return launchProfile(DEEP_RESERVE);
}

/** The Sepolia reserve's size: it was seeded with 20 PAXG. */
async function sepoliaReserveSystem(): Promise<LeverageSystem> {
  return launchProfile(SEPOLIA_RESERVE);
}

// ---------------------------------------------------------------------------------------
// Chain helpers

/** Send in a block stamped one second after the latest. */
async function pinned<T>(send: () => Promise<T>): Promise<T> {
  await time.setNextBlockTimestamp((await time.latest()) + 1);
  return send();
}

/** The fixture's setValidPrice, pinned like every other write. */
async function stamp(feed: MockAggregatorV3, price: bigint): Promise<void> {
  await pinned(() => setValidPrice(feed, price));
}

/** Gold moves: C, G (and XAUT's feed, for tidiness) together; lastKnownPrice follows. */
async function setGold(s: LeverageSystem, price: bigint): Promise<void> {
  for (const feed of [s.paxgFeed, s.xautFeed, s.anchorFeed]) await stamp(feed, price);
  await pinned(() => s.oracle.getTokenPrice(s.paxgAddr));
}

async function accrualState(s: LeverageSystem, who: string): Promise<AccrualState> {
  return {
    accumulator: await s.stabilityModule.rateAccumulator(s.paxgId),
    lastAccrual: await s.stabilityModule.lastAccrualTimestamp(s.paxgId),
    rate: await s.stabilityModule.stabilityFeeRate(s.paxgId),
    normalised: await s.stabilityModule.normalisedDebt(who, s.paxgId),
  };
}

async function collateralOf(s: LeverageSystem, who: HardhatEthersSigner): Promise<bigint> {
  return (await s.vault.vaults(who.address)).collateralAmount;
}

async function openPosition(s: LeverageSystem, who: HardhatEthersSigner): Promise<void> {
  await pinned(() => s.vault.connect(who).deposit(s.paxgAddr, EQUITY));
}

/**
 * Mint the most the vault allows at `target`: the debt that puts the ratio the mint checks at
 * the target. Section 2 proves against the contract that one wei more is refused. The view read
 * afterwards includes the StabilityModule's protocol favouring round up of the new normalised
 * debt, so it can read one ppm under the ratio the mint itself checked.
 */
async function mintToRatio(s: LeverageSystem, who: HardhatEthersSigner, target: bigint): Promise<MintOutcome> {
  const t = (await time.latest()) + 1;
  const state = await accrualState(s, who.address);
  const price = await s.oracle.quoteBorrowPrice(s.paxgAddr);
  const value = valueOf(await collateralOf(s, who), price);
  const ceiling = (value * PPM) / target;
  const amount = ceiling - debtAt(state, t);

  const held = await s.stablecoin.balanceOf(who.address);
  await time.setNextBlockTimestamp(t);
  await s.vault.connect(who).mint(amount);
  const fee = (amount * ORIGINATION_FEE_BPS) / BPS;
  expect((await s.stablecoin.balanceOf(who.address)) - held).to.equal(amount - fee);

  const accumulator = accumulatorAt(state, t);
  const debt = ((state.normalised + ceilDiv(amount * WAD, accumulator)) * accumulator) / WAD;
  expect(await s.vault.getVaultCurrentDebt(who.address)).to.equal(debt);
  const viewRatio = await s.vault.getCollateralisationRatio(who.address);
  expect(viewRatio).to.equal((value * PPM) / debt);
  return { amount, fee, debt, viewRatio };
}

async function buyGoldFromReserve(s: LeverageSystem, who: HardhatEthersSigner, gsusdIn: bigint): Promise<Purchase> {
  const [quoted, spreadPpm] = await s.reserve.quoteGoldOut(s.paxgAddr, gsusdIn);
  const price = await s.oracle.quoteReservePrice(s.paxgAddr);
  const spreadFee = (gsusdIn * spreadPpm) / PPM;
  const gold = goldFor(gsusdIn, spreadPpm, price);
  expect(quoted).to.equal(gold);
  const tx = await pinned(() => s.reserve.connect(who).swapGsusdForGold(s.paxgAddr, gsusdIn, quoted));
  await expect(tx)
    .to.emit(s.reserve, "Swapped")
    .withArgs(who.address, s.paxgAddr, gsusdIn, gold, spreadPpm, spreadFee);
  return { gsusdIn, spreadPpm, spreadFee, gold };
}

/** The largest GSUSD input that buys exactly `gold` from the reserve at the spread it would pay. */
async function gsusdBuying(s: LeverageSystem, gold: bigint): Promise<bigint> {
  const price = await s.oracle.quoteReservePrice(s.paxgAddr);
  let spread = TOP_SPREAD_PPM;
  for (let attempt = 0; attempt < 4; attempt++) {
    let lo = 0n;
    let hi = 2n * ((gold * price * FEED_TO_WAD) / WAD) + WAD;
    while (lo < hi) {
      const mid = (lo + hi + 1n) / 2n;
      if (goldFor(mid, spread, price) <= gold) lo = mid;
      else hi = mid - 1n;
    }
    const [quoted, quotedSpread] = await s.reserve.quoteGoldOut(s.paxgAddr, lo);
    if (quotedSpread === spread) {
      expect(quoted).to.equal(gold);
      return lo;
    }
    spread = quotedSpread;
  }
  throw new Error("the spread tier did not settle");
}

/** One loop: mint to `target`, convert every GSUSD received at the reserve, deposit the gold. */
async function loopOnce(s: LeverageSystem, who: HardhatEthersSigner, target: bigint, n: number): Promise<LoopRow> {
  const mint = await mintToRatio(s, who, target);
  const purchase = await buyGoldFromReserve(s, who, mint.amount - mint.fee);
  expect(await s.stablecoin.balanceOf(who.address)).to.equal(0n);
  await pinned(() => s.vault.connect(who).deposit(s.paxgAddr, purchase.gold));
  const collateral = await collateralOf(s, who);
  const debt = await s.vault.getVaultCurrentDebt(who.address);
  const ratioAfterDeposit = await s.vault.getCollateralisationRatio(who.address);
  expect(ratioAfterDeposit).to.equal((valueOf(collateral, ENTRY_PRICE) * PPM) / debt);
  return {
    loop: n,
    minted: mint.amount,
    originationFee: mint.fee,
    spreadFee: purchase.spreadFee,
    goldBought: purchase.gold,
    collateral,
    debt,
    ratioAfterMint: mint.viewRatio,
    ratioAfterDeposit,
    leverage: fraction(collateral, EQUITY),
    debtPerEquity: fraction(debt, EQUITY_VALUE),
  };
}

async function loop(s: LeverageSystem, who: HardhatEthersSigner, target: bigint, loops: number): Promise<LoopRow[]> {
  const rows: LoopRow[] = [];
  for (let n = 1; n <= loops; n++) rows.push(await loopOnce(s, who, target, n));
  return rows;
}

/** The most collateral a withdrawal in a block stamped `t` may take (GoldVault.withdraw at the borrowing price). */
async function maxWithdrawableAt(s: LeverageSystem, who: HardhatEthersSigner, t: number): Promise<bigint> {
  const debt = debtAt(await accrualState(s, who.address), t);
  const price = await s.oracle.quoteBorrowPrice(s.paxgAddr);
  const needed = ceilDiv(ceilDiv(OPEN_MIN_RATIO * debt, PPM) * PRICE_UNIT, price);
  const collateral = await collateralOf(s, who);
  return collateral > needed ? collateral - needed : 0n;
}

async function startOfNextUtcDay(s: LeverageSystem): Promise<void> {
  const next = (Math.floor((await time.latest()) / DAY) + 1) * DAY + 3_600;
  await time.increaseTo(next);
  await setGold(s, ENTRY_PRICE);
}

// ---------------------------------------------------------------------------------------

describe("Leverage looping (open launch profile)", function () {
  this.timeout(600_000);

  describe("1. loops to a target ratio match the closed form", function () {
    for (const target of [2_000_000n, 1_600_000n, 1_400_000n]) {
      it(`loops six times to ${Number(target) / 10_000}%`, async function () {
        const s = await loadFixture(deepReserveSystem);
        const looper = s.loopers[0];
        const supply0 = await s.stablecoin.totalSupply();
        const fees0 = await s.vault.totalOriginationFees();
        const buffer0 = await s.surplusBuffer.gsusdBalance();
        const spread0 = await s.reserve.totalSpreadPaid();
        const inventory0 = await s.reserve.gsusdInventory();

        await openPosition(s, looper);
        const rows = await loop(s, looper, target, 6);

        const r = asRatio(target);
        for (const row of rows) {
          expect(row.ratioAfterMint).to.be.oneOf([target - 1n, target]);
          expect(row.ratioAfterDeposit).to.be.gt(target);
          expect(row.originationFee).to.equal((row.minted * ORIGINATION_FEE_BPS) / BPS);
          expect(row.leverage / leverageAfter(row.loop, r, SPREAD) - 1).to.be.closeTo(0, CLOSED_FORM_TOLERANCE);
          expect(row.debtPerEquity / debtPerEquityAfter(row.loop, r, SPREAD) - 1).to.be.closeTo(0, CLOSED_FORM_TOLERANCE);
        }

        const minted = rows.reduce((sum, row) => sum + row.minted, 0n);
        const fees = rows.reduce((sum, row) => sum + row.originationFee, 0n);
        const spreads = rows.reduce((sum, row) => sum + row.spreadFee, 0n);
        // Supply rises by the full amount minted: the fee is minted too and banked, not burned.
        expect((await s.stablecoin.totalSupply()) - supply0).to.equal(minted);
        expect((await s.vault.totalOriginationFees()) - fees0).to.equal(fees);
        // The buffer banks both the origination fees and the reserve's spread.
        expect((await s.surplusBuffer.gsusdBalance()) - buffer0).to.equal(fees + spreads);
        expect((await s.reserve.totalSpreadPaid()) - spread0).to.equal(spreads);
        // The GSUSD the looper sold sits in the reserve as inventory; none of it is burned.
        expect((await s.reserve.gsusdInventory()) - inventory0).to.equal(minted - fees - spreads);
        expect(rows[rows.length - 1].leverage).to.be.lt(leverageLimit(r, SPREAD));
      });
    }
  });

  describe("2. the 130% minimum is a hard cap on leverage", function () {
    it("converges on r / (r - (1 - f)(1 - s)) and refuses the wei that would cross 130%", async function () {
      const s = await loadFixture(deepReserveSystem);
      const looper = s.loopers[0];
      await openPosition(s, looper);
      const rows: LoopRow[] = [];
      // Loop until a mint brings in less than 1 GSUSD: the leverage left on the table is then
      // about 2e-5 of the limit.
      for (let n = 1; n <= 60; n++) {
        const row = await loopOnce(s, looper, OPEN_MIN_RATIO, n);
        rows.push(row);
        if (row.minted < WAD) break;
      }
      expect(rows[rows.length - 1].minted).to.be.lt(WAD);
      const r = asRatio(OPEN_MIN_RATIO);
      const last = rows[rows.length - 1];
      expect(last.leverage / leverageAfter(last.loop, r, SPREAD) - 1).to.be.closeTo(0, CLOSED_FORM_TOLERANCE);
      expect(last.leverage).to.be.lt(leverageLimit(r, SPREAD));
      expect(last.leverage).to.be.gt(leverageLimit(r, SPREAD) * 0.9999);
      expect(last.leverage).to.be.lt(r / (r - 1));

      // One wei over the cap is refused with the exact reason.
      const t = (await time.latest()) + 1;
      const value = valueOf(await collateralOf(s, looper), ENTRY_PRICE);
      const room = (value * PPM) / OPEN_MIN_RATIO - debtAt(await accrualState(s, looper.address), t);
      await time.setNextBlockTimestamp(t);
      await expect(s.vault.connect(looper).mint(room + 1n)).to.be.revertedWith("Below min collateralisation ratio");

      // The exact room is granted. After it, one more wei is refused and no gold may leave.
      const final = await mintToRatio(s, looper, OPEN_MIN_RATIO);
      await expect(pinned(() => s.vault.connect(looper).mint(1n))).to.be.revertedWith(
        "Below min collateralisation ratio"
      );
      await expect(pinned(() => s.vault.connect(looper).withdraw(1n))).to.be.revertedWith("Below min ratio");

      // Illustrative: on the equity left, leverage at 130% is r / (r - 1) = 4.333x whatever the
      // costs were. It follows from minting exactly to r, so it checks the arithmetic, not the
      // contracts.
      const netLeverage = fraction(value, value - final.debt);
      expect(netLeverage).to.be.closeTo(r / (r - 1), 1e-5);
    });
  });

  describe("3. liquidation thresholds", function () {
    it("liquidates a 4x loop one unit below its liquidation price and leaves a 2x loop standing", async function () {
      const s = await loadFixture(deepReserveSystem);
      const [aggressive, cautious] = s.loopers;
      const liquidator = s.liquidator;
      await openPosition(s, aggressive);
      const fourX = await loop(s, aggressive, OPEN_MIN_RATIO, 10);
      await openPosition(s, cautious);
      const twoX = await loop(s, cautious, 1_600_000n, 2);
      expect(fourX[9].leverage).to.be.gt(4);
      expect(twoX[1].leverage).to.be.gt(2);

      // Liquidation price = entry price x 1.10 x debt / collateral value.
      for (const who of [aggressive, cautious]) {
        const collateral = await collateralOf(s, who);
        const debt = await s.vault.getVaultCurrentDebt(who.address);
        const lp = await s.vault.getLiquidationPrice(who.address);
        expect(lp).to.equal((debt * LIQ_RATIO * PRICE_UNIT) / (collateral * PPM));
        const formula = Number(ENTRY_PRICE) * 1.1 * fraction(debt, valueOf(collateral, ENTRY_PRICE));
        expect(Number(lp)).to.be.closeTo(formula, 1);
      }

      // Two source clamp: PAXG/USD alone 20% down while gold holds. Liquidation still prices at
      // gold, so nothing is liquidatable; borrowing is refused off the 2% band.
      await stamp(s.paxgFeed, (ENTRY_PRICE * 80n) / 100n);
      expect(await s.oracle.quoteTokenPrice(s.paxgAddr)).to.equal(ENTRY_PRICE);
      await expect(s.oracle.quoteBorrowPrice(s.paxgAddr)).to.be.revertedWith("Off gold band");
      await expect(pinned(() => s.vault.connect(liquidator).liquidate(aggressive.address, 0n))).to.be.revertedWith(
        "Not undercollateralised"
      );
      await expect(pinned(() => s.vault.connect(aggressive).mint(WAD))).to.be.revertedWith("Off gold band");

      const collateral = await collateralOf(s, aggressive);
      const state = await accrualState(s, aggressive.address);

      // Gold itself falls to the lowest safe price for the block the call lands in: refused.
      const t1 = (await time.latest()) + 10;
      const safe = lowestSafePrice(collateral, debtAt(state, t1));
      const contractFormula = (debtAt(state, t1) * LIQ_RATIO * PRICE_UNIT) / (collateral * PPM);
      expect(safe - contractFormula).to.be.oneOf([0n, 1n]);
      await setGold(s, safe);
      await time.setNextBlockTimestamp(t1);
      await expect(s.vault.connect(liquidator).liquidate(aggressive.address, 0n)).to.be.revertedWith(
        "Not undercollateralised"
      );

      // One unit (1e-8 USD) lower: liquidated in full. The liquidator is funded first, with a
      // minute of fee to spare, because fundGsusd's writes are not pinned: had they run after t2
      // was chosen, a slow machine could stamp them past it.
      await fundGsusd(s, liquidator, debtAt(state, (await time.latest()) + 60));
      const gsusd0 = await s.stablecoin.balanceOf(liquidator.address);
      const t2 = (await time.latest()) + 10;
      const debt = debtAt(state, t2);
      const price = lowestSafePrice(collateral, debt) - 1n;
      await setGold(s, price);
      const reserveGold0 = await s.reserve.collateralBalance(s.paxgAddr);
      const liquidatorGold0 = await s.paxg.balanceOf(liquidator.address);
      await time.setNextBlockTimestamp(t2);
      await s.vault.connect(liquidator).liquidate(aggressive.address, 0n);

      const seize = (debt * (PPM + LIQ_PENALTY) * PRICE_UNIT) / (price * PPM);
      const debtEquivalent = (debt * PRICE_UNIT) / price;
      const bonus = ((seize - debtEquivalent) * LIQUIDATOR_SHARE_PPM) / PPM;
      const protocolShare = seize - debtEquivalent - bonus;
      expect(await collateralOf(s, aggressive)).to.equal(collateral - seize);
      expect((await s.vault.vaults(aggressive.address)).debtAmount).to.equal(0n);
      expect((await s.paxg.balanceOf(liquidator.address)) - liquidatorGold0).to.equal(debtEquivalent + bonus);
      expect((await s.reserve.collateralBalance(s.paxgAddr)) - reserveGold0).to.equal(
        (protocolShare * RESERVE_PENALTY_SHARE_BPS) / BPS
      );
      expect(gsusd0 - (await s.stablecoin.balanceOf(liquidator.address))).to.equal(debt);

      // The same fall leaves the 2x loop far above 110%.
      await expect(pinned(() => s.vault.connect(liquidator).liquidate(cautious.address, 0n))).to.be.revertedWith(
        "Not undercollateralised"
      );
      expect(await s.vault.getCollateralisationRatio(cautious.address)).to.be.gt(LIQ_RATIO);
      expect(await s.vault.getLiquidationPrice(cautious.address)).to.be.lt(price);
    });
  });

  describe("4. the reserve limits how much one looper converts in a day", function () {
    it("caps the conversion at 20% of the day-start gold and prices a thinning reserve dearer", async function () {
      const s = await loadFixture(sepoliaReserveSystem);
      const looper = s.loopers[0];
      await startOfNextUtcDay(s);
      await openPosition(s, looper);

      const first = await mintToRatio(s, looper, OPEN_MIN_RATIO);
      const proceeds = first.amount - first.fee;
      const capacity = await s.reserve.remainingDailyCapacity(s.paxgAddr);
      expect(capacity).to.equal((SEPOLIA_RESERVE * RESERVE_DAILY_CAP_PPM) / PPM);
      const [wanted] = await s.reserve.quoteGoldOut(s.paxgAddr, proceeds);
      expect(wanted).to.be.gt(capacity);
      await expect(
        pinned(() => s.reserve.connect(looper).swapGsusdForGold(s.paxgAddr, proceeds, 0n))
      ).to.be.revertedWith("Daily cap reached");

      const day1 = await buyGoldFromReserve(s, looper, await gsusdBuying(s, capacity));
      expect(day1.gold).to.equal(capacity);
      expect(await s.reserve.remainingDailyCapacity(s.paxgAddr)).to.equal(0n);
      await expect(
        pinned(() => s.reserve.connect(looper).swapGsusdForGold(s.paxgAddr, WAD, 0n))
      ).to.be.revertedWith("Daily cap reached");
      await pinned(() => s.vault.connect(looper).deposit(s.paxgAddr, day1.gold));
      expect(await collateralOf(s, looper)).to.equal(EQUITY + capacity);

      const spreads: bigint[] = [day1.spreadPpm];
      for (let day = 2; day <= 14; day++) {
        await startOfNextUtcDay(s);
        const start = await s.reserve.collateralBalance(s.paxgAddr);
        const cap = await s.reserve.remainingDailyCapacity(s.paxgAddr);
        expect(cap).to.equal((start * RESERVE_DAILY_CAP_PPM) / PPM);
        if ((await s.stablecoin.balanceOf(looper.address)) < (await gsusdBuying(s, cap))) {
          await mintToRatio(s, looper, OPEN_MIN_RATIO);
        }
        // Priced after any mint: new supply lowers coverage and can move the spread tier.
        const need = await gsusdBuying(s, cap);
        const held = await s.stablecoin.balanceOf(looper.address);
        const bought = await buyGoldFromReserve(s, looper, held < need ? held : need);
        if (held >= need) {
          expect(bought.gold).to.equal(cap);
          await expect(
            pinned(() => s.reserve.connect(looper).swapGsusdForGold(s.paxgAddr, WAD, 0n))
          ).to.be.revertedWith("Daily cap reached");
        }
        await pinned(() => s.vault.connect(looper).deposit(s.paxgAddr, bought.gold));
        spreads.push(bought.spreadPpm);
      }

      // The looper took the whole cap every day, so the reserve fell by a fifth a day.
      let left = SEPOLIA_RESERVE;
      for (let day = 1; day <= 14; day++) left -= (left * RESERVE_DAILY_CAP_PPM) / PPM;
      expect(await s.reserve.collateralBalance(s.paxgAddr)).to.equal(left);
      expect(await collateralOf(s, looper)).to.equal(EQUITY + SEPOLIA_RESERVE - left);
      // The 0.5% tier holds for eight days while the cap does the limiting. The spread rises
      // only once a swap would leave coverage under 10% (0.75%) and then under 5% (1.25%) of
      // the circulating supply, which here includes the 100,000 GSUSD the fixture mints.
      expect(spreads).to.deep.equal([
        ...Array<bigint>(8).fill(5_000n),
        ...Array<bigint>(3).fill(7_500n),
        ...Array<bigint>(3).fill(12_500n),
      ]);
      // Fourteen days of the full cap leave a 10 PAXG looper short of 3x.
      expect(fraction(await collateralOf(s, looper), EQUITY)).to.be.lt(3);
    });
  });

  describe("5. the stability fee", function () {
    it("grows a 4x loop's debt by e^0.02 - 1 in a year and lowers its ratio by the same factor", async function () {
      const s = await loadFixture(deepReserveSystem);
      const looper = s.loopers[0];
      await openPosition(s, looper);
      await loop(s, looper, OPEN_MIN_RATIO, 10);
      const collateral = await collateralOf(s, looper);
      const state = await accrualState(s, looper.address);
      const t0 = await time.latest();
      const debt0 = await s.vault.getVaultCurrentDebt(looper.address);
      const ratio0 = await s.vault.getCollateralisationRatio(looper.address);
      const lp0 = await s.vault.getLiquidationPrice(looper.address);
      expect(debt0).to.equal(debtAt(state, t0));

      await time.increaseTo(t0 + YEAR);
      const debt1 = await s.vault.getVaultCurrentDebt(looper.address);
      expect(debt1).to.equal(debtAt(state, t0 + YEAR));
      const growth = fraction(debt1 - debt0, debt0);
      expect(growth).to.be.closeTo(Math.expm1(0.02), 1e-9);

      const ratio1 = await s.vault.getCollateralisationRatio(looper.address);
      expect(ratio1).to.equal((valueOf(collateral, ENTRY_PRICE) * PPM) / debt1);
      expect(asRatio(ratio1) / asRatio(ratio0)).to.be.closeTo(1 / (1 + growth), 2e-6);
      const lp1 = await s.vault.getLiquidationPrice(looper.address);
      expect(fraction(lp1, lp0) - 1).to.be.closeTo(growth, 1e-9);
      expect(ratio1).to.be.lt(OPEN_MIN_RATIO);

      // The fee alone took the vault under 130%: no mint, no withdrawal, but no liquidation yet.
      await setGold(s, ENTRY_PRICE);
      await expect(pinned(() => s.vault.connect(looper).mint(1n))).to.be.revertedWith(
        "Below min collateralisation ratio"
      );
      await expect(pinned(() => s.vault.connect(looper).withdraw(1n))).to.be.revertedWith("Below min ratio");
      await expect(pinned(() => s.vault.connect(s.liquidator).liquidate(looper.address, 0n))).to.be.revertedWith(
        "Not undercollateralised"
      );
    });

    it("liquidates the same loop at a flat gold price once the fee alone carries it under 110%", async function () {
      const s = await loadFixture(deepReserveSystem);
      const looper = s.loopers[0];
      await openPosition(s, looper);
      await loop(s, looper, OPEN_MIN_RATIO, 10);
      const value = valueOf(await collateralOf(s, looper), ENTRY_PRICE);
      const state = await accrualState(s, looper.address);
      const liquidatable = (t: number): boolean => (value * PPM) / debtAt(state, t) < LIQ_RATIO;

      let lo = await time.latest();
      let hi = lo + 20 * YEAR;
      while (lo < hi) {
        const mid = Math.floor((lo + hi) / 2);
        if (liquidatable(mid)) hi = mid;
        else lo = mid + 1;
      }
      const tLiq = lo;
      // At a flat price the ratio decays as e^(-0.02 t): 110% is reached ln(R0 / 1.1) / 0.02 years on.
      const t0 = Number(state.lastAccrual);
      const years = (tLiq - t0) / YEAR;
      expect(years).to.be.closeTo(Math.log(fraction(value, debtAt(state, t0)) / 1.1) / 0.02, 1e-6);
      await fundGsusd(s, s.liquidator, debtAt(state, tLiq));
      await time.increaseTo(tLiq - 10);
      await setGold(s, ENTRY_PRICE);
      await time.setNextBlockTimestamp(tLiq - 1);
      await expect(s.vault.connect(s.liquidator).liquidate(looper.address, 0n)).to.be.revertedWith(
        "Not undercollateralised"
      );
      await time.setNextBlockTimestamp(tLiq);
      await expect(s.vault.connect(s.liquidator).liquidate(looper.address, 0n)).to.emit(s.vault, "Liquidated");
      expect((await s.vault.vaults(looper.address)).debtAmount).to.equal(0n);
    });
  });

  describe("6. unwinding", function () {
    it("cannot unwind without outside GSUSD: every repayment is bought from another holder", async function () {
      const s = await loadFixture(deepReserveSystem);
      const looper = s.loopers[0];
      const market = s.alice;
      await openPosition(s, looper);
      await loop(s, looper, OPEN_MIN_RATIO, 10);

      // The protocol offers no route back: the reserve only sells gold, the vault has no repay
      // with collateral and the looper sold every GSUSD it minted.
      expect(functionNames(s.reserve)).to.include("swapGsusdForGold").and.not.include("swapGoldForGsusd");
      const selfUnwinding = functionNames(s.vault).filter((name) =>
        /repay.*collateral|close|deleverage|unwind|selfLiquidat/i.test(name)
      );
      expect(selfUnwinding).to.deep.equal([]);
      expect(await s.stablecoin.balanceOf(looper.address)).to.equal(0n);
      await expect(pinned(() => s.vault.connect(looper).repay(WAD))).to.be.revertedWithCustomError(
        s.stablecoin,
        "ERC20InsufficientBalance"
      );

      // Without GSUSD the only gold that leaves is the spare above 130%; the debt stays whole.
      const t = (await time.latest()) + 1;
      const spareAtT = await maxWithdrawableAt(s, looper, t);
      await time.setNextBlockTimestamp(t);
      await expect(s.vault.connect(looper).withdraw(spareAtT + 1n)).to.be.revertedWith("Below min ratio");
      const t2 = (await time.latest()) + 1;
      const spare = await maxWithdrawableAt(s, looper, t2);
      await time.setNextBlockTimestamp(t2);
      await s.vault.connect(looper).withdraw(spare);
      expect(spare).to.be.gt(0n);
      const debtStart = await s.vault.getVaultCurrentDebt(looper.address);

      // The market buys the looper's PAXG at the oracle price less 0.30% and the looper
      // repays with that GSUSD, then withdraws what the repayment freed. Repeat to zero.
      await fundGsusd(s, market, ethers.parseEther("200000"));
      const minDebt = await s.vault.minDebt();
      let steps = 0;
      let bought = 0n;
      for (; steps < 40; steps++) {
        // Sell only the gold that covers the debt due at the repayment, two blocks later; the
        // rest stays the looper's.
        const wallet = await s.paxg.balanceOf(looper.address);
        const due = debtAt(await accrualState(s, looper.address), (await time.latest()) + 3);
        const covering = ceilDiv(due * PRICE_UNIT * PPM, ENTRY_PRICE * (PPM - MARKET_FEE_PPM)) + 1n;
        const gold = wallet < covering ? wallet : covering;
        const gsusd = (gold * ENTRY_PRICE * (PPM - MARKET_FEE_PPM)) / (PRICE_UNIT * PPM);
        await pinned(() => s.paxg.connect(looper).transfer(market.address, gold));
        await pinned(() => s.stablecoin.connect(market).transfer(looper.address, gsusd));
        bought += gsusd;

        const tr = (await time.latest()) + 1;
        const currentDebt = debtAt(await accrualState(s, looper.address), tr);
        const principal = (await s.vault.vaults(looper.address)).debtAmount;
        const held = await s.stablecoin.balanceOf(looper.address);
        if (held >= currentDebt) {
          await time.setNextBlockTimestamp(tr);
          await s.vault.connect(looper).repay(ethers.MaxUint256);
          expect(await s.stablecoin.balanceOf(looper.address)).to.equal(held - currentDebt);
          break;
        }
        // A partial repayment must leave at least minDebt of principal (GoldVault.repay).
        const keepsMinimum = ((principal - minDebt) * currentDebt) / principal;
        await time.setNextBlockTimestamp(tr);
        await s.vault.connect(looper).repay(held < keepsMinimum ? held : keepsMinimum);
        const tw = (await time.latest()) + 1;
        const freed = await maxWithdrawableAt(s, looper, tw);
        await time.setNextBlockTimestamp(tw);
        await s.vault.connect(looper).withdraw(freed);
      }
      expect((await s.vault.vaults(looper.address)).debtAmount).to.equal(0n);
      const remaining = await collateralOf(s, looper);
      await pinned(() => s.vault.connect(looper).withdraw(remaining));
      expect(await collateralOf(s, looper)).to.equal(0n);
      // About one market step per loop taken and every repayment bought from the market. The
      // round trip leaves the looper with less gold than it started with and only GSUSD dust.
      expect(steps + 1).to.be.within(9, 13);
      expect(bought).to.be.gt(debtStart);
      expect(await s.stablecoin.balanceOf(looper.address)).to.be.lt(WAD);
      const returned = await s.paxg.balanceOf(looper.address);
      expect(returned).to.be.lt(EQUITY);
      expect(returned).to.be.gt((EQUITY * 97n) / 100n);
    });
  });
});
