import { expect } from "chai";
import { autoFloor, effectiveFloor, reservePolicyVerdict, ReserveFloorReading } from "../scripts/lib/minReserve";

const E18 = 10n ** 18n;

/** A reading of a buffer that enforces the automatic floor, as verify-deployment takes it. */
function reading(supply: bigint, smoothedSupply: bigint, minReserve: bigint): ReserveFloorReading {
  return {
    supply,
    smoothedSupply,
    minReserve,
    autoFloorBps: 200n,
    effective: effectiveFloor(supply, smoothedSupply, minReserve),
  };
}

describe("reservePolicyVerdict (verify-deployment treasury:reserve-floor-enforces-2pct-policy)", function () {
  it("mirrors the contract: 2% of the larger of live and smoothed supply, rounded up", function () {
    expect(autoFloor(0n, 0n)).to.equal(0n);
    expect(autoFloor(1_000_000n * E18, 0n)).to.equal(20_000n * E18);
    expect(autoFloor(500_000n * E18, 1_000_000n * E18)).to.equal(20_000n * E18);
    expect(autoFloor(51n, 0n)).to.equal(2n);
    expect(effectiveFloor(1_000_000n * E18, 0n, 40_000n * E18)).to.equal(40_000n * E18);
    expect(effectiveFloor(1_000_000n * E18, 0n, 1n)).to.equal(20_000n * E18);
  });

  it("passes at zero supply and at the launch governed minimum of 0, since the floor is automatic", function () {
    expect(reservePolicyVerdict(reading(0n, 0n, 0n)).level).to.equal("pass");
    const verdict = reservePolicyVerdict(reading(1_000_000n * E18, 1_000_000n * E18, 0n));
    expect(verdict.level).to.equal("pass");
    expect(verdict.detail).to.include("the automatic 2% binds");
    expect(verdict.detail).to.include(String(20_000n * E18));
  });

  it("passes and names the governed minimum when it is the higher", function () {
    const verdict = reservePolicyVerdict(reading(1_000_000n * E18, 0n, 50_000n * E18));
    expect(verdict.level).to.equal("pass");
    expect(verdict.detail).to.include("the governed minimum binds");
  });

  it("fails a buffer that predates the automatic floor, whatever minGsusdReserve says", function () {
    const verdict = reservePolicyVerdict({
      supply: 1_000_000n * E18,
      smoothedSupply: 1_000_000n * E18,
      minReserve: 30_000n * E18,
      autoFloorBps: null,
      effective: null,
    });
    expect(verdict.level).to.equal("fail");
    expect(verdict.detail).to.include("predates the automatic reserve floor");
  });

  it("fails a rate other than 2%, including the retired 3%", function () {
    const verdict = reservePolicyVerdict({ ...reading(1_000_000n * E18, 0n, 0n), autoFloorBps: 300n });
    expect(verdict.level).to.equal("fail");
    expect(verdict.detail).to.include("AUTO_FLOOR_BPS is 300");
  });

  it("fails a reported floor that does not match the policy computed from the same block", function () {
    const honest = reading(1_000_000n * E18, 1_000_000n * E18, 0n);
    const low = reservePolicyVerdict({ ...honest, effective: 19_999n * E18 });
    expect(low.level).to.equal("fail");
    expect(low.detail).to.include("expected");
    // A floor priced off the live supply alone, ignoring the smoothed supply after a burn.
    const burn = reservePolicyVerdict({ ...reading(500_000n * E18, 1_000_000n * E18, 0n), effective: 10_000n * E18 });
    expect(burn.level).to.equal("fail");
  });
});
