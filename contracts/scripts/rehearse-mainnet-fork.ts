/**
 * Mainnet-fork rehearsal: the REAL PAXG (fee-on-transfer mechanism, 18 decimals), the REAL
 * XAUT (6 decimals) and the REAL Chainlink PAXG/USD and XAU/USD feeds, against a fresh
 * deployment on a Hardhat fork of mainnet. Collateral comes from impersonated holders.
 * Prices cannot be moved on real feeds, so the liquidation and breaker paths are covered by
 * scripts/rehearse-testnet-flow.ts on Sepolia; this run proves the PAXG-FIRST LAUNCH
 * CONFIGURATION (docs/ORACLE_IMPLEMENTATION_PLAN.md): Chainlink PAXG/USD validates within the
 * gold band of XAU/USD, deploy.ts seeds PAXG's anchor, the launch caps match the open profile
 * (no PAXG ceiling and no per-block cap; backstop is refused on mainnet and here), PAXG
 * credits are measured not nominal, and XAUT, registered in the oracle and otherwise dormant,
 * cannot be deposited, seeded into the reserve or pooled.
 *
 *   # 1. fork (pin the block; Tenderly's public gateway also works from a sandboxed shell)
 *   npx hardhat node --fork $MAINNET_RPC --fork-block-number <head minus 3> --port 8547
 *   # 2. with .env.mainnet loaded (docs/MAINNET.md section 2): run the preflight
 *   #    (PREFLIGHT_EXPECT_CHAIN_ID=31337), deploy.ts and verify-deployment.ts against the fork:
 *   LOCAL_RPC_URL=http://127.0.0.1:8547 npx hardhat run scripts/deploy.ts --network localhost
 *   LOCAL_RPC_URL=http://127.0.0.1:8547 npx hardhat run scripts/verify-deployment.ts --network localhost
 *   LOCAL_RPC_URL=http://127.0.0.1:8547 npx hardhat run scripts/verify-deployment.ts --network localhost
 *   # 3. this rehearsal
 *   LOCAL_RPC_URL=http://127.0.0.1:8547 npx hardhat run scripts/rehearse-mainnet-fork.ts --network localhost
 *
 * The fork writes deployments/localhost.json; back that file up first if the local
 * rehearsal snapshot matters. Fork only: refuses any node that does not report itself as a
 * Hardhat node. Never point --network mainnet at a fork: that network is the real chain, and the
 * mainnet snapshot paths belong to the real launch. Every account here sends through a raw
 * provider at the fork (scripts/rehearsal/lib.ts): the deployer's development key is unlocked on
 * the node, carol and dave are funded throwaway wallets and the holders are impersonated.
 */
import { ethers, network } from "hardhat";
import type { Signer } from "ethers";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isMainnetProfile } from "./lib/launchEnv";
import { oraclePrices } from "./lib/rehearsalSizing";
import { assertFork, impersonate, wallet } from "./rehearsal/lib";
import { describeError, describeErrorStack, redactUrls } from "./lib/redact";
import type { MockAggregatorV3, MockERC20 } from "../typechain-types";

const PAXG_HOLDERS = ["0x5a52E96BAcdaBb82fd05763E25335261B270Efcb", "0xF977814e90dA44bFA03b6295A0616a897441aceC"];
const XAUT_HOLDERS = ["0x5754284f345afc66a98fbB0a0Afe71e0F007B949", "0x77134cbC06cB00b66F4c7e623D5fdBF6777635EC"];
const E18 = 10n ** 18n; const PPM = 1_000_000n;
const results: [name: string, verdict: "PASS" | "FAIL", detail: string][] = [];
const fmt = (v: bigint, d = 18) => ethers.formatUnits(v, d);
const abs = (v: bigint) => (v < 0n ? -v : v);
/** ethers errors carry a one-line shortMessage beside the full message; URLs redacted either way. */
function errorText(e: unknown, preferShort: boolean): string {
  const short = preferShort && e instanceof Error ? (e as Error & { shortMessage?: unknown }).shortMessage : undefined;
  return typeof short === "string" && short ? redactUrls(short) : describeError(e);
}
async function check(name: string, fn: () => Promise<string | void>) {
  try { const d = await fn(); results.push([name, "PASS", d || ""]); console.log(`  PASS  ${name}${d ? ": " + d : ""}`); }
  catch (e) { const m = errorText(e, true).slice(0, 300); results.push([name, "FAIL", m]); console.log(`  FAIL  ${name}: ${m}`); }
}
function assert(c: unknown, m: string): asserts c { if (!c) throw new Error(m); }
async function expectRevert(p: Promise<unknown>, contains?: string): Promise<string> {
  let msg: string; try { await p; throw new Error("__no__"); } catch (e) { msg = errorText(e, false); if (msg === "__no__") throw new Error("did not revert"); }
  if (contains && !msg.includes(contains)) throw new Error(`reverted with "${msg.slice(0, 160)}" instead of "${contains}"`);
  return contains || msg.slice(0, 100);
}
async function main() {
  await assertFork();
  const snap = JSON.parse(readFileSync(resolve(__dirname, "../deployments", `${network.name}.json`), "utf8"));
  const a = snap.addresses, c = snap.config;
  // The node unlocks the deployer's development key; carol and dave are funded throwaway wallets.
  const deployer = await impersonate(snap.deployer);
  const carol = await wallet("rehearse-carol"), dave = await wallet("rehearse-dave");
  const vault = await ethers.getContractAt("GoldVault", a.vault, deployer);
  const oracle = await ethers.getContractAt("GoldOracle", a.oracle, deployer);
  const gsusd = await ethers.getContractAt("GoldStablecoin", a.stablecoin, deployer);
  const pool = await ethers.getContractAt("StabilityPool", a.stabilityPool, deployer);
  const reserve = await ethers.getContractAt("GoldStabilityReserve", a.reserve, deployer);
  const paxg = await ethers.getContractAt("MockERC20", c.paxgToken, deployer); // ERC-20 surface only
  const xaut = await ethers.getContractAt("MockERC20", c.xautToken, deployer);
  const paxgFeed = await ethers.getContractAt("MockAggregatorV3", c.paxgFeed, deployer);
  const xauFeed = await ethers.getContractAt("MockAggregatorV3", c.anchorFeed, deployer);
  const colId = (t: string) => ethers.solidityPackedKeccak256(["address"], [t]);
  const whale = async (token: MockERC20, holders: string[], need: bigint) => {
    for (const h of holders) {
      if ((await token.balanceOf(h)) >= need) {
        return impersonate(h);
      }
    }
    throw new Error("no holder with enough balance");
  };
  const transferMeasured = async (token: MockERC20, from: Signer, to: string, amount: bigint) => {
    const before = await token.balanceOf(to);
    await (await token.connect(from).transfer(to, amount)).wait();
    return (await token.balanceOf(to)) - before;
  };
  const feedPrice = async (feed: MockAggregatorV3) =>(await feed.latestRoundData())[1];
  console.log(`\nMainnet-fork rehearsal (chainId ${(await ethers.provider.getNetwork()).chainId}), PAXG ${c.paxgToken}, XAUT ${c.xautToken}`);

  let paxgPrice = 0n;
  await check("oracle:real-chainlink-feeds-validate", async () => {
    const [p, ok] = await oracle.getValidatedPrice(c.paxgToken);
    const fp = await feedPrice(paxgFeed), fg = await feedPrice(xauFeed);
    assert(ok, "Chainlink PAXG/USD did not validate");
    assert(p === fp, "oracle price differs from the Chainlink answer");
    // The oracle measures a gap against the higher of the two prices (GoldOracle._within).
    const high = fp > fg ? fp : fg;
    const gap = abs(fp - fg) * PPM / high;
    const band = await oracle.goldBandPpm(c.paxgToken);
    assert(gap <= band, `PAXG/USD sits ${Number(gap) / 10_000}% from XAU/USD, outside the ${Number(band) / 10_000}% gold band`);
    paxgPrice = p;
    return `PAXG/USD $${fmt(p, 8)}, XAU/USD $${fmt(fg, 8)}, gap ${(Number(gap) / 10_000).toFixed(3)}% inside the ${Number(band) / 10_000}% gold band`;
  });
  await check("policy:launch-caps", async () => {
    const pc = (await vault.collateralTypes(colId(c.paxgToken))).debtCeiling;
    assert(isMainnetProfile(c.launchCaps), `the snapshot records LAUNCH_CAPS=${c.launchCaps}; rehearse the open launch, the only mainnet profile`);
    if (c.launchCaps === "open") {
      const cap = await vault.perBlockMintCap();
      assert(pc === ethers.MaxUint256, `PAXG ceiling ${pc}; the open launch has none`);
      assert(cap === 0n, `per-block mint cap ${cap}; the open launch has none`);
      return "open: PAXG ceiling unlimited, per-block mint cap off";
    }
    assert(pc > 0n && pc <= BigInt(c.paxgBackstopMax ?? "0"), `PAXG ceiling ${pc} is outside (0, ${c.paxgBackstopMax}]`);
    return `backstop: PAXG ceiling ${fmt(pc)} GSUSD within the ${fmt(BigInt(c.paxgBackstopMax ?? "0"))} GSUSD maximum`;
  });
  let credited = 0n;
  await check("paxg:fee-on-transfer-deposit-credits-received", async () => {
    const w = await whale(paxg, PAXG_HOLDERS, ethers.parseEther("60"));
    const got = await transferMeasured(paxg, w, deployer.address, ethers.parseEther("60"));
    const feeBps = Number((ethers.parseEther("60") - got) * 10_000n * 100n / ethers.parseEther("60")) / 100;
    await (await paxg.approve(a.vault, ethers.parseEther("40"))).wait();
    await (await vault.deposit(c.paxgToken, ethers.parseEther("40"))).wait();
    credited = (await vault.vaults(deployer.address))[1];
    const vaultFeeBps = Number((ethers.parseEther("40") - credited) * 10_000n * 100n / ethers.parseEther("40")) / 100;
    assert(credited <= ethers.parseEther("40") && credited >= ethers.parseEther("40") * 999n / 1000n, `credited ${fmt(credited)}`);
    assert(Math.abs(vaultFeeBps - feeBps) < 0.5, `vault credited ${vaultFeeBps} bps short but the token charged ${feeBps} bps`);
    return `PAXG transfer fee observed ${feeBps} bps (PAXG has no transfer fee since its June 2026 upgrade; the token is an upgradeable proxy, so the vault still measures what arrives); deposit 40 PAXG credited ${fmt(credited)} PAXG, measured not nominal`;
  });
  await check("paxg:mint-priced-by-the-oracle-rule", async () => {
    // A mint is valued at the borrowing price, the lower of C and G inside the gold band; the
    // vault's ratio view reads the oracle's record, which the mint left at the liquidation
    // price, min(max(C, G), G x (1 + m)). Both are computed here from the two feeds, so the
    // check holds whatever the gap between them is on the day.
    const debt = ethers.parseEther("40000");
    await (await vault.mint(debt)).wait();
    const fc = await feedPrice(paxgFeed), fg = await feedPrice(xauFeed);
    const rule = oraclePrices(fc, fg, await oracle.goldBandPpm(c.paxgToken), await oracle.liquidationClampPpm(c.paxgToken));
    assert(rule.borrow !== undefined, `C $${fmt(fc, 8)} is outside the gold band of G $${fmt(fg, 8)}`);
    const borrow: bigint = await oracle.quoteBorrowPrice(c.paxgToken);
    assert(borrow === rule.borrow, `quoteBorrowPrice $${fmt(borrow, 8)}; the lower of C and G is $${fmt(rule.borrow, 8)}`);
    const record: bigint = await oracle.getLastKnownPrice(c.paxgToken);
    assert(record === rule.settlement, `the oracle's record $${fmt(record, 8)}; min(max(C, G), G x (1 + m)) is $${fmt(rule.settlement, 8)}`);
    const ratio: bigint = await vault.getCollateralisationRatio(deployer.address);
    const current: bigint = await vault.getVaultCurrentDebt(deployer.address);
    const expected = credited * record / 100_000_000n * PPM / current;
    assert(ratio === expected, `ratio ${ratio} vs ${expected} at the oracle's record`);
    const atBorrow = credited * borrow / 100_000_000n * PPM / debt;
    const minRatio: bigint = (await vault.collateralTypes(colId(c.paxgToken))).minRatio;
    assert(atBorrow >= minRatio, `the mint left ${atBorrow} ppm at the borrowing price, under the ${minRatio} ppm minimum`);
    return `40,000 GSUSD minted at the borrowing price $${fmt(borrow, 8)} (the lower of C $${fmt(fc, 8)} and G $${fmt(fg, 8)}): ${(Number(atBorrow) / 10_000).toFixed(2)}% there; the ratio view reads ${(Number(ratio) / 10_000).toFixed(2)}% at the oracle's record $${fmt(record, 8)}`;
  });
  await check("pool:deposit", async () => {
    await (await gsusd.approve(a.stabilityPool, ethers.parseEther("5000"))).wait();
    await (await pool.deposit(ethers.parseEther("5000"))).wait();
    assert((await pool.getTotalDeposits()) === ethers.parseEther("5000"), "pool total mismatch");
    return "5,000 GSUSD in the stability pool";
  });
  await check("reserve:empty-until-seeded-then-seed-and-swap-real-paxg", async () => {
    // The reserve ships empty: until it is seeded there is no gold to swap for.
    assert((await reserve.collateralBalance(c.paxgToken)) === 0n && (await reserve.redeemableCollateral(c.paxgToken)) === 0n, "the reserve holds gold before the seed");
    assert((await reserve.remainingDailyCapacity(c.paxgToken)) === 0n, "an empty reserve reports capacity");
    await (await gsusd.approve(a.reserve, ethers.parseEther("1000"))).wait();
    const empty = await expectRevert(reserve.swapGsusdForGold(c.paxgToken, ethers.parseEther("1000"), 0), "Reserve insufficient");
    await (await paxg.approve(a.reserve, ethers.parseEther("5"))).wait();
    await (await reserve.seedCollateral(c.paxgToken, ethers.parseEther("5"))).wait();
    const seeded = await reserve.collateralBalance(c.paxgToken);
    assert(seeded <= ethers.parseEther("5") && seeded >= ethers.parseEther("5") * 999n / 1000n, `seeded ${fmt(seeded)}`);
    const gsusdIn = ethers.parseEther("1000");
    const [quote, spread] = await reserve.quoteGoldOut(c.paxgToken, gsusdIn);
    await (await gsusd.approve(a.reserve, gsusdIn)).wait();
    const before = await paxg.balanceOf(deployer.address);
    await (await reserve.swapGsusdForGold(c.paxgToken, gsusdIn, quote * 99n / 100n)).wait();
    const received = (await paxg.balanceOf(deployer.address)) - before;
    assert((await reserve.collateralBalance(c.paxgToken)) === seeded - quote, "reserve did not fall by goldOut");
    assert(received <= quote && received >= quote * 999n / 1000n, `received ${fmt(received)} vs goldOut ${fmt(quote)}`);
    return `before the seed the reserve counts 0 PAXG, reports no capacity and refuses a 1000 GSUSD swap "${empty}"; seeded ${fmt(seeded)} PAXG (measured); 1000 GSUSD -> ${fmt(quote)} PAXG at ${Number(spread) / 10_000}% spread, ${fmt(received)} arrived`;
  });
  await check("xaut:dormant-nothing-can-use-it", async () => {
    const w = await whale(xaut, XAUT_HOLDERS, 10_000_000n);
    const got = await transferMeasured(xaut, w, dave.address, 10_000_000n);
    assert(got === 10_000_000n, `XAUT transfer delivered ${got}`);
    assert(!(await vault.collateralTypes(colId(c.xautToken))).active, "XAUT is an active collateral type");
    await (await xaut.connect(dave).approve(a.vault, 5_000_000n)).wait();
    const deposit = await expectRevert(vault.connect(dave).deposit(c.xautToken, 5_000_000n), "Collateral type not active");
    await (await xaut.connect(dave).approve(a.reserve, 5_000_000n)).wait();
    const seed = await expectRevert(reserve.connect(dave).seedCollateral(c.xautToken, 5_000_000n), "Unsupported token");
    assert(!(await pool.isCollateralToken(c.xautToken)), "XAUT is a stability pool collateral token");
    const xautFeed = await ethers.getContractAt(["function description() view returns (string)"], (await oracle.feeds(c.xautToken)).feed);
    assert((await xautFeed.description()) === "Inactive", "XAUT's oracle feed is not an InactiveFeed");
    await expectRevert(oracle.quoteTokenPrice(c.xautToken), "No reliable price");
    assert((await xaut.balanceOf(dave.address)) === 10_000_000n, "XAUT left the holder");
    return `deposit refused (${deposit}), reserve seeding refused (${seed}), not a pool token, priced nothing on an InactiveFeed; the holder keeps every unit`;
  });
  await check("paxg:lifecycle-close-net-of-fees", async () => {
    const w = await whale(paxg, PAXG_HOLDERS, ethers.parseEther("5"));
    const got = await transferMeasured(paxg, w, carol.address, ethers.parseEther("5"));
    await (await paxg.connect(carol).approve(a.vault, got)).wait();
    await (await vault.connect(carol).deposit(c.paxgToken, got)).wait();
    const cred = (await vault.vaults(carol.address))[1];
    await (await vault.connect(carol).mint(ethers.parseEther("4000"))).wait();
    await (await gsusd.transfer(carol.address, ethers.parseEther("5"))).wait();
    const debt = await vault.getVaultCurrentDebt(carol.address);
    await (await gsusd.connect(carol).approve(a.vault, debt + E18)).wait();
    await (await vault.connect(carol).repay(debt + E18)).wait();
    const before = await paxg.balanceOf(carol.address);
    await (await vault.connect(carol).withdraw(cred)).wait();
    const back = (await paxg.balanceOf(carol.address)) - before;
    const v = await vault.vaults(carol.address);
    assert(v[1] === 0n && v[2] === 0n, "vault not empty");
    assert(back <= cred && back >= cred * 998n / 1000n, `returned ${fmt(back)} of ${fmt(cred)}`);
    return `deposited ${fmt(cred)} (measured), minted 4000, repaid, withdrew; ${fmt(back)} PAXG came back (silo and vault hops would each take the PAXG fee if Paxos raised it)`;
  });
  await check("oracle:state-changing-read-with-real-feeds", async () => {
    // Variant C (plan section 3): liquidation at min(max(C, G), G x (1 + m)), not at C alone.
    const p = await oracle.getTokenPrice.staticCall(c.paxgToken);
    const g = await feedPrice(xauFeed);
    const cap = g * (PPM + (await oracle.liquidationClampPpm(c.paxgToken))) / PPM;
    const hi = paxgPrice > g ? paxgPrice : g;
    const expected = hi > cap ? cap : hi;
    assert(p === expected, `getTokenPrice $${fmt(p, 8)}, min(max(C, G), G x 1.02) is $${fmt(expected, 8)}`);
    return `getTokenPrice $${fmt(p, 8)} = min(max(C $${fmt(paxgPrice, 8)}, G $${fmt(g, 8)}), G x 1.02)`;
  });
  const failed = results.filter((r) => r[1] === "FAIL");
  console.log(`\nMainnet-fork rehearsal: ${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) process.exitCode = 1;
}
main().catch((e) => { console.error(describeErrorStack(e)); process.exit(1); });
