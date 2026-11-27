import { expect } from "chai";
import { ethers } from "hardhat";
import { BaseContract } from "ethers";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { productionSystem, setValidPrice, GOLD_PRICE } from "./helpers/productionSystem";

/**
 * Branch coverage for GoldStabilityReserve: every guard, ternary and modifier arm the
 * behavioural suites leave untaken. Each test names the branch it takes.
 */

const PPM = 1_000_000n;
const ONE_DOLLAR = 100_000_000n; // 8-decimal oracle price
const STALE = 3601; // one second past the fixture's 3600 s staleness threshold

type System = Awaited<ReturnType<typeof productionSystem>>;

function unauthorised(contract: BaseContract, call: Promise<unknown>) {
  return expect(call).to.be.revertedWithCustomError(contract, "AccessControlUnauthorizedAccount");
}

/** Gold a given net GSUSD amount buys at an 8-decimal price, in the token's decimals. */
function goldFor(net: bigint, priceE8: bigint, decimals: bigint): bigint {
  return (net * 10n ** decimals) / (priceE8 * 10n ** 10n);
}

/** Seed PAXG into the reserve from the deployer. */
async function seedPaxg(sys: System, amount: bigint) {
  const reserveAddr = await sys.reserve.getAddress();
  await sys.paxg.mint(sys.deployer.address, amount);
  await sys.paxg.approve(reserveAddr, amount);
  await sys.reserve.seedCollateral(await sys.paxg.getAddress(), amount);
}

/**
 * A third 18-decimal gold token that the oracle lists but has never been asked to price,
 * so its lastKnownPrice is zero. With `priceE8` null the feed has no round at all.
 */
async function addThirdToken(sys: System, priceE8: bigint | null) {
  const MockToken = await ethers.getContractFactory("MockERC20");
  const third = await MockToken.deploy("Third Gold", "TGLD", 18);
  const MockAgg = await ethers.getContractFactory("MockAggregatorV3");
  const feed = await MockAgg.deploy(8);
  if (priceE8 !== null) await setValidPrice(feed, priceE8);
  const thirdAddr = await third.getAddress();
  await sys.oracle.addFeed(thirdAddr, await feed.getAddress());
  await sys.reserve.setAssetConfig(thirdAddr, true, 0n, PPM);
  return { third, thirdAddr, feed };
}

/**
 * The GSUSD input that makes a swap deliver exactly `gold`. Verified against the
 * contract's own quote before it is returned, so the test cannot drift from the maths.
 */
async function gsusdForExactGold(sys: System, token: string, gold: bigint, priceE8: bigint, decimals: bigint) {
  const spread = await sys.reserve.currentSpreadPpm();
  const scale = 10n ** decimals;
  const denominator = priceE8 * 10n ** 10n;
  const netNeeded = (gold * denominator + scale - 1n) / scale;
  const gsusdIn = (netNeeded * PPM) / (PPM - spread) + 1n;
  const [quoted] = await sys.reserve.quoteGoldOut(token, gsusdIn);
  expect(quoted).to.equal(gold);
  return gsusdIn;
}

describe("GoldStabilityReserve branch coverage", function () {
  describe("swapGsusdForGold", function () {
    it("routes nothing when the spread on a tiny swap rounds to zero", async function () {
      const sys = await loadFixture(productionSystem);
      const { reserve, alice, deployer } = sys;
      const { third, thirdAddr } = await addThirdToken(sys, ONE_DOLLAR);

      // A large seed keeps coverage in the cheapest tier so the spread is 0.5%.
      const seed = ethers.parseEther("100000");
      await third.mint(deployer.address, seed);
      await third.approve(await reserve.getAddress(), seed);
      await reserve.seedCollateral(thirdAddr, seed);
      expect(await reserve.currentSpreadPpm()).to.equal(5_000n);

      // 100 wei × 0.5% is below one wei, so the fee is zero and _routeSpread returns early.
      await expect(reserve.connect(alice).swapGsusdForGold(thirdAddr, 100n, 0n))
        .to.emit(reserve, "Swapped")
        .withArgs(alice.address, thirdAddr, 100n, 100n, 5_000n, 0n);
      expect(await reserve.totalSpreadPaid()).to.equal(0n);
      expect(await reserve.gsusdInventory()).to.equal(100n);
      expect(await third.balanceOf(alice.address)).to.equal(100n);
    });

    it("is stopped by the oracle before the reserve's own zero-price guard can see a zero answer", async function () {
      // A zero answer is a stopped source, so getTokenPrice never returns zero and the
      // reserve's `require(price > 0)` is shadowed. This pins the behaviour that makes that
      // guard unreachable through the production oracle.
      const sys = await loadFixture(productionSystem);
      const { reserve, alice, paxg, paxgFeed } = sys;
      const ts = await time.latest();
      await paxgFeed.setLatestRoundData(1, 0n, ts, ts, 1);
      await expect(reserve.connect(alice).swapGsusdForGold(await paxg.getAddress(), ethers.parseEther("1"), 0n))
        .to.be.revertedWith("No reliable price");
    });
  });

  describe("funding", function () {
    it("refuses to seed a zero amount", async function () {
      const { reserve, paxg } = await loadFixture(productionSystem);
      await expect(reserve.seedCollateral(await paxg.getAddress(), 0n)).to.be.revertedWith("Zero amount");
    });

    it("refuses depositCollateral from an account without VAULT_ROLE", async function () {
      const { reserve, paxg, bob } = await loadFixture(productionSystem);
      await unauthorised(reserve, reserve.connect(bob).depositCollateral(await paxg.getAddress(), 1n));
    });

    it("credits depositCollateral from a VAULT_ROLE holder to the penalty counter", async function () {
      const { reserve, paxg, deployer } = await loadFixture(productionSystem);
      const paxgAddr = await paxg.getAddress();
      await reserve.grantRole(await reserve.VAULT_ROLE(), deployer.address);
      await paxg.mint(deployer.address, ethers.parseEther("2"));
      await paxg.approve(await reserve.getAddress(), ethers.parseEther("2"));
      await expect(reserve.depositCollateral(paxgAddr, ethers.parseEther("2")))
        .to.emit(reserve, "CollateralDeposited")
        .withArgs(paxgAddr, ethers.parseEther("2"), ethers.parseEther("2"));
      expect(await reserve.totalGoldFromPenalties(paxgAddr)).to.equal(ethers.parseEther("2"));
      expect(await reserve.totalGoldSeeded(paxgAddr)).to.equal(0n);
    });
  });

  describe("reserveValueUsd", function () {
    it("values a token the oracle has never priced at its live feed", async function () {
      const sys = await loadFixture(productionSystem);
      const { reserve, oracle, deployer } = sys;
      const { third, thirdAddr } = await addThirdToken(sys, ONE_DOLLAR);
      expect(await oracle.getLastKnownPrice(thirdAddr)).to.equal(0n);

      const seed = ethers.parseEther("1000");
      await third.mint(deployer.address, seed);
      await third.approve(await reserve.getAddress(), seed);
      await reserve.seedCollateral(thirdAddr, seed);

      // 1000 tokens at one dollar: the live read is used because there is no last known.
      expect(await reserve.reserveValueUsd()).to.equal(ethers.parseEther("1000"));
    });

    it("values at the lower of the market feed and gold while both are healthy", async function () {
      const sys = await loadFixture(productionSystem);
      const { reserve, paxgFeed, oracle } = sys;
      await seedPaxg(sys, ethers.parseEther("1"));
      const gold = await (await ethers.getContractFactory("MockAggregatorV3")).deploy(8);
      await setValidPrice(gold, 2000n * ONE_DOLLAR);
      await oracle.setAnchorFeed(await gold.getAddress());

      await setValidPrice(paxgFeed, 1900n * ONE_DOLLAR);
      expect(await reserve.reserveValueUsd()).to.equal(ethers.parseEther("1900"));

      await setValidPrice(paxgFeed, 2100n * ONE_DOLLAR);
      expect(await reserve.reserveValueUsd()).to.equal(ethers.parseEther("2000"));

      // Gold stopped: nothing current bounds the value, so the token is left out.
      await setValidPrice(paxgFeed, 2000n * ONE_DOLLAR);
      const now = await time.latest();
      await gold.setLatestRoundData(1, 2000n * ONE_DOLLAR, now - STALE, now - STALE, 1);
      expect(await reserve.reserveValueUsd()).to.equal(0n);
    });

    it("leaves a token out once its market feed is stale, never valuing it at the last known price", async function () {
      const sys = await loadFixture(productionSystem);
      const { reserve, paxgFeed, oracle } = sys;
      await seedPaxg(sys, ethers.parseEther("1"));
      await setValidPrice(paxgFeed, 1900n * ONE_DOLLAR);
      expect(await reserve.reserveValueUsd()).to.equal(ethers.parseEther("1900"));

      await time.increase(STALE);
      expect(await oracle.getLastKnownPrice(await sys.paxg.getAddress())).to.be.gt(0n);
      expect(await reserve.reserveValueUsd()).to.equal(0n);
    });

    it("counts a token with neither a live nor a last known price at zero", async function () {
      const sys = await loadFixture(productionSystem);
      const { reserve, deployer } = sys;
      await seedPaxg(sys, ethers.parseEther("1"));
      const { third, thirdAddr } = await addThirdToken(sys, null);

      const seed = ethers.parseEther("5");
      await third.mint(deployer.address, seed);
      await third.approve(await reserve.getAddress(), seed);
      await reserve.seedCollateral(thirdAddr, seed);

      expect(await reserve.reserveValueUsd()).to.equal(ethers.parseEther("2000"));
    });
  });

  describe("damped circulating supply", function () {
    it("prices against the live supply when a mint lifts it above the smoothed average", async function () {
      const { reserve, stablecoin, bob } = await loadFixture(productionSystem);
      await stablecoin.mint(bob.address, ethers.parseEther("1000"));

      const live = await reserve.circulatingSupply();
      expect(live).to.be.gt(await stablecoin.smoothedSupplyNow());
      expect(await reserve.dampedCirculatingSupply()).to.equal(live);
    });

    it("prices against the smoothed supply when a burn has just shrunk the live supply", async function () {
      const { reserve, stablecoin, alice } = await loadFixture(productionSystem);
      await time.increase(24 * 60 * 60); // the average has caught up with the fixture's mints
      await stablecoin.connect(alice).burn(ethers.parseEther("2000"));

      const live = await reserve.circulatingSupply();
      const damped = await reserve.dampedCirculatingSupply();
      expect(damped).to.be.gt(live);
      expect(damped).to.equal(await stablecoin.smoothedSupplyNow());
    });

    it("reports unlimited damped coverage when nothing is in circulation", async function () {
      const { oracle } = await loadFixture(productionSystem);
      const StablecoinF = await ethers.getContractFactory("GoldStablecoin");
      const emptyStablecoin = await StablecoinF.deploy();
      const ReserveF = await ethers.getContractFactory("GoldStabilityReserve");
      const emptyReserve = await ReserveF.deploy(await emptyStablecoin.getAddress(), await oracle.getAddress());

      expect(await emptyReserve.circulatingSupply()).to.equal(0n);
      expect(await emptyReserve.dampedCoveragePpm()).to.equal(PPM * 1000n);
      expect(await emptyReserve.coveragePpm()).to.equal(PPM * 1000n);
    });
  });

  describe("remainingDailyCapacity", function () {
    it("is zero for an unsupported token", async function () {
      const { reserve, stablecoin } = await loadFixture(productionSystem);
      expect(await reserve.remainingDailyCapacity(await stablecoin.getAddress())).to.equal(0n);
    });

    it("is zero for a paused token even when it holds gold", async function () {
      const sys = await loadFixture(productionSystem);
      const { reserve, paxg, guardian } = sys;
      const paxgAddr = await paxg.getAddress();
      await seedPaxg(sys, ethers.parseEther("10"));
      expect(await reserve.remainingDailyCapacity(paxgAddr)).to.equal(ethers.parseEther("10"));
      await reserve.connect(guardian).pauseAsset(paxgAddr);
      expect(await reserve.remainingDailyCapacity(paxgAddr)).to.equal(0n);
    });

    it("is bounded by the floor when the floor leaves less than the day allows", async function () {
      const sys = await loadFixture(productionSystem);
      const { reserve, paxg } = sys;
      const paxgAddr = await paxg.getAddress();
      await seedPaxg(sys, ethers.parseEther("10"));
      await reserve.setAssetConfig(paxgAddr, true, ethers.parseEther("9"), PPM);
      expect(await reserve.remainingDailyCapacity(paxgAddr)).to.equal(ethers.parseEther("1"));
    });

    it("is bounded by the day when the cap leaves less than the floor allows", async function () {
      const sys = await loadFixture(productionSystem);
      const { reserve, paxg } = sys;
      const paxgAddr = await paxg.getAddress();
      await seedPaxg(sys, ethers.parseEther("10"));
      await reserve.setAssetConfig(paxgAddr, true, 0n, 500_000n);
      expect(await reserve.remainingDailyCapacity(paxgAddr)).to.equal(ethers.parseEther("5"));
    });

    it("is zero when the daily cap is zero", async function () {
      const sys = await loadFixture(productionSystem);
      const { reserve, paxg } = sys;
      const paxgAddr = await paxg.getAddress();
      await seedPaxg(sys, ethers.parseEther("10"));
      await reserve.setAssetConfig(paxgAddr, true, 0n, 0n);
      expect(await reserve.remainingDailyCapacity(paxgAddr)).to.equal(0n);
    });

    it("is zero once the whole day's cap has been swapped out", async function () {
      const sys = await loadFixture(productionSystem);
      const { reserve, paxg, alice } = sys;
      const paxgAddr = await paxg.getAddress();
      await seedPaxg(sys, ethers.parseEther("10"));
      await reserve.setAssetConfig(paxgAddr, true, 0n, 500_000n);

      const cap = await reserve.remainingDailyCapacity(paxgAddr);
      expect(cap).to.equal(ethers.parseEther("5"));
      const gsusdIn = await gsusdForExactGold(sys, paxgAddr, cap, GOLD_PRICE, 18n);
      await reserve.connect(alice).swapGsusdForGold(paxgAddr, gsusdIn, cap);

      expect(await reserve.collateralBalance(paxgAddr)).to.equal(ethers.parseEther("5"));
      expect(await reserve.remainingDailyCapacity(paxgAddr)).to.equal(0n);
      await expect(reserve.connect(alice).swapGsusdForGold(paxgAddr, ethers.parseEther("2000"), 0n))
        .to.be.revertedWith("Daily cap reached");
    });
  });

  describe("quoteGoldOut", function () {
    it("returns nothing for an unsupported token", async function () {
      const { reserve, stablecoin } = await loadFixture(productionSystem);
      const [goldOut, spread] = await reserve.quoteGoldOut(await stablecoin.getAddress(), ethers.parseEther("1"));
      expect(goldOut).to.equal(0n);
      expect(spread).to.equal(0n);
    });

    it("quotes at the price a swap executes at, and nothing once the oracle would refuse it", async function () {
      const { reserve, paxg, paxgFeed } = await loadFixture(productionSystem);
      const paxgAddr = await paxg.getAddress();
      const gsusdIn = ethers.parseEther("2000");
      // An empty reserve sits in the restricted tier.
      const restricted = 20_000n;
      const net = gsusdIn - (gsusdIn * restricted) / PPM;

      await setValidPrice(paxgFeed, 1900n * ONE_DOLLAR);
      const [freshGold, freshSpread] = await reserve.quoteGoldOut(paxgAddr, gsusdIn);
      expect(freshSpread).to.equal(restricted);
      expect(freshGold).to.equal(goldFor(net, 1900n * ONE_DOLLAR, 18n));

      // A stale feed: the swap would revert "No reliable price", so there is no preview.
      await time.increase(STALE);
      const [staleGold, staleSpread] = await reserve.quoteGoldOut(paxgAddr, gsusdIn);
      expect(staleGold).to.equal(0n);
      expect(staleSpread).to.equal(0n);
    });

    it("returns nothing when neither a live nor a last known price exists", async function () {
      const sys = await loadFixture(productionSystem);
      const { thirdAddr } = await addThirdToken(sys, null);
      const [goldOut, spread] = await sys.reserve.quoteGoldOut(thirdAddr, ethers.parseEther("1"));
      expect(goldOut).to.equal(0n);
      expect(spread).to.equal(0n);
    });
  });

  describe("pauseAsset and unpauseAsset", function () {
    it("refuses a pause from an account that is neither guardian nor governance", async function () {
      const { reserve, paxg, bob } = await loadFixture(productionSystem);
      await expect(reserve.connect(bob).pauseAsset(await paxg.getAddress()))
        .to.be.revertedWith("Not guardian or governance");
    });

    it("lets the guardian pause an asset", async function () {
      const { reserve, xaut, guardian } = await loadFixture(productionSystem);
      const xautAddr = await xaut.getAddress();
      await expect(reserve.connect(guardian).pauseAsset(xautAddr))
        .to.emit(reserve, "AssetPaused")
        .withArgs(xautAddr, guardian.address);
      expect(await reserve.assetPaused(xautAddr)).to.equal(true);
      // The pause lapses on its own.
      expect((await reserve.assets(xautAddr)).pausedUntil).to.equal(
        BigInt(await time.latest()) + (await reserve.ASSET_PAUSE_DURATION())
      );
    });

    it("lets governance pause an asset", async function () {
      const { reserve, paxg, deployer } = await loadFixture(productionSystem);
      const paxgAddr = await paxg.getAddress();
      await expect(reserve.pauseAsset(paxgAddr)).to.emit(reserve, "AssetPaused").withArgs(paxgAddr, deployer.address);
      expect(await reserve.assetPaused(paxgAddr)).to.equal(true);
    });

    it("refuses to pause an unsupported token", async function () {
      const { reserve, stablecoin, guardian } = await loadFixture(productionSystem);
      await expect(reserve.connect(guardian).pauseAsset(await stablecoin.getAddress()))
        .to.be.revertedWith("Unsupported token");
    });

    it("refuses to unpause from a non-governance account and refuses an unsupported token", async function () {
      const { reserve, paxg, stablecoin, guardian } = await loadFixture(productionSystem);
      await unauthorised(reserve, reserve.connect(guardian).unpauseAsset(await paxg.getAddress(), 0n));
      await expect(reserve.unpauseAsset(await stablecoin.getAddress(), 0n)).to.be.revertedWith("Unsupported token");
    });
  });

  describe("setAssetConfig", function () {
    it("refuses a caller without GOVERNANCE_ROLE", async function () {
      const { reserve, paxg, bob } = await loadFixture(productionSystem);
      await unauthorised(reserve, reserve.connect(bob).setAssetConfig(await paxg.getAddress(), true, 0n, PPM));
    });

    it("refuses a daily cap above 100%", async function () {
      const { reserve, paxg } = await loadFixture(productionSystem);
      await expect(reserve.setAssetConfig(await paxg.getAddress(), true, 0n, PPM + 1n))
        .to.be.revertedWith("Cap exceeds 100%");
    });

    it("refuses a token with more than 18 decimals", async function () {
      const { reserve } = await loadFixture(productionSystem);
      const MockToken = await ethers.getContractFactory("MockERC20");
      const odd = await MockToken.deploy("Odd Gold", "ODD", 24);
      await expect(reserve.setAssetConfig(await odd.getAddress(), true, 0n, PPM))
        .to.be.revertedWith("Decimals must be <= 18");
    });
  });

  describe("setSpreadCurve", function () {
    it("refuses a caller without GOVERNANCE_ROLE", async function () {
      const { reserve, bob } = await loadFixture(productionSystem);
      await unauthorised(reserve, reserve.connect(bob).setSpreadCurve([], 20_000n));
    });

    it("refuses more steps than MAX_SPREAD_STEPS", async function () {
      const { reserve } = await loadFixture(productionSystem);
      const max = await reserve.MAX_SPREAD_STEPS();
      const steps = Array.from({ length: Number(max) + 1 }, (_, i) => ({
        coverageAtLeastPpm: 900_000n - BigInt(i) * 100_000n,
        spreadPpm: 5_000n,
      }));
      await expect(reserve.setSpreadCurve(steps, 20_000n)).to.be.revertedWith("Too many steps");
    });
  });

  describe("other governance setters", function () {
    it("refuses setAggregateDailyCap from a caller without GOVERNANCE_ROLE", async function () {
      const { reserve, bob } = await loadFixture(productionSystem);
      await unauthorised(reserve, reserve.connect(bob).setAggregateDailyCap(1n));
    });

    it("refuses setOracle from a stranger and refuses the zero address", async function () {
      const { reserve, oracle, bob } = await loadFixture(productionSystem);
      await unauthorised(reserve, reserve.connect(bob).setOracle(await oracle.getAddress()));
      await expect(reserve.setOracle(ethers.ZeroAddress)).to.be.revertedWith("Zero address");
    });

    it("refuses setSurplusBuffer from a caller without GOVERNANCE_ROLE", async function () {
      const { reserve, surplusBuffer, bob } = await loadFixture(productionSystem);
      await unauthorised(reserve, reserve.connect(bob).setSurplusBuffer(await surplusBuffer.getAddress()));
    });
  });

  describe("withdrawals", function () {
    it("refuses withdrawGsusd from a stranger and refuses the zero address", async function () {
      const { reserve, bob } = await loadFixture(productionSystem);
      await unauthorised(reserve, reserve.connect(bob).withdrawGsusd(bob.address, 0n));
      await expect(reserve.withdrawGsusd(ethers.ZeroAddress, 0n)).to.be.revertedWith("Zero address");
    });

    it("refuses withdrawCollateral from a stranger, to the zero address and above the balance", async function () {
      const { reserve, paxg, bob, deployer } = await loadFixture(productionSystem);
      const paxgAddr = await paxg.getAddress();
      await unauthorised(reserve, reserve.connect(bob).withdrawCollateral(paxgAddr, bob.address, 0n));
      await expect(reserve.withdrawCollateral(paxgAddr, ethers.ZeroAddress, 0n)).to.be.revertedWith("Zero address");
      await expect(reserve.withdrawCollateral(paxgAddr, deployer.address, 1n)).to.be.revertedWith("Exceeds balance");
    });
  });

  describe("role administration", function () {
    it("refuses grantGuardianRole from a stranger and refuses the zero address", async function () {
      const { reserve, bob } = await loadFixture(productionSystem);
      await unauthorised(reserve, reserve.connect(bob).grantGuardianRole(bob.address));
      await expect(reserve.grantGuardianRole(ethers.ZeroAddress)).to.be.revertedWith("Zero address");
    });

    it("refuses transferGovernance from a stranger and refuses the zero address", async function () {
      const { reserve, timelockAddr, bob } = await loadFixture(productionSystem);
      await unauthorised(reserve, reserve.connect(bob).transferGovernance(timelockAddr));
      await expect(reserve.transferGovernance(ethers.ZeroAddress)).to.be.revertedWith("Zero address");
    });
  });
});
