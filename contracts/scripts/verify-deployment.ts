import { ethers } from "hardhat";
import type { IAccessControl } from "../typechain-types";
import * as fs from "fs";
import * as path from "path";
import { DEFAULTS, isMainnetProfile, MAINNET_MIN_DEBT, PAXG_BACKSTOP_MAX, parsePreflightRecord, preflightRecordName, snapshotRecordMismatches } from "./lib/launchEnv";
import { launchParameterChecks, readLaunchParameters } from "./lib/launchParameterChecks";
import { isInactiveFeed, readPythFeed, readTwapFeed } from "./lib/marketFeeds";
import { reservePolicyVerdict } from "./lib/minReserve";
import { describeError } from "./lib/redact";
import { xautStatusOf } from "./lib/snapshotRefresh";
import { readCountedBalance, strandedFindings } from "./lib/strandedBalances";
import { siloGapChecks } from "./lib/siloGap";
import { censusAddresses, censusFromBlock, censusNames, censusTargets, takeRoleCensus, timelockGracePeriodCheck } from "./lib/roleCensus";

/**
 * Post-deployment verification script.
 *
 * Loads `deployments/<network>.json` (written by scripts/deploy.ts), then
 * confirms on-chain that every role, wiring, and config parameter matches
 * what was intended. Exits non-zero on any mismatch. Run after deploy, and
 * again after the governance transfer to catch incomplete transitions.
 *
 * Usage:
 *   npx hardhat run scripts/verify-deployment.ts --network <net>
 *
 * Env vars:
 *   EXPECT_GOVERNANCE_TRANSFERRED=1  additionally asserts the deployer no longer holds
 *                                    DEFAULT_ADMIN on any contract and the timelock does.
 *                                    It also switches the role census from the deployer
 *                                    as the authority to the timelock.
 *
 * The role census (scripts/lib/roleCensus.ts) rebuilds every privileged role's whole holder
 * set, from getRoleMember where the contract is enumerable and from the RoleGranted and
 * RoleRevoked logs everywhere, and fails any set that is not exactly the one the ceremony
 * intends: a planted second holder is named, whoever it is. It also asserts that the wrapper's
 * own PROPOSER_ROLE and EXECUTOR_ROLE holders are exactly the timelock's, the wrapper aside
 * (gov:wrapper-roles-match-timelock): a Safe revoked on one list alone keeps its power through
 * the other.
 *
 * Where deployments/<network>.preflight.json exists (the preflight writes it; mainnet
 * requires it) the snapshot's config is compared with the parameters the preflight
 * recorded, so a deploy that ran on different values than the preflight saw cannot pass.
 *
 * Every launch parameter the snapshot records is compared with the chain by equality, and
 * the runtime code at every address with build.runtimeCodeHashes
 * (scripts/lib/launchParameterChecks.ts). A value the snapshot does not record fails; a testnet
 * snapshot written before it was recorded gains it from refresh-deployment-snapshot.ts.
 */

interface Deployment {
  chainId: number;
  network: string;
  deployer: string;
  /** The vault's creation block. */
  deployBlock?: number;
  /** Every contract's creation block; recorded by deploy.ts from 2026-11-06, absent before. */
  creationBlocks?: Record<string, number>;
  addresses: Record<string, string>;
  /** The compiler and the runtime code hash at each address; written by deploy.ts. */
  build?: { runtimeCodeHashes?: Record<string, string> };
  config: {
    [key: string]: unknown;
    paxgToken: string;
    xautToken: string;
    paxgFeed: string;
    xautFeed: string;
    anchorFeed?: string; // XAU/USD anchor; absent or empty in pre-registry snapshots
    xautActive?: boolean; // false under open and backstop; absent (active) in older snapshots
    /** Stamped by refresh-deployment-snapshot.ts (XAUT_ACTIVATED=1) once governance has activated XAUT. */
    xautActivatedAt?: string;
    /** The feed the oracle prices XAUT on since its activation; xautFeed stays the constructor argument. */
    xautMarketFeed?: string;
    paxgBackstopMax?: string;
    backstopRehearsal?: boolean;
    paxgGoldBandPpm?: string;
    paxgLiquidationClampPpm?: string;
    proposers: string[];
    executors: string[];
    guardian: string;
    stalenessThreshold: number;
    siloCap: string;
    paxg: CollateralCfg;
    xaut: CollateralCfg;
    launchCaps?: string;
    minDebt?: string;
    underwaterDiscountPpm?: string;
    originationFeeBps?: string;
    parametersHash?: string;
  };
  governanceTransferred: boolean;
  /** Set by refresh-deployment-snapshot.ts once governance has moved a parameter. */
  parametersRefreshedAt?: string;
  /** The contract that created the token with CREATE2, and its salt; absent from deployments made before it. */
  stablecoinDeployer?: { address: string; salt: string };
}

interface CollateralCfg {
  minRatio: number;
  liqRatio: number;
  liqPenalty: number;
  debtCeiling: string;
  stabilityFeeBps: number;
}

/** A warning passes but is listed: a launch step still to run or a state to accept, not a broken deployment. */
type Check = { name: string; pass: boolean; detail?: string; warning?: string };

function ok(name: string): Check {
  return { name, pass: true };
}
function fail(name: string, detail: string): Check {
  return { name, pass: false, detail };
}
function warn(name: string, warning: string): Check {
  return { name, pass: true, warning };
}

async function main() {
  const [signer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();
  const file = path.resolve(__dirname, "..", "deployments", `${network.name}.json`);
  if (!fs.existsSync(file)) {
    throw new Error(`No deployment snapshot at ${file}. Run scripts/deploy.ts first.`);
  }
  const dep: Deployment = JSON.parse(fs.readFileSync(file, "utf8"));
  if (dep.chainId !== Number(network.chainId)) {
    throw new Error(
      `Chain mismatch: snapshot says ${dep.chainId}, connected to ${network.chainId}`
    );
  }

  const a = dep.addresses;
  const c = dep.config;
  // XAUT is dormant under open and backstop: an oracle entry and nothing else.
  const xautActive = c.xautActive !== false;
  // "activated": governance activated XAUT after the launch and a refresh recorded it (issue 75).
  const xautStatus = xautStatusOf(c);
  const onMainnet = Number(network.chainId) === 1;
  const expectTransferred = process.env.EXPECT_GOVERNANCE_TRANSFERRED === "1";

  const vault = await ethers.getContractAt("GoldVault", a.vault);
  const oracle = await ethers.getContractAt("GoldOracle", a.oracle);
  const stablecoin = await ethers.getContractAt("GoldStablecoin", a.stablecoin);
  const stabilityModule = await ethers.getContractAt("StabilityModule", a.stabilityModule);
  const surplusBuffer = await ethers.getContractAt("SurplusBuffer", a.surplusBuffer);
  const stabilityPool = await ethers.getContractAt("StabilityPool", a.stabilityPool);
  const reserve = await ethers.getContractAt("GoldStabilityReserve", a.reserve);
  const siloFactory = await ethers.getContractAt("SiloFactory", a.siloFactory);
  const governance = await ethers.getContractAt("GoldGovernance", a.governance);

  const checks: Check[] = [];

  // ---- Preflight record ----
  // The preflight wrote every effective parameter and its hash before the ceremony; the
  // snapshot must carry the same values, or the deploy ran on an environment the preflight
  // never saw. Skipped once governance has refreshed the snapshot, since the record describes
  // the launch and not the current parameters.
  {
    const recordPath = path.resolve(__dirname, "..", "deployments", preflightRecordName(network.name));
    if (fs.existsSync(recordPath)) {
      const record = parsePreflightRecord(fs.readFileSync(recordPath, "utf8"));
      if (dep.parametersRefreshedAt !== undefined) {
        checks.push(ok(`preflight:record (skipped: snapshot refreshed ${dep.parametersRefreshedAt})`));
      } else {
        const mismatches = snapshotRecordMismatches(dep.config, record.parameters);
        // deploy.ts always records the hash; a snapshot without it is not one the ceremony wrote.
        const hashProblem =
          dep.config.parametersHash === undefined
            ? ["the snapshot records no parametersHash"]
            : dep.config.parametersHash === record.parametersHash
              ? []
              : ["parametersHash differs"];
        checks.push(
          mismatches.length === 0 && hashProblem.length === 0
            ? ok("preflight:record-matches-snapshot")
            : fail("preflight:record-matches-snapshot", [...mismatches, ...hashProblem].join("; "))
        );
      }
    } else if (Number(network.chainId) === 1) {
      checks.push(fail("preflight:record", `no ${recordPath}; the mainnet ceremony starts with scripts/preflight-mainnet.ts`));
    } else {
      console.log("(No preflight record for this network; the snapshot is not compared with one.)");
    }
  }

  // ---- Code deployed ----
  for (const [name, addr] of Object.entries(a)) {
    const code = await ethers.provider.getCode(addr);
    checks.push(
      code === "0x"
        ? fail(`code:${name}`, `no bytecode at ${addr}`)
        : ok(`code:${name}`)
    );
  }

  // ---- Role wiring ----
  const MINTER_ROLE = await stablecoin.MINTER_ROLE();
  const VAULT_ROLE_SM = await stabilityModule.VAULT_ROLE();
  const VAULT_ROLE_SB = await surplusBuffer.VAULT_ROLE();
  const VAULT_ROLE_SP = await stabilityPool.VAULT_ROLE();
  const GUARDIAN_ROLE_V = await vault.GUARDIAN_ROLE();
  const GUARDIAN_ROLE_O = await oracle.GUARDIAN_ROLE();
  const ADMIN_ROLE = await vault.DEFAULT_ADMIN_ROLE();

  checks.push(
    (await stablecoin.hasRole(MINTER_ROLE, a.vault))
      ? ok("role:stablecoin.MINTER_ROLE->vault")
      : fail("role:stablecoin.MINTER_ROLE->vault", "not granted")
  );

  // ---- The token's address ----
  // The token was created by the deployer contract, at the address its salt gives, and that
  // contract passed the admin role on and kept none: it must hold no role on the token now.
  if (dep.stablecoinDeployer) {
    const tokenDeployer = await ethers.getContractAt("GoldStablecoinDeployer", dep.stablecoinDeployer.address);
    const [created, predicted, owner] = await Promise.all([tokenDeployer.token(), tokenDeployer.predict(dep.stablecoinDeployer.salt), tokenDeployer.owner()]);
    const sameAddress = (x: string, y: string): boolean => x.toLowerCase() === y.toLowerCase();
    checks.push(
      sameAddress(created, a.stablecoin)
        ? ok("token:created-by-the-deployer-contract")
        : fail("token:created-by-the-deployer-contract", `the deployer contract ${dep.stablecoinDeployer.address} created ${created}, and the snapshot names ${a.stablecoin}`)
    );
    checks.push(
      sameAddress(predicted, a.stablecoin)
        ? ok("token:address-follows-from-the-recorded-salt")
        : fail("token:address-follows-from-the-recorded-salt", `the recorded salt gives ${predicted}, and the snapshot names ${a.stablecoin}`)
    );
    checks.push(
      sameAddress(owner, dep.deployer)
        ? ok("token:deployer-contract.owner-is-the-deployer")
        : fail("token:deployer-contract.owner-is-the-deployer", `its owner is ${owner}, and the snapshot's deployer is ${dep.deployer}`)
    );
    const tokenAdminRole = await stablecoin.DEFAULT_ADMIN_ROLE();
    const [keepsAdmin, keepsMinter] = await Promise.all([stablecoin.hasRole(tokenAdminRole, dep.stablecoinDeployer.address), stablecoin.hasRole(MINTER_ROLE, dep.stablecoinDeployer.address)]);
    checks.push(
      !keepsAdmin && !keepsMinter
        ? ok("token:deployer-contract.holds-no-role")
        : fail("token:deployer-contract.holds-no-role", `the deployer contract holds ${keepsAdmin ? "DEFAULT_ADMIN_ROLE" : "MINTER_ROLE"} on the token`)
    );
  } else if (Number((await ethers.provider.getNetwork()).chainId) === 1) {
    // The mainnet deployment creates the token through the deployer contract; a snapshot without it is not that deployment's.
    checks.push(fail("token:created-by-the-deployer-contract", "the snapshot names no stablecoinDeployer, and the mainnet ceremony records one"));
  }
  checks.push(
    (await stabilityModule.hasRole(VAULT_ROLE_SM, a.vault))
      ? ok("role:stabilityModule.VAULT_ROLE->vault")
      : fail("role:stabilityModule.VAULT_ROLE->vault", "not granted")
  );
  checks.push(
    (await surplusBuffer.hasRole(VAULT_ROLE_SB, a.vault))
      ? ok("role:surplusBuffer.VAULT_ROLE->vault")
      : fail("role:surplusBuffer.VAULT_ROLE->vault", "not granted")
  );
  checks.push(
    (await surplusBuffer.hasRole(VAULT_ROLE_SB, a.reserve))
      ? ok("role:surplusBuffer.VAULT_ROLE->reserve")
      : fail("role:surplusBuffer.VAULT_ROLE->reserve", "not granted (reserve needs this to bank the spread)")
  );
  // GoldVault books bad debt absorption from the fall in GSUSD supply, so the buffer must burn
  // what it absorbs. A buffer built before that transferred it to the vault, where it
  // would sit stranded with nothing booked. The vault refuses such a buffer at
  // wiring time; this check also catches a deployment that predates the rule.
  {
    const burns = await surplusBuffer.absorptionBurns().catch(() => false);
    checks.push(
      burns
        ? ok("treasury:surplusBuffer.absorption-burns")
        : fail("treasury:surplusBuffer.absorption-burns", "the buffer does not declare absorptionBurns(): it predates burning what it absorbs; redeploy the buffer with the vault")
    );
  }
  // GoldVault.liquidateViaPool sends the seized gold to the pool and then calls
  // absorbLiquidationPrefunded, with no fallback. The vault refuses to wire a pool that does
  // not declare that path; this check reads the declaration from the pool the vault is
  // actually wired to, so a deployment that predates the rule is caught as well.
  {
    const wiredPool: string = await vault.stabilityPool();
    const declares =
      wiredPool === ethers.ZeroAddress
        ? false
        : await (await ethers.getContractAt("StabilityPool", wiredPool)).absorbsPrefunded().catch(() => false);
    checks.push(
      declares
        ? ok("wire:stabilityPool.absorbsPrefunded")
        : fail(
            "wire:stabilityPool.absorbsPrefunded",
            wiredPool === ethers.ZeroAddress
              ? "the vault has no stability pool wired"
              : `the pool the vault is wired to (${wiredPool}) does not declare absorbsPrefunded(): every pool liquidation would revert`
          )
    );
  }
  checks.push(
    (await reserve.hasRole(await reserve.VAULT_ROLE(), a.vault))
      ? ok("role:reserve.VAULT_ROLE->vault")
      : fail("role:reserve.VAULT_ROLE->vault", "not granted (vault needs this to route penalty gold)")
  );
  // THE defining property of the reserve: it holds assets and owes nothing. It must
  // never be able to mint GSUSD.
  checks.push(
    (await stablecoin.hasRole(await stablecoin.MINTER_ROLE(), a.reserve))
      ? fail("invariant:reserve-holds-no-MINTER_ROLE", "the reserve can mint GSUSD — this makes the protocol the bearer of gold/USD risk")
      : ok("invariant:reserve-holds-no-MINTER_ROLE")
  );
  checks.push(
    (await stabilityPool.hasRole(VAULT_ROLE_SP, a.vault))
      ? ok("role:stabilityPool.VAULT_ROLE->vault")
      : fail("role:stabilityPool.VAULT_ROLE->vault", "not granted")
  );
  checks.push(
    (await vault.hasRole(GUARDIAN_ROLE_V, c.guardian))
      ? ok("role:vault.GUARDIAN_ROLE->guardian")
      : fail("role:vault.GUARDIAN_ROLE->guardian", `guardian ${c.guardian} missing role`)
  );
  checks.push(
    (await oracle.hasRole(GUARDIAN_ROLE_O, c.guardian))
      ? ok("role:oracle.GUARDIAN_ROLE->guardian")
      : fail("role:oracle.GUARDIAN_ROLE->guardian", `guardian ${c.guardian} missing role`)
  );

  // Guardian role on GoldStabilityReserve and StabilityPool
  const GUARDIAN_ROLE_R = await reserve.GUARDIAN_ROLE();
  const GUARDIAN_ROLE_SP = await stabilityPool.GUARDIAN_ROLE();
  checks.push(
    (await reserve.hasRole(GUARDIAN_ROLE_R, c.guardian))
      ? ok("role:reserve.GUARDIAN_ROLE->guardian")
      : fail("role:reserve.GUARDIAN_ROLE->guardian", `guardian ${c.guardian} missing role`)
  );
  checks.push(
    (await stabilityPool.hasRole(GUARDIAN_ROLE_SP, c.guardian))
      ? ok("role:stabilityPool.GUARDIAN_ROLE->guardian")
      : fail("role:stabilityPool.GUARDIAN_ROLE->guardian", `guardian ${c.guardian} missing role`)
  );

  // SiloFactory wiring
  if (a.siloFactory) {
    const VAULT_ROLE_SF = await siloFactory.VAULT_ROLE();
    checks.push(
      (await siloFactory.hasRole(VAULT_ROLE_SF, a.vault))
        ? ok("role:siloFactory.VAULT_ROLE->vault")
        : fail("role:siloFactory.VAULT_ROLE->vault", "not granted")
    );
    // Custody: VAULT_ROLE must be permanent. Before the lock, the factory's admin key
    // could grant itself the role and empty every silo behind the vault's back.
    const locked = await siloFactory.vaultRoleLocked();
    const admin = await siloFactory.getRoleAdmin(VAULT_ROLE_SF);
    const LOCKED_ROLE = await siloFactory.LOCKED_ROLE();
    checks.push(
      locked && admin === LOCKED_ROLE
        ? ok("custody:siloFactory.VAULT_ROLE-locked")
        : fail("custody:siloFactory.VAULT_ROLE-locked", "admin key can still grant VAULT_ROLE and drain silos")
    );
    // LOCKED_ROLE must administer itself, so nobody can be granted it; the census below proves
    // it has no member. A holder would be the permanent admin of VAULT_ROLE, a drain key.
    checks.push(
      (await siloFactory.getRoleAdmin(LOCKED_ROLE)) === LOCKED_ROLE
        ? ok("custody:siloFactory.LOCKED_ROLE-self-administered")
        : fail("custody:siloFactory.LOCKED_ROLE-self-administered", "DEFAULT_ADMIN_ROLE administers LOCKED_ROLE, so the admin key could grant it and become the permanent admin of VAULT_ROLE")
    );
    let grantBlocked = false;
    try {
      await siloFactory.grantRole.staticCall(VAULT_ROLE_SF, signer.address);
    } catch {
      grantBlocked = true;
    }
    checks.push(
      grantBlocked
        ? ok("custody:siloFactory.grantRole(VAULT_ROLE)-reverts-for-signer")
        : fail("custody:siloFactory.grantRole(VAULT_ROLE)-reverts-for-signer", "signer could grant VAULT_ROLE")
    );
    // A deposit creates every silo missing up to the cursor, so a cursor moved far ahead
    // (setCurrentSiloIndex) must be followed by createSilos in batches, or the next deposit
    // can need more gas than a transaction may carry. The factory must offer the batch call,
    // and no token may be left with more than the one silo an ordinary deposit creates.
    const gapTokens = [
      { label: "PAXG", address: c.paxgToken },
      { label: "XAUT", address: c.xautToken },
    ].filter((t) => !!t.address);
    checks.push(...(await siloGapChecks(siloFactory, gapTokens)));
  }

  // The guardian-level resync must exist: it re-anchors lastKnownPrice, which the emergency
  // liquidation path reads while paused, without waiting out the timelock's delay.
  checks.push(
    oracle.interface.hasFunction("guardianResyncLastKnownPrice")
      ? ok("ops:oracle.guardianResyncLastKnownPrice-present")
      : fail("ops:oracle.guardianResyncLastKnownPrice-present", "oracle predates the guardian resync")
  );

  // ---- Launch parameters and runtime code, by equality with the snapshot ----
  // The stability fees, minDebt, the underwater discount, the origination fee, the penalty share,
  // both breakers, the reserve's minimums, caps and spread curve, the buffer's floors, the silo
  // cap and lock, then keccak256 of the code at every address against build.runtimeCodeHashes.
  // Each fails when the snapshot does not record it, rather than passing unchecked. Refreshed
  // by refresh-deployment-snapshot.ts after a governed change, the hashes excepted.
  try {
    checks.push(...launchParameterChecks(dep, await readLaunchParameters(dep)));
  } catch (error) {
    checks.push(fail("param:launch-parameters", `could not be read: ${describeError(error).slice(0, 200)}`));
  }

  // ---- Module wiring ----
  const pairs: Array<[string, Promise<string>, string]> = [
    ["vault.oracle", vault.oracle(), a.oracle],
    ["vault.stablecoin", vault.stablecoin(), a.stablecoin],
    ["vault.stabilityModule", vault.stabilityModule(), a.stabilityModule],
    ["vault.surplusBuffer", vault.surplusBuffer(), a.surplusBuffer],
    ["vault.stabilityPool", vault.stabilityPool(), a.stabilityPool],
    ["vault.stabilityReserve", vault.stabilityReserve(), a.reserve],
    ["reserve.oracle", reserve.oracle(), a.oracle],
    ["reserve.gsusd", reserve.gsusd(), a.stablecoin],
    ["reserve.surplusBuffer", reserve.surplusBuffer().then((addr: string) => addr), a.surplusBuffer],
  ];
  // vault.siloFactory was once absent from this table, so a setSiloFactory that
  // silently failed passed verification while the advertised censorship resistance
  // was simply not present.
  if (a.siloFactory) {
    pairs.push(["vault.siloFactory", vault.siloFactory(), a.siloFactory]);
  }
  // The registry is optional on older deployments; where the snapshot has one, both ends of
  // the wiring are asserted so a registry pointing at another vault cannot pass.
  if (a.vaultRegistry) {
    const vaultRegistry = await ethers.getContractAt("VaultRegistry", a.vaultRegistry);
    pairs.push(["vaultRegistry.vault", vaultRegistry.vault(), a.vault]);
    // A vault deployed before the registry hook has no vaultRegistry(): the call reverts.
    // The registry then lives on VaultRegistry.sync alone until the next redeploy, which is
    // a real gap in the deployment and is reported as one.
    const wired = await vault.vaultRegistry().catch(() => null);
    pairs.push([
      "vault.vaultRegistry",
      Promise.resolve(wired ?? "vault predates the registry hook; VaultRegistry.sync keeps the list current until the next redeploy"),
      a.vaultRegistry,
    ]);
  }
  for (const [label, promise, expected] of pairs) {
    const got = await promise;
    checks.push(
      got.toLowerCase() === expected.toLowerCase()
        ? ok(`wire:${label}`)
        : fail(`wire:${label}`, `got ${got}, expected ${expected}`)
    );
  }

  // ---- Oracle config ----
  checks.push(
    (await oracle.paxgUsdFeed()).toLowerCase() === c.paxgFeed.toLowerCase()
      ? ok("oracle:paxgFeed")
      : fail("oracle:paxgFeed", "mismatch")
  );
  checks.push(
    // After a recorded activation the oracle prices XAUT on the feed the batch set, not the constructor's.
    (await oracle.xautUsdFeed()).toLowerCase() === (c.xautMarketFeed ?? c.xautFeed).toLowerCase()
      ? ok("oracle:xautFeed")
      : fail("oracle:xautFeed", "mismatch")
  );
  const staleness = Number(await oracle.stalenessThreshold());
  checks.push(
    staleness === c.stalenessThreshold
      ? ok("oracle:stalenessThreshold")
      : fail("oracle:stalenessThreshold", `got ${staleness}, expected ${c.stalenessThreshold}`)
  );

  // ---- Oracle feed registry ----
  const paxgRegistry = await oracle.feeds(c.paxgToken);
  checks.push(
    paxgRegistry.supported
      ? ok("oracle:registry.paxg-supported")
      : fail("oracle:registry.paxg-supported", "PAXG missing from the feed registry")
  );
  const xautRegistry = await oracle.feeds(c.xautToken);
  checks.push(
    xautRegistry.supported
      ? ok("oracle:registry.xaut-supported")
      : fail("oracle:registry.xaut-supported", "XAUT missing from the feed registry")
  );
  const supported = (await oracle.getSupportedTokens()).map((t: string) => t.toLowerCase());
  const bothListed =
    supported.includes(c.paxgToken.toLowerCase()) && supported.includes(c.xautToken.toLowerCase());
  checks.push(
    bothListed
      ? ok("oracle:registry.enumeration")
      : fail("oracle:registry.enumeration", `getSupportedTokens missing a token: [${supported.join(", ")}]`)
  );

  // ---- Liveness hardening ----
  // The minter lock is a one-way governance action taken at steady state (LAUNCH.md step 5);
  // before that it is reported, after that it is required. The pause window is a constant
  // shared by the vault, oracle and pool, so a mismatch means a different build.
  {
    const locked: boolean = await stablecoin.mintersLocked();
    const expectLocked = process.env.EXPECT_MINTERS_LOCKED === "1";
    checks.push(
      locked
        ? ok("stablecoin:minters-locked")
        : expectLocked
          ? fail("stablecoin:minters-locked", "MINTER_ROLE can still be granted; call lockMinters(vault) through governance")
          : ok("stablecoin:minters (unlocked until steady state; EXPECT_MINTERS_LOCKED=1 enforces)")
    );
    const window: bigint = await vault.MAX_PAUSE_DURATION();
    const oracleWindow: bigint = await oracle.MAX_PAUSE_DURATION();
    const poolWindow: bigint = await stabilityPool.MAX_PAUSE_DURATION();
    checks.push(
      window === 14n * 86400n && oracleWindow === window && poolWindow === window
        ? ok("liveness:pause-window-14d")
        : fail("liveness:pause-window-14d", `vault ${window}s, oracle ${oracleWindow}s, pool ${poolWindow}s`)
    );
  }

  // ---- Oracle anchors seeded ----
  // lastKnownPrice is what getCollateralisationRatio, the keeper's degraded path and the
  // dapp price off; it stays 0 until the first getTokenPrice per token. deploy.ts seeds it,
  // and the keeper re-anchors it outside dry run, so a zero here means neither has run.
  const seededTokens: Array<[string, string]> = [["paxg", c.paxgToken]];
  if (xautActive) seededTokens.push(["xaut", c.xautToken]);
  for (const [label, token] of seededTokens) {
    const anchor: bigint = await oracle.getLastKnownPrice(token);
    checks.push(
      anchor > 0n
        ? ok(`oracle:${label}.lastKnownPrice-seeded`)
        : fail(
            `oracle:${label}.lastKnownPrice-seeded`,
            "anchor is 0: ratio reads have no price until someone calls getTokenPrice; poke it (the keeper does outside dry run)"
          )
    );
  }

  // ---- Oracle anchor feed ----
  const onChainAnchor = (await oracle.anchorFeed()).toLowerCase();
  const expectedAnchor = (c.anchorFeed ?? "").toLowerCase();
  if (expectedAnchor && expectedAnchor !== ethers.ZeroAddress.toLowerCase()) {
    checks.push(
      onChainAnchor === expectedAnchor
        ? ok("oracle:anchorFeed")
        : fail("oracle:anchorFeed", `got ${onChainAnchor}, expected ${expectedAnchor}`)
    );
  } else if (Number(network.chainId) === 1) {
    // Mainnet with no anchor: the cross-feed consistency check is disabled. Fail loudly.
    checks.push(
      fail(
        "oracle:anchorFeed",
        "mainnet deployment without an XAU/USD anchor — the cross-feed consistency check is disabled"
      )
    );
  } else {
    console.log("(Anchor feed unset — cross-feed consistency check disabled on this network.)");
  }

  // ---- PAXG's sources, band and clamp (docs/ORACLE_IMPLEMENTATION_PLAN.md) ----
  // C is the token's Chainlink feed and G the XAU/USD anchor; nothing else prices. The band and
  // the clamp are the recorded values. Then the views a borrower, a liquidator and the reserve
  // depend on must answer now.
  {
    const primary = ((await oracle.feeds(c.paxgToken)).feed as string).toLowerCase();
    if (primary === onChainAnchor) checks.push(fail("oracle:paxg.primary", "the primary feed is the XAU/USD anchor, never PAXG's market price"));
    if (await readPythFeed(ethers.provider, primary)) checks.push(fail("oracle:paxg.primary", "is a PythMarketFeed; Pyth is outside the production path"));
    else if (await readTwapFeed(ethers.provider, primary)) checks.push(fail("oracle:paxg.primary", "is a UniswapV3TwapFeed; pool prices are outside the production path"));
    else checks.push(ok("oracle:paxg.primary (not a Pyth or pool adapter)"));
    const bands: Array<[string, () => Promise<bigint>, string]> = [
      ["oracle:paxg.goldBandPpm", () => oracle.goldBandPpm(c.paxgToken), c.paxgGoldBandPpm ?? DEFAULTS.paxgGoldBandPpm.toString()],
      ["oracle:paxg.liquidationClampPpm", () => oracle.liquidationClampPpm(c.paxgToken), c.paxgLiquidationClampPpm ?? DEFAULTS.paxgLiquidationClampPpm.toString()],
    ];
    for (const [label, readBand, expected] of bands) {
      const got = await readBand();
      checks.push(got === BigInt(expected) ? ok(`${label} (${got})`) : fail(label, `got ${got}, expected ${expected}`));
    }
    const quoted: Array<[string, string]> = [["paxg", c.paxgToken]];
    if (xautActive) quoted.push(["xaut", c.xautToken]);
    for (const [label, token] of quoted) {
      for (const view of ["quoteTokenPrice", "quoteBorrowPrice", "quoteReservePrice"] as const) {
        const check = `oracle:${label}.${view}-live`;
        try {
          const price: bigint = await oracle[view](token);
          checks.push(price > 0n ? ok(`${check} ($${ethers.formatUnits(price, 8)})`) : fail(check, "answered 0"));
        } catch (error) {
          checks.push(fail(check, `reverted: ${describeError(error).slice(0, 160)}`));
        }
      }
    }
  }

  // ---- XAUT: active on testnets, dormant at launch ----
  // Dormant means an oracle entry (the constructor's, on XAUT_FEED) and nothing else: no
  // collateral type, no stability fee, no reserve asset and no stability pool token. Mainnet
  // requires the dormant configuration.
  const xautId = ethers.keccak256(ethers.solidityPacked(["address"], [c.xautToken]));
  if (onMainnet && xautStatus === "activated") {
    checks.push(ok(`xaut:activated (the snapshot records governance activating XAUT, ${c.xautActivatedAt})`));
  } else if (onMainnet && xautActive) {
    checks.push(
      fail(
        "xaut:dormant",
        "the snapshot records XAUT as active with no recorded activation; the mainnet launch keeps it dormant, and an activation by governance is recorded with XAUT_ACTIVATED=1 scripts/refresh-deployment-snapshot.ts"
      )
    );
  }
  if (!xautActive) {
    const xautType = await vault.collateralTypes(xautId);
    checks.push(!xautType.active ? ok("xaut:inactive.collateral-type") : fail("xaut:inactive.collateral-type", "XAUT is an active collateral type"));
    checks.push(xautType.debtCeiling === 0n ? ok("xaut:inactive.debt-ceiling") : fail("xaut:inactive.debt-ceiling", `ceiling ${xautType.debtCeiling}`));
    const accumulator = await stabilityModule.rateAccumulator(xautId);
    checks.push(accumulator === 0n ? ok("xaut:inactive.stability-fee") : fail("xaut:inactive.stability-fee", "initCollateral was called for XAUT"));
    const asset = await reserve.assets(c.xautToken);
    checks.push(!asset.supported ? ok("xaut:inactive.reserve-asset") : fail("xaut:inactive.reserve-asset", "XAUT is a supported reserve asset"));
    checks.push(!(await stabilityPool.isCollateralToken(c.xautToken)) ? ok("xaut:inactive.pool-token") : fail("xaut:inactive.pool-token", "XAUT is a stability pool collateral token"));
    // Its oracle entry sits on an InactiveFeed (8 decimals, "Inactive", an all-zero round), so
    // every read refuses it rather than pricing it on anything.
    const xautFeed = (await oracle.feeds(c.xautToken)).feed as string;
    checks.push((await isInactiveFeed(ethers.provider, xautFeed)) ? ok("xaut:inactive.oracle-feed") : fail("xaut:inactive.oracle-feed", `${xautFeed} is not an InactiveFeed`));
    try {
      const priced: bigint = await oracle.quoteTokenPrice(c.xautToken);
      checks.push(fail("xaut:inactive.unpriced", `quoteTokenPrice(XAUT) answered ${priced}`));
    } catch (error) {
      const message = describeError(error);
      checks.push(message.includes("No reliable price") ? ok("xaut:inactive.unpriced") : fail("xaut:inactive.unpriced", `reverted otherwise: ${message.slice(0, 120)}`));
    }
  }

  // ---- Oracle feed liveness ----
  // Age is measured against the chain's clock, the way the oracle measures it; a fork or a
  // Hardhat node drifts from the wall clock.
  const chainNow = (await ethers.provider.getBlock("latest"))?.timestamp ?? Math.floor(Date.now() / 1000);
  try {
    const [paxgPrice, paxgUpdated] = await oracle.getPaxgPrice();
    const paxgAge = chainNow - Number(paxgUpdated);
    if (paxgPrice <= 0n) {
      checks.push(fail("oracle:paxg-live", `price not positive: ${paxgPrice}`));
    } else if (paxgAge >= c.stalenessThreshold) {
      checks.push(fail("oracle:paxg-live", `feed stale by ${paxgAge}s`));
    } else {
      checks.push(ok(`oracle:paxg-live ($${Number(paxgPrice) / 1e8}, ${paxgAge}s old)`));
    }
  } catch (e: unknown) {
    checks.push(fail("oracle:paxg-live", `getPaxgPrice reverted: ${describeError(e)}`));
  }
  if (xautActive) try {
    const [xautPrice, xautUpdated] = await oracle.getXautPrice();
    const xautAge = chainNow - Number(xautUpdated);
    if (xautPrice <= 0n) {
      checks.push(fail("oracle:xaut-live", `price not positive: ${xautPrice}`));
    } else if (xautAge >= c.stalenessThreshold) {
      checks.push(fail("oracle:xaut-live", `feed stale by ${xautAge}s`));
    } else {
      checks.push(ok(`oracle:xaut-live ($${Number(xautPrice) / 1e8}, ${xautAge}s old)`));
    }
  } catch (e: unknown) {
    checks.push(fail("oracle:xaut-live", `getXautPrice reverted: ${describeError(e)}`));
  }

  // ---- Collateral registration ----
  const paxgId = ethers.keccak256(ethers.solidityPacked(["address"], [c.paxgToken]));

  const paxgType = await vault.collateralTypes(paxgId);
  const xautType = await vault.collateralTypes(xautId);
  // Both are read here; the open-profile policy below compares XAUT's ceiling too.

  const assertColl = (label: string, got: bigint, expected: bigint | number) => {
    const e = BigInt(expected);
    checks.push(
      got === e ? ok(label) : fail(label, `got ${got}, expected ${e}`)
    );
  };

  checks.push(
    paxgType.active ? ok("collateral:paxg.active") : fail("collateral:paxg.active", "inactive")
  );
  assertColl("collateral:paxg.minRatio", paxgType.minRatio, c.paxg.minRatio);
  assertColl("collateral:paxg.liqRatio", paxgType.liquidationRatio, c.paxg.liqRatio);
  assertColl("collateral:paxg.liqPenalty", paxgType.liquidationPenalty, c.paxg.liqPenalty);
  assertColl("collateral:paxg.debtCeiling", paxgType.debtCeiling, BigInt(c.paxg.debtCeiling));

  if (xautActive) {
    checks.push(
      xautType.active ? ok("collateral:xaut.active") : fail("collateral:xaut.active", "inactive")
    );
    assertColl("collateral:xaut.minRatio", xautType.minRatio, c.xaut.minRatio);
    assertColl("collateral:xaut.liqRatio", xautType.liquidationRatio, c.xaut.liqRatio);
    assertColl("collateral:xaut.liqPenalty", xautType.liquidationPenalty, c.xaut.liqPenalty);
    assertColl("collateral:xaut.debtCeiling", xautType.debtCeiling, BigInt(c.xaut.debtCeiling));
  }

  // ---- Stability fee init ----
  const paxgAccum = await stabilityModule.rateAccumulator(paxgId);
  checks.push(
    paxgAccum > 0n ? ok("fee:paxg.initialised") : fail("fee:paxg.initialised", "accumulator == 0")
  );
  if (xautActive) {
    const xautAccum = await stabilityModule.rateAccumulator(xautId);
    checks.push(
      xautAccum > 0n ? ok("fee:xaut.initialised") : fail("fee:xaut.initialised", "accumulator == 0")
    );
  }

  // ---- Launch policy, asserted against CONSTANTS not the snapshot ----
  // assertColl above compares chain state to dep.config, which deploy.ts wrote from the
  // same values it deployed with — a drift check that structurally cannot detect a
  // policy deviation. On mainnet the policy itself is the thing to assert.
  const chainId = (await ethers.provider.getNetwork()).chainId;
  const openLaunch = dep.config.launchCaps === "open";
  if (openLaunch) {
    // The mainnet launch (decision of 29 October 2026): no PAXG debt ceiling from block one and
    // XAUT dormant, which the xaut:inactive checks above assert (its ceiling stays 0). Assert the
    // chain carries exactly that, so a half-applied profile cannot pass as the open one. A
    // snapshot from before XAUT went dormant under open records it active: its ceiling must then
    // be unlimited too.
    const problems: string[] = [];
    if (paxgType.debtCeiling !== ethers.MaxUint256) problems.push(`PAXG ${paxgType.debtCeiling}`);
    // An XAUT activated later carries the ceiling its governance batch chose, which the refresh records.
    if (xautStatus === "active-since-deploy" && xautType.debtCeiling !== ethers.MaxUint256) problems.push(`XAUT ${xautType.debtCeiling}`);
    const xautText = xautStatus === "dormant" ? "dormant" : xautStatus === "activated" ? "activated by governance, its ceiling as recorded" : "unlimited";
    checks.push(
      problems.length === 0
        ? ok(`policy:open-launch.ceilings-unlimited (PAXG unlimited, XAUT ${xautText})`)
        : fail("policy:open-launch.ceilings-unlimited", `the open profile expects no debt ceiling on an active collateral, got ${problems.join(", ")}`)
    );
  } else if (dep.config.launchCaps === "backstop") {
    // The backstop: one finite PAXG ceiling above zero, at most the maximum the snapshot
    // recorded, and on mainnet at most the modelled constant and never a rehearsal stand-in.
    const recordedMax = BigInt(c.paxgBackstopMax ?? "0");
    const ceiling = paxgType.debtCeiling;
    const problems: string[] = [];
    if (ceiling === 0n) problems.push("0 leaves PAXG unable to mint");
    if (ceiling === ethers.MaxUint256) problems.push("unlimited; the backstop is finite");
    if (ceiling > recordedMax) problems.push(`above the recorded maximum ${recordedMax}`);
    if (chainId === 1n && c.backstopRehearsal) problems.push("deployed with a rehearsal stand-in for the modelled maximum");
    if (chainId === 1n && ceiling > PAXG_BACKSTOP_MAX) problems.push(`above the modelled maximum ${PAXG_BACKSTOP_MAX} in scripts/lib/launchEnv.ts`);
    checks.push(problems.length === 0 ? ok(`policy:backstop.paxg-ceiling (${ethers.formatEther(ceiling)} GSUSD)`) : fail("policy:backstop.paxg-ceiling", problems.join("; ")));
  }
  if (chainId === 1n) {
    // open is the only mainnet profile, with XAUT dormant; backstop is refused (its maximum was
    // derived under the retired pool design).
    checks.push(
      isMainnetProfile(dep.config.launchCaps) && xautStatus !== "active-since-deploy"
        ? ok(`policy:mainnet-profile (${dep.config.launchCaps}, XAUT ${xautStatus === "activated" ? `activated by governance ${c.xautActivatedAt}` : "dormant"})`)
        : fail(
            "policy:mainnet-profile",
            `the snapshot records LAUNCH_CAPS=${dep.config.launchCaps ?? "guarded"} with XAUT ${xautActive ? "active since the deploy" : "dormant"}; mainnet launches under open alone, with XAUT dormant until governance activates it`
          )
    );
  }

  // ---- Origination fee ships at the launch value ----
  // The launch policy is DEFAULTS.originationFeeBps (5 bps, project decision 2026-11-02).
  // Any other value is a pricing decision governance makes deliberately after launch, not
  // one carried in on a deploy environment. Also asserts the invariant guard: a non-zero fee
  // without a SurplusBuffer would burn the fee and break `totalSupply == aggregate debt`.
  const originationFee = await vault.originationFeeBps();
  if (chainId === 1n && !process.env.ALLOW_ORIGINATION_FEE) {
    checks.push(
      originationFee === DEFAULTS.originationFeeBps
        ? ok(`policy:originationFee-at-launch (${originationFee} bps)`)
        : fail(
            "policy:originationFee-at-launch",
            `launch policy is ${DEFAULTS.originationFeeBps} bps, got ${originationFee}. Set ALLOW_ORIGINATION_FEE=1 only for a deliberate, governed change.`
          )
    );
  }
  // The documented launch minimum (docs/LAUNCH.md) is asserted here as well as in the preflight
  // and deploy.ts, so the three cannot drift apart; a later governed setMinDebt is acknowledged
  // with ALLOW_MIN_DEBT_CHANGE=1, as ALLOW_ORIGINATION_FEE is for the fee.
  if (chainId === 1n && !process.env.ALLOW_MIN_DEBT_CHANGE) {
    const liveMinDebt = await vault.minDebt();
    checks.push(
      liveMinDebt === MAINNET_MIN_DEBT
        ? ok(`policy:minDebt-at-launch (${ethers.formatEther(liveMinDebt)} GSUSD)`)
        : fail(
            "policy:minDebt-at-launch",
            `launch policy is ${ethers.formatEther(MAINNET_MIN_DEBT)} GSUSD, got ${ethers.formatEther(liveMinDebt)}. Set ALLOW_MIN_DEBT_CHANGE=1 only for a deliberate, governed change.`
          )
    );
  }
  if (originationFee > 0n) {
    const buffer = await vault.surplusBuffer();
    checks.push(
      buffer !== ethers.ZeroAddress
        ? ok("policy:originationFee-has-buffer")
        : fail(
            "policy:originationFee-has-buffer",
            "a non-zero origination fee with no SurplusBuffer burns the fee and breaks supply == debt"
          )
    );
  }

  // ---- Stability reserve: caps armed, and is there any floor at all? ----
  const reserveCapPpm = (await reserve.assets(c.paxgToken)).dailyCapPpm;
  checks.push(
    reserveCapPpm > 0n && reserveCapPpm <= 1_000_000n
      ? ok("policy:reserve.dailyCap-armed")
      : fail("policy:reserve.dailyCap-armed", `PAXG daily cap is ${reserveCapPpm} ppm; 0 disables the outflow bound`)
  );
  {
    const redeemable = await reserve.redeemableCollateral(c.paxgToken);
    const supply = await stablecoin.totalSupply();
    const coverage = await reserve.coveragePpm();
    console.log(`  reserve: redeemable PAXG ${redeemable} | coverage ${Number(coverage) / 10_000}% of circulating`);
    if (supply > 0n && redeemable === 0n) {
      console.log("  WARNING: the reserve is empty against non-zero supply. GSUSD has NO conversion floor until it is seeded.");
    }
  }

  // ---- Tokens held but not counted ----
  // The reserve and the buffer release only what their own functions booked. A plain transfer
  // to either is locked for good, so an excess is listed as a warning on every run (a
  // fork rehearsal once passed in silence with 5 PAXG stranded).
  {
    const erc20 = (address: string) => ethers.getContractAt("IERC20Metadata", address);
    const gsusdToken = await erc20(a.stablecoin);
    const goldTokens: Array<[string, string]> = [["paxg", c.paxgToken]];
    if (xautActive) goldTokens.push(["xaut", c.xautToken]);
    const balances = [
      await readCountedBalance({ label: "reserve.gsusd", token: gsusdToken, holder: a.reserve, counted: () => reserve.gsusdInventory() }),
      await readCountedBalance({ label: "buffer.gsusd", token: gsusdToken, holder: a.surplusBuffer, counted: () => surplusBuffer.gsusdBalance() }),
    ];
    for (const [label, token] of goldTokens) {
      balances.push(await readCountedBalance({ label: `reserve.${label}`, token: await erc20(token), holder: a.reserve, counted: () => reserve.collateralBalance(token) }));
      balances.push(await readCountedBalance({ label: `buffer.${label}`, token: await erc20(token), holder: a.surplusBuffer, counted: () => surplusBuffer.collateralBalance(token) }));
    }
    for (const finding of strandedFindings(balances)) {
      if (finding.failure !== undefined) checks.push(fail(finding.name, finding.failure));
      else if (finding.warning !== undefined) checks.push(warn(finding.name, finding.warning));
      else checks.push(ok(finding.name));
    }
  }

  // ---- Circuit breakers actually armed ----
  const badDebtThreshold = await vault.badDebtPauseThreshold();
  const mintCap = await vault.perBlockMintCap();
  checks.push(
    badDebtThreshold > 0n
      ? ok("breaker:badDebtPauseThreshold-armed")
      : fail("breaker:badDebtPauseThreshold-armed", "0 disables the insolvency auto-pause entirely")
  );
  if (openLaunch) {
    checks.push(
      mintCap === 0n
        ? ok("policy:open-launch.perBlockMintCap-off")
        : fail("policy:open-launch.perBlockMintCap-off", `open profile expects no per-block cap, got ${mintCap}`)
    );
  } else {
    checks.push(
      mintCap > 0n
        ? ok("breaker:perBlockMintCap-armed")
        : fail("breaker:perBlockMintCap-armed", "0 disables the per-block mint cap entirely")
    );
  }

  // ---- Treasury first-loss floor: automatic, asserted on every run ----
  // docs/BUSINESS_MODEL.md section 5 keeps at least 2% of outstanding supply in the
  // SurplusBuffer. The buffer enforces it itself: withdrawGsusd keeps
  // max(minGsusdReserve, 2% of max(live supply, one day smoothed supply)), so no governance
  // step is needed and minGsusdReserve (0 at deploy) is only an optional higher minimum.
  // The check asserts the contract enforces it: the rate is 2% and the floor it reports
  // matches the policy computed here from the same block. A buffer without the automatic
  // floor fails, whatever minGsusdReserve says.
  {
    const name = "treasury:reserve-floor-enforces-2pct-policy";
    const blockTag = await ethers.provider.getBlockNumber();
    const [supply, smoothedSupply, minReserve] = await Promise.all([
      stablecoin.totalSupply({ blockTag }),
      stablecoin.smoothedSupplyNow({ blockTag }),
      surplusBuffer.minGsusdReserve({ blockTag }),
    ]);
    let autoFloorBps: bigint | null = null;
    let effective: bigint | null = null;
    try {
      [autoFloorBps, effective] = await Promise.all([
        surplusBuffer.AUTO_FLOOR_BPS({ blockTag }),
        surplusBuffer.effectiveMinGsusdReserve({ blockTag }),
      ]);
    } catch {
      // Left null: reservePolicyVerdict reports a buffer that predates the automatic floor.
    }
    const verdict = reservePolicyVerdict({ supply, smoothedSupply, minReserve, autoFloorBps, effective });
    checks.push(verdict.level === "pass" ? ok(name) : fail(name, verdict.detail));
  }

  // ---- StabilityPool collateral registration ----
  // A missed addCollateralToken surfaces only as an "Unsupported token" revert the
  // first time liquidateViaPool is needed — i.e. during a crash.
  const poolTokens: Array<[string, string]> = [["paxg", c.paxgToken]];
  if (xautActive) poolTokens.push(["xaut", c.xautToken]);
  for (const [label, token] of poolTokens) {
    checks.push(
      (await stabilityPool.isCollateralToken(token))
        ? ok(`pool:${label}.registered`)
        : fail(`pool:${label}.registered`, "addCollateralToken was never called")
    );
  }

  // ---- The governance wrapper's targets ----
  // The wrapper's constructor takes its three targets as given: the preflight estimates that
  // creation against stand-in addresses, so it cannot probe them. setGovernedContract does
  // probe a replacement. This is the check that the targets recorded at construction, or
  // moved since, are the deployed vault, oracle and stability module: a helper proposal aimed
  // at anything else would execute and change nothing.
  for (const [label, read, expected] of [
    ["vault", () => governance.vault(), a.vault],
    ["oracle", () => governance.oracle(), a.oracle],
    ["stabilityModule", () => governance.stabilityModule(), a.stabilityModule],
  ] as const) {
    const actual = await read();
    checks.push(
      actual.toLowerCase() === expected.toLowerCase()
        ? ok(`governance:${label}`)
        : fail(`governance:${label}`, `the wrapper's ${label} is ${actual}, not the deployed ${expected}; its helper proposals would target the wrong address`)
    );
  }

  // ---- TimelockController role check ----
  // The handover check previously read only DEFAULT_ADMIN_ROLE on the nine contracts and
  // never touched the timelock itself. GoldGovernance grants every configured proposer the
  // timelock's PROPOSER_ROLE (and, under OZ v5, CANCELLER_ROLE) at construction; nothing
  // revokes or checks them. A deployer left in that list keeps the ability to schedule any
  // operation forever, while the handover script still reports "zero admin roles anywhere".
  {
    const timelock = await ethers.getContractAt(
      [
        "function getMinDelay() view returns (uint256)",
        "function hasRole(bytes32,address) view returns (bool)",
        "function PROPOSER_ROLE() view returns (bytes32)",
        "function EXECUTOR_ROLE() view returns (bytes32)",
        "function CANCELLER_ROLE() view returns (bytes32)",
        "function DEFAULT_ADMIN_ROLE() view returns (bytes32)",
      ],
      a.timelock
    );
    const minDelay: bigint = await timelock.getMinDelay();
    checks.push(
      minDelay === 48n * 3600n
        ? ok("timelock:minDelay-48h")
        : fail("timelock:minDelay-48h", `expected 172800, got ${minDelay}`)
    );
    const tlRoles: Array<[string, string]> = [
      ["proposer", await timelock.PROPOSER_ROLE()],
      ["executor", await timelock.EXECUTOR_ROLE()],
      ["canceller", await timelock.CANCELLER_ROLE()],
      ["admin", await timelock.DEFAULT_ADMIN_ROLE()],
    ];
    for (const [label, role] of tlRoles) {
      checks.push(
        !(await timelock.hasRole(role, dep.deployer))
          ? ok(`timelock:${label}.deployer-absent`)
          : fail(
              `timelock:${label}.deployer-absent`,
              `deployer holds the timelock ${label} role — it can still drive governance`
            )
      );
    }
  }

  // ---- Governance transfer state (conditional) ----
  if (expectTransferred || dep.governanceTransferred) {
    const admins: Array<[string, Pick<IAccessControl, "hasRole">]> = [
      ["stablecoin", stablecoin],
      ["oracle", oracle],
      ["vault", vault],
      ["stabilityModule", stabilityModule],
      ["surplusBuffer", surplusBuffer],
      ["stabilityPool", stabilityPool],
      ["reserve", reserve],
      // These were previously omitted, so an incomplete handover (deployer still admin
      // on the governance wrapper or the silo factory) could pass verification. Both must be checked.
      ["siloFactory", siloFactory],
      ["governance", governance],
    ];
    for (const [label, ctr] of admins) {
      const deployerHasAdmin = await ctr.hasRole(ADMIN_ROLE, dep.deployer);
      const timelockHasAdmin = await ctr.hasRole(ADMIN_ROLE, a.timelock);
      checks.push(
        !deployerHasAdmin
          ? ok(`gov:${label}.deployer-revoked`)
          : fail(`gov:${label}.deployer-revoked`, "deployer still holds DEFAULT_ADMIN_ROLE")
      );
      checks.push(
        timelockHasAdmin
          ? ok(`gov:${label}.timelock-admin`)
          : fail(`gov:${label}.timelock-admin`, "timelock missing DEFAULT_ADMIN_ROLE")
      );
    }
  } else {
    console.log("\n(Skipping governance-transfer checks — set EXPECT_GOVERNANCE_TRANSFERRED=1 after transfer.)");
  }

  // ---- Role census ----
  // The checks above ask whether a named key holds a named role, so a second holder of the same
  // role passed them: a minter planted beside the vault, a governor beside the timelock, the
  // deployer's own grant on the wrapper. The census rebuilds every privileged role's whole holder
  // set and requires exactly the set the ceremony intends, with the deployer as the authority
  // before the handover and the timelock after it, and the deployer holding nothing else.
  try {
    const addresses = censusAddresses(a);
    const latest = await ethers.provider.getBlockNumber();
    const start = await censusFromBlock(ethers.provider, { addresses, deployBlock: dep.deployBlock, creationBlocks: dep.creationBlocks }, latest);
    checks.push(start.warning === undefined ? ok(`census:from-block (${start.fromBlock}, ${start.source})`) : warn("census:from-block", start.warning));
    const policy = {
      addresses,
      deployer: dep.deployer,
      proposers: c.proposers,
      executors: c.executors,
      guardian: c.guardian,
      transferred: expectTransferred || dep.governanceTransferred,
    };
    const census = await takeRoleCensus(ethers.provider, censusTargets(policy), {
      fromBlock: start.fromBlock,
      toBlock: latest,
      deployer: dep.deployer,
      names: censusNames(policy),
    });
    checks.push(...census);
  } catch (error) {
    checks.push(fail("census", `the role census could not be taken: ${describeError(error).slice(0, 200)}`));
  }
  // A matured operation must expire: under an open executor anyone could otherwise run a stale
  // approval, an unpause made for an earlier incident, at a moment of their choosing.
  checks.push(await timelockGracePeriodCheck(ethers.provider, a.timelock));

  // ---- Report ----
  const passed = checks.filter((c) => c.pass).length;
  const failed = checks.filter((c) => !c.pass);

  const warnings = checks.filter((c) => c.warning !== undefined);

  // VERIFY_VERBOSE=1 lists every check, passed ones included, for the ceremony record.
  if (process.env.VERIFY_VERBOSE) {
    for (const c of checks) console.log(`  ${c.pass ? (c.warning ? "!" : "✓") : "✗"} ${c.name}${c.pass ? "" : `: ${c.detail ?? ""}`}`);
  }
  console.log(`\n${passed}/${checks.length} checks passed${warnings.length > 0 ? `, ${warnings.length} with a warning` : ""}`);
  if (warnings.length > 0) {
    console.log("\nWARNINGS (passing; each is a launch step still to run or a state to read and accept):");
    for (const w of warnings) console.log(`  ! ${w.name}: ${w.warning}`);
  }
  if (failed.length > 0) {
    console.log("\nFAILED:");
    for (const f of failed) {
      console.log(`  ✗ ${f.name}: ${f.detail ?? ""}`);
    }
    process.exit(1);
  }
  console.log("All verification checks passed.");
}

main().catch((error) => {
  console.error(describeError(error));
  process.exit(1);
});
