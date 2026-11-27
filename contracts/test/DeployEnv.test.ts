import { expect } from "chai";
import { ethers } from "hardhat";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  BACKSTOP_REFUSED,
  buildPreflightRecord,
  DEFAULTS,
  MAINNET_MIN_DEBT,
  parsePreflightMaxAgeMinutes,
  PREFLIGHT_MAX_AGE_MINUTES,
  SafeRecord,
  safeRecordProblems,
  isMainnetProfile,
  LaunchParameters,
  mainnetLaunchProblems,
  PAXG_BACKSTOP_MAX,
  RETIRED_KEYS,
  XAUT_DORMANT_TEXT,
  XAUT_INACTIVE_FEED_TEXT,
  parameterHash,
  parameterRecord,
  parseLaunchParameters,
  parsePreflightRecord,
  preflightGateProblems,
  snapshotRecordMismatches,
  XAUT_ACTIVATION_KEYS,
  xautDormant,
} from "../scripts/lib/launchEnv";
import { roleSplit } from "../scripts/lib/preflight";
import { describeError, redactUrls } from "../scripts/lib/redact";

/**
 * The environment reading deploy.ts and the preflight share (scripts/lib/launchEnv.ts): the
 * same parser on both sides, the ceremony record it produces and the gate that refuses a
 * deploy whose environment the preflight never saw.
 */
describe("Launch environment shared by deploy.ts and the preflight (scripts/lib/launchEnv.ts)", function () {
  const addr = (n: number): string => ethers.getAddress(`0x${n.toString(16).padStart(40, "0")}`);
  const DEPLOYER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
  const baseEnv: NodeJS.ProcessEnv = {
    PAXG_TOKEN: addr(1),
    XAUT_TOKEN: addr(2),
    PAXG_FEED: addr(3),
    XAUT_FEED: addr(4),
    XAU_USD_ANCHOR_FEED: addr(8),
    TIMELOCK_PROPOSER: addr(10),
    TIMELOCK_EXECUTOR: ethers.ZeroAddress,
    TIMELOCK_GUARDIAN: addr(12),
  };
  /** The mainnet launch profile: no ceiling, no per-block cap, PAXG on Chainlink alone, XAUT dormant. */
  const open: NodeJS.ProcessEnv = { LAUNCH_CAPS: "open" };

  function params(overrides: NodeJS.ProcessEnv = {}): LaunchParameters {
    const { params: parsed, findings } = parseLaunchParameters({ ...baseEnv, ...overrides });
    if (!parsed) throw new Error(findings.map((f) => `${f.name}: ${f.detail}`).join("\n"));
    return parsed;
  }
  const failing = (overrides: NodeJS.ProcessEnv): string[] =>
    parseLaunchParameters({ ...baseEnv, ...overrides }).findings.filter((f) => f.verdict === "fail").map((f) => f.name);

  describe("parseLaunchParameters", function () {
    it("applies the documented defaults when a knob is unset", function () {
      const p = params();
      expect(p.launchCaps).to.equal("guarded");
      expect(p.stalenessThreshold).to.equal(90_000);
      expect(p.siloCap).to.equal(100n * 10n ** 18n);
      expect(p.paxg).to.deep.equal({ minRatio: 1_300_000, liqRatio: 1_100_000, liqPenalty: 50_000, debtCeiling: 0n, stabilityFeeBps: 200 });
      expect(p.minDebt).to.equal(ethers.parseEther("100"));
      expect(p.perBlockMintCap).to.equal(50_000n * 10n ** 18n);
      expect(p.badDebtPauseThreshold).to.equal(25_000n * 10n ** 18n);
      expect(p.lockSiloVaultRole).to.equal(true);
      expect(p.anchorFeed).to.equal(addr(8));
    });

    it("gives the open profile an unlimited PAXG ceiling, no per-block cap and a dormant XAUT", function () {
      const p = params(open);
      expect(p.launchCaps).to.equal("open");
      expect(p.paxg.debtCeiling).to.equal(ethers.MaxUint256);
      expect(p.perBlockMintCap).to.equal(0n);
      expect(p.xautActive).to.equal(false);
      expect(p.backstopRehearsal).to.equal(false);
      const record = parameterRecord(p);
      expect(record.PAXG_DEBT_CEILING).to.equal("unlimited");
      expect(record.PER_BLOCK_MINT_CAP).to.equal("0");
      expect(record.XAUT_STATUS).to.equal("dormant (oracle entry only)");
      expect(record.XAUT_DEBT_CEILING).to.equal(XAUT_DORMANT_TEXT);
      expect(record.PAXG_BACKSTOP_MAX).to.equal("not applicable");
      expect(params({ ...open, PAXG_DEBT_CEILING: "max" }).paxg.debtCeiling).to.equal(ethers.MaxUint256);
      expect(failing({ ...open, PER_BLOCK_MINT_CAP: "1" })).to.deep.equal(["policy:PER_BLOCK_MINT_CAP"]);
      expect(failing({ ...open, PER_BLOCK_MINT_CAP: "0" })).to.deep.equal([]);
      expect(failing({ LAUNCH_CAPS: "wide" })).to.include("policy:LAUNCH_CAPS");
    });

    it("refuses an explicit PAXG ceiling under the open profile unless it is unlimited", function () {
      const key = "PAXG_DEBT_CEILING";
      expect(failing({ ...open, [key]: "1000000000000000000000000" })).to.deep.equal([`policy:${key}`]);
      expect(failing({ ...open, [key]: "0" })).to.deep.equal([`policy:${key}`]);
      expect(failing({ ...open, [key]: ethers.MaxUint256.toString() })).to.deep.equal([]);
      expect(failing({ ...open, [key]: "unlimited" })).to.deep.equal([]);
      expect(params({ ...open, [key]: ethers.MaxUint256.toString() }).paxg.debtCeiling).to.equal(ethers.MaxUint256);
    });

    it("keeps XAUT dormant under the open profile: every activation key is refused", function () {
      for (const key of XAUT_ACTIVATION_KEYS) {
        const { params: parsed, findings } = parseLaunchParameters({ ...baseEnv, ...open, [key]: "1" });
        expect(parsed, key).to.equal(undefined);
        expect(findings.find((f) => f.name === `policy:${key}`)?.detail, key).to.include("XAUT is dormant under the open profile");
      }
    });

    it("needs no second PAXG source under the open profile and refuses the backstop's rehearsal stand-in", function () {
      expect(failing({ LAUNCH_CAPS: "open" })).to.deep.equal([]);
      expect(failing({ ...open, PAXG_BACKSTOP_REHEARSAL_MAX: "1" })).to.deep.equal(["env:PAXG_BACKSTOP_REHEARSAL_MAX"]);
    });

    it("treats XAUT as dormant under open and backstop and active under guarded only", function () {
      expect(xautDormant("open")).to.equal(true);
      expect(xautDormant("backstop")).to.equal(true);
      expect(xautDormant("guarded")).to.equal(false);
    });

    it("leaves an explicit ceiling and the per-block cap alone under the guarded profile", function () {
      expect(failing({ LAUNCH_CAPS: "guarded", PAXG_DEBT_CEILING: "500000000000000000000000" })).to.deep.equal([]);
      expect(failing({ PAXG_DEBT_CEILING: "0", XAUT_DEBT_CEILING: "0" })).to.deep.equal([]);
      expect(failing({ PER_BLOCK_MINT_CAP: "1000" })).to.deep.equal([]);
    });

    it("trims comma lists so deploy.ts never hands a spaced address to the ABI encoder", function () {
      const p = params({ TIMELOCK_PROPOSER: ` ${addr(10)} , ${addr(11)}, `, TIMELOCK_EXECUTOR: `${addr(13)} ,${ethers.ZeroAddress}` });
      expect(p.proposers).to.deep.equal([addr(10), addr(11)]);
      expect(p.executors).to.deep.equal([addr(13), ethers.ZeroAddress]);
      expect(() => ethers.AbiCoder.defaultAbiCoder().encode(["address[]"], [p.proposers])).to.not.throw();
    });

    it("refuses the zero guardian before any contract is created", function () {
      const names = failing({ TIMELOCK_GUARDIAN: ethers.ZeroAddress });
      expect(names).to.include("env:TIMELOCK_GUARDIAN");
      const { findings } = parseLaunchParameters({ ...baseEnv, TIMELOCK_GUARDIAN: ethers.ZeroAddress });
      expect(findings.find((f) => f.name === "env:TIMELOCK_GUARDIAN")?.detail).to.include("grantGuardianRole");
    });

    it("refuses an empty string where the old scripts read zero", function () {
      expect(failing({ SILO_CAP: "" })).to.include("env:SILO_CAP");
      expect(failing({ MIN_GSUSD_RESERVE: " " })).to.include("env:MIN_GSUSD_RESERVE");
      expect(failing({ XAU_USD_ANCHOR_FEED: "" })).to.include("env:XAU_USD_ANCHOR_FEED");
      expect(failing({ TIMELOCK_PROPOSER: " , " })).to.include("env:TIMELOCK_PROPOSER");
    });

    it("leaves the anchor unset only when the variable is absent", function () {
      const { XAU_USD_ANCHOR_FEED: _unused, ...withoutAnchor } = baseEnv;
      void _unused;
      const parsed = parseLaunchParameters(withoutAnchor);
      expect(parsed.params?.anchorFeed).to.equal("");
      expect(parameterRecord(parsed.params as LaunchParameters).XAU_USD_ANCHOR_FEED).to.include("unset");
    });

    it("refuses the zero address as the anchor, which would look configured and check nothing", function () {
      expect(failing({ XAU_USD_ANCHOR_FEED: ethers.ZeroAddress })).to.include("env:XAU_USD_ANCHOR_FEED");
    });

    it("refuses duplicate or zero tokens and feeds, which the oracle constructor would reject", function () {
      expect(failing({ XAUT_TOKEN: addr(1) })).to.include("env:XAUT_TOKEN");
      expect(failing({ PAXG_FEED: ethers.ZeroAddress })).to.include("env:PAXG_FEED");
      expect(failing({ PAXG_TOKEN: "0xabc" })).to.include("env:PAXG_TOKEN");
    });

    it("bounds minDebt, the silo cap and the ratios by the setters' ranges", function () {
      expect(failing({ MIN_DEBT_GSUSD: "10000.000000000000000001" })).to.include("env:MIN_DEBT_GSUSD");
      expect(failing({ MIN_DEBT_GSUSD: "1e3" })).to.include("env:MIN_DEBT_GSUSD");
      expect(failing({ SILO_CAP: "0" })).to.include("env:SILO_CAP");
      // Below 0.01 oz the cap floors to zero for a 6-decimal token.
      expect(failing({ SILO_CAP: "9999999999999999" })).to.include("env:SILO_CAP");
      expect(failing({ SILO_CAP: "1000000000000" })).to.include("env:SILO_CAP");
      expect(params({ SILO_CAP: "10000000000000000" }).siloCap).to.equal(10n ** 16n);
      expect(failing({ XAUT_MIN_RATIO: "1000000", XAUT_LIQ_RATIO: "1000000" })).to.include("env:XAUT_MIN_RATIO");
      expect(failing({ SILO_LOCK_VAULT_ROLE: "no" })).to.include("env:SILO_LOCK_VAULT_ROLE");
      expect(params({ SILO_LOCK_VAULT_ROLE: "false" }).lockSiloVaultRole).to.equal(false);
    });
  });

  describe("retired oracle variables and the liquidation cap", function () {
    it("refuses every variable of the retired pool design, under every profile, rather than ignoring it", function () {
      expect([...RETIRED_KEYS]).to.deep.equal(["PAXG_CONFIRM_FEED", "XAUT_CONFIRM_FEED", "PAXG_AGREEMENT_BAND_PPM", "MARKET_FEEDS"]);
      for (const profile of [{}, open]) {
        for (const key of RETIRED_KEYS) {
          const { params: parsed, findings } = parseLaunchParameters({ ...baseEnv, ...profile, [key]: key.endsWith("_FEED") ? addr(5) : "1" });
          expect(parsed, key).to.equal(undefined);
          expect(findings.find((f) => f.name === `env:${key}`)?.detail, key).to.include("retired");
        }
      }
      expect(failing({ PAXG_CONFIRM_FEED: "" })).to.include("env:PAXG_CONFIRM_FEED");
    });

    it("defaults the liquidation cap to 2%, records it and bounds it by GoldOracle's setter", function () {
      const p = params();
      expect(p.paxgLiquidationClampPpm).to.equal(20_000n);
      expect(parameterRecord(p).PAXG_LIQUIDATION_CLAMP_PPM).to.equal("20000");
      expect(params({ PAXG_LIQUIDATION_CLAMP_PPM: "5000" }).paxgLiquidationClampPpm).to.equal(5_000n);
      expect(params({ PAXG_LIQUIDATION_CLAMP_PPM: "50000" }).paxgLiquidationClampPpm).to.equal(50_000n);
      expect(failing({ PAXG_LIQUIDATION_CLAMP_PPM: "4999" })).to.deep.equal(["env:PAXG_LIQUIDATION_CLAMP_PPM"]);
      expect(failing({ PAXG_LIQUIDATION_CLAMP_PPM: "50001" })).to.deep.equal(["env:PAXG_LIQUIDATION_CLAMP_PPM"]);
      expect(failing({ PAXG_LIQUIDATION_CLAMP_PPM: "" })).to.deep.equal(["env:PAXG_LIQUIDATION_CLAMP_PPM"]);
    });

    it("requires the cap below the headroom the liquidation ratio leaves above par", function () {
      // 105% leaves 50,000 ppm: a 5% cap is refused, 4.5% accepted.
      const tight = { PAXG_MIN_RATIO: "1300000", PAXG_LIQ_RATIO: "1050000" };
      expect(failing({ ...tight, PAXG_LIQUIDATION_CLAMP_PPM: "50000" })).to.deep.equal(["env:PAXG_LIQUIDATION_CLAMP_PPM"]);
      expect(failing({ ...tight, PAXG_LIQUIDATION_CLAMP_PPM: "45000" })).to.deep.equal([]);
      const { findings } = parseLaunchParameters({ ...baseEnv, ...tight, PAXG_LIQUIDATION_CLAMP_PPM: "50000" });
      expect(findings.find((f) => f.name === "env:PAXG_LIQUIDATION_CLAMP_PPM")?.detail).to.include("50000 ppm headroom");
    });

    it("changes the ceremony hash when the liquidation cap changes", function () {
      const base = parameterHash(parameterRecord(params()));
      expect(parameterHash(parameterRecord(params({ PAXG_LIQUIDATION_CLAMP_PPM: "25000" })))).to.not.equal(base);
    });
  });

  describe("feeds and the anchor", function () {
    it("refuses a token feed that is the XAU/USD anchor under every profile, which GoldOracle.setAnchorFeed would revert on", function () {
      for (const profile of [{}, open, { LAUNCH_CAPS: "backstop", PAXG_DEBT_CEILING: "1" }]) {
        expect(failing({ ...profile, PAXG_FEED: addr(8) }), JSON.stringify(profile)).to.include("env:PAXG_FEED");
        expect(failing({ ...profile, XAUT_FEED: addr(8) }), JSON.stringify(profile)).to.include("env:XAUT_FEED");
      }
      const { findings } = parseLaunchParameters({ ...baseEnv, XAUT_FEED: addr(8) });
      expect(findings.find((f) => f.name === "env:XAUT_FEED")?.detail).to.include("test mocks must be distinct contracts");
      // Without an anchor there is nothing to collide with (local deployments only).
      const { XAU_USD_ANCHOR_FEED: _anchor, ...noAnchor } = baseEnv;
      void _anchor;
      expect(parseLaunchParameters({ ...noAnchor, XAUT_FEED: addr(3) }).params?.xautFeed).to.equal(addr(3));
    });

    it("requires XAUT_FEED while XAUT is active and leaves it to deploy.ts under open and backstop", function () {
      expect(failing({ XAUT_FEED: undefined })).to.deep.equal(["env:XAUT_FEED"]);
      expect(failing({ LAUNCH_CAPS: "guarded", XAUT_FEED: undefined })).to.deep.equal(["env:XAUT_FEED"]);
      for (const profile of [open, { LAUNCH_CAPS: "backstop", PAXG_DEBT_CEILING: "1" }]) {
        const dormant = params({ ...profile, XAUT_FEED: undefined });
        expect(dormant.xautFeed, String(profile.LAUNCH_CAPS)).to.equal("");
        expect(parameterRecord(dormant).XAUT_FEED, String(profile.LAUNCH_CAPS)).to.equal(XAUT_INACTIVE_FEED_TEXT);
      }
    });

  });

  describe("the backstop profile: PAXG-first, XAUT dormant, forks and local rehearsals only", function () {
    // A rehearsal stand-in for the maximum. The profile parses for forks and local rehearsals;
    // mainnet refuses it outright (the gate below), PAXG_BACKSTOP_MAX predating variant C.
    const MAX = 2_000_000n * 10n ** 18n;
    const backstop: NodeJS.ProcessEnv = {
      LAUNCH_CAPS: "backstop",
      PAXG_DEBT_CEILING: (1_000_000n * 10n ** 18n).toString(),
      PAXG_BACKSTOP_REHEARSAL_MAX: MAX.toString(),
      XAUT_FEED: undefined, // unset: deploy.ts registers XAUT on an InactiveFeed it creates
    };

    it("takes the maximum from the economic model: 5,000,000 GSUSD (section 14.1 item 6)", function () {
      expect(PAXG_BACKSTOP_MAX).to.equal(5_000_000n * 10n ** 18n);
      const { PAXG_BACKSTOP_REHEARSAL_MAX: _stand, ...modelledOnly } = backstop;
      void _stand;
      const p = params(modelledOnly);
      expect(p.paxgBackstopMax).to.equal(PAXG_BACKSTOP_MAX);
      expect(p.backstopRehearsal).to.equal(false);
      expect(parameterRecord(p).PAXG_BACKSTOP_MAX).to.equal(PAXG_BACKSTOP_MAX.toString());
      expect(failing({ ...modelledOnly, PAXG_DEBT_CEILING: PAXG_BACKSTOP_MAX.toString() })).to.deep.equal([]);
      expect(failing({ ...modelledOnly, PAXG_DEBT_CEILING: (PAXG_BACKSTOP_MAX + 1n).toString() })).to.deep.equal(["policy:PAXG_DEBT_CEILING"]);
    });

    it("reads PAXG under the backstop and XAUT dormant, and records both plainly", function () {
      const p = params(backstop);
      expect(p.launchCaps).to.equal("backstop");
      expect(p.xautActive).to.equal(false);
      expect(p.paxg.debtCeiling).to.equal(1_000_000n * 10n ** 18n);
      expect(p.xaut.debtCeiling).to.equal(0n);
      expect(p.paxgBackstopMax).to.equal(MAX);
      expect(p.backstopRehearsal).to.equal(true);
      expect(p.xautFeed).to.equal("");
      expect(p.perBlockMintCap).to.equal(50_000n * 10n ** 18n);
      const record = parameterRecord(p);
      expect(record.XAUT_STATUS).to.equal("dormant (oracle entry only)");
      expect(record.XAUT_FEED).to.equal(XAUT_INACTIVE_FEED_TEXT);
      expect(record.XAUT_DEBT_CEILING).to.equal(XAUT_DORMANT_TEXT);
      expect(record.XAUT_MIN_RATIO).to.equal(XAUT_DORMANT_TEXT);
      expect(record.RESERVE_MIN_RESERVE_XAUT).to.equal(XAUT_DORMANT_TEXT);
      expect(record.PAXG_BACKSTOP_MAX).to.equal(`${MAX} (rehearsal stand-in)`);
      expect(parameterRecord(params()).PAXG_BACKSTOP_MAX).to.equal("not applicable");
      expect(parameterRecord(params()).XAUT_STATUS).to.equal("active");
    });

    it("requires a finite PAXG ceiling above zero and at most the maximum", function () {
      expect(failing({ ...backstop, PAXG_DEBT_CEILING: undefined })).to.include("policy:PAXG_DEBT_CEILING");
      expect(failing({ ...backstop, PAXG_DEBT_CEILING: "0" })).to.include("policy:PAXG_DEBT_CEILING");
      expect(failing({ ...backstop, PAXG_DEBT_CEILING: "unlimited" })).to.include("policy:PAXG_DEBT_CEILING");
      expect(failing({ ...backstop, PAXG_DEBT_CEILING: (MAX + 1n).toString() })).to.include("policy:PAXG_DEBT_CEILING");
      expect(failing({ ...backstop, PAXG_DEBT_CEILING: "1e24" })).to.include("env:PAXG_DEBT_CEILING");
      expect(failing({ ...backstop, PAXG_DEBT_CEILING: MAX.toString() })).to.deep.equal([]);
      expect(failing({ ...backstop, PAXG_DEBT_CEILING: "" })).to.include("env:PAXG_DEBT_CEILING");
    });

    it("refuses every variable that would configure XAUT beyond its oracle entry", function () {
      const cases: NodeJS.ProcessEnv = {
        XAUT_DEBT_CEILING: "0",
        XAUT_MIN_RATIO: "1300000",
        XAUT_LIQ_RATIO: "1100000",
        XAUT_LIQ_PENALTY: "50000",
        XAUT_STABILITY_FEE_BPS: "200",
        RESERVE_MIN_RESERVE_XAUT: "0",
      };
      for (const [key, value] of Object.entries(cases)) {
        expect(failing({ ...backstop, [key]: value }), key).to.deep.equal([`policy:${key}`]);
      }
    });

    it("requires the per-block cap and keeps the rehearsal stand-in to backstop", function () {
      expect(failing({ ...backstop, PER_BLOCK_MINT_CAP: "0" })).to.deep.equal(["policy:PER_BLOCK_MINT_CAP"]);
      expect(failing({ PAXG_BACKSTOP_REHEARSAL_MAX: "1" })).to.deep.equal(["env:PAXG_BACKSTOP_REHEARSAL_MAX"]);
      expect(failing({ ...backstop, PAXG_BACKSTOP_REHEARSAL_MAX: "0" })).to.include("env:PAXG_BACKSTOP_REHEARSAL_MAX");
    });

    it("keeps guarded working with XAUT active for testnets and the end-to-end harness", function () {
      const e2e = params({ PAXG_DEBT_CEILING: "1000000000000000000000000", XAUT_DEBT_CEILING: "1000000000000000000000000", MIN_GSUSD_RESERVE: "0" });
      expect(e2e.xautActive).to.equal(true);
      expect(e2e.xaut.debtCeiling).to.equal(10n ** 24n);
      expect(failing({ LAUNCH_CAPS: "wide" })).to.include("policy:LAUNCH_CAPS");
    });
  });

  describe(".env.mainnet.example", function () {
    /** The example as the shell would load it, every angle-bracket placeholder filled with a stand-in. */
    function exampleEnv(): NodeJS.ProcessEnv {
      const text = readFileSync(resolve(__dirname, "..", ".env.mainnet.example"), "utf8");
      const env: NodeJS.ProcessEnv = {};
      let filler = 40;
      for (const line of text.split("\n")) {
        const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
        if (!match) continue;
        const [, key, raw] = match;
        const value = raw.replace(/^"(.*)"$/, "$1");
        if (!value.startsWith("<")) env[key] = value;
        else if (key === "PAXG_DEBT_CEILING") env[key] = (1_000_000n * 10n ** 18n).toString();
        else env[key] = addr(filler++);
      }
      return env;
    }

    it("is the PAXG-first open launch: no debt ceiling, no per-block cap, XAUT dormant on an InactiveFeed, band and clamp 2%", function () {
      // Parsed on its own: the shared base environment must not leak into the example.
      const { params: parsed, findings } = parseLaunchParameters(exampleEnv());
      expect(findings.filter((f) => f.verdict === "fail")).to.deep.equal([]);
      const p = parsed as LaunchParameters;
      expect(p.launchCaps).to.equal("open");
      expect(p.paxg.debtCeiling).to.equal(ethers.MaxUint256);
      expect(p.perBlockMintCap).to.equal(0n);
      expect(p.backstopRehearsal).to.equal(false);
      expect(p.xautActive).to.equal(false);
      expect(p.xautFeed).to.equal("");
      expect(p.paxgGoldBandPpm).to.equal(20_000n);
      expect(p.paxgLiquidationClampPpm).to.equal(20_000n);
      expect(mainnetLaunchProblems(p)).to.deep.equal([]);
    });

    it("keeps MIN_GSUSD_RESERVE at 0 and says the 2% reserve floor is automatic, the figure SurplusBuffer holds", function () {
      expect(exampleEnv().MIN_GSUSD_RESERVE).to.equal("0");
      const text = readFileSync(resolve(__dirname, "..", ".env.mainnet.example"), "utf8");
      const block = text.slice(0, text.indexOf("MIN_GSUSD_RESERVE=0"));
      const comment = block.slice(block.lastIndexOf("STALENESS_THRESHOLD="));
      expect(comment).to.include("automatic");
      expect(comment).to.include("optional higher");
      expect(comment).to.not.include("raised toward 3%");
      // The floor is the contract's constant, in basis points; the template must state that figure and no other.
      const source = readFileSync(resolve(__dirname, "..", "src", "core", "SurplusBuffer.sol"), "utf8");
      const floorBps = Number(/AUTO_FLOOR_BPS = (\d+);/.exec(source)?.[1]);
      expect(floorBps).to.equal(200);
      expect(comment).to.include(`The ${floorBps / 100}% reserve floor is automatic: SurplusBuffer keeps ${floorBps / 100}% of`);
      expect(comment).to.not.include("3%");
    });

    it("lists every default with the value the parser applies", function () {
      const text = readFileSync(resolve(__dirname, "..", ".env.mainnet.example"), "utf8");
      const commented = (key: string): string | undefined => new RegExp(`^# ${key}=(\\S+)`, "m").exec(text)?.[1];
      const expected: Record<string, string> = {
        SILO_CAP: DEFAULTS.siloCap.toString(),
        PAXG_MIN_RATIO: String(DEFAULTS.minRatio),
        PAXG_LIQ_RATIO: String(DEFAULTS.liqRatio),
        PAXG_LIQ_PENALTY: String(DEFAULTS.liqPenalty),
        PAXG_STABILITY_FEE_BPS: String(DEFAULTS.stabilityFeeBps),
        BAD_DEBT_PAUSE_THRESHOLD: DEFAULTS.badDebtPauseThreshold.toString(),
        RESERVE_PENALTY_SHARE_BPS: DEFAULTS.reservePenaltyShareBps.toString(),
        ORIGINATION_FEE_BPS: DEFAULTS.originationFeeBps.toString(),
        UNDERWATER_DISCOUNT_PPM: DEFAULTS.underwaterDiscountPpm.toString(),
        RESERVE_DAILY_CAP_PPM: DEFAULTS.reserveDailyCapPpm.toString(),
        RESERVE_MIN_RESERVE_PAXG: DEFAULTS.reserveMinReserve.toString(),
        RESERVE_AGGREGATE_DAILY_CAP_USD: DEFAULTS.reserveAggregateDailyCapUsd.toString(),
        // The preflight prints both as param lines, so the template names them too.
        MIN_COLLATERAL_RESERVE: DEFAULTS.minCollateralReserve.toString(),
        SILO_LOCK_VAULT_ROLE: String(parseLaunchParameters(exampleEnv()).params?.lockSiloVaultRole),
      };
      for (const [key, value] of Object.entries(expected)) expect(commented(key), key).to.equal(value);
      const env = exampleEnv();
      expect(env.STALENESS_THRESHOLD).to.equal(String(DEFAULTS.stalenessThreshold));
      expect(env.PAXG_GOLD_BAND_PPM).to.equal(DEFAULTS.paxgGoldBandPpm.toString());
      expect(env.PAXG_LIQUIDATION_CLAMP_PPM).to.equal(DEFAULTS.paxgLiquidationClampPpm.toString());
      expect(ethers.parseEther(env.MIN_DEBT_GSUSD ?? "0")).to.equal(MAINNET_MIN_DEBT);
      expect(text).to.include(`good for ${PREFLIGHT_MAX_AGE_MINUTES} minutes`);
    });

    it("offers no profile the preflight refuses: backstop is described as refused on mainnet and never as an alternative", function () {
      const text = readFileSync(resolve(__dirname, "..", ".env.mainnet.example"), "utf8");
      expect(text).to.include("LAUNCH_CAPS=backstop is refused on mainnet");
      expect(text).to.not.include("accepted alternative");
      expect(text).to.not.include("To launch under it");
      // No line, commented or not, sets the backstop profile or a ceiling.
      expect(/^#?\s*LAUNCH_CAPS=backstop\s*$/m.test(text)).to.equal(false);
      expect(/^#?\s*PAXG_DEBT_CEILING=/m.test(text)).to.equal(false);
      const env = exampleEnv();
      expect(env.LAUNCH_CAPS).to.equal("open");
      expect(env.PAXG_DEBT_CEILING).to.equal(undefined);
    });

    it("names the operations Safe, which the preflight checks and the parameters hash ignores", function () {
      const env = exampleEnv();
      expect(env.OPERATIONS_SAFE).to.match(/^0x[0-9a-fA-F]{40}$/);
      const withSafe = parseLaunchParameters(env).params as LaunchParameters;
      const { OPERATIONS_SAFE: _unset, ...without } = env;
      const withoutSafe = parseLaunchParameters(without).params as LaunchParameters;
      expect(parameterHash(parameterRecord(withSafe))).to.equal(parameterHash(parameterRecord(withoutSafe)));
    });

    it("carries no variable of the retired pool design", function () {
      const env = exampleEnv();
      for (const key of RETIRED_KEYS) expect(env[key], key).to.equal(undefined);
      expect(Object.keys(env).some((key) => key.includes("TWAP") || key.includes("PYTH"))).to.equal(false);
    });
  });

  describe("PAXG's gold band", function () {
    it("defaults to the oracle's 2% gold band", function () {
      const p = params();
      expect(p.paxgGoldBandPpm).to.equal(20_000n);
      expect(parameterRecord(p).PAXG_GOLD_BAND_PPM).to.equal("20000");
    });

    it("bounds the band by GoldOracle's setter", function () {
      expect(params({ PAXG_GOLD_BAND_PPM: "5000" }).paxgGoldBandPpm).to.equal(5_000n);
      expect(params({ PAXG_GOLD_BAND_PPM: "100000" }).paxgGoldBandPpm).to.equal(100_000n);
      expect(failing({ PAXG_GOLD_BAND_PPM: "4999" })).to.deep.equal(["env:PAXG_GOLD_BAND_PPM"]);
      expect(failing({ PAXG_GOLD_BAND_PPM: "100001" })).to.deep.equal(["env:PAXG_GOLD_BAND_PPM"]);
    });
  });

  describe("the mainnet launch gate in deploy.ts", function () {
    // A restricted executor Safe: the shared base environment's open executor is refused on
    // mainnet without ALLOW_OPEN_EXECUTOR=1, which has its own case below.
    const launchable: NodeJS.ProcessEnv = { ...open, XAUT_FEED: undefined, MIN_DEBT_GSUSD: "1000", TIMELOCK_EXECUTOR: addr(11) };
    const backstop: NodeJS.ProcessEnv = {
      LAUNCH_CAPS: "backstop",
      PAXG_DEBT_CEILING: (5_000_000n * 10n ** 18n).toString(),
      XAUT_FEED: undefined,
      MIN_DEBT_GSUSD: "1000",
      TIMELOCK_EXECUTOR: addr(11),
    };
    const modelled = (): LaunchParameters => params(launchable);

    it("passes the open launch: PAXG uncapped on Chainlink alone, with XAUT dormant on an InactiveFeed deploy.ts creates", function () {
      expect(modelled().xautFeed).to.equal("");
      expect(mainnetLaunchProblems(modelled())).to.deep.equal([]);
    });

    it("refuses the Sepolia minimum debt: the mainnet launch opens at 1000 GSUSD", function () {
      const problems = mainnetLaunchProblems(params({ ...launchable, MIN_DEBT_GSUSD: undefined }));
      expect(problems).to.have.length(1);
      expect(problems[0]).to.include("MIN_DEBT_GSUSD is 100.0");
      expect(problems[0]).to.include("set MIN_DEBT_GSUSD=1000");
      expect(mainnetLaunchProblems(params({ ...launchable, MIN_DEBT_GSUSD: "5000" }))[0]).to.include("MIN_DEBT_GSUSD is 5000.0");
    });

    it("refuses the backstop: open is the only mainnet profile, the backstop maximum predating variant C", function () {
      expect(mainnetLaunchProblems(params(backstop))).to.deep.equal([BACKSTOP_REFUSED]);
      expect(BACKSTOP_REFUSED).to.include("retired pool design");
      expect(isMainnetProfile("backstop")).to.equal(false);
      expect(isMainnetProfile("open")).to.equal(true);
    });

    it("refuses an open launch that carries a PAXG ceiling or a per-block cap behind the parser", function () {
      expect(mainnetLaunchProblems({ ...modelled(), paxg: { ...modelled().paxg, debtCeiling: 1n } })[0]).to.include("PAXG_DEBT_CEILING");
      expect(mainnetLaunchProblems({ ...modelled(), perBlockMintCap: 1n })[0]).to.include("PER_BLOCK_MINT_CAP");
    });

    it("refuses the guarded profile and a rehearsal stand-in", function () {
      expect(mainnetLaunchProblems(params()).some((m) => m.startsWith("LAUNCH_CAPS=guarded"))).to.equal(true);
      expect(mainnetLaunchProblems(params({ ...backstop, PAXG_DEBT_CEILING: "1000", PAXG_BACKSTOP_REHEARSAL_MAX: "1000" }))).to.deep.equal([
        BACKSTOP_REFUSED,
        "PAXG_BACKSTOP_REHEARSAL_MAX is set: a rehearsal stand-in for the modelled backstop maximum can never reach mainnet",
      ]);
    });

    // An open executor
    // lets anyone choose when a matured operation runs, so mainnet takes it only when accepted.
    it("refuses an open executor on mainnet unless ALLOW_OPEN_EXECUTOR=1 accepts it", function () {
      const openExecutor = mainnetLaunchProblems(params({ ...launchable, TIMELOCK_EXECUTOR: ethers.ZeroAddress }));
      expect(openExecutor).to.have.length(1);
      expect(openExecutor[0]).to.include("TIMELOCK_EXECUTOR includes the zero address");
      expect(openExecutor[0]).to.include("ALLOW_OPEN_EXECUTOR=1");
      expect(mainnetLaunchProblems(params({ ...launchable, TIMELOCK_EXECUTOR: `${addr(13)},${ethers.ZeroAddress}` }))[0]).to.include("TIMELOCK_EXECUTOR");
      expect(mainnetLaunchProblems(params({ ...launchable, TIMELOCK_EXECUTOR: ethers.ZeroAddress, ALLOW_OPEN_EXECUTOR: "1" }))).to.deep.equal([]);
      // Outside mainnet the parser still takes the open executor without the acceptance.
      expect(params().executors).to.deep.equal([ethers.ZeroAddress]);
      expect(params().allowOpenExecutor).to.equal(false);
      expect(failing({ ALLOW_OPEN_EXECUTOR: "yes" })).to.deep.equal(["env:ALLOW_OPEN_EXECUTOR"]);
    });

    it("refuses a missing anchor, PAXG on the anchor and an active XAUT", function () {
      const base = modelled();
      expect(mainnetLaunchProblems({ ...base, anchorFeed: "" })[0]).to.include("XAU_USD_ANCHOR_FEED is unset");
      expect(mainnetLaunchProblems({ ...base, paxgFeed: base.anchorFeed })[0]).to.include("PAXG_FEED is the XAU/USD anchor");
      expect(mainnetLaunchProblems({ ...base, xautActive: true })[0]).to.include("XAUT is active");
      expect(mainnetLaunchProblems({ ...base, xautFeed: base.anchorFeed })[0]).to.include("XAUT_FEED is the XAU/USD anchor");
    });
  });

  describe("the ceremony record and its hash", function () {
    it("is the same on both sides of the ceremony for the same environment", function () {
      const fromPreflight = parameterRecord(params({ ...open, MIN_DEBT_GSUSD: "1000" }));
      const fromDeploy = parameterRecord(params({ ...open, MIN_DEBT_GSUSD: "1000" }));
      expect(parameterHash(fromDeploy)).to.equal(parameterHash(fromPreflight));
      expect(fromPreflight.MIN_DEBT_WEI).to.equal(ethers.parseEther("1000").toString());
      expect(fromPreflight.PAXG_DEBT_CEILING).to.equal("unlimited");
      expect(Object.keys(fromPreflight)).to.deep.equal([...Object.keys(fromPreflight)].sort());
    });

    it("changes when any knob changes, including one that is not in the snapshot", function () {
      const base = parameterHash(parameterRecord(params()));
      expect(parameterHash(parameterRecord(params({ PAXG_LIQ_PENALTY: "60000" })))).to.not.equal(base);
      expect(parameterHash(parameterRecord(params({ BAD_DEBT_PAUSE_THRESHOLD: "1" })))).to.not.equal(base);
      expect(parameterHash(parameterRecord(params({ TIMELOCK_PROPOSER: `${addr(10)},${addr(11)}` })))).to.not.equal(base);
    });

    it("round-trips through the file the preflight writes", function () {
      const safes: SafeRecord[] = [{ role: "proposer", address: addr(10), threshold: "2", owners: [addr(71), addr(72), addr(73)] }];
      const record = buildPreflightRecord({ network: "mainnet", chainId: 1, deployer: DEPLOYER, deployerNonce: 0, createdAt: "2026-10-24T00:00:00.000Z", chainTime: 1_793_000_000, safes, operationsSafe: addr(60), params: params(), findings: [] });
      const parsed = parsePreflightRecord(JSON.stringify(record));
      expect(parsed.parametersHash).to.equal(parameterHash(parsed.parameters));
      expect(parsed.deployerNonce).to.equal(0);
      expect(parsed.chainTime).to.equal(1_793_000_000);
      expect(parsed.safes).to.deep.equal(safes);
      expect(parsed.operationsSafe).to.equal(addr(60));
      expect(() => parsePreflightRecord(JSON.stringify({ ...record, schema: "other" }))).to.throw("schema");
    });
  });

  describe("the gate in deploy.ts", function () {
    /** The chain's clock when the preflight passed, and the three Safes as it read them. */
    const PREFLIGHT_TIME = 1_793_000_000;
    const SAFES: SafeRecord[] = [
      { role: "proposer", address: addr(10), threshold: "2", owners: [addr(71), addr(72), addr(73)] },
      { role: "executor", address: addr(11), threshold: "1", owners: [addr(74)] },
      { role: "guardian", address: addr(12), threshold: "2", owners: [addr(75), addr(76), addr(77)] },
    ];
    const record = (p: LaunchParameters, chainId = 1, deployer = DEPLOYER) =>
      buildPreflightRecord({ network: "mainnet", chainId, deployer, deployerNonce: 0, createdAt: "2026-10-24T00:00:00.000Z", chainTime: PREFLIGHT_TIME, safes: SAFES, params: p, findings: [] });
    /** A fresh ceremony from a single-use key, the nonce the preflight recorded, ten minutes later with the Safes untouched. */
    const fresh = { deployerNonce: 0, resuming: false, chainTime: PREFLIGHT_TIME + 600, maxAgeMinutes: PREFLIGHT_MAX_AGE_MINUTES, safes: SAFES };

    it("refuses a mainnet deploy with no record and allows a rehearsal without one", function () {
      const p = params();
      expect(preflightGateProblems({ record: undefined, params: p, chainId: 1, deployer: DEPLOYER, mandatory: true, ...fresh })).to.have.length(1);
      expect(preflightGateProblems({ record: undefined, params: p, chainId: 31337, deployer: DEPLOYER, mandatory: false, ...fresh })).to.deep.equal([]);
    });

    it("passes when the environment is exactly what the preflight saw", function () {
      const p = params(open);
      expect(preflightGateProblems({ record: record(p), params: p, chainId: 1, deployer: DEPLOYER, mandatory: true, ...fresh })).to.deep.equal([]);
    });

    it("names the knob that changed between the preflight and the deploy", function () {
      const seen = record(params());
      const problems = preflightGateProblems({ record: seen, params: params({ PAXG_LIQ_PENALTY: "60000" }), chainId: 1, deployer: DEPLOYER, mandatory: true, ...fresh });
      expect(problems).to.have.length(1);
      expect(problems[0]).to.include("PAXG_LIQ_PENALTY");
    });

    it("refuses an edited record, another chain and another deployer, wherever the record exists", function () {
      const p = params();
      const edited = { ...record(p), parameters: { ...parameterRecord(p), PAXG_LIQ_PENALTY: "1" } };
      expect(preflightGateProblems({ record: edited, params: p, chainId: 1, deployer: DEPLOYER, mandatory: true, ...fresh }).some((m) => m.includes("edited"))).to.equal(true);
      expect(preflightGateProblems({ record: record(p, 11155111), params: p, chainId: 1, deployer: DEPLOYER, mandatory: true, ...fresh }).some((m) => m.includes("chain"))).to.equal(true);
      expect(preflightGateProblems({ record: record(p, 31337, addr(99)), params: p, chainId: 31337, deployer: DEPLOYER, mandatory: false, ...fresh }).some((m) => m.includes("signs as"))).to.equal(true);
    });

    it("refuses a record replayed after the deployer has sent anything, unless a stopped ceremony is resuming", function () {
      const p = params(open);
      const replayed = preflightGateProblems({ record: record(p), params: p, chainId: 1, deployer: DEPLOYER, mandatory: true, ...fresh, deployerNonce: 47 });
      expect(replayed).to.have.length(1);
      expect(replayed[0]).to.include("nonce is 47, the preflight saw 0");
      expect(preflightGateProblems({ record: record(p), params: p, chainId: 1, deployer: DEPLOYER, mandatory: true, ...fresh, deployerNonce: 30, resuming: true })).to.deep.equal([]);
      // On a rehearsal the record is held to its nonce wherever it exists.
      expect(preflightGateProblems({ record: record(p, 31337), params: p, chainId: 31337, deployer: DEPLOYER, mandatory: false, ...fresh, deployerNonce: 3 })).to.have.length(1);
    });

    it("refuses on mainnet a record written before it carried the deployer nonce, and accepts one elsewhere", function () {
      const p = params(open);
      const older = { ...record(p), deployerNonce: undefined };
      expect(preflightGateProblems({ record: older, params: p, chainId: 1, deployer: DEPLOYER, mandatory: true, ...fresh })[0]).to.include("no deployer nonce");
      expect(preflightGateProblems({ record: { ...older, chainId: 31337 }, params: p, chainId: 31337, deployer: DEPLOYER, mandatory: false, ...fresh, deployerNonce: 9 })).to.deep.equal([]);
    });

    it("refuses a record older than the limit by the chain's clock, and one stamped ahead of the chain", function () {
      const p = params(open);
      const gate = { record: record(p), params: p, chainId: 1, deployer: DEPLOYER, mandatory: true, ...fresh };
      expect(PREFLIGHT_MAX_AGE_MINUTES).to.equal(60);
      expect(preflightGateProblems({ ...gate, chainTime: PREFLIGHT_TIME + 3600 })).to.deep.equal([]);
      const old = preflightGateProblems({ ...gate, chainTime: PREFLIGHT_TIME + 3601 });
      expect(old).to.have.length(1);
      expect(old[0]).to.include("60 minutes old by the chain's clock; the limit is 60 minutes");
      expect(old[0]).to.include("PREFLIGHT_MAX_AGE_MINUTES");
      // The override moves the limit both ways.
      expect(preflightGateProblems({ ...gate, chainTime: PREFLIGHT_TIME + 3601, maxAgeMinutes: 90 })).to.deep.equal([]);
      expect(preflightGateProblems({ ...gate, chainTime: PREFLIGHT_TIME + 601, maxAgeMinutes: 10 })[0]).to.include("the limit is 10 minutes");
      expect(preflightGateProblems({ ...gate, chainTime: PREFLIGHT_TIME - 30 })[0]).to.include("30 s after the chain's latest block");
      // A rehearsal that ran the preflight is held to the limit too.
      expect(preflightGateProblems({ ...gate, record: record(p, 31337), chainId: 31337, mandatory: false, chainTime: PREFLIGHT_TIME + 7200 })).to.have.length(1);
    });

    it("does not hold a resumed ceremony to the age limit: its record was fresh when it started", function () {
      const p = params(open);
      expect(preflightGateProblems({ record: record(p), params: p, chainId: 1, deployer: DEPLOYER, mandatory: true, ...fresh, deployerNonce: 12, resuming: true, chainTime: PREFLIGHT_TIME + 86_400 })).to.deep.equal([]);
    });

    it("refuses when a Safe's threshold or owners differ from the record, on a fresh run and on a resume", function () {
      const p = params(open);
      const gate = { record: record(p), params: p, chainId: 1, deployer: DEPLOYER, mandatory: true, ...fresh };
      const withProposer = (proposer: SafeRecord): SafeRecord[] => [proposer, SAFES[1], SAFES[2]];
      // The same owners in another order, or in another letter case, are the same Safe.
      const reordered = withProposer({ ...SAFES[0], owners: [addr(73), addr(71).toUpperCase().replace("0X", "0x"), addr(72)] });
      expect(preflightGateProblems({ ...gate, safes: reordered })).to.deep.equal([]);

      const lowered = preflightGateProblems({ ...gate, safes: withProposer({ ...SAFES[0], threshold: "1" }) });
      expect(lowered.join("\n")).to.include(`the proposer Safe ${addr(10)} was 2-of-3 at the preflight and is 1-of-3 now`);
      expect(lowered.join("\n")).to.include("run the preflight again");

      const swapped = preflightGateProblems({ ...gate, safes: withProposer({ ...SAFES[0], owners: [addr(71), addr(72), addr(99)] }) });
      expect(swapped.join("\n")).to.include(`the owners of the proposer Safe ${addr(10)} changed since the preflight (added ${addr(99)}; removed ${addr(73)})`);

      const resumed = preflightGateProblems({ ...gate, deployerNonce: 20, resuming: true, safes: withProposer({ ...SAFES[0], owners: [addr(71), addr(72)] }) });
      expect(resumed.join("\n")).to.include("changed since the preflight");

      // A Safe that no longer answers the Safe views is a change as well.
      const unread = preflightGateProblems({ ...gate, safes: withProposer({ role: "proposer", address: addr(10), unreadable: "call reverted" }) });
      expect(unread.join("\n")).to.include("is no readable Safe policy now");
    });

    it("names an address the record does not hold and one the deploy no longer wires", function () {
      const other: SafeRecord = { role: "guardian", address: addr(13), threshold: "2", owners: [addr(75), addr(76), addr(77)] };
      const problems = safeRecordProblems(SAFES, [SAFES[0], SAFES[1], other]);
      expect(problems).to.have.length(2);
      expect(problems[0]).to.include(`the guardian ${addr(12)} the preflight recorded is not among the Safes this deploy would wire`);
      expect(problems[1]).to.include(`the guardian ${addr(13)} is not in the preflight record`);
      // An accepted open executor has no policy on either side and compares equal.
      const open0: SafeRecord = { role: "executor", address: ethers.ZeroAddress };
      expect(safeRecordProblems([open0], [open0])).to.deep.equal([]);
    });

    it("refuses on mainnet a record written before it carried the chain time or the Safes, and accepts one elsewhere", function () {
      const p = params(open);
      const older = { ...record(p), chainTime: undefined, safes: undefined };
      const problems = preflightGateProblems({ record: older, params: p, chainId: 1, deployer: DEPLOYER, mandatory: true, ...fresh });
      expect(problems).to.have.length(2);
      expect(problems[0]).to.include("no chain time");
      expect(problems[1]).to.include("no Safe thresholds and owners");
      expect(preflightGateProblems({ record: { ...older, chainId: 31337 }, params: p, chainId: 31337, deployer: DEPLOYER, mandatory: false, ...fresh })).to.deep.equal([]);
    });

    it("reads PREFLIGHT_MAX_AGE_MINUTES as whole minutes above zero and refuses anything else", function () {
      expect(parsePreflightMaxAgeMinutes(undefined)).to.equal(60);
      expect(parsePreflightMaxAgeMinutes(" 15 ")).to.equal(15);
      for (const bad of ["", "0", "-5", "1.5", "an hour", "0x10", "1e3"]) expect(() => parsePreflightMaxAgeMinutes(bad), bad).to.throw("PREFLIGHT_MAX_AGE_MINUTES");
    });
  });

  describe("verify-deployment's comparison of the snapshot with the record", function () {
    const snapshotConfig = (p: LaunchParameters): Record<string, unknown> => ({
      launchCaps: p.launchCaps,
      paxgToken: p.paxgToken,
      xautToken: p.xautToken,
      paxgFeed: p.paxgFeed,
      // deploy.ts records the InactiveFeed it creates when XAUT_FEED is unset.
      xautFeed: p.xautFeed === "" ? addr(66) : p.xautFeed,
      xautFeedDeployed: p.xautFeed === "",
      anchorFeed: p.anchorFeed,
      xautActive: p.xautActive,
      paxgGoldBandPpm: p.paxgGoldBandPpm.toString(),
      paxgLiquidationClampPpm: p.paxgLiquidationClampPpm.toString(),
      minGsusdReserve: p.minGsusdReserve.toString(),
      reservePenaltyShareBps: p.reservePenaltyShareBps.toString(),
      originationFeeBps: p.originationFeeBps.toString(),
      minDebt: p.minDebt.toString(),
      underwaterDiscountPpm: p.underwaterDiscountPpm.toString(),
      reserveDailyCapPpm: p.reserveDailyCapPpm.toString(),
      reserveAggregateDailyCapUsd: p.reserveAggregateDailyCapUsd.toString(),
      reserveMinReservePaxg: p.reserveMinReservePaxg.toString(),
      reserveMinReserveXaut: p.reserveMinReserveXaut.toString(),
      minCollateralReserve: p.minCollateralReserve.toString(),
      badDebtPauseThreshold: p.badDebtPauseThreshold.toString(),
      perBlockMintCap: p.perBlockMintCap.toString(),
      lockSiloVaultRole: p.lockSiloVaultRole,
      proposers: p.proposers,
      executors: p.executors,
      guardian: p.guardian,
      stalenessThreshold: p.stalenessThreshold,
      siloCap: p.siloCap.toString(),
      paxg: { ...p.paxg, debtCeiling: p.paxg.debtCeiling.toString() },
      xaut: { ...p.xaut, debtCeiling: p.xaut.debtCeiling.toString() },
    });

    it("agrees with the snapshot deploy.ts writes from the same parameters", function () {
      const p = params({ ...open, TIMELOCK_PROPOSER: `${addr(10)},${addr(11)}` });
      expect(snapshotRecordMismatches(snapshotConfig(p), parameterRecord(p))).to.deep.equal([]);
    });

    it("agrees for a dormant XAUT and names an XAUT the snapshot activated behind the record", function () {
      const p = params({ LAUNCH_CAPS: "backstop", PAXG_DEBT_CEILING: "1000", PAXG_BACKSTOP_REHEARSAL_MAX: "1000" });
      expect(snapshotRecordMismatches(snapshotConfig(p), parameterRecord(p))).to.deep.equal([]);
      const activated = snapshotRecordMismatches({ ...snapshotConfig(p), xautActive: true }, parameterRecord(p));
      expect(activated.some((m) => m.startsWith("XAUT_STATUS"))).to.equal(true);
      expect(activated.some((m) => m.startsWith("XAUT_DEBT_CEILING"))).to.equal(true);
      const banded = snapshotRecordMismatches({ ...snapshotConfig(p), paxgGoldBandPpm: "25000" }, parameterRecord(p));
      expect(banded).to.deep.equal(["PAXG_GOLD_BAND_PPM: snapshot 25000, preflight 20000"]);
      // A snapshot written before the backstop profile carries no xautActive: XAUT was active.
      const { xautActive: _dropped, ...older } = snapshotConfig(params());
      void _dropped;
      expect(snapshotRecordMismatches(older, parameterRecord(params()))).to.deep.equal([]);
    });

    it("names a liquidation cap the snapshot and the preflight disagree on", function () {
      const p = params({ PAXG_LIQUIDATION_CLAMP_PPM: "25000" });
      expect(snapshotRecordMismatches(snapshotConfig(p), parameterRecord(p))).to.deep.equal([]);
      const drifted = { ...snapshotConfig(p), paxgLiquidationClampPpm: "30000" };
      expect(snapshotRecordMismatches(drifted, parameterRecord(p))).to.deep.equal(["PAXG_LIQUIDATION_CLAMP_PPM: snapshot 30000, preflight 25000"]);
    });

    it("names a reserve minimum, breaker or silo lock the snapshot lacks or records otherwise", function () {
      const p = params(open);
      const { badDebtPauseThreshold: _a, perBlockMintCap: _b, minCollateralReserve: _c, reserveMinReservePaxg: _d, lockSiloVaultRole: _e, ...older } = snapshotConfig(p);
      void [_a, _b, _c, _d, _e];
      const missing = snapshotRecordMismatches(older, parameterRecord(p)).map((m) => m.split(":")[0]);
      expect(missing).to.have.members(["BAD_DEBT_PAUSE_THRESHOLD", "PER_BLOCK_MINT_CAP", "MIN_COLLATERAL_RESERVE", "RESERVE_MIN_RESERVE_PAXG", "SILO_LOCK_VAULT_ROLE"]);
      const drifted = snapshotRecordMismatches({ ...snapshotConfig(p), perBlockMintCap: "1", lockSiloVaultRole: false }, parameterRecord(p));
      expect(drifted).to.deep.equal(["PER_BLOCK_MINT_CAP: snapshot 1, preflight 0", "SILO_LOCK_VAULT_ROLE: snapshot false, preflight true"]);
    });

    it("names a snapshot value the preflight never saw", function () {
      const p = params();
      const drifted = { ...snapshotConfig(p), xaut: { ...p.xaut, debtCeiling: "5" }, guardian: addr(77) };
      const mismatches = snapshotRecordMismatches(drifted, parameterRecord(p));
      expect(mismatches.some((m) => m.startsWith("XAUT_DEBT_CEILING"))).to.equal(true);
      expect(mismatches.some((m) => m.startsWith("TIMELOCK_GUARDIAN"))).to.equal(true);
      expect(mismatches).to.have.length(2);
    });
  });

  describe("the mainnet role split", function () {
    it("fails on mainnet and warns elsewhere when the guardian is a proposer or proposers are executors", function () {
      const guardianIsProposer: Array<["proposer" | "executor" | "guardian", string]> = [["proposer", addr(1)], ["executor", addr(2)], ["guardian", addr(1)]];
      expect(roleSplit(guardianIsProposer, 1).verdict).to.equal("fail");
      expect(roleSplit(guardianIsProposer, 11155111).verdict).to.equal("warn");
      const proposerIsExecutor: Array<["proposer" | "executor" | "guardian", string]> = [["proposer", addr(1)], ["executor", addr(1)], ["guardian", addr(3)]];
      expect(roleSplit(proposerIsExecutor, 1).verdict).to.equal("fail");
      expect(roleSplit(proposerIsExecutor, 1).detail).to.include("executor is the same address as proposer");
      const split: Array<["proposer" | "executor" | "guardian", string]> = [["proposer", addr(1)], ["executor", addr(2)], ["guardian", addr(3)]];
      expect(roleSplit(split, 1).verdict).to.equal("pass");
    });
  });

  describe("error redaction for the launch scripts", function () {
    it("keeps the origin and drops the path that carries the provider key", function () {
      expect(redactUrls("could not detect network https://eth-mainnet.g.alchemy.com/v2/SECRET123 (code=NETWORK_ERROR)")).to.equal(
        "could not detect network https://eth-mainnet.g.alchemy.com/<redacted> (code=NETWORK_ERROR)"
      );
      expect(describeError(new Error("fetch http://user:pw@rpc.example.net:8545/key failed"))).to.equal("fetch http://<redacted>@rpc.example.net:8545/<redacted> failed");
      expect(describeError("plain")).to.equal("plain");
    });

    it("leaves no script printing a raw error past it", function () {
      // A thrown value reaches a terminal either from a catch that prints it whole or from one
      // that interpolates its message; both must go through describeError or redactUrls.
      const raw = [
        /console\.(?:error|warn|log)\(\s*(?:e|err|error)\s*(?:\)|,|instanceof)/,
        /String\(\s*(?:e|err|error)\s*\)/,
        /\(\s*(?:e|err|error) as Error\s*\)\??\.(?:message|shortMessage)/,
        /(?:e|err|error) instanceof Error \? (?:e|err|error)\.message/,
      ];
      const root = resolve(__dirname, "../scripts");
      const files = readdirSync(root, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".ts") && f !== join("lib", "redact.ts"));
      const offenders = files.flatMap((file) =>
        readFileSync(join(root, file), "utf8")
          .split("\n")
          .flatMap((line, i) => (raw.some((pattern) => pattern.test(line)) ? [`scripts/${file}:${i + 1}: ${line.trim()}`] : []))
      );
      expect(offenders, offenders.join("\n")).to.deep.equal([]);
    });
  });
});
