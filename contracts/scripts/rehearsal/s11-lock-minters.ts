/**
 * Scenario 11, after the handover (scripts/transfer-governance.ts, then verify-deployment.ts with
 * EXPECT_GOVERNANCE_TRANSFERRED=1): the steady-state minter lock of docs/LAUNCH.md, scheduled by the
 * proposer Safe through the 48 hour timelock and executed by the executor Safe on the fork.
 * GoldStablecoin.lockMinters(vault) is one-way, so this proves its guards before the real call: a
 * MINTER_ROLE holder planted beside the vault blocks the lock ("MINTER_ROLE must have a sole
 * holder") until governance revokes it, and once locked no key, the timelock included, can grant
 * MINTER_ROLE again while the vault still mints. The operations whose execution reverted stay
 * pending, so they are left to expire after the timelock's grace period and then cancelled.
 *
 *   LOCAL_RPC_URL=http://127.0.0.1:8547 npx hardhat run --no-compile scripts/rehearsal/s11-lock-minters.ts --network localhost
 *
 * REHEARSAL_KEEP=1 keeps the locked state, so verify-deployment.ts can then run with
 * EXPECT_GOVERNANCE_TRANSFERRED=1 EXPECT_MINTERS_LOCKED=1.
 */
import { Contract, ZeroHash, id } from "ethers";
import type { ContractTransactionResponse } from "ethers";
import { E18, actors, advance, assert, at, exec, expectRevert, identity, impersonate, ledger, restamp, scenario, wallet } from "./lib";

const HOURS_48 = 48n * 3600n;

scenario("Scenario 11: the minter lock through the 48 h timelock", async (sys, r) => {
  const MINTER = id("MINTER_ROLE");
  const ADMIN = ZeroHash;
  const proposer = await impersonate(sys.c.proposers[0]);
  const executor = await impersonate(sys.c.executors[0]);
  const deployer = await impersonate(sys.snap.deployer);
  const keeper = await actors.keeper();
  const planted = (await wallet("s11-planted-minter")).address;
  const timelock = await at("ExpiringTimelockController", sys.a.timelock);
  const delay: bigint = await timelock.getMinDelay();
  const gsusd: string = sys.a.stablecoin;
  const vault: string = sys.a.vault;
  const call = (fn: string, args: unknown[]): string => sys.gsusd.interface.encodeFunctionData(fn, args);
  const lockData = call("lockMinters", [vault]);
  const opId = (data: string, salt: string): Promise<string> => timelock.hashOperation(gsusd, 0, data, ZeroHash, salt);
  const schedule = async (data: string, label: string): Promise<string> => {
    const salt = id(`s11-${label}`);
    await exec((timelock.connect(proposer) as Contract).schedule(gsusd, 0, data, ZeroHash, salt, delay));
    return salt;
  };
  const execute = (data: string, salt: string): Promise<ContractTransactionResponse> =>
    (timelock.connect(executor) as Contract).execute(gsusd, 0, data, ZeroHash, salt);
  const mature = async (): Promise<void> => {
    await advance(Number(delay) + 1);
    await restamp();
  };
  const minters = async (): Promise<string[]> => {
    const n: bigint = await sys.gsusd.getRoleMemberCount(MINTER);
    const holders: string[] = await Promise.all(Array.from({ length: Number(n) }, (_, i) => sys.gsusd.getRoleMember(MINTER, i)));
    return holders.map((h) => h.toLowerCase());
  };
  const onlyVault = async (): Promise<boolean> => {
    const m = await minters();
    return m.length === 1 && m[0] === vault.toLowerCase();
  };
  const reverted: Array<{ label: string; data: string; salt: string }> = [];

  await r.check("lock:governance-alone", async () => {
    assert(delay === HOURS_48, `timelock delay ${delay} s; this scenario rehearses the 48 h launch delay`);
    const admins: bigint = await sys.gsusd.getRoleMemberCount(ADMIN);
    assert(admins === 1n && (await sys.gsusd.getRoleMember(ADMIN, 0)).toLowerCase() === sys.a.timelock.toLowerCase(), "the timelock is not the stablecoin's sole admin");
    assert(await onlyVault(), `minters ${(await minters()).join(", ")}; expected the vault alone`);
    assert(!(await sys.gsusd.mintersLocked()), "minters already locked");
    const direct = await expectRevert((sys.gsusd.connect(deployer) as Contract).lockMinters(vault), "AccessControlUnauthorizedAccount");
    assert(direct.includes(ADMIN), `deployer lockMinters refused for another role: ${direct}`);
    const stranger = await expectRevert((timelock.connect(keeper) as Contract).schedule(gsusd, 0, lockData, ZeroHash, id("s11-stranger"), delay), "AccessControlUnauthorizedAccount");
    assert(stranger.includes(id("PROPOSER_ROLE")), `keeper schedule refused for another role: ${stranger}`);
    return `timelock sole admin (48 h delay), vault sole minter, unlocked; deployer lockMinters refused for DEFAULT_ADMIN_ROLE; keeper schedule refused for PROPOSER_ROLE`;
  });

  await r.check("lock:refused-while-a-planted-minter-holds-the-role", async () => {
    const grantData = call("grantRole", [MINTER, planted]);
    const plant = await schedule(grantData, "plant");
    const early = await schedule(lockData, "lock-early");
    await mature();
    await exec(execute(grantData, plant));
    assert((await minters()).includes(planted.toLowerCase()), "the planted key did not receive MINTER_ROLE");
    const refused = await expectRevert(execute(lockData, early), "MINTER_ROLE must have a sole holder");
    reverted.push({ label: "lock-early", data: lockData, salt: early });
    assert(!(await sys.gsusd.mintersLocked()), "locked with a second minter");
    return `planted ${planted.slice(0, 10)}… granted MINTER_ROLE through the timelock; lockMinters then refused: "${refused}"; still unlocked`;
  });

  await r.check("lock:executed-after-48h-once-the-planted-key-is-revoked", async () => {
    const revokeData = call("revokeRole", [MINTER, planted]);
    const revoke = await schedule(revokeData, "revoke");
    const lock = await schedule(lockData, "lock");
    await advance(Number(delay) - 3600);
    // The revocation would succeed if the timelock let it through, so its refusal is the delay's.
    const tooEarly = await expectRevert(execute(revokeData, revoke), "TimelockUnexpectedOperationState");
    assert(!(await timelock.isOperationReady(await opId(revokeData, revoke))), "the revocation is ready before 48 h");
    await advance(3_601);
    await restamp();
    await exec(execute(revokeData, revoke));
    const receipt = await exec(execute(lockData, lock));
    assert(await sys.gsusd.mintersLocked(), "mintersLocked() is false");
    assert(await onlyVault(), `minters ${(await minters()).join(", ")}; expected the vault alone`);
    return `47 h in: the revocation refused "${tooEarly.slice(0, 50)}…"; after 48 h the executor Safe revoked the planted key, then locked (block ${receipt.blockNumber}, ${receipt.gasUsed} gas); vault sole minter`;
  });

  await r.check("lock:no-key-can-grant-minter-again", async () => {
    const regrantData = call("grantRole", [MINTER, planted]);
    const regrant = await schedule(regrantData, "regrant");
    const relock = await schedule(lockData, "relock");
    await mature();
    const grant = await expectRevert(execute(regrantData, regrant), "Minters locked");
    const again = await expectRevert(execute(lockData, relock), "Already locked");
    reverted.push({ label: "regrant", data: regrantData, salt: regrant }, { label: "relock", data: lockData, salt: relock });
    assert(await onlyVault(), `minters ${(await minters()).join(", ")}; expected the vault alone`);
    return `timelock grantRole(MINTER_ROLE) after 48 h: "${grant}"; a second lock: "${again}"; vault sole minter`;
  });

  await r.check("timelock:reverted-operations-expire-then-are-cancelled", async () => {
    const grace: bigint = await timelock.GRACE_PERIOD();
    await advance(Number(grace) + 1);
    await restamp();
    const states: string[] = [];
    for (const op of reverted) {
      const opHash = await opId(op.data, op.salt);
      assert(await timelock.isOperationPending(opHash), `${op.label} is not pending`);
      assert(await timelock.isOperationExpired(opHash), `${op.label} has not expired ${grace} s after readiness`);
      await expectRevert(execute(op.data, op.salt), "TimelockOperationExpired");
      const stranger = await expectRevert((timelock.connect(keeper) as Contract).cancel(opHash), "AccessControlUnauthorizedAccount");
      assert(stranger.includes(id("CANCELLER_ROLE")), `keeper cancel refused for another role: ${stranger}`);
      await exec((timelock.connect(proposer) as Contract).cancel(opHash));
      assert(!(await timelock.isOperation(opHash)), `${op.label} still recorded after cancel`);
      states.push(op.label);
    }
    return `${states.join(", ")}: pending, expired ${Number(grace) / 86_400} days after readiness, execute refused "TimelockOperationExpired", keeper cancel refused for CANCELLER_ROLE, cancelled by the proposer Safe`;
  });

  await r.check("vault:still-mints-after-the-lock", async () => {
    const bank = await actors.bank();
    const amount = 1_000n * E18;
    const fee = (amount * BigInt(await sys.vault.originationFeeBps())) / 10_000n;
    const exempt: boolean = await sys.vault.originationFeeExempt(bank.address);
    const before: bigint = await sys.gsusd.balanceOf(bank.address);
    await exec((sys.vault.connect(bank) as Contract).mint(amount));
    const got: bigint = (await sys.gsusd.balanceOf(bank.address)) - before;
    assert(got === (exempt ? amount : amount - fee), `the mint delivered ${got}, expected ${exempt ? amount : amount - fee}`);
    identity(await ledger(sys));
    return `a 1,000 GSUSD mint delivered exactly ${Number(got / 10n ** 15n) / 1000} GSUSD (origination fee ${exempt ? "exempt" : `${Number(fee / 10n ** 15n) / 1000} GSUSD`}); identity holds`;
  });
});
