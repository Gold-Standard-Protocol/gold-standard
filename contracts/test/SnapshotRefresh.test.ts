import { expect } from "chai";
import { ChainParameters, RefreshableConfig, refreshSnapshotConfig, xautActivationPending, xautStatusOf } from "../scripts/lib/snapshotRefresh";
import { stabilityFeeRateOf } from "../scripts/lib/launchParameterChecks";

/**
 * scripts/lib/snapshotRefresh.ts: what refresh-deployment-snapshot.ts writes back. It once
 * refreshed only the collateral types and the reserve minimum, so
 * a governed change to minDebt, the underwater discount, the origination fee or PAXG's gold
 * band or clamp failed verify-deployment.ts for good, and it overwrote a dormant XAUT's
 * recorded configuration with the zeros of an unregistered type.
 */
describe("refreshSnapshotConfig", function () {
  const recorded = {
    paxgToken: "0x1000000000000000000000000000000000000001",
    xautActive: false,
    guardian: "0x3000000000000000000000000000000000000003",
    paxgGoldBandPpm: "20000",
    paxgLiquidationClampPpm: "20000",
    minGsusdReserve: "0",
    originationFeeBps: "5",
    minDebt: "100000000000000000000",
    underwaterDiscountPpm: "20000",
    stalenessThreshold: 86400,
    reserveDailyCapPpm: "100000",
    reservePenaltyShareBps: "4000",
    badDebtPauseThreshold: "25000000000000000000000",
    perBlockMintCap: "0",
    reserveMinReservePaxg: "0",
    reserveAggregateDailyCapUsd: "0",
    reserveSpreadCurve: [{ coverageAtLeastPpm: "150000", spreadPpm: "5000" }],
    reserveRestrictedSpreadPpm: "20000",
    minCollateralReserve: "0",
    siloCap: "100000000000000000000",
    lockSiloVaultRole: true,
    paxg: { minRatio: 1300000, liqRatio: 1100000, liqPenalty: 50000, debtCeiling: "1000", stabilityFeeBps: 200 },
    xaut: { minRatio: 1300000, liqRatio: 1100000, liqPenalty: 50000, debtCeiling: "0", stabilityFeeBps: 200 },
  };
  const unregistered = { active: false, minRatio: 0n, liquidationRatio: 0n, liquidationPenalty: 0n, debtCeiling: 0n };
  const sameAsRecorded: ChainParameters = {
    paxg: { active: true, minRatio: 1300000n, liquidationRatio: 1100000n, liquidationPenalty: 50000n, debtCeiling: 1000n },
    xaut: unregistered,
    minGsusdReserve: 0n,
    minDebt: 100n * 10n ** 18n,
    underwaterDiscountPpm: 20000n,
    originationFeeBps: 5n,
    paxgGoldBandPpm: 20000n,
    paxgLiquidationClampPpm: 20000n,
    stalenessThreshold: 86400n,
    reserveDailyCapPpm: 100000n,
    paxgStabilityFeeRate: stabilityFeeRateOf(200n),
    reservePenaltyShareBps: 4000n,
    badDebtPauseThreshold: 25_000n * 10n ** 18n,
    perBlockMintCap: 0n,
    reserveMinReservePaxg: 0n,
    reserveAggregateDailyCapUsd: 0n,
    reserveSpreadCurve: [{ coverageAtLeastPpm: 150000n, spreadPpm: 5000n }],
    reserveRestrictedSpreadPpm: 20000n,
    minCollateralReserve: 0n,
    siloCap: 100n * 10n ** 18n,
    lockSiloVaultRole: true,
  };

  it("reports no drift when the chain matches, and keeps a dormant XAUT as recorded", function () {
    const { config, changed, kept } = refreshSnapshotConfig(recorded, sameAsRecorded);
    expect(changed).to.deep.equal([]);
    expect(config.xaut).to.deep.equal(recorded.xaut);
    expect(kept).to.have.length(1);
    expect(kept[0]).to.match(/^xaut \(dormant/);
  });

  it("refreshes minDebt, the underwater discount, the origination fee and PAXG's band and clamp", function () {
    const { config, changed } = refreshSnapshotConfig(recorded, {
      ...sameAsRecorded,
      minDebt: 1_000n * 10n ** 18n,
      underwaterDiscountPpm: 30000n,
      originationFeeBps: 10n,
      paxgGoldBandPpm: 30000n,
      paxgLiquidationClampPpm: 10000n,
      stalenessThreshold: 7200n,
      reserveDailyCapPpm: 50000n,
    });
    expect(changed).to.have.members([
      "minDebt",
      "underwaterDiscountPpm",
      "originationFeeBps",
      "paxgGoldBandPpm",
      "paxgLiquidationClampPpm",
      "stalenessThreshold",
      "reserveDailyCapPpm",
    ]);
    expect(config).to.include({
      minDebt: "1000000000000000000000",
      underwaterDiscountPpm: "30000",
      originationFeeBps: "10",
      paxgGoldBandPpm: "30000",
      paxgLiquidationClampPpm: "10000",
      reserveDailyCapPpm: "50000",
      stalenessThreshold: 7200,
    });
    // Strings, as deploy.ts writes them, so verify-deployment and the manifest read them unchanged;
    // the staleness threshold is the one number, because deploy.ts records it as one and
    // verify-deployment compares it with ===.
    expect(typeof config.minDebt).to.equal("string");
    expect(typeof config.reserveDailyCapPpm).to.equal("string");
    expect(typeof config.stalenessThreshold).to.equal("number");
  });

  it("refreshes PAXG's collateral type and keeps fields it does not read", function () {
    const { config, changed } = refreshSnapshotConfig(recorded, {
      ...sameAsRecorded,
      paxg: { ...sameAsRecorded.paxg, minRatio: 1400000n, debtCeiling: 5000n },
    });
    expect(changed).to.have.members(["paxg.minRatio", "paxg.debtCeiling"]);
    expect(config.paxg).to.deep.equal({ ...recorded.paxg, minRatio: 1400000, debtCeiling: "5000" });
  });

  describe("XAUT activation by governance", function () {
    const LIVE_FEED = "0x00000000000000000000000000000000000000Fe";
    const active = { active: true, minRatio: 1500000n, liquidationRatio: 1200000n, liquidationPenalty: 50000n, debtCeiling: 7n };
    /** The chain after the activation batch: an active XAUT type, its fee initialised, its feed replaced. */
    const activated: ChainParameters = { ...sameAsRecorded, xaut: active, xautStabilityFeeRate: stabilityFeeRateOf(300n), reserveMinReserveXaut: 9n, xautFeed: LIVE_FEED };
    const STAMP = "2027-02-01T10:00:00.000Z";

    it("refreshes XAUT once it has a collateral type on chain and the operator confirms the activation", function () {
      expect(xautActivationPending(recorded, activated)).to.equal(true);
      const { config, changed, kept } = refreshSnapshotConfig<RefreshableConfig>(recorded, activated, { xautActivated: true, now: STAMP });
      expect(kept).to.deep.equal([]);
      expect(changed).to.include.members(["xautActive", "xautActivatedAt", "xautMarketFeed", "xaut.minRatio", "xaut.liqRatio", "xaut.debtCeiling", "xaut.stabilityFeeBps", "reserveMinReserveXaut"]);
      expect(config.xaut).to.include({ minRatio: 1500000, liqRatio: 1200000, debtCeiling: "7", stabilityFeeBps: 300 });
      // The flip the issue found missing: the snapshot now records XAUT as active, when, and on which feed.
      expect(config.xautActive).to.equal(true);
      expect(config.xautActivatedAt).to.equal(STAMP);
      expect(config.xautMarketFeed).to.equal(LIVE_FEED);
      expect(config.reserveMinReserveXaut).to.equal("9");
      expect(xautStatusOf(config)).to.equal("activated");
    });

    it("leaves the constructor's XAUT feed and every other address alone", function () {
      const withFeed = { ...recorded, xautFeed: "0x00000000000000000000000000000000000000A1", xautFeedDeployed: true };
      const { config } = refreshSnapshotConfig<RefreshableConfig>(withFeed, activated, { xautActivated: true, now: STAMP });
      expect(config.xautFeed).to.equal(withFeed.xautFeed);
      expect(config.xautFeedDeployed).to.equal(true);
      expect(config.paxgToken).to.equal(recorded.paxgToken);
      expect(config.guardian).to.equal(recorded.guardian);
    });

    it("refuses loudly, and writes nothing, when XAUT is active on chain and the operator has not confirmed it", function () {
      expect(() => refreshSnapshotConfig(recorded, activated)).to.throw("XAUT_ACTIVATED=1");
      expect(() => refreshSnapshotConfig(recorded, activated, { xautActivated: false })).to.throw("governance has activated it");
    });

    it("refuses a confirmation the chain does not bear out, or one missing the feed or the fee", function () {
      expect(() => refreshSnapshotConfig(recorded, sameAsRecorded, { xautActivated: true })).to.throw("has not executed");
      expect(() => refreshSnapshotConfig(recorded, { ...activated, xautFeed: undefined }, { xautActivated: true })).to.throw("live oracle feed");
      expect(() => refreshSnapshotConfig(recorded, { ...activated, xautStabilityFeeRate: undefined }, { xautActivated: true })).to.throw("stability fee rate");
    });

    it("is recorded once: a later refresh keeps the stamp and the flag is then a note, not a change", function () {
      const first = refreshSnapshotConfig<RefreshableConfig>(recorded, activated, { xautActivated: true, now: STAMP }).config;
      const again = refreshSnapshotConfig<RefreshableConfig>(first, activated, { xautActivated: true, now: "2027-03-01T00:00:00.000Z" });
      expect(again.changed).to.deep.equal([]);
      expect(again.config.xautActivatedAt).to.equal(STAMP);
      expect(again.kept.some((note) => note.includes("XAUT_ACTIVATED=1 has no effect"))).to.equal(true);
      expect(refreshSnapshotConfig<RefreshableConfig>(first, activated).changed).to.deep.equal([]);
    });

    it("tells a dormant XAUT, one active since the deploy and one governance activated apart", function () {
      expect(xautStatusOf({ xautActive: false })).to.equal("dormant");
      expect(xautStatusOf({})).to.equal("active-since-deploy");
      expect(xautStatusOf({ xautActive: true })).to.equal("active-since-deploy");
      expect(xautStatusOf({ xautActive: true, xautActivatedAt: "" })).to.equal("active-since-deploy");
      expect(xautStatusOf({ xautActive: true, xautActivatedAt: STAMP })).to.equal("activated");
      // A stamp cannot make a dormant snapshot read as activated.
      expect(xautStatusOf({ xautActive: false, xautActivatedAt: STAMP })).to.equal("dormant");
    });
  });

  it("treats an older snapshot without xautActive as active, as verify-deployment does", function () {
    const { xautActive: _omitted, ...older } = recorded;
    const { config } = refreshSnapshotConfig(older, sameAsRecorded);
    expect(config.xaut.minRatio).to.equal(0);
  });

  it("records a parameter an older snapshot never had, and leaves addresses and roles alone", function () {
    const { originationFeeBps: _omitted, ...older } = recorded;
    const { config, changed } = refreshSnapshotConfig<RefreshableConfig>(older, sameAsRecorded);
    expect(changed).to.deep.equal(["originationFeeBps"]);
    expect(config.originationFeeBps).to.equal("5");
    expect(config.guardian).to.equal(recorded.guardian);
    expect(config.paxgToken).to.equal(recorded.paxgToken);
  });

  it("refreshes every launch parameter verify-deployment compares by equality", function () {
    const { config, changed, kept } = refreshSnapshotConfig(recorded, {
      ...sameAsRecorded,
      paxgStabilityFeeRate: stabilityFeeRateOf(350n),
      reservePenaltyShareBps: 5000n,
      badDebtPauseThreshold: 1n,
      perBlockMintCap: 7n,
      reserveMinReservePaxg: 2n,
      reserveAggregateDailyCapUsd: 3n,
      reserveSpreadCurve: [{ coverageAtLeastPpm: 100000n, spreadPpm: 7500n }],
      reserveRestrictedSpreadPpm: 30000n,
      minCollateralReserve: 4n,
      siloCap: 5n * 10n ** 18n,
    });
    expect(changed).to.have.members([
      "paxg.stabilityFeeBps",
      "reservePenaltyShareBps",
      "badDebtPauseThreshold",
      "perBlockMintCap",
      "reserveMinReservePaxg",
      "reserveAggregateDailyCapUsd",
      "reserveSpreadCurve",
      "reserveRestrictedSpreadPpm",
      "minCollateralReserve",
      "siloCap",
    ]);
    expect(kept).to.have.length(1); // the dormant XAUT alone
    expect(config.paxg.stabilityFeeBps).to.equal(350);
    expect(config).to.include({ perBlockMintCap: "7", siloCap: "5000000000000000000", lockSiloVaultRole: true });
    expect(config.reserveSpreadCurve).to.deep.equal([{ coverageAtLeastPpm: "100000", spreadPpm: "7500" }]);
  });

  it("keeps a recorded stability fee the chain's per-second rate cannot be read back from", function () {
    const { config, kept } = refreshSnapshotConfig(recorded, { ...sameAsRecorded, paxgStabilityFeeRate: stabilityFeeRateOf(200n) + 1n });
    expect(config.paxg.stabilityFeeBps).to.equal(200);
    expect(kept.some((note) => note.startsWith("paxg.stabilityFeeBps"))).to.equal(true);
  });

  it("never modifies the snapshot it was given", function () {
    const copy = JSON.parse(JSON.stringify(recorded));
    refreshSnapshotConfig(recorded, { ...sameAsRecorded, minDebt: 1n, paxg: { ...sameAsRecorded.paxg, minRatio: 1n } });
    expect(recorded).to.deep.equal(copy);
  });
});
