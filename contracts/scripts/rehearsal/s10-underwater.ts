/**
 * Scenario 10 (variant C; the project's decision: an underwater vault is liquidated in full only):
 * a multi-million GSUSD vault on real PAXG pushed under 100% at the liquidation price by a
 * gold-wide fall, with the stability pool holding less than its debt.
 *
 *   (a) liquidateViaPool reverts "Pool insufficient" and changes nothing
 *   (d) a partial attempt reverts "Thin vault: liquidate in full" and changes nothing
 *   (b) a liquidator holding enough GSUSD liquidates it in full in one transaction
 *   (c) a liquidator holding only PAXG deposits it, mints GSUSD in its own vault, then liquidates
 *       in full (the capital it needs is reported against the debt)
 *   (e) after the full liquidation: collateral and debt zero, the shortfall booked once and
 *       absorbed by the SurplusBuffer as far as it can, supply = principal + unabsorbed bad debt,
 *       collateral out of the silos = liquidator + reserve + buffer, a second call books nothing
 *
 * It also sizes the largest underwater vault the fork's executable liquidity can clear: the
 * stability pool's deposits, and a liquidator starting from ETH who must buy PAXG from the
 * PAXG/WETH pool to mint the GSUSD (measured with a static call of a real swap).
 *
 *   LOCAL_RPC_URL=http://127.0.0.1:8547 npx hardhat run --no-compile scripts/rehearsal/s10-underwater.ts --network localhost
 */
import { Contract } from "ethers";
import type { TransactionReceipt, Wallet } from "ethers";
import {
  ADDR, E18, E8, MAX, PPM, actors, assert, colId, delta, exec, expectRevert, fundPaxg, g18, identity, ledger, market,
  mintChunks, poolSpot, quote, rewind, scale, scenario, snapshot, trader, usd8, wallet,
} from "./lib";
import type { System } from "./lib";

const FALL = 720_000n; // gold-wide -28%

async function state(sys: System, owner: string): Promise<string> {
  const v = await sys.vault.vaults(owner);
  const l = await ledger(sys);
  return JSON.stringify({ v: [v[0], String(v[1]), String(v[2])], l: Object.fromEntries(Object.entries(l).map(([k, x]) => [k, String(x)])), owner: String(await sys.paxg.balanceOf(owner)) });
}

/** What GoldVault._sizeSeizure makes an underwater liquidator pay: max(value x (1 - discount), 2 x value - debt). */
async function underwaterRepay(sys: System, owner: string, price: bigint): Promise<{ repay: bigint; debt: bigint; value: bigint }> {
  const coll: bigint = (await sys.vault.vaults(owner))[1];
  const debt: bigint = await sys.vault.getVaultCurrentDebt(owner);
  const value = (coll * price) / E8;
  const discount: bigint = await sys.vault.underwaterDiscountPpm();
  let repay = (value * (PPM - discount)) / PPM;
  if (2n * value > debt && 2n * value - debt > repay) repay = 2n * value - debt;
  return { repay, debt, value };
}

function badDebtEvents(sys: System, r: TransactionReceipt): bigint[] {
  return r.logs.map((log) => { try { return sys.vault.interface.parseLog(log); } catch { return null; } }).filter((e) => e?.name === "BadDebt").map((e) => e!.args[1] as bigint);
}

/** A wallet that turns PAXG into GSUSD in its own vault at 135% of the borrowing price. */
async function financeWithPaxg(sys: System, w: Wallet, gsusd: bigint): Promise<bigint> {
  const bp: bigint = await sys.oracle.quoteBorrowPrice(ADDR.PAXG);
  const paxgNeeded = (gsusd * 1_350_000n * E8) / (bp * PPM) + E18;
  await exec((sys.paxg.connect(w) as Contract).approve(sys.a.vault, MAX));
  let left = await fundPaxg(sys, w.address, paxgNeeded);
  const total = left;
  while (left > 0n) {
    const chunk = left > 500n * E18 ? 500n * E18 : left;
    await exec((sys.vault.connect(w) as Contract).deposit(ADDR.PAXG, chunk));
    left -= chunk;
  }
  await mintChunks(sys, w, gsusd);
  return total;
}

scenario("Scenario 10: large underwater vault, liquidated in full only (variant C)", async (sys, r) => {
  const keeper = await actors.keeper();
  const whale = await wallet("s10-whale");
  await exec((sys.paxg.connect(whale) as Contract).approve(sys.a.vault, MAX));
  for (let i = 0; i < 3; i++) await exec((sys.vault.connect(whale) as Contract).deposit(ADDR.PAXG, await fundPaxg(sys, whale.address, 500n * E18)));
  const bp0: bigint = await sys.oracle.quoteBorrowPrice(ADDR.PAXG);
  const coll0: bigint = (await sys.vault.vaults(whale.address))[1];
  await mintChunks(sys, whale, ((coll0 * bp0) / E8) * PPM / 1_310_000n);
  const base = await market({});
  await market({ C: scale(base.C, FALL), G: scale(base.G, FALL) });
  const price = (await quote(sys, "token")).price;
  const { repay, debt, value } = await underwaterRepay(sys, whale.address, price);
  const poolDeposits: bigint = await sys.pool.getTotalDeposits();
  r.info("setup", `whale vault ${g18(coll0, 0)} PAXG, ${g18(debt, 0)} GSUSD debt; gold-wide -28%: liquidation price ${usd8(price)}, collateral worth ${g18(value, 0)} (${(Number((value * PPM) / debt) / 10_000).toFixed(2)}%); a full liquidation repays ${g18(repay, 0)}; stability pool ${g18(poolDeposits, 0)} GSUSD`);
  assert(value < debt && poolDeposits < repay, "setup is not an underwater vault larger than the pool");
  let start = await snapshot();

  await r.check("a:pool-path-reverts-Pool-insufficient-nothing-changes", async () => {
    const before = await state(sys, whale.address);
    const why = await expectRevert((sys.vault.connect(keeper) as Contract).liquidateViaPool(whale.address, 0), "Pool insufficient");
    assert((await state(sys, whale.address)) === before, "state changed");
    return `liquidateViaPool "${why}" (pool ${g18(poolDeposits, 0)} < repayment ${g18(repay, 0)}); vault, pool, buffer, reserve, supply, totalBadDebt, custody and balances identical`;
  });

  await r.check("d:partial-attempts-revert-thin-vault-nothing-changes", async () => {
    const holder = await wallet("s10-partial");
    await financeWithPaxg(sys, holder, 100_000n * E18);
    await exec((sys.gsusd.connect(holder) as Contract).approve(sys.a.vault, MAX));
    const before = await state(sys, whale.address);
    const direct = await expectRevert((sys.vault.connect(holder) as Contract).liquidate(whale.address, debt / 10n), "Thin vault: liquidate in full");
    const pool = await expectRevert((sys.vault.connect(keeper) as Contract).liquidateViaPool(whale.address, 100_000n * E18), "Thin vault: liquidate in full");
    assert((await state(sys, whale.address)) === before, "state changed");
    return `direct partial (10% of the debt) "${direct}"; pool partial of 100,000 "${pool}"; state identical`;
  });

  const full = async (label: string, liq: Wallet, how: string): Promise<string> => {
    const before = await ledger(sys);
    const lPaxg0: bigint = await sys.paxg.balanceOf(liq.address);
    const lGsusd0: bigint = await sys.gsusd.balanceOf(liq.address);
    const bad0: bigint = await sys.vault.totalBadDebt();
    const principal0: bigint = (await sys.vault.vaults(whale.address))[2];
    const owed = (await underwaterRepay(sys, whale.address, price)).repay;
    const receipt = await exec((sys.vault.connect(liq) as Contract).liquidate(whale.address, 0));
    const paid = lGsusd0 - (await sys.gsusd.balanceOf(liq.address));
    assert(paid === owed, `the liquidator paid ${g18(paid, 6)} GSUSD; the underwater sizing asks ${g18(owed, 6)}`);
    const after = await ledger(sys);
    const d = delta(before, after);
    const v = await sys.vault.vaults(whale.address);
    const events = badDebtEvents(sys, receipt);
    const got = (await sys.paxg.balanceOf(liq.address)) - lPaxg0;
    assert(v[1] === 0n && v[2] === 0n, "vault not cleared");
    assert(events.length === 1, `${events.length} BadDebt events`);
    const absorbed = events[0] - (after.badDebt - bad0);
    assert(absorbed >= 0n && absorbed <= events[0], `absorbed ${absorbed} of ${events[0]}`);
    assert(-d.custody === got + d.reservePaxg + d.bufferPaxg, `custody -${-d.custody} vs liquidator ${got} + reserve ${d.reservePaxg} + buffer ${d.bufferPaxg}`);
    identity(after);
    // bad debt over BAD_DEBT_PAUSE_THRESHOLD pauses the vault; the path still open in a pause is emergencyLiquidate
    const autoPaused: boolean = await sys.vault.paused();
    const threshold: bigint = await sys.vault.badDebtPauseThreshold();
    const again = autoPaused
      ? `${await expectRevert((sys.vault.connect(liq) as Contract).liquidate(whale.address, 0), "EnforcedPause")}; emergencyLiquidate ${await expectRevert((sys.vault.connect(liq) as Contract).emergencyLiquidate(whale.address, 0), "No debt")}`
      : await expectRevert((sys.vault.connect(liq) as Contract).liquidate(whale.address, 0), "No debt");
    assert((await sys.vault.totalBadDebt()) === after.badDebt, "a second call booked something");
    return `${how}; paid exactly the sized ${g18(paid, 2)} GSUSD; one transaction (gas ${receipt.gasUsed}): principal ${g18(principal0, 0)} cleared, supply -${g18(-d.supply, 0)} (principal repaid plus the absorbed bad debt burned), buffer GSUSD ${d.bufferGsusd >= 0n ? "+" : ""}${g18(d.bufferGsusd, 2)} (fee in, absorption out), seized ${g18(-d.custody, 4)} PAXG (liquidator ${g18(got, 4)}, reserve ${g18(d.reservePaxg, 4)}, buffer ${g18(d.bufferPaxg, 4)}); BadDebt booked once: ${g18(events[0], 2)} GSUSD, buffer absorbed ${g18(absorbed, 2)}, totalBadDebt now ${g18(after.badDebt, 2)} (unabsorbed); supply = principal + bad debt holds; ${autoPaused ? `bad debt above the ${g18(threshold, 0)} GSUSD threshold auto-paused the vault; ` : ""}a second call: "${again}", nothing booked; ${label}`;
  };

  start = await rewind(start);
  await r.check("b-e:liquidator-holding-GSUSD-liquidates-in-full", async () => {
    const funder = await wallet("s10-funder");
    await financeWithPaxg(sys, funder, (repay * 1_001n) / 1_000n);
    // A mint delivers its amount less the origination fee, so pass on what actually arrived.
    const held: bigint = await sys.gsusd.balanceOf(funder.address);
    assert(held >= repay, `the funder holds ${g18(held, 0)} GSUSD, short of the ${g18(repay, 0)} repayment`);
    const liq = await wallet("s10-liquidator-b");
    await exec((sys.gsusd.connect(funder) as Contract).transfer(liq.address, held));
    await exec((sys.gsusd.connect(liq) as Contract).approve(sys.a.vault, MAX));
    return full("(b)", liq, `liquidator held ${g18(held, 0)} GSUSD`);
  });

  start = await rewind(start);
  await r.check("c-e:liquidator-holding-only-PAXG-finances-then-liquidates", async () => {
    const liq = await wallet("s10-liquidator-c");
    const paxgIn = await financeWithPaxg(sys, liq, (repay * 1_001n) / 1_000n);
    await exec((sys.gsusd.connect(liq) as Contract).approve(sys.a.vault, MAX));
    const usd = (paxgIn * price) / E8;
    return full("(c)", liq, `liquidator deposited ${g18(paxgIn, 2)} PAXG (${g18(usd, 0)} USD, ${(Number((usd * 1000n) / debt) / 1000).toFixed(2)}x the vault's debt, ${(Number((usd * 1000n) / repay) / 1000).toFixed(2)}x the repayment) and minted ${g18((repay * 1_001n) / 1_000n, 0)} GSUSD at 135%, received net of the origination fee, before liquidating`);
  });

  start = await rewind(start);
  await r.check("capacity:largest-underwater-vault-the-fork-can-clear", async () => {
    const t = await trader(sys, "s10-capacity");
    const spot = await poolSpot(sys);
    const out: bigint = await (sys.router.connect(t) as Contract).exactInputSingle.staticCall({
      tokenIn: ADDR.WETH, tokenOut: ADDR.PAXG, fee: 3000, recipient: t.address, amountIn: 50_000n * E18, amountOutMinimum: 0, sqrtPriceLimitX96: spot.sqrtP * 4n,
    });
    const bp: bigint = await sys.oracle.quoteBorrowPrice(ADDR.PAXG);
    const mintable = ((out * bp) / E8) * PPM / 1_300_000n;
    // repayment per unit of debt at this vault's collateral ratio rho: max(0.98 rho, 2 rho - 1)
    const rho = (value * PPM) / debt;
    const perDebt = ((rho * 980_000n) / PPM > 2n * rho - PPM ? (rho * 980_000n) / PPM : 2n * rho - PPM);
    const viaPool = ((poolDeposits - 1n) * PPM) / perDebt;
    const viaDex = (mintable * PPM) / perDebt;
    return `at ${(Number(rho) / 10_000).toFixed(2)}% collateralisation a full liquidation repays ${(Number(perDebt) / 10_000).toFixed(2)}% of the debt. Stability pool: ${g18(poolDeposits, 0)} GSUSD clears an underwater vault of at most ${g18(viaPool, 0)} GSUSD debt. A liquidator starting from ETH can buy at most ${g18(out, 2)} PAXG from the PAXG/WETH pool (all of it, price x16), mint ${g18(mintable, 0)} GSUSD at 130% and clear at most ${g18(viaDex, 0)} GSUSD of debt. Larger vaults need a liquidator already holding PAXG (or GSUSD) worth about 1.35x the repayment; there is no GSUSD market on the fork to buy it`;
  });
});
