import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { setValidPrice } from "./helpers/productionSystem";
import { loadOpen } from "./helpers/openProfile";

/**
 * Randomised multi-actor run on the open launch profile. After every step it checks:
 *  I1  sum of vault principal == sum of collateralType.totalDebt
 *  I2  GSUSD supply - externally minted == sum of vault principal + totalBadDebt
 *  I3  per token: sum of vault collateral == silo total; vault balance == surplusCollateral
 *  I4  per token: protocol token balances cover everything the accounting says is owed
 *  I5  pool: sum of effective deposits <= totalDeposits <= GSUSD held by the pool
 *  I6  module: sum of current debt >= sum of principal
 *  I7  reserve: collateralBalance <= token balance; reserve GSUSD >= gsusdInventory
 * Three seeds of 150 steps keep the suite fast; SEEDS="1,2,3,4,5" STEPS=250 widens the
 * sweep for a deeper run.
 */
const SEEDS = (process.env.SEEDS ?? "1,2,3").split(",").map((x) => Number(x));
const STEPS = Number(process.env.STEPS ?? 150);

function mulberry32(a: number) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("Invariant fuzz (open profile)", function () {
  this.timeout(3_600_000);

  for (const seed of SEEDS) {
    it(`seed ${seed}`, async function () {
      const rnd = mulberry32(seed);
      const pick = <T,>(xs: T[]) => xs[Math.floor(rnd() * xs.length)];
      const s = await loadOpen();
      const rates = [0, 200, 1500, 5000];
      const ratePax = pick(rates); const rateXaut = pick(rates); const origBps = pick([0, 25, 100]);
      if (ratePax) await s.stabilityModule.setStabilityFee(s.paxgId, ratePax);
      if (rateXaut) await s.stabilityModule.setStabilityFee(s.xautId, rateXaut);
      if (origBps) await s.vault.setOriginationFeeBps(origBps);
      const signers = await ethers.getSigners();
      const actors = signers.slice(4, 12);
      const liquidators = signers.slice(12, 14);
      const vaultAddr = await s.vault.getAddress();
      const poolAddr = await s.stabilityPool.getAddress();
      const reserveAddr = await s.reserve.getAddress();
      const tokens = { paxg: s.paxg, xaut: s.xaut };
      const tokenAddr = { paxg: await s.paxg.getAddress(), xaut: await s.xaut.getAddress() };
      const unit = { paxg: 10n ** 18n, xaut: 10n ** 6n };
      const feeds = { paxg: s.paxgFeed, xaut: s.xautFeed };
      const price: Record<"paxg" | "xaut", bigint> = { paxg: 2000n * 10n ** 8n, xaut: 2000n * 10n ** 8n };
      const kind = new Map<string, "paxg" | "xaut">();
      let externalMinted = 100_000n * 10n ** 18n; // the fixture mints 50k to alice and bob
      const violations: string[] = [];
      let trend = 0;

      // Funding: liquidators hold GSUSD; every actor approves the vault, pool and reserve.
      for (const l of liquidators) {
        await s.stablecoin.mint(l.address, 5_000_000n * 10n ** 18n);
        externalMinted += 5_000_000n * 10n ** 18n;
      }
      for (const a of [...actors, ...liquidators]) {
        await s.stablecoin.connect(a).approve(vaultAddr, ethers.MaxUint256);
        await s.stablecoin.connect(a).approve(poolAddr, ethers.MaxUint256);
        await s.stablecoin.connect(a).approve(reserveAddr, ethers.MaxUint256);
        await s.paxg.connect(a).approve(vaultAddr, ethers.MaxUint256);
        await s.xaut.connect(a).approve(vaultAddr, ethers.MaxUint256);
      }
      await s.stabilityPool.connect(liquidators[1]).deposit(1_500_000n * 10n ** 18n);
      // Seed the reserve so swaps can happen.
      await s.paxg.mint(signers[3].address, 100n * unit.paxg);
      await s.paxg.connect(signers[3]).approve(reserveAddr, ethers.MaxUint256);
      await s.reserve.connect(signers[3]).seedCollateral(tokenAddr.paxg, 100n * unit.paxg);
      await s.xaut.mint(signers[3].address, 100n * unit.xaut);
      await s.xaut.connect(signers[3]).approve(reserveAddr, ethers.MaxUint256);
      await s.reserve.connect(signers[3]).seedCollateral(tokenAddr.xaut, 100n * unit.xaut);

      // A refused action is part of the walk; the invariants are what must hold. The label
      // names the action for a reader stepping through a failing seed.
      const attempt = async (_label: string, fn: () => Promise<unknown>) => {
        try { await fn(); return true; } catch { return false; }
      };

      const refreshFeeds = async () => {
        for (const k of ["paxg", "xaut"] as const) {
          await setValidPrice(feeds[k] as never, price[k]);
          await attempt("poke", () => s.oracle.getTokenPrice(tokenAddr[k]));
        }
      };

      const principalSum = async () => {
        let sum = 0n;
        for (const a of actors) sum += (await s.vault.vaults(a.address)).debtAmount;
        return sum;
      };

      async function checkInvariants(step: number, what: string) {
        const bad = (m: string) => violations.push(`seed ${seed} step ${step} after ${what}: ${m}`);
        // I1
        let principal = 0n; let current = 0n;
        const coll: Record<string, bigint> = { paxg: 0n, xaut: 0n };
        for (const a of actors) {
          const v = await s.vault.vaults(a.address);
          principal += v.debtAmount;
          current += await s.vault.getVaultCurrentDebt(a.address);
          const k = v.collateralToken === tokenAddr.paxg ? "paxg" : v.collateralToken === tokenAddr.xaut ? "xaut" : null;
          if (k) coll[k] += v.collateralAmount;
        }
        const tdebt = (await s.vault.collateralTypes(s.paxgId)).totalDebt + (await s.vault.collateralTypes(s.xautId)).totalDebt;
        if (tdebt !== principal) bad(`I1 totalDebt ${tdebt} != sum principal ${principal}`);
        // I2
        const supply = await s.stablecoin.totalSupply();
        const bd = await s.vault.totalBadDebt();
        const buf = await s.surplusBuffer.gsusdBalance();
        const vaultHeld = await s.stablecoin.balanceOf(vaultAddr);
        if (supply - externalMinted !== principal + bd) bad(`I2 supply-ext ${supply - externalMinted} != principal ${principal} + badDebt ${bd} (diff ${supply - externalMinted - principal - bd})`);
        if ((await s.stablecoin.balanceOf(await s.surplusBuffer.getAddress())) < buf) bad(`I9 buffer GSUSD below gsusdBalance ${buf}`);
        if (vaultHeld !== 0n) bad(`I2b vault holds ${vaultHeld} GSUSD`);
        // I3 / I4
        for (const k of ["paxg", "xaut"] as const) {
          const t = tokens[k];
          const silo = await s.siloFactory.totalCollateral(tokenAddr[k]);
          if (silo !== coll[k]) bad(`I3 ${k} silo total ${silo} != sum vault collateral ${coll[k]}`);
          const vbal = await t.balanceOf(vaultAddr);
          const surplus = await s.vault.surplusCollateral(tokenAddr[k]);
          if (vbal !== surplus) bad(`I3 ${k} vault balance ${vbal} != surplusCollateral ${surplus}`);
          // I4: pool balance covers every depositor's claimable gain
          let gains = 0n;
          for (const a of [...actors, ...liquidators]) gains += await s.stabilityPool.getCollateralGain(a.address, tokenAddr[k]);
          const pbal = await t.balanceOf(poolAddr);
          if (pbal < gains) bad(`I4 ${k} pool balance ${pbal} < claimable ${gains}`);
          const rbal = await t.balanceOf(reserveAddr);
          const racc = await s.reserve.collateralBalance(tokenAddr[k]);
          if (rbal < racc) bad(`I7 ${k} reserve balance ${rbal} < accounted ${racc}`);
          const bbal = await t.balanceOf(await s.surplusBuffer.getAddress());
          const bacc = await s.surplusBuffer.collateralBalance(tokenAddr[k]);
          if (bbal < bacc) bad(`I4 ${k} buffer balance ${bbal} < accounted ${bacc}`);
        }
        // I5
        let eff = 0n;
        for (const a of [...actors, ...liquidators]) eff += await s.stabilityPool.getEffectiveDeposit(a.address);
        const total = await s.stabilityPool.getTotalDeposits();
        const held = await s.stablecoin.balanceOf(poolAddr);
        if (eff > total) bad(`I5 sum effective ${eff} > totalDeposits ${total}`);
        if (total > held) bad(`I5 totalDeposits ${total} > pool GSUSD ${held}`);
        // I6
        if (current < principal) bad(`I6 current debt ${current} < principal ${principal}`);
        // I7
        const inv = await s.reserve.gsusdInventory();
        const rg = await s.stablecoin.balanceOf(reserveAddr);
        if (rg < inv) bad(`I7 reserve GSUSD ${rg} < inventory ${inv}`);
      }

      async function liquidateOne(): Promise<string> {
        const liq = pick(liquidators);
        const cands: string[] = [];
        for (const a of actors) {
          const vv = await s.vault.vaults(a.address);
          if (vv.debtAmount === 0n) continue;
          const ratio = await s.vault.getCollateralisationRatio(a.address);
          if (ratio < 1_100_000n) cands.push(a.address);
        }
        if (!cands.length) return "liquidate(none)";
        const target = pick(cands);
        const cur = await s.vault.getVaultCurrentDebt(target);
        const usePool = rnd() < 0.4;
        const partial = rnd() < 0.35;
        const amt = partial ? (cur * BigInt(10 + Math.floor(rnd() * 80))) / 100n : 0n;
        if (usePool) await attempt("liquidateViaPool", () => s.vault.connect(liq).liquidateViaPool(target, amt, { gasLimit: 16_000_000n }));
        else await attempt("liquidate", () => s.vault.connect(liq).liquidate(target, amt, { gasLimit: 16_000_000n }));
        return `${usePool ? "liquidateViaPool" : "liquidate"}${partial ? "(partial)" : ""}`;
      }

      const refreshAndStep = async () => { await refreshFeeds(); };

      for (let step = 0; step < STEPS; step++) {
        const r = rnd();
        const actor = pick(actors);
        let what = "noop";
        const v = await s.vault.vaults(actor.address);
        const k = kind.get(actor.address) ?? (rnd() < 0.5 ? "paxg" : "xaut");
        if (r < 0.2) {
          what = "deposit";
          if (v.collateralAmount > 0n && v.collateralToken !== tokenAddr[k]) { await checkInvariants(step, "skip"); continue; }
          const amt = BigInt(1 + Math.floor(rnd() * 40)) * unit[k] + BigInt(Math.floor(rnd() * 1000));
          await tokens[k].mint(actor.address, amt);
          if (await attempt("deposit", () => s.vault.connect(actor).deposit(tokenAddr[k], amt, { gasLimit: 16_000_000n }))) kind.set(actor.address, k);
        } else if (r < 0.4) {
          what = "mint";
          if (v.collateralAmount === 0n) { await checkInvariants(step, "skip"); continue; }
          const kk = v.collateralToken === tokenAddr.paxg ? "paxg" : "xaut";
          const value = (v.collateralAmount * 10n ** (18n - (kk === "paxg" ? 18n : 6n)) * price[kk]) / 10n ** 8n;
          const cap = (value * 1_000_000n) / 1_300_000n;
          const cur = await s.vault.getVaultCurrentDebt(actor.address);
          if (cap > cur) {
            const room = cap - cur;
            const amt = (room * BigInt(55 + Math.floor(rnd() * 45))) / 100n;
            await attempt("mint", () => s.vault.connect(actor).mint(amt, { gasLimit: 16_000_000n }));
          }
        } else if (r < 0.52) {
          what = "repay";
          const cur = await s.vault.getVaultCurrentDebt(actor.address);
          if (cur > 0n) {
            const frac = rnd() < 0.3 ? 100n : BigInt(1 + Math.floor(rnd() * 99));
            const amt = (cur * frac) / 100n + (frac === 100n ? 10n ** 15n : 0n);
            if ((await s.stablecoin.balanceOf(actor.address)) < amt) {
              await s.stablecoin.connect(liquidators[0]).transfer(actor.address, amt);
            }
            await attempt("repay", () => s.vault.connect(actor).repay(amt, { gasLimit: 16_000_000n }));
          }
        } else if (r < 0.6) {
          what = "withdraw";
          if (v.collateralAmount > 0n) {
            const frac = rnd() < 0.3 ? 100n : BigInt(1 + Math.floor(rnd() * 99));
            await attempt("withdraw", () => s.vault.connect(actor).withdraw((v.collateralAmount * frac) / 100n, { gasLimit: 16_000_000n }));
          }
        } else if (r < 0.66) {
          what = "poolDeposit";
          const bal = await s.stablecoin.balanceOf(actor.address);
          if (bal > 0n) await attempt("poolDeposit", () => s.stabilityPool.connect(actor).deposit((bal * BigInt(1 + Math.floor(rnd() * 99))) / 100n + 1n));
        } else if (r < 0.70) {
          what = "poolWithdraw";
          const e = await s.stabilityPool.getEffectiveDeposit(actor.address);
          if (e > 0n) await attempt("poolWithdraw", () => s.stabilityPool.connect(actor).withdraw((e * BigInt(1 + Math.floor(rnd() * 100))) / 100n));
        } else if (r < 0.73) {
          what = "poolClaim";
          await attempt("poolClaim", () => s.stabilityPool.connect(actor).claimCollateral(tokenAddr[pick(["paxg", "xaut"] as const)]));
        } else if (r < 0.77) {
          what = "swap";
          const bal = await s.stablecoin.balanceOf(actor.address);
          if (bal > 0n) {
            const tk = pick(["paxg", "xaut"] as const);
            await attempt("swap", () => s.reserve.connect(actor).swapGsusdForGold(tokenAddr[tk], (bal * BigInt(1 + Math.floor(rnd() * 50))) / 100n + 10n ** 16n, 0n, { gasLimit: 16_000_000n }));
          }
        } else if (r < 0.84) {
          what = await liquidateOne();
        } else if (r < 0.94) {
          what = "price";
          const tk = pick(["paxg", "xaut"] as const);
          if (rnd() < 0.08) trend = pick([-1, -1, 1, 0]);
          const delta = trend < 0 ? -(0.03 + rnd() * 0.06) : trend > 0 ? 0.02 + rnd() * 0.05 : (rnd() - 0.5) * 0.08;
          let next = (price[tk] * BigInt(Math.round((1 + delta) * 1e6))) / 1_000_000n;
          const floor = 400n * 10n ** 8n;
          if (next < floor) next = floor;
          if (next > 6000n * 10n ** 8n) next = 6000n * 10n ** 8n;
          // Keep each hop under the breaker.
          const lk = await s.oracle.getLastKnownPrice(tokenAddr[tk]);
          const maxStep = (lk * 9n) / 100n;
          if (next > lk + maxStep) next = lk + maxStep;
          if (next + maxStep < lk) next = lk - maxStep;
          price[tk] = next;
          await time.increase(30);
          await setValidPrice(feeds[tk] as never, next);
          await attempt("poke", () => s.oracle.getTokenPrice(tokenAddr[tk]));
          if (rnd() < 0.8) { for (let i = 0; i < 3; i++) await liquidateOne(); what = "price+sweep"; }
          if (rnd() < 0.12) {
            // Flash crash: three hops of about 8.5% with no liquidation between them.
            for (let h = 0; h < 3; h++) {
              const lk2 = await s.oracle.getLastKnownPrice(tokenAddr[tk]);
              const nx = (lk2 * 915n) / 1000n;
              price[tk] = nx;
              await time.increase(30);
              await setValidPrice(feeds[tk] as never, nx);
              await attempt("poke", () => s.oracle.getTokenPrice(tokenAddr[tk]));
            }
            for (let i = 0; i < 4; i++) await liquidateOne();
            what = "flashcrash+sweep";
          }
        } else if (r < 0.955) {
          what = "governance";
          const tk = pick(["paxg", "xaut"] as const);
          const choice = Math.floor(rnd() * 6);
          if (choice === 0) {
            const liqRatio = pick([1_000_000n, 1_050_000n, 1_100_000n, 1_200_000n]);
            const pen = pick([0n, 20_000n, 50_000n, 100_000n, 200_000n]);
            await attempt("gov.updateCollateralRatios", () => s.vault.updateCollateralRatios(tokenAddr[tk], 1_300_000n, liqRatio, pen));
            what = `gov.liq${liqRatio}/${pen}`;
          } else if (choice === 1) {
            await attempt("gov.setMinDebt", () => s.vault.setMinDebt(pick([100n, 1000n, 10_000n]) * 10n ** 18n));
          } else if (choice === 2) {
            await attempt("gov.setUnderwaterDiscount", () => s.vault.setUnderwaterDiscount(pick([0n, 20_000n, 50_000n])));
          } else if (choice === 3) {
            await attempt("gov.setLiquidatorIncentiveShare", () => s.vault.setLiquidatorIncentiveShare(pick([0n, 300_000n, 600_000n, 1_000_000n])));
          } else if (choice === 4) {
            await attempt("gov.setReservePenaltyShare", () => s.vault.setReservePenaltyShare(pick([0n, 4000n, 10_000n])));
          } else {
            await attempt("gov.setBadDebtPauseThreshold", () => s.vault.setBadDebtPauseThreshold(pick([0n, 5_000n * 10n ** 18n, 25_000n * 10n ** 18n])));
          }
        } else if (r < 0.975) {
          what = "breaker";
          const tk = pick(["paxg", "xaut"] as const);
          const lk = await s.oracle.getLastKnownPrice(tokenAddr[tk]);
          const gap = rnd() < 0.7 ? (lk * 85n) / 100n : (lk * 115n) / 100n;
          price[tk] = gap;
          await time.increase(30);
          await setValidPrice(feeds[tk] as never, gap);
          // The guardian's manual freeze (there is no permissionless trip): a frozen token is
          // emergency liquidated at its normal price, here the mirrored market price.
          if (await attempt("freezeToken", () => s.oracle.connect(s.guardian).freezeToken(tokenAddr[tk]))) {
            for (let i = 0; i < 4; i++) {
              const liq = pick(liquidators);
              for (const a of actors) {
                const vv = await s.vault.vaults(a.address);
                if (vv.debtAmount === 0n) continue;
                const cur = await s.vault.getVaultCurrentDebt(a.address);
                const partial = rnd() < 0.3;
                const amt = partial ? (cur * BigInt(10 + Math.floor(rnd() * 80))) / 100n : 0n;
                await attempt("emergencyLiquidate", () => s.vault.connect(liq).emergencyLiquidate(a.address, amt, { gasLimit: 16_000_000n }));
              }
              break;
            }
            // Recovery by the guardian, as the runbook describes: no anchor is set here, so the
            // per-token unfreeze records the live price the rules give.
            for (const t2 of ["paxg", "xaut"] as const) {
              const live = await s.oracle.getValidatedPrice(tokenAddr[t2]);
              if (live[1]) price[t2] = live[0];
              if (await s.oracle.tokenFrozen(tokenAddr[t2])) {
                await attempt("guardianUnfreezeToken", async () =>
                  s.oracle.connect(s.guardian).guardianUnfreezeToken(tokenAddr[t2], await s.oracle.freezeEpoch(tokenAddr[t2]))
                );
              } else {
                await attempt("guardianResync", () => s.oracle.connect(s.guardian).guardianResyncLastKnownPrice(tokenAddr[t2]));
              }
            }
            if (await s.oracle.paused()) { await attempt("gov.unpause", async () => s.oracle.unpause(await s.oracle.pauseEpoch())); }
          }
        } else {
          what = "timejump";
          const secs = Math.floor(3600 + rnd() * (rnd() < 0.2 ? 400 : 20) * 86400);
          await time.increase(secs);
          await refreshAndStep();
        }
        if (await s.vault.paused()) await attempt("gov.vault.unpause", async () => s.vault.unpause(await s.vault.pauseEpoch()));
        await checkInvariants(step, what);
        if (violations.length > 12) break;
      }

      // Everyone exits: repay all, withdraw all, then check nothing is stranded.
      await refreshFeeds();
      for (const a of actors) {
        const cur = await s.vault.getVaultCurrentDebt(a.address);
        if (cur > 0n) {
          const need = cur + 10n ** 16n;
          const bal = await s.stablecoin.balanceOf(a.address);
          if (bal < need) await s.stablecoin.connect(liquidators[0]).transfer(a.address, need - bal);
          await attempt("exit-repay", () => s.vault.connect(a).repay(need, { gasLimit: 16_000_000n }));
        }
        const v = await s.vault.vaults(a.address);
        if (v.collateralAmount > 0n) await attempt("exit-withdraw", () => s.vault.connect(a).withdraw(v.collateralAmount, { gasLimit: 16_000_000n }));
      }
      await checkInvariants(STEPS, "exit");
      expect(violations, violations.slice(0, 6).join("\n")).to.deep.equal([]);
      // Nothing is stranded once every borrower has repaid and withdrawn in full.
      for (const k of ["paxg", "xaut"] as const) {
        expect(await s.siloFactory.totalCollateral(tokenAddr[k]), `${k} left in silos`).to.equal(0n);
      }
    });
  }
});
