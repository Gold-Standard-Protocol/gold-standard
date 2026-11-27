/**
 * Scenario 18, before or after the handover: the stability pool's claim block rule, the
 * principal-first write-off of an underwater vault and the silo gap a governed cursor move leaves.
 *
 *   pool      a deposit, a claimCollateral and a withdraw from one wallet in one block: the
 *             deposit lands, the claim reverts "No same-block claim" and the withdrawal
 *             "No same-block withdrawal"; one block later both are open again
 *   wiring    governance cannot point the vault at a pool that does not declare the prefunded
 *             absorb path (absorbsPrefunded): the deployer's call reverts before the handover,
 *             and after it the scheduled proposal reverts when the executor Safe runs it
 *   seizure   an underwater vault carrying half a year of stability fee, liquidated in full:
 *             the payment retires principal first, the bad debt booked is the principal the
 *             payment did not cover, the accrued fee is not booked and no fee is banked
 *   silos     governance moves the PAXG deposit cursor (SiloFactory.setCurrentSiloIndex):
 *             missingSilos reports the gap, verify-deployment.ts fails
 *             ops:siloFactory.PAXG.no-silo-gap, anyone closes it with createSilos in batches
 *             of at most 16, a deposit works again and the verifier passes
 *
 *   LOCAL_RPC_URL=http://127.0.0.1:8547 npx hardhat run --no-compile scripts/rehearsal/s18-claim-seizure-silo-gap.ts --network localhost
 */
import { Contract, ZeroHash, id, toBeHex, zeroPadValue } from "ethers";
import type { TransactionReceipt, Wallet } from "ethers";
import {
  ADDR, E18, E8, MAX, PPM, YEAR_SECONDS, advance, assert, at, delta, deploy, exec, expectRevert, fundPaxg, g18, govern, identity,
  impersonate, ledger, market, mintChunks, provider, quote, restamp, runScript, scale, scenario, send, usd8, wallet,
} from "./lib";
import type { System } from "./lib";

async function openVault(sys: System, w: Wallet, paxg: bigint, ratioPpm: bigint): Promise<bigint> {
  await exec((sys.paxg.connect(w) as Contract).approve(sys.a.vault, MAX));
  const got = await fundPaxg(sys, w.address, paxg);
  await exec((sys.vault.connect(w) as Contract).deposit(ADDR.PAXG, got));
  const bp: bigint = await sys.oracle.quoteBorrowPrice(ADDR.PAXG);
  const amount = (((got * bp) / E8) * PPM) / ratioPpm;
  await mintChunks(sys, w, amount);
  return amount;
}

scenario("Scenario 18: pool claim block rule, pool wiring rule, principal-first write-off, silo gap", async (sys, r) => {
  await r.check("pool:deposit-and-claim-in-one-block-the-claim-is-refused", async () => {
    const w = await wallet("s18-depositor");
    await openVault(sys, w, 10n * E18, 2_000_000n);
    await exec((sys.gsusd.connect(w) as Contract).approve(sys.a.stabilityPool, MAX));
    const pool = sys.pool.connect(w) as Contract;
    const nonce = await provider.getTransactionCount(w.address, "latest");
    await send("evm_setAutomine", [false]);
    let dep, claim, wd;
    let pendingWhy = "";
    try {
      dep = await pool.deposit(1_000n * E18, { gasLimit: 1_500_000, nonce });
      // The estimate runs against the pending block, which holds the deposit.
      pendingWhy = await expectRevert(pool.claimCollateral.estimateGas(ADDR.PAXG), "No same-block claim");
      claim = await pool.claimCollateral(ADDR.PAXG, { gasLimit: 600_000, nonce: nonce + 1 });
      wd = await pool.withdraw(1n * E18, { gasLimit: 600_000, nonce: nonce + 2 });
      await send("evm_mine", []);
    } finally {
      await send("evm_setAutomine", [true]);
    }
    const [rd, rc, rw] = await Promise.all([dep, claim, wd].map((t) => provider.getTransactionReceipt(t!.hash)));
    assert(rd && rc && rw, "a transaction was not mined");
    assert(rd.blockNumber === rc.blockNumber && rd.blockNumber === rw.blockNumber, `blocks ${rd.blockNumber}, ${rc.blockNumber}, ${rw.blockNumber}`);
    assert(rd.status === 1, "the deposit failed");
    assert(rc.status === 0, "the claim in the deposit's block succeeded");
    assert(rw.status === 0, "the withdrawal in the deposit's block succeeded");
    assert((await sys.pool.lastDepositBlock(w.address)) === BigInt(rd.blockNumber), "lastDepositBlock is not the deposit's block");
    const next = await expectRevert(pool.claimCollateral.estimateGas(ADDR.PAXG), "No gains");
    await exec(pool.withdraw(1n * E18));
    return `deposit, claimCollateral and withdraw from one wallet mined in block ${rd.blockNumber}: deposit status 1, claim status 0, withdraw status 0; the claim simulated on the pending block: "${pendingWhy}"; one block later the claim is refused only with "${next}" and a withdrawal succeeds`;
  });

  await r.check("pool:governance-cannot-wire-a-pool-without-the-prefunded-declaration", async () => {
    const maker = await wallet("s18-pool-maker");
    const silent = await (await deploy("MockPoolWithoutPrefundedAbsorb", maker)).getAddress();
    const denying = await (await deploy("MockPoolDenyingPrefundedAbsorb", maker)).getAddress();
    const wired: string = await sys.vault.stabilityPool();
    assert(await sys.pool.absorbsPrefunded(), "the wired pool does not declare the prefunded path");
    const call = (pool: string): string => sys.vault.interface.encodeFunctionData("setStabilityPool", [pool]);
    if (await sys.vault.hasRole(id("GOVERNANCE_ROLE"), sys.snap.deployer)) {
      const d = await impersonate(sys.snap.deployer);
      const a = await expectRevert(d.sendTransaction({ to: sys.a.vault, data: call(silent) }));
      const b = await expectRevert(d.sendTransaction({ to: sys.a.vault, data: call(denying) }), "PoolLacksPrefundedAbsorb");
      assert((await sys.vault.stabilityPool()) === wired, "the vault's pool changed");
      return `the wired pool answers absorbsPrefunded() true; before the handover the deployer's setStabilityPool to a pool with no declaration reverts ("${a.slice(0, 60)}") and to one that answers false reverts "${b}"; the vault keeps its pool`;
    }
    const governance = await at("GoldGovernance", sys.a.governance);
    const proposer = await impersonate(sys.c.proposers[0]);
    const executor = await impersonate(sys.c.executors[0]);
    const delay: bigint = await sys.timelock.getMinDelay();
    const nonce: bigint = await governance.proposalNonce();
    const salt = (n: bigint): string => zeroPadValue(toBeHex(n), 32);
    await exec((governance.connect(proposer) as Contract).proposeStabilityPoolUpdate(silent));
    await exec((governance.connect(proposer) as Contract).proposeStabilityPoolUpdate(denying));
    await advance(Number(delay) + 1);
    await restamp();
    const a = await expectRevert((governance.connect(executor) as Contract).executeProposal(sys.a.vault, call(silent), salt(nonce)));
    const b = await expectRevert((governance.connect(executor) as Contract).executeProposal(sys.a.vault, call(denying), salt(nonce + 1n)), "PoolLacksPrefundedAbsorb");
    assert((await sys.vault.stabilityPool()) === wired, "the vault's pool changed");
    // A proposal that cannot execute stays in the queue until it expires: the proposer Safe cancels it.
    for (const [pool, n] of [[silent, nonce], [denying, nonce + 1n]] as const) {
      await exec((sys.timelock.connect(proposer) as Contract).cancel(await sys.timelock.hashOperation(sys.a.vault, 0, call(pool), ZeroHash, salt(n))));
    }
    return `the wired pool answers absorbsPrefunded() true; the proposer Safe scheduled proposeStabilityPoolUpdate for a pool with no declaration and for one that answers false; ${delay / 3600n} h later the executor Safe's executeProposal reverts for the first ("${a.slice(0, 60)}") and with "${b}" for the second; the vault keeps its pool and the proposer Safe cancelled both operations`;
  });

  await r.check("seizure:underwater-vault-with-accrued-fee-retires-principal-first", async () => {
    const b = await wallet("s18-borrower");
    await openVault(sys, b, 10n * E18, 1_310_000n);
    await advance(YEAR_SECONDS / 2);
    await restamp();
    const base = await market({});
    await market({ C: scale(base.C, 720_000n), G: scale(base.G, 720_000n) });
    const price = (await quote(sys, "token")).price;
    const liq = await wallet("s18-liquidator");
    await openVault(sys, liq, 60n * E18, 2_000_000n);
    await exec((sys.gsusd.connect(liq) as Contract).approve(sys.a.vault, MAX));
    const v0 = await sys.vault.vaults(b.address);
    const principal0: bigint = v0[2];
    const debt0: bigint = await sys.vault.getVaultCurrentDebt(b.address);
    const value = (v0[1] * price) / E8;
    assert(debt0 > principal0, "no fee accrued");
    assert(value < principal0, `the vault is not under water against its principal: value ${g18(value, 2)}, principal ${g18(principal0, 2)}`);
    const before = await ledger(sys);
    const bad0: bigint = await sys.vault.totalBadDebt();
    const buffer0: bigint = await sys.buffer.gsusdBalance();
    const held0: bigint = await sys.gsusd.balanceOf(liq.address);
    const receipt: TransactionReceipt = await exec((sys.vault.connect(liq) as Contract).liquidate(b.address, 0));
    const paid = held0 - (await sys.gsusd.balanceOf(liq.address));
    const events = receipt.logs.map((log) => { try { return sys.vault.interface.parseLog(log); } catch { return null; } }).filter((e) => e?.name === "BadDebt").map((e) => e!.args[1] as bigint);
    assert(events.length === 1, `${events.length} BadDebt events`);
    const after = await ledger(sys);
    const d = delta(before, after);
    const v1 = await sys.vault.vaults(b.address);
    assert(v1[1] === 0n && v1[2] === 0n, "vault not cleared");
    assert(paid < principal0, `the payment ${g18(paid, 4)} covers the principal ${g18(principal0, 4)}`);
    assert(events[0] === principal0 - paid, `bad debt booked ${g18(events[0], 6)}; principal ${g18(principal0, 6)} less the payment ${g18(paid, 6)} is ${g18(principal0 - paid, 6)}`);
    const absorbed = events[0] - ((await sys.vault.totalBadDebt()) - bad0);
    const banked = (await sys.buffer.gsusdBalance()) - buffer0 + absorbed;
    assert(banked === 0n, `the buffer banked ${g18(banked, 6)} GSUSD of fee from an underwater liquidation`);
    assert(-d.supply === paid + absorbed, `supply fell by ${g18(-d.supply, 6)}; payment ${g18(paid, 6)} plus absorbed ${g18(absorbed, 6)}`);
    identity(after);
    return `10 PAXG vault, principal ${g18(principal0, 2)} GSUSD, debt with half a year of fee ${g18(debt0, 2)} (fee ${g18(debt0 - principal0, 2)}); gold-wide -28%, liquidation price ${usd8(price)}, collateral worth ${g18(value, 2)}; full liquidation paid ${g18(paid, 2)} GSUSD, all of it burned as principal; BadDebt ${g18(events[0], 2)} = principal less the payment exactly; the accrued fee is not booked as bad debt and no fee was banked; the buffer absorbed ${g18(absorbed, 2)}; supply = principal + bad debt holds`;
  });

  await r.check("silos:cursor-move-leaves-a-gap-verifier-fails-createSilos-closes-it-deposit-works", async () => {
    await market({});
    const handedOver = !(await sys.vault.hasRole(id("GOVERNANCE_ROLE"), sys.snap.deployer));
    const venv = { VERIFY_VERBOSE: "1", ...(handedOver ? { EXPECT_GOVERNANCE_TRANSFERRED: "1" } : {}) };
    const stranger = await wallet("s18-stranger");
    const factory = sys.silo;
    const cur: bigint = await factory.currentSiloIndex(ADDR.PAXG);
    assert((await factory.missingSilos(ADDR.PAXG)) === 0n, "a gap exists before the move");
    const nothing = await expectRevert((factory.connect(stranger) as Contract).createSilos(ADDR.PAXG, 1), "Nothing to create");
    const v0 = runScript("scripts/verify-deployment.ts", venv);
    const gapLine = (out: string) => (out.split("\n").find((l) => l.includes("ops:siloFactory.PAXG.no-silo-gap")) ?? "").trim();
    const moved = cur + 40n;
    const how = await govern(sys, "s18-cursor-move", [{ to: sys.a.siloFactory, data: factory.interface.encodeFunctionData("setCurrentSiloIndex", [ADDR.PAXG, moved]) }]);
    const gap: bigint = await factory.missingSilos(ADDR.PAXG);
    assert(gap > 0n, "missingSilos reads 0 after the move");
    const v1 = runScript("scripts/verify-deployment.ts", venv);
    assert(v1.code !== 0 && /✗ ops:siloFactory\.PAXG\.no-silo-gap/.test(v1.out), `verify-deployment.ts with the gap open exited ${v1.code}: ${gapLine(v1.out)}`);
    const tooMany = await expectRevert((factory.connect(stranger) as Contract).createSilos(ADDR.PAXG, 17), "Invalid count");
    let batches = 0, gasMax = 0n;
    for (let left: bigint = gap; left > 0n; left = await factory.missingSilos(ADDR.PAXG)) {
      const receipt = await exec((factory.connect(stranger) as Contract).createSilos(ADDR.PAXG, left > 16n ? 16n : left));
      if (receipt.gasUsed > gasMax) gasMax = receipt.gasUsed;
      batches++;
    }
    const again = await expectRevert((factory.connect(stranger) as Contract).createSilos(ADDR.PAXG, 1), "Nothing to create");
    const depositor = await wallet("s18-after-gap");
    const custody0: bigint = await factory.totalCollateral(ADDR.PAXG);
    await exec((sys.paxg.connect(depositor) as Contract).approve(sys.a.vault, MAX));
    const got = await fundPaxg(sys, depositor.address, 2n * E18);
    const dep = await exec((sys.vault.connect(depositor) as Contract).deposit(ADDR.PAXG, got));
    assert((await factory.totalCollateral(ADDR.PAXG)) - custody0 === got, "custody did not rise by the deposit");
    await exec((sys.vault.connect(depositor) as Contract).withdraw(got));
    const v2 = runScript("scripts/verify-deployment.ts", venv);
    assert(/✓ ops:siloFactory\.PAXG\.no-silo-gap/.test(v2.out), `after createSilos the gap check reads: ${gapLine(v2.out)}`);
    return `before the move: missingSilos 0, createSilos "${nothing}", verifier line "${gapLine(v0.out)}" (exit ${v0.code}); setCurrentSiloIndex(PAXG, ${cur} -> ${moved}): ${how}; missingSilos ${gap}; verify-deployment.ts exits ${v1.code} with "${gapLine(v1.out).slice(0, 160)}"; createSilos(17) "${tooMany}"; an unprivileged wallet closed the gap in ${batches} batches of at most 16 (largest ${gasMax} gas); createSilos again "${again}"; a 2 PAXG deposit then landed (${dep.gasUsed} gas) and was withdrawn; verifier line "${gapLine(v2.out)}" (exit ${v2.code})`;
  });
});
