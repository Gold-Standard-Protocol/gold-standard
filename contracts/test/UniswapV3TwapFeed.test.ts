import { expect } from "chai";
import hre, { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

/**
 * UniswapV3TwapFeed: every constructor guard, every read status and the invalid-is-zero rule.
 * Reference answers are exact floors computed with python3 Decimal at 200 digits; the feed may sit
 * at most one unit of the eighth decimal below them.
 */
describe("UniswapV3TwapFeed", function () {
  const WINDOW = 30 * 60;
  const SUB = WINDOW / 6;
  const MIN_LIQ = 10n ** 15n;
  const DAY = 24 * 60 * 60;
  const OBS_AGE = 6 * 3600;
  const Q128 = 1n << 128n;

  enum Status {
    OK,
    OBSERVE_FAILED,
    BAD_OBSERVATION,
    TICK_OUT_OF_RANGE,
    THIN_LIQUIDITY,
    QUOTE_FEED_FAILED,
    QUOTE_INVALID,
    QUOTE_STALE,
    PRICE_OUT_OF_RANGE,
    NO_RECENT_SWAPS,
  }

  async function token(decimals: number) {
    return (await ethers.getContractFactory("MockERC20")).deploy("T", "T", decimals);
  }

  /** Seven point raw observations from six sub-window mean ticks and one liquidity over the window. */
  function raw(subTicks: number[], liquidity: bigint, lastRemainder = 0): [bigint[], bigint[]] {
    const ticks: bigint[] = [0n];
    const liq: bigint[] = [0n];
    let cumulative = 0n;
    subTicks.forEach((t, i) => {
      cumulative += BigInt(t) * BigInt(SUB);
      ticks.push(cumulative);
      liq.push(((BigInt(SUB) * BigInt(i + 1)) << 128n) / liquidity);
    });
    ticks[6] += BigInt(lastRemainder);
    return [ticks, liq];
  }

  async function fixture() {
    const [deployer, other] = await ethers.getSigners();
    const paxg = await token(18);
    const usdc = await token(6);
    const weth = await token(18);
    const pool = await (await ethers.getContractFactory("MockUniswapV3Pool")).deploy(
      await paxg.getAddress(),
      await usdc.getAddress(),
    );
    await pool.setLiquidity(10n ** 20n);
    await pool.setTick(-193349);
    const wethPool = await (await ethers.getContractFactory("MockUniswapV3Pool")).deploy(
      await weth.getAddress(),
      await paxg.getAddress(),
    );
    await wethPool.setLiquidity(10n ** 20n);
    await wethPool.setTick(-2876);
    const ethUsd = await (await ethers.getContractFactory("MockSwitchableAggregatorV3")).deploy(8);
    const now = await time.latest();
    await ethUsd.setRound(5, 3000n * 10n ** 8n, now, 5);
    const Feed = await ethers.getContractFactory("UniswapV3TwapFeed");
    const usdcFeed = await Feed.deploy(
      await pool.getAddress(), await paxg.getAddress(), WINDOW, MIN_LIQ, ethers.ZeroAddress, 0, OBS_AGE, "PAXG / USD",
    );
    const wethFeed = await Feed.deploy(
      await wethPool.getAddress(), await paxg.getAddress(), WINDOW, MIN_LIQ, await ethUsd.getAddress(), DAY, OBS_AGE, "PAXG / USD via ETH",
    );
    return { deployer, other, paxg, usdc, weth, pool, wethPool, ethUsd, Feed, usdcFeed, wethFeed };
  }

  describe("constructor", function () {
    it("records the pool, both tokens, decimals and configuration in either token order", async function () {
      const f = await loadFixture(fixture);
      expect(await f.usdcFeed.pool()).to.equal(await f.pool.getAddress());
      expect(await f.usdcFeed.baseToken()).to.equal(await f.paxg.getAddress());
      expect(await f.usdcFeed.quoteToken()).to.equal(await f.usdc.getAddress());
      expect(await f.usdcFeed.baseIsToken0()).to.equal(true);
      expect(await f.usdcFeed.baseDecimals()).to.equal(18);
      expect(await f.usdcFeed.quoteDecimals()).to.equal(6);
      expect(await f.usdcFeed.windowSeconds()).to.equal(WINDOW);
      expect(await f.usdcFeed.minHarmonicLiquidity()).to.equal(MIN_LIQ);
      expect(await f.usdcFeed.quoteUsdFeed()).to.equal(ethers.ZeroAddress);
      expect(await f.usdcFeed.maxQuoteAge()).to.equal(0);
      expect(await f.usdcFeed.maxObservationAge()).to.equal(OBS_AGE);
      expect(await f.wethFeed.baseIsToken0()).to.equal(false);
      expect(await f.wethFeed.quoteToken()).to.equal(await f.weth.getAddress());
      expect(await f.wethFeed.maxQuoteAge()).to.equal(DAY);
      expect(await f.usdcFeed.decimals()).to.equal(8);
      expect(await f.usdcFeed.version()).to.equal(2);
      expect(await f.usdcFeed.SUB_WINDOWS()).to.equal(6);
      expect(await f.usdcFeed.description()).to.equal("PAXG / USD");
    });

    it("rejects a zero pool, a zero base, a pool with no code and a pool with no quote token", async function () {
      const f = await loadFixture(fixture);
      const paxg = await f.paxg.getAddress();
      const pool = await f.pool.getAddress();
      await expect(f.Feed.deploy(ethers.ZeroAddress, paxg, WINDOW, MIN_LIQ, ethers.ZeroAddress, 0, OBS_AGE, ""))
        .to.be.revertedWithCustomError(f.Feed, "ZeroAddress");
      await expect(f.Feed.deploy(pool, ethers.ZeroAddress, WINDOW, MIN_LIQ, ethers.ZeroAddress, 0, OBS_AGE, ""))
        .to.be.revertedWithCustomError(f.Feed, "ZeroAddress");
      await expect(f.Feed.deploy(f.other.address, paxg, WINDOW, MIN_LIQ, ethers.ZeroAddress, 0, OBS_AGE, ""))
        .to.be.revertedWithCustomError(f.Feed, "NotAContract").withArgs(f.other.address);
      const halfEmpty = await (await ethers.getContractFactory("MockUniswapV3Pool")).deploy(paxg, ethers.ZeroAddress);
      await expect(f.Feed.deploy(await halfEmpty.getAddress(), paxg, WINDOW, MIN_LIQ, ethers.ZeroAddress, 0, OBS_AGE, ""))
        .to.be.revertedWithCustomError(f.Feed, "ZeroAddress");
    });

    it("accepts windows of exactly 10 and 120 minutes, rejects anything outside and any window not divisible by six", async function () {
      const f = await loadFixture(fixture);
      const args = [await f.pool.getAddress(), await f.paxg.getAddress()] as const;
      await f.Feed.deploy(...args, 600, MIN_LIQ, ethers.ZeroAddress, 0, OBS_AGE, "");
      await f.Feed.deploy(...args, 7200, MIN_LIQ, ethers.ZeroAddress, 0, OBS_AGE, "");
      await expect(f.Feed.deploy(...args, 599, MIN_LIQ, ethers.ZeroAddress, 0, OBS_AGE, ""))
        .to.be.revertedWithCustomError(f.Feed, "WindowOutOfRange").withArgs(599);
      await expect(f.Feed.deploy(...args, 7201, MIN_LIQ, ethers.ZeroAddress, 0, OBS_AGE, ""))
        .to.be.revertedWithCustomError(f.Feed, "WindowOutOfRange").withArgs(7201);
      await expect(f.Feed.deploy(...args, 1801, MIN_LIQ, ethers.ZeroAddress, 0, OBS_AGE, ""))
        .to.be.revertedWithCustomError(f.Feed, "WindowNotDivisible").withArgs(1801);
    });

    it("bounds the observation age between 1 and 24 hours", async function () {
      const f = await loadFixture(fixture);
      const args = [await f.pool.getAddress(), await f.paxg.getAddress(), WINDOW, MIN_LIQ, ethers.ZeroAddress, 0] as const;
      await f.Feed.deploy(...args, 3600, "");
      await f.Feed.deploy(...args, DAY, "");
      await expect(f.Feed.deploy(...args, 3599, "")).to.be.revertedWithCustomError(f.Feed, "ObservationAgeOutOfRange").withArgs(3599);
      await expect(f.Feed.deploy(...args, DAY + 1, "")).to.be.revertedWithCustomError(f.Feed, "ObservationAgeOutOfRange").withArgs(DAY + 1);
    });

    it("rejects a zero liquidity floor and a base token that is not in the pool", async function () {
      const f = await loadFixture(fixture);
      const pool = await f.pool.getAddress();
      await expect(f.Feed.deploy(pool, await f.paxg.getAddress(), WINDOW, 0, ethers.ZeroAddress, 0, OBS_AGE, ""))
        .to.be.revertedWithCustomError(f.Feed, "ZeroMinLiquidity");
      const weth = await f.weth.getAddress();
      await expect(f.Feed.deploy(pool, weth, WINDOW, MIN_LIQ, ethers.ZeroAddress, 0, OBS_AGE, ""))
        .to.be.revertedWithCustomError(f.Feed, "BaseNotInPool").withArgs(weth);
    });

    it("rejects base or quote decimals above 18", async function () {
      const f = await loadFixture(fixture);
      const wide = await token(19);
      const usdc = await token(6);
      const PoolF = await ethers.getContractFactory("MockUniswapV3Pool");
      const p1 = await PoolF.deploy(await wide.getAddress(), await usdc.getAddress());
      await expect(f.Feed.deploy(await p1.getAddress(), await wide.getAddress(), WINDOW, MIN_LIQ, ethers.ZeroAddress, 0, OBS_AGE, ""))
        .to.be.revertedWithCustomError(f.Feed, "DecimalsOutOfRange").withArgs(await wide.getAddress(), 19);
      await expect(f.Feed.deploy(await p1.getAddress(), await usdc.getAddress(), WINDOW, MIN_LIQ, await f.ethUsd.getAddress(), DAY, OBS_AGE, ""))
        .to.be.revertedWithCustomError(f.Feed, "DecimalsOutOfRange").withArgs(await wide.getAddress(), 19);
    });

    it("pins the quote at 1 USD only for a 6 decimal quote with no age configured", async function () {
      const f = await loadFixture(fixture);
      await expect(f.Feed.deploy(await f.wethPool.getAddress(), await f.paxg.getAddress(), WINDOW, MIN_LIQ, ethers.ZeroAddress, 0, OBS_AGE, ""))
        .to.be.revertedWithCustomError(f.Feed, "UnpricedQuoteMustHaveSixDecimals").withArgs(18);
      await expect(f.Feed.deploy(await f.pool.getAddress(), await f.paxg.getAddress(), WINDOW, MIN_LIQ, ethers.ZeroAddress, DAY, OBS_AGE, ""))
        .to.be.revertedWithCustomError(f.Feed, "QuoteAgeWithoutFeed");
    });

    it("requires a quote feed with code, 8 decimals and an age between 1 second and 3 days", async function () {
      const f = await loadFixture(fixture);
      const args = [await f.wethPool.getAddress(), await f.paxg.getAddress(), WINDOW, MIN_LIQ] as const;
      await expect(f.Feed.deploy(...args, f.other.address, DAY, OBS_AGE, ""))
        .to.be.revertedWithCustomError(f.Feed, "NotAContract").withArgs(f.other.address);
      const wrong = await (await ethers.getContractFactory("MockSwitchableAggregatorV3")).deploy(18);
      await expect(f.Feed.deploy(...args, await wrong.getAddress(), DAY, OBS_AGE, ""))
        .to.be.revertedWithCustomError(f.Feed, "QuoteFeedDecimals").withArgs(18);
      const feed = await f.ethUsd.getAddress();
      await expect(f.Feed.deploy(...args, feed, 0, OBS_AGE, ""))
        .to.be.revertedWithCustomError(f.Feed, "QuoteAgeOutOfRange").withArgs(0);
      await expect(f.Feed.deploy(...args, feed, 3 * DAY + 1, OBS_AGE, ""))
        .to.be.revertedWithCustomError(f.Feed, "QuoteAgeOutOfRange").withArgs(3 * DAY + 1);
      await f.Feed.deploy(...args, feed, 3 * DAY, OBS_AGE, "");
    });
  });

  describe("reads", function () {
    it("prices PAXG against USDC at the Python reference, stamped with the current block", async function () {
      const f = await loadFixture(fixture);
      const [roundId, answer, startedAt, updatedAt, answeredInRound] = await f.usdcFeed.latestRoundData();
      const expected = 401217110502n;
      expect(answer).to.be.lte(expected);
      expect(answer).to.be.gte(expected - 1n);
      const now = BigInt(await time.latest());
      expect(roundId).to.equal(now);
      expect(answeredInRound).to.equal(now);
      expect(startedAt).to.equal(now);
      expect(updatedAt).to.equal(now);
      const [price, status] = await f.usdcFeed.readPrice();
      expect(price).to.equal(answer);
      expect(status).to.equal(Status.OK);
    });

    it("prices PAXG against WETH through the ETH/USD feed with PAXG as token1", async function () {
      const f = await loadFixture(fixture);
      const [, answer] = await f.wethFeed.latestRoundData();
      const expected = 399961421263n;
      expect(answer).to.be.lte(expected);
      expect(answer).to.be.gte(expected - 1n);
    });

    it("answers 0 when the pool reverts OLD, and recovers when the window fits", async function () {
      const f = await loadFixture(fixture);
      await f.pool.increaseObservationCardinalityNext(200);
      expect(await f.pool.observationCardinalityNext()).to.equal(200);
      await f.pool.increaseObservationCardinalityNext(100);
      expect(await f.pool.observationCardinalityNext()).to.equal(200);
      await f.pool.setRevertOld(true);
      expect((await f.usdcFeed.latestRoundData())[1]).to.equal(0);
      expect((await f.usdcFeed.readPrice())[1]).to.equal(Status.OBSERVE_FAILED);
      expect(await f.usdcFeed.liquidityUsd()).to.deep.equal([0n, BigInt(Status.OBSERVE_FAILED)]);
      await f.pool.setRevertOld(false);
      expect((await f.usdcFeed.readPrice())[1]).to.equal(Status.OK);
    });

    it("answers 0 for an observation of the wrong shape, with no liquidity movement or with liquidity above a uint128", async function () {
      const f = await loadFixture(fixture);
      const [ticks, liq] = raw([-193349, -193349, -193349, -193349, -193349, -193349], 10n ** 20n);
      await f.pool.setRawObservations(ticks.slice(0, 6), liq);
      expect(await f.usdcFeed.readPrice()).to.deep.equal([0n, BigInt(Status.BAD_OBSERVATION)]);
      await f.pool.setRawObservations(ticks, liq.slice(0, 6));
      expect(await f.usdcFeed.readPrice()).to.deep.equal([0n, BigInt(Status.BAD_OBSERVATION)]);
      await f.pool.setRawObservations(ticks, [5n, 5n, 5n, 5n, 5n, 5n, 5n]);
      expect(await f.usdcFeed.readPrice()).to.deep.equal([0n, BigInt(Status.BAD_OBSERVATION)]);
      // A change of one unit over the window means liquidity of window * 2^128, above any real pool.
      await f.pool.setRawObservations(ticks, [0n, 0n, 0n, 0n, 0n, 0n, 1n]);
      expect((await f.usdcFeed.observeWindow())[2]).to.equal(Status.BAD_OBSERVATION);
      await f.pool.clearRawObservations();
      expect((await f.usdcFeed.readPrice())[1]).to.equal(Status.OK);
    });

    it("answers 0 for a median tick beyond either end of the Uniswap range", async function () {
      const f = await loadFixture(fixture);
      const [up, liq] = raw([887273, 887273, 887273, 887273, 887273, 887273], 10n ** 20n);
      await f.pool.setRawObservations(up, liq);
      expect(await f.usdcFeed.observeWindow()).to.deep.equal([0n, 0n, BigInt(Status.TICK_OUT_OF_RANGE)]);
      const [down] = raw([-887273, -887273, -887273, -887273, -887273, -887273], 10n ** 20n);
      await f.pool.setRawObservations(down, liq);
      expect((await f.usdcFeed.readPrice())[1]).to.equal(Status.TICK_OUT_OF_RANGE);
    });

    it("floors each sub-window mean towards negative infinity and reports the median of the six", async function () {
      const f = await loadFixture(fixture);
      const quiet = -100;
      const [a, liq] = raw([quiet, quiet, quiet, quiet, quiet, quiet], 10n ** 20n, 1);
      await f.pool.setRawObservations(a, liq);
      expect((await f.usdcFeed.observeWindow())[0]).to.equal(quiet);
      const [b] = raw([quiet, quiet, quiet, quiet, quiet, quiet], 10n ** 20n, -1);
      await f.pool.setRawObservations(b, liq);
      // Only the last sub-window floors to -101; the median stays at -100.
      expect((await f.usdcFeed.observeWindow())[0]).to.equal(quiet);
      const [c] = raw([quiet, quiet, quiet, quiet, quiet, quiet], 10n ** 20n, -SUB);
      await f.pool.setRawObservations(c, liq);
      expect((await f.usdcFeed.observeWindow())[0]).to.equal(quiet);
      // Two pushed sub-windows out of six do not move the median; three move it half way.
      const [d] = raw([quiet, 50000, 50000, quiet, quiet, quiet], 10n ** 20n);
      await f.pool.setRawObservations(d, liq);
      expect((await f.usdcFeed.observeWindow())[0]).to.equal(quiet);
      const [e] = raw([50000, quiet, 50000, quiet, 50000, quiet], 10n ** 20n);
      await f.pool.setRawObservations(e, liq);
      expect((await f.usdcFeed.observeWindow())[0]).to.equal(Math.floor((quiet + 50000) / 2));
      // The floor mean of the two middle values rounds a negative odd sum down.
      const [g] = raw([-7, -4, -4, -3, 10, 20], 10n ** 20n);
      await f.pool.setRawObservations(g, liq);
      expect((await f.usdcFeed.observeWindow())[0]).to.equal(-4);
    });

    it("answers 0 below the harmonic liquidity floor and prices at exactly the floor", async function () {
      const f = await loadFixture(fixture);
      await f.pool.setLiquidity(MIN_LIQ - 1n);
      const thin = await f.usdcFeed.observeWindow();
      expect(thin[1]).to.equal(MIN_LIQ - 1n);
      expect(thin[2]).to.equal(Status.THIN_LIQUIDITY);
      expect((await f.usdcFeed.latestRoundData())[1]).to.equal(0);
      expect(await f.usdcFeed.liquidityUsd()).to.deep.equal([0n, BigInt(Status.THIN_LIQUIDITY)]);
      await f.pool.setLiquidity(MIN_LIQ);
      expect((await f.usdcFeed.observeWindow())[1]).to.equal(MIN_LIQ);
      expect((await f.usdcFeed.readPrice())[1]).to.equal(Status.OK);
    });

    it("answers 0 for every invalid quote feed state", async function () {
      const f = await loadFixture(fixture);
      const now = BigInt(await time.latest());
      const cases: Array<[string, bigint, bigint, bigint, bigint, Status]> = [
        ["zero answer", 6n, 0n, now, 6n, Status.QUOTE_INVALID],
        ["negative answer", 6n, -1n, now, 6n, Status.QUOTE_INVALID],
        ["absurd answer", 6n, 10n ** 20n + 1n, now, 6n, Status.QUOTE_INVALID],
        ["updatedAt zero", 6n, 3000n * 10n ** 8n, 0n, 6n, Status.QUOTE_INVALID],
        ["answeredInRound below roundId", 6n, 3000n * 10n ** 8n, now, 5n, Status.QUOTE_INVALID],
        ["future stamp", 6n, 3000n * 10n ** 8n, now + 100n, 6n, Status.QUOTE_INVALID],
        ["older than maxQuoteAge", 6n, 3000n * 10n ** 8n, now - BigInt(DAY) - 1n, 6n, Status.QUOTE_STALE],
      ];
      for (const [name, round, answer, updatedAt, answered, status] of cases) {
        await f.ethUsd.setRound(round, answer, updatedAt, answered);
        expect(await f.wethFeed.quotePriceUsd(), name).to.deep.equal([0n, BigInt(status)]);
        expect((await f.wethFeed.latestRoundData())[1], name).to.equal(0);
        expect((await f.wethFeed.liquidityUsd())[1], name).to.equal(status);
      }
      // Just inside maxQuoteAge; each mined transaction moves the clock, so leave a few seconds.
      await f.ethUsd.setRound(6, 3000n * 10n ** 8n, BigInt(await time.latest()) - BigInt(DAY) + 5n, 6);
      expect((await f.wethFeed.quotePriceUsd())[1]).to.equal(Status.OK);
      await f.ethUsd.setReverting(true);
      expect(await f.wethFeed.quotePriceUsd()).to.deep.equal([0n, BigInt(Status.QUOTE_FEED_FAILED)]);
      expect(await f.wethFeed.readPrice()).to.deep.equal([0n, BigInt(Status.QUOTE_FEED_FAILED)]);
    });

    it("returns exactly 1 USD for an unpriced stablecoin quote", async function () {
      const f = await loadFixture(fixture);
      expect(await f.usdcFeed.quotePriceUsd()).to.deep.equal([10n ** 8n, BigInt(Status.OK)]);
    });
  });

  describe("observation freshness", function () {
    it("reports the age of the latest observation and answers 0 once it passes maxObservationAge", async function () {
      const f = await loadFixture(fixture);
      const fresh = await f.usdcFeed.lastObservationAge();
      expect(fresh[0]).to.equal(0);
      expect(fresh[1]).to.equal(Status.OK);
      const now = await time.latest();
      await f.pool.setLastObservation(now - OBS_AGE + 10, true);
      expect((await f.usdcFeed.lastObservationAge())[1]).to.equal(Status.OK);
      expect((await f.usdcFeed.readPrice())[1]).to.equal(Status.OK);
      await f.pool.setLastObservation(now - OBS_AGE - 10, true);
      const stale = await f.usdcFeed.lastObservationAge();
      expect(stale[0]).to.be.gte(OBS_AGE + 10);
      expect(stale[1]).to.equal(Status.NO_RECENT_SWAPS);
      expect((await f.usdcFeed.latestRoundData())[1]).to.equal(0);
      expect(await f.usdcFeed.readPrice()).to.deep.equal([0n, BigInt(Status.NO_RECENT_SWAPS)]);
      expect(await f.usdcFeed.liquidityUsd()).to.deep.equal([0n, BigInt(Status.NO_RECENT_SWAPS)]);
    });

    it("treats an uninitialised observation or a pool that cannot be read as an observation failure", async function () {
      const f = await loadFixture(fixture);
      await f.pool.setLastObservation(await time.latest(), false);
      expect(await f.usdcFeed.lastObservationAge()).to.deep.equal([0n, BigInt(Status.OBSERVE_FAILED)]);
      await f.pool.setLastObservation(0, true);
      await f.pool.setRevertObservations(true);
      expect(await f.usdcFeed.lastObservationAge()).to.deep.equal([0n, BigInt(Status.OBSERVE_FAILED)]);
      expect((await f.usdcFeed.readPrice())[1]).to.equal(Status.OBSERVE_FAILED);
      await f.pool.setRevertObservations(false);
      await f.pool.setRevertSlot0(true);
      expect(await f.usdcFeed.lastObservationAge()).to.deep.equal([0n, BigInt(Status.OBSERVE_FAILED)]);
      await f.pool.setRevertSlot0(false);
      await f.pool.setObservationIndex(17);
      expect((await f.usdcFeed.lastObservationAge())[1]).to.equal(Status.OK);
    });
  });

  describe("liquidityUsd", function () {
    it("values the virtual reserves at the Python reference for both token orders", async function () {
      const f = await loadFixture(fixture);
      // PAXG/USDC with liquidity 1e20 at tick -193349: 2 * L * sqrt(P) USDC, reference 12668340230708905354584110200.
      const [usd18, status] = await f.usdcFeed.liquidityUsd();
      expect(status).to.equal(Status.OK);
      const expected = 12668340230708905354584110200n;
      expect(usd18).to.be.lte(expected);
      expect(usd18).to.be.gte(expected - 2n * 10n ** 12n - 1n);
      // PAXG as token1 against WETH at $3000 with liquidity 5e20: reference 3463934560279295295723986.
      const [viaWeth] = await f.wethFeed.liquidityValueAtTick(-2876, 5n * 10n ** 20n, 3000n * 10n ** 8n);
      expect(viaWeth).to.be.lte(3463934560279295295723986n);
      expect(viaWeth).to.be.gte(3463934560279295295723986n - 2n * 3000n * 10n ** 8n - 1n);
      // Tick zero and an 18 decimal quote at $1: exactly 2 * L.
      expect((await f.wethFeed.liquidityValueAtTick(0, 10n ** 24n, 10n ** 8n))[0]).to.equal(2n * 10n ** 24n);
    });

    it("rejects out of range ticks, bad quote prices, zero or oversized liquidity and vanishing or absurd values", async function () {
      const f = await loadFixture(fixture);
      expect(await f.usdcFeed.liquidityValueAtTick(887273, 10n ** 18n, 10n ** 8n)).to.deep.equal([0n, BigInt(Status.TICK_OUT_OF_RANGE)]);
      expect(await f.usdcFeed.liquidityValueAtTick(-887273, 10n ** 18n, 10n ** 8n)).to.deep.equal([0n, BigInt(Status.TICK_OUT_OF_RANGE)]);
      expect(await f.usdcFeed.liquidityValueAtTick(0, 10n ** 18n, 0)).to.deep.equal([0n, BigInt(Status.QUOTE_INVALID)]);
      expect(await f.usdcFeed.liquidityValueAtTick(0, 10n ** 18n, 10n ** 20n + 1n)).to.deep.equal([0n, BigInt(Status.QUOTE_INVALID)]);
      expect(await f.usdcFeed.liquidityValueAtTick(0, 0, 10n ** 8n)).to.deep.equal([0n, BigInt(Status.BAD_OBSERVATION)]);
      expect(await f.usdcFeed.liquidityValueAtTick(0, Q128, 10n ** 8n)).to.deep.equal([0n, BigInt(Status.BAD_OBSERVATION)]);
      expect(await f.usdcFeed.liquidityValueAtTick(-887272, 1, 10n ** 8n)).to.deep.equal([0n, BigInt(Status.PRICE_OUT_OF_RANGE)]);
      // L / sqrt(P) with PAXG as token1 and the full liquidity range: the quote side passes 1e40.
      expect(await f.wethFeed.liquidityValueAtTick(-887272, Q128 - 1n, 10n ** 8n)).to.deep.equal([0n, BigInt(Status.PRICE_OUT_OF_RANGE)]);
      // Within 1e40 of quote units but above the 100 trillion dollar ceiling.
      expect(await f.usdcFeed.liquidityValueAtTick(0, 10n ** 27n, 10n ** 8n)).to.deep.equal([0n, BigInt(Status.PRICE_OUT_OF_RANGE)]);
    });
  });

  describe("priceAtTick", function () {
    it("rejects ticks outside the range and quote prices of zero or above the ceiling", async function () {
      const f = await loadFixture(fixture);
      expect(await f.usdcFeed.priceAtTick(887273, 10n ** 8n)).to.deep.equal([0n, BigInt(Status.TICK_OUT_OF_RANGE)]);
      expect(await f.usdcFeed.priceAtTick(-887273, 10n ** 8n)).to.deep.equal([0n, BigInt(Status.TICK_OUT_OF_RANGE)]);
      expect(await f.usdcFeed.priceAtTick(0, 0)).to.deep.equal([0n, BigInt(Status.QUOTE_INVALID)]);
      expect(await f.usdcFeed.priceAtTick(0, 10n ** 20n + 1n)).to.deep.equal([0n, BigInt(Status.QUOTE_INVALID)]);
    });

    it("reports absurdly high and vanishing prices as out of range, never as a number", async function () {
      const f = await loadFixture(fixture);
      expect(await f.usdcFeed.priceAtTick(887272, 10n ** 8n)).to.deep.equal([0n, BigInt(Status.PRICE_OUT_OF_RANGE)]);
      expect(await f.usdcFeed.priceAtTick(300000, 10n ** 8n)).to.deep.equal([0n, BigInt(Status.PRICE_OUT_OF_RANGE)]);
      expect(await f.usdcFeed.priceAtTick(-887272, 10n ** 8n)).to.deep.equal([0n, BigInt(Status.PRICE_OUT_OF_RANGE)]);
    });

    it("flips the tick for a token1 base so both orders give the same price", async function () {
      const f = await loadFixture(fixture);
      const [a] = await f.wethFeed.priceAtTick(-2876, 3000n * 10n ** 8n);
      expect(a).to.be.lte(399961421263n);
      expect(a).to.be.gte(399961421262n);
    });

    it("reads within a modest gas budget", async function () {
      const f = await loadFixture(fixture);
      const gas = await ethers.provider.estimateGas({
        to: await f.wethFeed.getAddress(),
        data: f.wethFeed.interface.encodeFunctionData("latestRoundData"),
      });
      // solidity-coverage instruments the bytecode, so the budget holds only on normal bytecode.
      const coverageRun = (hre as unknown as { __SOLIDITY_COVERAGE_RUNNING?: boolean }).__SOLIDITY_COVERAGE_RUNNING === true;
      if (!coverageRun) expect(gas).to.be.lt(120_000n);
    });
  });

  describe("TickPower", function () {
    async function harness() {
      return (await ethers.getContractFactory("TickPowerHarness")).deploy();
    }

    it("returns exactly 1.0 at tick 0 and the rounded base constant at tick 1", async function () {
      const h = await loadFixture(harness);
      expect(await h.pow(0)).to.deep.equal([1n << 127n, -127n]);
      expect(await h.pow(1)).to.deep.equal([170158197578815278654860472446255694139n, -127n]);
    });

    it("matches the Python references at both ends of the tick range", async function () {
      const h = await loadFixture(harness);
      const close = (got: readonly [bigint, bigint], m: bigint, e: bigint) => {
        expect(got[1]).to.equal(e);
        const diff = got[0] > m ? got[0] - m : m - got[0];
        expect(diff * 10n ** 30n).to.be.lte(m);
      };
      close(await h.pow(887272), 340256786836388094050805785052946541066n, 0n);
      close(await h.pow(-887272), 170153974464283981435225617938057077700n, -255n);
      close(await h.pow(-193670), 177455154174258678848873436432571966810n, -155n);
    });

    it("renormalises the reciprocal of an exact power of two", async function () {
      const h = await loadFixture(harness);
      expect(await h.reciprocal(1n << 127n, -130)).to.deep.equal([1n << 127n, -124n]);
      expect(await h.reciprocal((1n << 128n) - 1n, -127)).to.deep.equal([1n << 127n, -128n]);
    });

    it("multiplies with either normalisation shift", async function () {
      const h = await loadFixture(harness);
      expect(await h.multiply(1n << 127n, -127, 1n << 127n, -127)).to.deep.equal([1n << 127n, -127n]);
      expect(await h.multiply((1n << 128n) - 1n, -127, (1n << 128n) - 1n, -127)).to.deep.equal([
        ((((1n << 128n) - 1n) ** 2n) >> 128n),
        -126n,
      ]);
    });

    it("reverts outside the Uniswap tick range", async function () {
      const h = await loadFixture(harness);
      await expect(h.pow(887273)).to.be.revertedWithCustomError(h, "TickOutOfRange").withArgs(887273);
      await expect(h.pow(-887273)).to.be.revertedWithCustomError(h, "TickOutOfRange").withArgs(-887273);
    });
  });
});
