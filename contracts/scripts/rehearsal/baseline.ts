/**
 * Fork rehearsal baseline, after deploy.ts, verify-deployment.ts and rehearse-mainnet-fork.ts:
 *
 *   1. Points the three REAL Chainlink proxies the protocol reads (PAXG/USD = C, XAU/USD = G and
 *      ETH/USD inside P) at mock aggregators through each proxy's own proposeAggregator and
 *      confirmAggregator, as their owner. Answers start at the live values; only the scenarios
 *      move them. The protocol's addresses are untouched.
 *   2. Funds the actors every scenario reuses: the bank (a 800 PAXG vault, 1,000,000 GSUSD minted
 *      under the per-block cap, 300,000 of it in the stability pool, the rest liquidation float)
 *      and the trader (PAXG and WETH for real swaps through SwapRouter02).
 *
 *   LOCAL_RPC_URL=http://127.0.0.1:8547 npx hardhat run --no-compile scripts/rehearsal/baseline.ts --network localhost
 */
import { Contract } from "ethers";
import {
  ADDR, E18, FEEDS, MAX, Report, actors, assertFork, exec, fundPaxg, g18, identity, ledger, mintChunks, quote,
  restamp, showQuote, system, takeOverFeed, trader, twapRead, usd8, wallet,
} from "./lib";
import { describeErrorStack } from "../lib/redact";

async function main(): Promise<void> {
  const fork = await assertFork();
  const sys = await system();
  const r = new Report(`Baseline (chain ${fork.chainId}, block ${fork.block})`);
  const operator = await wallet("feed-operator", 100n);

  for (const [name, address] of Object.entries(FEEDS)) {
    await r.check(`feeds:take-over-${name}`, () => takeOverFeed(address, operator));
  }
  await r.check("feeds:restamped", async () => {
    const m = await restamp();
    return `C ${usd8(m.C)}, G ${usd8(m.G)}, ETH/USD ${usd8(m.ETH)}, all stamped at the latest block`;
  });

  await r.check("actors:trader", async () => {
    const t = await trader(sys);
    return `${t.address}: ${g18(await sys.paxg.balanceOf(t.address), 1)} PAXG, ${g18(await sys.weth.balanceOf(t.address), 1)} WETH, router approved`;
  });

  await r.check("actors:bank", async () => {
    const bank = await actors.bank();
    if ((await sys.vault.vaults(bank.address))[2] > 0n) return `${bank.address} already funded`;
    const got = await fundPaxg(sys, bank.address, 800n * E18);
    await exec((sys.paxg.connect(bank) as Contract).approve(sys.a.vault, got));
    await exec((sys.vault.connect(bank) as Contract).deposit(ADDR.PAXG, got));
    await mintChunks(sys, bank, 1_000_000n * E18);
    await exec((sys.gsusd.connect(bank) as Contract).approve(sys.a.vault, MAX));
    await exec((sys.gsusd.connect(bank) as Contract).approve(sys.a.stabilityPool, MAX));
    await exec((sys.pool.connect(bank) as Contract).deposit(300_000n * E18));
    const ratio: bigint = await sys.vault.getCollateralisationRatio(bank.address);
    return `${bank.address}: ${g18(got, 2)} PAXG, 1,000,000 GSUSD minted (in per-block-cap chunks where a cap applies; one mint under open) (ratio ${(Number(ratio) / 10_000).toFixed(1)}%), 300,000 in the stability pool, ${g18(await sys.gsusd.balanceOf(bank.address), 0)} float`;
  });
  await r.check("actors:keeper", async () => `${(await actors.keeper()).address} (ETH only; the pool path needs no capital)`);

  await r.check("baseline:prices", async () => {
    const [t, b, p] = await Promise.all([quote(sys, "token"), quote(sys, "borrow"), twapRead(sys)]);
    return `liquidation ${showQuote(t)}, borrowing ${showQuote(b)}, reserve ${showQuote(await quote(sys, "reserve"))}, valuation ${showQuote(await quote(sys, "valuation"))}${p.status === "NONE" ? "" : `, P ${p.status} ${usd8(p.answer)}`}`;
  });
  await r.check("baseline:accounting-identity", async () => identity(await ledger(sys)));
  r.finish();
}

main().catch((e) => {
  console.error(describeErrorStack(e));
  process.exit(1);
});
