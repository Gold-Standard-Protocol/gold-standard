/**
 * Scenario 5 (variant C): a stale feed. With either C (Chainlink PAXG/USD) or G (Chainlink XAU/USD)
 * older than the 90,000 s staleness threshold, every priced path is refused "No reliable price":
 * liquidation (normal, pool and, while paused, emergency), borrowing, reserve swaps and their
 * quote, and coverage valuation. Repayment and deposits never read a price and go through.
 * Pricing resumes by itself on the next healthy round: no call, role or keeper step.
 *
 *   (v) C stale, then (after it recovers) G stale, then both; each followed by a fresh round.
 *
 *   LOCAL_RPC_URL=http://127.0.0.1:8547 npx hardhat run --no-compile scripts/rehearsal/s5-stale-feeds.ts --network localhost
 */
import { Contract } from "ethers";
import type { Wallet } from "ethers";
import {
  ADDR, E18, MAX, actors, assert, exec, expectRevert, fundPaxg, impersonate, liquidate, market, openVault, quote,
  rewind, samePrice, scale, scenario, showQuote, snapshot, usd8, variantC,
} from "./lib";
import type { FeedName, System } from "./lib";

const STALE = 90_001; // one second past the oracle's threshold

async function repayAndDeposit(sys: System, w: Wallet): Promise<void> {
  const before: bigint = await sys.vault.getVaultCurrentDebt(w.address);
  await exec((sys.vault.connect(w) as Contract).repay(100n * E18));
  const got = await fundPaxg(sys, w.address, E18 / 10n);
  await exec((sys.vault.connect(w) as Contract).deposit(ADDR.PAXG, got));
  assert(before - (await sys.vault.getVaultCurrentDebt(w.address)) >= 99n * E18, "repayment did not land");
}

scenario("Scenario 5: stale feeds refuse every priced path and resume by themselves (variant C)", async (sys, r) => {
  const keeper = await actors.keeper();
  const bank = await actors.bank();
  const guardian = await impersonate(sys.c.guardian);
  const borrower = (await openVault(sys, "s5-borrower", 10n * E18, 1_500_000n)).w;
  await exec((sys.paxg.connect(borrower) as Contract).approve(sys.a.vault, MAX));
  const victim = (await openVault(sys, "s5-victim", 5n * E18, 1_310_000n)).w;
  await exec((sys.gsusd.connect(bank) as Contract).approve(sys.a.reserve, MAX));
  const base = await market({});
  // a gold-wide fall puts the victim under 110%, so each refusal below is the price and not the ratio
  const c = scale(base.C, 820_000n), g = scale(base.G, 820_000n);
  await market({ C: c, G: g });
  let start = await snapshot();

  for (const [i, stale] of ([["C"], ["G"], ["C", "G"]] as FeedName[][]).entries()) {
    // each case starts from the same healthy, unpaused market with the victim open
    if (i > 0) start = await rewind(start);
    await r.check(`v:${stale.join("+")}-stale-refused-then-resumes`, async () => {
      const ages = Object.fromEntries(stale.map((n) => [n, STALE]));
      await market({ C: c, G: g }, ages);
      const qs = await Promise.all([quote(sys, "token"), quote(sys, "borrow"), quote(sys, "reserve"), quote(sys, "valuation")]);
      assert(qs.slice(0, 3).every((q) => !q.ok && q.why === "No reliable price") && qs[3].ok && qs[3].price === 0n, `quotes ${qs.map(showQuote).join(", ")}`);
      const liq = await expectRevert((sys.vault.connect(keeper) as Contract).liquidateViaPool(victim.address, 0), "No reliable price");
      const direct = await expectRevert((sys.vault.connect(bank) as Contract).liquidate(victim.address, 0), "No reliable price");
      const mint = await expectRevert((sys.vault.connect(borrower) as Contract).mint(1_000n * E18), "No reliable price");
      const swap = await expectRevert((sys.reserve.connect(bank) as Contract).swapGsusdForGold(ADDR.PAXG, 1_000n * E18, 0), "No reliable price");
      const [goldOut] = await sys.reserve.quoteGoldOut(ADDR.PAXG, 1_000n * E18);
      await exec((sys.vault.connect(guardian) as Contract).emergencyPause());
      const emer = await expectRevert((sys.vault.connect(bank) as Contract).emergencyLiquidate(victim.address, 0), "No price");
      await repayAndDeposit(sys, borrower);
      // the next healthy round: nothing else is called
      await market({ C: c, G: g });
      const back = await Promise.all([quote(sys, "token"), quote(sys, "borrow"), quote(sys, "reserve")]);
      const want = variantC(c, g);
      assert(back[0].price === want.liq && back[1].price === want.borrow && back[2].price === want.reserve, `after the fresh round ${back.map(showQuote).join(", ")}`);
      const l = await liquidate(sys, bank, victim.address, "emergency");
      assert(samePrice(l.impliedPrice, want.liq), `emergency liquidation at ${usd8(l.impliedPrice)}`);
      return `${stale.join(" and ")} ${STALE} s old: liquidation, borrowing and reserve quotes "No reliable price", valuation 0 (the reserve counts no coverage for PAXG); liquidateViaPool "${liq}", liquidate "${direct}", mint "${mint}", reserve swap "${swap}" (quoteGoldOut ${goldOut}); vault paused: emergencyLiquidate "${emer}"; repay and deposit went through. Next healthy round, no call made: liquidation ${usd8(back[0].price)}, borrowing ${usd8(back[1].price)}, reserve ${usd8(back[2].price)}; the paused vault's emergency liquidation settled at ${usd8(l.impliedPrice)}`;
    });
  }
});
