import { expect } from "chai";
import { LAUNCH_SITE_ORIGINS, parseSiteOrigins, serviceEnv, ServiceEnvSnapshot } from "../scripts/lib/serviceEnv";
import { DEFAULT_SITE_URL, manifestSiteUrl } from "../scripts/lib/agentManifest";
import { UNISWAP } from "../scripts/lib/mainnetAddresses";

/** scripts/print-service-env.ts: the three env blocks a deployment's services need. */
describe("Service environment blocks (scripts/print-service-env.ts)", function () {
  const addr = (n: number): string => `0x${n.toString(16).padStart(40, "0")}`;
  const snapshot: ServiceEnvSnapshot = {
    chainId: 1,
    deployBlock: 23_456_789,
    addresses: {
      oracle: addr(1),
      stablecoin: addr(2),
      stabilityModule: addr(3),
      vault: addr(4),
      surplusBuffer: addr(5),
      stabilityPool: addr(6),
      reserve: addr(7),
      siloFactory: addr(8),
    },
    config: { paxgToken: addr(21), xautToken: addr(22) },
  };
  const entries = (block: string): Record<string, string> =>
    Object.fromEntries(block.trim().split("\n").map((line) => line.split(/=(.*)/s).slice(0, 2)));

  it("prints the VaultRegistry address only for a snapshot that has one", function () {
    expect(entries(serviceEnv(snapshot).dapp)).to.not.have.property("VITE_VAULT_REGISTRY_ADDRESS");
    const withRegistry: ServiceEnvSnapshot = { ...snapshot, addresses: { ...snapshot.addresses, vaultRegistry: addr(11) } };
    expect(entries(serviceEnv(withRegistry).dapp).VITE_VAULT_REGISTRY_ADDRESS).to.equal(addr(11));
  });

  it("targets mainnet in the dapp block with every address the build reads", function () {
    const dapp = entries(serviceEnv(snapshot).dapp);
    expect(dapp.VITE_TARGET_CHAIN_ID).to.equal("1");
    expect(dapp).to.have.property("VITE_MAINNET_RPC_URL");
    expect(dapp).to.not.have.property("VITE_SEPOLIA_RPC_URL");
    expect(dapp.VITE_GOLD_VAULT_ADDRESS).to.equal(addr(4));
    expect(dapp.VITE_DEPLOY_BLOCK).to.equal("23456789");
    expect(dapp.VITE_PAXG_ADDRESS).to.equal(addr(21));
    expect(dapp.VITE_XAUT_ADDRESS).to.equal(addr(22));
    // The dapp build refuses a placeholder, so the two optional lines say they may be deleted.
    expect(dapp.VITE_WALLETCONNECT_PROJECT_ID).to.match(/^<fill in: .*or delete this line>$/);
    expect(dapp.VITE_SOURCE_URL).to.match(/^<fill in: .*or delete this line>$/);
    expect(dapp.VITE_API_URL).to.include("/trpc");
    expect(dapp).to.have.property("VITE_SOURCE_URL");
  });

  it("gives the API the indexer set with the historical RPC variable name", function () {
    const api = entries(serviceEnv(snapshot).api);
    expect(api.INDEXER_CHAIN_ID).to.equal("1");
    expect(api.INDEXER_CONFIRMATIONS).to.equal("6");
    expect(api.GOLD_VAULT_ADDRESS).to.equal(addr(4));
    expect(api.GOLD_VAULT_DEPLOY_BLOCK).to.equal("23456789");
    expect(api.SEPOLIA_RPC_URL).to.include("mainnet RPC");
    expect(api.REDIS_NAMESPACE).to.equal("gsusd-mainnet");
    expect(api.REDIS_URL).to.equal("redis://127.0.0.1:6379");
    expect(api).to.not.have.property("REDIS_HOST");
    expect(api.NODE_ENV).to.equal("production");
    expect(api).to.not.have.property("DAPP_DIST");
    // TRUST_PROXY_HOPS=1 is sound only while Caddy on the same host is the sole way in.
    expect(api.API_HOST).to.equal("127.0.0.1");
    expect(api.TRUST_PROXY_HOPS).to.equal("1");
    expect(api).to.not.have.property("KEEPER_PRIVATE_KEY");
  });

  it("gives the API the Usage Ledger from the deployment block, with the documented confirmation depth", function () {
    const api = entries(serviceEnv(snapshot, { deployTimestamp: 1_800_000_000 }).api);
    expect(api.LEDGER_START_TIMESTAMP).to.equal("1800000000");
    expect(api.LEDGER_STABILITY_POOL_ADDRESS).to.equal(addr(6));
    expect(api.LEDGER_CONFIRMATIONS).to.equal("12");
  });

  it("prints the ledger start as a placeholder that names the block when the timestamp is not known", function () {
    const api = entries(serviceEnv(snapshot).api);
    expect(api.LEDGER_START_TIMESTAMP).to.match(/^<fill in: unix seconds of block 23456789, the deployment block/);
    expect(api.LEDGER_STABILITY_POOL_ADDRESS).to.equal(addr(6));
  });

  it("refuses a deployment timestamp that is not whole unix seconds", function () {
    for (const bad of [0, 1.5, 1_800_000_000_000, Number.NaN, -1]) {
      expect(() => serviceEnv(snapshot, { deployTimestamp: bad })).to.throw("expected unix seconds");
    }
  });

  it("prints the two liquidity variables as comments, with the position manager of the chain and a note on when to set them", function () {
    const block = serviceEnv(snapshot, { deployTimestamp: 1_800_000_000 }).api;
    const api = entries(block);
    // Commented out: neither is a variable of the file until the pool exists.
    expect(api).to.not.have.property("LEDGER_LIQUIDITY_POOL_ADDRESS");
    expect(api).to.not.have.property("LEDGER_LIQUIDITY_POSITION_MANAGER");
    const comments = block.split("\n").filter((line) => line.startsWith("# "));
    expect(comments).to.include("# LEDGER_LIQUIDITY_POSITION_MANAGER=0xC36442b4a4522E871399CD717aBDD847Ab11FE88");
    expect(comments.some((line) => /^# LEDGER_LIQUIDITY_POOL_ADDRESS=<fill in: .*GSUSD\/USDC/.test(line))).to.equal(true);
    expect(comments.some((line) => line.includes("set once the official GSUSD/USDC pool exists"))).to.equal(true);
    // Every line is a comment or a variable, so the file loads as it is.
    for (const line of block.trim().split("\n")) expect(line).to.match(/^(#\s|[A-Z0-9_]+=)/);
    const sepolia = serviceEnv({ ...snapshot, chainId: 11155111 }).api;
    expect(sepolia).to.include("# LEDGER_LIQUIDITY_POSITION_MANAGER=0x1238536071E1c677A632429e3655c799b22cDA52");
  });

  it("builds the Usage Ledger page into the dapp on every chain", function () {
    expect(entries(serviceEnv(snapshot).dapp).VITE_LEDGER_ENABLED).to.equal("true");
    expect(entries(serviceEnv({ ...snapshot, chainId: 11155111 }).dapp).VITE_LEDGER_ENABLED).to.equal("true");
  });

  it("leaves the market tab off on mainnet: no Uniswap variable, and a comment that names the pool it needs", function () {
    const block = serviceEnv(snapshot).dapp;
    const dapp = entries(block);
    for (const key of ["VITE_UNISWAP_ROUTER", "VITE_UNISWAP_QUOTER", "VITE_DEX_POOL_FEE"]) expect(dapp, key).to.not.have.property(key);
    expect(block).to.not.include(UNISWAP[1].router);
    expect(block).to.not.include(UNISWAP[1].quoter);
    expect(block).to.include("# The market tab needs a seeded GSUSD/PAXG 0.30% Uniswap v3 pool");
    expect(block).to.include("DEX_MARKET set to 1");
    // Every line is a variable or a comment, so the block still loads as an env file.
    for (const line of block.trim().split("\n")) expect(line).to.match(/^(#\s|[A-Z0-9_]+=)/);
  });

  it("prints the market tab's variables on mainnet only when told the pool is seeded", function () {
    const block = serviceEnv(snapshot, { dexMarket: true }).dapp;
    const dapp = entries(block);
    expect(dapp.VITE_UNISWAP_ROUTER).to.equal(UNISWAP[1].router);
    expect(dapp.VITE_UNISWAP_QUOTER).to.equal(UNISWAP[1].quoter);
    expect(dapp.VITE_DEX_POOL_FEE).to.equal("3000");
    expect(block).to.include("# Market tab on");
    expect(serviceEnv(snapshot, { dexMarket: false }).dapp).to.equal(serviceEnv(snapshot).dapp);
  });

  it("asks for one or two comma-separated https endpoints in the mainnet browser RPC variable", function () {
    const dapp = entries(serviceEnv(snapshot).dapp);
    expect(dapp.VITE_MAINNET_RPC_URL).to.match(/^<fill in: one or two comma-separated https mainnet RPC endpoints/);
    expect(dapp.VITE_MAINNET_RPC_URL).to.include("fallback");
    // A placeholder, never an endpoint: nothing here could be mistaken for a URL with a key.
    expect(dapp.VITE_MAINNET_RPC_URL).to.not.match(/https?:\/\//);
  });

  it("admits both launch origins on CORS, the canonical one first, rather than every origin", function () {
    expect(LAUNCH_SITE_ORIGINS).to.deep.equal(["https://goldstandardfinance.eth.limo", "https://goldstandard.finance"]);
    expect(entries(serviceEnv(snapshot).api).CORS_ORIGINS).to.equal("https://goldstandardfinance.eth.limo,https://goldstandard.finance");
    expect(entries(serviceEnv(snapshot).api).CORS_ORIGINS).to.not.include("*");
  });

  it("takes another origin, or a list of them, when told", function () {
    expect(entries(serviceEnv(snapshot, { siteOrigins: ["https://goldstandardfinance.eth.limo/"] }).api).CORS_ORIGINS).to.equal("https://goldstandardfinance.eth.limo");
    expect(entries(serviceEnv(snapshot, { siteOrigins: ["https://a.example/app", "https://b.example"] }).api).CORS_ORIGINS).to.equal("https://a.example,https://b.example");
    expect(() => serviceEnv(snapshot, { siteOrigins: ["not a url"] })).to.throw("not a URL");
    expect(() => serviceEnv(snapshot, { siteOrigins: [] })).to.throw("SITE_URL is empty");
  });

  it("reads SITE_URL as one origin or a comma-separated list, reduced to origins without repeats", function () {
    expect(parseSiteOrigins(undefined)).to.deep.equal([...LAUNCH_SITE_ORIGINS]);
    expect(parseSiteOrigins("https://goldstandardfinance.eth.limo/")).to.deep.equal(["https://goldstandardfinance.eth.limo"]);
    expect(parseSiteOrigins(" https://goldstandardfinance.eth.limo , https://goldstandard.finance/path?x=1,https://goldstandardfinance.eth.limo ")).to.deep.equal(["https://goldstandardfinance.eth.limo", "https://goldstandard.finance"]);
    expect(() => parseSiteOrigins("")).to.throw("SITE_URL is empty");
    expect(() => parseSiteOrigins(" , ")).to.throw("SITE_URL is empty");
    expect(() => parseSiteOrigins("goldstandardfinance.eth.limo")).to.throw("not a URL");
    expect(() => parseSiteOrigins("ipfs://bafy")).to.throw("not an http(s) origin");
    expect(() => parseSiteOrigins("*")).to.throw("not a URL");
  });

  it("keeps the agent manifest on one canonical origin when SITE_URL is a list", function () {
    expect(manifestSiteUrl(undefined)).to.equal(DEFAULT_SITE_URL);
    // The project's decision: the ENS gateway is canonical, the DNS name the mirror. The manifest's
    // default and the first CORS origin are one value, so exporting SITE_URL for the service env
    // printer cannot move the manifest's links to another origin.
    expect(DEFAULT_SITE_URL).to.equal("https://goldstandardfinance.eth.limo");
    expect(manifestSiteUrl(undefined)).to.equal(parseSiteOrigins(undefined)[0]);
    expect(manifestSiteUrl(LAUNCH_SITE_ORIGINS.join(","))).to.equal(manifestSiteUrl(undefined));
    expect(manifestSiteUrl("https://goldstandardfinance.eth.limo/")).to.equal("https://goldstandardfinance.eth.limo");
    expect(() => manifestSiteUrl("goldstandardfinance.eth.limo")).to.throw("not a URL");
    expect(manifestSiteUrl("https://goldstandardfinance.eth.limo")).to.equal("https://goldstandardfinance.eth.limo");
    expect(manifestSiteUrl("https://goldstandardfinance.eth.limo, https://goldstandard.finance")).to.equal("https://goldstandardfinance.eth.limo");
    expect(() => manifestSiteUrl(" , ")).to.throw("SITE_URL is empty");
  });

  it("ships the keeper in dry run with the direct path armed and every target pinned", function () {
    const keeper = entries(serviceEnv(snapshot).keeper);
    expect(keeper.KEEPER_DRY_RUN).to.equal("true");
    expect(keeper.KEEPER_ENABLE_DIRECT).to.equal("true");
    expect(keeper.KEEPER_CHAIN_ID).to.equal("1");
    // An unfilled placeholder stops the keeper at start, so the optional read endpoints are a decision, not a default.
    expect(keeper.KEEPER_READ_RPC_URLS).to.match(/^<fill in: .*or delete this line>$/);
    expect(keeper.GSUSD_ADDRESS).to.equal(addr(2));
    expect(keeper.STABILITY_POOL_ADDRESS).to.equal(addr(6));
    expect(keeper.PAXG_TOKEN).to.equal(addr(21));
    expect(keeper.KEEPER_PRIVATE_KEY).to.include("<fill in");
    expect(keeper.KEEPER_MAX_FEE_GWEI).to.equal("150");
    expect(keeper.KEEPER_MAX_PRIORITY_FEE_GWEI).to.equal("3");
    expect(Number(keeper.KEEPER_INTERVAL_SECONDS)).to.be.within(5, 86400);
    // The stuck-transaction replacement age, inside the keeper's own bounds.
    expect(Number(keeper.KEEPER_STUCK_TX_REPLACE_SECONDS)).to.be.within(60, 86400);
    // The early warning for a late feed: the keeper's own defaults, inside its bounds.
    expect(keeper.KEEPER_FEED_HEARTBEAT_SECONDS).to.equal("86400");
    expect(keeper.KEEPER_FEED_LATE_MARGIN_SECONDS).to.equal("900");
    expect(keeper.KEEPER_FEED_LATE_REPEAT_SECONDS).to.equal("3600");
    // The dead-man ping is a decision: the keeper refuses the placeholder at start.
    expect(keeper.KEEPER_HEARTBEAT_URL).to.match(/^<fill in: https URL .*or delete this line>$/);
  });

  it("gives a keeper without a registry the API's Redis coordinates and namespace, and a registry keeper no Redis at all", function () {
    const legacy = entries(serviceEnv(snapshot).keeper);
    const api = entries(serviceEnv(snapshot).api);
    expect(legacy.REDIS_URL).to.equal(api.REDIS_URL);
    expect(legacy.REDIS_NAMESPACE).to.equal(api.REDIS_NAMESPACE);
    expect(legacy).to.not.have.property("VAULT_REGISTRY_ADDRESS");
    const withRegistry = entries(serviceEnv({ ...snapshot, addresses: { ...snapshot.addresses, vaultRegistry: addr(11) } }).keeper);
    expect(withRegistry.VAULT_REGISTRY_ADDRESS).to.equal(addr(11));
    expect(Object.keys(withRegistry).some((key) => key.startsWith("REDIS_"))).to.equal(false);
  });

  it("refuses a snapshot whose address is not an address", function () {
    expect(() => serviceEnv({ ...snapshot, addresses: { ...snapshot.addresses, vault: "0x1234" } })).to.throw("addresses.vault");
    expect(() => serviceEnv({ ...snapshot, config: { ...snapshot.config, paxgToken: "PAXG" } })).to.throw("config.paxgToken");
    expect(() => serviceEnv({ ...snapshot, addresses: { ...snapshot.addresses, vaultRegistry: "0xnope" } })).to.throw("addresses.vaultRegistry");
  });

  it("uses the Sepolia variable and addresses for a Sepolia snapshot", function () {
    const dapp = entries(serviceEnv({ ...snapshot, chainId: 11155111 }).dapp);
    expect(dapp.VITE_TARGET_CHAIN_ID).to.equal("11155111");
    expect(dapp).to.have.property("VITE_SEPOLIA_RPC_URL");
    expect(dapp.VITE_SEPOLIA_RPC_URL).to.equal("<fill in: sepolia RPC URL the browser may call>");
    // Sepolia is unchanged: the market tab's variables are always printed, with or without the mainnet flag.
    expect(dapp.VITE_UNISWAP_ROUTER).to.equal(UNISWAP[11155111].router);
    expect(dapp.VITE_UNISWAP_QUOTER).to.equal(UNISWAP[11155111].quoter);
    expect(dapp.VITE_DEX_POOL_FEE).to.equal("3000");
    const sepolia = serviceEnv({ ...snapshot, chainId: 11155111 });
    expect(sepolia.dapp).to.not.include("#");
    expect(serviceEnv({ ...snapshot, chainId: 11155111 }, { dexMarket: true }).dapp).to.equal(sepolia.dapp);
  });

  it("refuses an unknown chain or an incomplete snapshot", function () {
    expect(() => serviceEnv({ ...snapshot, chainId: 31337 })).to.throw("31337");
    expect(() => serviceEnv({ ...snapshot, addresses: { ...snapshot.addresses, reserve: "" } })).to.throw("reserve");
  });
});
