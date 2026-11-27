import { expect } from "chai";
import { LAUNCH_SITE_ORIGINS } from "../scripts/lib/serviceEnv";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Interface, id } from "ethers";
import {
  ABI_CONTRACTS,
  AGENT_MANIFEST_SCHEMA,
  AgentManifest,
  AgentManifestAddresses,
  AgentManifestSnapshot,
  buildAgentManifest,
  buildLlmsTxt,
  DEFAULT_SITE_URL,
  INACTIVE_COLLATERAL_NOTE,
  misdirectedChecks,
  publishableSnapshots,
  uncoveredAddresses,
} from "../scripts/lib/agentManifest";
import { stabilityFeeRateOf } from "../scripts/lib/launchParameterChecks";
import { refreshSnapshotConfig } from "../scripts/lib/snapshotRefresh";

/** scripts/print-agent-manifest.ts: the manifest the dapp serves at /agents.json, with /llms.txt and /abi/. */
describe("Agent manifest (scripts/print-agent-manifest.ts)", function () {
  const addr = (n: number): string => `0x${n.toString(16).padStart(40, "0")}`;
  const collateral = { minRatio: 1_300_000, liqRatio: 1_100_000, liqPenalty: 50_000, debtCeiling: "500000000000000000000000", stabilityFeeBps: 200 };
  const sepolia: AgentManifestSnapshot = {
    chainId: 11155111,
    network: "sepolia",
    deployer: addr(99),
    deployBlock: 11_968_525,
    deployedAt: "2026-10-22T09:02:38.079Z",
    governanceTransferred: true,
    addresses: {
      oracle: addr(1), stablecoin: addr(2), stabilityModule: addr(3), vault: addr(4), surplusBuffer: addr(5),
      stabilityPool: addr(6), reserve: addr(7), siloFactory: addr(8), vaultRegistry: addr(9), governance: addr(10), timelock: addr(11),
    },
    config: {
      paxgToken: addr(21), xautToken: addr(22), paxgFeed: addr(31), xautFeed: addr(32),
      minDebt: "100000000000000000000", underwaterDiscountPpm: "20000", originationFeeBps: "5", stalenessThreshold: 90_000, reserveDailyCapPpm: "200000", paxg: collateral, xaut: collateral,
    },
  };
  const options = { generatedAt: "2026-10-23T00:00:00.000Z", siteUrl: "https://example.org" };
  const publicDir = resolve(__dirname, "../../apps/dapp/public");

  it("carries the schema, site-hosted links and every address of the snapshot, and no code host by default", function () {
    const m = buildAgentManifest([sepolia], options);
    expect(m.schema).to.equal(AGENT_MANIFEST_SCHEMA);
    expect(m.schema).to.equal("goldstandard-agents/1");
    expect(m.source.site).to.equal("https://example.org");
    expect(m.source.guide).to.equal("https://example.org/docs/agents");
    expect(m.source.abis.GoldVault).to.equal("https://example.org/abi/GoldVault.json");
    expect(Object.keys(m.source.abis)).to.have.members([...ABI_CONTRACTS]);
    expect(m.source.repository).to.equal(undefined);
    expect(JSON.stringify(m)).to.not.include("github.com");
    const net = m.networks["11155111"];
    expect(net.status).to.equal("testnet");
    expect(net.explorer).to.equal("https://sepolia.etherscan.io");
    expect(net.addresses?.vaultRegistry).to.equal(addr(9));
    expect(net.deployBlock).to.equal(11_968_525);
  });

  it("includes a repository link only when the operator supplies one", function () {
    const m = buildAgentManifest([sepolia], { ...options, repository: "https://github.com/gold-standard-protocol/gold-standard.git" });
    expect(m.source.repository).to.equal("https://github.com/gold-standard-protocol/gold-standard");
    expect(buildLlmsTxt(m)).to.include("[Repository](https://github.com/gold-standard-protocol/gold-standard)");
    expect(buildLlmsTxt(buildAgentManifest([sepolia], options))).to.not.include("## Source");
  });

  it("describes each collateral in parts per million with the token's decimals", function () {
    const net = buildAgentManifest([sepolia], options).networks["11155111"];
    expect(net.collateral).to.have.length(2);
    const [paxg, xaut] = net.collateral ?? [];
    expect(paxg).to.include({ symbol: "PAXG", token: addr(21), decimals: 18, minRatioPpm: 1_300_000, liquidationRatioPpm: 1_100_000, liquidationPenaltyPpm: 50_000 });
    expect(xaut).to.include({ symbol: "XAUT", token: addr(22), decimals: 6 });
    // The origination fee is a governed parameter like the others.
    expect(net.parameters).to.deep.equal({ minDebt: "100000000000000000000", underwaterDiscountPpm: 20_000, originationFeeBps: 5, oracleStalenessSeconds: 90_000, reserveDailyCapPpm: 200_000 });
  });

  it("lists mainnet as not deployed until a mainnet snapshot exists", function () {
    const without = buildAgentManifest([sepolia], options).networks["1"];
    expect(without).to.deep.equal({ chainId: 1, name: "mainnet", status: "not deployed", explorer: "https://etherscan.io" });
    const mainnet: AgentManifestSnapshot = { ...sepolia, chainId: 1, network: "mainnet" };
    const withMainnet = buildAgentManifest([sepolia, mainnet], options).networks["1"];
    expect(withMainnet.status).to.equal("mainnet");
    expect(withMainnet.addresses?.vault).to.equal(addr(4));
  });

  it("states the conventions an agent must not guess", function () {
    const m = buildAgentManifest([sepolia], options);
    expect(m.conventions.priceDecimals).to.equal(8);
    expect(m.conventions.registryHookGasFloor).to.equal(375_000);
    expect(m.conventions.repayCapsAtCurrentDebt).to.equal(true);
    expect(m.conventions.underwaterLiquidatesInFull).to.equal(true);
    expect(m.conventions).to.not.have.property("thinVaultLiquidatesInFull");
    expect(m.token).to.include({ symbol: "GSUSD", decimals: 18, permit: true });
    // Freezing is the guardian's or governance's; the permissionless maintenance call is the price poke.
    const calls = m.maintenance.map((entry) => entry.call);
    expect(calls).to.include("GoldOracle.getTokenPrice(token)");
    expect(calls.join(" ")).to.not.include("tripCircuitBreaker");
    expect(JSON.stringify(m)).to.not.match(/tripCircuitBreaker|deviation gate|anchor band/);
    expect(m.reads.price).to.include("quoteTokenPrice(token)");
    expect(m.reads.price).to.include("quoteBorrowPrice(token)");
    // GoldOracle grants freezeToken to GUARDIAN_ROLE and GOVERNANCE_ROLE,
    // and the freeze holds through a pause.
    expect(m.reads.frozen).to.include("The guardian or governance freezes it");
    expect(m.reads.frozen).to.include("during a pause as well");
    // An unfreeze names the freeze it lifts, so the call carries the number.
    expect(m.reads.frozen).to.include("guardianUnfreezeToken(token, freezeEpoch(token))");
    expect(m.actions.emergencyLiquidate).to.include("never for a frozen token");
    // A reserve asset pause lapses by itself.
    expect(m.reads.paused).to.include("GoldStabilityReserve.assetPaused(token)");
    // The delay is governable: the convention is the launch value, getMinDelay() the live one.
    expect(m.conventions.governanceDelaySeconds).to.equal(48 * 3600);
    expect(m.reads.governanceDelay).to.include("TimelockController.getMinDelay()");
    expect(m.reads.governanceDelay).to.include("updateDelay");
    // CallScheduled announces a delay change in advance; MinDelayChange only records its execution.
    expect(m.reads.governanceDelay).to.include("CallScheduled announces it in advance");
    expect(m.reads.governanceDelay).to.include("MinDelayChange records it when it executes");
  });

  it("never publishes a chain 1 snapshot deployed by a Hardhat development account: that is a fork rehearsal", function () {
    const forkRehearsal: AgentManifestSnapshot = { ...sepolia, chainId: 1, network: "mainnet", deployer: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" };
    const realMainnet: AgentManifestSnapshot = { ...sepolia, chainId: 1, network: "mainnet", deployer: addr(77) };
    const sepoliaByDevAccount: AgentManifestSnapshot = { ...sepolia, deployer: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" };
    const { publish, rehearsals } = publishableSnapshots([sepolia, forkRehearsal]);
    expect(publish).to.deep.equal([sepolia]);
    expect(rehearsals).to.deep.equal([forkRehearsal]);
    expect(publishableSnapshots([realMainnet]).publish).to.deep.equal([realMainnet]);
    // Testnets are not filtered: a test deployment by a development account is still a test deployment.
    expect(publishableSnapshots([sepoliaByDevAccount]).publish).to.deep.equal([sepoliaByDevAccount]);
  });

  it("renders an XAUT that governance activated with its ratios and no inactive note", function () {
    const launchCollateral = { minRatio: 1_300_000, liqRatio: 1_100_000, liqPenalty: 50_000, debtCeiling: "0", stabilityFeeBps: 200 };
    const dormant = { ...sepolia.config, xautActive: false, paxg: launchCollateral, xaut: launchCollateral };
    // What refresh-deployment-snapshot.ts writes with XAUT_ACTIVATED=1 after the activation batch.
    const { config } = refreshSnapshotConfig(
      dormant,
      {
        paxg: { active: true, minRatio: 1_300_000n, liquidationRatio: 1_100_000n, liquidationPenalty: 50_000n, debtCeiling: 0n },
        xaut: { active: true, minRatio: 1_500_000n, liquidationRatio: 1_200_000n, liquidationPenalty: 60_000n, debtCeiling: 250_000n * 10n ** 18n },
        paxgStabilityFeeRate: stabilityFeeRateOf(200n),
        xautStabilityFeeRate: stabilityFeeRateOf(300n),
        xautFeed: addr(77),
        minGsusdReserve: 0n,
        minDebt: 1_000n * 10n ** 18n,
        underwaterDiscountPpm: 20_000n,
        originationFeeBps: 5n,
        paxgGoldBandPpm: 20_000n,
        paxgLiquidationClampPpm: 20_000n,
        stalenessThreshold: 90_000n,
        reserveDailyCapPpm: 200_000n,
        reservePenaltyShareBps: 4_000n,
        badDebtPauseThreshold: 25_000n * 10n ** 18n,
        perBlockMintCap: 0n,
        reserveMinReservePaxg: 0n,
        reserveMinReserveXaut: 0n,
        reserveAggregateDailyCapUsd: 0n,
        reserveSpreadCurve: [{ coverageAtLeastPpm: 150_000n, spreadPpm: 5_000n }],
        reserveRestrictedSpreadPpm: 20_000n,
        minCollateralReserve: 0n,
        siloCap: 100n * 10n ** 18n,
        lockSiloVaultRole: true,
      },
      { xautActivated: true, now: "2027-02-01T10:00:00.000Z" }
    );
    expect(config.xautActive).to.equal(true);
    const activated: AgentManifestSnapshot = {
      ...sepolia,
      config: { ...sepolia.config, xautActive: config.xautActive, xaut: { ...launchCollateral, ...config.xaut, stabilityFeeBps: Number(config.xaut.stabilityFeeBps) } },
    };
    const manifest = buildAgentManifest([activated], options);
    const xaut = (manifest.networks["11155111"].collateral ?? [])[1];
    expect(xaut).to.deep.equal({
      symbol: "XAUT",
      token: addr(22),
      decimals: 6,
      minRatioPpm: 1_500_000,
      liquidationRatioPpm: 1_200_000,
      liquidationPenaltyPpm: 60_000,
      debtCeiling: (250_000n * 10n ** 18n).toString(),
      stabilityFeeBps: 300,
    });
    const text = buildLlmsTxt(manifest);
    expect(text).to.include("tokenised gold (PAXG and XAUT)");
    expect(text).to.not.include(INACTIVE_COLLATERAL_NOTE);
  });

  it("lists XAUT as registered but inactive on a PAXG-first deployment, with on-chain zeros and a note", function () {
    const paxgFirst: AgentManifestSnapshot = { ...sepolia, config: { ...sepolia.config, xautActive: false } };
    const net = buildAgentManifest([paxgFirst], options).networks["11155111"];
    const [paxg, xaut] = net.collateral ?? [];
    expect(paxg.symbol).to.equal("PAXG");
    expect(paxg.active).to.equal(undefined);
    expect(paxg.minRatioPpm).to.equal(1_300_000);
    expect(xaut).to.deep.equal({
      symbol: "XAUT",
      token: addr(22),
      decimals: 6,
      minRatioPpm: 0,
      liquidationRatioPpm: 0,
      liquidationPenaltyPpm: 0,
      debtCeiling: "0",
      stabilityFeeBps: 0,
      active: false,
      note: INACTIVE_COLLATERAL_NOTE,
    });
    // The quickstart requires the list to name exactly the two tokens the oracle reports, so XAUT stays listed.
    expect((net.collateral ?? []).map((c) => c.token)).to.deep.equal([addr(21), addr(22)]);
    const text = buildLlmsTxt(buildAgentManifest([paxgFirst], options));
    expect(text).to.include("tokenised gold (PAXG, with XAUT registered but inactive where a deployment lists it so)");
    expect(text).to.include("## Collateral");
    expect(text).to.include(`- sepolia (chain 11155111): PAXG accepted; XAUT ${INACTIVE_COLLATERAL_NOTE}`);
    // A deployment with both tokens active reads as before.
    const both = buildLlmsTxt(buildAgentManifest([sepolia], options));
    expect(both).to.include("tokenised gold (PAXG and XAUT)");
    expect(both).to.not.include("## Collateral");
  });

  it("leaves collateral out when the snapshot has no configuration for it", function () {
    const bare: AgentManifestSnapshot = { ...sepolia, config: { paxgToken: addr(21), xautToken: addr(22) } };
    const net = buildAgentManifest([bare], options).networks["11155111"];
    expect(net.collateral).to.deep.equal([]);
    expect(net.parameters?.minDebt).to.equal(undefined);
    expect(uncoveredAddresses(net)).to.deep.equal([]);
  });

  // The minter claim is made per network and never stronger than the chain supports.
  it("says the minter set is changeable until lockMinters(vault) and adds the lock check only when the snapshot records it", function () {
    const open = buildAgentManifest([sepolia], options).networks["11155111"];
    expect(open.minting?.minter).to.equal("GoldVault");
    expect(open.minting?.locked).to.equal(undefined);
    expect(open.minting?.note).to.include("until lockMinters(vault) is called (lockMinters() on deployments before 2026-11-06)");
    expect(open.minting?.note).to.include("mintersLocked()");
    expect((open.verification ?? []).some((c) => c.check.includes("mintersLocked"))).to.equal(false);
    const m = buildAgentManifest([sepolia], options);
    expect(m.token.minter).to.not.include("no other address can mint");
    const locked = buildAgentManifest([{ ...sepolia, mintersLocked: true }], options).networks["11155111"];
    expect(locked.minting?.locked).to.equal(true);
    expect(locked.minting?.note).to.include("locked for good");
    const lockCheck = (locked.verification ?? []).find((c) => c.check.includes("mintersLocked"));
    expect(lockCheck?.address).to.equal("stablecoin");
    expect(lockCheck?.to).to.equal(addr(2));
    expect(lockCheck?.result).to.equal(`0x${"0".repeat(63)}1`);
  });

  describe("verification", function () {
    const net = () => buildAgentManifest([sepolia], options).networks["11155111"];

    it("carries replayable eth_calls that tie the addresses together", function () {
      const checks = net().verification ?? [];
      expect(checks.map((c) => c.check)).to.include("GoldStablecoin: the vault holds MINTER_ROLE");
      const minter = checks.find((c) => c.check.includes("the vault holds MINTER_ROLE"));
      const roles = new Interface(["function hasRole(bytes32,address) view returns (bool)"]);
      expect(minter?.address).to.equal("stablecoin");
      expect(minter?.to).to.equal(addr(2));
      expect(minter?.data).to.equal(roles.encodeFunctionData("hasRole", [id("MINTER_ROLE"), addr(4)]));
      expect(minter?.result).to.equal(`0x${"0".repeat(63)}1`);
      const registry = checks.find((c) => c.check.startsWith("GoldVault.vaultRegistry()"));
      expect(registry?.result).to.equal(`0x${"0".repeat(24)}${addr(9).slice(2)}`);
      const deployer = checks.find((c) => c.check.includes("deployer no longer"));
      expect(deployer?.result).to.equal(`0x${"0".repeat(64)}`);
      // The delay is governed, so the list proves the timelock's wiring, not its value.
      expect(checks.some((c) => c.check.startsWith("TimelockController.getMinDelay()"))).to.equal(false);
      const proposer = checks.find((c) => c.check.startsWith("TimelockController: the governance wrapper holds PROPOSER_ROLE"));
      expect(proposer?.address).to.equal("timelock");
      const feed = checks.find((c) => c.check.startsWith("GoldOracle.paxgUsdFeed()"));
      expect(feed?.result).to.equal(`0x${"0".repeat(24)}${addr(31).slice(2)}`);
    });

    // Every address is the target of a check, and every check calls the address it names.
    it("names the address each check calls, covers every address in the set and never points elsewhere", function () {
      const network = net();
      const checks = network.verification ?? [];
      expect(checks.length).to.be.greaterThan(0);
      for (const check of checks) {
        expect(network.addresses?.[check.address], check.check).to.equal(check.to);
        expect(check.result).to.match(/^0x[0-9a-f]{64}$/);
      }
      expect(uncoveredAddresses(network)).to.deep.equal([]);
      expect(misdirectedChecks(network)).to.deep.equal([]);
      for (const key of Object.keys(network.addresses ?? {})) {
        expect(checks.filter((c) => c.address === key).length, key).to.be.greaterThan(0);
      }
    });

    it("exposes the two hostile shapes the quickstart must refuse: an empty list and swapped addresses", function () {
      const network = net();
      expect(uncoveredAddresses({ ...network, verification: [] })).to.have.members(Object.keys(network.addresses ?? {}));
      const dead = addr(0xdead);
      const lookAlike: AgentManifestAddresses = {
        oracle: dead, stablecoin: dead, stabilityModule: dead, vault: dead, surplusBuffer: dead, stabilityPool: dead,
        reserve: dead, siloFactory: dead, vaultRegistry: dead, governance: dead, timelock: dead,
      };
      const swapped = { ...network, addresses: lookAlike };
      expect(misdirectedChecks(swapped)).to.have.length(network.verification?.length ?? 0);
    });

    it("refuses to build a network entry whose address set it cannot cover", function () {
      const stripped = { ...sepolia, addresses: { ...sepolia.addresses, extra: addr(42) } as unknown as AgentManifestSnapshot["addresses"] };
      expect(() => buildAgentManifest([stripped], options)).to.throw("extra");
    });

    it("omits the timelock admin checks until governance is transferred but still covers the timelock", function () {
      const pre: AgentManifestSnapshot = { ...sepolia, governanceTransferred: false };
      const network = buildAgentManifest([pre], options).networks["11155111"];
      const checks = network.verification ?? [];
      expect(checks.some((c) => c.check.includes("DEFAULT_ADMIN_ROLE"))).to.equal(false);
      expect(checks.some((c) => c.check.includes("deployer"))).to.equal(false);
      expect(uncoveredAddresses(network)).to.deep.equal([]);
    });
  });

  describe("llms.txt", function () {
    it("is built from the manifest, points at the site and states where the live addresses are", function () {
      const text = buildLlmsTxt(buildAgentManifest([sepolia], options));
      expect(text).to.include("https://example.org/agents.json");
      expect(text).to.include("schema goldstandard-agents/1");
      expect(text).to.include("https://example.org/abi/GoldVault.json");
      expect(text).to.include("Mainnet is not yet deployed; the live addresses are on the Sepolia test network.");
      expect(text).to.include("until lockMinters(vault) is called (lockMinters() on deployments before 2026-11-06)");
      expect(text).to.include("a change to the delay itself waits out the delay in force");
      expect(text).to.not.include("github.com");
      const live = buildLlmsTxt(buildAgentManifest([sepolia, { ...sepolia, chainId: 1, network: "mainnet" }], options));
      expect(live).to.include("The live addresses are on Ethereum mainnet");
    });
  });

  describe("the committed files", function () {
    // The printer's own filter: a mainnet fork rehearsal's snapshot is never published.
    const snapshots = publishableSnapshots(
      ["sepolia", "mainnet"]
        .map((name) => resolve(__dirname, "../deployments", `${name}.json`))
        .filter((path) => existsSync(path))
        .map((path) => JSON.parse(readFileSync(path, "utf8")) as AgentManifestSnapshot)
    ).publish;
    const committed = JSON.parse(readFileSync(resolve(publicDir, "agents.json"), "utf8")) as AgentManifest;
    // Exactly the inputs the printer used, read back from the manifest itself: no environment dependence.
    const inputs = { generatedAt: committed.generatedAt, siteUrl: committed.source.site, repository: committed.source.repository };

    it("match what the printer builds from the snapshots (regenerate them after a snapshot change)", function () {
      const fresh = buildAgentManifest(snapshots, inputs);
      expect(JSON.parse(JSON.stringify(fresh))).to.deep.equal(committed, "run `npx hardhat run scripts/print-agent-manifest.ts` and commit apps/dapp/public/agents.json, llms.txt and abi/");
      expect(readFileSync(resolve(publicDir, "llms.txt"), "utf8").replace(/\r\n/g, "\n")).to.equal(buildLlmsTxt(fresh));
      for (const name of ABI_CONTRACTS) expect(existsSync(resolve(publicDir, "abi", `${name}.json`)), name).to.equal(true);
    });

    // A manifest generated with SOURCE_URL set round-trips through the same drift test.
    it("round-trip whichever repository the operator set, so a SOURCE_URL run cannot fail the drift test", function () {
      const operatorRun = buildAgentManifest(snapshots, { ...inputs, repository: "https://github.com/gold-standard-protocol/gold-standard" });
      const rebuilt = buildAgentManifest(snapshots, { generatedAt: operatorRun.generatedAt, siteUrl: operatorRun.source.site, repository: operatorRun.source.repository });
      expect(JSON.parse(JSON.stringify(rebuilt))).to.deep.equal(JSON.parse(JSON.stringify(operatorRun)));
    });

    // No code-host link, personal or otherwise, reaches a published file by default.
    it("carry no code-host link by default", function () {
      // The site is one of the dapp's own launch origins. A fresh run with SITE_URL unset writes the
      // canonical one (DEFAULT_SITE_URL); a committed copy on the mirror stays valid until it is regenerated.
      expect(LAUNCH_SITE_ORIGINS).to.include(committed.source.site);
      expect(LAUNCH_SITE_ORIGINS[0]).to.equal(DEFAULT_SITE_URL);
      const generated = [resolve(publicDir, "agents.json"), resolve(publicDir, "llms.txt"), ...readdirSync(resolve(publicDir, "abi")).map((f) => resolve(publicDir, "abi", f))];
      if (committed.source.repository === undefined) {
        for (const file of generated) expect(readFileSync(file, "utf8"), file).to.not.include("github.com");
      }
    });

    it("cover every address on every deployed network with calls that target it", function () {
      for (const network of Object.values(committed.networks)) {
        if (network.status === "not deployed") continue;
        expect(network.verification?.length ?? 0, network.name).to.be.greaterThan(0);
        expect(uncoveredAddresses(network), network.name).to.deep.equal([]);
        expect(misdirectedChecks(network), network.name).to.deep.equal([]);
      }
    });
  });
});
