/**
 * Scenario 19, after the handover: the first-week operations of docs/MAINNET.md section 5 as
 * the operations Safe performs them, with every printed transaction sent unchanged.
 *
 *   seed vault  the Safe holds the launch gold, 0.70 PAXG: it deposits 0.65 and mints
 *               1,551 GSUSD on launch day, paying the origination fee like any borrower:
 *               the keeper's 1,100 GSUSD float and 450 for the GSUSD/USDC position; it sends
 *               the float to the keeper wallet
 *   float       the keeper wallet liquidates a minimum-debt vault in full, directly, out of
 *               the float, which covers one such vault and no more
 *   reserve     print-reserve-seed.ts for 0.05 PAXG, the launch seed, sent by the operations
 *               Safe; one swap pays exactly quoteGoldOut, banks the spread and lowers
 *               remainingDailyCapacity by the gold paid; a swap over the capacity is refused
 *   exemption   print-fee-exemption-proposal.ts for the operations Safe: scheduled by the
 *               proposer Safe the same day, executed by the executor Safe 48 hours later, so
 *               that a later mint, such as the one that deepens the position, pays no fee
 *
 * The operations Safe is OPERATIONS_SAFE when it is set (the real Safe, by impersonation) and
 * a stand-in MockSafe otherwise.
 *
 *   LOCAL_RPC_URL=http://127.0.0.1:8547 npx hardhat run --no-compile scripts/rehearsal/s19-operations-safe.ts --network localhost
 */
import { Contract, Wallet } from "ethers";
import type { JsonRpcSigner, TransactionReceipt } from "ethers";
import {
  ADDR, E18, E8, MAX, PPM, advance, assert, at, actors, deploy, exec, expectRevert, fundPaxg, g18, identity, impersonate, ledger,
  market, printedTransactions, restamp, runScript, scale, scenario, setEth, wallet,
} from "./lib";
import type { PrintedTransaction } from "./lib";

const sendPrinted = (from: JsonRpcSigner, tx: PrintedTransaction): Promise<TransactionReceipt> =>
  exec(from.sendTransaction({ to: tx.to, data: tx.data, value: tx.value }));

scenario("Scenario 19: the operations Safe: seed vault, keeper float, 0.05 PAXG reserve seed, fee exemption", async (sys, r) => {
  const configured = (process.env.OPERATIONS_SAFE ?? "").trim();
  assert(configured === "" || /^0x[0-9a-fA-F]{40}$/.test(configured), "OPERATIONS_SAFE is not an address");
  const ops: string = configured !== ""
    ? configured
    : await (await deploy("MockSafe", await wallet("s19-safe-deployer"), Array.from({ length: 3 }, () => Wallet.createRandom().address), 2)).getAddress();
  r.info("operations-safe", configured !== "" ? `OPERATIONS_SAFE ${ops}, by impersonation` : `OPERATIONS_SAFE is unset: a stand-in 2-of-3 MockSafe at ${ops}`);
  const proposer = await impersonate(sys.c.proposers[0]);
  const executor = await impersonate(sys.c.executors[0]);
  const opsSigner = await impersonate(ops);
  await setEth(ops, 10n * E18);
  const timelock = await at("ExpiringTimelockController", sys.a.timelock);
  const delay: bigint = await timelock.getMinDelay();
  const keeper = await actors.keeper();
  // The launch allocation of docs/MAINNET.md section 5 (project decision, 2026-11-26).
  const HELD = (70n * E18) / 100n;
  const DEPOSIT = (65n * E18) / 100n;
  const SEED = "0.05";
  const FLOAT = 1_100n * E18;
  const POSITION = 450n * E18;
  // One GSUSD above the two uses: the launch mint pays the 5 bps origination fee, under 1 GSUSD.
  const MINT = FLOAT + POSITION + E18;

  await r.check("seed-vault:the-operations-safe-mints-the-float-and-the-position-and-pays-the-origination-fee", async () => {
    const got = await fundPaxg(sys, ops, HELD);
    await exec((sys.paxg.connect(opsSigner) as Contract).approve(sys.a.vault, DEPOSIT));
    await exec((sys.vault.connect(opsSigner) as Contract).deposit(ADDR.PAXG, DEPOSIT));
    assert(!(await sys.vault.originationFeeExempt(ops)), "the launch mint is rehearsed before any exemption");
    const fee = (MINT * (await sys.vault.originationFeeBps())) / 10_000n;
    assert(fee > 0n && MINT - fee >= FLOAT + POSITION, `a ${g18(MINT, 0)} mint less its ${g18(fee, 6)} fee does not cover the float and the position`);
    const buffer0: bigint = await sys.buffer.gsusdBalance();
    const held0: bigint = await sys.gsusd.balanceOf(ops);
    await exec((sys.vault.connect(opsSigner) as Contract).mint(MINT));
    const received = (await sys.gsusd.balanceOf(ops)) - held0;
    assert(received === MINT - fee, `the Safe received ${g18(received, 6)} of a ${g18(MINT, 0)} mint with a ${g18(fee, 6)} fee`);
    assert((await sys.buffer.gsusdBalance()) - buffer0 === fee, "the buffer did not bank the origination fee");
    const k0: bigint = await sys.gsusd.balanceOf(keeper.address);
    await exec((sys.gsusd.connect(opsSigner) as Contract).transfer(keeper.address, FLOAT));
    assert((await sys.gsusd.balanceOf(keeper.address)) - k0 === FLOAT, "the keeper did not receive the float");
    assert((await sys.gsusd.balanceOf(ops)) - held0 >= POSITION, "the Safe does not hold the position's GSUSD");
    const ratio: bigint = await sys.vault.getCollateralisationRatio(ops);
    // Under 140% the day's gold price no longer carries this allocation with room to spare: resize it before launch.
    assert(ratio >= 1_400_000n, `the seed vault opens at ${(Number(ratio) / 10_000).toFixed(1)}%, under 140%: resize the launch allocation`);
    const minDebt: bigint = await sys.vault.minDebt();
    return `the operations Safe received ${g18(got, 2)} PAXG, deposited ${g18(DEPOSIT, 2)} and minted ${g18(MINT, 0)} GSUSD: ${g18(received, 4)} arrived and the ${g18(fee, 4)} GSUSD origination fee went to the buffer; ${g18(POSITION, 0)} kept for the GSUSD/USDC position; seed vault at ${(Number(ratio) / 10_000).toFixed(1)}%; the float sent to the keeper wallet ${keeper.address}; minDebt ${g18(minDebt, 0)}, so the float covers a full direct liquidation of a vault of up to about ${g18((FLOAT * 100n) / 101n, 0)} GSUSD of debt`;
  });
  await r.check("float:the-keeper-wallet-liquidates-a-minimum-debt-vault-from-the-float", async () => {
    const victim = await wallet("s19-victim");
    await exec((sys.paxg.connect(victim) as Contract).approve(sys.a.vault, MAX));
    const bp: bigint = await sys.oracle.quoteBorrowPrice(ADDR.PAXG);
    // The launch float covers one vault at the minimum debt with its accrued fee, and nothing larger.
    const debt: bigint = await sys.vault.minDebt();
    assert(debt + debt / 100n <= FLOAT, `the float ${FLOAT} does not cover a minimum-debt vault of ${debt} plus 1%`);
    const paxg = (debt * 1_305_000n * E8) / (bp * PPM);
    const got = await fundPaxg(sys, victim.address, paxg);
    await exec((sys.vault.connect(victim) as Contract).deposit(ADDR.PAXG, got));
    await exec((sys.vault.connect(victim) as Contract).mint(debt));
    const base = await market({});
    await market({ C: scale(base.C, 830_000n), G: scale(base.G, 830_000n) });
    await exec((sys.gsusd.connect(keeper) as Contract).approve(sys.a.vault, MAX));
    const k0: bigint = await sys.gsusd.balanceOf(keeper.address);
    const p0: bigint = await sys.paxg.balanceOf(keeper.address);
    const receipt = await exec((sys.vault.connect(keeper) as Contract).liquidate(victim.address, 0));
    const spent = k0 - (await sys.gsusd.balanceOf(keeper.address));
    const gold = (await sys.paxg.balanceOf(keeper.address)) - p0;
    assert((await sys.vault.getVaultCurrentDebt(victim.address)) === 0n, "the victim still has debt");
    assert(spent > 0n && spent <= FLOAT && gold > 0n, `spent ${spent}, received ${gold}`);
    await exec((sys.gsusd.connect(keeper) as Contract).approve(sys.a.vault, 0));
    await market({ C: base.C, G: base.G });
    return `a ${g18(debt, 0)} GSUSD vault at 130.5% fell under 110% on a gold-wide -17%; the keeper wallet liquidated it in full from the float (${receipt.gasUsed} gas): ${g18(spent, 2)} GSUSD spent, ${g18(gold, 4)} PAXG received, ${g18(FLOAT - spent, 2)} GSUSD of float left; prices restored`;
  });

  await r.check("reserve-seed:0.05-PAXG-printed-and-sent-by-the-operations-safe-then-one-swap", async () => {
    const empty = await expectRevert((sys.reserve.connect(keeper) as Contract).swapGsusdForGold.estimateGas(ADDR.PAXG, 10n * E18, 0));
    const run = runScript("scripts/print-reserve-seed.ts", { SEED_AMOUNT: SEED, SEED_FROM: ops });
    assert(run.code === 0, `the printer exited ${run.code}: ${run.out.slice(-400)}`);
    const txs = printedTransactions(run.out);
    const approve = txs.find((t) => /\(approve\):$/.test(t.title));
    const seed = txs.find((t) => /\(seedCollateral\):$/.test(t.title));
    assert(approve && seed && txs.length === 2, `printed titles: ${txs.map((t) => t.title).join(" | ")}`);
    const counted0: bigint = await sys.reserve.collateralBalance(ADDR.PAXG);
    await sendPrinted(opsSigner, approve);
    const sr = await sendPrinted(opsSigner, seed);
    const seedAmount = HELD - DEPOSIT;
    assert((await sys.reserve.collateralBalance(ADDR.PAXG)) - counted0 === seedAmount, "the reserve does not count the seed");
    const redeemable: bigint = await sys.reserve.redeemableCollateral(ADDR.PAXG);
    const capacity: bigint = await sys.reserve.remainingDailyCapacity(ADDR.PAXG);
    assert(capacity > 0n && capacity <= redeemable, `capacity ${capacity}, redeemable ${redeemable}`);
    // One swap sized inside the day's capacity, by the keeper wallet out of its float.
    // What a liquidation leaves of the float is under 100 GSUSD, so the swap is sized inside it.
    const gsusdIn = 50n * E18;
    const [goldOut, spreadPpm]: [bigint, bigint] = await sys.reserve.quoteGoldOut(ADDR.PAXG, gsusdIn);
    assert(goldOut > 0n && goldOut <= capacity, `quote ${goldOut} against capacity ${capacity}`);
    await exec((sys.gsusd.connect(keeper) as Contract).approve(sys.a.reserve, gsusdIn));
    const buffer0: bigint = await sys.buffer.gsusdBalance();
    const p0: bigint = await sys.paxg.balanceOf(keeper.address);
    const swap = await exec((sys.reserve.connect(keeper) as Contract).swapGsusdForGold(ADDR.PAXG, gsusdIn, goldOut));
    const got = (await sys.paxg.balanceOf(keeper.address)) - p0;
    const banked = (await sys.buffer.gsusdBalance()) - buffer0;
    assert(got === goldOut, `the swap paid ${got}, the quote said ${goldOut}`);
    assert(banked === (gsusdIn * spreadPpm) / PPM, `the buffer banked ${g18(banked, 6)}; the spread on ${g18(gsusdIn, 0)} is ${g18((gsusdIn * spreadPpm) / PPM, 6)}`);
    const capacityAfter: bigint = await sys.reserve.remainingDailyCapacity(ADDR.PAXG);
    assert(capacityAfter === capacity - got, `capacity ${capacity} -> ${capacityAfter} after ${got} left`);
    const big = ((capacityAfter + E18 / 100n) * (await sys.oracle.quoteReservePrice(ADDR.PAXG))) / E8;
    await exec((sys.gsusd.connect(keeper) as Contract).approve(sys.a.reserve, big * 2n));
    const over = await expectRevert((sys.reserve.connect(keeper) as Contract).swapGsusdForGold.estimateGas(ADDR.PAXG, big * 2n, 0));
    await exec((sys.gsusd.connect(keeper) as Contract).approve(sys.a.reserve, 0));
    const verify = runScript("scripts/verify-deployment.ts", { EXPECT_GOVERNANCE_TRANSFERRED: "1" });
    assert(verify.code === 0, `verify-deployment.ts after the seed exited ${verify.code}:\n${verify.out.slice(-1200)}`);
    identity(await ledger(sys));
    return `before the seed a swap is refused "${empty.slice(0, 40)}"; print-reserve-seed.ts SEED_AMOUNT=${SEED} printed an approve and a seedCollateral, sent unchanged from the operations Safe (${sr.gasUsed} gas): the reserve counts ${SEED} PAXG more, redeemable ${g18(redeemable, 4)}, remainingDailyCapacity ${g18(capacity, 4)}; quoteGoldOut(${g18(gsusdIn, 0)} GSUSD) = ${g18(goldOut, 6)} PAXG at ${Number(spreadPpm) / 10_000}%; the swap paid exactly the quote (${swap.gasUsed} gas) and the buffer banked ${g18(banked, 4)} GSUSD; capacity fell to ${g18(capacityAfter, 6)}; a swap sized over the remaining capacity is refused "${over.slice(0, 40)}"; verify-deployment.ts passes after the seed`;
  });

  await r.check("exemption:scheduled-the-same-day-executed-after-48h-and-a-later-mint-pays-no-fee", async () => {
    assert(!(await sys.vault.originationFeeExempt(ops)), "already exempt");
    const run = runScript("scripts/print-fee-exemption-proposal.ts", { EXEMPT_ACCOUNT: ops, EXEMPT_MEMO: "s19 rehearsal" });
    assert(run.code === 0, `the printer exited ${run.code}: ${run.out.slice(-400)}`);
    const txs = printedTransactions(run.out);
    const schedule = txs.find((t) => /^1\. Now: /.test(t.title));
    const execute = txs.find((t) => /^2\. Then: /.test(t.title));
    assert(schedule && execute, `printed titles: ${txs.map((t) => t.title).join(" | ")}`);
    const s = await sendPrinted(proposer, schedule);
    const early = await expectRevert(executor.sendTransaction({ to: execute.to, data: execute.data }), "TimelockUnexpectedOperationState");
    await advance(Number(delay) + 1);
    await restamp();
    const e = await sendPrinted(executor, execute);
    assert(await sys.vault.originationFeeExempt(ops), "not exempt after the execute");
    // A later mint, such as the one that deepens the position, then pays no fee.
    const bufferBefore: bigint = await sys.buffer.gsusdBalance();
    const heldBefore: bigint = await sys.gsusd.balanceOf(ops);
    await exec((sys.vault.connect(opsSigner) as Contract).mint(10n * E18));
    assert((await sys.gsusd.balanceOf(ops)) - heldBefore === 10n * E18 && (await sys.buffer.gsusdBalance()) === bufferBefore, "the exempt Safe paid a fee on a later mint");
    return `printed for the operations Safe ${ops}; schedule sent from the proposer Safe ${sys.c.proposers[0]} (${s.gasUsed} gas); the execute at once: "${early.slice(0, 40)}"; ${delay / 3600n} h later sent from the executor Safe ${sys.c.executors[0]} (${e.gasUsed} gas); originationFeeExempt(operations Safe) true, and a later 10 GSUSD mint arrived whole`;
  });
});
