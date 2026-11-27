import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import type { Provider, TransactionRequest } from "ethers";
import type { MockChainlinkFeed, MockERC20, MockSafe, MockUniswapV3Pool, UniswapV3TwapFeed } from "../typechain-types";
import { Finding, formatFindings, gapPpm, hasFailures, LaunchEnv, parseLaunchEnv, readSafeRecords, runPreflight } from "../scripts/lib/preflight";
import { safeRecordProblems } from "../scripts/lib/launchEnv";
import type { KnownAddresses } from "../scripts/lib/mainnetAddresses";

/**
 * The launch preflight (scripts/preflight-mainnet.ts) against mocks: what the PAXG-first launch
 * environment reads like (docs/ORACLE_IMPLEMENTATION_PLAN.md: C Chainlink PAXG/USD and G XAU/USD
 * alone, LAUNCH_CAPS=open with no ceiling and no per-block cap, XAUT
 * dormant; open the only mainnet profile, backstop refused), and which mistakes it refuses
 * before any transaction is sent.
 */
describe("Mainnet preflight (scripts/preflight-mainnet.ts)", function () {
  // Hardhat's first unlocked account; the preflight derives the deployer from the key.
  const DEPLOYER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
  const DEPLOYER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
  const HARDHAT = 31337;
  const GOLD = 4_150_00000000n; // G: $4,150 with 8 decimals
  const CHAINLINK = GOLD + 50_00000000n; // C: $4,200, 1.19% above gold
  const CEILING = 5_000_000n * 10n ** 18n; // the model's backstop, section 14.1 item 6
  const STAND_IN = 2_000_000n * 10n ** 18n;

  let paxg: MockERC20;
  let xaut: MockERC20;
  let paxgFeed: MockChainlinkFeed;
  let xauFeed: MockChainlinkFeed;
  let usdc: MockERC20;
  let paxgTwap: UniswapV3TwapFeed;
  let proposer: MockSafe;
  let executor: MockSafe;
  let guardian: MockSafe;
  let creations: TransactionRequest[];
  let known: KnownAddresses;
  let baseEnv: NodeJS.ProcessEnv;
  /** The backstop profile: refused on mainnet, its maximum derived under the retired pool design. */
  const backstopEnv: NodeJS.ProcessEnv = { LAUNCH_CAPS: "backstop", PAXG_DEBT_CEILING: CEILING.toString() };

  async function stamp(feed: MockChainlinkFeed, answer: bigint, ageSeconds = 60): Promise<void> {
    const now = await time.latest();
    await feed.setLatestRoundData(1, answer, now - ageSeconds, now - ageSeconds, 1);
  }

  async function chainlink(description: string, answer: bigint, decimals = 8, ageSeconds = 60): Promise<MockChainlinkFeed> {
    const feed = await (await ethers.getContractFactory("MockChainlinkFeed")).deploy(decimals, description);
    await stamp(feed, answer, ageSeconds);
    return feed;
  }

  const WINDOW = 1800;
  /** The pool tick at which a token0 base of `baseDecimals` trades at `usd` against a 6 decimal stablecoin. */
  const tickFor = (usd: number, baseDecimals: number): number => Math.floor(Math.log((usd * 1e6) / 10 ** baseDecimals) / Math.log(1.0001));

  interface TwapOptions {
    usd?: number;
    cardinality?: number;
    filled?: boolean;
    liquidity?: bigint;
    old?: boolean;
    idleSeconds?: number;
  }

  /** P: a UniswapV3TwapFeed over a fresh mock PAXG pool against a 6 decimal stablecoin at 1 USD. */
  async function twap(options: TwapOptions = {}): Promise<{ feed: UniswapV3TwapFeed; pool: MockUniswapV3Pool }> {
    const pool = await (await ethers.getContractFactory("MockUniswapV3Pool")).deploy(await paxg.getAddress(), await usdc.getAddress());
    await pool.setTick(tickFor(options.usd ?? 4_180, 18));
    await pool.setLiquidity(options.liquidity ?? 10n ** 24n);
    await pool.increaseObservationCardinalityNext(options.cardinality ?? 200);
    if (options.filled ?? true) await pool.fillObservations();
    if (options.old) await pool.setRevertOld(true);
    if (options.idleSeconds) await pool.setLastObservation((await time.latest()) - options.idleSeconds, true);
    const feed = await (await ethers.getContractFactory("UniswapV3TwapFeed")).deploy(
      await pool.getAddress(), await paxg.getAddress(), WINDOW, 10n ** 15n, ethers.ZeroAddress, 0, 6 * 3600, "PAXG / USD (TWAP)"
    );
    return { feed, pool };
  }

  async function pythAdapter(): Promise<string> {
    const pyth = await (await ethers.getContractFactory("MockPyth")).deploy();
    const id = ethers.keccak256(ethers.toUtf8Bytes("PAXG/USD"));
    await pyth.setPrice(id, CHAINLINK, 0n, -8, await time.latest());
    const feed = await (await ethers.getContractFactory("PythMarketFeed")).deploy(await pyth.getAddress(), id, 3600, 5000, "PAXG / USD (Pyth)");
    return feed.getAddress();
  }

  // Each Safe gets its own signers (offset into Hardhat's accounts) so the base environment has no shared signer.
  async function safe(threshold: number, owners: number, offset = 1): Promise<MockSafe> {
    const signers = (await ethers.getSigners()).slice(offset, offset + owners).map((s) => s.address);
    return (await ethers.getContractFactory("MockSafe")).deploy(signers, threshold);
  }

  before(async function () {
    paxg = await (await ethers.getContractFactory("MockERC20")).deploy("Paxos Gold", "PAXG", 18);
    xaut = await (await ethers.getContractFactory("MockERC20")).deploy("Tether Gold", "XAUt", 6);
    usdc = await (await ethers.getContractFactory("MockERC20")).deploy("USD Coin", "USDC", 6);
    paxgFeed = await chainlink("PAXG / USD", CHAINLINK);
    xauFeed = await chainlink("XAU / USD", GOLD);
    paxgTwap = (await twap()).feed;
    proposer = await safe(3, 5, 1);
    executor = await safe(2, 3, 17);
    guardian = await safe(2, 3, 8);
    const stablecoin = await ethers.getContractFactory("GoldStablecoin");
    const buffer = await ethers.getContractFactory("SurplusBuffer");
    creations = [await stablecoin.getDeployTransaction(), await buffer.getDeployTransaction(await paxg.getAddress())];
    known = {
      paxgToken: await paxg.getAddress(),
      xautToken: await xaut.getAddress(),
      paxgUsdFeed: await paxgFeed.getAddress(),
      anchorFeed: await xauFeed.getAddress(),
    };
    baseEnv = {
      LAUNCH_CAPS: "open",
      PAXG_TOKEN: known.paxgToken,
      XAUT_TOKEN: known.xautToken,
      PAXG_FEED: known.paxgUsdFeed,
      // XAUT_FEED unset: deploy.ts registers XAUT on an InactiveFeed it creates.
      XAU_USD_ANCHOR_FEED: known.anchorFeed,
      // The mainnet launch figure; the 100 default is for Sepolia and the rehearsal harness.
      MIN_DEBT_GSUSD: "1000",
      TIMELOCK_PROPOSER: await proposer.getAddress(),
      TIMELOCK_EXECUTOR: await executor.getAddress(),
      TIMELOCK_GUARDIAN: await guardian.getAddress(),
      RPC_URL: "https://mainnet.example/rpc",
      PRIVATE_KEY: DEPLOYER_KEY,
      ETHERSCAN_API_KEY: "key",
    };
  });

  function parsed(overrides: NodeJS.ProcessEnv = {}): LaunchEnv {
    const { env, findings } = parseLaunchEnv({ ...baseEnv, ...overrides });
    if (!env) throw new Error(formatFindings(findings));
    return env;
  }

  async function preflight(env: LaunchEnv, overrides: Partial<Parameters<typeof runPreflight>[0]> = {}): Promise<Finding[]> {
    return runPreflight({
      provider: ethers.provider,
      env,
      expectedChainId: HARDHAT,
      known,
      creations,
      snapshotExists: false,
      allowExistingSnapshot: false,
      ...overrides,
    });
  }

  /** The Hardhat provider presenting itself as chain 1, for the checks that differ on mainnet. */
  function asMainnet(): Provider {
    const provider = ethers.provider;
    return new Proxy(provider, {
      get(target, key) {
        if (key === "getNetwork") return async () => ({ chainId: 1n, name: "mainnet" });
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as unknown as Provider;
  }

  const verdict = (findings: Finding[], name: string): string | undefined => findings.find((f) => f.name === name)?.verdict;
  const detail = (findings: Finding[], name: string): string => findings.find((f) => f.name === name)?.detail ?? "";
  const failNames = (findings: Finding[]): string[] => findings.filter((f) => f.verdict === "fail").map((f) => f.name);

  describe("parseLaunchEnv", function () {
    it("accepts the PAXG-first launch environment and derives the deployer from the key", function () {
      const { env, findings } = parseLaunchEnv(baseEnv);
      expect(hasFailures(findings), formatFindings(findings)).to.equal(false);
      expect(env?.deployer).to.equal(DEPLOYER);
      expect(env?.launchCaps).to.equal("open");
      expect(env?.xautActive).to.equal(false);
      expect(env?.paxg.debtCeiling).to.equal(ethers.MaxUint256);
      expect(env?.perBlockMintCap).to.equal(0n);
      expect(env?.stalenessThreshold).to.equal(90000);
      expect(env?.proposers).to.deep.equal([baseEnv.TIMELOCK_PROPOSER]);
      expect(verdict(findings, "policy:LAUNCH_CAPS")).to.equal("pass");
      expect(detail(findings, "policy:LAUNCH_CAPS")).to.include("open: the mainnet launch profile");
      expect(verdict(findings, "policy:PAXG_DEBT_CEILING")).to.equal("pass");
      expect(detail(findings, "policy:PAXG_DEBT_CEILING")).to.include("unlimited");
      expect(detail(findings, "policy:PER_BLOCK_MINT_CAP")).to.include("off");
    });

    it("fails the backstop: open is the only mainnet profile, the backstop maximum predating variant C", function () {
      const { env, findings } = parseLaunchEnv({ ...baseEnv, ...backstopEnv });
      expect(env).to.equal(undefined);
      expect(verdict(findings, "policy:LAUNCH_CAPS")).to.equal("fail");
      expect(detail(findings, "policy:LAUNCH_CAPS")).to.include("LAUNCH_CAPS=backstop is refused on mainnet");
      expect(detail(findings, "policy:LAUNCH_CAPS")).to.include("retired pool design");
      expect(detail(findings, "policy:LAUNCH_CAPS")).to.include("open is the only mainnet profile");
      // The modelled ceiling itself would parse: the refusal is the profile, not the number.
      expect(verdict(findings, "policy:PAXG_DEBT_CEILING")).to.equal(undefined);
    });

    it("asserts the mainnet minimum debt of 1000 GSUSD rather than trusting the default", function () {
      expect(verdict(parseLaunchEnv({ ...baseEnv, MIN_DEBT_GSUSD: undefined }).findings, "policy:MIN_DEBT_GSUSD")).to.equal("fail");
      expect(detail(parseLaunchEnv({ ...baseEnv, MIN_DEBT_GSUSD: "100" }).findings, "policy:MIN_DEBT_GSUSD")).to.include("got 100.0 GSUSD");
      expect(verdict(parseLaunchEnv({ ...baseEnv, MIN_DEBT_GSUSD: "1000" }).findings, "policy:MIN_DEBT_GSUSD")).to.equal("pass");
    });

    it("fails an open launch with a PAXG ceiling or a per-block cap", function () {
      for (const [key, value] of [["PAXG_DEBT_CEILING", CEILING.toString()], ["PER_BLOCK_MINT_CAP", "1"]]) {
        const { env, findings } = parseLaunchEnv({ ...baseEnv, [key]: value });
        expect(env, key).to.equal(undefined);
        expect(verdict(findings, `policy:${key}`), key).to.equal("fail");
        expect(detail(findings, `policy:${key}`), key).to.include("the open profile");
      }
      expect(verdict(parseLaunchEnv({ ...baseEnv, PAXG_DEBT_CEILING: "unlimited" }).findings, "policy:PAXG_DEBT_CEILING")).to.equal("pass");
    });

    it("names every missing variable at once, the anchor included", function () {
      const { env, findings } = parseLaunchEnv({ ...baseEnv, XAU_USD_ANCHOR_FEED: "", PRIVATE_KEY: undefined });
      expect(env).to.equal(undefined);
      expect(findings.map((f) => f.name)).to.have.members(["env:XAU_USD_ANCHOR_FEED", "env:PRIVATE_KEY"]);
    });

    it("fails the guarded profile: the mainnet launch is open alone", function () {
      const { env, findings } = parseLaunchEnv({
        ...baseEnv,
        LAUNCH_CAPS: "guarded",
        // XAUT is active under guarded and needs a feed of its own.
        XAUT_FEED: known.xautToken,
      });
      expect(env).to.equal(undefined);
      expect(verdict(findings, "policy:LAUNCH_CAPS")).to.equal("fail");
      expect(detail(findings, "policy:LAUNCH_CAPS")).to.include("testnets");
      expect(verdict(parseLaunchEnv({ ...baseEnv, LAUNCH_CAPS: "wide" }).findings, "policy:LAUNCH_CAPS")).to.equal("fail");
    });

    it("fails the backstop ceiling unset, zero, unlimited or above the model's 5,000,000 GSUSD", function () {
      for (const value of [undefined, "0", "unlimited", (CEILING + 1n).toString()]) {
        const { env, findings } = parseLaunchEnv({ ...baseEnv, ...backstopEnv, PAXG_DEBT_CEILING: value });
        expect(env, String(value)).to.equal(undefined);
        expect(verdict(findings, "policy:PAXG_DEBT_CEILING"), String(value)).to.equal("fail");
      }
      // A rehearsal stand-in replaces the maximum: below the ceiling it refuses the ceiling.
      const stood = parseLaunchEnv({ ...baseEnv, ...backstopEnv, PAXG_BACKSTOP_REHEARSAL_MAX: STAND_IN.toString() });
      expect(detail(stood.findings, "policy:PAXG_DEBT_CEILING")).to.include(`above the rehearsal backstop maximum ${STAND_IN}`);
    });

    it("fails any variable that would configure XAUT beyond its oracle entry, under open and backstop", function () {
      for (const profile of [{}, backstopEnv]) {
        for (const key of ["XAUT_DEBT_CEILING", "XAUT_MIN_RATIO", "RESERVE_MIN_RESERVE_XAUT"]) {
          const { env, findings } = parseLaunchEnv({ ...baseEnv, ...profile, [key]: "0" });
          expect(env, key).to.equal(undefined);
          expect(verdict(findings, `policy:${key}`), key).to.equal("fail");
          expect(detail(findings, `policy:${key}`), key).to.include("XAUT is dormant");
        }
      }
    });

    it("fails an environment that still carries a pool confirmation, its agreement band or a market feed step", function () {
      const stale: Array<[string, string]> = [
        ["PAXG_CONFIRM_FEED", known.paxgUsdFeed],
        ["XAUT_CONFIRM_FEED", known.paxgUsdFeed],
        ["PAXG_AGREEMENT_BAND_PPM", "30000"],
        ["MARKET_FEEDS", "PAXG_WETH_TWAP"],
      ];
      for (const [key, value] of stale) {
        const { env, findings } = parseLaunchEnv({ ...baseEnv, [key]: value });
        expect(env, key).to.equal(undefined);
        expect(verdict(findings, `env:${key}`), key).to.equal("fail");
        expect(detail(findings, `env:${key}`), key).to.include("retired");
      }
    });

    it("refuses a reserve floor, an unlocked silo role, a disabled mint cap and the ceiling override", function () {
      const { env, findings } = parseLaunchEnv({
        ...baseEnv,
        MIN_GSUSD_RESERVE: "1",
        SILO_LOCK_VAULT_ROLE: "false",
        ALLOW_NONZERO_CEILING: "1",
      });
      expect(env).to.equal(undefined);
      expect(verdict(findings, "policy:MIN_GSUSD_RESERVE")).to.equal("fail");
      expect(verdict(findings, "policy:SILO_LOCK_VAULT_ROLE")).to.equal("fail");
      expect(verdict(findings, "policy:ALLOW_NONZERO_CEILING")).to.equal("fail");
      expect(verdict(parseLaunchEnv({ ...baseEnv, ...backstopEnv, PER_BLOCK_MINT_CAP: "0" }).findings, "policy:PER_BLOCK_MINT_CAP")).to.equal("fail");
    });

    it("bounds the staleness threshold by the heartbeat and the oracle's cap", function () {
      expect(verdict(parseLaunchEnv({ ...baseEnv, STALENESS_THRESHOLD: "3600" }).findings, "policy:STALENESS_THRESHOLD")).to.equal("fail");
      // Above the oracle constructor's cap the contract itself would revert, so the shared parser refuses it.
      expect(verdict(parseLaunchEnv({ ...baseEnv, STALENESS_THRESHOLD: "100000" }).findings, "env:STALENESS_THRESHOLD")).to.equal("fail");
      expect(verdict(parseLaunchEnv({ ...baseEnv, STALENESS_THRESHOLD: "87000" }).findings, "policy:STALENESS_THRESHOLD")).to.equal("warn");
      expect(verdict(parseLaunchEnv({ ...baseEnv, STALENESS_THRESHOLD: "90000" }).findings, "policy:STALENESS_THRESHOLD")).to.equal("pass");
    });

    it("tells the operator how to spell a permissionless executor", function () {
      const { findings } = parseLaunchEnv({ ...baseEnv, TIMELOCK_EXECUTOR: "0x0" });
      expect(verdict(findings, "env:TIMELOCK_EXECUTOR")).to.equal("fail");
      expect(detail(findings, "env:TIMELOCK_EXECUTOR")).to.include(ethers.ZeroAddress);
      // Spelled correctly it parses; the launch accepts it only with ALLOW_OPEN_EXECUTOR=1 (below).
      expect(parseLaunchEnv({ ...baseEnv, TIMELOCK_EXECUTOR: ethers.ZeroAddress, ALLOW_OPEN_EXECUTOR: "1" }).env?.executors).to.deep.equal([ethers.ZeroAddress]);
    });

    // With the zero address as
    // executor anyone chooses when a matured operation runs, so the launch refuses it unless the
    // operator accepts it in so many words.
    it("refuses an open executor unless ALLOW_OPEN_EXECUTOR=1 accepts it, and says what the acceptance means", function () {
      const refused = parseLaunchEnv({ ...baseEnv, TIMELOCK_EXECUTOR: ethers.ZeroAddress });
      expect(refused.env).to.equal(undefined);
      expect(failNames(refused.findings)).to.deep.equal(["policy:TIMELOCK_EXECUTOR"]);
      expect(detail(refused.findings, "policy:TIMELOCK_EXECUTOR")).to.include("ALLOW_OPEN_EXECUTOR=1");
      // One open entry beside a Safe opens execution to everyone just the same.
      const mixed = parseLaunchEnv({ ...baseEnv, TIMELOCK_EXECUTOR: `${baseEnv.TIMELOCK_EXECUTOR},${ethers.ZeroAddress}` });
      expect(verdict(mixed.findings, "policy:TIMELOCK_EXECUTOR")).to.equal("fail");

      const accepted = parseLaunchEnv({ ...baseEnv, TIMELOCK_EXECUTOR: ethers.ZeroAddress, ALLOW_OPEN_EXECUTOR: "1" });
      expect(accepted.env?.allowOpenExecutor).to.equal(true);
      expect(verdict(accepted.findings, "policy:TIMELOCK_EXECUTOR")).to.equal("warn");
      expect(detail(accepted.findings, "policy:TIMELOCK_EXECUTOR")).to.include("7 day grace period");
      expect(detail(accepted.findings, "policy:TIMELOCK_EXECUTOR")).to.include("cancel");

      expect(verdict(parseLaunchEnv(baseEnv).findings, "policy:TIMELOCK_EXECUTOR")).to.equal("pass");
    });

    it("reads ALLOW_OPEN_EXECUTOR as 1 or nothing, and notes an acceptance with no open executor to accept", function () {
      const misspelt = parseLaunchEnv({ ...baseEnv, TIMELOCK_EXECUTOR: ethers.ZeroAddress, ALLOW_OPEN_EXECUTOR: "true" });
      expect(misspelt.env).to.equal(undefined);
      expect(verdict(misspelt.findings, "env:ALLOW_OPEN_EXECUTOR")).to.equal("fail");
      const idle = parseLaunchEnv({ ...baseEnv, ALLOW_OPEN_EXECUTOR: "1" });
      expect(idle.env).to.not.equal(undefined);
      expect(verdict(idle.findings, "policy:TIMELOCK_EXECUTOR")).to.equal("warn");
      expect(detail(idle.findings, "policy:TIMELOCK_EXECUTOR")).to.include("no effect");
    });

    it("refuses a malformed key without printing it", function () {
      const { findings } = parseLaunchEnv({ ...baseEnv, PRIVATE_KEY: "0xnotakey" });
      expect(verdict(findings, "env:PRIVATE_KEY")).to.equal("fail");
      expect(detail(findings, "env:PRIVATE_KEY")).to.not.include("notakey");
    });

    it("only warns about a missing Etherscan key", function () {
      const { env, findings } = parseLaunchEnv({ ...baseEnv, ETHERSCAN_API_KEY: undefined });
      expect(env).to.not.equal(undefined);
      expect(verdict(findings, "env:ETHERSCAN_API_KEY")).to.equal("warn");
    });

    // The divergences between the old preflight and deploy.ts, closed by the shared parser.
    it("refuses a zero guardian with a guardian-specific reason rather than the executor's", function () {
      const { env, findings } = parseLaunchEnv({ ...baseEnv, TIMELOCK_GUARDIAN: ethers.ZeroAddress });
      expect(env).to.equal(undefined);
      expect(verdict(findings, "env:TIMELOCK_GUARDIAN")).to.equal("fail");
      expect(detail(findings, "env:TIMELOCK_GUARDIAN")).to.include("grantGuardianRole");
      expect(detail(findings, "env:TIMELOCK_GUARDIAN")).to.not.include("once the timelock matures");
    });

    it("trims a spaced proposer list to the addresses deploy.ts will encode", async function () {
      const second = await safe(2, 3, 11);
      const spaced = `${baseEnv.TIMELOCK_PROPOSER}, ${await second.getAddress()} `;
      const { env } = parseLaunchEnv({ ...baseEnv, TIMELOCK_PROPOSER: spaced });
      expect(env?.proposers).to.deep.equal([baseEnv.TIMELOCK_PROPOSER, await second.getAddress()]);
      for (const address of env?.proposers ?? []) expect(ethers.isAddress(address)).to.equal(true);
    });

    it("refuses an empty string instead of reading it as zero", function () {
      const { env, findings } = parseLaunchEnv({ ...baseEnv, PAXG_MIN_RATIO: "", MIN_DEBT_GSUSD: "   " });
      expect(env).to.equal(undefined);
      expect(verdict(findings, "env:PAXG_MIN_RATIO")).to.equal("fail");
      expect(verdict(findings, "env:MIN_DEBT_GSUSD")).to.equal("fail");
      expect(detail(findings, "env:PAXG_MIN_RATIO")).to.include("empty");
    });

    it("bounds every numeric knob by the contracts' own limits", function () {
      const cases: Array<[string, string]> = [
        ["PAXG_LIQ_PENALTY", "200001"],
        ["PAXG_LIQ_RATIO", "999999"],
        ["PAXG_MIN_RATIO", "10000001"],
        ["PAXG_STABILITY_FEE_BPS", "5001"],
        ["PAXG_GOLD_BAND_PPM", "4999"],
        ["PAXG_LIQUIDATION_CLAMP_PPM", "80001"],
        ["PAXG_LIQUIDATION_CLAMP_PPM", "4999"],
        ["MIN_DEBT_GSUSD", "99"],
        ["UNDERWATER_DISCOUNT_PPM", "50001"],
        ["RESERVE_PENALTY_SHARE_BPS", "10001"],
        ["ORIGINATION_FEE_BPS", "101"],
        ["RESERVE_DAILY_CAP_PPM", "1000001"],
        ["SILO_CAP", "1000000000000000000001"],
        ["BAD_DEBT_PAUSE_THRESHOLD", "0"],
        ["SILO_CAP", "abc"],
      ];
      for (const [key, value] of cases) {
        const { env, findings } = parseLaunchEnv({ ...baseEnv, [key]: value });
        expect(env, `${key}=${value}`).to.equal(undefined);
        expect(verdict(findings, `env:${key}`), `${key}=${value}`).to.equal("fail");
      }
      const inverted = parseLaunchEnv({ ...baseEnv, PAXG_MIN_RATIO: "1100000", PAXG_LIQ_RATIO: "1100000" });
      expect(verdict(inverted.findings, "env:PAXG_MIN_RATIO")).to.equal("fail");
      const atTheEdge = parseLaunchEnv({ ...baseEnv, PAXG_LIQ_PENALTY: "200000", UNDERWATER_DISCOUNT_PPM: "50000" });
      expect(atTheEdge.env?.paxg.liqPenalty).to.equal(200_000);
      // The contract's upper bound parses, and the launch policy then refuses it on its own line.
      const topOfRange = parseLaunchEnv({ ...baseEnv, MIN_DEBT_GSUSD: "10000" });
      expect(failNames(topOfRange.findings)).to.deep.equal(["policy:MIN_DEBT_GSUSD"]);
      expect(topOfRange.env).to.equal(undefined);
    });

    it("echoes every effective parameter, defaults included, as the ceremony record", function () {
      const { env, findings } = parseLaunchEnv(baseEnv);
      expect(env).to.not.equal(undefined);
      const echoed = Object.fromEntries(findings.filter((f) => f.name.startsWith("param:")).map((f) => [f.name.slice(6), f.detail]));
      expect(echoed.PAXG_LIQ_PENALTY).to.equal("50000");
      expect(echoed.MIN_DEBT_WEI).to.equal(ethers.parseEther("1000").toString());
      expect(echoed.LAUNCH_CAPS).to.equal("open");
      expect(echoed.PER_BLOCK_MINT_CAP).to.equal("0");
      expect(echoed.PAXG_DEBT_CEILING).to.equal("unlimited");
      expect(echoed.PAXG_BACKSTOP_MAX).to.equal("not applicable");
      expect(echoed.PAXG_GOLD_BAND_PPM).to.equal("20000");
      expect(echoed.PAXG_LIQUIDATION_CLAMP_PPM).to.equal("20000");
      expect(echoed.XAUT_STATUS).to.equal("dormant (oracle entry only)");
      expect(echoed.XAUT_DEBT_CEILING).to.equal("not applied (XAUT dormant)");
      expect(echoed.TIMELOCK_GUARDIAN).to.equal(baseEnv.TIMELOCK_GUARDIAN);
      expect(echoed.ORIGINATION_FEE_BPS).to.equal("5");
      expect(echoed.PAXG_CONFIRM_FEED).to.equal(undefined);
      expect(Object.keys(echoed)).to.have.length(38);
    });
  });

  describe("runPreflight", function () {
    it("passes the PAXG-first launch and states what it confirmed", async function () {
      const findings = await preflight(parsed());
      expect(hasFailures(findings), formatFindings(findings)).to.equal(false);
      for (const name of [
        "inventory:PAXG_FEED",
        "inventory:XAU_USD_ANCHOR_FEED",
        "feed:XAU_USD_ANCHOR_FEED",
        "feed:PAXG_FEED",
        "market:PAXG",
        "gold-band:PAXG",
        "recovery:PAXG",
        "xaut:dormant",
        "pyth:excluded",
        "twap:excluded",
      ]) {
        expect(verdict(findings, name), name).to.equal("pass");
      }
      expect(detail(findings, "token:PAXG")).to.include("18 decimals");
      expect(detail(findings, "token:XAUT")).to.include("6 decimals");
      expect(detail(findings, "feed:PAXG_FEED")).to.include('"PAXG / USD"');
      expect(detail(findings, "gold-band:PAXG")).to.include("1.205%");
      expect(detail(findings, "gold-band:PAXG")).to.include("the band is 2.000%");
      expect(detail(findings, "recovery:PAXG")).to.include("may freeze PAXG and unfreeze it once a normal read succeeds");
      expect(detail(findings, "recovery:PAXG")).to.include("liquidation resumes by itself");
      expect(findings.some((f) => f.name.includes("PAXG_CONFIRM_FEED") || f.name.startsWith("agreement-band"))).to.equal(false);
      expect(detail(findings, "xaut:dormant")).to.include("on an InactiveFeed that deploy.ts creates");
      expect(detail(findings, "xaut:dormant")).to.include("no collateral type, stability fee, reserve asset or stability pool token");
      expect(findings.some((f) => f.name === "policy:PAXG_BACKSTOP_REHEARSAL_MAX")).to.equal(false);
      expect(findings.filter((f) => f.verdict === "warn").map((f) => f.name)).to.deep.equal(["deployer:fresh"]);
      expect(detail(findings, "safe:proposer")).to.include("3-of-5");
      expect(detail(findings, "safe:guardian")).to.include("2-of-3");
      expect(verdict(findings, "deployer:balance")).to.equal("pass");
      expect(verdict(findings, "snapshot")).to.equal("pass");
    });

    it("measures a gap the way GoldOracle measures its band and clamp, in ppm of the reference", function () {
      expect(gapPpm(4200n, 4150n)).to.equal(12048n);
      expect(gapPpm(4150n, 4200n)).to.equal(11904n);
      expect(gapPpm(100n, 100n)).to.equal(0n);
    });

    it("stops at the chain check when connected to the wrong network", async function () {
      const findings = await preflight(parsed(), { expectedChainId: 1 });
      expect(findings).to.have.length(1);
      expect(verdict(findings, "chain")).to.equal("fail");
    });

    it("refuses a backstop environment with a rehearsal stand-in, and still fails a stand-in that reaches the run on mainnet", async function () {
      const refused = parseLaunchEnv({
        ...baseEnv,
        ...backstopEnv,
        PAXG_DEBT_CEILING: STAND_IN.toString(),
        PAXG_BACKSTOP_REHEARSAL_MAX: STAND_IN.toString(),
      });
      expect(refused.env).to.equal(undefined);
      expect(verdict(refused.findings, "policy:LAUNCH_CAPS")).to.equal("fail");
      // Defence in depth: the run itself still flags a stand-in should one ever reach it.
      const env: LaunchEnv = { ...parsed(), backstopRehearsal: true, paxgBackstopMax: STAND_IN };
      expect(verdict(await preflight(env), "policy:PAXG_BACKSTOP_REHEARSAL_MAX")).to.equal("warn");
      const findings = await preflight(env, { provider: asMainnet(), expectedChainId: 1 });
      expect(verdict(findings, "chain")).to.equal("pass");
      expect(verdict(findings, "policy:PAXG_BACKSTOP_REHEARSAL_MAX")).to.equal("fail");
      expect(detail(findings, "policy:PAXG_BACKSTOP_REHEARSAL_MAX")).to.include("can never reach mainnet");
      expect(verdict(await preflight(parsed(), { provider: asMainnet(), expectedChainId: 1 }), "policy:PAXG_BACKSTOP_REHEARSAL_MAX")).to.equal(undefined);
    });

    it("fails C when it is not the published Chainlink PAXG/USD, and an anchor that is not the published XAU/USD", async function () {
      const other = await chainlink("PAXG / USD", CHAINLINK);
      const a = await preflight(parsed({ PAXG_FEED: await other.getAddress() }));
      expect(verdict(a, "inventory:PAXG_FEED")).to.equal("fail");
      expect(detail(a, "inventory:PAXG_FEED")).to.include(known.paxgUsdFeed);
      const gold = await chainlink("XAU / USD", GOLD);
      const b = await preflight(parsed({ XAU_USD_ANCHOR_FEED: await gold.getAddress() }));
      expect(verdict(b, "inventory:XAU_USD_ANCHOR_FEED")).to.equal("fail");
    });

    it("fails C or G with the wrong decimals, stale or describing itself as another pair", async function () {
      const asC = async (feed: MockChainlinkFeed): Promise<Finding[]> => {
        const address = await feed.getAddress();
        return preflight(parsed({ PAXG_FEED: address }), { known: { ...known, paxgUsdFeed: address } });
      };
      expect(detail(await asC(await chainlink("PAXG / USD", CHAINLINK, 18)), "feed:PAXG_FEED")).to.include("18 decimals");
      expect(detail(await asC(await chainlink("PAXG / USD", CHAINLINK, 8, 90_001)), "feed:PAXG_FEED")).to.include("staleness threshold");
      expect(detail(await asC(await chainlink("ETH / USD", CHAINLINK)), "feed:PAXG_FEED")).to.include('"ETH / USD"');
      const silver = await chainlink("XAG / USD", GOLD);
      const silverAddress = await silver.getAddress();
      const asG = await preflight(parsed({ XAU_USD_ANCHOR_FEED: silverAddress }), { known: { ...known, anchorFeed: silverAddress } });
      expect(detail(asG, "feed:XAU_USD_ANCHOR_FEED")).to.include('"XAG / USD"');
    });

    for (const fault of ["zero timestamp", "future timestamp", "incomplete round", "exact staleness boundary"]) {
      it(`fails C with ${fault}, matching the on-chain validated read`, async function () {
        const feed = await (await ethers.getContractFactory("MockChainlinkFeed")).deploy(8, "PAXG / USD");
        const next = (await time.latest()) + 1;
        await time.setNextBlockTimestamp(next);
        const updatedAt = fault === "zero timestamp" ? 0
          : fault === "future timestamp" ? next + 10_000
          : fault === "exact staleness boundary" ? next - 90_000 : next;
        await feed.setLatestRoundData(3, CHAINLINK, updatedAt, updatedAt, fault === "incomplete round" ? 2 : 3);
        const address = await feed.getAddress();
        const findings = await preflight(parsed({ PAXG_FEED: address }), { known: { ...known, paxgUsdFeed: address } });
        expect(verdict(findings, "feed:PAXG_FEED")).to.equal("fail");
      });
    }

    it("fails C more than the gold band from G, and passes the same gap under a wider band", async function () {
      const drifted = await chainlink("PAXG / USD", (GOLD * 105n) / 100n); // 4.76% above gold
      const address = await drifted.getAddress();
      const env = { PAXG_FEED: address };
      const options = { known: { ...known, paxgUsdFeed: address } };
      const narrow = await preflight(parsed(env), options);
      expect(verdict(narrow, "gold-band:PAXG")).to.equal("fail");
      expect(detail(narrow, "gold-band:PAXG")).to.include("borrowing and reserve swaps would stop");
      expect(verdict(await preflight(parsed({ ...env, PAXG_GOLD_BAND_PPM: "50000" }), options), "gold-band:PAXG")).to.equal("pass");
    });

    it("fails a pool adapter anywhere in the configured feeds: pool prices are outside the production path", async function () {
      const findings = await preflight(parsed({ XAUT_FEED: await paxgTwap.getAddress() }));
      expect(verdict(findings, "twap:excluded")).to.equal("fail");
      expect(detail(findings, "twap:excluded")).to.include("XAUT_FEED is a UniswapV3TwapFeed");
    });

    it("fails PAXG priced on the XAU/USD feed: gold is the reference, never a market price", async function () {
      // The shared parser refuses it first, since GoldOracle.setAnchorFeed would revert.
      const refused = parseLaunchEnv({ ...baseEnv, PAXG_FEED: known.anchorFeed });
      expect(refused.env).to.equal(undefined);
      expect(detail(refused.findings, "env:PAXG_FEED")).to.include("setAnchorFeed refuses");
      // And the on-chain check still names it if an environment were assembled by hand.
      const findings = await preflight({ ...parsed(), paxgFeed: known.anchorFeed }, { known: { ...known, paxgUsdFeed: known.anchorFeed } });
      expect(verdict(findings, "market:PAXG")).to.equal("fail");
      expect(detail(findings, "market:PAXG")).to.include("reference only");
    });

    it("states XAUT's dormant entry plainly, and fails it when XAUT is configured or its feed is not an InactiveFeed", async function () {
      const inactive = await (await ethers.getContractFactory("InactiveFeed")).deploy();
      const supplied = await preflight(parsed({ XAUT_FEED: await inactive.getAddress() }));
      expect(verdict(supplied, "xaut:dormant")).to.equal("pass");
      expect(detail(supplied, "xaut:dormant")).to.include(`on the InactiveFeed ${await inactive.getAddress()}`);
      const other = await chainlink("XAUT / USD", GOLD);
      const live = await preflight(parsed({ XAUT_FEED: await other.getAddress() }));
      expect(verdict(live, "xaut:dormant")).to.equal("fail");
      expect(detail(live, "xaut:dormant")).to.include("is not an InactiveFeed");
      const active = await preflight({ ...parsed(), xautActive: true });
      expect(verdict(active, "xaut:dormant")).to.equal("fail");
      expect(detail(active, "xaut:dormant")).to.include("configured beyond its oracle entry");
      const [, eoa] = await ethers.getSigners();
      expect(detail(await preflight(parsed({ XAUT_FEED: eoa.address })), "xaut:dormant")).to.include("is not an InactiveFeed");
      // XAUT on the anchor: the parser refuses it, and the on-chain check names it too.
      expect(parseLaunchEnv({ ...baseEnv, XAUT_FEED: known.anchorFeed }).env).to.equal(undefined);
      const onAnchor = await preflight({ ...parsed(), xautFeed: known.anchorFeed });
      expect(detail(onAnchor, "xaut:dormant")).to.include("setAnchorFeed refuses");
    });

    it("fails a Pyth adapter anywhere in the configured feeds", async function () {
      const pyth = await pythAdapter();
      const findings = await preflight(parsed({ XAUT_FEED: pyth }));
      expect(verdict(findings, "pyth:excluded")).to.equal("fail");
      expect(detail(findings, "pyth:excluded")).to.include("XAUT_FEED is a PythMarketFeed");
    });

    it("refuses an EOA, a 1-of-N proposer and a guardian that is also the deployer", async function () {
      const [, eoa] = await ethers.getSigners();
      const weak = await safe(1, 3);
      const a = await preflight(parsed({ TIMELOCK_PROPOSER: eoa.address }));
      expect(detail(a, "safe:proposer")).to.include("EOA");
      const b = await preflight(parsed({ TIMELOCK_PROPOSER: await weak.getAddress() }));
      expect(detail(b, "safe:proposer")).to.include("1-of-3");
      expect(verdict(b, "safe:proposer")).to.equal("fail");
      const c = await preflight(parsed({ TIMELOCK_GUARDIAN: DEPLOYER }));
      expect(verdict(c, "safe:distinct")).to.equal("fail");
      expect(verdict(c, "safe:guardian")).to.equal("fail");
    });

    it("holds each Safe to the documented 2-of-3: proposer, executor and guardian alike", async function () {
      const cases: Array<[string, MockSafe, string]> = [
        ["TIMELOCK_PROPOSER", await safe(1, 3, 10), "safe:proposer"],
        ["TIMELOCK_PROPOSER", await safe(2, 2, 10), "safe:proposer"],
        ["TIMELOCK_GUARDIAN", await safe(2, 2, 10), "safe:guardian"],
        ["TIMELOCK_GUARDIAN", await safe(1, 3, 10), "safe:guardian"],
        // The executor was 1-of-1 until the project decision of 2026-11-16.
        ["TIMELOCK_EXECUTOR", await safe(1, 1, 10), "safe:executor"],
        ["TIMELOCK_EXECUTOR", await safe(1, 3, 10), "safe:executor"],
        ["TIMELOCK_EXECUTOR", await safe(2, 2, 10), "safe:executor"],
      ];
      for (const [key, weak, name] of cases) {
        const findings = await preflight(parsed({ [key]: await weak.getAddress() }), { provider: asMainnet(), expectedChainId: 1 });
        expect(verdict(findings, name), `${key} ${detail(findings, name)}`).to.equal("fail");
        expect(detail(findings, name)).to.include("at least 2-of-3");
      }
      const planned = await safe(2, 3, 10);
      expect(verdict(await preflight(parsed({ TIMELOCK_PROPOSER: await planned.getAddress() }), { provider: asMainnet(), expectedChainId: 1 }), "safe:proposer")).to.equal("pass");
      const plannedExecutor = await safe(2, 3, 10);
      expect(verdict(await preflight(parsed({ TIMELOCK_EXECUTOR: await plannedExecutor.getAddress() }), { provider: asMainnet(), expectedChainId: 1 }), "safe:executor")).to.equal("pass");
      // The minimum is not a mainnet rule alone: a fork or a testnet holds the executor to it too.
      const weakOffMainnet = await preflight(parsed({ TIMELOCK_EXECUTOR: await (await safe(1, 1, 10)).getAddress() }));
      expect(verdict(weakOffMainnet, "safe:executor")).to.equal("fail");
      const stronger = await safe(4, 7, 10);
      expect(verdict(await preflight(parsed({ TIMELOCK_PROPOSER: await stronger.getAddress() })), "safe:proposer")).to.equal("pass");
      const intended = await preflight(parsed(), { provider: asMainnet(), expectedChainId: 1 });
      expect(["safe:proposer", "safe:executor", "safe:guardian"].map((name) => verdict(intended, name))).to.deep.equal(["pass", "pass", "pass"]);
    });

    it("fails a Safe whose threshold and owners could not belong to a working Safe", async function () {
      const accounts = (await ethers.getSigners()).map((s) => s.address);
      const five = accounts.slice(10, 15);
      const factory = await ethers.getContractFactory("MockSafe");
      const broken: Array<[string, string[], number]> = [
        ["exceeds its 5 owners", five, 6],
        ["threshold of zero", five, 0],
        ["no owners", [], 3],
        ["same owner twice", [...five.slice(0, 4), five[0]], 3],
        ["zero address as an owner", [...five.slice(0, 4), ethers.ZeroAddress], 3],
      ];
      for (const [reason, owners, threshold] of broken) {
        const bad = await factory.deploy(owners, threshold);
        const findings = await preflight(parsed({ TIMELOCK_PROPOSER: await bad.getAddress() }));
        expect(verdict(findings, "safe:proposer"), reason).to.equal("fail");
        expect(detail(findings, "safe:proposer")).to.include(reason);
      }
    });

    it("fails a contract that does not answer the Safe views on mainnet, warns elsewhere, and does not probe it for signers", async function () {
      const address = await paxg.getAddress();
      const findings = await preflight(parsed({ TIMELOCK_GUARDIAN: address }));
      expect(verdict(findings, "safe:guardian")).to.equal("warn");
      expect(verdict(findings, "safe:signer-overlap")).to.equal("pass");
      const stablecoin = await (await ethers.getContractFactory("GoldStablecoin")).deploy();
      for (const key of ["TIMELOCK_PROPOSER", "TIMELOCK_EXECUTOR", "TIMELOCK_GUARDIAN"]) {
        const onMainnet = await preflight(parsed({ [key]: await stablecoin.getAddress() }), { provider: asMainnet(), expectedChainId: 1 });
        const name = `safe:${key.slice("TIMELOCK_".length).toLowerCase()}`;
        expect(verdict(onMainnet, name), key).to.equal("fail");
        expect(detail(onMainnet, name)).to.include("cannot be confirmed");
      }
      // An accepted open executor (ALLOW_OPEN_EXECUTOR=1) is untouched by the fail-closed rule.
      const permissionless = await preflight(parsed({ TIMELOCK_EXECUTOR: ethers.ZeroAddress, ALLOW_OPEN_EXECUTOR: "1" }), { provider: asMainnet(), expectedChainId: 1 });
      expect(verdict(permissionless, "safe:executor")).to.equal("pass");
      expect(detail(permissionless, "safe:executor")).to.include("grace period");
    });

    it("fails the role split on mainnet and warns elsewhere when one Safe holds two roles", async function () {
      const shared = await proposer.getAddress();
      const onFork = await preflight(parsed({ TIMELOCK_GUARDIAN: shared }));
      expect(verdict(onFork, "safe:role-split")).to.equal("warn");
      expect(detail(onFork, "safe:role-split")).to.include("guardian is the same address as proposer");
      const sameExecutor = await preflight(parsed({ TIMELOCK_EXECUTOR: shared }));
      expect(verdict(sameExecutor, "safe:role-split")).to.equal("warn");
      expect(detail(sameExecutor, "safe:role-split")).to.include("executor is the same address as proposer");
      expect(verdict(await preflight(parsed()), "safe:role-split")).to.equal("pass");
    });

    it("warns when two Safes share a signer", async function () {
      const overlapping = await safe(2, 3, 2); // signers 2..4 sit on the proposer too
      const findings = await preflight(parsed({ TIMELOCK_GUARDIAN: await overlapping.getAddress() }));
      expect(verdict(findings, "safe:signer-overlap")).to.equal("warn");
      expect(detail(findings, "safe:signer-overlap")).to.include("proposer and guardian share 3 signer(s)");
      expect(hasFailures(findings)).to.equal(false);
    });

    it("warns when the operations Safe shares a signer with a governance Safe, and passes when it shares none", async function () {
      const apart = await safe(2, 3, 14);
      const clean = await preflight(parsed({ OPERATIONS_SAFE: await apart.getAddress() }));
      expect(verdict(clean, "safe:signer-overlap")).to.equal("pass");

      const overlapping = await safe(2, 3, 2); // signers 2..4 sit on the proposer too
      const findings = await preflight(parsed({ OPERATIONS_SAFE: await overlapping.getAddress() }));
      expect(verdict(findings, "safe:operations")).to.equal("pass");
      expect(verdict(findings, "safe:operations-distinct")).to.equal("pass");
      expect(verdict(findings, "safe:signer-overlap")).to.equal("warn");
      expect(detail(findings, "safe:signer-overlap")).to.include("proposer and operations share 3 signer(s)");
      expect(hasFailures(findings)).to.equal(false);
    });

    it("fails when the deployer is an owner of any Safe, naming the Safe (safe:deployer-not-owner)", async function () {
      expect(verdict(await preflight(parsed()), "safe:deployer-not-owner")).to.equal("pass");
      // Account 0 is the deployer. A Safe it alone owns is the likeliest slip: retiring the key would leave it with no signer.
      const factory = await ethers.getContractFactory("MockSafe");
      const soleOwner = await factory.deploy([DEPLOYER], 1);
      const asExecutor = await preflight(parsed({ TIMELOCK_EXECUTOR: await soleOwner.getAddress() }));
      expect(verdict(asExecutor, "safe:deployer-not-owner")).to.equal("fail");
      expect(detail(asExecutor, "safe:deployer-not-owner")).to.include(`the executor Safe ${await soleOwner.getAddress()}`);
      expect(detail(asExecutor, "safe:deployer-not-owner")).to.include("single-use");
      // The address itself differs from the deployer, so the older check alone would have passed it.
      expect(verdict(asExecutor, "safe:distinct")).to.equal("pass");

      const others = (await ethers.getSigners()).slice(12, 14).map((s) => s.address);
      const seated = await factory.deploy([...others, DEPLOYER.toLowerCase()], 2);
      for (const key of ["TIMELOCK_PROPOSER", "TIMELOCK_GUARDIAN"]) {
        const findings = await preflight(parsed({ [key]: await seated.getAddress() }));
        expect(verdict(findings, "safe:deployer-not-owner"), key).to.equal("fail");
        expect(hasFailures(findings), key).to.equal(true);
      }
      const asOperations = await preflight(parsed({ OPERATIONS_SAFE: await seated.getAddress() }));
      expect(verdict(asOperations, "safe:deployer-not-owner")).to.equal("fail");
      expect(detail(asOperations, "safe:deployer-not-owner")).to.include("the operations Safe");
    });

    describe("the operations Safe (OPERATIONS_SAFE)", function () {
      it("is optional: unset warns on mainnet, naming the variable, and says nothing elsewhere", async function () {
        expect(parsed().operationsSafe).to.equal(undefined);
        expect(verdict(await preflight(parsed()), "safe:operations")).to.equal(undefined);
        const onMainnet = await preflight(parsed(), { provider: asMainnet(), expectedChainId: 1 });
        expect(verdict(onMainnet, "safe:operations")).to.equal("warn");
        expect(detail(onMainnet, "safe:operations")).to.include("OPERATIONS_SAFE is unset");
      });

      it("refuses a line that is present but holds no address", function () {
        for (const bad of ["", "   ", "<operations Safe: a fourth Safe>", "0x1234", ethers.ZeroAddress]) {
          const { env, findings } = parseLaunchEnv({ ...baseEnv, OPERATIONS_SAFE: bad });
          expect(env, bad).to.equal(undefined);
          expect(failNames(findings), bad).to.deep.equal(["env:OPERATIONS_SAFE"]);
        }
      });

      it("passes a working Safe that is none of the governance Safes nor the deployer", async function () {
        const operations = await safe(2, 3, 14);
        const env = parsed({ OPERATIONS_SAFE: (await operations.getAddress()).toLowerCase() });
        expect(env.operationsSafe).to.equal(await operations.getAddress());
        const findings = await preflight(env, { provider: asMainnet(), expectedChainId: 1 });
        expect(verdict(findings, "safe:operations")).to.equal("pass");
        expect(detail(findings, "safe:operations")).to.include("2-of-3");
        expect(verdict(findings, "safe:operations-distinct")).to.equal("pass");
        expect(verdict(findings, "safe:deployer-not-owner")).to.equal("pass");
      });

      it("fails an address with no code, a contract that is no Safe on mainnet, and a Safe that could not sign", async function () {
        const eoa = await preflight(parsed({ OPERATIONS_SAFE: ethers.Wallet.createRandom().address }));
        expect(verdict(eoa, "safe:operations")).to.equal("fail");
        expect(detail(eoa, "safe:operations")).to.include("has no code");

        const notSafe = parsed({ OPERATIONS_SAFE: await paxg.getAddress() });
        expect(verdict(await preflight(notSafe), "safe:operations")).to.equal("warn");
        const onMainnet = await preflight(notSafe, { provider: asMainnet(), expectedChainId: 1 });
        expect(verdict(onMainnet, "safe:operations")).to.equal("fail");
        expect(detail(onMainnet, "safe:operations")).to.include("cannot be confirmed to be a Safe");

        const owners = (await ethers.getSigners()).slice(14, 16).map((s) => s.address);
        const broken = await (await ethers.getContractFactory("MockSafe")).deploy(owners, 3);
        const findings = await preflight(parsed({ OPERATIONS_SAFE: await broken.getAddress() }));
        expect(verdict(findings, "safe:operations")).to.equal("fail");
        expect(detail(findings, "safe:operations")).to.include("exceeds its 2 owners");
      });

      it("fails an operations Safe that is a governance Safe or the deployer", async function () {
        for (const [role, governanceSafe] of [["proposer", proposer], ["executor", executor], ["guardian", guardian]] as const) {
          const findings = await preflight(parsed({ OPERATIONS_SAFE: await governanceSafe.getAddress() }));
          expect(verdict(findings, "safe:operations-distinct"), role).to.equal("fail");
          expect(detail(findings, "safe:operations-distinct"), role).to.include(`the ${role} Safe`);
        }
        const asDeployer = await preflight(parsed({ OPERATIONS_SAFE: DEPLOYER }));
        expect(verdict(asDeployer, "safe:operations-distinct")).to.equal("fail");
        expect(detail(asDeployer, "safe:operations-distinct")).to.include("the deployer");
      });
    });

    describe("the Safes as the record keeps them (readSafeRecords)", function () {
      it("records each Safe's threshold and owners, and an address that is no Safe without a policy", async function () {
        const env = parsed();
        const records = await readSafeRecords(ethers.provider, env);
        expect(records.map((r) => r.role)).to.deep.equal(["proposer", "executor", "guardian"]);
        expect(records[0]).to.deep.equal({ role: "proposer", address: env.proposers[0], threshold: (await proposer.getThreshold()).toString(), owners: [...(await proposer.getOwners())] });
        expect(records[1].threshold).to.equal((await executor.getThreshold()).toString());
        expect(safeRecordProblems(records, await readSafeRecords(ethers.provider, env))).to.deep.equal([]);

        const open = await readSafeRecords(ethers.provider, parsed({ TIMELOCK_EXECUTOR: ethers.ZeroAddress, ALLOW_OPEN_EXECUTOR: "1" }));
        expect(open[1]).to.deep.equal({ role: "executor", address: ethers.ZeroAddress });
        const notSafe = await readSafeRecords(ethers.provider, parsed({ TIMELOCK_GUARDIAN: await paxg.getAddress() }));
        expect(notSafe[2].threshold).to.equal(undefined);
        expect(notSafe[2].owners).to.equal(undefined);
        expect(notSafe[2].unreadable).to.be.a("string");
      });

      it("shows a Safe swapped for one with other owners as a change", async function () {
        const before = await readSafeRecords(ethers.provider, parsed());
        // Another Safe under the same role: the address the record holds is no longer the one wired.
        const other = await safe(2, 3, 16);
        const replaced = await readSafeRecords(ethers.provider, parsed({ TIMELOCK_PROPOSER: await other.getAddress() }));
        expect(safeRecordProblems(before, replaced)).to.have.length(2);
        // The same address answering with one owner swapped, as the chain would show after swapOwner.
        const swapped = before.map((r) => (r.role === "guardian" ? { ...r, owners: [...(r.owners ?? []).slice(0, 2), DEPLOYER] } : r));
        const problems = safeRecordProblems(before, swapped);
        expect(problems).to.have.length(1);
        expect(problems[0]).to.include("changed since the preflight");
        expect(problems[0]).to.include(DEPLOYER.toLowerCase());
      });
    });

    it("refuses an existing snapshot unless the overwrite is acknowledged", async function () {
      expect(verdict(await preflight(parsed(), { snapshotExists: true }), "snapshot")).to.equal("fail");
      expect(verdict(await preflight(parsed(), { snapshotExists: true, allowExistingSnapshot: true }), "snapshot")).to.equal("warn");
    });

    it("fails a deployer that cannot pay for the ceremony and warns about a used key", async function () {
      const poor = ethers.Wallet.createRandom();
      const env = parsed({ PRIVATE_KEY: poor.privateKey });
      const findings = await preflight(env);
      expect(verdict(findings, "deployer:balance")).to.equal("fail");
      expect(detail(findings, "deployer:balance")).to.include("short by");
      const used = await preflight(parsed());
      expect(verdict(used, "deployer:fresh")).to.equal("warn");
    });
  });
});
