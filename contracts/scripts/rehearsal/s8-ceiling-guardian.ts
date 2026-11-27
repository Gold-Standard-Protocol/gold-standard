/**
 * Scenario 8, before the handover: the backstop ceiling, the per-block mint cap, the guardian's
 * per-token freeze and the emergency pause.
 *
 *   ceiling   the open profile: no PAXG ceiling and no per-block cap, so 8,000,000 GSUSD mints in
 *             one transaction and more in the next block, bounded only by the 130% ratio
 *   freeze    guardian Safe freezes PAXG: every price read, mint, liquidation (normal, pool and
 *             emergency) and reserve swap refused "Token frozen"; repay and deposit open; a
 *             non-guardian cannot freeze; a vault pause does not lift the freeze,
 *             so the emergency paths refuse it too until the guardian unfreezes it,
 *             still paused, and it is seized at the rules' price; the freeze lapses after 14 days;
 *             guardianUnfreezeToken(token, freezeEpoch(token)) lifts it at the rules' price
 *   pause     guardian pauses the vault: mint and the direct liquidation refused, the pool path
 *             and emergencyLiquidate open at the rules' price, repay and deposit open, an indebted
 *             withdrawal refused, a debt-free withdrawal open; the guardian cannot unpause,
 *             governance can (after the handover: proposer Safe, 48 h timelock, executor Safe)
 *
 *   LOCAL_RPC_URL=http://127.0.0.1:8547 npx hardhat run --no-compile scripts/rehearsal/s8-ceiling-guardian.ts --network localhost
 */
import { Contract } from "ethers";
import {
  ADDR, E18, MAX, actors, advance, assert, colId, exec, expectRevert, fundPaxg, g18, govern, identity, impersonate, ledger,
  liquidate, market, mintChunks, openVault, pokePool, quote, restamp, rewind, samePrice, scale, scenario, snapshot,
  trader, usd8, variantC, wallet,
} from "./lib";
import { collateralForDebt } from "../lib/rehearsalSizing";

scenario("Scenario 8a: backstop ceiling, per-block cap, guardian freeze, emergency pause", async (sys, r) => {
  const keeper = await actors.keeper();
  const bank = await actors.bank();
  const guardian = await impersonate(sys.c.guardian);
  const victim = (await openVault(sys, "s8-victim", 5n * E18, 1_310_000n)).w;
  const victim2 = (await openVault(sys, "s8-victim-2", 5n * E18, 1_310_000n)).w;
  const borrower = (await openVault(sys, "s8-borrower", 10n * E18, 1_500_000n)).w;
  await exec((sys.paxg.connect(borrower) as Contract).approve(sys.a.vault, MAX));
  const base = await market({});
  let start = await snapshot();

  await r.check("ceiling:profile-open-no-ceiling-or-backstop-5000000", async () => {
    const ct = await sys.vault.collateralTypes(colId(ADDR.PAXG));
    const ceiling: bigint = ct.debtCeiling;
    if (sys.c.launchCaps === "open") {
      // the open launch: no ceiling and no per-block cap; one wallet mints far past the old $5M
      assert(ceiling === MAX && (await sys.vault.perBlockMintCap()) === 0n, `open profile with ceiling ${ceiling}, cap ${await sys.vault.perBlockMintCap()}`);
      const w = await wallet("s8-whale-open");
      await exec((sys.paxg.connect(w) as Contract).approve(sys.a.vault, MAX));
      // Sized from the day's borrowing price: enough PAXG to carry the 8,500,000 GSUSD below at 135%.
      const borrowPrice: bigint = await sys.oracle.quoteBorrowPrice(ADDR.PAXG);
      const needed = collateralForDebt(8_500_000n * E18, borrowPrice, 1_350_000n);
      let deposited = 0n;
      while (deposited < needed) {
        const left = needed - deposited;
        const got = await fundPaxg(sys, w.address, left > 500n * E18 ? 500n * E18 : left);
        await exec((sys.vault.connect(w) as Contract).deposit(ADDR.PAXG, got));
        deposited += got;
      }
      const before: bigint = (await sys.vault.collateralTypes(colId(ADDR.PAXG))).totalDebt;
      const receipt = await exec((sys.vault.connect(w) as Contract).mint(8_000_000n * E18));
      const total: bigint = (await sys.vault.collateralTypes(colId(ADDR.PAXG))).totalDebt;
      assert(total - before === 8_000_000n * E18 && total > 5_000_000n * E18, `PAXG debt ${g18(total)}`);
      const more = await exec((sys.vault.connect(w) as Contract).mint(500_000n * E18));
      const ratio: bigint = await sys.vault.getCollateralisationRatio(w.address);
      identity(await ledger(sys));
      return `open profile: debtCeiling unlimited, perBlockMintCap 0; ${g18(deposited, 2)} PAXG deposited (135% of 8,500,000 GSUSD at the borrowing price ${usd8(borrowPrice)}), 8,000,000 GSUSD minted in ONE transaction (block ${receipt.blockNumber}, ${receipt.gasUsed} gas) and 500,000 more in block ${more.blockNumber}; PAXG debt ${g18(total + 500_000n * E18, 0)} GSUSD, ${g18((total + 500_000n * E18) / 5_000_000n, 2)}x the old $5M backstop; whale at ${(Number(ratio) / 10_000).toFixed(1)}%; only the 130% ratio bounded it; identity holds`;
    }
    assert(ceiling === 5_000_000n * E18, `ceiling ${g18(ceiling)}`);
    const cap: bigint = await sys.vault.perBlockMintCap();
    const whales = [];
    for (let i = 0; i < 4; i++) {
      const w = await wallet(`s8-whale-${i}`);
      const got = await fundPaxg(sys, w.address, 400n * E18);
      await exec((sys.paxg.connect(w) as Contract).approve(sys.a.vault, MAX));
      await exec((sys.vault.connect(w) as Contract).deposit(ADDR.PAXG, got));
      await exec((sys.gsusd.connect(w) as Contract).approve(sys.a.vault, MAX));
      whales.push(w);
    }
    const capRefusal = await expectRevert((sys.vault.connect(whales[0]) as Contract).mint(cap + 10n ** 12n), "Per-block mint cap reached");
    let blocks = 0;
    for (const w of whales) {
      const headroom: bigint = ceiling - (await sys.vault.collateralTypes(colId(ADDR.PAXG))).totalDebt;
      if (headroom === 0n) break;
      const bp: bigint = await sys.oracle.quoteBorrowPrice(ADDR.PAXG);
      const room = ((((await sys.vault.vaults(w.address))[1] as bigint) * bp) / 10n ** 8n) * 10n / 14n; // to about 140%
      const amount = headroom < room ? headroom : room;
      await mintChunks(sys, w, amount);
      blocks += Number((amount + cap - 1n) / cap);
    }
    const total: bigint = (await sys.vault.collateralTypes(colId(ADDR.PAXG))).totalDebt;
    assert(total === ceiling, `PAXG debt ${g18(total)} after filling`);
    const one = await expectRevert((sys.vault.connect(whales[3]) as Contract).mint(1n), "Debt ceiling reached");
    // a repayment of 1,000 retires a little less than 1,000 of principal (part of it pays fee),
    // so the room it opens is the principal it retired, not the GSUSD paid
    await exec((sys.vault.connect(whales[3]) as Contract).repay(1_000n * E18));
    const reopened: bigint = ceiling - (await sys.vault.collateralTypes(colId(ADDR.PAXG))).totalDebt;
    const over = await expectRevert((sys.vault.connect(whales[3]) as Contract).mint(1_000n * E18), "Debt ceiling reached");
    await exec((sys.vault.connect(whales[3]) as Contract).mint(reopened));
    const again = await expectRevert((sys.vault.connect(whales[3]) as Contract).mint(1n), "Debt ceiling reached");
    assert((await sys.vault.collateralTypes(colId(ADDR.PAXG))).totalDebt === ceiling, "not back at the ceiling");
    identity(await ledger(sys));
    return `per-block cap: ${g18(cap + 10n ** 12n, 6)} in one mint refused ("${capRefusal}"); PAXG debt filled to ${g18(total)} GSUSD over ${blocks} capped mints; 1 wei more: "${one}"; a 1,000 GSUSD repayment reopened ${g18(reopened, 6)} of principal room, so minting 1,000 back is refused ("${over}") and minting ${g18(reopened, 6)} lands exactly on the ceiling; 1 wei more again: "${again}"; identity holds`;
  });

  start = await rewind(start);
  await r.check("freeze:non-guardian-refused", async () => {
    const why = await expectRevert((sys.oracle.connect(keeper) as Contract).freezeToken(ADDR.PAXG), "Not guardian or governance");
    return `keeper freezeToken: "${why}"`;
  });

  await r.check("freeze:guardian-freezes-PAXG-everything-priced-stops", async () => {
    await exec((sys.oracle.connect(guardian) as Contract).freezeToken(ADDR.PAXG));
    const until: bigint = await sys.oracle.frozenUntil(ADDR.PAXG);
    await market({ C: scale(base.C, 820_000n), G: scale(base.G, 820_000n) }); // victim now below 110% at C
    const [tok, bor] = await Promise.all([quote(sys, "token"), quote(sys, "borrow")]);
    assert(!tok.ok && tok.why === "Token frozen" && !bor.ok && bor.why === "Token frozen", "a price read survived the freeze");
    const mint = await expectRevert((sys.vault.connect(borrower) as Contract).mint(1_000n * E18), "Token frozen");
    const liq = await expectRevert((sys.vault.connect(bank) as Contract).liquidate(victim.address, 0), "Token frozen");
    const pool = await expectRevert((sys.vault.connect(keeper) as Contract).liquidateViaPool(victim.address, 0), "Token frozen");
    const emer = await expectRevert((sys.vault.connect(bank) as Contract).emergencyLiquidate(victim.address, 0), "Token frozen");
    await exec((sys.gsusd.connect(bank) as Contract).approve(sys.a.reserve, MAX));
    const swap = await expectRevert((sys.reserve.connect(bank) as Contract).swapGsusdForGold(ADDR.PAXG, 1_000n * E18, 0), "Token frozen");
    await exec((sys.vault.connect(borrower) as Contract).repay(100n * E18));
    const got = await fundPaxg(sys, borrower.address, E18 / 10n);
    await exec((sys.vault.connect(borrower) as Contract).deposit(ADDR.PAXG, got));
    return `frozen until ${until} (14 days); quotes, mint "${mint}", liquidate "${liq}", liquidateViaPool "${pool}", emergencyLiquidate (no pause) "${emer}", reserve swap "${swap}"; repay 100 and deposit 0.1 PAXG went through`;
  });

  let frozen = await snapshot();
  await r.check("freeze:a-vault-pause-does-not-lift-the-freeze", async () => {
    await exec((sys.vault.connect(guardian) as Contract).emergencyPause());
    const before = await sys.vault.vaults(victim.address);
    // A frozen token stays refused on the paths a pause opens.
    const emergency = await expectRevert((sys.vault.connect(bank) as Contract).emergencyLiquidate(victim.address, 0), "Token frozen");
    const viaPool = await expectRevert((sys.vault.connect(bank) as Contract).liquidateViaPool(victim.address, 0), "Token frozen");
    const after = await sys.vault.vaults(victim.address);
    assert(after[1] === before[1] && after[2] === before[2], "the victim's vault changed");
    // The documented recovery: lift the freeze while the vault is still paused, then seize.
    const epoch: bigint = await sys.oracle.freezeEpoch(ADDR.PAXG);
    await exec((sys.oracle.connect(guardian) as Contract).guardianUnfreezeToken(ADDR.PAXG, epoch));
    assert(await sys.vault.paused(), "the vault pause did not survive the unfreeze");
    const c = variantC(scale(base.C, 820_000n), scale(base.G, 820_000n)).liq; // the rules' price
    const l = await liquidate(sys, bank, victim.address, "emergency");
    assert(samePrice(l.impliedPrice, c), `emergency liquidation at ${usd8(l.impliedPrice)}, the rules' price ${usd8(c)}`);
    return `vault paused by the guardian: emergencyLiquidate "${emergency}", liquidateViaPool "${viaPool}", the victim's vault untouched; guardianUnfreezeToken(PAXG, ${epoch}) while still paused, then emergencyLiquidate seized at ${usd8(l.impliedPrice)} = the rules' price`;
  });

  frozen = await rewind(frozen);
  await r.check("freeze:lapses-after-14-days", async () => {
    await advance(14 * 86_400 + 1);
    await restamp();
    await pokePool(sys, await trader(sys));
    const frozenNow: boolean = await sys.oracle.tokenFrozen(ADDR.PAXG);
    const tok = await quote(sys, "token");
    assert(!frozenNow && tok.ok, `still frozen (${tok.why})`);
    return `14 days + 1 s later: tokenFrozen false without any transaction; liquidation ${usd8(tok.price)}`;
  });

  frozen = await rewind(frozen);
  await r.check("freeze:guardianUnfreezeToken-at-the-rules-price", async () => {
    // An unfreeze names the freeze it lifts (freezeEpoch); read it now, just before the call.
    const epoch: bigint = await sys.oracle.freezeEpoch(ADDR.PAXG);
    const receipt = await exec((sys.oracle.connect(guardian) as Contract).guardianUnfreezeToken(ADDR.PAXG, epoch));
    const ev = receipt.logs.map((l) => { try { return sys.oracle.interface.parseLog(l); } catch { return null; } }).find((e) => e?.name === "TokenUnfrozen");
    const c = variantC(scale(base.C, 820_000n), scale(base.G, 820_000n)).liq; // the rules' price
    assert(ev && ev.args[2] === c, `TokenUnfrozen price ${ev?.args[2]}`);
    const tok = await quote(sys, "token");
    assert(tok.ok && tok.price === c, "price reads still refused");
    const l = await liquidate(sys, keeper, victim.address, "pool");
    return `TokenUnfrozen at ${usd8(ev.args[2])} (the rules' price); reads open again; the victim liquidated via the pool at ${usd8(l.impliedPrice)}`;
  });

  start = await rewind(start);
  await r.check("pause:guardian-pauses-the-vault", async () => {
    await market({ C: scale(base.C, 820_000n), G: scale(base.G, 820_000n) });
    await exec((sys.vault.connect(guardian) as Contract).emergencyPause());
    const mint = await expectRevert((sys.vault.connect(borrower) as Contract).mint(1_000n * E18));
    const liq = await expectRevert((sys.vault.connect(bank) as Contract).liquidate(victim.address, 0));
    // the pool path stays open through a vault pause, priced by the emergency read (the rules' price here)
    const viaPool = await liquidate(sys, keeper, victim2.address, "pool");
    assert(samePrice(viaPool.impliedPrice, variantC(scale(base.C, 820_000n), scale(base.G, 820_000n)).liq), `pool liquidation while paused at ${usd8(viaPool.impliedPrice)}`);
    const pool = `absorbed ${g18(viaPool.debtRepaid, 2)} GSUSD at ${usd8(viaPool.impliedPrice)}`;
    const withdraw = await expectRevert((sys.vault.connect(borrower) as Contract).withdraw(E18), "Paused: repay in full to withdraw");
    await exec((sys.vault.connect(borrower) as Contract).repay(100n * E18));
    const got = await fundPaxg(sys, borrower.address, E18 / 10n);
    await exec((sys.vault.connect(borrower) as Contract).deposit(ADDR.PAXG, got));
    const saver = await wallet("s8-saver");
    const s = await fundPaxg(sys, saver.address, E18);
    await exec((sys.paxg.connect(saver) as Contract).approve(sys.a.vault, MAX));
    await exec((sys.vault.connect(saver) as Contract).deposit(ADDR.PAXG, s));
    await exec((sys.vault.connect(saver) as Contract).withdraw(s));
    const c = variantC(scale(base.C, 820_000n), scale(base.G, 820_000n)).liq; // the rules' price
    const l = await liquidate(sys, bank, victim.address, "emergency");
    assert(samePrice(l.impliedPrice, c), `emergency liquidation at ${usd8(l.impliedPrice)}`);
    // An unpause names the pause it lifts: read the vault's pauseEpoch when it is scheduled.
    const epoch: bigint = await sys.vault.pauseEpoch();
    const unpause = await expectRevert((sys.vault.connect(guardian) as Contract).unpause(epoch));
    const how = await govern(sys, `vault.unpause(${epoch})`, [{ to: sys.a.vault, data: sys.vault.interface.encodeFunctionData("unpause", [epoch]) }]);
    assert(!(await sys.vault.paused()), "still paused");
    await market({ C: base.C, G: base.G });
    await exec((sys.vault.connect(borrower) as Contract).mint(1_000n * E18));
    return `paused: mint "${mint}", liquidate "${liq}", liquidateViaPool still open (${pool}), indebted withdraw "${withdraw}"; repay, deposit and a debt-free withdrawal went through; emergencyLiquidate at ${usd8(l.impliedPrice)} = the rules' price; guardian unpause "${unpause.slice(0, 50)}"; ${how}; minting resumed`;
  });

  start = await rewind(start);
  await r.check("pause:pool-paused-still-absorbs-oracle-paused-emergency-path-only", async () => {
    const c = variantC(scale(base.C, 820_000n), scale(base.G, 820_000n)).liq; // the rules' price
    await market({ C: c, G: scale(base.G, 820_000n) });
    await exec((sys.pool.connect(guardian) as Contract).emergencyPause());
    const dep = await expectRevert((sys.pool.connect(bank) as Contract).deposit(1_000n * E18));
    const l = await liquidate(sys, keeper, victim.address, "pool");
    assert(samePrice(l.impliedPrice, c), `pool liquidation at ${usd8(l.impliedPrice)}`);
    await exec((sys.oracle.connect(guardian) as Contract).emergencyPause());
    const tok = await quote(sys, "token");
    const liq = await expectRevert((sys.vault.connect(bank) as Contract).liquidate(victim2.address, 0));
    const e = await liquidate(sys, bank, victim2.address, "emergency");
    assert(samePrice(e.impliedPrice, c), `emergency liquidation at ${usd8(e.impliedPrice)}`);
    return `pool paused: deposit "${dep.slice(0, 40)}", yet liquidateViaPool absorbed ${g18(l.debtRepaid, 2)} GSUSD at ${usd8(l.impliedPrice)}; oracle paused: liquidation read "${tok.why}", liquidate "${liq.slice(0, 40)}", emergencyLiquidate at ${usd8(e.impliedPrice)} = the rules' price`;
  });
});
