import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { productionSystem, setValidPrice, GOLD_PRICE, SILO_CAP, MIN_RATIO, LIQ_RATIO, LIQ_PENALTY, DEBT_CEILING } from "./helpers/productionSystem";

/**
 * Wiring, custody and pause regressions, one block per fault, each test taking the path
 * that once failed.
 */
describe("Wiring and pause regressions", function () {
  const ONE = ethers.parseEther("1");
  const DAY = 24 * 60 * 60;

  describe("reserve: re-supporting an asset lists it once", function () {
    it("keeps one entry and one valuation across unsupport and re-support", async function () {
      const fx = await loadFixture(productionSystem);
      const paxgAddr = await fx.paxg.getAddress();
      await fx.paxg.connect(fx.alice).approve(await fx.reserve.getAddress(), ONE);
      await fx.reserve.connect(fx.alice).seedCollateral(paxgAddr, ONE);
      const before = await fx.reserve.reserveValueUsd();
      expect(await fx.reserve.supportedTokenCount()).to.equal(2n);
      await fx.reserve.setAssetConfig(paxgAddr, false, 0n, 1_000_000n);
      await fx.reserve.setAssetConfig(paxgAddr, true, 0n, 1_000_000n);
      await fx.reserve.setAssetConfig(paxgAddr, false, 0n, 1_000_000n);
      await fx.reserve.setAssetConfig(paxgAddr, true, 0n, 1_000_000n);
      expect(await fx.reserve.supportedTokenCount()).to.equal(2n);
      expect(await fx.reserve.reserveValueUsd()).to.equal(before);
    });
  });

  describe("silo factory: the cap is in ounces, scaled to each token", function () {
    it("rolls a 6 decimal token into a second silo at the same ounce cap as an 18 decimal one", async function () {
      const fx = await loadFixture(productionSystem);
      const xautAddr = await fx.xaut.getAddress();
      await fx.xaut.mint(fx.charlie.address, 100_000_000n); // charlie holds 200 XAUT for the test
      await fx.vault.connect(fx.charlie).deposit(xautAddr, 60_000_000n);
      await fx.vault.connect(fx.charlie).deposit(xautAddr, 60_000_000n);
      expect(await fx.siloFactory.getSiloCount(xautAddr)).to.equal(2n);
      // 18 decimal PAXG at the same cap behaves as before: 100 fills exactly one silo.
      await fx.vault.connect(fx.alice).deposit(await fx.paxg.getAddress(), SILO_CAP);
      expect(await fx.siloFactory.getSiloCount(await fx.paxg.getAddress())).to.equal(1n);
    });
  });

  describe("vault: components holding live state cannot be repointed", function () {
    it("refuses a new silo factory while the current one holds collateral, allows it once empty", async function () {
      const fx = await loadFixture(productionSystem);
      const paxgAddr = await fx.paxg.getAddress();
      const fresh = await (await ethers.getContractFactory("SiloFactory")).deploy(SILO_CAP);
      await fresh.grantRole(await fresh.VAULT_ROLE(), await fx.vault.getAddress());
      await fx.vault.connect(fx.alice).deposit(paxgAddr, ONE);
      await expect(fx.vault.setSiloFactory(await fresh.getAddress())).to.be.revertedWith("Current factory holds collateral");
      await expect(fx.vault.setSiloFactory(ethers.ZeroAddress)).to.be.revertedWith("Current factory holds collateral");
      await fx.vault.connect(fx.alice).withdraw(ONE);
      await fx.vault.setSiloFactory(await fresh.getAddress());
      expect(await fx.vault.siloFactory()).to.equal(await fresh.getAddress());
    });

    it("refuses to wire a factory over collateral the vault holds itself", async function () {
      const fx = await loadFixture(productionSystem);
      const paxgAddr = await fx.paxg.getAddress();
      const fresh = await (await ethers.getContractFactory("SiloFactory")).deploy(SILO_CAP);
      await fresh.grantRole(await fresh.VAULT_ROLE(), await fx.vault.getAddress());
      await fx.vault.setSiloFactory(ethers.ZeroAddress); // empty, so unwiring is allowed
      await fx.vault.connect(fx.alice).deposit(paxgAddr, ONE);
      expect(await fx.paxg.balanceOf(await fx.vault.getAddress())).to.equal(ONE);
      await expect(fx.vault.setSiloFactory(await fresh.getAddress())).to.be.revertedWith("Current factory holds collateral");
      // One way: even after the gold leaves, the vault stays unwired.
      await fx.vault.connect(fx.alice).withdraw(ONE);
      await expect(fx.vault.setSiloFactory(await fresh.getAddress())).to.be.revertedWith("Current factory holds collateral");
      await fx.vault.setSiloFactory(ethers.ZeroAddress);
    });

    it("refuses to rotate a factory while a frozen silo holds gold, as THREAT_MODEL C2 states", async function () {
      const fx = await loadFixture(productionSystem);
      const token = await (await ethers.getContractFactory("MockERC20Freezable")).deploy("Frozen Gold", "FGLD");
      const tokenAddr = await token.getAddress();
      const feed = await (await ethers.getContractFactory("MockAggregatorV3")).deploy(8);
      await setValidPrice(feed, GOLD_PRICE);
      await fx.oracle.addFeed(tokenAddr, await feed.getAddress());
      await fx.vault.addCollateralType(tokenAddr, MIN_RATIO, LIQ_RATIO, LIQ_PENALTY, DEBT_CEILING);
      await token.mint(fx.alice.address, SILO_CAP + ONE);
      await token.connect(fx.alice).approve(await fx.vault.getAddress(), SILO_CAP + ONE);
      await fx.vault.connect(fx.alice).deposit(tokenAddr, SILO_CAP + ONE); // two silos
      await token.setFrozen(await fx.siloFactory.getSilo(tokenAddr, 1n), true);
      await fx.vault.connect(fx.alice).withdraw(SILO_CAP); // routed around the frozen silo
      expect(await fx.siloFactory.isEmpty()).to.equal(false);
      const fresh = await (await ethers.getContractFactory("SiloFactory")).deploy(SILO_CAP);
      await fresh.grantRole(await fresh.VAULT_ROLE(), await fx.vault.getAddress());
      await expect(fx.vault.setSiloFactory(await fresh.getAddress())).to.be.revertedWith("Current factory holds collateral");
      // Once the issuer releases the gold, the factory drains and rotation goes through.
      await token.setFrozen(await fx.siloFactory.getSilo(tokenAddr, 1n), false);
      await fx.vault.connect(fx.alice).withdraw(ONE);
      await fx.vault.setSiloFactory(await fresh.getAddress());
    });

    it("has no stability module setter at all: the module is fixed at construction", async function () {
      const fx = await loadFixture(productionSystem);
      expect(fx.vault.interface.hasFunction("setStabilityModule")).to.equal(false);
      expect(await fx.vault.stabilityModule()).to.equal(await fx.stabilityModule.getAddress());
    });
  });

  describe("stability pool: no same-block deposit and withdrawal", function () {
    it("refuses the atomic deposit, absorb, withdraw shape", async function () {
      const fx = await loadFixture(productionSystem);
      const jit = await (await ethers.getContractFactory("MockPoolJit")).deploy(
        await fx.stabilityPool.getAddress(), await fx.stablecoin.getAddress()
      );
      await fx.stablecoin.mint(await jit.getAddress(), ethers.parseEther("1000"));
      await expect(jit.run(ethers.parseEther("1000"))).to.be.revertedWith("No same-block withdrawal");
      // The ordinary path, a block apart, is untouched.
      await fx.stabilityPool.connect(fx.alice).deposit(ethers.parseEther("1000"));
      await fx.stabilityPool.connect(fx.alice).withdraw(ethers.parseEther("1000"));
      expect(await fx.stabilityPool.getTotalDeposits()).to.equal(0n);
    });
  });

  describe("pauses can be extended before they lapse", function () {
    it("lets the guardian restart the vault's window and refuses everyone else", async function () {
      const fx = await loadFixture(productionSystem);
      await expect(fx.vault.connect(fx.guardian).extendPause()).to.be.revertedWith("Not paused");
      await fx.vault.connect(fx.guardian).emergencyPause();
      await time.increase(13 * DAY);
      await expect(fx.vault.connect(fx.alice).extendPause()).to.be.revertedWith("Not guardian or governance");
      await expect(fx.vault.connect(fx.guardian).extendPause()).to.emit(fx.vault, "PauseExtended");
      await time.increase(2 * DAY);
      await expect(fx.vault.unpauseExpired()).to.be.revertedWith("Pause not expired");
      await time.increase(13 * DAY);
      await fx.vault.unpauseExpired();
      expect(await fx.vault.paused()).to.equal(false);
    });

    it("works the same on the oracle and the pool", async function () {
      const fx = await loadFixture(productionSystem);
      await fx.oracle.connect(fx.guardian).emergencyPause();
      await fx.stabilityPool.connect(fx.guardian).emergencyPause();
      const oracleExpiry = await fx.oracle.pauseExpiresAt();
      const poolExpiry = await fx.stabilityPool.pauseExpiresAt();
      await time.increase(DAY);
      await fx.oracle.connect(fx.guardian).extendPause();
      await fx.stabilityPool.connect(fx.guardian).extendPause();
      expect(await fx.oracle.pauseExpiresAt()).to.be.greaterThan(oracleExpiry);
      expect(await fx.stabilityPool.pauseExpiresAt()).to.be.greaterThan(poolExpiry);
    });
  });

  describe("oracle: the guardian can lift one token's freeze once it is back on its anchor", function () {
    it("refuses a stranger and a token still off the anchor, then lifts and re-anchors", async function () {
      const fx = await loadFixture(productionSystem);
      const paxgAddr = await fx.paxg.getAddress();
      const anchor = await (await ethers.getContractFactory("MockAggregatorV3")).deploy(8);
      await setValidPrice(anchor, GOLD_PRICE);
      await fx.oracle.setAnchorFeed(await anchor.getAddress());
      await setValidPrice(fx.paxgFeed, (GOLD_PRICE * 112n) / 100n);
      // Only the guardian (or governance) freezes; there is no permissionless trip.
      await expect(fx.oracle.connect(fx.alice).freezeToken(paxgAddr)).to.be.revertedWith("Not guardian or governance");
      await fx.oracle.connect(fx.guardian).freezeToken(paxgAddr);
      expect(await fx.oracle.tokenFrozen(paxgAddr)).to.equal(true);
      expect(await fx.oracle.paused()).to.equal(false);
      await expect(fx.oracle.connect(fx.alice).guardianUnfreezeToken(paxgAddr, await fx.oracle.freezeEpoch(paxgAddr))).to.be.revertedWith("Not guardian or governance");
      // PAXG's market feed stopped: no normal read, so it stays frozen.
      const now = await time.latest();
      await fx.paxgFeed.setLatestRoundData(1, (GOLD_PRICE * 112n) / 100n, now - 100_000, now - 100_000, 1);
      await expect(fx.oracle.connect(fx.guardian).guardianUnfreezeToken(paxgAddr, await fx.oracle.freezeEpoch(paxgAddr))).to.be.revertedWith("No reliable price");
      // Gold itself moved and the feed publishes: the guardian lifts the freeze at the live price.
      await setValidPrice(fx.paxgFeed, (GOLD_PRICE * 112n) / 100n);
      await setValidPrice(anchor, (GOLD_PRICE * 112n) / 100n);
      await expect(fx.oracle.connect(fx.guardian).guardianUnfreezeToken(paxgAddr, await fx.oracle.freezeEpoch(paxgAddr)))
        .to.emit(fx.oracle, "TokenUnfrozen")
        .withArgs(paxgAddr, fx.guardian.address, (GOLD_PRICE * 112n) / 100n);
      expect(await fx.oracle.tokenFrozen(paxgAddr)).to.equal(false);
      expect(await fx.oracle.getLastKnownPrice(paxgAddr)).to.equal((GOLD_PRICE * 112n) / 100n);
      await expect(fx.oracle.connect(fx.guardian).guardianUnfreezeToken(paxgAddr, await fx.oracle.freezeEpoch(paxgAddr))).to.be.revertedWith("Not frozen");
    });
  });
});

describe("Wiring and pause regressions, second group", function () {
  const ONE = ethers.parseEther("1");
  const DAY = 24 * 60 * 60;

  async function walkPriceDown(fx: Awaited<ReturnType<typeof productionSystem>>, target: bigint) {
    let price = GOLD_PRICE;
    while (price > target) {
      const next = (price * 91n) / 100n > target ? (price * 91n) / 100n : target;
      await setValidPrice(fx.paxgFeed, next);
      await setValidPrice(fx.xautFeed, next);
      await fx.oracle.getTokenPrice(await fx.paxg.getAddress());
      await fx.oracle.getTokenPrice(await fx.xaut.getAddress());
      price = next;
    }
  }

  describe("silo factory: emptied silos are refilled, not left behind", function () {
    it("keeps the silo count flat across deposit and withdraw cycles that cross the cap", async function () {
      const fx = await loadFixture(productionSystem);
      const paxgAddr = await fx.paxg.getAddress();
      await fx.paxg.mint(fx.alice.address, ethers.parseEther("1000"));
      const over = SILO_CAP + ONE;
      for (let i = 0; i < 4; i++) {
        await fx.vault.connect(fx.alice).deposit(paxgAddr, over);
        await fx.vault.connect(fx.alice).withdraw(over);
      }
      expect(await fx.siloFactory.getSiloCount(paxgAddr)).to.equal(2n);
      expect(await fx.siloFactory.currentSiloIndex(paxgAddr)).to.equal(0n);
      await fx.vault.connect(fx.alice).deposit(paxgAddr, over);
      expect(await fx.siloFactory.getSiloCount(paxgAddr)).to.equal(2n);
    });
  });

  describe("minimum debt and underwater discount are governed", function () {
    it("bounds the minimum debt and applies it to mints", async function () {
      const fx = await loadFixture(productionSystem);
      await expect(fx.vault.connect(fx.alice).setMinDebt(ethers.parseEther("500")))
        .to.be.revertedWithCustomError(fx.vault, "AccessControlUnauthorizedAccount");
      await expect(fx.vault.setMinDebt(ethers.parseEther("99"))).to.be.revertedWith("Min debt out of range");
      await expect(fx.vault.setMinDebt(ethers.parseEther("10001"))).to.be.revertedWith("Min debt out of range");
      await expect(fx.vault.setMinDebt(ethers.parseEther("1000"))).to.emit(fx.vault, "MinDebtUpdated").withArgs(ethers.parseEther("1000"));
      await fx.vault.connect(fx.alice).deposit(await fx.paxg.getAddress(), ONE);
      await expect(fx.vault.connect(fx.alice).mint(ethers.parseEther("999"))).to.be.revertedWith("Below minimum debt");
      await fx.vault.connect(fx.alice).mint(ethers.parseEther("1000"));
    });

    it("sells underwater gold at the discount so the liquidator profits and the shortfall is booked", async function () {
      const fx = await loadFixture(productionSystem);
      await expect(fx.vault.setUnderwaterDiscount(50_001n)).to.be.revertedWith("Discount exceeds 5%");
      await expect(fx.vault.setUnderwaterDiscount(30_000n)).to.emit(fx.vault, "UnderwaterDiscountUpdated").withArgs(30_000n);
      await fx.vault.connect(fx.alice).deposit(await fx.paxg.getAddress(), ONE);
      await fx.vault.connect(fx.alice).mint(ethers.parseEther("1300"));
      await walkPriceDown(fx, 110000000000n); // $1,100 of gold against 1,300 of debt
      const before = await fx.stablecoin.balanceOf(fx.bob.address);
      const goldBefore = await fx.paxg.balanceOf(fx.bob.address);
      await fx.vault.connect(fx.bob).liquidate(fx.alice.address, 0);
      expect(before - (await fx.stablecoin.balanceOf(fx.bob.address))).to.equal(ethers.parseEther("1067")); // 1,100 less 3%
      // The discount is split like a penalty: 60% to the liquidator, 40% to the protocol.
      expect((await fx.paxg.balanceOf(fx.bob.address)) - goldBefore).to.equal(ethers.parseEther("0.988"));
      expect(await fx.vault.totalBadDebt()).to.be.greaterThan(0n);
    });
  });

  describe("reserve: a burn is credited to coverage only as it ages", function () {
    it("ignores a same-transaction burn however stale the reserve is, and credits it after a day", async function () {
      const fx = await loadFixture(productionSystem);
      const paxgAddr = await fx.paxg.getAddress();
      await fx.paxg.connect(fx.alice).approve(await fx.reserve.getAddress(), ethers.parseEther("10"));
      await fx.reserve.connect(fx.alice).seedCollateral(paxgAddr, ethers.parseEther("10"));
      await time.increase(30 * DAY); // a long quiet spell: the old anchor would have snapped to live
      const dampedBefore = await fx.reserve.dampedCirculatingSupply();
      await fx.stablecoin.connect(fx.alice).burn(ethers.parseEther("20000"));
      expect(await fx.reserve.circulatingSupply()).to.equal(dampedBefore - ethers.parseEther("20000"));
      expect(await fx.reserve.dampedCirculatingSupply()).to.equal(dampedBefore);
      await time.increase(12 * 60 * 60);
      const halfway = await fx.reserve.dampedCirculatingSupply();
      expect(halfway).to.be.lessThan(dampedBefore);
      expect(halfway).to.be.greaterThan(dampedBefore - ethers.parseEther("20000"));
      await time.increase(12 * 60 * 60 + 1);
      expect(await fx.reserve.dampedCirculatingSupply()).to.equal(await fx.reserve.circulatingSupply());
    });

    it("counts a mint at once", async function () {
      const fx = await loadFixture(productionSystem);
      const before = await fx.reserve.dampedCirculatingSupply();
      await fx.stablecoin.mint(fx.bob.address, ethers.parseEther("5000"));
      expect(await fx.reserve.dampedCirculatingSupply()).to.equal(before + ethers.parseEther("5000"));
    });
  });
});

describe("Wiring and pause regressions: liquidations survive a freeze of the vault's own address", function () {
  const ONE = ethers.parseEther("1");

  it("pays the liquidator from the silos and cedes the protocol share when the vault cannot receive", async function () {
    const fx = await loadFixture(productionSystem);
    const token = await (await ethers.getContractFactory("MockERC20Freezable")).deploy("Frozen Gold", "FGLD");
    const tokenAddr = await token.getAddress();
    const feed = await (await ethers.getContractFactory("MockAggregatorV3")).deploy(8);
    await setValidPrice(feed, GOLD_PRICE);
    await fx.oracle.addFeed(tokenAddr, await feed.getAddress());
    await fx.vault.addCollateralType(tokenAddr, MIN_RATIO, LIQ_RATIO, LIQ_PENALTY, DEBT_CEILING);
    await fx.stabilityModule.initCollateral(ethers.keccak256(ethers.solidityPacked(["address"], [tokenAddr])), 200);
    await fx.stabilityPool.addCollateralToken(tokenAddr);
    await fx.reserve.setAssetConfig(tokenAddr, true, 0n, 1_000_000n);
    await fx.oracle.getTokenPrice(tokenAddr);
    await token.mint(fx.alice.address, ONE);
    await token.connect(fx.alice).approve(await fx.vault.getAddress(), ONE);
    await fx.vault.connect(fx.alice).deposit(tokenAddr, ONE);
    await fx.vault.connect(fx.alice).mint(ethers.parseEther("1300"));
    let price = GOLD_PRICE;
    while (price > 140000000000n) {
      price = (price * 91n) / 100n > 140000000000n ? (price * 91n) / 100n : 140000000000n;
      await setValidPrice(feed, price);
      await fx.oracle.getTokenPrice(tokenAddr);
    }
    // The issuer freezes the vault's own address: nothing can be transferred INTO it.
    await token.setFrozen(await fx.vault.getAddress(), true);
    const goldBefore = await token.balanceOf(fx.bob.address);
    await expect(fx.vault.connect(fx.bob).liquidate(fx.alice.address, 0))
      .to.emit(fx.vault, "ProtocolShareCeded");
    expect((await token.balanceOf(fx.bob.address)) - goldBefore).to.be.greaterThan(0n);
    expect((await fx.vault.vaults(fx.alice.address)).debtAmount).to.equal(0n);
    expect(await token.balanceOf(await fx.vault.getAddress())).to.equal(0n);
  });

  it("routes the protocol share as before when the vault can receive", async function () {
    const fx = await loadFixture(productionSystem);
    const paxgAddr = await fx.paxg.getAddress();
    await fx.vault.connect(fx.alice).deposit(paxgAddr, ONE);
    await fx.vault.connect(fx.alice).mint(ethers.parseEther("1300"));
    let price = GOLD_PRICE;
    while (price > 140000000000n) {
      price = (price * 91n) / 100n > 140000000000n ? (price * 91n) / 100n : 140000000000n;
      await setValidPrice(fx.paxgFeed, price);
      await setValidPrice(fx.xautFeed, price);
      await fx.oracle.getTokenPrice(paxgAddr);
      await fx.oracle.getTokenPrice(await fx.xaut.getAddress());
    }
    const reserveBefore = await fx.reserve.collateralBalance(paxgAddr);
    const bufferBefore = await fx.surplusBuffer.collateralBalance(paxgAddr);
    await expect(fx.vault.connect(fx.bob).liquidate(fx.alice.address, 0)).to.not.emit(fx.vault, "ProtocolShareCeded");
    expect(await fx.reserve.collateralBalance(paxgAddr)).to.be.greaterThan(reserveBefore);
    expect(await fx.surplusBuffer.collateralBalance(paxgAddr)).to.be.greaterThan(bufferBefore);
    expect(await fx.paxg.balanceOf(await fx.vault.getAddress())).to.equal(0n);
  });
});
