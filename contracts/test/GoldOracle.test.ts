import { expect } from "chai";
import type { Interface } from "ethers";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";
import { GoldOracle, MockAggregatorV3, MockERC20 } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";


describe("GoldOracle", function () {
  let oracle: GoldOracle;
  let paxgFeed: MockAggregatorV3;
  let xautFeed: MockAggregatorV3;
  let paxgToken: MockERC20;
  let xautToken: MockERC20;
  let other: HardhatEthersSigner;

  const GOLD_PRICE = 200000000000n; // $2000 with 8 decimals
  const STALENESS = 3600; // 1 hour

  async function setValidPrice(feed: MockAggregatorV3, price: bigint) {
    const ts = await time.latest();
    await feed.setLatestRoundData(1, price, ts, ts, 1);
  }

  beforeEach(async function () {
    [, other] = await ethers.getSigners();

    const MockAgg = await ethers.getContractFactory("MockAggregatorV3");
    paxgFeed = await MockAgg.deploy(8);
    xautFeed = await MockAgg.deploy(8);

    const MockToken = await ethers.getContractFactory("MockERC20");
    paxgToken = await MockToken.deploy("Pax Gold", "PAXG", 18);
    xautToken = await MockToken.deploy("Tether Gold", "XAUT", 6);

    await setValidPrice(paxgFeed, GOLD_PRICE);
    await setValidPrice(xautFeed, GOLD_PRICE);

    const OracleFactory = await ethers.getContractFactory("GoldOracle");
    oracle = await OracleFactory.deploy(
      await paxgFeed.getAddress(),
      await xautFeed.getAddress(),
      await paxgToken.getAddress(),
      await xautToken.getAddress(),
      STALENESS
    );
  });

  describe("Constructor", function () {
    it("should reject staleness threshold 0", async function () {
      const F = await ethers.getContractFactory("GoldOracle");
      await expect(
        F.deploy(await paxgFeed.getAddress(), await xautFeed.getAddress(), await paxgToken.getAddress(), await xautToken.getAddress(), 0)
      ).to.be.revertedWith("Invalid staleness threshold");
    });

    it("should reject staleness threshold > 90000", async function () {
      const F = await ethers.getContractFactory("GoldOracle");
      await expect(
        F.deploy(await paxgFeed.getAddress(), await xautFeed.getAddress(), await paxgToken.getAddress(), await xautToken.getAddress(), 90001)
      ).to.be.revertedWith("Invalid staleness threshold");
    });

    it("should accept staleness threshold covering a 24h-heartbeat feed (90000)", async function () {
      const F = await ethers.getContractFactory("GoldOracle");
      const o = await F.deploy(
        await paxgFeed.getAddress(), await xautFeed.getAddress(), await paxgToken.getAddress(), await xautToken.getAddress(), 90000
      );
      expect(await o.stalenessThreshold()).to.equal(90000);
    });

    it("should reject zero feed addresses", async function () {
      const F = await ethers.getContractFactory("GoldOracle");
      await expect(
        F.deploy(ethers.ZeroAddress, await xautFeed.getAddress(), await paxgToken.getAddress(), await xautToken.getAddress(), STALENESS)
      ).to.be.revertedWith("Zero feed address");
    });

    it("should reject zero token addresses", async function () {
      const F = await ethers.getContractFactory("GoldOracle");
      await expect(
        F.deploy(await paxgFeed.getAddress(), await xautFeed.getAddress(), ethers.ZeroAddress, await xautToken.getAddress(), STALENESS)
      ).to.be.revertedWith("Zero token address");
    });

    it("should reject duplicate token addresses", async function () {
      const F = await ethers.getContractFactory("GoldOracle");
      await expect(
        F.deploy(await paxgFeed.getAddress(), await xautFeed.getAddress(), await paxgToken.getAddress(), await paxgToken.getAddress(), STALENESS)
      ).to.be.revertedWith("Duplicate token");
    });

    it("should register both tokens in the feed registry", async function () {
      const paxgCfg = await oracle.feeds(await paxgToken.getAddress());
      const xautCfg = await oracle.feeds(await xautToken.getAddress());
      expect(paxgCfg.supported).to.be.true;
      expect(paxgCfg.feed).to.equal(await paxgFeed.getAddress());
      expect(xautCfg.supported).to.be.true;
      expect(xautCfg.feed).to.equal(await xautFeed.getAddress());
      const tokens = await oracle.getSupportedTokens();
      expect([...tokens]).to.deep.equal([
        await paxgToken.getAddress(),
        await xautToken.getAddress(),
      ]);
    });
  });

  describe("getTokenPrice", function () {
    it("should return correct PAXG price", async function () {
      const price = await oracle.getTokenPrice.staticCall(await paxgToken.getAddress());
      expect(price).to.equal(GOLD_PRICE);
    });

    it("should return correct XAUT price", async function () {
      const price = await oracle.getTokenPrice.staticCall(await xautToken.getAddress());
      expect(price).to.equal(GOLD_PRICE);
    });

    it("should revert for unsupported token", async function () {
      await expect(oracle.getTokenPrice(other.address)).to.be.revertedWith("Unsupported token");
    });

    it("should update lastKnownPaxgPrice", async function () {
      expect(await oracle.lastKnownPaxgPrice()).to.equal(0);
      await oracle.getTokenPrice(await paxgToken.getAddress());
      expect(await oracle.lastKnownPaxgPrice()).to.equal(GOLD_PRICE);
    });

    it("should update lastKnownXautPrice", async function () {
      expect(await oracle.lastKnownXautPrice()).to.equal(0);
      await oracle.getTokenPrice(await xautToken.getAddress());
      expect(await oracle.lastKnownXautPrice()).to.equal(GOLD_PRICE);
    });

    it("should skip deviation check on first call (lastKnown == 0)", async function () {
      // First call should not revert even with any price
      await expect(oracle.getTokenPrice(await paxgToken.getAddress())).to.not.be.reverted;
    });
  });

  describe("Market feed validation (getTokenPrice refuses, getPaxgPrice names the fault)", function () {
    it("should revert if answer <= 0", async function () {
      const ts = await time.latest();
      await paxgFeed.setLatestRoundData(1, 0, ts, ts, 1);
      await expect(oracle.getTokenPrice(await paxgToken.getAddress())).to.be.revertedWith("No reliable price");
      await expect(oracle.getPaxgPrice()).to.be.revertedWith("Invalid price");
    });

    it("should revert if answer is negative", async function () {
      const ts = await time.latest();
      await paxgFeed.setLatestRoundData(1, -1, ts, ts, 1);
      await expect(oracle.getTokenPrice(await paxgToken.getAddress())).to.be.revertedWith("No reliable price");
      await expect(oracle.getPaxgPrice()).to.be.revertedWith("Invalid price");
    });

    it("should revert if updatedAt == 0", async function () {
      await paxgFeed.setLatestRoundData(1, GOLD_PRICE, 0, 0, 1);
      await expect(oracle.getTokenPrice(await paxgToken.getAddress())).to.be.revertedWith("No reliable price");
      await expect(oracle.getPaxgPrice()).to.be.revertedWith("Round not complete");
    });

    it("should revert if answeredInRound < roundId", async function () {
      const ts = await time.latest();
      await paxgFeed.setLatestRoundData(5, GOLD_PRICE, ts, ts, 4);
      await expect(oracle.getTokenPrice(await paxgToken.getAddress())).to.be.revertedWith("No reliable price");
      await expect(oracle.getPaxgPrice()).to.be.revertedWith("Stale round");
    });

    it("should revert if data is stale", async function () {
      const old = (await time.latest()) - STALENESS - 1;
      await paxgFeed.setLatestRoundData(1, GOLD_PRICE, old, old, 1);
      await expect(oracle.getTokenPrice(await paxgToken.getAddress())).to.be.revertedWith("No reliable price");
      await expect(oracle.getPaxgPrice()).to.be.revertedWith("Stale oracle");
    });
  });

  describe("Manual freeze (no step gate, no permissionless trip)", function () {
    it("prices a large single move at once and records it: there is no step gate", async function () {
      await oracle.getTokenPrice(await paxgToken.getAddress());
      const newPrice = GOLD_PRICE * 111n / 100n;
      await setValidPrice(paxgFeed, newPrice);
      expect(await oracle.getTokenPrice.staticCall(await paxgToken.getAddress())).to.equal(newPrice);
      await oracle.getTokenPrice(await paxgToken.getAddress());
      expect(await oracle.lastKnownPaxgPrice()).to.equal(newPrice);
      expect(await oracle.paused()).to.be.false;
    });

    it("freezeToken freezes only that token", async function () {
      await expect(oracle.freezeToken(await paxgToken.getAddress()))
        .to.emit(oracle, "TokenFrozen");
      expect(await oracle.tokenFrozen(await paxgToken.getAddress())).to.be.true;
      expect(await oracle.tokenFrozen(await xautToken.getAddress())).to.be.false;
      expect(await oracle.paused()).to.be.false;
    });

    it("freezeToken is refused to a caller without the guardian or governance role", async function () {
      await expect(oracle.connect(other).freezeToken(await paxgToken.getAddress()))
        .to.be.revertedWith("Not guardian or governance");
    });

    it("should prevent getTokenPrice for the frozen token only", async function () {
      await oracle.getTokenPrice(await paxgToken.getAddress());
      await oracle.freezeToken(await paxgToken.getAddress());
      await expect(oracle.getTokenPrice(await paxgToken.getAddress()))
        .to.be.revertedWith("Token frozen");
      await expect(oracle.getTokenPrice(await xautToken.getAddress())).to.not.be.reverted;
    });

    it("should prevent getTokenPrice for every token while the guardian pause holds", async function () {
      await oracle.emergencyPause();
      await expect(oracle.getTokenPrice(await paxgToken.getAddress()))
        .to.be.revertedWithCustomError(oracle, "EnforcedPause");
    });
  });

  describe("getLastKnownPrice", function () {
    it("should work when paused and frozen", async function () {
      await oracle.getTokenPrice(await paxgToken.getAddress());
      expect(await oracle.lastKnownPaxgPrice()).to.equal(GOLD_PRICE);
      await oracle.freezeToken(await paxgToken.getAddress());
      await oracle.emergencyPause();
      await setValidPrice(paxgFeed, GOLD_PRICE * 2n);
      // The frozen, paused token is read by nothing, so the record holds the pre-spike price.
      expect(await oracle.getLastKnownPrice(await paxgToken.getAddress())).to.equal(GOLD_PRICE);
    });

    it("should revert for unsupported token", async function () {
      await expect(oracle.getLastKnownPrice(other.address)).to.be.revertedWith("Unsupported token");
    });
  });

  describe("Anchor consistency", function () {
    let anchorFeed: MockAggregatorV3;

    beforeEach(async function () {
      const MockAgg = await ethers.getContractFactory("MockAggregatorV3");
      anchorFeed = await MockAgg.deploy(8);
      await setValidPrice(anchorFeed, GOLD_PRICE);
    });

    it("anchorFeed defaults to zero and a 20% PAXG/XAUT divergence passes", async function () {
      expect(await oracle.anchorFeed()).to.equal(ethers.ZeroAddress);
      await oracle.getTokenPrice(await paxgToken.getAddress());

      // 20% below PAXG. The removed pairwise check would have reverted here;
      // the registry design has no pairwise PAXG/XAUT comparison.
      const diverged = GOLD_PRICE * 80n / 100n;
      await setValidPrice(xautFeed, diverged);
      await expect(oracle.getTokenPrice(await xautToken.getAddress())).to.not.be.reverted;
      expect(await oracle.lastKnownXautPrice()).to.equal(diverged);
    });

    it("setAnchorFeed should only allow GOVERNANCE_ROLE", async function () {
      await expect(oracle.connect(other).setAnchorFeed(await anchorFeed.getAddress())).to.be.reverted;
    });

    it("setAnchorFeed should reject a non-8-decimal feed", async function () {
      const MockAgg = await ethers.getContractFactory("MockAggregatorV3");
      const badFeed = await MockAgg.deploy(18);
      await expect(oracle.setAnchorFeed(await badFeed.getAddress())).to.be.revertedWith("Must be 8 decimals");
    });

    it("setAnchorFeed accepts the zero address only while no anchor has been set", async function () {
      await expect(oracle.setAnchorFeed(ethers.ZeroAddress))
        .to.emit(oracle, "AnchorFeedUpdated")
        .withArgs(ethers.ZeroAddress);
      await oracle.setAnchorFeed(await anchorFeed.getAddress());
      await expect(oracle.setAnchorFeed(ethers.ZeroAddress)).to.be.revertedWith("Anchor required");
      expect(await oracle.anchorFeed()).to.equal(await anchorFeed.getAddress());
    });

    it("setAnchorFeed refuses any token's market feed", async function () {
      await expect(oracle.setAnchorFeed(await paxgFeed.getAddress())).to.be.revertedWith("Feed not independent");
      await expect(oracle.setAnchorFeed(await xautFeed.getAddress())).to.be.revertedWith("Feed not independent");
    });

    it("should pass a read within the gold band", async function () {
      await oracle.setAnchorFeed(await anchorFeed.getAddress());
      // 1.5% above the $2000 gold reference, inside the default 2% band
      await setValidPrice(paxgFeed, GOLD_PRICE * 1015n / 1000n);
      await expect(oracle.getTokenPrice(await paxgToken.getAddress())).to.not.be.reverted;
    });

    it("should refuse borrowing outside the gold band and cap liquidation at 2% above gold", async function () {
      await oracle.setAnchorFeed(await anchorFeed.getAddress());
      await setValidPrice(paxgFeed, GOLD_PRICE * 115n / 100n);
      await expect(oracle.getBorrowPrice(await paxgToken.getAddress()))
        .to.be.revertedWith("Off gold band");
      expect(await oracle.quoteTokenPrice(await paxgToken.getAddress())).to.equal(GOLD_PRICE * 102n / 100n);
    });

    it("should refuse borrowing and liquidation when the gold reference is stale", async function () {
      await oracle.setAnchorFeed(await anchorFeed.getAddress());
      const old = (await time.latest()) - STALENESS - 1;
      await anchorFeed.setLatestRoundData(1, GOLD_PRICE, old, old, 1);
      await setValidPrice(paxgFeed, GOLD_PRICE / 2n);
      await expect(oracle.getBorrowPrice(await paxgToken.getAddress()))
        .to.be.revertedWith("No reliable price");
      await expect(oracle.quoteTokenPrice(await paxgToken.getAddress())).to.be.revertedWith("No reliable price");
    });

    it("should revert when the gold reference answers zero", async function () {
      await oracle.setAnchorFeed(await anchorFeed.getAddress());
      const ts = await time.latest();
      await anchorFeed.setLatestRoundData(1, 0, ts, ts, 1);
      await setValidPrice(paxgFeed, GOLD_PRICE);
      await expect(oracle.getTokenPrice(await paxgToken.getAddress()))
        .to.be.revertedWith("No reliable price");
    });

    it("tightening one token's gold band flips a 1.5% divergence from borrowable to refused", async function () {
      await oracle.setAnchorFeed(await anchorFeed.getAddress());
      const off = GOLD_PRICE * 1015n / 1000n;
      await setValidPrice(paxgFeed, off);
      await expect(oracle.getBorrowPrice(await paxgToken.getAddress())).to.not.be.reverted;

      await oracle.setGoldBand(await paxgToken.getAddress(), 10_000); // 1%
      await setValidPrice(paxgFeed, off);
      await expect(oracle.getBorrowPrice(await paxgToken.getAddress()))
        .to.be.revertedWith("Off gold band");
      expect(await oracle.quoteTokenPrice(await paxgToken.getAddress())).to.equal(off, "the cap is separate");
      await setValidPrice(xautFeed, off);
      await expect(oracle.getBorrowPrice(await xautToken.getAddress())).to.not.be.reverted; // XAUT keeps 2%
    });

    it("an oracle that never set a gold reference counts every price as inside the band (local only)", async function () {
      await setValidPrice(paxgFeed, GOLD_PRICE * 115n / 100n);
      await expect(oracle.getBorrowPrice(await paxgToken.getAddress())).to.not.be.reverted;
      await oracle.setAnchorFeed(await anchorFeed.getAddress());
      await setValidPrice(paxgFeed, GOLD_PRICE * 115n / 100n);
      await expect(oracle.getBorrowPrice(await paxgToken.getAddress()))
        .to.be.revertedWith("Off gold band");
    });

    it("setGoldBand emits GoldBandUpdated", async function () {
      await expect(oracle.setGoldBand(await paxgToken.getAddress(), 50_000))
        .to.emit(oracle, "GoldBandUpdated")
        .withArgs(await paxgToken.getAddress(), 50_000);
    });
  });

  describe("Feed registry: addFeed", function () {
    let kauToken: MockERC20;
    let kauFeed: MockAggregatorV3;

    beforeEach(async function () {
      const MockToken = await ethers.getContractFactory("MockERC20");
      kauToken = await MockToken.deploy("Kinesis Gold", "KAU", 18);
      const MockAgg = await ethers.getContractFactory("MockAggregatorV3");
      kauFeed = await MockAgg.deploy(8);
      await setValidPrice(kauFeed, GOLD_PRICE);
    });

    it("governance can add a third token feed", async function () {
      await expect(oracle.addFeed(await kauToken.getAddress(), await kauFeed.getAddress()))
        .to.emit(oracle, "FeedAdded")
        .withArgs(await kauToken.getAddress(), await kauFeed.getAddress());
      const cfg = await oracle.feeds(await kauToken.getAddress());
      expect(cfg.supported).to.be.true;
      expect(cfg.feed).to.equal(await kauFeed.getAddress());
      expect(cfg.lastKnownPrice).to.equal(0);
    });

    it("non-governance cannot add a feed", async function () {
      await expect(
        oracle.connect(other).addFeed(await kauToken.getAddress(), await kauFeed.getAddress())
      ).to.be.reverted;
    });

    it("should reject a zero token address", async function () {
      await expect(oracle.addFeed(ethers.ZeroAddress, await kauFeed.getAddress()))
        .to.be.revertedWith("Zero token address");
    });

    it("should reject a zero feed address", async function () {
      await expect(oracle.addFeed(await kauToken.getAddress(), ethers.ZeroAddress))
        .to.be.revertedWith("Zero feed address");
    });

    it("should reject a non-8-decimal feed", async function () {
      const MockAgg = await ethers.getContractFactory("MockAggregatorV3");
      const badFeed = await MockAgg.deploy(18);
      await expect(oracle.addFeed(await kauToken.getAddress(), await badFeed.getAddress()))
        .to.be.revertedWith("Must be 8 decimals");
    });

    it("should reject a duplicate token", async function () {
      await expect(oracle.addFeed(await paxgToken.getAddress(), await kauFeed.getAddress()))
        .to.be.revertedWith("Feed already added");
      await oracle.addFeed(await kauToken.getAddress(), await kauFeed.getAddress());
      await expect(oracle.addFeed(await kauToken.getAddress(), await kauFeed.getAddress()))
        .to.be.revertedWith("Feed already added");
    });

    it("first getTokenPrice seeds lastKnown without a deviation check", async function () {
      await oracle.addFeed(await kauToken.getAddress(), await kauFeed.getAddress());
      expect(await oracle.getLastKnownPrice(await kauToken.getAddress())).to.equal(0);
      await expect(oracle.getTokenPrice(await kauToken.getAddress())).to.not.be.reverted;
      expect(await oracle.getLastKnownPrice(await kauToken.getAddress())).to.equal(GOLD_PRICE);
    });

    it("getValidatedPrice returns the live price for the new token", async function () {
      await oracle.addFeed(await kauToken.getAddress(), await kauFeed.getAddress());
      const [price, valid] = await oracle.getValidatedPrice(await kauToken.getAddress());
      expect(valid).to.be.true;
      expect(price).to.equal(GOLD_PRICE);
    });

    it("getSupportedTokens lists all registered tokens", async function () {
      await oracle.addFeed(await kauToken.getAddress(), await kauFeed.getAddress());
      const tokens = await oracle.getSupportedTokens();
      expect([...tokens]).to.deep.equal([
        await paxgToken.getAddress(),
        await xautToken.getAddress(),
        await kauToken.getAddress(),
      ]);
    });

    it("getPaxgPrice and getXautPrice still serve the original feeds", async function () {
      await oracle.addFeed(await kauToken.getAddress(), await kauFeed.getAddress());
      const [paxgPrice] = await oracle.getPaxgPrice();
      const [xautPrice] = await oracle.getXautPrice();
      expect(paxgPrice).to.equal(GOLD_PRICE);
      expect(xautPrice).to.equal(GOLD_PRICE);
      expect(await oracle.paxgUsdFeed()).to.equal(await paxgFeed.getAddress());
      expect(await oracle.xautUsdFeed()).to.equal(await xautFeed.getAddress());
    });
  });

  describe("Feed registry: setFeed", function () {
    it("replaces the feed for a supported token", async function () {
      const MockAgg = await ethers.getContractFactory("MockAggregatorV3");
      const newFeed = await MockAgg.deploy(8);
      await setValidPrice(newFeed, GOLD_PRICE);
      await expect(oracle.setFeed(await paxgToken.getAddress(), await newFeed.getAddress()))
        .to.emit(oracle, "FeedUpdated")
        .withArgs(await paxgToken.getAddress(), await newFeed.getAddress());
      expect(await oracle.paxgUsdFeed()).to.equal(await newFeed.getAddress());
    });

    it("should reject an unsupported token", async function () {
      const MockAgg = await ethers.getContractFactory("MockAggregatorV3");
      const newFeed = await MockAgg.deploy(8);
      await expect(oracle.setFeed(other.address, await newFeed.getAddress()))
        .to.be.revertedWith("Unsupported token");
    });

    it("should reject the zero feed address", async function () {
      await expect(oracle.setFeed(await paxgToken.getAddress(), ethers.ZeroAddress))
        .to.be.revertedWith("Zero address");
    });

    it("should reject a non-8-decimal feed", async function () {
      const MockAgg = await ethers.getContractFactory("MockAggregatorV3");
      const badFeed = await MockAgg.deploy(6);
      await expect(oracle.setFeed(await paxgToken.getAddress(), await badFeed.getAddress()))
        .to.be.revertedWith("Must be 8 decimals");
    });

    it("only governance may replace a feed", async function () {
      const MockAgg = await ethers.getContractFactory("MockAggregatorV3");
      const newFeed = await MockAgg.deploy(8);
      await expect(
        oracle.connect(other).setFeed(await paxgToken.getAddress(), await newFeed.getAddress())
      ).to.be.reverted;
    });

    it("preserves lastKnownPrice across the swap; the next read prices the replacement", async function () {
      await oracle.getTokenPrice(await paxgToken.getAddress()); // lastKnown = $2000
      const MockAgg = await ethers.getContractFactory("MockAggregatorV3");
      const newFeed = await MockAgg.deploy(8);
      const divergent = GOLD_PRICE * 120n / 100n;
      await setValidPrice(newFeed, divergent);

      await oracle.setFeed(await paxgToken.getAddress(), await newFeed.getAddress());
      expect(await oracle.lastKnownPaxgPrice()).to.equal(GOLD_PRICE);
      await oracle.getTokenPrice(await paxgToken.getAddress()); // no step gate: no wedge
      expect(await oracle.lastKnownPaxgPrice()).to.equal(divergent);
    });
  });

  describe("Guardian resync (guardianResyncLastKnownPrice)", function () {
    beforeEach(async function () {
      await oracle.getTokenPrice(await paxgToken.getAddress()); // lastKnown = $2000
      await setValidPrice(paxgFeed, GOLD_PRICE * 120n / 100n); // unread since
    });

    it("a guardian re-records the normal price without the timelock", async function () {
      await oracle.grantGuardianRole(other.address);
      await expect(oracle.connect(other).guardianResyncLastKnownPrice(await paxgToken.getAddress()))
        .to.emit(oracle, "LastKnownPriceResynced")
        .withArgs(await paxgToken.getAddress(), GOLD_PRICE, GOLD_PRICE * 120n / 100n);
      expect(await oracle.lastKnownPaxgPrice()).to.equal(GOLD_PRICE * 120n / 100n);
    });

    it("a random caller cannot resync", async function () {
      const [, , stranger] = await ethers.getSigners();
      await expect(
        oracle.connect(stranger).guardianResyncLastKnownPrice(await paxgToken.getAddress())
      ).to.be.revertedWith("Not guardian or governance");
    });

    it("works mid-incident while the oracle is paused", async function () {
      await oracle.grantGuardianRole(other.address);
      await oracle.connect(other).emergencyPause();
      await oracle.connect(other).guardianResyncLastKnownPrice(await paxgToken.getAddress());
      expect(await oracle.lastKnownPaxgPrice()).to.equal(GOLD_PRICE * 120n / 100n);
    });

    it("refuses a stale feed: timing is the guardian's only discretion, never the value", async function () {
      await oracle.grantGuardianRole(other.address);
      await time.increase(90001);
      await expect(
        oracle.connect(other).guardianResyncLastKnownPrice(await paxgToken.getAddress())
      ).to.be.revertedWith("No reliable price");
    });

    it("both paths accept only a price the rules accept: above the gold band it is capped", async function () {
      const MockAgg = await ethers.getContractFactory("MockAggregatorV3");
      const anchorFeed = await MockAgg.deploy(8);
      await setValidPrice(anchorFeed, GOLD_PRICE);
      await oracle.setAnchorFeed(await anchorFeed.getAddress());
      await oracle.grantGuardianRole(other.address);
      await oracle.connect(other).guardianResyncLastKnownPrice(await paxgToken.getAddress());
      expect(await oracle.lastKnownPaxgPrice()).to.equal(GOLD_PRICE * 102n / 100n);
      await oracle.resyncLastKnownPrice(await paxgToken.getAddress());
      expect(await oracle.lastKnownPaxgPrice()).to.equal(GOLD_PRICE * 102n / 100n);
    });
  });

  describe("Per-token circuit breaker isolation", function () {
    beforeEach(async function () {
      await oracle.getTokenPrice(await paxgToken.getAddress());
      await oracle.getTokenPrice(await xautToken.getAddress());
    });

    it("PAXG off the gold band blocks PAXG borrowing but not XAUT reads", async function () {
      const MockAgg = await ethers.getContractFactory("MockAggregatorV3");
      const anchorFeed = await MockAgg.deploy(8);
      await setValidPrice(anchorFeed, GOLD_PRICE);
      await oracle.setAnchorFeed(await anchorFeed.getAddress());
      await setValidPrice(paxgFeed, GOLD_PRICE * 120n / 100n);
      await expect(oracle.getBorrowPrice(await paxgToken.getAddress()))
        .to.be.revertedWith("Off gold band");

      const xautPrice = GOLD_PRICE * 1015n / 1000n;
      await setValidPrice(xautFeed, xautPrice);
      await expect(oracle.getTokenPrice(await xautToken.getAddress())).to.not.be.reverted;
      expect(await oracle.lastKnownXautPrice()).to.equal(xautPrice);
    });

    it("freezing PAXG leaves XAUT running", async function () {
      await oracle.freezeToken(await paxgToken.getAddress());
      expect(await oracle.paused()).to.be.false;
      expect(await oracle.tokenFrozen(await xautToken.getAddress())).to.be.false;
      await expect(oracle.getTokenPrice(await xautToken.getAddress())).to.not.be.reverted;
      await expect(oracle.getTokenPrice(await paxgToken.getAddress())).to.be.revertedWith("Token frozen");
    });

    it("resyncLastKnownPrice on PAXG does not touch the XAUT anchor", async function () {
      const divergent = GOLD_PRICE * 120n / 100n;
      await setValidPrice(paxgFeed, divergent);
      await oracle.resyncLastKnownPrice(await paxgToken.getAddress());
      expect(await oracle.lastKnownPaxgPrice()).to.equal(divergent);
      expect(await oracle.lastKnownXautPrice()).to.equal(GOLD_PRICE);
    });

    it("resyncLastKnownPrice reverts for an unsupported token", async function () {
      await expect(oracle.resyncLastKnownPrice(other.address))
        .to.be.revertedWith("Unsupported token");
    });

    it("freeze, unfreeze and resync on a registry-added token behave like PAXG", async function () {
      const MockToken = await ethers.getContractFactory("MockERC20");
      const kauToken = await MockToken.deploy("Kinesis Gold", "KAU", 18);
      const MockAgg = await ethers.getContractFactory("MockAggregatorV3");
      const kauFeed = await MockAgg.deploy(8);
      await setValidPrice(kauFeed, GOLD_PRICE);
      await oracle.addFeed(await kauToken.getAddress(), await kauFeed.getAddress());
      await oracle.getTokenPrice(await kauToken.getAddress()); // record lastKnown

      await expect(oracle.freezeToken(await kauToken.getAddress()))
        .to.emit(oracle, "TokenFrozen")
        .withArgs(await kauToken.getAddress(), (await ethers.getSigners())[0].address, anyValue);
      expect(await oracle.tokenFrozen(await kauToken.getAddress())).to.be.true;

      // No gold reference is set here, so the unfreeze records the live price.
      const divergent = GOLD_PRICE * 120n / 100n;
      await setValidPrice(kauFeed, divergent);
      expect(await oracle.freezeEpoch(await kauToken.getAddress())).to.equal(1n);
      await oracle.guardianUnfreezeToken(await kauToken.getAddress(), 1n);
      expect(await oracle.getLastKnownPrice(await kauToken.getAddress())).to.equal(divergent);

      await setValidPrice(kauFeed, divergent);
      expect(await oracle.getTokenPrice.staticCall(await kauToken.getAddress())).to.equal(divergent);
    });
  });

  describe("Feed Setters", function () {
    it("setPaxgFeed should reject zero address", async function () {
      await expect(oracle.setPaxgFeed(ethers.ZeroAddress)).to.be.revertedWith("Zero address");
    });

    it("setPaxgFeed should reject non-8-decimal feed", async function () {
      const MockAgg = await ethers.getContractFactory("MockAggregatorV3");
      const badFeed = await MockAgg.deploy(18);
      await expect(oracle.setPaxgFeed(await badFeed.getAddress())).to.be.revertedWith("Must be 8 decimals");
    });

    it("setXautFeed should reject zero address", async function () {
      await expect(oracle.setXautFeed(ethers.ZeroAddress)).to.be.revertedWith("Zero address");
    });

    it("setXautFeed should reject non-8-decimal feed", async function () {
      const MockAgg = await ethers.getContractFactory("MockAggregatorV3");
      const badFeed = await MockAgg.deploy(6);
      await expect(oracle.setXautFeed(await badFeed.getAddress())).to.be.revertedWith("Must be 8 decimals");
    });

    it("should only allow GOVERNANCE_ROLE to set feeds", async function () {
      const MockAgg = await ethers.getContractFactory("MockAggregatorV3");
      const newFeed = await MockAgg.deploy(8);
      await expect(oracle.connect(other).setPaxgFeed(await newFeed.getAddress())).to.be.reverted;
    });
  });

  describe("setStalenessThreshold", function () {
    it("should reject threshold < 300", async function () {
      await expect(oracle.setStalenessThreshold(299)).to.be.revertedWith("Threshold out of range");
    });

    it("should reject threshold > 90000", async function () {
      await expect(oracle.setStalenessThreshold(90001)).to.be.revertedWith("Threshold out of range");
    });

    it("should accept valid threshold", async function () {
      await oracle.setStalenessThreshold(600);
      expect(await oracle.stalenessThreshold()).to.equal(600);
    });

    it("should accept a threshold matched to a 24h-heartbeat feed", async function () {
      await oracle.setStalenessThreshold(90000);
      expect(await oracle.stalenessThreshold()).to.equal(90000);
    });
  });

  describe("freezeToken", function () {
    it("should revert for unsupported token", async function () {
      await expect(oracle.freezeToken(other.address)).to.be.revertedWith("Unsupported token");
    });

    it("needs no prior read", async function () {
      await oracle.freezeToken(await paxgToken.getAddress());
      expect(await oracle.tokenFrozen(await paxgToken.getAddress())).to.be.true;
    });

    it("is open to the guardian", async function () {
      await oracle.grantGuardianRole(other.address);
      await expect(oracle.connect(other).freezeToken(await paxgToken.getAddress()))
        .to.emit(oracle, "TokenFrozen")
        .withArgs(await paxgToken.getAddress(), other.address, anyValue);
    });

    it("lasts 14 days and a second call while frozen extends it", async function () {
      await oracle.freezeToken(await paxgToken.getAddress());
      const first = await oracle.frozenUntil(await paxgToken.getAddress());
      expect(first).to.equal(BigInt(await time.latest()) + 14n * 86400n);
      await time.increase(86400);
      await oracle.freezeToken(await paxgToken.getAddress());
      expect(await oracle.frozenUntil(await paxgToken.getAddress())).to.equal(BigInt(await time.latest()) + 14n * 86400n);
      await time.increase(14 * 86400);
      expect(await oracle.tokenFrozen(await paxgToken.getAddress())).to.be.false;
    });
  });

  describe("setGoldBand and setLiquidationClamp", function () {
    it("should update within bounds", async function () {
      await oracle.setGoldBand(await paxgToken.getAddress(), 100_000);
      expect(await oracle.goldBandPpm(await paxgToken.getAddress())).to.equal(100_000);
      await oracle.setLiquidationClamp(await paxgToken.getAddress(), 50_000);
      expect(await oracle.liquidationClampPpm(await paxgToken.getAddress())).to.equal(50_000);
    });

    it("should reject a gold band below 0.5% or above 10%", async function () {
      await expect(oracle.setGoldBand(await paxgToken.getAddress(), 4_999)).to.be.revertedWith("Band out of range");
      await expect(oracle.setGoldBand(await paxgToken.getAddress(), 100_001)).to.be.revertedWith("Band out of range");
    });

    it("should reject a liquidation clamp below 0.5% or above 5%", async function () {
      await expect(oracle.setLiquidationClamp(await paxgToken.getAddress(), 4_999)).to.be.revertedWith("Clamp out of range");
      await expect(oracle.setLiquidationClamp(await paxgToken.getAddress(), 50_001)).to.be.revertedWith("Clamp out of range");
    });

    it("should only allow GOVERNANCE_ROLE", async function () {
      await expect(oracle.connect(other).setGoldBand(await paxgToken.getAddress(), 20_000)).to.be.reverted;
      await expect(oracle.connect(other).setLiquidationClamp(await paxgToken.getAddress(), 30_000)).to.be.reverted;
    });
  });

  describe("removed surface", function () {
    it("no longer exposes the step gate, the trip, recovery activation or the global bands", async function () {
      // The untyped ABI: the generated interface only accepts names that still exist.
      const abi: Interface = oracle.interface;
      for (const name of [
        "deviationThreshold", "setDeviationThreshold", "tripCircuitBreaker", "activateRecovery",
        "recoveryActive", "recoveryReference", "recoveryPrice", "confirmationBand",
        "setConfirmationBand", "crossFeedThreshold", "setCrossFeedThreshold",
        "confirmationFeed", "setConfirmationFeed", "agreementBandPpm", "setAgreementBand",
        "observeBand", "quoteBreach", "breachSince", "breachBelow", "floorDescentPpmPerHour",
        "setFloorDescent", "quoteDepth", "depthRecord", "quoteLiquidationFloor",
        "MAX_OBSERVATION_GAP", "BREACH_PERSISTENCE",
      ]) {
        expect(abi.getFunction(name), name).to.equal(null);
      }
      expect(abi.getEvent("CircuitBreakerTriggered")).to.equal(null);
    });
  });

  describe("Guardian", function () {
    it("emergencyPause should be callable by guardian", async function () {
      await oracle.grantGuardianRole(other.address);
      await oracle.connect(other).emergencyPause();
      expect(await oracle.paused()).to.be.true;
    });

    it("grantGuardianRole should reject zero address", async function () {
      await expect(oracle.grantGuardianRole(ethers.ZeroAddress))
        .to.be.revertedWith("Zero address");
    });
  });

  describe("unpause", function () {
    it("should only allow GOVERNANCE_ROLE", async function () {
      await expect(oracle.connect(other).unpause(0n)).to.be.reverted;
    });
  });
});
