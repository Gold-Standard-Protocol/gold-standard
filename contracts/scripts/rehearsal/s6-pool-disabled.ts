/**
 * Scenario 6 (variant C): the Uniswap PAXG/WETH pool is no longer a price source, so disabling or
 * pushing it changes nothing. An attacker empties the pool's in-range liquidity for one 12 s block
 * and restores it, then pushes the pool 10% down and holds it 25 minutes: every price the protocol
 * reads (liquidation, borrowing, reserve, valuation) stays exactly what C and G give.
 *
 *   LOCAL_RPC_URL=http://127.0.0.1:8547 npx hardhat run --no-compile scripts/rehearsal/s6-pool-disabled.ts --network localhost
 */
import {
  advance, assert, latestTs, market, poolSpot, poolTo, pushPool, quote, restamp, scenario, send, showQuote, trader,
} from "./lib";
import type { System } from "./lib";

async function prices(sys: System): Promise<string> {
  const qs = await Promise.all([quote(sys, "token"), quote(sys, "borrow"), quote(sys, "reserve"), quote(sys, "valuation")]);
  return qs.map(showQuote).join(" / ");
}

scenario("Scenario 6: the pool is out of the pricing path (disabled or pushed, nothing moves)", async (sys, r) => {
  const attacker = await trader(sys, "s6-attacker");
  await market({});
  const before = await prices(sys);

  await r.check("pool-emptied-for-one-block-changes-no-price", async () => {
    const spot0 = await poolSpot(sys);
    const out = await poolTo(sys, attacker, spot0.sqrtP * 2n);
    await send("evm_setNextBlockTimestamp", [(await latestTs()) + 12]);
    await poolTo(sys, attacker, spot0.sqrtP);
    await restamp();
    const after = await prices(sys);
    assert(after === before, `${before} -> ${after}`);
    return `${out}, restored 12 s later; liquidation / borrowing / reserve / valuation ${after}, unchanged`;
  });

  await r.check("pool-pushed-10pct-down-held-25-min-changes-no-price", async () => {
    const swap = await pushPool(sys, attacker, 900_000n);
    for (let s = 300; s <= 1500; s += 300) {
      await advance(300);
      await restamp();
      const now = await prices(sys);
      assert(now === before, `t+${s / 60} min: ${now}`);
    }
    return `${swap}; prices ${before} at every 5 minute step for 25 minutes`;
  });
});
