/**
 * Scenario 8, after the handover (scripts/transfer-governance.ts, then verify-deployment.ts with
 * EXPECT_GOVERNANCE_TRANSFERRED=1): the XAUT activation batch of docs/XAUT_ACTIVATION.md section 4,
 * scheduled by the proposer Safe through the 48 hour timelock and executed by the executor Safe on
 * the fork, proving PAXG positions, parameters and prices are untouched.
 *
 * XAUT's market source is a stand-in (MockChainlinkFeed "XAUT / USD"): no XAUT push feed meets the
 * activation criteria today, so this rehearses the procedure, not the source. The reserve listing (section 4 step 5) waits 30 days
 * after activation and is not in the batch.
 *
 *   LOCAL_RPC_URL=http://127.0.0.1:8547 npx hardhat run --no-compile scripts/rehearsal/s8-xaut-activation.ts --network localhost
 */
import { Contract, ZeroHash, id } from "ethers";
import {
  ADDR, E18, E8, MAX, PPM, actors, advance, assert, colId, deploy, exec, expectRevert, fundXaut, g18, identity, impersonate,
  latestTs, ledger, market, mintChunks, pokePool, quote, restamp, scale, scenario, showQuote, trader, usd8, wallet,
} from "./lib";
import type { System } from "./lib";

async function paxgState(sys: System): Promise<string> {
  const count: bigint = await sys.registry.vaultOwnerCount();
  const owners: string[] = await sys.registry.vaultOwners(0, count);
  const rows: string[] = [];
  for (const o of owners) {
    const v = await sys.vault.vaults(o);
    if (v[0].toLowerCase() === ADDR.PAXG.toLowerCase()) rows.push(`${o}:${v[1]}:${v[2]}:${await sys.sm.normalisedDebt(o, colId(ADDR.PAXG))}`);
  }
  const ct = await sys.vault.collateralTypes(colId(ADDR.PAXG));
  const feed = await sys.oracle.feeds(ADDR.PAXG);
  return JSON.stringify({
    vaults: rows,
    type: ct.map((x: unknown) => String(x)),
    fee: String(await sys.sm.stabilityFeeRate(colId(ADDR.PAXG))),
    feed: [feed[0], String(feed[2])],
    bands: [String(await sys.oracle.goldBandPpm(ADDR.PAXG)), String(await sys.oracle.liquidationClampPpm(ADDR.PAXG))],
    poolToken: await sys.pool.isCollateralToken(ADDR.PAXG),
    reserve: (await sys.reserve.assets(ADDR.PAXG)).map((x: unknown) => String(x)),
  });
}

scenario("Scenario 8b: timelock handover and the XAUT activation batch (48 h)", async (sys, r) => {
  const GOV = id("GOVERNANCE_ROLE");
  const proposer = await impersonate(sys.c.proposers[0]);
  const executor = await impersonate(sys.c.executors[0]);
  const deployer = await impersonate(sys.snap.deployer);
  const keeper = await actors.keeper();
  const xId = colId(ADDR.XAUT);
  let before = "";
  let pricesBefore = "";
  let tokBefore = { ok: false, price: 0n, why: "" };
  let borBefore = { ok: false, price: 0n, why: "" };

  await r.check("handover:deployer-holds-nothing-timelock-holds-governance", async () => {
    for (const c of [sys.vault, sys.oracle, sys.sm, sys.pool, sys.reserve, sys.buffer]) {
      assert(!(await c.hasRole(GOV, sys.snap.deployer)), `deployer still governs ${await c.getAddress()}`);
      assert(await c.hasRole(GOV, sys.a.timelock), `timelock does not govern ${await c.getAddress()}`);
    }
    const refused = await expectRevert((sys.oracle.connect(deployer) as Contract).setGoldBand(ADDR.XAUT, 20_000));
    return `governance on vault, oracle, stability module, pool, reserve and buffer is the timelock's (min delay ${Number(await sys.timelock.getMinDelay()) / 3600} h); deployer setGoldBand: "${refused.slice(0, 70)}"`;
  });

  const xautC = await deploy("MockChainlinkFeed", await wallet("xaut-feeds"), 8, "XAUT / USD");
  const stampXaut = async (): Promise<bigint> => {
    const g = (await market({})).G;
    const answer = scale(g, 999_000n);
    const now = BigInt(await latestTs());
    for (const f of [xautC]) {
      const [rid] = await f.latestRoundData();
      await exec(f.setLatestRoundData(rid + 1n, answer, now, now, rid + 1n));
    }
    return answer;
  };
  await stampXaut();

  const oracle = sys.oracle.interface, vaultI = sys.vault.interface, smI = sys.sm.interface, poolI = sys.pool.interface;
  const calls: Array<[string, string, string]> = [
    ["oracle.setXautFeed", sys.a.oracle, oracle.encodeFunctionData("setXautFeed", [await xautC.getAddress()])],
    ["oracle.setGoldBand", sys.a.oracle, oracle.encodeFunctionData("setGoldBand", [ADDR.XAUT, 20_000])],
    ["oracle.setLiquidationClamp", sys.a.oracle, oracle.encodeFunctionData("setLiquidationClamp", [ADDR.XAUT, 20_000])],
    ["stabilityModule.initCollateral", sys.a.stabilityModule, smI.encodeFunctionData("initCollateral", [xId, 200])],
    ["vault.addCollateralType", sys.a.vault, vaultI.encodeFunctionData("addCollateralType", [ADDR.XAUT, 1_300_000, 1_100_000, 50_000, 500_000n * E18])],
    ["stabilityPool.addCollateralToken", sys.a.stabilityPool, poolI.encodeFunctionData("addCollateralToken", [ADDR.XAUT])],
  ];
  const targets = calls.map((c) => c[1]);
  const values = calls.map(() => 0);
  const payloads = calls.map((c) => c[2]);
  const salt = id("xaut-activation-rehearsal");
  const delay: bigint = await sys.timelock.getMinDelay();
  const opId: string = await sys.timelock.hashOperationBatch(targets, values, payloads, ZeroHash, salt);

  await r.check("batch:only-the-proposer-schedules", async () => {
    before = await paxgState(sys);
    tokBefore = await quote(sys, "token");
    borBefore = await quote(sys, "borrow");
    pricesBefore = `${showQuote(tokBefore)}/${showQuote(borBefore)}`;
    const stranger = await expectRevert((sys.timelock.connect(keeper) as Contract).scheduleBatch(targets, values, payloads, ZeroHash, salt, delay));
    await exec((sys.timelock.connect(proposer) as Contract).scheduleBatch(targets, values, payloads, ZeroHash, salt, delay));
    const ready: bigint = await sys.timelock.getTimestamp(opId);
    return `${calls.length} calls (${calls.map((c) => c[0]).join(", ")}); keeper scheduleBatch: "${stranger.slice(0, 60)}"; proposer Safe scheduled ${opId.slice(0, 10)}…, ready at ${ready} (+${delay / 3600n} h)`;
  });

  await r.check("batch:refused-before-the-delay", async () => {
    await advance(Number(delay) - 3600);
    const early = await expectRevert((sys.timelock.connect(executor) as Contract).executeBatch(targets, values, payloads, ZeroHash, salt));
    return `47 h in: executeBatch "${early.slice(0, 80)}"`;
  });

  await r.check("batch:executed-after-48h-by-the-executor", async () => {
    await advance(3_601);
    await restamp();
    await stampXaut();
    await pokePool(sys, await trader(sys));
    const stranger = await expectRevert((sys.timelock.connect(keeper) as Contract).executeBatch(targets, values, payloads, ZeroHash, salt));
    const receipt = await exec((sys.timelock.connect(executor) as Contract).executeBatch(targets, values, payloads, ZeroHash, salt));
    assert(await sys.timelock.isOperationDone(opId), "operation not done");
    return `keeper executeBatch: "${stranger.slice(0, 60)}"; executor Safe executed in block ${receipt.blockNumber} (${receipt.gasUsed} gas)`;
  });

  await r.check("paxg:untouched", async () => {
    const after = await paxgState(sys);
    assert(after === before, `PAXG state changed:\n${before}\n${after}`);
    const tokAfter = await quote(sys, "token");
    const borAfter = await quote(sys, "borrow");
    const pricesAfter = `${showQuote(tokAfter)}/${showQuote(borAfter)}`;
    // the liquidation price is C, unchanged; the borrowing price may move by one pool tick, since
    // after 48 h the median reads the pool's current tick rather than the window the fill left
    assert(tokAfter.ok && tokAfter.price === tokBefore.price, `PAXG liquidation price ${pricesBefore} -> ${pricesAfter}`);
    assert(borAfter.ok && (borAfter.price > borBefore.price ? borAfter.price - borBefore.price : borBefore.price - borAfter.price) * 5_000n <= borBefore.price, `PAXG borrowing price ${pricesBefore} -> ${pricesAfter}`);
    const bank = await actors.bank();
    await exec((sys.vault.connect(bank) as Contract).mint(1_000n * E18));
    identity(await ledger(sys));
    const n = JSON.parse(after).vaults.length;
    return `${n} PAXG vaults: collateral, principal and normalised debt identical; PAXG collateral type, stability fee, oracle feed, gold band, liquidation cap, pool token and reserve asset identical; PAXG prices ${pricesBefore} -> ${pricesAfter} (liquidation identical; borrowing within one pool tick, P's median window); a PAXG mint still works; identity holds`;
  });

  await r.check("xaut:active-and-usable", async () => {
    const holder = await wallet("s8b-xaut");
    const got = await fundXaut(sys, holder.address, 100_000_000n);
    await exec((sys.xaut.connect(holder) as Contract).approve(sys.a.vault, MAX));
    await exec((sys.vault.connect(holder) as Contract).deposit(ADDR.XAUT, got));
    const tok = await quote(sys, "token", ADDR.XAUT);
    const bor = await quote(sys, "borrow", ADDR.XAUT);
    assert(tok.ok && bor.ok, `XAUT prices ${showQuote(tok)} / ${showQuote(bor)}`);
    const value = (got * 10n ** 12n * bor.price) / E8;
    const mint = (value * PPM) / 1_400_000n;
    await mintChunks(sys, holder, mint);
    const ct = await sys.vault.collateralTypes(xId);
    const seed = await expectRevert((sys.reserve.connect(holder) as Contract).seedCollateral(ADDR.XAUT, 1n), "Unsupported token");
    identity(await ledger(sys));
    return `100 XAUt deposited (6 decimals); liquidation ${usd8(tok.price)}, borrowing ${usd8(bor.price)}; minted ${g18(mint, 2)} GSUSD at 140%; XAUT debt ${g18(ct.totalDebt, 2)} of a ${g18(ct.debtCeiling, 0)} ceiling; pool token ${await sys.pool.isCollateralToken(ADDR.XAUT)}; reserve still refuses XAUT ("${seed}", listing waits 30 days); identity holds across both collateral types`;
  });
});
