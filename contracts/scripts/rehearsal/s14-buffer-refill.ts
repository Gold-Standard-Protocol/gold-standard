/**
 * Scenario 14, after the handover: bad debt the SurplusBuffer cannot absorb, the buffer refilled,
 * GoldVault.retryBadDebtAbsorption(), and the accounting identity (supply = principal + unabsorbed
 * bad debt) at every step.
 *
 * The buffer counts GSUSD only through SurplusBuffer.depositFee, which the vault alone may call:
 * the origination fee on a mint and the stability fee part of a repayment or liquidation. A plain
 * GSUSD transfer to the buffer is not counted and absorbs nothing. So "refill" here is fee income:
 *
 *   under     an underwater vault liquidated in full books bad debt under the breaker threshold;
 *             the buffer burns all it holds and the rest stays booked; a retry with an empty
 *             buffer and a retry after a plain GSUSD transfer both revert "Nothing absorbed";
 *             origination fees absorb part on retry; stability fees banked by a repayment two
 *             years on absorb the rest, and a further retry reverts "No bad debt"
 *   breaker   bad debt above the threshold pauses the vault (the bad-debt breaker); an unpause
 *             scheduled while bad debt is still above the threshold is voided when a second
 *             bad-debt liquidation re-asserts the pause ("Different pause"); repayments, which a
 *             pause leaves open, bank the fees that bring bad debt under the threshold on retry;
 *             only then is unpause(pauseEpoch) scheduled, and it lifts the pause 48 hours later
 *
 *   LOCAL_RPC_URL=http://127.0.0.1:8547 npx hardhat run --no-compile scripts/rehearsal/s14-buffer-refill.ts --network localhost
 */
import { Contract, ZeroHash, id } from "ethers";
import type { TransactionReceipt, Wallet } from "ethers";
import {
  ADDR, E18, PPM, actors, advance, assert, exec, expectRevert, g18, identity, impersonate, ledger, market, mintChunks, openVault,
  restamp, rewind, scale, scenario, snapshot, usd8,
} from "./lib";
import type { System } from "./lib";
import { collateralForBadDebt } from "../lib/rehearsalSizing";

const FALL = 720_000n; // gold-wide -28%
const YEAR = 365 * 86_400;

function events(sys: System, receipt: TransactionReceipt, name: string): bigint[] {
  return receipt.logs
    .map((log) => { try { return sys.vault.interface.parseLog(log); } catch { return null; } })
    .filter((e) => e?.name === name)
    .map((e) => e!.args[e!.args.length - 1] as bigint);
}

interface Books { badDebt: bigint; counted: bigint; held: bigint; supply: bigint }
async function books(sys: System): Promise<Books> {
  return {
    badDebt: await sys.vault.totalBadDebt(),
    counted: await sys.buffer.gsusdBalance(),
    held: await sys.gsusd.balanceOf(sys.a.surplusBuffer),
    supply: await sys.gsusd.totalSupply(),
  };
}

/** A full liquidation of an underwater vault by `liq`; returns the bad debt it booked and what the buffer absorbed. */
async function liquidateUnderwater(sys: System, liq: Wallet, owner: string, emergency = false): Promise<{ booked: bigint; absorbed: bigint; receipt: TransactionReceipt }> {
  const before = await books(sys);
  const vault = sys.vault.connect(liq) as Contract;
  const receipt = await exec(emergency ? vault.emergencyLiquidate(owner, 0) : vault.liquidate(owner, 0));
  const booked = events(sys, receipt, "BadDebt");
  assert(booked.length === 1, `${booked.length} BadDebt events`);
  const after = await books(sys);
  const absorbed = booked[0] - (after.badDebt - before.badDebt);
  assert(absorbed >= 0n && absorbed <= booked[0], `absorbed ${absorbed} of ${booked[0]}`);
  return { booked: booked[0], absorbed, receipt };
}

/** Retry and check the books move by exactly what the event reports. */
async function retry(sys: System, by: Wallet): Promise<bigint> {
  const before = await books(sys);
  const receipt = await exec((sys.vault.connect(by) as Contract).retryBadDebtAbsorption());
  const [absorbed] = events(sys, receipt, "BadDebtRetried");
  const after = await books(sys);
  assert(absorbed > 0n, "no BadDebtRetried event");
  assert(before.badDebt - after.badDebt === absorbed, `totalBadDebt fell ${before.badDebt - after.badDebt}, the event says ${absorbed}`);
  assert(before.counted - after.counted === absorbed && before.held - after.held === absorbed, "the buffer's balances did not fall by the absorbed amount");
  assert(before.supply - after.supply === absorbed, `supply fell ${before.supply - after.supply}, the event says ${absorbed}`);
  identity(await ledger(sys));
  return absorbed;
}

/** Let `years` pass and have the bank repay `amount`; returns the stability fee the repayment banked. */
async function bankFees(sys: System, bank: Wallet, years: number, amount: bigint): Promise<bigint> {
  await advance(years * YEAR);
  await restamp();
  const before: bigint = await sys.buffer.gsusdBalance();
  await exec((sys.vault.connect(bank) as Contract).repay(amount));
  return (await sys.buffer.gsusdBalance()) - before;
}

scenario("Scenario 14: bad debt beyond the buffer, refill by fees, retryBadDebtAbsorption", async (sys, r) => {
  const bank = await actors.bank();
  const keeper = await actors.keeper();
  const threshold: bigint = await sys.vault.badDebtPauseThreshold();
  const feeBps = BigInt(await sys.vault.originationFeeBps());
  assert(threshold > 0n && feeBps > 0n, "this scenario needs the bad-debt breaker and an origination fee");
  const base = await market({});
  const crash = (): Promise<unknown> => market({ C: scale(base.C, FALL), G: scale(base.G, FALL) });
  const recover = (): Promise<unknown> => market({ C: base.C, G: base.G });
  // At 131% and a 28% fall a vault is worth about 94.3% of its debt and a full liquidation
  // leaves about 7.6% of the debt as bad debt when C equals G, less when G sits above C.
  // Sized from the day's prices, so the breaker trips whatever gold costs and however far C
  // sits from G: the small vault books a fifth of the threshold beyond what the buffer holds,
  // the large one the threshold plus 6% beyond it.
  const sizing = {
    borrowPrice: (await sys.oracle.quoteBorrowPrice(ADDR.PAXG)) as bigint,
    settlementPrice: (await sys.oracle.quoteTokenPrice(ADDR.PAXG)) as bigint,
    fallPpm: FALL,
    ratioPpm: 1_310_000n,
    discountPpm: BigInt(await sys.vault.underwaterDiscountPpm()),
  };
  const second = await openVault(sys, "s14-second", 5n * E18, 1_310_000n);
  const counted0: bigint = await sys.buffer.gsusdBalance();
  const small = await openVault(sys, "s14-small", collateralForBadDebt({ ...sizing, badDebt: counted0 + threshold / 5n }), 1_310_000n);
  const large = await openVault(sys, "s14-large", collateralForBadDebt({ ...sizing, badDebt: counted0 + (threshold * 106n) / 100n }), 1_310_000n);
  r.info("sizing", `borrowing price ${usd8(sizing.borrowPrice)}, liquidation price ${usd8(sizing.settlementPrice)}, threshold ${g18(threshold, 0)} GSUSD, buffer ${g18(counted0, 2)} GSUSD: small vault ${g18(small.credited, 2)} PAXG, large vault ${g18(large.credited, 2)} PAXG, both at 131%`);
  let start = await snapshot();

  let outstanding = 0n;
  await r.check("under:bad-debt-beyond-the-buffer-stays-booked", async () => {
    const before = await books(sys);
    assert(before.badDebt === 0n, `bad debt ${before.badDebt} before the scenario`);
    assert(before.counted === before.held, `the buffer counts ${before.counted} and holds ${before.held}`);
    await crash();
    const { booked, absorbed, receipt } = await liquidateUnderwater(sys, bank, small.w.address);
    const after = await books(sys);
    outstanding = after.badDebt;
    assert(booked > before.counted, `bad debt ${g18(booked)} fits the buffer's ${g18(before.counted)}`);
    assert(after.counted === 0n && absorbed >= before.counted, `the buffer kept ${after.counted} with bad debt outstanding (absorbed ${absorbed}, held ${before.counted})`);
    assert(outstanding > 0n && outstanding < threshold, `outstanding ${g18(outstanding)} against a ${g18(threshold)} threshold`);
    assert(!(await sys.vault.paused()), "the breaker tripped under the threshold");
    assert(events(sys, receipt, "BadDebtAbsorptionFailed").length === 0, "the absorption call failed");
    const idLine = identity(await ledger(sys));
    return `a ${g18(small.minted, 0)} GSUSD vault liquidated in full after a 28% fall booked ${g18(booked, 2)} GSUSD of bad debt; the buffer held ${g18(before.counted, 2)} and burned ${g18(absorbed, 2)} (its liquidation fee income included), leaving it at 0; ${g18(outstanding, 2)} stays booked, under the ${g18(threshold, 0)} threshold, vault not paused; ${idLine.split(";")[0]}`;
  });

  await r.check("under:retry-with-an-empty-buffer-or-a-plain-transfer-absorbs-nothing", async () => {
    const empty = await expectRevert((sys.vault.connect(keeper) as Contract).retryBadDebtAbsorption(), "Nothing absorbed");
    const gift = outstanding + 1_000n * E18;
    await exec((sys.gsusd.connect(bank) as Contract).transfer(sys.a.surplusBuffer, gift));
    const b = await books(sys);
    assert(b.held === gift && b.counted === 0n, `after the transfer the buffer holds ${b.held} and counts ${b.counted}`);
    const gifted = await expectRevert((sys.vault.connect(keeper) as Contract).retryBadDebtAbsorption(), "Nothing absorbed");
    assert((await sys.vault.totalBadDebt()) === outstanding, "bad debt moved");
    const withdraw = await expectRevert((sys.buffer.connect(await impersonate(sys.a.timelock)) as Contract).withdrawGsusd(bank.address, gift), "Exceeds balance");
    identity(await ledger(sys));
    return `retry with the buffer at 0: "${empty}"; ${g18(gift, 2)} GSUSD sent to the buffer with a plain transfer: balanceOf ${g18(b.held, 2)}, gsusdBalance ${g18(b.counted, 2)}, retry "${gifted}", bad debt unchanged; the timelock's withdrawGsusd of it: "${withdraw}" (not counted, so not absorbable and not withdrawable); identity holds`;
  });

  // The plain transfer is a dead end; go on without it.
  start = await rewind(start);
  await crash();
  await liquidateUnderwater(sys, bank, small.w.address);
  outstanding = await sys.vault.totalBadDebt();
  await recover();

  await r.check("under:origination-fees-absorb-part-on-retry", async () => {
    const amount = 1_000_000n * E18;
    await mintChunks(sys, bank, amount);
    const fee = (amount * feeBps) / 10_000n;
    const counted: bigint = await sys.buffer.gsusdBalance();
    assert(counted === fee, `the buffer counts ${counted} after a mint whose fee is ${fee}`);
    assert(fee < outstanding, "the fee covers all the bad debt; nothing left for the next step");
    const absorbed = await retry(sys, keeper);
    assert(absorbed === fee, `retry absorbed ${absorbed}, the buffer held ${fee}`);
    const left: bigint = await sys.vault.totalBadDebt();
    assert(left === outstanding - fee, `bad debt ${left}, expected ${outstanding - fee}`);
    const again = await expectRevert((sys.vault.connect(keeper) as Contract).retryBadDebtAbsorption(), "Nothing absorbed");
    return `the bank minted 1,000,000 GSUSD: origination fee ${g18(fee, 2)} banked; the keeper's retry (permissionless) burned exactly that, bad debt ${g18(outstanding, 2)} -> ${g18(left, 2)}, supply down by the same; a second retry: "${again}"; identity holds`;
  });

  await r.check("under:stability-fees-absorb-the-rest-then-no-bad-debt", async () => {
    const left: bigint = await sys.vault.totalBadDebt();
    const banked = await bankFees(sys, bank, 2, 600_000n * E18);
    assert(banked > left, `the repayment banked ${g18(banked)} of fee, short of the ${g18(left)} outstanding`);
    const absorbed = await retry(sys, keeper);
    assert(absorbed === left && (await sys.vault.totalBadDebt()) === 0n, `retry absorbed ${absorbed} of ${left}`);
    const kept: bigint = await sys.buffer.gsusdBalance();
    assert(kept === banked - left, `the buffer keeps ${kept}, expected ${banked - left}`);
    const none = await expectRevert((sys.vault.connect(keeper) as Contract).retryBadDebtAbsorption(), "No bad debt");
    const idLine = identity(await ledger(sys));
    return `two years on (2% a year) a 600,000 GSUSD repayment by the bank banked ${g18(banked, 2)} of stability fee; retry burned the outstanding ${g18(left, 2)} and no more, totalBadDebt 0, the buffer keeps ${g18(kept, 2)}; a further retry: "${none}"; ${idLine.split(";")[0]}`;
  });

  start = await rewind(start);
  await r.check("breaker:above-the-threshold-the-vault-pauses-and-a-second-trip-voids-an-early-unpause", async () => {
    const proposer = await impersonate(sys.c.proposers[0]);
    const executor = await impersonate(sys.c.executors[0]);
    const delay: bigint = await sys.timelock.getMinDelay();
    const epoch0: bigint = await sys.vault.pauseEpoch();
    await crash();
    const first = await liquidateUnderwater(sys, bank, large.w.address);
    const afterFirst: bigint = await sys.vault.totalBadDebt();
    assert(afterFirst > threshold, `bad debt ${g18(afterFirst)} is under the ${g18(threshold)} threshold`);
    assert(await sys.vault.paused(), "the breaker did not pause the vault");
    const epoch1: bigint = await sys.vault.pauseEpoch();
    assert(epoch1 === epoch0 + 1n, `pause number ${epoch0} -> ${epoch1}`);
    const mint = await expectRevert((sys.vault.connect(bank) as Contract).mint(1_000n * E18), "EnforcedPause");

    // The mistake LAUNCH.md warns against: an unpause scheduled while bad debt is above the threshold.
    const early = sys.vault.interface.encodeFunctionData("unpause", [epoch1]);
    const earlySalt = id("s14-early-unpause");
    await exec((sys.timelock.connect(proposer) as Contract).schedule(sys.a.vault, 0, early, ZeroHash, earlySalt, delay));
    await advance(Number(delay) / 2);
    await crash();
    const trip = await liquidateUnderwater(sys, bank, second.w.address, true);
    const epoch2: bigint = await sys.vault.pauseEpoch();
    assert(epoch2 === epoch1 + 1n, `the second trip took number ${epoch2}, expected ${epoch1 + 1n}`);
    await advance(Number(delay) / 2 + 1);
    await crash();
    const voided = await expectRevert((sys.timelock.connect(executor) as Contract).execute(sys.a.vault, 0, early, ZeroHash, earlySalt), "Different pause");
    assert(await sys.vault.paused(), "the voided unpause lifted the pause");
    await exec((sys.timelock.connect(proposer) as Contract).cancel(await sys.timelock.hashOperation(sys.a.vault, 0, early, ZeroHash, earlySalt)));
    identity(await ledger(sys));
    return `a ${g18(large.minted, 0)} GSUSD vault liquidated in full booked ${g18(first.booked, 2)} GSUSD (buffer burned ${g18(first.absorbed, 2)}): totalBadDebt ${g18(afterFirst, 2)} above the ${g18(threshold, 0)} threshold, vault paused under number ${epoch1}, mint "${mint}"; unpause(${epoch1}) scheduled at once; 24 h in an emergencyLiquidate of a second underwater vault booked ${g18(trip.booked, 2)} more and the breaker re-asserted the pause as number ${epoch2}; after 48 h the unpause reverted "${voided}", cancelled by the proposer Safe; identity holds`;
  });

  await r.check("breaker:fees-from-repayments-bring-bad-debt-under-the-threshold-then-unpause", async () => {
    const proposer = await impersonate(sys.c.proposers[0]);
    const executor = await impersonate(sys.c.executors[0]);
    const delay: bigint = await sys.timelock.getMinDelay();
    await recover();
    const before: bigint = await sys.vault.totalBadDebt();
    // Paused: no mint, so no origination fee. A repayment is open and banks its stability fee.
    const float: bigint = await sys.gsusd.balanceOf(bank.address);
    const repay = float - 1_000n * E18;
    const banked = await bankFees(sys, bank, 2, repay);
    const absorbed = await retry(sys, keeper);
    const after: bigint = await sys.vault.totalBadDebt();
    assert(absorbed === banked && after === before - banked, `retry absorbed ${absorbed}, the repayment banked ${banked}`);
    assert(after > 0n && after < threshold, `bad debt ${g18(after)} against the ${g18(threshold)} threshold`);
    assert(await sys.vault.paused(), "the retry lifted the pause");
    // Under the threshold nothing re-asserts the pause; now the unpause, as an operation of its own.
    const epoch: bigint = await sys.vault.pauseEpoch();
    const data = sys.vault.interface.encodeFunctionData("unpause", [epoch]);
    const salt = id("s14-unpause");
    await exec((sys.timelock.connect(proposer) as Contract).schedule(sys.a.vault, 0, data, ZeroHash, salt, delay));
    await advance(Number(delay) + 1);
    await restamp();
    await exec((sys.timelock.connect(executor) as Contract).execute(sys.a.vault, 0, data, ZeroHash, salt));
    assert(!(await sys.vault.paused()), "still paused");
    await exec((sys.vault.connect(bank) as Contract).mint(1_000n * E18));
    const idLine = identity(await ledger(sys));
    const price: bigint = await sys.oracle.quoteBorrowPrice(ADDR.PAXG);
    return `vault paused, bad debt ${g18(before, 2)}: two years on the bank repaid ${g18(repay, 0)} GSUSD (repay is open in a pause), banking ${g18(banked, 2)} of stability fee; retry burned it, bad debt ${g18(after, 2)}, under the threshold, still paused; unpause(${epoch}) scheduled only then and executed 48 h later; a 1,000 GSUSD mint at ${usd8(price)} went through; ${g18(after, 2)} GSUSD of bad debt remains for later fee income (${(Number((after * PPM) / (await sys.gsusd.totalSupply())) / 10_000).toFixed(3)}% of supply); ${idLine.split(";")[0]}`;
  });

});
