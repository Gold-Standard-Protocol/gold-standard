import { expect } from "chai";
import {
  SIZING_PPM,
  collateralForBadDebt,
  collateralForDebt,
  mintAtRatio,
  oraclePrices,
  underwaterBadDebtPpm,
} from "../scripts/lib/rehearsalSizing";

const E8 = 100_000_000n;
const E18 = 10n ** 18n;
const usd = (dollars: number): bigint => BigInt(Math.round(dollars * 100)) * (E8 / 100n);

/** The sizing arithmetic of the fork rehearsal: it must hold at any gold price and any gap between the feeds. */
describe("rehearsal sizing helpers", function () {
  describe("oraclePrices", function () {
    it("borrows at the lower feed and settles at the higher one while C sits under G", function () {
      const p = oraclePrices(usd(3621.81), usd(3642.16), 20_000n, 20_000n);
      expect(p.borrow).to.equal(usd(3621.81));
      expect(p.settlement).to.equal(usd(3642.16));
      expect(p.valuation).to.equal(usd(3621.81));
    });

    it("borrows at G and settles at C while C sits above G inside the clamp", function () {
      const p = oraclePrices(usd(4040), usd(4000), 20_000n, 20_000n);
      expect(p.borrow).to.equal(usd(4000));
      expect(p.settlement).to.equal(usd(4040));
      expect(p.valuation).to.equal(usd(4000));
    });

    it("caps the settlement price at G plus the clamp and refuses a borrowing price off the band", function () {
      const high = oraclePrices(usd(4200), usd(4000), 20_000n, 20_000n);
      expect(high.borrow).to.equal(undefined);
      expect(high.settlement).to.equal(usd(4080));
      expect(high.valuation).to.equal(usd(4000));
      const low = oraclePrices(usd(3800), usd(4000), 20_000n, 20_000n);
      expect(low.borrow).to.equal(undefined);
      expect(low.settlement).to.equal(usd(4000));
      expect(low.valuation).to.equal(usd(3800));
    });

    it("includes both edges of the band and gives one price when the feeds agree", function () {
      expect(oraclePrices(usd(3920), usd(4000), 20_000n, 20_000n).borrow).to.equal(usd(3920));
      expect(oraclePrices(usd(4080), usd(4000), 20_000n, 20_000n).borrow).to.equal(usd(4000));
      const same = oraclePrices(usd(4000), usd(4000), 20_000n, 20_000n);
      expect([same.borrow, same.settlement, same.valuation]).to.deep.equal([usd(4000), usd(4000), usd(4000)]);
    });

    it("refuses a price of zero and a negative width", function () {
      expect(() => oraclePrices(0n, usd(4000), 20_000n, 20_000n)).to.throw(/above zero/);
      expect(() => oraclePrices(usd(4000), 0n, 20_000n, 20_000n)).to.throw(/above zero/);
      expect(() => oraclePrices(usd(4000), usd(4000), -1n, 20_000n)).to.throw(/negative/);
    });
  });

  describe("mintAtRatio and collateralForDebt", function () {
    it("sizes a mint at a stated ratio", function () {
      expect(mintAtRatio(10n * E18, usd(4000), 2_000_000n)).to.equal(20_000n * E18);
      expect(mintAtRatio(3_000n * E18, usd(3621.81), 1_300_000n)).to.equal((3_000n * E18 * usd(3621.81) / E8) * SIZING_PPM / 1_300_000n);
      expect(() => mintAtRatio(E18, usd(4000), 0n)).to.throw(/ratio/);
    });

    it("rounds the collateral up, so the debt it was sized for always fits", function () {
      for (const price of [usd(1800), usd(3621.81), usd(4000), usd(9999.99)]) {
        for (const ratio of [1_300_000n, 1_350_000n, 2_000_000n]) {
          const debt = 8_500_000n * E18;
          const collateral = collateralForDebt(debt, price, ratio);
          expect(mintAtRatio(collateral, price, ratio) >= debt, `price ${price}, ratio ${ratio}`).to.equal(true);
          expect(mintAtRatio(collateral - E18 / 1000n, price, ratio) < debt, `price ${price}, ratio ${ratio}: not minimal`).to.equal(true);
        }
      }
      expect(() => collateralForDebt(E18, 0n, 1_300_000n)).to.throw(/price/);
    });
  });

  describe("underwaterBadDebtPpm", function () {
    it("is zero at or above full cover", function () {
      expect(underwaterBadDebtPpm(1_000_000n, 20_000n)).to.equal(0n);
      expect(underwaterBadDebtPpm(1_100_000n, 20_000n)).to.equal(0n);
    });

    it("follows the larger of the discounted value and twice the value less the debt", function () {
      // 94.32% cover: 2 x 0.9432 - 1 = 0.8864 is under 0.9432 x 0.98 = 0.924336, so 7.5664% is lost.
      expect(underwaterBadDebtPpm(943_200n, 20_000n)).to.equal(75_664n);
      // 99.5% cover: 2 x 0.995 - 1 = 0.99 beats 0.995 x 0.98 = 0.9751, so 1% is lost.
      expect(underwaterBadDebtPpm(995_000n, 20_000n)).to.equal(10_000n);
      expect(underwaterBadDebtPpm(0n, 20_000n)).to.equal(SIZING_PPM);
    });

    it("refuses shares outside 0 to 100%", function () {
      expect(() => underwaterBadDebtPpm(-1n, 20_000n)).to.throw(/Shares/);
      expect(() => underwaterBadDebtPpm(900_000n, 1_000_001n)).to.throw(/Shares/);
    });
  });

  describe("collateralForBadDebt", function () {
    const base = { fallPpm: 720_000n, ratioPpm: 1_310_000n, discountPpm: 20_000n };

    /** Replays the liquidation the helper sizes for and returns the bad debt it books. */
    function booked(collateral: bigint, borrowPrice: bigint, settlementPrice: bigint): bigint {
      const debt = mintAtRatio(collateral, borrowPrice, base.ratioPpm);
      const value = (collateral * ((settlementPrice * base.fallPpm) / SIZING_PPM)) / E8;
      const discounted = (value * (SIZING_PPM - base.discountPpm)) / SIZING_PPM;
      const floor = 2n * value > debt ? 2n * value - debt : 0n;
      const paid = discounted > floor ? discounted : floor;
      return debt - paid;
    }

    it("books at least the target at any gold price and any gap between the feeds", function () {
      const target = 26_500n * E18;
      for (const borrow of [usd(1800), usd(3621.81), usd(3760), usd(8000)]) {
        for (const gapPpm of [0n, 5_600n, 20_000n]) {
          const settlement = (borrow * (SIZING_PPM + gapPpm)) / SIZING_PPM;
          const collateral = collateralForBadDebt({ ...base, badDebt: target, borrowPrice: borrow, settlementPrice: settlement });
          const got = booked(collateral, borrow, settlement);
          expect(got >= target, `borrow ${borrow}, gap ${gapPpm}: booked ${got}`).to.equal(true);
          expect(got <= (target * 1_001n) / 1_000n, `borrow ${borrow}, gap ${gapPpm}: booked ${got}, far over the target`).to.equal(true);
        }
      }
    });

    it("needs more collateral when the settlement price sits above the borrowing price", function () {
      const target = 26_500n * E18;
      const level = collateralForBadDebt({ ...base, badDebt: target, borrowPrice: usd(3621.81), settlementPrice: usd(3621.81) });
      const apart = collateralForBadDebt({ ...base, badDebt: target, borrowPrice: usd(3621.81), settlementPrice: usd(3642.16) });
      expect(apart > level).to.equal(true);
    });

    it("refuses a vault that the fall does not put under water, a zero target and a zero price", function () {
      expect(() => collateralForBadDebt({ ...base, fallPpm: 900_000n, badDebt: E18, borrowPrice: usd(4000), settlementPrice: usd(4000) })).to.throw(/not under water/);
      expect(() => collateralForBadDebt({ ...base, badDebt: 0n, borrowPrice: usd(4000), settlementPrice: usd(4000) })).to.throw(/bad debt/);
      expect(() => collateralForBadDebt({ ...base, badDebt: E18, borrowPrice: 0n, settlementPrice: usd(4000) })).to.throw(/prices/);
    });
  });
});
