import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import {
  deployMarketFeeds,
  feedsSnapshotName,
  MarketFeedSpec,
  MarketFeedsSnapshot,
  parseFeedsSnapshot,
  parseMarketFeedSpecs,
  pythStatusName,
  readPythFeed,
  readTwapFeed,
  requiredCardinality,
  specDifferences,
  twapStatusName,
} from "../scripts/lib/marketFeeds";

/**
 * Launch ceremony step one (scripts/deploy-market-feeds.ts, through scripts/lib/marketFeeds.ts):
 * the environment it reads, the adapters it deploys against MockUniswapV3Pool, the pool
 * cardinality it raises and the idempotence of a rerun.
 */
describe("Market feed deployment (scripts/deploy-market-feeds.ts)", function () {
  const WINDOW = 1800;

  async function fixture() {
    const [signer, other] = await ethers.getSigners();
    const Token = await ethers.getContractFactory("MockERC20");
    const paxg = await Token.deploy("Paxos Gold", "PAXG", 18);
    const xaut = await Token.deploy("Tether Gold", "XAUt", 6);
    const usdc = await Token.deploy("USD Coin", "USDC", 6);
    const weth = await Token.deploy("Wrapped Ether", "WETH", 18);
    const Pool = await ethers.getContractFactory("MockUniswapV3Pool");
    const paxgUsdc = await Pool.deploy(await paxg.getAddress(), await usdc.getAddress());
    const xautWeth = await Pool.deploy(await xaut.getAddress(), await weth.getAddress());
    for (const pool of [paxgUsdc, xautWeth]) await pool.setLiquidity(10n ** 24n);
    await paxgUsdc.setTick(-193_349);
    const ethUsd = await (await ethers.getContractFactory("MockChainlinkFeed")).deploy(8, "ETH / USD");
    const pyth = await (await ethers.getContractFactory("MockPyth")).deploy();
    const priceId = ethers.keccak256(ethers.toUtf8Bytes("XAUT/USD"));
    const env: NodeJS.ProcessEnv = {
      MARKET_FEEDS: "PAXG_USDC_TWAP, XAUT_WETH_TWAP, XAUT_PYTH",
      XAUT_PYTH_PYTH: await pyth.getAddress(),
      XAUT_PYTH_PRICE_ID: priceId,
      XAUT_PYTH_MAX_AGE: "60",
      XAUT_PYTH_MAX_CONFIDENCE_PPM: "5000",
      XAUT_PYTH_DESCRIPTION: "XAUT / USD (Pyth)",
      PAXG_USDC_TWAP_POOL: await paxgUsdc.getAddress(),
      PAXG_USDC_TWAP_BASE_TOKEN: await paxg.getAddress(),
      PAXG_USDC_TWAP_WINDOW: String(WINDOW),
      PAXG_USDC_TWAP_MIN_LIQUIDITY: "1000000000000000",
      PAXG_USDC_TWAP_MAX_OBSERVATION_AGE: "21600",
      PAXG_USDC_TWAP_DESCRIPTION: "PAXG / USD (Uniswap v3 TWAP, USDC)",
      XAUT_WETH_TWAP_POOL: await xautWeth.getAddress(),
      XAUT_WETH_TWAP_BASE_TOKEN: await xaut.getAddress(),
      XAUT_WETH_TWAP_WINDOW: "3600",
      XAUT_WETH_TWAP_MIN_LIQUIDITY: "1000000000000000",
      XAUT_WETH_TWAP_QUOTE_USD_FEED: await ethUsd.getAddress(),
      XAUT_WETH_TWAP_MAX_QUOTE_AGE: "3600",
      XAUT_WETH_TWAP_MAX_OBSERVATION_AGE: "3600",
      XAUT_WETH_TWAP_DESCRIPTION: "XAUT / USD (Uniswap v3 TWAP, WETH)",
    };
    const factories = {
      twap: await ethers.getContractFactory("UniswapV3TwapFeed", signer),
      pyth: await ethers.getContractFactory("PythMarketFeed", signer),
    };
    return { signer, other, paxg, xaut, usdc, weth, paxgUsdc, xautWeth, ethUsd, pyth, priceId, env, factories };
  }

  function specsOf(env: NodeJS.ProcessEnv): MarketFeedSpec[] {
    const { specs, findings } = parseMarketFeedSpecs(env);
    if (!specs) throw new Error(findings.map((f) => `${f.name}: ${f.detail}`).join("\n"));
    return specs;
  }

  async function run(f: Awaited<ReturnType<typeof fixture>>, env: NodeJS.ProcessEnv, existing?: MarketFeedsSnapshot) {
    const saved: MarketFeedsSnapshot[] = [];
    const result = await deployMarketFeeds({
      specs: specsOf(env),
      signer: f.signer,
      factories: f.factories,
      chainId: 31337,
      network: "hardhat",
      existing,
      save: (snapshot) => saved.push(JSON.parse(JSON.stringify(snapshot)) as MarketFeedsSnapshot),
      now: () => "2026-10-28T00:00:00.000Z",
    });
    return { result, saved };
  }

  describe("parseMarketFeedSpecs", function () {
    it("reads every adapter block, trimming the name list", async function () {
      const f = await loadFixture(fixture);
      const specs = specsOf(f.env);
      expect(specs.map((s) => s.name)).to.deep.equal(["PAXG_USDC_TWAP", "XAUT_WETH_TWAP", "XAUT_PYTH"]);
      expect(specs.map((s) => s.kind)).to.deep.equal(["TWAP", "TWAP", "PYTH"]);
      const [first, second, third] = specs;
      if (first.kind !== "TWAP" || second.kind !== "TWAP" || third.kind !== "PYTH") throw new Error("kinds");
      expect(first.quoteUsdFeed).to.equal("");
      expect(first.maxQuoteAge).to.equal(0);
      expect(second.quoteUsdFeed).to.equal(await f.ethUsd.getAddress());
      expect(second.maxQuoteAge).to.equal(3600);
      expect(second.minHarmonicLiquidity).to.equal(10n ** 15n);
      expect(first.maxObservationAge).to.equal(21600);
      expect(third.pyth).to.equal(await f.pyth.getAddress());
      expect(third.priceId).to.equal(f.priceId);
      expect(third.maxAgeSeconds).to.equal(60);
      expect(third.maxConfidencePpm).to.equal(5000);
    });

    it("refuses a missing list, a bad or repeated name and every unusable value, naming each variable", async function () {
      const f = await loadFixture(fixture);
      const failing = (overrides: NodeJS.ProcessEnv): string[] =>
        parseMarketFeedSpecs({ ...f.env, ...overrides }).findings.filter((x) => x.verdict === "fail").map((x) => x.name);
      expect(failing({ MARKET_FEEDS: " " })).to.deep.equal(["env:MARKET_FEEDS"]);
      expect(failing({ MARKET_FEEDS: "paxg-twap" })).to.deep.equal(["env:MARKET_FEEDS"]);
      expect(failing({ MARKET_FEEDS: "PAXG_USDC_TWAP,PAXG_USDC_TWAP" })).to.deep.equal(["env:MARKET_FEEDS"]);
      expect(failing({ PAXG_USDC_TWAP_WINDOW: "599" })).to.deep.equal(["env:PAXG_USDC_TWAP_WINDOW"]);
      expect(failing({ PAXG_USDC_TWAP_WINDOW: "7201" })).to.deep.equal(["env:PAXG_USDC_TWAP_WINDOW"]);
      expect(failing({ PAXG_USDC_TWAP_WINDOW: "1801" })).to.deep.equal(["env:PAXG_USDC_TWAP_WINDOW"]);
      expect(failing({ PAXG_USDC_TWAP_MAX_OBSERVATION_AGE: undefined })).to.deep.equal(["env:PAXG_USDC_TWAP_MAX_OBSERVATION_AGE"]);
      expect(failing({ PAXG_USDC_TWAP_MAX_OBSERVATION_AGE: "3599" })).to.deep.equal(["env:PAXG_USDC_TWAP_MAX_OBSERVATION_AGE"]);
      expect(failing({ PAXG_USDC_TWAP_MAX_OBSERVATION_AGE: "86401" })).to.deep.equal(["env:PAXG_USDC_TWAP_MAX_OBSERVATION_AGE"]);
      expect(failing({ PAXG_USDC_TWAP_MIN_LIQUIDITY: "0" })).to.deep.equal(["env:PAXG_USDC_TWAP_MIN_LIQUIDITY"]);
      expect(failing({ PAXG_USDC_TWAP_MIN_LIQUIDITY: "1e15" })).to.deep.equal(["env:PAXG_USDC_TWAP_MIN_LIQUIDITY"]);
      expect(failing({ PAXG_USDC_TWAP_POOL: ethers.ZeroAddress })).to.deep.equal(["env:PAXG_USDC_TWAP_POOL"]);
      expect(failing({ PAXG_USDC_TWAP_BASE_TOKEN: undefined })).to.deep.equal(["env:PAXG_USDC_TWAP_BASE_TOKEN"]);
      expect(failing({ PAXG_USDC_TWAP_DESCRIPTION: " " })).to.deep.equal(["env:PAXG_USDC_TWAP_DESCRIPTION"]);
      expect(failing({ PAXG_USDC_TWAP_MAX_QUOTE_AGE: "60" })).to.deep.equal(["env:PAXG_USDC_TWAP_MAX_QUOTE_AGE"]);
      expect(failing({ XAUT_WETH_TWAP_MAX_QUOTE_AGE: undefined })).to.deep.equal(["env:XAUT_WETH_TWAP_MAX_QUOTE_AGE"]);
      expect(failing({ XAUT_WETH_TWAP_MAX_QUOTE_AGE: "259201" })).to.deep.equal(["env:XAUT_WETH_TWAP_MAX_QUOTE_AGE"]);
      expect(failing({ XAUT_WETH_TWAP_QUOTE_USD_FEED: "0xabc" })).to.deep.equal(["env:XAUT_WETH_TWAP_QUOTE_USD_FEED"]);
      expect(parseMarketFeedSpecs({ ...f.env, PAXG_USDC_TWAP_WINDOW: "10" }).specs).to.equal(undefined);
    });

    it("refuses every unusable Pyth value and a block that names both a pool and a Pyth contract", async function () {
      const f = await loadFixture(fixture);
      const failing = (overrides: NodeJS.ProcessEnv): string[] =>
        parseMarketFeedSpecs({ ...f.env, ...overrides }).findings.filter((x) => x.verdict === "fail").map((x) => x.name);
      expect(failing({ XAUT_PYTH_PYTH: ethers.ZeroAddress })).to.deep.equal(["env:XAUT_PYTH_PYTH"]);
      expect(failing({ XAUT_PYTH_PRICE_ID: undefined })).to.deep.equal(["env:XAUT_PYTH_PRICE_ID"]);
      expect(failing({ XAUT_PYTH_PRICE_ID: "0x1234" })).to.deep.equal(["env:XAUT_PYTH_PRICE_ID"]);
      expect(failing({ XAUT_PYTH_PRICE_ID: ethers.ZeroHash })).to.deep.equal(["env:XAUT_PYTH_PRICE_ID"]);
      expect(failing({ XAUT_PYTH_MAX_AGE: "9" })).to.deep.equal(["env:XAUT_PYTH_MAX_AGE"]);
      expect(failing({ XAUT_PYTH_MAX_AGE: "3601" })).to.deep.equal(["env:XAUT_PYTH_MAX_AGE"]);
      expect(failing({ XAUT_PYTH_MAX_CONFIDENCE_PPM: "0" })).to.deep.equal(["env:XAUT_PYTH_MAX_CONFIDENCE_PPM"]);
      expect(failing({ XAUT_PYTH_MAX_CONFIDENCE_PPM: "50001" })).to.deep.equal(["env:XAUT_PYTH_MAX_CONFIDENCE_PPM"]);
      expect(failing({ XAUT_PYTH_DESCRIPTION: "" })).to.deep.equal(["env:XAUT_PYTH_DESCRIPTION"]);
      expect(failing({ XAUT_PYTH_POOL: f.env.PAXG_USDC_TWAP_POOL })).to.include("env:XAUT_PYTH");
      // A Pyth price id is stored lower case so the snapshot comparison is case free.
      const upper = parseMarketFeedSpecs({ ...f.env, XAUT_PYTH_PRICE_ID: f.priceId.toUpperCase().replace("0X", "0x") }).specs;
      expect(upper?.[2].kind === "PYTH" && upper[2].priceId).to.equal(f.priceId.toLowerCase());
    });
  });

  it("sizes the cardinality at one slot per 12 s block over the window plus a margin of 50", function () {
    expect(requiredCardinality(600)).to.equal(100);
    expect(requiredCardinality(1800)).to.equal(200);
    expect(requiredCardinality(1801)).to.equal(201);
    expect(requiredCardinality(7200)).to.equal(650);
  });

  describe("deployMarketFeeds", function () {
    it("deploys each adapter, raises each short pool and records everything", async function () {
      const f = await loadFixture(fixture);
      const { result, saved } = await run(f, f.env);
      expect(result.deployed).to.deep.equal(["PAXG_USDC_TWAP", "XAUT_WETH_TWAP", "XAUT_PYTH"]);
      expect(result.reused).to.deep.equal([]);
      expect(result.raised).to.deep.equal([
        { pool: await f.paxgUsdc.getAddress(), from: 1, to: 200 },
        { pool: await f.xautWeth.getAddress(), from: 1, to: 350 },
      ]);
      expect(await f.paxgUsdc.observationCardinalityNext()).to.equal(200);
      expect(await f.xautWeth.observationCardinalityNext()).to.equal(350);

      const recorded = result.snapshot.feeds.PAXG_USDC_TWAP;
      const adapter = await ethers.getContractAt("UniswapV3TwapFeed", recorded.address);
      expect(await adapter.pool()).to.equal(await f.paxgUsdc.getAddress());
      expect(await adapter.baseToken()).to.equal(await f.paxg.getAddress());
      expect(await adapter.windowSeconds()).to.equal(WINDOW);
      expect(await adapter.description()).to.equal("PAXG / USD (Uniswap v3 TWAP, USDC)");
      const weth = await ethers.getContractAt("UniswapV3TwapFeed", result.snapshot.feeds.XAUT_WETH_TWAP.address);
      expect(await weth.quoteUsdFeed()).to.equal(await f.ethUsd.getAddress());
      expect(await weth.maxQuoteAge()).to.equal(3600);
      expect(await adapter.maxObservationAge()).to.equal(21600);
      expect(recorded.maxObservationAge).to.equal(21600);
      expect(recorded.cardinalityNext).to.equal(200);
      expect(recorded.requiredCardinality).to.equal(200);
      expect(recorded.kind).to.equal("TWAP");

      const pythRecord = result.snapshot.feeds.XAUT_PYTH;
      expect(pythRecord.kind).to.equal("PYTH");
      expect(pythRecord.cardinalityNext).to.equal(undefined);
      const pythFeed = await ethers.getContractAt("PythMarketFeed", pythRecord.address);
      expect(await pythFeed.pyth()).to.equal(await f.pyth.getAddress());
      expect(await pythFeed.priceId()).to.equal(f.priceId);
      expect(await pythFeed.maxAgeSeconds()).to.equal(60);
      expect(await pythFeed.maxConfidencePpm()).to.equal(5000);
      expect(await pythFeed.description()).to.equal("XAUT / USD (Pyth)");

      // Saved after each deployment and once at the end, so a crash midway loses nothing.
      expect(saved).to.have.length(4);
      expect(Object.keys(saved[0].feeds)).to.deep.equal(["PAXG_USDC_TWAP"]);
      const roundTrip = parseFeedsSnapshot(JSON.stringify(saved[2]));
      expect(roundTrip.feeds.XAUT_WETH_TWAP.address).to.equal(result.snapshot.feeds.XAUT_WETH_TWAP.address);
      expect(feedsSnapshotName("mainnet")).to.equal("mainnet-feeds.json");
    });

    it("is idempotent: a rerun reuses every adapter and sends nothing", async function () {
      const f = await loadFixture(fixture);
      const first = await run(f, f.env);
      const nonce = await ethers.provider.getTransactionCount(f.signer.address);
      const second = await run(f, f.env, first.result.snapshot);
      expect(second.result.deployed).to.deep.equal([]);
      expect(second.result.reused).to.deep.equal(["PAXG_USDC_TWAP", "XAUT_WETH_TWAP", "XAUT_PYTH"]);
      expect(second.result.raised).to.deep.equal([]);
      expect(await ethers.provider.getTransactionCount(f.signer.address)).to.equal(nonce);
      expect(second.result.snapshot.feeds.PAXG_USDC_TWAP.address).to.equal(first.result.snapshot.feeds.PAXG_USDC_TWAP.address);
    });

    it("deploys only the adapter added since the last run", async function () {
      const f = await loadFixture(fixture);
      const onlyPaxg = { ...f.env, MARKET_FEEDS: "PAXG_USDC_TWAP" };
      const first = await run(f, onlyPaxg);
      const second = await run(f, f.env, first.result.snapshot);
      expect(second.result.reused).to.deep.equal(["PAXG_USDC_TWAP"]);
      expect(second.result.deployed).to.deep.equal(["XAUT_WETH_TWAP", "XAUT_PYTH"]);
    });

    it("leaves a pool alone when its cardinality already covers the window, and sizes a shared pool for its longest window", async function () {
      const f = await loadFixture(fixture);
      await f.paxgUsdc.increaseObservationCardinalityNext(500);
      const shared = {
        ...f.env,
        MARKET_FEEDS: "PAXG_SHORT,PAXG_LONG",
        PAXG_SHORT_POOL: f.env.PAXG_USDC_TWAP_POOL,
        PAXG_SHORT_BASE_TOKEN: f.env.PAXG_USDC_TWAP_BASE_TOKEN,
        PAXG_SHORT_WINDOW: "600",
        PAXG_SHORT_MIN_LIQUIDITY: "1",
        PAXG_SHORT_MAX_OBSERVATION_AGE: "3600",
        PAXG_SHORT_DESCRIPTION: "short",
        PAXG_LONG_POOL: f.env.PAXG_USDC_TWAP_POOL,
        PAXG_LONG_BASE_TOKEN: f.env.PAXG_USDC_TWAP_BASE_TOKEN,
        PAXG_LONG_WINDOW: "7200",
        PAXG_LONG_MIN_LIQUIDITY: "1",
        PAXG_LONG_MAX_OBSERVATION_AGE: "3600",
        PAXG_LONG_DESCRIPTION: "long",
      };
      const { result } = await run(f, shared);
      expect(result.raised).to.deep.equal([{ pool: await f.paxgUsdc.getAddress(), from: 500, to: 650 }]);
      const covered = await run(f, { ...f.env, MARKET_FEEDS: "PAXG_USDC_TWAP" });
      expect(covered.result.raised).to.deep.equal([]);
    });

    it("refuses before any transaction: changed parameters, a recorded address with no code and another chain's snapshot", async function () {
      const f = await loadFixture(fixture);
      const first = await run(f, f.env);
      const nonce = await ethers.provider.getTransactionCount(f.signer.address);
      await expect(run(f, { ...f.env, PAXG_USDC_TWAP_WINDOW: "3600" }, first.result.snapshot)).to.be.rejectedWith("PAXG_USDC_TWAP_WINDOW");
      const ghost = {
        ...first.result.snapshot,
        feeds: { ...first.result.snapshot.feeds, PAXG_USDC_TWAP: { ...first.result.snapshot.feeds.PAXG_USDC_TWAP, address: f.other.address } },
      };
      await expect(run(f, f.env, ghost)).to.be.rejectedWith("has no code on this chain");
      await expect(run(f, f.env, { ...first.result.snapshot, chainId: 1 })).to.be.rejectedWith("chain 1");
      await expect(run(f, { ...f.env, XAUT_PYTH_MAX_AGE: "120" }, first.result.snapshot)).to.be.rejectedWith("XAUT_PYTH_MAX_AGE");
      // A name recorded as one kind and now given the other kind is refused by kind, not by field.
      const swapped = { ...f.env, XAUT_PYTH_PYTH: undefined, XAUT_PYTH_POOL: f.env.PAXG_USDC_TWAP_POOL, XAUT_PYTH_BASE_TOKEN: f.env.PAXG_USDC_TWAP_BASE_TOKEN, XAUT_PYTH_WINDOW: "1800", XAUT_PYTH_MIN_LIQUIDITY: "1", XAUT_PYTH_MAX_OBSERVATION_AGE: "3600" };
      await expect(run(f, swapped, first.result.snapshot)).to.be.rejectedWith("kind (PYTH recorded, TWAP now)");
      // A snapshot written before kinds existed reads as TWAP.
      const { kind: _dropped, ...legacy } = first.result.snapshot.feeds.PAXG_USDC_TWAP;
      void _dropped;
      const legacySnapshot = { ...first.result.snapshot, feeds: { PAXG_USDC_TWAP: legacy } };
      const reused = await run(f, { ...f.env, MARKET_FEEDS: "PAXG_USDC_TWAP" }, legacySnapshot);
      expect(reused.result.reused).to.deep.equal(["PAXG_USDC_TWAP"]);
      expect(await ethers.provider.getTransactionCount(f.signer.address)).to.equal(nonce);
    });

    it("refuses a pool without code, a base token outside the pool and a quote feed that is not 8 decimals", async function () {
      const f = await loadFixture(fixture);
      const wide = await (await ethers.getContractFactory("MockChainlinkFeed")).deploy(18, "ETH / USD");
      const nonce = await ethers.provider.getTransactionCount(f.signer.address);
      await expect(run(f, { ...f.env, PAXG_USDC_TWAP_POOL: f.other.address })).to.be.rejectedWith("has no code");
      await expect(run(f, { ...f.env, PAXG_USDC_TWAP_BASE_TOKEN: await f.xaut.getAddress() })).to.be.rejectedWith("is neither token of pool");
      await expect(run(f, { ...f.env, XAUT_WETH_TWAP_QUOTE_USD_FEED: await wide.getAddress() })).to.be.rejectedWith("is not an 8 decimal feed");
      await expect(run(f, { ...f.env, XAUT_WETH_TWAP_QUOTE_USD_FEED: f.other.address })).to.be.rejectedWith("QUOTE_USD_FEED");
      await expect(run(f, { ...f.env, PAXG_USDC_TWAP_POOL: await f.usdc.getAddress() })).to.be.rejectedWith("does not answer as a Uniswap v3 pool");
      await expect(run(f, { ...f.env, XAUT_PYTH_PYTH: f.other.address })).to.be.rejectedWith(/XAUT_PYTH_PYTH .* has no code/);
      await expect(run(f, { ...f.env, XAUT_PYTH_PYTH: await f.usdc.getAddress() })).to.be.rejectedWith("does not answer getUpdateFee");
      expect(await ethers.provider.getTransactionCount(f.signer.address)).to.equal(nonce);
    });

    it("refuses a Pyth block on mainnet before any transaction, and deploys TWAP blocks there as usual", async function () {
      const f = await loadFixture(fixture);
      const nonce = await ethers.provider.getTransactionCount(f.signer.address);
      const onMainnet = (env: NodeJS.ProcessEnv) =>
        deployMarketFeeds({ specs: specsOf(env), signer: f.signer, factories: f.factories, chainId: 1, network: "mainnet", save: () => undefined });
      await expect(onMainnet(f.env)).to.be.rejectedWith("XAUT_PYTH is a PythMarketFeed block; Pyth is outside the production path");
      expect(await ethers.provider.getTransactionCount(f.signer.address)).to.equal(nonce);
      const twapOnly = await onMainnet({ ...f.env, MARKET_FEEDS: "PAXG_USDC_TWAP" });
      expect(twapOnly.deployed).to.deep.equal(["PAXG_USDC_TWAP"]);
    });

    it("names the parameters that differ from a recorded adapter", async function () {
      const f = await loadFixture(fixture);
      const { result } = await run(f, f.env);
      const [spec, , pythSpec] = specsOf({ ...f.env, PAXG_USDC_TWAP_MIN_LIQUIDITY: "5", PAXG_USDC_TWAP_MAX_OBSERVATION_AGE: "7200", PAXG_USDC_TWAP_DESCRIPTION: "other", XAUT_PYTH_MAX_CONFIDENCE_PPM: "100", XAUT_PYTH_PRICE_ID: ethers.keccak256(ethers.toUtf8Bytes("other")) });
      expect(specDifferences(spec, result.snapshot.feeds.PAXG_USDC_TWAP)).to.deep.equal(["PAXG_USDC_TWAP_MIN_LIQUIDITY", "PAXG_USDC_TWAP_MAX_OBSERVATION_AGE", "PAXG_USDC_TWAP_DESCRIPTION"]);
      expect(specDifferences(pythSpec, result.snapshot.feeds.XAUT_PYTH)).to.deep.equal(["XAUT_PYTH_PRICE_ID", "XAUT_PYTH_MAX_CONFIDENCE_PPM"]);
      expect(() => parseFeedsSnapshot(JSON.stringify({ schema: "other", feeds: {} }))).to.throw("schema");
      expect(() => parseFeedsSnapshot(JSON.stringify({ schema: "goldstandard-market-feeds/1" }))).to.throw("lacks its feeds");
    });
  });

  describe("readPythFeed", function () {
    it("reads a Pyth adapter's status and id and tells the other feeds apart", async function () {
      const f = await loadFixture(fixture);
      const { result } = await run(f, f.env);
      const address = result.snapshot.feeds.XAUT_PYTH.address;
      const unrelayed = await readPythFeed(ethers.provider, address);
      expect(unrelayed?.status).to.equal("STALE");
      expect(unrelayed?.priceId).to.equal(f.priceId);
      expect(unrelayed?.pyth).to.equal(await f.pyth.getAddress());
      await f.pyth.setPrice(f.priceId, 4000_00000000n, 0n, -8, await time.latest());
      const live = await readPythFeed(ethers.provider, address);
      expect(live?.status).to.equal("OK");
      expect(live?.answer).to.equal(4000_00000000n);
      expect(await readPythFeed(ethers.provider, result.snapshot.feeds.PAXG_USDC_TWAP.address)).to.equal(undefined);
      expect(await readPythFeed(ethers.provider, await f.ethUsd.getAddress())).to.equal(undefined);
      expect(pythStatusName(3)).to.equal("STALE");
      expect(pythStatusName(42)).to.equal("UNKNOWN(42)");
    });
  });

  describe("readTwapFeed", function () {
    it("reads an adapter's status and pool cardinality and tells a Chainlink feed apart", async function () {
      const f = await loadFixture(fixture);
      const { result } = await run(f, f.env);
      await f.paxgUsdc.fillObservations();
      const reading = await readTwapFeed(ethers.provider, result.snapshot.feeds.PAXG_USDC_TWAP.address);
      expect(reading?.status).to.equal("OK");
      expect(reading?.answer).to.be.gt(0n);
      expect(reading?.windowSeconds).to.equal(WINDOW);
      expect(reading?.cardinality).to.deep.equal({ cardinality: 200, cardinalityNext: 200 });
      await f.paxgUsdc.setRevertOld(true);
      expect((await readTwapFeed(ethers.provider, result.snapshot.feeds.PAXG_USDC_TWAP.address))?.status).to.equal("OBSERVE_FAILED");
      expect(await readTwapFeed(ethers.provider, await f.ethUsd.getAddress())).to.equal(undefined);
      expect(await readTwapFeed(ethers.provider, result.snapshot.feeds.XAUT_PYTH.address)).to.equal(undefined);
      expect(twapStatusName(9)).to.equal("NO_RECENT_SWAPS");
      expect(twapStatusName(99)).to.equal("UNKNOWN(99)");
      await f.paxgUsdc.setRevertOld(false);
      await f.paxgUsdc.setLastObservation((await time.latest()) - 86_400, true);
      expect((await readTwapFeed(ethers.provider, result.snapshot.feeds.PAXG_USDC_TWAP.address))?.status).to.equal("NO_RECENT_SWAPS");
    });
  });
});
