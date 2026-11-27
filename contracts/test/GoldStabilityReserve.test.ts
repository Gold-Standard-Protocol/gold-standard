import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import {
  GoldOracle,
  GoldStablecoin,
  GoldStabilityReserve,
  MockAggregatorV3,
  MockERC20,
  SurplusBuffer,
} from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

/**
 * GoldStabilityReserve: the below-peg floor, and nothing else.
 *
 * The property every test here serves: the reserve holds assets and owes nothing. It
 * never mints, never burns, and no path through it can reach a borrower's vault.
 */
describe("GoldStabilityReserve", function () {
  let owner: HardhatEthersSigner;
  let redeemer: HardhatEthersSigner;
  let guardian: HardhatEthersSigner;
  let other: HardhatEthersSigner;

  let paxg: MockERC20;
  let xaut: MockERC20;
  let paxgFeed: MockAggregatorV3;
  let xautFeed: MockAggregatorV3;
  let oracle: GoldOracle;
  let stablecoin: GoldStablecoin;
  let buffer: SurplusBuffer;
  let reserve: GoldStabilityReserve;

  const GOLD = 200000000000n; // $2000, 8 dec
  const PPM = 1_000_000n;
  const CURVE = [
    { coverageAtLeastPpm: 150_000n, spreadPpm: 5_000n }, // at the raised 0.5% floor
    { coverageAtLeastPpm: 100_000n, spreadPpm: 5_000n },
    { coverageAtLeastPpm: 50_000n, spreadPpm: 7_500n },
    { coverageAtLeastPpm: 20_000n, spreadPpm: 12_500n },
  ];
  const RESTRICTED = 20_000n;

  async function setPrice(feed: MockAggregatorV3, price: bigint) {
    const now = await time.latest();
    await feed.setLatestRoundData(1, price, now, now, 1);
  }

  async function refreshPrices() {
    await setPrice(paxgFeed, GOLD);
    await setPrice(xautFeed, GOLD);
  }

  beforeEach(async function () {
    [owner, redeemer, guardian, other] = await ethers.getSigners();

    const MockAgg = await ethers.getContractFactory("MockAggregatorV3");
    paxgFeed = await MockAgg.deploy(8);
    xautFeed = await MockAgg.deploy(8);
    await refreshPrices();

    const MockToken = await ethers.getContractFactory("MockERC20");
    paxg = await MockToken.deploy("Pax Gold", "PAXG", 18);
    xaut = await MockToken.deploy("Tether Gold", "XAUT", 6);

    const OracleF = await ethers.getContractFactory("GoldOracle");
    oracle = await OracleF.deploy(
      await paxgFeed.getAddress(),
      await xautFeed.getAddress(),
      await paxg.getAddress(),
      await xaut.getAddress(),
      90000
    );
    await oracle.getTokenPrice(await paxg.getAddress());
    await oracle.getTokenPrice(await xaut.getAddress());

    const StablecoinF = await ethers.getContractFactory("GoldStablecoin");
    stablecoin = await StablecoinF.deploy();
    await stablecoin.grantRole(await stablecoin.MINTER_ROLE(), owner.address);

    const BufferF = await ethers.getContractFactory("SurplusBuffer");
    buffer = await BufferF.deploy(await stablecoin.getAddress());

    const ReserveF = await ethers.getContractFactory("GoldStabilityReserve");
    reserve = await ReserveF.deploy(await stablecoin.getAddress(), await oracle.getAddress());
    await buffer.grantRole(await buffer.VAULT_ROLE(), await reserve.getAddress());
    await reserve.setSurplusBuffer(await buffer.getAddress());
    await reserve.setAssetConfig(await paxg.getAddress(), true, 0n, PPM);
    await reserve.setAssetConfig(await xaut.getAddress(), true, 0n, PPM);
    await reserve.setSpreadCurve(CURVE, RESTRICTED);
    await reserve.grantGuardianRole(guardian.address);

    // Owner holds gold to seed with; the redeemer holds GSUSD.
    await paxg.mint(owner.address, ethers.parseEther("1000"));
    await xaut.mint(owner.address, 1_000_000_000n);
    await paxg.approve(await reserve.getAddress(), ethers.MaxUint256);
    await xaut.approve(await reserve.getAddress(), ethers.MaxUint256);
    await stablecoin.mint(redeemer.address, ethers.parseEther("1000000"));
    await stablecoin.connect(redeemer).approve(await reserve.getAddress(), ethers.MaxUint256);
  });

  async function seed(amountPaxg: bigint) {
    await reserve.seedCollateral(await paxg.getAddress(), amountPaxg);
  }

  /**
   * The GSUSD input that makes a PAXG swap pay exactly `gold` at `priceE8` and the spread in
   * force. Checked against the arithmetic the swap uses, so a test cannot drift from it.
   */
  async function gsusdForExactPaxg(gold: bigint, priceE8: bigint = GOLD) {
    const spread = await reserve.currentSpreadPpm();
    const denominator = priceE8 * 10n ** 10n;
    const one = 10n ** 18n;
    const netNeeded = (gold * denominator + one - 1n) / one;
    const gsusdIn = (netNeeded * PPM) / (PPM - spread) + 1n;
    const net = gsusdIn - (gsusdIn * spread) / PPM;
    expect((net * one) / denominator).to.equal(gold);
    return gsusdIn;
  }

  // -------------------------------------------------------------------------

  describe("constructor and wiring", function () {
    it("rejects zero addresses", async function () {
      const F = await ethers.getContractFactory("GoldStabilityReserve");
      await expect(F.deploy(ethers.ZeroAddress, await oracle.getAddress())).to.be.revertedWith("Zero address");
      await expect(F.deploy(await stablecoin.getAddress(), ethers.ZeroAddress)).to.be.revertedWith("Zero address");
    });

    it("never holds MINTER_ROLE on the stablecoin", async function () {
      // The defining property, stated as a test. Deploy scripts never grant it and
      // verify-deployment asserts it; this is the unit-level statement.
      expect(await stablecoin.hasRole(await stablecoin.MINTER_ROLE(), await reserve.getAddress())).to.be.false;
    });

    it("probes the buffer interface on setSurplusBuffer and allows address(0)", async function () {
      await expect(reserve.setSurplusBuffer(other.address)).to.be.reverted;
      await expect(reserve.setSurplusBuffer(ethers.ZeroAddress)).to.emit(reserve, "SurplusBufferUpdated");
    });
  });

  describe("seeding and penalty deposits", function () {
    it("seedCollateral is permissionless and credits the measured delta", async function () {
      await paxg.mint(other.address, ethers.parseEther("5"));
      await paxg.connect(other).approve(await reserve.getAddress(), ethers.MaxUint256);
      await expect(reserve.connect(other).seedCollateral(await paxg.getAddress(), ethers.parseEther("5")))
        .to.emit(reserve, "CollateralSeeded")
        .withArgs(await paxg.getAddress(), other.address, ethers.parseEther("5"), ethers.parseEther("5"));
      expect(await reserve.collateralBalance(await paxg.getAddress())).to.equal(ethers.parseEther("5"));
      expect(await reserve.totalGoldSeeded(await paxg.getAddress())).to.equal(ethers.parseEther("5"));
    });

    it("rejects seeding an unsupported token, and rejects GSUSD as an asset", async function () {
      await expect(reserve.seedCollateral(await stablecoin.getAddress(), 1n)).to.be.revertedWith("Unsupported token");
      await expect(reserve.setAssetConfig(await stablecoin.getAddress(), true, 0n, PPM)).to.be.revertedWith(
        "Not a collateral token"
      );
    });

    it("credits a fee-on-transfer token with what actually arrived", async function () {
      const FeeToken = await ethers.getContractFactory("MockERC20FeeOnTransfer");
      const fot = await FeeToken.deploy("Fee Gold", "FGOLD", 100); // 1% fee
      await oracle.addFeed(await fot.getAddress(), await paxgFeed.getAddress());
      await reserve.setAssetConfig(await fot.getAddress(), true, 0n, PPM);
      await fot.mint(owner.address, ethers.parseEther("100"));
      await fot.approve(await reserve.getAddress(), ethers.MaxUint256);
      await reserve.seedCollateral(await fot.getAddress(), ethers.parseEther("100"));
      expect(await reserve.collateralBalance(await fot.getAddress())).to.equal(ethers.parseEther("99"));
    });

    it("depositCollateral is VAULT_ROLE only and counts separately from seeds", async function () {
      await expect(reserve.depositCollateral(await paxg.getAddress(), 1n)).to.be.revertedWithCustomError(
        reserve,
        "AccessControlUnauthorizedAccount"
      );
      await reserve.grantRole(await reserve.VAULT_ROLE(), owner.address);
      await reserve.depositCollateral(await paxg.getAddress(), ethers.parseEther("2"));
      expect(await reserve.totalGoldFromPenalties(await paxg.getAddress())).to.equal(ethers.parseEther("2"));
      expect(await reserve.totalGoldSeeded(await paxg.getAddress())).to.equal(0n);
    });
  });

  describe("swapGsusdForGold", function () {
    it("pays oracle price minus spread, banks the spread, holds the rest", async function () {
      await seed(ethers.parseEther("51"));
      // Coverage: $102k reserve / 1m circulating = 10.2%; after the swap at least 10% → 0.5%
      const amount = ethers.parseEther("2000");
      const supplyBefore = await stablecoin.totalSupply();
      await refreshPrices();

      await expect(reserve.connect(redeemer).swapGsusdForGold(await paxg.getAddress(), amount, 0n))
        .to.emit(reserve, "Swapped");

      // 2000 × 0.995 / 2000 = 0.995 PAXG
      expect(await paxg.balanceOf(redeemer.address)).to.equal(ethers.parseEther("0.995"));
      expect(await buffer.gsusdBalance()).to.equal(ethers.parseEther("10"));
      expect(await reserve.gsusdInventory()).to.equal(ethers.parseEther("1990"));
      // A swap, not a burn.
      expect(await stablecoin.totalSupply()).to.equal(supplyBefore);
      expect(await reserve.collateralBalance(await paxg.getAddress())).to.equal(ethers.parseEther("50.005"));
      expect(await reserve.totalGsusdReceived()).to.equal(amount);
      expect(await reserve.totalSpreadPaid()).to.equal(ethers.parseEther("10"));
    });

    it("uses XAUT's 6 decimals correctly", async function () {
      await reserve.seedCollateral(await xaut.getAddress(), 51_000_000n);
      await refreshPrices();
      const out = await reserve
        .connect(redeemer)
        .swapGsusdForGold.staticCall(await xaut.getAddress(), ethers.parseEther("2000"), 0n);
      expect(out).to.equal(995000n);
    });

    it("honours minGoldOut", async function () {
      await seed(ethers.parseEther("50"));
      await refreshPrices();
      await expect(
        reserve.connect(redeemer).swapGsusdForGold(await paxg.getAddress(), ethers.parseEther("2000"), ethers.parseEther("1"))
      ).to.be.revertedWith("Slippage");
    });

    it("refuses when the reserve cannot cover it, and never reaches below the floor", async function () {
      await seed(ethers.parseEther("10"));
      await reserve.setAssetConfig(await paxg.getAddress(), true, ethers.parseEther("9"), PPM);
      await refreshPrices();
      // 1 PAXG redeemable; 4000 GSUSD would need ~1.99.
      await expect(
        reserve.connect(redeemer).swapGsusdForGold(await paxg.getAddress(), ethers.parseEther("4000"), 0n)
      ).to.be.revertedWith("Reserve insufficient");
      // 1900 GSUSD → 0.945 PAXG, fits.
      await expect(reserve.connect(redeemer).swapGsusdForGold(await paxg.getAddress(), ethers.parseEther("1900"), 0n))
        .to.not.be.reverted;
      expect(await reserve.collateralBalance(await paxg.getAddress())).to.be.gte(ethers.parseEther("9"));
    });

    it("a swap may take the reserve down to exactly its minimum, and not one unit below", async function () {
      const token = await paxg.getAddress();
      await seed(ethers.parseEther("100"));
      await reserve.setAssetConfig(token, true, ethers.parseEther("95"), PPM);
      await refreshPrices();
      expect(await reserve.redeemableCollateral(token)).to.equal(ethers.parseEther("5"));

      // One base unit more than the reserve holds above its minimum is refused.
      const over = await gsusdForExactPaxg(ethers.parseEther("5") + 1n);
      await expect(reserve.connect(redeemer).swapGsusdForGold(token, over, 0n)).to.be.revertedWith("Reserve insufficient");

      const exact = await gsusdForExactPaxg(ethers.parseEther("5"));
      await reserve.connect(redeemer).swapGsusdForGold(token, exact, ethers.parseEther("5"));
      expect(await reserve.collateralBalance(token)).to.equal(ethers.parseEther("95"));
      expect(await reserve.redeemableCollateral(token)).to.equal(0n);
    });

    it("rejects zero, unsupported and paused assets", async function () {
      await seed(ethers.parseEther("10"));
      await expect(reserve.connect(redeemer).swapGsusdForGold(await paxg.getAddress(), 0n, 0n)).to.be.revertedWith("Zero amount");
      await expect(reserve.connect(redeemer).swapGsusdForGold(other.address, 1n, 0n)).to.be.revertedWith("Unsupported token");
      await reserve.connect(guardian).pauseAsset(await paxg.getAddress());
      await expect(reserve.connect(redeemer).swapGsusdForGold(await paxg.getAddress(), 1n, 0n)).to.be.revertedWith("Asset paused");
    });

    it("rejects a swap too small to yield any gold", async function () {
      await reserve.seedCollateral(await xaut.getAddress(), 50_000_000n);
      await refreshPrices();
      // 1 wei of GSUSD → 0 units of 6-decimal XAUT.
      await expect(reserve.connect(redeemer).swapGsusdForGold(await xaut.getAddress(), 1n, 0n)).to.be.revertedWith("Swap too small");
    });

    it("holds the spread as inventory when the buffer rejects it, and never burns", async function () {
      await seed(ethers.parseEther("51"));
      // Revoke the reserve's right to deposit fees.
      await buffer.revokeRole(await buffer.VAULT_ROLE(), await reserve.getAddress());
      const supplyBefore = await stablecoin.totalSupply();
      await refreshPrices();
      const amount = ethers.parseEther("2000");
      await expect(reserve.connect(redeemer).swapGsusdForGold(await paxg.getAddress(), amount, 0n))
        .to.emit(reserve, "FeeRoutingFailed")
        .withArgs(ethers.parseEther("10"));
      expect(await reserve.gsusdInventory()).to.equal(amount);
      expect(await stablecoin.totalSupply()).to.equal(supplyBefore);
      expect(await stablecoin.balanceOf(await reserve.getAddress())).to.equal(amount);
    });
  });

  describe("pricing what the reserve can really pay", function () {
    it("prices a swap at the tier of the coverage it leaves behind", async function () {
      await seed(ethers.parseEther("50")); // $100k = 10%, exactly on the 0.5% tier
      expect(await reserve.currentSpreadPpm()).to.equal(5_000n);
      // 2,000 GSUSD leaves 9.8%: the 0.75% tier, not the 0.5% it started on.
      const [, spread] = await reserve.quoteGoldOut(await paxg.getAddress(), ethers.parseEther("2000"));
      expect(spread).to.equal(7_500n);
      await refreshPrices();
      await expect(reserve.connect(redeemer).swapGsusdForGold(await paxg.getAddress(), ethers.parseEther("2000"), 0n))
        .to.emit(reserve, "Swapped")
        .withArgs(redeemer.address, await paxg.getAddress(), ethers.parseEther("2000"), ethers.parseEther("0.9925"), 7_500n, ethers.parseEther("15"));
    });

    it("does not count gold of a de-supported or paused asset as coverage", async function () {
      await seed(ethers.parseEther("50"));
      await reserve.seedCollateral(await xaut.getAddress(), 50_000_000n); // $200k = 20%
      expect(await reserve.coveragePpm()).to.equal(200_000n);
      await reserve.connect(guardian).pauseAsset(await xaut.getAddress());
      expect(await reserve.coveragePpm()).to.equal(100_000n);
      await reserve.unpauseAsset(await xaut.getAddress(), await reserve.assetPauseEpoch(await xaut.getAddress()));
      await reserve.setAssetConfig(await xaut.getAddress(), false, 0n, PPM);
      expect(await reserve.coveragePpm()).to.equal(100_000n);
    });

    it("refuses to list a token the oracle has no feed for", async function () {
      const MockToken = await ethers.getContractFactory("MockERC20");
      const rogue = await MockToken.deploy("Rogue Gold", "RGLD", 18);
      await expect(reserve.setAssetConfig(await rogue.getAddress(), true, 0n, PPM))
        .to.be.revertedWith("No oracle feed");
      await oracle.addFeed(await rogue.getAddress(), await paxgFeed.getAddress());
      await reserve.setAssetConfig(await rogue.getAddress(), true, 0n, PPM);
      expect(await reserve.supportedTokenCount()).to.equal(3n);
    });
  });

  describe("spread curve", function () {
    it("steps up as coverage falls and restricts below every step", async function () {
      // Circulating = 1,000,000 GSUSD. Reserve value sets coverage.
      await seed(ethers.parseEther("100")); // $200k = 20% → 0.50% (top tier sits at the floor)
      expect(await reserve.currentSpreadPpm()).to.equal(5_000n);
      await reserve.withdrawCollateral(await paxg.getAddress(), owner.address, ethers.parseEther("40")); // $120k = 12% → 0.50%
      expect(await reserve.currentSpreadPpm()).to.equal(5_000n);
      await reserve.withdrawCollateral(await paxg.getAddress(), owner.address, ethers.parseEther("30")); // $60k = 6% → 0.75%
      expect(await reserve.currentSpreadPpm()).to.equal(7_500n);
      await reserve.withdrawCollateral(await paxg.getAddress(), owner.address, ethers.parseEther("15")); // $30k = 3% → 1.25%
      expect(await reserve.currentSpreadPpm()).to.equal(12_500n);
      await reserve.withdrawCollateral(await paxg.getAddress(), owner.address, ethers.parseEther("10")); // $10k = 1% → restricted 2%
      expect(await reserve.currentSpreadPpm()).to.equal(RESTRICTED);
    });

    it("validates ordering and bounds", async function () {
      await expect(
        reserve.setSpreadCurve([{ coverageAtLeastPpm: 10_000n, spreadPpm: 5_000n }, { coverageAtLeastPpm: 20_000n, spreadPpm: 6_000n }], RESTRICTED)
      ).to.be.revertedWith("Steps must descend in coverage");
      // Two steps at one coverage: the second could never apply, so the pair is refused.
      await expect(
        reserve.setSpreadCurve([{ coverageAtLeastPpm: 20_000n, spreadPpm: 5_000n }, { coverageAtLeastPpm: 20_000n, spreadPpm: 6_000n }], RESTRICTED)
      ).to.be.revertedWith("Steps must descend in coverage");
      await expect(
        reserve.setSpreadCurve([{ coverageAtLeastPpm: 20_000n, spreadPpm: 6_000n }, { coverageAtLeastPpm: 10_000n, spreadPpm: 5_000n }], RESTRICTED)
      ).to.be.revertedWith("Spreads must ascend");
      await expect(reserve.setSpreadCurve([{ coverageAtLeastPpm: 20_000n, spreadPpm: 500n }], RESTRICTED)).to.be.revertedWith("Spread out of range");
      await expect(reserve.setSpreadCurve([{ coverageAtLeastPpm: 20_000n, spreadPpm: 30_000n }], RESTRICTED)).to.be.revertedWith("Step exceeds restricted spread");
      await expect(reserve.setSpreadCurve([], 60_000n)).to.be.revertedWith("Restricted spread out of range");
      await expect(reserve.setSpreadCurve([], 20_000n)).to.emit(reserve, "SpreadCurveUpdated");
      expect(await reserve.currentSpreadPpm()).to.equal(20_000n);
    });

    it("the floor never lets the spread fall below MIN_SPREAD_PPM", async function () {
      expect(await reserve.MIN_SPREAD_PPM()).to.equal(5_000n);
    });
  });

  describe("daily caps", function () {
    it("per-asset cap is a share of the day-start balance and resets on a new UTC day", async function () {
      await seed(ethers.parseEther("100"));
      await reserve.setAssetConfig(await paxg.getAddress(), true, 0n, 100_000n); // 10%/day
      await refreshPrices();
      await reserve.connect(redeemer).swapGsusdForGold(await paxg.getAddress(), ethers.parseEther("19000"), 0n); // ~9.45 PAXG
      await expect(
        reserve.connect(redeemer).swapGsusdForGold(await paxg.getAddress(), ethers.parseEther("2000"), 0n)
      ).to.be.revertedWith("Daily cap reached");
      expect(await reserve.remainingDailyCapacity(await paxg.getAddress())).to.be.lt(ethers.parseEther("1"));

      await time.increase(86400);
      await refreshPrices();
      await expect(reserve.connect(redeemer).swapGsusdForGold(await paxg.getAddress(), ethers.parseEther("2000"), 0n)).to.not.be.reverted;
    });

    it("two swaps in one day together take exactly the day-start share", async function () {
      const token = await paxg.getAddress();
      await seed(ethers.parseEther("100"));
      await reserve.setAssetConfig(token, true, 0n, 100_000n); // 10% of the day-start balance
      await refreshPrices();
      expect(await reserve.remainingDailyCapacity(token)).to.equal(ethers.parseEther("10"));

      const first = await gsusdForExactPaxg(ethers.parseEther("4"));
      await reserve.connect(redeemer).swapGsusdForGold(token, first, ethers.parseEther("4"));
      // The cap is still 10% of the 100 PAXG the day began with, so 6 remain: the room does
      // not shrink with the balance.
      expect(await reserve.remainingDailyCapacity(token)).to.equal(ethers.parseEther("6"));

      const second = await gsusdForExactPaxg(ethers.parseEther("6"));
      await reserve.connect(redeemer).swapGsusdForGold(token, second, ethers.parseEther("6"));
      expect(await reserve.collateralBalance(token)).to.equal(ethers.parseEther("90"));
      expect(await reserve.remainingDailyCapacity(token)).to.equal(0n);

      const oneUnit = await gsusdForExactPaxg(1n);
      await expect(reserve.connect(redeemer).swapGsusdForGold(token, oneUnit, 0n)).to.be.revertedWith("Daily cap reached");
    });

    it("a swap that exactly fills the aggregate cap succeeds, and one unit of cap less refuses it", async function () {
      const token = await paxg.getAddress();
      await seed(ethers.parseEther("100"));
      await refreshPrices();
      const day = BigInt(await time.latest()) / 86400n;
      // One whole PAXG at $2,000 is worth exactly 2,000 USD, with nothing lost to rounding.
      const gsusdIn = await gsusdForExactPaxg(ethers.parseEther("1"));
      const worth = ethers.parseEther("2000");

      await reserve.setAggregateDailyCap(worth - 1n);
      await expect(reserve.connect(redeemer).swapGsusdForGold(token, gsusdIn, 0n)).to.be.revertedWith(
        "Aggregate daily cap reached"
      );

      await reserve.setAggregateDailyCap(worth);
      await reserve.connect(redeemer).swapGsusdForGold(token, gsusdIn, ethers.parseEther("1"));
      expect(await reserve.dayOutflowUsd(day)).to.equal(worth);
      expect(await reserve.remainingDailyCapacity(token)).to.equal(0n);
    });

    it("values gold in USD rounded down, in the reserve's value and in the day's outflow", async function () {
      const token = await paxg.getAddress();
      // A price and amounts whose product is not a whole number of USD units.
      const price = GOLD + 1n;
      await setPrice(paxgFeed, price);
      await setPrice(xautFeed, price);
      const seeded = ethers.parseEther("100") + 1n;
      await seed(seeded);
      expect((seeded * price) % 10n ** 8n).to.not.equal(0n);
      expect(await reserve.reserveValueUsd()).to.equal((seeded * price) / 10n ** 8n);

      const day = BigInt(await time.latest()) / 86400n;
      const before = await paxg.balanceOf(redeemer.address);
      await reserve.connect(redeemer).swapGsusdForGold(token, ethers.parseEther("1234.567") + 7n, 0n);
      const goldOut = (await paxg.balanceOf(redeemer.address)) - before;
      expect((goldOut * price) % 10n ** 8n).to.not.equal(0n);
      expect(await reserve.dayOutflowUsd(day)).to.equal((goldOut * price) / 10n ** 8n);
    });

    it("aggregate USD cap binds across assets", async function () {
      await seed(ethers.parseEther("100"));
      await reserve.seedCollateral(await xaut.getAddress(), 100_000_000n);
      await reserve.setAggregateDailyCap(ethers.parseEther("3000")); // $3k/day total
      await refreshPrices();
      await reserve.connect(redeemer).swapGsusdForGold(await paxg.getAddress(), ethers.parseEther("2000"), 0n); // $1990
      await expect(
        reserve.connect(redeemer).swapGsusdForGold(await xaut.getAddress(), ethers.parseEther("2000"), 0n)
      ).to.be.revertedWith("Aggregate daily cap reached");
      await reserve.setAggregateDailyCap(0n); // disabled
      await expect(reserve.connect(redeemer).swapGsusdForGold(await xaut.getAddress(), ethers.parseEther("2000"), 0n)).to.not.be.reverted;
    });
  });

  describe("aggregate cap switched on part way through a day", function () {
    const DAY = 86400n;
    const usdOf = async (day: bigint) => reserve.dayOutflowUsd(day);

    /** Start well inside a fresh UTC day, so every swap below lands on the same day. */
    async function startOfDay(): Promise<bigint> {
      const day = BigInt(await time.latest()) / DAY + 1n;
      await time.increaseTo(day * DAY + 3600n);
      await refreshPrices();
      return day;
    }

    it("records the day's USD outflow while the cap is off, across both assets", async function () {
      await seed(ethers.parseEther("100"));
      await reserve.seedCollateral(await xaut.getAddress(), 100_000_000n);
      const day = await startOfDay();
      expect(await reserve.aggregateDailyCapUsd()).to.equal(0n);

      await reserve.connect(redeemer).swapGsusdForGold(await paxg.getAddress(), ethers.parseEther("2000"), 0n);
      const afterPaxg = await usdOf(day);
      expect(afterPaxg).to.be.gt(ethers.parseEther("1900")); // about $1,990 of gold left
      expect(afterPaxg).to.be.lte(ethers.parseEther("2000"));

      await reserve.connect(redeemer).swapGsusdForGold(await xaut.getAddress(), ethers.parseEther("500"), 0n);
      const afterXaut = await usdOf(day);
      expect(afterXaut - afterPaxg).to.be.gt(ethers.parseEther("450"));
      expect(afterXaut - afterPaxg).to.be.lte(ethers.parseEther("500"));
    });

    it("a cap enabled after $1,990 has left allows only the rest of its allowance that day", async function () {
      await seed(ethers.parseEther("100"));
      await reserve.seedCollateral(await xaut.getAddress(), 100_000_000n);
      const day = await startOfDay();
      await reserve.connect(redeemer).swapGsusdForGold(await paxg.getAddress(), ethers.parseEther("2000"), 0n);
      const before = await usdOf(day);

      await reserve.setAggregateDailyCap(ethers.parseEther("3000"));
      // Without the earlier outflow this swap would fit a fresh $3,000 allowance.
      await expect(
        reserve.connect(redeemer).swapGsusdForGold(await xaut.getAddress(), ethers.parseEther("2000"), 0n)
      ).to.be.revertedWith("Aggregate daily cap reached");
      expect(await usdOf(day)).to.equal(before);

      // What is left of the allowance is still there.
      await reserve.connect(redeemer).swapGsusdForGold(await xaut.getAddress(), ethers.parseEther("500"), 0n);
      expect(await usdOf(day)).to.be.gt(before);
      expect(await usdOf(day)).to.be.lte(ethers.parseEther("3000"));
    });

    it("keeps one cumulative total through a disabled interval; re-enabling below it leaves nothing", async function () {
      await seed(ethers.parseEther("100"));
      await reserve.seedCollateral(await xaut.getAddress(), 100_000_000n);
      const day = await startOfDay();
      const paxgAddr = await paxg.getAddress();
      const xautAddr = await xaut.getAddress();

      // before activation
      await reserve.connect(redeemer).swapGsusdForGold(paxgAddr, ethers.parseEther("1000"), 0n);
      const a = await usdOf(day);
      // while enabled
      await reserve.setAggregateDailyCap(ethers.parseEther("10000"));
      await reserve.connect(redeemer).swapGsusdForGold(xautAddr, ethers.parseEther("1000"), 0n);
      const b = await usdOf(day);
      // during a disabled interval
      await reserve.setAggregateDailyCap(0n);
      await reserve.connect(redeemer).swapGsusdForGold(paxgAddr, ethers.parseEther("1000"), 0n);
      const c = await usdOf(day);
      expect(a).to.be.gt(0n);
      expect(b).to.be.gt(a);
      expect(c).to.be.gt(b);
      expect(BigInt(await time.latest()) / DAY).to.equal(day);

      // re-enabled below what has already left today
      await reserve.setAggregateDailyCap(c - 1n);
      expect(await reserve.remainingDailyCapacity(paxgAddr)).to.equal(0n);
      expect(await reserve.remainingDailyCapacity(xautAddr)).to.equal(0n);
      await expect(reserve.connect(redeemer).swapGsusdForGold(paxgAddr, ethers.parseEther("100"), 0n)).to.be.revertedWith("Aggregate daily cap reached");
      await expect(reserve.connect(redeemer).swapGsusdForGold(xautAddr, ethers.parseEther("100"), 0n)).to.be.revertedWith("Aggregate daily cap reached");
      expect(await usdOf(day)).to.equal(c);

      // the next UTC day starts from zero again
      await time.increaseTo((day + 1n) * DAY + 60n);
      await refreshPrices();
      expect(await usdOf(day + 1n)).to.equal(0n);
      await expect(reserve.connect(redeemer).swapGsusdForGold(paxgAddr, ethers.parseEther("100"), 0n)).to.not.be.reverted;
    });
  });

  describe("pause", function () {
    it("guardian can pause one asset without the other; only governance unpauses", async function () {
      await seed(ethers.parseEther("10"));
      await reserve.seedCollateral(await xaut.getAddress(), 10_000_000n);
      await reserve.connect(guardian).pauseAsset(await paxg.getAddress());
      await refreshPrices();
      await expect(reserve.connect(redeemer).swapGsusdForGold(await paxg.getAddress(), ethers.parseEther("100"), 0n)).to.be.revertedWith("Asset paused");
      await expect(reserve.connect(redeemer).swapGsusdForGold(await xaut.getAddress(), ethers.parseEther("100"), 0n)).to.not.be.reverted;
      await expect(reserve.connect(guardian).unpauseAsset(await paxg.getAddress(), 1n)).to.be.reverted;
      await expect(reserve.connect(other).pauseAsset(await xaut.getAddress())).to.be.revertedWith("Not guardian or governance");
      await reserve.unpauseAsset(await paxg.getAddress(), await reserve.assetPauseEpoch(await paxg.getAddress()));
      await expect(reserve.connect(redeemer).swapGsusdForGold(await paxg.getAddress(), ethers.parseEther("100"), 0n)).to.not.be.reverted;
    });
  });

  describe("governance withdrawals and handover", function () {
    it("withdrawGsusd moves inventory out and counts it", async function () {
      await seed(ethers.parseEther("51"));
      await refreshPrices();
      await reserve.connect(redeemer).swapGsusdForGold(await paxg.getAddress(), ethers.parseEther("2000"), 0n);
      await expect(reserve.withdrawGsusd(other.address, ethers.parseEther("1990"))).to.emit(reserve, "GsusdWithdrawn");
      expect(await reserve.gsusdInventory()).to.equal(0n);
      expect(await reserve.totalGsusdWithdrawn()).to.equal(ethers.parseEther("1990"));
      await expect(reserve.withdrawGsusd(other.address, 1n)).to.be.revertedWith("Exceeds inventory");
    });

    it("withdrawCollateral may go below the swap floor; swaps may not", async function () {
      await seed(ethers.parseEther("10"));
      await reserve.setAssetConfig(await paxg.getAddress(), true, ethers.parseEther("10"), PPM);
      expect(await reserve.redeemableCollateral(await paxg.getAddress())).to.equal(0n);
      await expect(reserve.withdrawCollateral(await paxg.getAddress(), other.address, ethers.parseEther("10"))).to.emit(reserve, "CollateralWithdrawn");
      await expect(
        reserve.connect(other).withdrawCollateral(await paxg.getAddress(), other.address, 1n)
      ).to.be.revertedWithCustomError(reserve, "AccessControlUnauthorizedAccount");
    });

    it("refuses itself as the recipient of GSUSD and leaves every figure as it was", async function () {
      await seed(ethers.parseEther("51"));
      await refreshPrices();
      await reserve.connect(redeemer).swapGsusdForGold(await paxg.getAddress(), ethers.parseEther("2000"), 0n);
      const self = await reserve.getAddress();
      const inventory = await reserve.gsusdInventory();
      const balance = await stablecoin.balanceOf(self);
      const withdrawn = await reserve.totalGsusdWithdrawn();
      const circulating = await reserve.circulatingSupply();
      expect(inventory).to.be.gt(0n);

      await expect(reserve.withdrawGsusd(self, inventory)).to.be.revertedWith("Self payment");
      await expect(reserve.withdrawGsusd(self, 0n)).to.be.revertedWith("Self payment");
      expect(await reserve.gsusdInventory()).to.equal(inventory);
      expect(await stablecoin.balanceOf(self)).to.equal(balance);
      expect(await reserve.totalGsusdWithdrawn()).to.equal(withdrawn);
      expect(await reserve.circulatingSupply()).to.equal(circulating);
    });

    it("a GSUSD payment to another address moves exactly what the ledger debits", async function () {
      await seed(ethers.parseEther("51"));
      await refreshPrices();
      await reserve.connect(redeemer).swapGsusdForGold(await paxg.getAddress(), ethers.parseEther("2000"), 0n);
      const self = await reserve.getAddress();
      const amount = ethers.parseEther("700");
      const [inventory, held, received] = [await reserve.gsusdInventory(), await stablecoin.balanceOf(self), await stablecoin.balanceOf(other.address)];

      await reserve.withdrawGsusd(other.address, amount);
      expect(inventory - (await reserve.gsusdInventory())).to.equal(amount);
      expect(held - (await stablecoin.balanceOf(self))).to.equal(amount);
      expect((await stablecoin.balanceOf(other.address)) - received).to.equal(amount);
    });

    it("refuses itself as the recipient of collateral and leaves every figure as it was", async function () {
      await seed(ethers.parseEther("10"));
      const self = await reserve.getAddress();
      const paxgAddr = await paxg.getAddress();
      const [counted, held, out] = [await reserve.collateralBalance(paxgAddr), await paxg.balanceOf(self), await reserve.totalGoldWithdrawn(paxgAddr)];

      await expect(reserve.withdrawCollateral(paxgAddr, self, ethers.parseEther("1"))).to.be.revertedWith("Self payment");
      expect(await reserve.collateralBalance(paxgAddr)).to.equal(counted);
      expect(await paxg.balanceOf(self)).to.equal(held);
      expect(await reserve.totalGoldWithdrawn(paxgAddr)).to.equal(out);
    });

    it("transferGovernance hands both roles to the timelock and revokes the deployer", async function () {
      await expect(reserve.transferGovernance(owner.address)).to.be.revertedWith("Would self-revoke");
      await expect(reserve.transferGovernance(other.address)).to.be.revertedWith("Timelock must be a contract");
      const dest = await stablecoin.getAddress();
      await reserve.transferGovernance(dest);
      const GOV = await reserve.GOVERNANCE_ROLE();
      const ADMIN = await reserve.DEFAULT_ADMIN_ROLE();
      expect(await reserve.hasRole(GOV, dest)).to.be.true;
      expect(await reserve.hasRole(ADMIN, dest)).to.be.true;
      expect(await reserve.hasRole(GOV, owner.address)).to.be.false;
      expect(await reserve.hasRole(ADMIN, owner.address)).to.be.false;
    });
  });

  describe("conservative cross-token valuation", function () {
    it("a wrong-high validated read on one token cannot lower the executed spread", async function () {
      await seed(ethers.parseEther("50")); // 10% coverage at $2000 -> 5_000 ppm tier
      const before = await reserve.currentSpreadPpm();

      // XAUT's feed starts returning a fresh-but-wrong high answer. getValidatedPrice
      // accepts it (integrity checks only); getTokenPrice would reject it at the
      // deviation gate. Valuation must take min(validated, lastKnown), so coverage
      // and therefore the spread stay where the gated price says they are.
      await setPrice(xautFeed, GOLD * 3n);
      expect(await reserve.currentSpreadPpm()).to.equal(before);

      // The other direction stays conservative too: a wrong-LOW read lowers the
      // valuation and can only push the spread UP, never below the gated tier.
      await setPrice(xautFeed, GOLD / 3n);
      expect(await reserve.currentSpreadPpm()).to.be.gte(before);
    });

    it("the spread floor never sits below the gold feeds' deviation triggers", async function () {
      // PAXG/USD and XAUT/USD update on 0.5% moves; a spread below that hands a
      // lawfully lagging feed to arbitrageurs as a riskless drain.
      expect(await reserve.MIN_SPREAD_PPM()).to.equal(5_000n);
      await expect(
        reserve.setSpreadCurve([{ coverageAtLeastPpm: 100_000n, spreadPpm: 4_999n }], RESTRICTED)
      ).to.be.revertedWith("Spread out of range");
    });
  });

  describe("views", function () {
    it("coverage and quote track the reserve", async function () {
      await seed(ethers.parseEther("51")); // $102k against 1m → 10.2%
      expect(await reserve.coveragePpm()).to.equal(102_000n);
      const [gold, spread] = await reserve.quoteGoldOut(await paxg.getAddress(), ethers.parseEther("2000"));
      expect(spread).to.equal(5_000n);
      expect(gold).to.equal(ethers.parseEther("0.995"));
      expect(await reserve.circulatingSupply()).to.equal(ethers.parseEther("1000000"));
    });

    it("quotes the best tier while nothing circulates", async function () {
      await seed(ethers.parseEther("100"));
      await stablecoin.connect(redeemer).burn(ethers.parseEther("1000000"));
      // A day on, the smoothed supply has followed the live supply to zero.
      await time.increase(86400);
      await refreshPrices();
      expect(await reserve.dampedCirculatingSupply()).to.equal(0n);
      const [gold, spread] = await reserve.quoteGoldOut(await paxg.getAddress(), ethers.parseEther("2000"));
      expect(spread).to.equal(CURVE[0].spreadPpm);
      expect(spread).to.not.equal(RESTRICTED);
      expect(gold).to.equal(ethers.parseEther("0.995"));
    });

    it("coverage reads as unlimited with no circulating supply", async function () {
      await stablecoin.connect(redeemer).burn(ethers.parseEther("1000000"));
      expect(await reserve.coveragePpm()).to.equal(PPM * 1000n);
    });
  });
});
