import { expect } from "chai";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  assertChainMatches,
  HARDHAT_CHAIN_ID,
  loadSnapshot,
  parseGsusd,
  resolveSnapshotName,
} from "../scripts/lib/deploymentContext";
import { parseWithdrawalEnv, refusedRecipients, summarise } from "../scripts/lib/withdrawSurplusCli";
import type { WithdrawalOutcome, WithdrawalStep } from "../scripts/lib/surplusWithdrawal";

/** The pure parts of scripts/withdraw-surplus.ts: what it accepts and what it refuses. */
describe("withdraw-surplus CLI helpers", function () {
  const SAFE = "0x5afe5afE5afE5afE5afE5aFe5aFe5Afe5Afe5AfE";
  const valid = { WITHDRAW_TO: SAFE, WITHDRAW_GSUSD: "2500.5", WITHDRAW_MEMO: "2026-Q4 infrastructure" };

  describe("parseWithdrawalEnv", function () {
    it("parses a complete environment with the safe defaults", function () {
      const env = parseWithdrawalEnv(valid);
      expect(env.to).to.equal(SAFE);
      expect(env.amount).to.equal(2500_500000000000000000n);
      expect(env.memo).to.equal("2026-Q4 infrastructure");
      expect(env.confirm).to.equal(false);
      expect(env.allowEoaRecipient).to.equal(false);
      expect(env.forkOf).to.equal(undefined);
      expect(env.impersonate).to.equal(undefined);
    });

    it("reads the flags only from their exact values", function () {
      expect(parseWithdrawalEnv({ ...valid, CONFIRM: "YES", WITHDRAW_TO_EOA: "YES" })).to.include({
        confirm: true,
        allowEoaRecipient: true,
      });
      expect(parseWithdrawalEnv({ ...valid, CONFIRM: "yes", WITHDRAW_TO_EOA: "true" })).to.include({
        confirm: false,
        allowEoaRecipient: false,
      });
    });

    it("checksums and trims the recipient", function () {
      expect(parseWithdrawalEnv({ ...valid, WITHDRAW_TO: ` ${SAFE.toLowerCase()} ` }).to).to.equal(SAFE);
    });

    it("refuses a missing or malformed recipient", function () {
      expect(() => parseWithdrawalEnv({ ...valid, WITHDRAW_TO: undefined })).to.throw(/Set WITHDRAW_TO/);
      expect(() => parseWithdrawalEnv({ ...valid, WITHDRAW_TO: "0x1234" })).to.throw(/not a valid address/);
      expect(() => parseWithdrawalEnv({ ...valid, WITHDRAW_TO: SAFE.replace("5afE", "5afe") })).to.throw(
        /not a valid address/
      );
    });

    it("refuses a missing, non-decimal or non-positive amount", function () {
      expect(() => parseWithdrawalEnv({ ...valid, WITHDRAW_GSUSD: undefined })).to.throw(/Set WITHDRAW_GSUSD/);
      expect(() => parseWithdrawalEnv({ ...valid, WITHDRAW_GSUSD: "2,500" })).to.throw(/not a decimal/);
      expect(() => parseWithdrawalEnv({ ...valid, WITHDRAW_GSUSD: "1e3" })).to.throw(/not a decimal/);
      expect(() => parseWithdrawalEnv({ ...valid, WITHDRAW_GSUSD: "0" })).to.throw(/must be positive/);
      expect(() => parseWithdrawalEnv({ ...valid, WITHDRAW_GSUSD: "-5" })).to.throw(/must be positive/);
    });

    it("requires a non-blank memo", function () {
      expect(() => parseWithdrawalEnv({ ...valid, WITHDRAW_MEMO: undefined })).to.throw(/Set WITHDRAW_MEMO/);
      expect(() => parseWithdrawalEnv({ ...valid, WITHDRAW_MEMO: "   " })).to.throw(/Set WITHDRAW_MEMO/);
    });

    it("ties impersonation to a fork", function () {
      expect(() => parseWithdrawalEnv({ ...valid, IMPERSONATE: SAFE })).to.throw(/only works on a fork/);
      const env = parseWithdrawalEnv({ ...valid, FORK_OF: "sepolia", IMPERSONATE: SAFE.toLowerCase() });
      expect(env.forkOf).to.equal("sepolia");
      expect(env.impersonate).to.equal(SAFE);
    });
  });

  describe("parseGsusd", function () {
    it("allows zero only when asked, never a negative", function () {
      expect(parseGsusd("X", "0", true)).to.equal(0n);
      expect(() => parseGsusd("X", "0")).to.throw(/must be positive/);
      expect(() => parseGsusd("X", "-1", true)).to.throw(/zero or more/);
    });
  });

  describe("loadSnapshot", function () {
    it("reads the committed Sepolia snapshot", function () {
      const snap = loadSnapshot(resolve(__dirname, "../deployments/sepolia.json"));
      expect(snap.chainId).to.equal(11155111);
      expect(snap.addresses.surplusBuffer).to.match(/^0x[0-9a-fA-F]{40}$/);
      expect(snap.addresses.timelock).to.match(/^0x[0-9a-fA-F]{40}$/);
      expect(snap.addresses.governance).to.match(/^0x[0-9a-fA-F]{40}$/);
    });

    it("reads the governance Safes the snapshot records, and none from a snapshot without them", function () {
      const snap = loadSnapshot(resolve(__dirname, "../deployments/sepolia.json"));
      expect(snap.governanceSafes.proposers.length).to.be.greaterThan(0);
      expect(snap.governanceSafes.guardian).to.match(/^0x[0-9a-fA-F]{40}$/);
      const dir = mkdtempSync(join(tmpdir(), "gsusd-snapshot-"));
      const bare = join(dir, "bare.json");
      writeFileSync(bare, JSON.stringify({ chainId: 1, addresses: { surplusBuffer: SAFE, timelock: SAFE, governance: SAFE, stablecoin: SAFE }, config: { proposers: "not a list", guardian: 7 } }));
      expect(loadSnapshot(bare).governanceSafes).to.deep.equal({ proposers: [], executors: [] });
    });

    it("names the deployer and each governance Safe as an address a withdrawal never pays", function () {
      const addr = (n: number): string => `0x${n.toString(16).padStart(40, "0")}`;
      const parties = refusedRecipients({ deployer: addr(1), governanceSafes: { proposers: [addr(2)], executors: [addr(3)], guardian: addr(4) } });
      expect(parties).to.deep.equal([
        { label: "the deployer", address: addr(1) },
        { label: "the proposer Safe", address: addr(2) },
        { label: "the executor Safe", address: addr(3) },
        { label: "the guardian Safe", address: addr(4) },
      ]);
      // An open executor is the zero address, which is no recipient to hold back; an unrecorded deployer contributes nothing.
      expect(refusedRecipients({ deployer: "", governanceSafes: { proposers: [], executors: [addr(0)] } })).to.deep.equal([]);
    });

    it("refuses a missing or malformed snapshot", function () {
      const dir = mkdtempSync(join(tmpdir(), "gsusd-snapshot-"));
      expect(() => loadSnapshot(join(dir, "nowhere.json"))).to.throw(/No deployment snapshot/);
      const malformed = join(dir, "malformed.json");
      writeFileSync(malformed, JSON.stringify({ chainId: 1, addresses: { surplusBuffer: SAFE } }));
      expect(() => loadSnapshot(malformed)).to.throw(/lacks chainId or one of addresses/);
      // The governance address is what the timelock cross-check reads; its absence must not fail open.
      const noGovernance = join(dir, "no-governance.json");
      writeFileSync(noGovernance, JSON.stringify({ chainId: 1, addresses: { surplusBuffer: SAFE, timelock: SAFE } }));
      expect(() => loadSnapshot(noGovernance)).to.throw(/addresses.governance/);
      const notAnObject = join(dir, "list.json");
      writeFileSync(notAnObject, "[]");
      expect(() => loadSnapshot(notAnObject)).to.throw(/malformed/);
    });
  });

  describe("chain checks", function () {
    it("uses the connected network's snapshot unless forking", function () {
      expect(resolveSnapshotName("mainnet", undefined, 1)).to.equal("mainnet");
      expect(resolveSnapshotName("localhost", "sepolia", HARDHAT_CHAIN_ID)).to.equal("sepolia");
      expect(() => resolveSnapshotName("sepolia", "sepolia", 11155111)).to.throw(/needs a Hardhat fork/);
    });

    it("requires the wire and the snapshot to agree off a fork", function () {
      expect(() => assertChainMatches(1, 11155111, undefined)).to.throw(/Chain mismatch/);
      expect(() => assertChainMatches(11155111, 11155111, undefined)).to.not.throw();
      expect(() => assertChainMatches(11155111, HARDHAT_CHAIN_ID, "sepolia")).to.not.throw();
    });
  });

  describe("summarise", function () {
    it("has a distinct closing line for every step", function () {
      const steps: WithdrawalStep[] = [
        "dry-run",
        "withdrawn",
        "scheduled",
        "awaiting-proposer",
        "waiting",
        "executed",
        "awaiting-executor",
        "expired",
        "done",
      ];
      const lines = steps.map((step) => summarise({ step, path: "timelock" } as WithdrawalOutcome));
      lines.forEach((line) => expect(line).to.have.length.greaterThan(10));
      // "withdrawn" and "executed" deliberately share a line; every other step is distinct.
      expect(new Set(lines).size).to.equal(steps.length - 1);
    });
  });
});
