import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

/**
 * PythMarketFeed: every constructor guard, every read status, the exact rescaling across exponents,
 * the fee forwarding and refund paths, and the invalid-is-zero rule GoldOracle relies on.
 */
describe("PythMarketFeed", function () {
  const ID = ethers.keccak256(ethers.toUtf8Bytes("XAUT/USD"));
  const MAX_AGE = 60;
  const MAX_CONF_PPM = 5_000;
  const PRICE = 4000_00000000n;

  enum Status {
    OK,
    FEED_FAILED,
    INVALID_PRICE,
    STALE,
    FUTURE_PUBLISH_TIME,
    WIDE_CONFIDENCE,
    EXPONENT_OUT_OF_RANGE,
    PRICE_OUT_OF_RANGE,
  }

  async function fixture() {
    const [deployer, other] = await ethers.getSigners();
    const pyth = await (await ethers.getContractFactory("MockPyth")).deploy();
    const Feed = await ethers.getContractFactory("PythMarketFeed");
    const feed = await Feed.deploy(await pyth.getAddress(), ID, MAX_AGE, MAX_CONF_PPM, "XAUT / USD (Pyth)");
    const relayer = await (await ethers.getContractFactory("MockPythRelayer")).deploy();
    const publishTime = await time.latest();
    await pyth.setPrice(ID, PRICE, 1_00000000n, -8, publishTime);
    return { deployer, other, pyth, Feed, feed, relayer, publishTime };
  }

  async function update(pyth: Awaited<ReturnType<typeof fixture>>["pyth"], price: bigint, publishTime: number, conf = 0n, expo = -8) {
    return pyth.encodeUpdate(ID, price, conf, expo, publishTime);
  }

  describe("constructor", function () {
    it("records its configuration", async function () {
      const f = await loadFixture(fixture);
      expect(await f.feed.pyth()).to.equal(await f.pyth.getAddress());
      expect(await f.feed.priceId()).to.equal(ID);
      expect(await f.feed.maxAgeSeconds()).to.equal(MAX_AGE);
      expect(await f.feed.maxConfidencePpm()).to.equal(MAX_CONF_PPM);
      expect(await f.feed.description()).to.equal("XAUT / USD (Pyth)");
      expect(await f.feed.decimals()).to.equal(8);
      expect(await f.feed.version()).to.equal(1);
    });

    it("rejects a zero or codeless Pyth address, a zero price id and out of range bounds", async function () {
      const f = await loadFixture(fixture);
      const pyth = await f.pyth.getAddress();
      await expect(f.Feed.deploy(ethers.ZeroAddress, ID, MAX_AGE, MAX_CONF_PPM, "")).to.be.revertedWithCustomError(f.Feed, "ZeroAddress");
      await expect(f.Feed.deploy(f.other.address, ID, MAX_AGE, MAX_CONF_PPM, "")).to.be.revertedWithCustomError(f.Feed, "NotAContract").withArgs(f.other.address);
      await expect(f.Feed.deploy(pyth, ethers.ZeroHash, MAX_AGE, MAX_CONF_PPM, "")).to.be.revertedWithCustomError(f.Feed, "ZeroPriceId");
      await expect(f.Feed.deploy(pyth, ID, 9, MAX_CONF_PPM, "")).to.be.revertedWithCustomError(f.Feed, "MaxAgeOutOfRange").withArgs(9);
      await expect(f.Feed.deploy(pyth, ID, 3601, MAX_CONF_PPM, "")).to.be.revertedWithCustomError(f.Feed, "MaxAgeOutOfRange").withArgs(3601);
      await expect(f.Feed.deploy(pyth, ID, MAX_AGE, 0, "")).to.be.revertedWithCustomError(f.Feed, "MaxConfidenceOutOfRange").withArgs(0);
      await expect(f.Feed.deploy(pyth, ID, MAX_AGE, 50_001, "")).to.be.revertedWithCustomError(f.Feed, "MaxConfidenceOutOfRange").withArgs(50_001);
      await f.Feed.deploy(pyth, ID, 10, 50_000, "");
      await f.Feed.deploy(pyth, ID, 3600, 1, "");
    });
  });

  describe("reads", function () {
    it("returns the stored price at 8 decimals with the publish time as round and stamps", async function () {
      const f = await loadFixture(fixture);
      const [roundId, answer, startedAt, updatedAt, answeredInRound] = await f.feed.latestRoundData();
      expect(answer).to.equal(PRICE);
      expect(roundId).to.equal(f.publishTime);
      expect(answeredInRound).to.equal(f.publishTime);
      expect(startedAt).to.equal(f.publishTime);
      expect(updatedAt).to.equal(f.publishTime);
      expect(await f.feed.readPrice()).to.deep.equal([PRICE, BigInt(Status.OK)]);
    });

    it("rescales exponents above and below -8 exactly, flooring the division", async function () {
      const f = await loadFixture(fixture);
      expect(await f.feed.convert(4000n, 0n, 0)).to.deep.equal([4000_00000000n, BigInt(Status.OK)]);
      expect(await f.feed.convert(4000_00n, 0n, -2)).to.deep.equal([4000_00000000n, BigInt(Status.OK)]);
      expect(await f.feed.convert(4000_000000000000n, 0n, -12)).to.deep.equal([4000_00000000n, BigInt(Status.OK)]);
      expect(await f.feed.convert(4000_000000009999n, 0n, -12)).to.deep.equal([4000_00000000n, BigInt(Status.OK)]);
      // int64 holds at most 9.2e18, so a -18 exponent can only express prices under $9.22.
      expect(await f.feed.convert(4000_00000000000000n, 0n, -14)).to.deep.equal([4000_00000000n, BigInt(Status.OK)]);
      expect(await f.feed.convert(9_000000000000000000n, 0n, -18)).to.deep.equal([9_00000000n, BigInt(Status.OK)]);
      expect(await f.feed.convert(1n, 0n, -18)).to.deep.equal([0n, BigInt(Status.PRICE_OUT_OF_RANGE)]);
      expect(await f.feed.convert(10n ** 13n, 0n, 0)).to.deep.equal([0n, BigInt(Status.PRICE_OUT_OF_RANGE)]);
      expect(await f.feed.convert(10n ** 12n, 0n, 0)).to.deep.equal([10n ** 20n, BigInt(Status.OK)]);
    });

    it("answers 0 for a non positive price, an exponent outside -18..0 and a confidence above the cap", async function () {
      const f = await loadFixture(fixture);
      expect(await f.feed.convert(0n, 0n, -8)).to.deep.equal([0n, BigInt(Status.INVALID_PRICE)]);
      expect(await f.feed.convert(-1n, 0n, -8)).to.deep.equal([0n, BigInt(Status.INVALID_PRICE)]);
      expect(await f.feed.convert(PRICE, 0n, -19)).to.deep.equal([0n, BigInt(Status.EXPONENT_OUT_OF_RANGE)]);
      expect(await f.feed.convert(PRICE, 0n, 1)).to.deep.equal([0n, BigInt(Status.EXPONENT_OUT_OF_RANGE)]);
      // The comparison is exact: 5,000 ppm of $4,000 is $20.00, which is accepted, and one
      // unit of confidence more is refused, although it is still 5,000 ppm in whole numbers.
      expect((await f.feed.convert(PRICE, 19_99999999n, -8))[1]).to.equal(Status.OK);
      expect((await f.feed.convert(PRICE, 20_00000000n, -8))[1]).to.equal(Status.OK);
      expect(await f.feed.convert(PRICE, 20_00000001n, -8)).to.deep.equal([0n, BigInt(Status.WIDE_CONFIDENCE)]);
      expect(await f.feed.convert(PRICE, 20_00399999n, -8)).to.deep.equal([0n, BigInt(Status.WIDE_CONFIDENCE)]);
    });

    it("answers 0 with every field 0 when the stored price is stale, from the future or invalid", async function () {
      const f = await loadFixture(fixture);
      const now = await time.latest();
      const zeros = [0n, 0n, 0n, 0n, 0n];
      await f.pyth.setPrice(ID, PRICE, 0n, -8, now - MAX_AGE - 5);
      expect(await f.feed.latestRoundData()).to.deep.equal(zeros);
      expect(await f.feed.readPrice()).to.deep.equal([0n, BigInt(Status.STALE)]);
      await f.pyth.setPrice(ID, PRICE, 0n, -8, now + 1000);
      expect(await f.feed.latestRoundData()).to.deep.equal(zeros);
      expect(await f.feed.readPrice()).to.deep.equal([0n, BigInt(Status.FUTURE_PUBLISH_TIME)]);
      await f.pyth.setPrice(ID, PRICE, 100_00000000n, -8, now);
      expect(await f.feed.latestRoundData()).to.deep.equal(zeros);
      expect(await f.feed.readPrice()).to.deep.equal([0n, BigInt(Status.WIDE_CONFIDENCE)]);
      await f.pyth.setPrice(ID, PRICE, 0n, -8, now - MAX_AGE + 5);
      expect((await f.feed.latestRoundData())[1]).to.equal(PRICE);
    });

    it("answers 0 when Pyth itself reverts on the read", async function () {
      const f = await loadFixture(fixture);
      await f.pyth.setRevertOnRead(true);
      expect(await f.feed.latestRoundData()).to.deep.equal([0n, 0n, 0n, 0n, 0n]);
      expect(await f.feed.readPrice()).to.deep.equal([0n, BigInt(Status.FEED_FAILED)]);
    });
  });

  describe("updatePrice", function () {
    it("passes the fee through, forwards exactly it and refunds the rest", async function () {
      const f = await loadFixture(fixture);
      await f.pyth.setFeePerUpdate(ethers.parseEther("0.01"));
      const now = await time.latest();
      const updates = [await update(f.pyth, 4010_00000000n, now + 1), await update(f.pyth, 4005_00000000n, now)];
      expect(await f.feed.getUpdateFee(updates)).to.equal(ethers.parseEther("0.02"));
      const before = await ethers.provider.getBalance(f.other.address);
      const tx = await f.feed.connect(f.other).updatePrice(updates, { value: ethers.parseEther("1") });
      const receipt = await tx.wait();
      const gasPaid = receipt!.gasUsed * receipt!.gasPrice;
      expect(await ethers.provider.getBalance(f.other.address)).to.equal(before - ethers.parseEther("0.02") - gasPaid);
      await expect(tx).to.emit(f.feed, "PriceUpdated").withArgs(f.other.address, ethers.parseEther("0.02"), ethers.parseEther("0.98"));
      expect(await f.pyth.feesReceived()).to.equal(ethers.parseEther("0.02"));
      expect(await ethers.provider.getBalance(await f.feed.getAddress())).to.equal(0);
      // Only the newer of the two updates was stored.
      expect(await f.pyth.updatesApplied()).to.equal(1);
      expect((await f.feed.latestRoundData())[1]).to.equal(4010_00000000n);
    });

    it("works with a zero fee and no value, as on mainnet today", async function () {
      const f = await loadFixture(fixture);
      const now = await time.latest();
      await expect(f.feed.updatePrice([await update(f.pyth, 4020_00000000n, now + 1)]))
        .to.emit(f.feed, "PriceUpdated").withArgs(f.deployer.address, 0, 0);
      expect((await f.feed.latestRoundData())[1]).to.equal(4020_00000000n);
    });

    it("reverts on an underpaid fee and when Pyth rejects the update", async function () {
      const f = await loadFixture(fixture);
      await f.pyth.setFeePerUpdate(100n);
      const now = await time.latest();
      const updates = [await update(f.pyth, PRICE, now)];
      await expect(f.feed.updatePrice(updates, { value: 99n })).to.be.revertedWithCustomError(f.feed, "InsufficientFee").withArgs(100n, 99n);
      await f.pyth.setRevertOnUpdate(true);
      await expect(f.feed.updatePrice(updates, { value: 100n })).to.be.revertedWith("InvalidUpdateData");
    });

    it("does not let a relayer that rejects the refund block the update, and holds the excess for it", async function () {
      const f = await loadFixture(fixture);
      await f.pyth.setFeePerUpdate(1000n);
      await f.relayer.setAcceptEth(false);
      const now = await time.latest();
      const relayerAddress = await f.relayer.getAddress();
      await expect(f.relayer.relay(f.feed, [await update(f.pyth, 4030_00000000n, now + 1)], { value: 1500n }))
        .to.emit(f.feed, "RefundFailed").withArgs(relayerAddress, 500n)
        // Nothing was refunded: the excess is owed, not paid, and the summary says so.
        .and.to.emit(f.feed, "PriceUpdated").withArgs(relayerAddress, 1000n, 0n);
      expect((await f.feed.latestRoundData())[1]).to.equal(4030_00000000n);
      expect(await f.feed.pendingRefunds(relayerAddress)).to.equal(500n);
      expect(await ethers.provider.getBalance(await f.feed.getAddress())).to.equal(500n);
      await expect(f.relayer.claim(f.feed)).to.be.revertedWithCustomError(f.feed, "RefundTransferFailed").withArgs(relayerAddress, 500n);
      await f.relayer.setAcceptEth(true);
      await expect(f.relayer.claim(f.feed)).to.emit(f.feed, "RefundClaimed").withArgs(relayerAddress, 500n);
      expect(await f.relayer.received()).to.equal(500n);
      expect(await f.feed.pendingRefunds(relayerAddress)).to.equal(0);
      await expect(f.relayer.claim(f.feed)).to.be.revertedWithCustomError(f.feed, "NothingToClaim");
      await expect(f.feed.claimRefund()).to.be.revertedWithCustomError(f.feed, "NothingToClaim");
    });

    it("refunds a relayer contract that accepts ETH directly", async function () {
      const f = await loadFixture(fixture);
      await f.pyth.setFeePerUpdate(1000n);
      const now = await time.latest();
      await f.relayer.relay(f.feed, [await update(f.pyth, PRICE, now + 1)], { value: 1500n });
      expect(await f.relayer.received()).to.equal(500n);
      expect(await f.feed.pendingRefunds(await f.relayer.getAddress())).to.equal(0);
    });
  });
});
