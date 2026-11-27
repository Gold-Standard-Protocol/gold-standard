/**
 * Scenario 2: full and partial liquidation, direct and through the stability pool, with every flow
 * reconciled against the contracts' own sizing (GoldVault._sizeSeizure, _payLiquidation and
 * liquidateViaPool): GSUSD supply against aggregate principal plus bad debt, the fee banked in the
 * buffer, the penalty gold split between liquidator, reserve and buffer, the pool's deposits and
 * its depositors' collateral gains. Four vaults open at 131%, carry 60 days of fee, then gold falls
 * 18% (C and G together, inside the band) so each sits near 108%.
 *
 *   LOCAL_RPC_URL=http://127.0.0.1:8547 npx hardhat run --no-compile scripts/rehearsal/s2-liquidations.ts --network localhost
 */
import type { Wallet } from "ethers";
import {
  ADDR, E18, E8, PPM, actors, advance, assert, colId, delta, g18, identity, ledger, liquidate, market, openVault, pokePool,
  quote, ratioAt, restamp, scale, scenario, trader, usd8,
} from "./lib";
import type { Ledger, Liquidation, System } from "./lib";

const mulDiv = (a: bigint, b: bigint, c: bigint): bigint => (a * b) / c;

async function gains(sys: System, who: string[]): Promise<bigint> {
  let sum = 0n;
  for (const w of who) sum += await sys.pool.getCollateralGain(w, ADDR.PAXG);
  return sum;
}

scenario("Scenario 2: liquidations, direct and pool, full and partial, with the accounting identity", async (sys, r) => {
  const bank = await actors.bank();
  const keeper = await actors.keeper();
  const depositors = [bank.address, sys.snap.deployer as string];
  const penalty: bigint = (await sys.vault.collateralTypes(colId(ADDR.PAXG))).liquidationPenalty;
  const share: bigint = await sys.vault.liquidatorIncentiveShare();
  const reserveBps: bigint = await sys.vault.reservePenaltyShareBps();
  const vaults: Wallet[] = [];

  await r.check("setup:five-vaults-at-131pct-then-60-days-then-gold-down-18pct", async () => {
    for (let i = 0; i < 5; i++) vaults.push((await openVault(sys, `s2-v${i}`, 5n * E18, 1_310_000n)).w);
    await advance(60 * 86_400);
    await restamp();
    await pokePool(sys, await trader(sys));
    const m = await market({});
    await market({ C: scale(m.C, 820_000n), G: scale(m.G, 820_000n) });
    const c: bigint = await sys.oracle.quoteTokenPrice(ADDR.PAXG);
    const ratios = await Promise.all(vaults.map((v) => ratioAt(sys, v.address, c)));
    assert(ratios.every((x) => x < 1_100_000n && x >= 1_050_000n), `ratios ${ratios.join(",")}`);
    identity(await ledger(sys));
    return `C ${usd8(m.C)} -> ${usd8(c)}; vault ratios at C ${ratios.map((x) => (Number(x) / 10_000).toFixed(2) + "%").join(", ")}; identity holds`;
  });

  const run = async (name: string, i: number, mode: Liquidation["mode"], partial: boolean, by: Wallet): Promise<void> => {
    await r.check(name, async () => {
      const owner = vaults[i].address;
      const price = (await quote(sys, "token")).price;
      const vBefore = await sys.vault.vaults(owner);
      const debtNow: bigint = await sys.vault.getVaultCurrentDebt(owner);
      const askFor = partial ? (debtNow * 4n) / 10n : 0n;
      const before: Ledger = await ledger(sys);
      const gainBefore = await gains(sys, depositors);
      const l = await liquidate(sys, by, owner, mode, askFor);
      const after: Ledger = await ledger(sys);
      const d = delta(before, after);
      const vAfter = await sys.vault.vaults(owner);
      const D = l.debtRepaid, S = l.seized;
      const principalRetired: bigint = (vBefore[2] as bigint) - (vAfter[2] as bigint);
      // the contract's own sizing at C
      const expectS = mulDiv(D * (PPM + penalty), E8, price * PPM);
      assert(S === expectS, `seized ${S}, expected ${expectS} at ${usd8(price)}`);
      const debtEq = mulDiv(D, E8, price);
      const totalPenalty = S - debtEq;
      assert(d.supply === -principalRetired && d.paxgDebt === -principalRetired, `supply ${d.supply} / debt ${d.paxgDebt} vs principal ${principalRetired}`);
      assert(d.bufferGsusd === D - principalRetired, `buffer GSUSD +${d.bufferGsusd}, fee ${D - principalRetired}`);
      assert(d.custody === -S && d.collateralSum === -S, "custody did not fall by the seizure");
      let flows: string;
      if (mode === "pool") {
        const bounty = mulDiv(totalPenalty, share / 2n, PPM);
        const gain = (await gains(sys, depositors)) - gainBefore;
        assert(l.liquidatorPaxg === bounty, `keeper got ${l.liquidatorPaxg}, bounty ${bounty}`);
        assert(d.poolDeposits === -D && d.poolPaxg === S - bounty, `pool deposits ${d.poolDeposits}, pool PAXG ${d.poolPaxg}`);
        assert(d.reservePaxg === 0n && d.bufferPaxg === 0n, "the pool path paid the reserve or the buffer");
        // product-sum rounding leaves dust in the pool, never a gain the pool cannot pay
        assert(gain <= d.poolPaxg && (d.poolPaxg - gain) * 1_000_000_000n <= d.poolPaxg, `depositors' gains +${gain} vs pool PAXG +${d.poolPaxg}`);
        flows = `pool -${g18(D, 2)} GSUSD, +${g18(d.poolPaxg, 6)} PAXG (depositors' gains +${g18(gain, 6)}, ${d.poolPaxg - gain} wei of rounding dust stays in the pool); keeper bounty ${g18(bounty, 6)} PAXG (30% of the penalty)`;
      } else {
        const bonus = mulDiv(totalPenalty, share, PPM);
        const protocol = S - debtEq - bonus;
        const toReserve = mulDiv(protocol, reserveBps, 10_000n);
        assert(l.liquidatorPaxg === debtEq + bonus, `liquidator got ${l.liquidatorPaxg}, expected ${debtEq + bonus}`);
        assert(d.reservePaxg === toReserve && d.bufferPaxg === protocol - toReserve, `reserve +${d.reservePaxg}, buffer +${d.bufferPaxg}`);
        assert(d.poolDeposits === 0n && d.poolPaxg === 0n, "the direct path touched the pool");
        flows = `liquidator paid ${g18(D, 2)} GSUSD, got ${g18(l.liquidatorPaxg, 6)} PAXG (debt equivalent + 60% of the penalty); protocol ${g18(protocol, 6)} PAXG: reserve ${g18(toReserve, 6)}, buffer ${g18(protocol - toReserve, 6)}`;
      }
      if (partial) {
        assert(vAfter[2] >= (await sys.vault.minDebt()) && vAfter[1] > 0n, "partial left dust or emptied the vault");
      } else {
        assert(vAfter[2] === 0n, "full liquidation left principal");
      }
      assert(d.badDebt === 0n, "bad debt booked");
      identity(after);
      return `at ${usd8(price)} (implied ${usd8(l.impliedPrice)}): repaid ${g18(D, 4)} (principal ${g18(principalRetired, 4)} burned, fee ${g18(D - principalRetired, 6)} banked), seized ${g18(S, 6)} PAXG; ${flows}; ${partial ? `vault keeps ${g18(vAfter[1], 4)} PAXG / ${g18(vAfter[2], 2)} principal` : "vault cleared"}; gas ${l.gasUsed}`;
    });
  };

  await run("liquidate:direct-full", 0, "direct", false, bank);
  await run("liquidate:direct-partial-40pct", 1, "direct", true, bank);
  await run("liquidate:pool-full", 2, "pool", false, keeper);
  await run("liquidate:pool-partial-40pct", 3, "pool", true, keeper);

  await r.check("liquidate:thin-solvent-vault-partial-pro-rata-then-full", async () => {
    const m = await market({});
    await market({ C: scale(m.C, 957_000n), G: scale(m.G, 957_000n) });
    const price = (await quote(sys, "token")).price;
    const owner = vaults[4].address;
    const ratio = await ratioAt(sys, owner, price);
    assert(ratio > 1_000_000n && ratio < 1_000_000n + penalty, `ratio ${ratio} is not between 100% and 100% + penalty`);
    const coll: bigint = (await sys.vault.vaults(owner))[1];
    const debtNow: bigint = await sys.vault.getVaultCurrentDebt(owner);
    const before = await ledger(sys);
    const l = await liquidate(sys, bank, owner, "direct", (debtNow * 4n) / 10n);
    const d = delta(before, await ledger(sys));
    const D = l.debtRepaid, S = l.seized;
    const proRata = mulDiv(coll, D, debtNow);
    assert((S > proRata ? S - proRata : proRata - S) * PPM <= S, `seized ${S}, pro rata ${proRata}`);
    const debtEq = mulDiv(D, E8, price);
    const bonus = mulDiv(S - debtEq, share, PPM);
    const protocol = S - debtEq - bonus;
    assert(l.liquidatorPaxg === debtEq + bonus, `liquidator ${l.liquidatorPaxg}, expected ${debtEq + bonus}`);
    assert(d.reservePaxg === mulDiv(protocol, reserveBps, 10_000n), "reserve share");
    const ratioAfter = await ratioAt(sys, owner, price);
    const full = await liquidate(sys, keeper, owner, "pool");
    const vAfter = await sys.vault.vaults(owner);
    assert(vAfter[1] === 0n && vAfter[2] === 0n, "thin vault not cleared");
    assert((await sys.vault.totalBadDebt()) === 0n, "bad debt booked on a solvent vault");
    identity(await ledger(sys));
    return `gold -4.3% more: vault at ${(Number(ratio) / 10_000).toFixed(2)}% (penalty cannot fit); 40% partial repaid ${g18(D, 2)}, seized ${g18(S, 6)} PAXG = the same share of the gold (penalty ${g18(S - debtEq, 6)} PAXG, ${(Number(((S - debtEq) * PPM) / debtEq) / 10_000).toFixed(2)}% instead of 5%); ratio after ${(Number(ratioAfter) / 10_000).toFixed(2)}%; then the pool took the rest in full: ${g18(full.seized, 6)} PAXG for ${g18(full.debtRepaid, 2)} GSUSD; no bad debt; identity holds`;
  });

  await r.check("pool:depositor-claims-gain", async () => {
    const gain: bigint = await sys.pool.getCollateralGain(bank.address, ADDR.PAXG);
    const before: bigint = await sys.paxg.balanceOf(bank.address);
    await (await (sys.pool.connect(bank) as never as { claimCollateral: (t: string) => Promise<{ wait: () => Promise<unknown> }> }).claimCollateral(ADDR.PAXG)).wait();
    const got = (await sys.paxg.balanceOf(bank.address)) - before;
    assert(got === gain, `claimed ${got}, gain ${gain}`);
    return `bank claimed ${g18(got, 6)} PAXG; effective deposit ${g18(await sys.pool.getEffectiveDeposit(bank.address), 2)} GSUSD`;
  });

  await r.check("accounting:end-state", async () => {
    const l = await ledger(sys);
    assert(l.badDebt === 0n, "bad debt");
    return identity(l);
  });
});
