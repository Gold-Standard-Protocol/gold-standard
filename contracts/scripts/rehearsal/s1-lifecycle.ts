/**
 * Scenario 1: a PAXG borrower's whole life on the real token and the real price paths, and XAUT
 * proven dormant. Borrowing prices at min(C, G) inside the band (variant C); 30 days of stability fee
 * accrue; a partial repayment retires principal pro rata and banks its fee; a full repayment
 * with an overshoot pulls only the debt; the withdrawal returns every credited unit. XAUT cannot
 * be deposited, seeded, swapped or priced. Runs inside a snapshot (scripts/rehearsal/lib.ts).
 *
 *   LOCAL_RPC_URL=http://127.0.0.1:8547 npx hardhat run --no-compile scripts/rehearsal/s1-lifecycle.ts --network localhost
 */
import { Contract } from "ethers";
import {
  ADDR, E18, E8, MAX, PPM, actors, advance, assert, colId, exec, expectRevert, fundPaxg, fundXaut, g18, identity,
  ledger, pokePool, quote, readFeed, restamp, scenario, showQuote, trader, usd8, variantC, wallet,
} from "./lib";

scenario("Scenario 1: PAXG borrow, repay in part and in full, withdraw; XAUT dormant", async (sys, r) => {
  const borrower = await wallet("s1-borrower");
  const vault = sys.vault.connect(borrower) as Contract;
  let credited = 0n, minted = 0n;

  await r.check("prices:variant-C-at-baseline", async () => {
    const [c, g] = await Promise.all([readFeed(ADDR.PAXG_USD), readFeed(ADDR.XAU_USD)]);
    const want = variantC(c.answer, g.answer);
    const [tok, bor, res, val] = await Promise.all([quote(sys, "token"), quote(sys, "borrow"), quote(sys, "reserve"), quote(sys, "valuation")]);
    assert(tok.price === want.liq && bor.price === want.borrow && res.price === want.reserve && val.price === want.valuation, `liquidation ${showQuote(tok)}, borrowing ${showQuote(bor)}, reserve ${showQuote(res)}, valuation ${showQuote(val)}`);
    return `C ${usd8(c.answer)}, G ${usd8(g.answer)}: liquidation ${usd8(tok.price)} = min(max(C, G), 1.02G); borrowing ${usd8(bor.price)} = min(C, G); reserve ${usd8(res.price)} = max(C, G); valuation ${usd8(val.price)} = min(C, G)`;
  });

  await r.check("borrow:deposit-mint-ratio-gate", async () => {
    const got = await fundPaxg(sys, borrower.address, 10n * E18);
    await exec((sys.paxg.connect(borrower) as Contract).approve(sys.a.vault, MAX));
    await exec(vault.deposit(ADDR.PAXG, got));
    credited = (await sys.vault.vaults(borrower.address))[1];
    const bp: bigint = await sys.oracle.quoteBorrowPrice(ADDR.PAXG);
    const max = (((credited * bp) / E8) * PPM) / 1_300_000n;
    const refusal = await expectRevert(vault.mint((max * 1_001n) / 1_000n), "Below min collateralisation ratio");
    minted = (max * 7n) / 10n;
    const supplyBefore: bigint = await sys.gsusd.totalSupply();
    await exec(vault.mint(minted));
    assert((await sys.gsusd.totalSupply()) - supplyBefore === minted, "supply did not rise by the mint");
    const lkp: bigint = await sys.oracle.getLastKnownPrice(ADDR.PAXG);
    const liq: bigint = await sys.oracle.quoteTokenPrice(ADDR.PAXG);
    assert(lkp === liq, `lastKnownPrice ${usd8(lkp)} is not the liquidation price ${usd8(liq)}`);
    return `deposited ${g18(credited)} PAXG (measured); max at 130% of ${usd8(bp)} is ${g18(max, 2)}; +0.1% refused ("${refusal}"); minted ${g18(minted, 2)} GSUSD; lastKnownPrice recorded as the liquidation price`;
  });

  await r.check("borrow:fee-accrues-30-days", async () => {
    await advance(30 * 86_400);
    await restamp();
    await pokePool(sys, await trader(sys));
    const debt: bigint = await sys.vault.getVaultCurrentDebt(borrower.address);
    const fee = debt - minted;
    const expected = (minted * 200n * 30n) / (10_000n * 365n);
    assert(fee > 0n && (fee > expected ? fee - expected : expected - fee) * 100n <= expected, `fee ${g18(fee)} vs about ${g18(expected)}`);
    return `debt ${g18(debt, 4)} after 30 days at 2% a year: fee ${g18(fee, 4)} GSUSD`;
  });

  await r.check("repay:partial-retires-principal-pro-rata-and-banks-fee", async () => {
    const before = await ledger(sys);
    const debt: bigint = await sys.vault.getVaultCurrentDebt(borrower.address);
    const principal: bigint = (await sys.vault.vaults(borrower.address))[2];
    const amount = (debt * 4n) / 10n;
    await exec((sys.gsusd.connect(borrower) as Contract).approve(sys.a.vault, MAX));
    await exec(vault.repay(amount));
    const after = await ledger(sys);
    const principalAfter: bigint = (await sys.vault.vaults(borrower.address))[2];
    const retired = principal - principalAfter;
    // the debt grew by one block of fee before the repayment landed: allow one part in a million
    const expected = (principal * amount) / debt;
    assert((retired > expected ? retired - expected : expected - retired) * PPM <= expected, `retired ${retired}, expected about ${expected}`);
    assert(before.supply - after.supply === retired, "supply fell by more or less than the principal retired");
    assert(after.bufferGsusd - before.bufferGsusd === amount - retired, "the buffer did not bank the fee portion");
    identity(after);
    return `repaid ${g18(amount, 4)}: principal -${g18(retired, 4)} (burned), fee ${g18(amount - retired, 6)} banked in the buffer; identity holds`;
  });

  await r.check("repay:full-with-overshoot-pulls-only-the-debt", async () => {
    const bank = await actors.bank();
    await exec((sys.gsusd.connect(bank) as Contract).transfer(borrower.address, 100n * E18));
    const before = await ledger(sys);
    const balBefore: bigint = await sys.gsusd.balanceOf(borrower.address);
    const debt: bigint = await sys.vault.getVaultCurrentDebt(borrower.address);
    const principal: bigint = (await sys.vault.vaults(borrower.address))[2];
    await exec(vault.repay(debt + 50n * E18));
    const paid = balBefore - (await sys.gsusd.balanceOf(borrower.address));
    const after = await ledger(sys);
    const v = await sys.vault.vaults(borrower.address);
    assert(v[2] === 0n && (await sys.vault.getVaultCurrentDebt(borrower.address)) === 0n, "debt left");
    assert(paid >= debt && paid - debt < E18 / 100n, `paid ${g18(paid)} for a debt of ${g18(debt)}`);
    assert(after.bufferGsusd - before.bufferGsusd === paid - principal, "fee not banked");
    identity(after);
    return `asked to repay debt + 50; ${g18(paid, 6)} pulled (debt ${g18(debt, 6)} plus one block of fee), fee ${g18(paid - principal, 6)} banked`;
  });

  await r.check("withdraw:every-credited-unit-returns", async () => {
    const before: bigint = await sys.paxg.balanceOf(borrower.address);
    await exec(vault.withdraw(credited));
    const back = (await sys.paxg.balanceOf(borrower.address)) - before;
    const v = await sys.vault.vaults(borrower.address);
    assert(v[1] === 0n && v[0] === "0x0000000000000000000000000000000000000000", "vault not released");
    assert(!(await sys.registry.isVaultOwner(borrower.address)), "registry still lists the owner");
    assert(back === credited, `returned ${g18(back)} of ${g18(credited)}`);
    return `${g18(back)} PAXG returned; vault released and delisted from the registry`;
  });

  await r.check("xaut:dormant-everywhere", async () => {
    const holder = await wallet("s1-xaut");
    const got = await fundXaut(sys, holder.address, 10_000_000n);
    await exec((sys.xaut.connect(holder) as Contract).approve(sys.a.vault, MAX));
    await exec((sys.xaut.connect(holder) as Contract).approve(sys.a.reserve, MAX));
    const dep = await expectRevert((sys.vault.connect(holder) as Contract).deposit(ADDR.XAUT, got), "Collateral type not active");
    const seed = await expectRevert((sys.reserve.connect(holder) as Contract).seedCollateral(ADDR.XAUT, got), "Unsupported token");
    const bank = await actors.bank();
    await exec((sys.gsusd.connect(bank) as Contract).approve(sys.a.reserve, MAX));
    const swap = await expectRevert((sys.reserve.connect(bank) as Contract).swapGsusdForGold(ADDR.XAUT, 1_000n * E18, 0), "Unsupported token");
    const listing = await expectRevert((sys.reserve.connect(holder) as Contract).setAssetConfig(ADDR.XAUT, true, 0, 200_000));
    const price = await quote(sys, "token", ADDR.XAUT);
    const [cfg, isPool, confirm, ct] = await Promise.all([
      sys.reserve.assets(ADDR.XAUT), sys.pool.isCollateralToken(ADDR.XAUT), Promise.resolve("0x0000000000000000000000000000000000000000"), sys.vault.collateralTypes(colId(ADDR.XAUT)),
    ]);
    assert(!cfg.supported && !isPool && !ct.active && confirm === "0x0000000000000000000000000000000000000000", "XAUT is configured somewhere");
    assert(!price.ok, `the oracle prices XAUT at ${usd8(price.price)}`);
    assert((await sys.xaut.balanceOf(holder.address)) === got, "XAUT left the holder");
    return `deposit "${dep}"; seed "${seed}"; swap "${swap}"; listing by a non-governor "${listing.slice(0, 60)}"; oracle "${price.why}"; not a pool token, no collateral type`;
  });

  await r.check("accounting:identity-at-end", async () => identity(await ledger(sys)));
});
