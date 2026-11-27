import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import type { GoldOracle, MockAggregatorV3 } from "../typechain-types";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { productionSystem, setValidPrice } from "./helpers/productionSystem";

/**
 * The two source rules of docs/ORACLE_IMPLEMENTATION_PLAN.md sections 3 and 4, at the oracle.
 * C is the token's Chainlink market feed, G the XAU/USD reference. The gold band g gates
 * borrowing and reserve swaps; liquidation prices at min(max(C, G), G x (1 + m)), m the
 * liquidation cap. Whenever C or G is unhealthy every priced path refuses. The Foundry suite
 * OracleClamp drives the same rules through the vault and the reserve.
 */
describe("GoldOracle two source rules (plan sections 3 and 4)", function () {
  const GOLD = 400_000_000_000n; // $4000, 8 decimals
  const below = (x: bigint, ppm: bigint) => (x * (1_000_000n - ppm)) / 1_000_000n;
  const above = (x: bigint, ppm: bigint) => (x * (1_000_000n + ppm)) / 1_000_000n;
  const STALE = 100_000;
  let oracle: GoldOracle;
  let paxgFeed: MockAggregatorV3;
  let xautFeed: MockAggregatorV3;
  let anchor: MockAggregatorV3;
  let stranger: HardhatEthersSigner;
  const paxg = ethers.getAddress("0x000000000000000000000000000000000000ba76");
  const xaut = ethers.getAddress("0x0000000000000000000000000000000000007a07");

  async function push(feed: MockAggregatorV3, price: bigint, age = 0) {
    const now = BigInt(await time.latest());
    await feed.setLatestRoundData(1, price, now - BigInt(age), now - BigInt(age), 1);
  }

  /** XAUT's C and gold; PAXG follows gold. */
  async function set(c: bigint, g: bigint) {
    await push(xautFeed, c);
    await push(anchor, g);
    await push(paxgFeed, g);
  }

  async function liquidatesAt(price: bigint) {
    expect(await oracle.quoteTokenPrice(xaut)).to.equal(price);
    await oracle.getTokenPrice(xaut);
    expect(await oracle.getLastKnownPrice(xaut)).to.equal(price);
  }

  async function liquidationRefused(reason: string) {
    await expect(oracle.quoteTokenPrice(xaut)).to.be.revertedWith(reason);
    await expect(oracle.getTokenPrice(xaut)).to.be.revertedWith(reason);
  }

  async function borrowsAt(price: bigint) {
    expect(await oracle.quoteBorrowPrice(xaut)).to.equal(price);
    await oracle.getBorrowPrice(xaut);
  }

  async function borrowRefused(reason: string) {
    await expect(oracle.quoteBorrowPrice(xaut)).to.be.revertedWith(reason);
    await expect(oracle.getBorrowPrice(xaut)).to.be.revertedWith(reason);
  }

  async function reserveAt(price: bigint) {
    expect(await oracle.quoteReservePrice(xaut)).to.equal(price);
    await oracle.getReservePrice(xaut);
  }

  async function reserveRefused(reason: string) {
    await expect(oracle.quoteReservePrice(xaut)).to.be.revertedWith(reason);
    await expect(oracle.getReservePrice(xaut)).to.be.revertedWith(reason);
  }

  beforeEach(async function () {
    [, stranger] = await ethers.getSigners();
    const Agg = await ethers.getContractFactory("MockAggregatorV3");
    paxgFeed = await Agg.deploy(8);
    xautFeed = await Agg.deploy(8);
    anchor = await Agg.deploy(8);
    for (const f of [paxgFeed, xautFeed, anchor]) await push(f, GOLD);
    oracle = await (await ethers.getContractFactory("GoldOracle")).deploy(
      await paxgFeed.getAddress(),
      await xautFeed.getAddress(),
      paxg,
      xaut,
      90_000
    );
    await oracle.setAnchorFeed(await anchor.getAddress());
  });

  describe("parameters", function () {
    it("seeds a 2% band and a 2% liquidation cap per token", async function () {
      expect(await oracle.goldBandPpm(xaut)).to.equal(20_000n);
      expect(await oracle.liquidationClampPpm(xaut)).to.equal(20_000n);
      expect(await oracle.DEFAULT_LIQUIDATION_CLAMP_PPM()).to.equal(20_000n);
    });

    it("bounds the cap to 0.5% .. 8%, governance only, per token", async function () {
      await expect(oracle.setLiquidationClamp(xaut, 4_999)).to.be.revertedWith("Clamp out of range");
      await expect(oracle.setLiquidationClamp(xaut, 50_001)).to.be.revertedWith("Clamp out of range");
      await expect(oracle.setLiquidationClamp(stranger.address, 20_000)).to.be.revertedWith("Unsupported token");
      await expect(oracle.connect(stranger).setLiquidationClamp(xaut, 20_000)).to.be.reverted;
      await expect(oracle.setLiquidationClamp(xaut, 30_000))
        .to.emit(oracle, "LiquidationClampUpdated")
        .withArgs(xaut, 30_000n);
      expect(await oracle.liquidationClampPpm(xaut)).to.equal(30_000n);
      expect(await oracle.liquidationClampPpm(paxg)).to.equal(20_000n);
    });
  });

  describe("C and G healthy", function () {
    it("borrows at the lower of C and G inside the band, refuses outside it", async function () {
      await set(below(GOLD, 10_000n), GOLD);
      await borrowsAt(below(GOLD, 10_000n));
      await set(above(GOLD, 20_000n), GOLD);
      await borrowsAt(GOLD);
      await set(above(GOLD, 20_001n), GOLD);
      await borrowRefused("Off gold band");
      await set(below(GOLD, 20_001n), GOLD);
      await borrowRefused("Off gold band");
    });

    it("trades reserve gold at the higher of C and G inside the band, refuses outside it", async function () {
      await set(below(GOLD, 15_000n), GOLD);
      await reserveAt(GOLD);
      await set(above(GOLD, 15_000n), GOLD);
      await reserveAt(above(GOLD, 15_000n));
      await set(below(GOLD, 300_000n), GOLD);
      await reserveRefused("Off gold band");
    });

    it("never values collateral below gold: a push of C down liquidates at G", async function () {
      for (const ppm of [0n, 1n, 15_000n, 300_000n, 999_000n]) {
        await set(below(GOLD, ppm), GOLD);
        await liquidatesAt(GOLD);
      }
    });

    for (const m of [20_000n, 25_000n, 30_000n]) {
      it(`caps liquidation at G x (1 + ${Number(m) / 10_000}%) and prices at C below the cap`, async function () {
        await oracle.setLiquidationClamp(xaut, m);
        const hi = above(GOLD, m);
        await set(hi - 1n, GOLD);
        await liquidatesAt(hi - 1n);
        await set(hi, GOLD);
        await liquidatesAt(hi);
        await set(hi + 1n, GOLD);
        await liquidatesAt(hi);
        await set(above(GOLD, 300_000n), GOLD);
        await liquidatesAt(hi);
      });
    }

    it("a 30% depeg with gold steady: borrowing and the reserve refuse, liquidation values it at gold", async function () {
      await set(below(GOLD, 300_000n), GOLD);
      await borrowRefused("Off gold band");
      await reserveRefused("Off gold band");
      await liquidatesAt(GOLD);
      expect(await oracle.quoteValuationPrice(xaut)).to.equal(below(GOLD, 300_000n));
    });

    it("a gold-wide fall liquidates at C", async function () {
      const fallen = below(GOLD, 300_000n);
      await set(fallen, fallen);
      await liquidatesAt(fallen);
    });

    it("records the liquidation price on borrow and reserve reads, not the price they return", async function () {
      await set(below(GOLD, 10_000n), GOLD);
      await borrowsAt(below(GOLD, 10_000n));
      expect(await oracle.getLastKnownPrice(xaut)).to.equal(GOLD);
      await set(above(GOLD, 10_000n), GOLD);
      await oracle.getReservePrice(xaut);
      expect(await oracle.getLastKnownPrice(xaut)).to.equal(above(GOLD, 10_000n));
    });
  });

  describe("a feed unhealthy", function () {
    it("refuses liquidation, borrowing and the reserve while C is stale or invalid, and resumes on the first healthy pair", async function () {
      await oracle.getTokenPrice(xaut);
      await push(xautFeed, GOLD, STALE);
      await liquidationRefused("No reliable price");
      await borrowRefused("No reliable price");
      await reserveRefused("No reliable price");
      expect(await oracle.quoteValuationPrice(xaut)).to.equal(0n);
      await push(xautFeed, 0n);
      await liquidationRefused("No reliable price");
      await push(xautFeed, above(GOLD, 5_000n));
      await liquidatesAt(above(GOLD, 5_000n));
    });

    it("refuses every priced path while G is stale or answers nothing, whatever C says", async function () {
      await set(GOLD, GOLD);
      await push(anchor, GOLD, STALE);
      await push(xautFeed, below(GOLD, 500_000n));
      await liquidationRefused("No reliable price");
      await push(xautFeed, GOLD);
      await liquidationRefused("No reliable price");
      await borrowRefused("No reliable price");
      await reserveRefused("No reliable price");
      expect(await oracle.quoteValuationPrice(xaut)).to.equal(0n);
      await anchor.setLatestRoundData(1, 0, await time.latest(), await time.latest(), 1);
      await liquidationRefused("No reliable price");
      await push(anchor, GOLD);
      await liquidatesAt(GOLD);
    });

    it("treats a reverting feed as unhealthy, without reverting itself", async function () {
      const flaky = await (await ethers.getContractFactory("MockSwitchableAggregatorV3")).deploy(8);
      await flaky.setRound(1, GOLD, await time.latest(), 1);
      await oracle.setFeed(xaut, await flaky.getAddress());
      await liquidatesAt(GOLD);
      await flaky.setReverting(true);
      await liquidationRefused("No reliable price");
      expect(await oracle.getValidatedPrice(xaut)).to.deep.equal([0n, false]);
      await flaky.setReverting(false);
      await flaky.setRound(2, GOLD, await time.latest(), 2);
      await liquidatesAt(GOLD);
    });

    it("both unhealthy refuses", async function () {
      await push(anchor, GOLD, STALE);
      await push(xautFeed, GOLD, STALE);
      await liquidationRefused("No reliable price");
      await borrowRefused("No reliable price");
      await reserveRefused("No reliable price");
    });
  });

  describe("no gold reference (local deployments)", function () {
    it("counts every price inside the band, liquidates at C and refuses a stale C", async function () {
      const Agg = await ethers.getContractFactory("MockAggregatorV3");
      const c = await Agg.deploy(8);
      await push(c, below(GOLD, 300_000n));
      const o = await (await ethers.getContractFactory("GoldOracle")).deploy(
        await c.getAddress(),
        await xautFeed.getAddress(),
        paxg,
        xaut,
        90_000
      );
      expect(await o.quoteTokenPrice(paxg)).to.equal(below(GOLD, 300_000n));
      expect(await o.quoteBorrowPrice(paxg)).to.equal(below(GOLD, 300_000n));
      expect(await o.quoteReservePrice(paxg)).to.equal(below(GOLD, 300_000n));
      expect(await o.quoteValuationPrice(paxg)).to.equal(below(GOLD, 300_000n));
      await push(c, GOLD, STALE);
      await expect(o.quoteTokenPrice(paxg)).to.be.revertedWith("No reliable price");
    });
  });

  describe("valuation", function () {
    it("is the lower of C and G while both are healthy, works paused and frozen, and refuses unknown tokens", async function () {
      await set(above(GOLD, 10_000n), GOLD);
      expect(await oracle.quoteValuationPrice(xaut)).to.equal(GOLD);
      await set(below(GOLD, 10_000n), GOLD);
      expect(await oracle.quoteValuationPrice(xaut)).to.equal(below(GOLD, 10_000n));
      await oracle.freezeToken(xaut);
      await oracle.emergencyPause();
      expect(await oracle.quoteValuationPrice(xaut)).to.equal(below(GOLD, 10_000n));
      await expect(oracle.quoteValuationPrice(stranger.address)).to.be.revertedWith("Unsupported token");
    });
  });

  describe("emergency price", function () {
    it("is refused outside a pause, and for a frozen token in a pause as well", async function () {
      await expect(oracle.getEmergencyPrice(xaut, false)).to.be.revertedWith("Not in emergency");
      expect(await oracle.getEmergencyPrice(xaut, true)).to.equal(GOLD);
      await oracle.freezeToken(xaut);
      await expect(oracle.getEmergencyPrice(xaut, false)).to.be.revertedWith("Token frozen");
      // The freeze holds through a pause.
      await expect(oracle.getEmergencyPrice(xaut, true)).to.be.revertedWith("Token frozen");
      await oracle.guardianUnfreezeToken(xaut, await oracle.freezeEpoch(xaut));
      expect(await oracle.getEmergencyPrice(xaut, true)).to.equal(GOLD);
    });

    it("uses the rules while both feeds are healthy and refuses otherwise, never the last known price", async function () {
      await oracle.getTokenPrice(xaut);
      await set(below(GOLD, 300_000n), GOLD);
      await oracle.emergencyPause();
      expect(await oracle.getEmergencyPrice(xaut, false)).to.equal(GOLD);
      await set(above(GOLD, 300_000n), GOLD);
      expect(await oracle.getEmergencyPrice(xaut, false)).to.equal(above(GOLD, 20_000n));
      await push(xautFeed, GOLD, STALE);
      await expect(oracle.getEmergencyPrice(xaut, false)).to.be.revertedWith("No price");
      await set(GOLD, GOLD);
      await push(anchor, GOLD, STALE);
      await expect(oracle.getEmergencyPrice(xaut, true)).to.be.revertedWith("No price");
      expect(await oracle.getEmergencyPrice(stranger.address, true)).to.equal(0n);
    });
  });

  describe("reserve integration", function () {
    it("sells reserve gold at gold when C is pushed down inside the band, refuses a depeg and values coverage at no more than C", async function () {
      const s = await productionSystem();
      const Agg = await ethers.getContractFactory("MockAggregatorV3");
      const gold = await Agg.deploy(8);
      await setValidPrice(gold, 200000000000n);
      await s.oracle.setAnchorFeed(await gold.getAddress());
      const token = await s.paxg.getAddress();
      await s.paxg.mint(s.deployer.address, ethers.parseEther("10"));
      await s.paxg.approve(await s.reserve.getAddress(), ethers.MaxUint256);
      await s.reserve.seedCollateral(token, ethers.parseEther("10"));

      const pushed = (200000000000n * 990n) / 1000n;
      await setValidPrice(s.paxgFeed, pushed);
      await setValidPrice(gold, 200000000000n);
      const gsusdIn = ethers.parseEther("2000");
      const [out, spread] = await s.reserve.quoteGoldOut(token, gsusdIn);
      const net = gsusdIn - (gsusdIn * spread) / 1_000_000n;
      expect(out).to.equal((net * 100000000n) / 200000000000n);
      await expect(s.reserve.connect(s.alice).swapGsusdForGold(token, gsusdIn, out)).to.emit(s.reserve, "Swapped");

      const depeg = (200000000000n * 700n) / 1000n;
      await setValidPrice(s.paxgFeed, depeg);
      await setValidPrice(gold, 200000000000n);
      const [none] = await s.reserve.quoteGoldOut(token, gsusdIn);
      expect(none).to.equal(0n);
      await expect(s.reserve.connect(s.alice).swapGsusdForGold(token, gsusdIn, 0)).to.be.revertedWith("Off gold band");
      const balance = await s.reserve.redeemableCollateral(token);
      expect(await s.reserve.reserveValueUsd()).to.be.lte((balance * depeg) / 100000000n);

      await setValidPrice(gold, 200000000000n);
      const now = BigInt(await time.latest());
      await s.paxgFeed.setLatestRoundData(1, depeg, now - 100_000n, now - 100_000n, 1);
      expect(await s.reserve.reserveValueUsd()).to.equal(0n, "a stopped token is left out");
    });
  });
});
