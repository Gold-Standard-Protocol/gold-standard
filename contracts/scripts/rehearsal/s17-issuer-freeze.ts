/**
 * Scenario 17: an issuer freeze against the REAL PAXG on the fork, by the account that holds
 * Paxos's ASSET_PROTECTION_ROLE on the token (impersonated), and what deposit, withdraw, repay,
 * mint and liquidation do in each case, held against docs/THREAT_MODEL.md (C1, C2 and L7).
 * Until now this was covered by unit and Foundry tests with a mock token only.
 *
 * PAXG's implementation since June 2026 exposes freeze(address), unfreeze(address) and
 * isFrozen(address) behind an AccessControl role, keccak256("ASSET_PROTECTION_ROLE"). The token
 * does not enumerate role members, so the holder is taken from the RoleGranted event of the
 * upgrade (block 25,232,808) and confirmed with hasRole on the fork; if it no longer holds the
 * role the logs are searched, and if nobody is found the scenario reports that and stops.
 *
 *   silo      the issuer freezes the silo a borrower's deposit landed in: deposits skip it, a
 *             withdrawal and both liquidation paths source the gold from the other silos, repay
 *             and mint are untouched, the frozen gold stays counted (C1)
 *   silos     every funded silo frozen: withdrawals and liquidations that need the frozen gold
 *             revert, repay stays open, a fresh deposit lands in a new silo and can leave (C2)
 *   vault     the vault's own address frozen: deposits stop, withdrawals leave straight from
 *             the silos, repay and mint are untouched, liquidation settles with the protocol's
 *             share ceded to the liquidator (L7)
 *
 *   LOCAL_RPC_URL=http://127.0.0.1:8547 npx hardhat run --no-compile scripts/rehearsal/s17-issuer-freeze.ts --network localhost
 */
import { Contract, id } from "ethers";
import type { JsonRpcSigner, TransactionReceipt, Wallet } from "ethers";
import {
  ADDR, E18, MAX, actors, assert, exec, expectRevert, fundPaxg, g18, identity, impersonate, ledger, market, openVault, provider,
  reason, rewind, scale, scenario, snapshot,
} from "./lib";
import type { System } from "./lib";

const PAXG_ABI = [
  "function freeze(address)",
  "function unfreeze(address)",
  "function isFrozen(address) view returns (bool)",
  "function hasRole(bytes32,address) view returns (bool)",
  "event RoleGranted(bytes32 indexed role, address indexed account, address indexed sender)",
];
const ROLE = id("ASSET_PROTECTION_ROLE");
/** Granted the role by the token itself in the June 2026 upgrade (block 25,232,808). */
const KNOWN_HOLDER = "0x3af3e85f4f97de7ad0f000b724fb77fe5ffc024b";
const UPGRADE_BLOCK = 25_232_808;
const FALL = 820_000n; // gold-wide -18%: a 131% vault falls under the 110% liquidation ratio

async function findFreezer(token: Contract): Promise<string | undefined> {
  if (await token.hasRole(ROLE, KNOWN_HOLDER)) return KNOWN_HOLDER;
  try {
    const logs = await provider.getLogs({ address: ADDR.PAXG, fromBlock: UPGRADE_BLOCK, toBlock: "latest", topics: [id("RoleGranted(bytes32,address,address)"), ROLE] });
    for (const log of logs.reverse()) {
      const account = `0x${log.topics[2].slice(26)}`;
      if (await token.hasRole(ROLE, account)) return account;
    }
  } catch {
    /* the fork's upstream may refuse a wide log query; nothing found then */
  }
  return undefined;
}

interface Silos { addresses: string[]; balances: bigint[]; cursor: number }
async function silos(sys: System): Promise<Silos> {
  const n = Number(await sys.silo.getSiloCount(ADDR.PAXG));
  const addresses: string[] = await Promise.all(Array.from({ length: n }, (_, i) => sys.silo.getSilo(ADDR.PAXG, i)));
  const balances: bigint[] = await Promise.all(addresses.map((a) => sys.paxg.balanceOf(a)));
  return { addresses, balances, cursor: Number(await sys.silo.currentSiloIndex(ADDR.PAXG)) };
}

interface Seizure { debtRepaid: bigint; seized: bigint; liquidatorPaxg: bigint; ceded: bigint; gasUsed: bigint }
async function seize(sys: System, by: Wallet, owner: string, mode: "direct" | "pool"): Promise<Seizure> {
  const before: bigint = await sys.paxg.balanceOf(by.address);
  const vault = sys.vault.connect(by) as Contract;
  const receipt: TransactionReceipt = await exec(mode === "pool" ? vault.liquidateViaPool(owner, 0) : vault.liquidate(owner, 0));
  let debtRepaid = 0n, seized = 0n, ceded = 0n;
  for (const log of receipt.logs) {
    try {
      const parsed = sys.vault.interface.parseLog(log);
      if (parsed && (parsed.name === "Liquidated" || parsed.name === "LiquidatedViaPool")) { debtRepaid = parsed.args[2]; seized = parsed.args[3]; }
      if (parsed?.name === "ProtocolShareCeded") ceded += parsed.args[1] as bigint;
    } catch {
      /* another contract's log */
    }
  }
  assert(seized > 0n, "no liquidation event");
  return { debtRepaid, seized, ceded, gasUsed: receipt.gasUsed, liquidatorPaxg: (await sys.paxg.balanceOf(by.address)) - before };
}

/** What an action did: "ok" or the refusal. */
async function outcome(p: Promise<unknown>): Promise<string> {
  try {
    await exec(p as never);
    return "ok";
  } catch (e) {
    return `refused "${reason(e).slice(0, 90)}"`;
  }
}

scenario("Scenario 17: issuer freeze of a silo, of every silo and of the vault, on the real PAXG", async (sys, r) => {
  const token = new Contract(ADDR.PAXG, PAXG_ABI, provider);
  const holder = await findFreezer(token);
  if (!holder) {
    r.info("skipped", `no account holding PAXG's ASSET_PROTECTION_ROLE (${ROLE}) was found on the fork: ${KNOWN_HOLDER} no longer holds it and the RoleGranted logs since block ${UPGRADE_BLOCK} name no current holder. Nothing was rehearsed.`);
    return;
  }
  const issuer: JsonRpcSigner = await impersonate(holder);
  const freeze = (who: string): Promise<TransactionReceipt> => exec((token.connect(issuer) as Contract).freeze(who));
  const bank = await actors.bank();
  const keeper = await actors.keeper();

  const borrower = (await openVault(sys, "s17-borrower", 20n * E18, 1_500_000n)).w;
  await exec((sys.paxg.connect(borrower) as Contract).approve(sys.a.vault, MAX));
  await fundPaxg(sys, borrower.address, 10n * E18);
  const victims = [
    (await openVault(sys, "s17-victim-direct", 10n * E18, 1_310_000n)).w,
    (await openVault(sys, "s17-victim-pool", 10n * E18, 1_310_000n)).w,
  ];
  const base = await market({});
  const crash = (): Promise<unknown> => market({ C: scale(base.C, FALL), G: scale(base.G, FALL) });
  let start = await snapshot();

  await r.check("issuer:the-asset-protection-role-holder-can-freeze-on-the-fork", async () => {
    assert(await token.hasRole(ROLE, holder), `${holder} does not hold the role`);
    const stranger = await expectRevert((token.connect(keeper) as Contract).freeze(sys.a.vault));
    const probe = keeper.address;
    await freeze(probe);
    assert(await token.isFrozen(probe), "isFrozen is false after freeze");
    const out = await expectRevert((sys.paxg.connect(await impersonate(ADDR.PAXG_HOLDER)) as Contract).transfer(probe, 1n));
    await exec((token.connect(issuer) as Contract).unfreeze(probe));
    assert(!(await token.isFrozen(probe)), "isFrozen is true after unfreeze");
    return `${holder} holds keccak256("ASSET_PROTECTION_ROLE") on the real PAXG (granted in the June 2026 upgrade); a freeze by the keeper: "${stranger.slice(0, 60)}"; freeze, isFrozen and unfreeze work; a transfer TO a frozen address: "${out.slice(0, 60)}"`;
  });

  await r.check("silo:one-frozen-silo-is-routed-around (C1)", async () => {
    const before = await silos(sys);
    const top = before.cursor;
    const frozen = before.addresses[top];
    assert(before.balances[top] > 0n, "the cursor silo is empty; the borrower's deposit is not there");
    const funded = before.balances.filter((b) => b > 0n).length;
    await freeze(frozen);
    assert(await token.isFrozen(frozen), "the silo is not frozen");
    const custody0: bigint = await sys.silo.totalCollateral(ADDR.PAXG);

    // deposit: the frozen silo refuses the transfer, the factory skips it and uses the next one
    const dep = await exec((sys.vault.connect(borrower) as Contract).deposit(ADDR.PAXG, 1n * E18));
    const skipped = dep.logs.map((l) => { try { return sys.silo.interface.parseLog(l); } catch { return null; } }).filter((e) => e?.name === "SiloSkipped").length;
    const afterDeposit = await silos(sys);
    assert(skipped === 1 && afterDeposit.cursor === top + 1, `${skipped} silos skipped, cursor ${top} -> ${afterDeposit.cursor}`);
    assert(afterDeposit.balances[top] === before.balances[top] && afterDeposit.balances[top + 1] === 1n * E18, "the deposit did not land in the next silo");

    // withdraw: more than the new silo holds, so the walk must pass over the frozen one
    const got0: bigint = await sys.paxg.balanceOf(borrower.address);
    await exec((sys.vault.connect(borrower) as Contract).withdraw(3n * E18));
    const afterWithdraw = await silos(sys);
    assert((await sys.paxg.balanceOf(borrower.address)) - got0 === 3n * E18, "the borrower did not receive 3 PAXG");
    assert(afterWithdraw.balances[top] === before.balances[top], "the frozen silo's balance moved");

    await exec((sys.vault.connect(borrower) as Contract).repay(100n * E18));
    await exec((sys.vault.connect(borrower) as Contract).mint(100n * E18));

    await crash();
    const direct = await seize(sys, bank, victims[0].address, "direct");
    const pool = await seize(sys, keeper, victims[1].address, "pool");
    const end = await silos(sys);
    assert(end.balances[top] === before.balances[top], "a liquidation moved the frozen silo's balance");
    assert(direct.ceded === 0n && pool.ceded === 0n, "the protocol share was ceded with the vault unfrozen");
    for (const v of victims) assert((await sys.vault.vaults(v.address))[2] === 0n, `victim ${v.address} still owes after a full liquidation`);
    const custody: bigint = await sys.silo.totalCollateral(ADDR.PAXG);
    const stuck = before.balances[top];
    const idLine = identity(await ledger(sys));
    return `silo ${top} of ${before.addresses.length} (${frozen}, ${g18(stuck, 4)} PAXG, ${funded} funded silos) frozen by the issuer. deposit 1 PAXG: ok, SiloSkipped once, landed in silo ${top + 1}; withdraw 3 PAXG: ok, taken from the other silos, the frozen balance untouched; repay 100 and mint 100: ok; after an 18% fall a direct liquidation seized ${g18(direct.seized, 4)} PAXG (${direct.gasUsed} gas) and a pool liquidation ${g18(pool.seized, 4)} PAXG (${pool.gasUsed} gas), both sourced from unfrozen silos; the frozen ${g18(stuck, 4)} PAXG stays counted in custody (${g18(custody0, 4)} -> ${g18(custody, 4)}), ${(Number((stuck * 10_000n) / custody) / 100).toFixed(1)}% of it; ${idLine.split(";")[0]}. Matches C1`;
  });

  start = await rewind(start);
  await r.check("silos:every-funded-silo-frozen-strands-what-needs-the-frozen-gold (C2)", async () => {
    const before = await silos(sys);
    const funded = before.addresses.filter((_, i) => before.balances[i] > 0n);
    for (const s of funded) await freeze(s);
    const state = async (who: string): Promise<string> => (await sys.vault.vaults(who)).map(String).join(":");

    const withdraw = await expectRevert((sys.vault.connect(borrower) as Contract).withdraw(1n * E18), "Withdrawal failed: insufficient unfrozen silo balance");
    const repay = await outcome((sys.vault.connect(borrower) as Contract).repay(100n * E18));
    const mint = await outcome((sys.vault.connect(borrower) as Contract).mint(100n * E18));
    assert(repay === "ok" && mint === "ok", `repay ${repay}, mint ${mint}`);

    // a fresh deposit skips the frozen cursor silo, lands in a new one and can leave again
    const dep = await exec((sys.vault.connect(borrower) as Contract).deposit(ADDR.PAXG, 2n * E18));
    const skipped = dep.logs.map((l) => { try { return sys.silo.interface.parseLog(l); } catch { return null; } }).filter((e) => e?.name === "SiloSkipped").length;
    await exec((sys.vault.connect(borrower) as Contract).withdraw(2n * E18));
    const more = await expectRevert((sys.vault.connect(borrower) as Contract).withdraw(1n), "Withdrawal failed: insufficient unfrozen silo balance");

    await crash();
    const v0 = await state(victims[0].address);
    const direct = await expectRevert((sys.vault.connect(bank) as Contract).liquidate(victims[0].address, 0));
    const pool = await expectRevert((sys.vault.connect(keeper) as Contract).liquidateViaPool(victims[1].address, 0));
    assert((await state(victims[0].address)) === v0, "a refused liquidation changed the victim's vault");
    assert(/insufficient unfrozen silo balance/.test(direct) && /insufficient unfrozen silo balance/.test(pool), `liquidations refused for another reason: direct "${direct}", pool "${pool}"`);
    const after = await silos(sys);
    for (const [i, a] of before.addresses.entries()) assert(after.balances[i] === before.balances[i], `silo ${i} (${a}) moved`);
    const idLine = identity(await ledger(sys));
    return `all ${funded.length} funded silos frozen (${g18(before.balances.reduce((x, y) => x + y, 0n), 2)} PAXG). withdraw 1 PAXG: "${withdraw}"; repay 100: ${repay}; mint 100: ${mint}; a fresh 2 PAXG deposit: ok (${skipped} frozen silo skipped, a new silo created) and withdrawn again, 1 wei more: "${more.slice(0, 40)}…"; after an 18% fall liquidate and liquidateViaPool of two vaults under 110%: both "${direct}", the vaults untouched, so they cannot be liquidated until the issuer releases the gold (C2: such vaults become bad debt if the price keeps falling); ${idLine.split(";")[0]}. Matches C2`;
  });

  start = await rewind(start);
  await r.check("vault:the-vault-address-frozen-deposits-stop-everything-else-settles (L7)", async () => {
    await freeze(sys.a.vault);
    assert(await token.isFrozen(sys.a.vault), "the vault is not frozen");
    const before = await silos(sys);
    const deposit = await expectRevert((sys.vault.connect(borrower) as Contract).deposit(ADDR.PAXG, 1n * E18));
    const got0: bigint = await sys.paxg.balanceOf(borrower.address);
    await exec((sys.vault.connect(borrower) as Contract).withdraw(1n * E18));
    assert((await sys.paxg.balanceOf(borrower.address)) - got0 === 1n * E18, "the borrower did not receive 1 PAXG");
    await exec((sys.vault.connect(borrower) as Contract).repay(100n * E18));
    await exec((sys.vault.connect(borrower) as Contract).mint(100n * E18));

    await crash();
    const reserve0: bigint = await sys.reserve.collateralBalance(ADDR.PAXG);
    const buffer0: bigint = await sys.paxg.balanceOf(sys.a.surplusBuffer);
    const poolPaxg0: bigint = await sys.paxg.balanceOf(sys.a.stabilityPool);
    const direct = await seize(sys, bank, victims[0].address, "direct");
    assert(direct.ceded > 0n, "no ProtocolShareCeded event with the vault frozen");
    assert(direct.liquidatorPaxg === direct.seized, `the liquidator received ${direct.liquidatorPaxg} of ${direct.seized} seized`);
    assert((await sys.reserve.collateralBalance(ADDR.PAXG)) === reserve0 && (await sys.paxg.balanceOf(sys.a.surplusBuffer)) === buffer0, "the reserve or the buffer received gold through a frozen vault");
    const pool = await seize(sys, keeper, victims[1].address, "pool");
    const poolGot = (await sys.paxg.balanceOf(sys.a.stabilityPool)) - poolPaxg0;
    assert(poolGot + pool.liquidatorPaxg === pool.seized, `pool path: seized ${pool.seized}, the pool received ${poolGot}, the caller ${pool.liquidatorPaxg}`);
    assert((await sys.paxg.balanceOf(sys.a.vault)) === 0n, "gold reached the frozen vault");
    const after = await silos(sys);
    assert(after.balances.reduce((x, y) => x + y, 0n) === before.balances.reduce((x, y) => x + y, 0n) - 1n * E18 - direct.seized - pool.seized, "custody does not account for the withdrawal and the two seizures");
    const idLine = identity(await ledger(sys));

    await exec((token.connect(issuer) as Contract).unfreeze(sys.a.vault));
    await exec((sys.vault.connect(borrower) as Contract).deposit(ADDR.PAXG, 1n * E18));
    return `the vault ${sys.a.vault} frozen by the issuer. deposit 1 PAXG: "${deposit.slice(0, 70)}"; withdraw 1 PAXG: ok, straight from a silo; repay 100 and mint 100: ok; after an 18% fall a direct liquidation settled (${direct.gasUsed} gas): ${g18(direct.seized, 4)} PAXG seized, all of it to the liquidator, of which ${g18(direct.ceded, 4)} PAXG is the protocol share ceded (ProtocolShareCeded), reserve and buffer unchanged; the pool path settled too (${pool.gasUsed} gas): ${g18(pool.seized, 4)} PAXG seized, ${g18(poolGot, 4)} to the stability pool, ${g18(pool.liquidatorPaxg, 4)} to the caller, ${g18(pool.ceded, 4)} ceded; nothing reached the vault; ${idLine.split(";")[0]}; after an unfreeze a deposit works again. Matches L7`;
  });
});
