import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import {
  productionSystem,
  setValidPrice,
  GOLD_PRICE,
  MIN_RATIO,
  LIQ_RATIO,
  LIQ_PENALTY,
  DEBT_CEILING,
  SILO_CAP,
} from "./helpers/productionSystem";

/**
 * Branch coverage for src/core/GoldVault.sol.
 *
 * Each test takes one arm that the main suites leave untaken: a modifier's revert, a
 * require's failing input, or the rarer side of an if or a ternary. Every test restores
 * the production fixture, so none depends on another.
 *
 * Price moves walk the feed in steps of at most nine percent and record each step with
 * the state-changing oracle read, because the oracle refuses a single move beyond ten
 * percent of its last known price.
 */

type System = Awaited<ReturnType<typeof productionSystem>>;
type Signer = System["alice"];
type Feed = System["paxgFeed"];

interface CollateralToken {
  getAddress(): Promise<string>;
  mint(to: string, amount: bigint): Promise<unknown>;
  connect(signer: Signer): { approve(spender: string, amount: bigint): Promise<unknown> };
}

const ONE = ethers.parseEther("1");
const DEBT = ethers.parseEther("1200");
const PARTIAL = ethers.parseEther("600");
const DUST_PARTIAL = ethers.parseEther("1150");
const OVERSHOOT = ethers.parseEther("1000000");
const POOL_FUNDING = ethers.parseEther("5000");
const PRICE_1300 = 1300n * 10n ** 8n;
const PRICE_1100 = 1100n * 10n ** 8n;
const STANDARD_RATE_BPS = 200;
const ZERO_RATE_BPS = 0;
const FEE_FIVE_PERCENT = 500n;
const FEE_NINETY_NINE_PERCENT = 9900n;
const XAUT_TENTH = 100_000n;
const XAUT_DUST_DEBT = ethers.parseEther("120");

const collateralId = (token: string) =>
  ethers.keccak256(ethers.solidityPacked(["address"], [token]));

// ---------- helpers ----------

async function walkPrice(sys: System, feed: Feed, token: string, target: bigint) {
  let current = await sys.oracle.getLastKnownPrice(token);
  while (current !== target) {
    const falling = current > target;
    const stepped = falling ? (current * 91n) / 100n : (current * 109n) / 100n;
    const overshoots = falling ? stepped < target : stepped > target;
    const next = overshoots ? target : stepped;
    await setValidPrice(feed, next);
    await sys.oracle.getTokenPrice(token);
    current = next;
  }
}

async function openPaxgVault(sys: System, debt: bigint = DEBT) {
  await sys.vault.connect(sys.alice).deposit(await sys.paxg.getAddress(), ONE);
  await sys.vault.connect(sys.alice).mint(debt);
}

async function openLiquidatablePaxgVault(sys: System, price: bigint = PRICE_1300) {
  await openPaxgVault(sys);
  await walkPrice(sys, sys.paxgFeed, await sys.paxg.getAddress(), price);
}

async function openLiquidatableXautDustVault(sys: System) {
  await sys.vault.connect(sys.charlie).deposit(await sys.xaut.getAddress(), XAUT_TENTH);
  await sys.vault.connect(sys.charlie).mint(XAUT_DUST_DEBT);
  await walkPrice(sys, sys.xautFeed, await sys.xaut.getAddress(), PRICE_1300);
}

async function wireCollateral(sys: System, token: CollateralToken, annualRateBps: number) {
  const tokenAddr = await token.getAddress();
  const feed = await (await ethers.getContractFactory("MockAggregatorV3")).deploy(8);
  await setValidPrice(feed, GOLD_PRICE);
  await sys.oracle.addFeed(tokenAddr, await feed.getAddress());
  await sys.vault.addCollateralType(tokenAddr, MIN_RATIO, LIQ_RATIO, LIQ_PENALTY, DEBT_CEILING);
  await sys.stabilityModule.initCollateral(collateralId(tokenAddr), annualRateBps);
  await sys.stabilityPool.addCollateralToken(tokenAddr);
  await sys.reserve.setAssetConfig(tokenAddr, true, 0n, 1_000_000n);
  await sys.oracle.getTokenPrice(tokenAddr);
  await token.mint(sys.alice.address, ethers.parseEther("1000000"));
  await token.connect(sys.alice).approve(await sys.vault.getAddress(), ethers.MaxUint256);
  return { tokenAddr, feed };
}

async function openLiquidatableFeeVault(sys: System, feeBps: bigint, depositAmount: bigint) {
  const token = await (await ethers.getContractFactory("MockERC20FeeOnTransfer")).deploy(
    "Fee Gold",
    "FEE",
    feeBps
  );
  const { tokenAddr, feed } = await wireCollateral(sys, token, STANDARD_RATE_BPS);
  await sys.vault.connect(sys.alice).deposit(tokenAddr, depositAmount);
  // 1200 GSUSD of debt per whole token; both sides carry eighteen decimals.
  const credited = (await sys.vault.vaults(sys.alice.address)).collateralAmount;
  const debt = credited * 1200n;
  await sys.vault.connect(sys.alice).mint(debt);
  await walkPrice(sys, feed, tokenAddr, PRICE_1300);
  return { token, tokenAddr, feed, credited, debt };
}

async function openUnderwaterZeroRateVault(sys: System) {
  const token = await (await ethers.getContractFactory("MockERC20")).deploy("Zero Fee Gold", "ZERO", 18);
  const { tokenAddr, feed } = await wireCollateral(sys, token, ZERO_RATE_BPS);
  await sys.vault.connect(sys.alice).deposit(tokenAddr, ONE);
  await sys.vault.connect(sys.alice).mint(DEBT);
  await walkPrice(sys, feed, tokenAddr, PRICE_1100);
  return { token, tokenAddr, feed };
}

async function fundBuffer(sys: System, amount: bigint) {
  await sys.surplusBuffer.grantRole(await sys.surplusBuffer.VAULT_ROLE(), sys.deployer.address);
  await sys.stablecoin.mint(sys.deployer.address, amount);
  await sys.stablecoin.approve(await sys.surplusBuffer.getAddress(), amount);
  await sys.surplusBuffer.depositFee(amount);
}

async function fundPool(sys: System, amount: bigint = POOL_FUNDING) {
  await sys.stabilityPool.connect(sys.alice).deposit(amount);
}

// ---------- tests ----------

describe("GoldVault branch coverage", function () {
  describe("collateral types", function () {
    it("refuses a collateral token with more than eighteen decimals", async function () {
      const sys = await loadFixture(productionSystem);
      const token = await (await ethers.getContractFactory("MockERC20")).deploy("Wide", "WIDE", 19);
      await expect(
        sys.vault.addCollateralType(await token.getAddress(), MIN_RATIO, LIQ_RATIO, LIQ_PENALTY, DEBT_CEILING)
      ).to.be.revertedWith("Decimals must be 2 to 18");
    });

    it("refuses to update a collateral type that is not active", async function () {
      const sys = await loadFixture(productionSystem);
      await expect(
        sys.vault.updateCollateralRatios(sys.bob.address, MIN_RATIO, LIQ_RATIO, LIQ_PENALTY)
      ).to.be.revertedWith("Not active");
      await expect(sys.vault.setDebtCeiling(sys.bob.address, DEBT_CEILING)).to.be.revertedWith("Not active");
    });
  });

  describe("withdraw", function () {
    it("refuses a withdrawal larger than the collateral held", async function () {
      const sys = await loadFixture(productionSystem);
      await sys.vault.connect(sys.alice).deposit(await sys.paxg.getAddress(), ONE);
      await expect(sys.vault.connect(sys.alice).withdraw(ONE * 2n)).to.be.revertedWith(
        "Insufficient collateral"
      );
    });
  });

  describe("mint", function () {
    it("refuses to mint while the vault is paused", async function () {
      const sys = await loadFixture(productionSystem);
      await sys.vault.connect(sys.alice).deposit(await sys.paxg.getAddress(), ONE);
      await sys.vault.connect(sys.guardian).emergencyPause();
      await expect(sys.vault.connect(sys.alice).mint(DEBT)).to.be.revertedWithCustomError(
        sys.vault,
        "EnforcedPause"
      );
    });

    it("refuses to mint with no collateral deposited", async function () {
      const sys = await loadFixture(productionSystem);
      await expect(sys.vault.connect(sys.bob).mint(DEBT)).to.be.revertedWith("No collateral");
    });
  });

  describe("repay", function () {
    it("refuses to repay when the vault carries no debt", async function () {
      const sys = await loadFixture(productionSystem);
      await sys.vault.connect(sys.alice).deposit(await sys.paxg.getAddress(), ONE);
      await expect(sys.vault.connect(sys.alice).repay(ONE)).to.be.revertedWith("No debt");
    });
  });

  describe("retryBadDebtAbsorption", function () {
    it("refuses when no surplus buffer is wired", async function () {
      const sys = await loadFixture(productionSystem);
      const bare = await (await ethers.getContractFactory("GoldVault")).deploy(
        await sys.oracle.getAddress(),
        await sys.stablecoin.getAddress(),
        await sys.stabilityModule.getAddress()
      );
      await expect(bare.retryBadDebtAbsorption()).to.be.revertedWith("No buffer");
    });

    it("refuses when there is no bad debt outstanding", async function () {
      const sys = await loadFixture(productionSystem);
      await expect(sys.vault.retryBadDebtAbsorption()).to.be.revertedWith("No bad debt");
    });

    it("refuses when the buffer holds nothing to absorb", async function () {
      const sys = await loadFixture(productionSystem);
      await openUnderwaterZeroRateVault(sys);
      await sys.vault.connect(sys.bob).liquidate(sys.alice.address, 0);

      // A zero stability fee means no fee portion ever reached the buffer, so the
      // liquidation's own absorption attempt received nothing and the bad debt stands whole.
      expect(await sys.vault.totalBadDebt()).to.equal(ethers.parseEther("122"));
      expect(await sys.surplusBuffer.gsusdBalance()).to.equal(0n);
      await expect(sys.vault.retryBadDebtAbsorption()).to.be.revertedWith("Nothing absorbed");
    });

    it("burns what the buffer returns and reduces the bad debt", async function () {
      const sys = await loadFixture(productionSystem);
      await openUnderwaterZeroRateVault(sys);
      await sys.vault.connect(sys.bob).liquidate(sys.alice.address, 0);
      const outstanding = await sys.vault.totalBadDebt();
      const topUp = ethers.parseEther("60");
      await fundBuffer(sys, topUp);

      await expect(sys.vault.retryBadDebtAbsorption()).to.emit(sys.vault, "BadDebtRetried").withArgs(topUp);
      expect(await sys.vault.totalBadDebt()).to.equal(outstanding - topUp);
    });

    it("absorbs bad debt from a funded buffer at the moment of liquidation", async function () {
      const sys = await loadFixture(productionSystem);
      await fundBuffer(sys, ethers.parseEther("1000"));
      await openLiquidatablePaxgVault(sys, PRICE_1100);
      await sys.vault.connect(sys.bob).liquidate(sys.alice.address, 0);

      expect(await sys.vault.totalBadDebt()).to.equal(0n);
      await expect(sys.vault.retryBadDebtAbsorption()).to.be.revertedWith("No bad debt");
    });
  });

  describe("liquidate", function () {
    it("refuses to liquidate while the vault is paused", async function () {
      const sys = await loadFixture(productionSystem);
      await openLiquidatablePaxgVault(sys);
      await sys.vault.connect(sys.guardian).emergencyPause();
      await expect(sys.vault.connect(sys.bob).liquidate(sys.alice.address, 0)).to.be.revertedWithCustomError(
        sys.vault,
        "EnforcedPause"
      );
    });

    it("refuses to liquidate a vault with no debt", async function () {
      const sys = await loadFixture(productionSystem);
      await expect(sys.vault.connect(sys.bob).liquidate(sys.alice.address, 0)).to.be.revertedWith("No debt");
    });

    it("refuses a repayment larger than the vault's debt", async function () {
      const sys = await loadFixture(productionSystem);
      await openLiquidatablePaxgVault(sys);
      await expect(sys.vault.connect(sys.bob).liquidate(sys.alice.address, OVERSHOOT)).to.be.revertedWith(
        "Exceeds vault debt"
      );
    });

    it("clears the whole position on a full liquidation", async function () {
      const sys = await loadFixture(productionSystem);
      await openLiquidatablePaxgVault(sys);
      await sys.vault.connect(sys.bob).liquidate(sys.alice.address, 0);
      const vault = await sys.vault.vaults(sys.alice.address);
      expect(vault.debtAmount).to.equal(0n);
      expect(vault.collateralAmount).to.be.gt(0n);
    });

    it("repays principal pro rata on a partial liquidation", async function () {
      const sys = await loadFixture(productionSystem);
      await openLiquidatablePaxgVault(sys);
      await sys.vault.connect(sys.bob).liquidate(sys.alice.address, PARTIAL);
      const vault = await sys.vault.vaults(sys.alice.address);
      expect(vault.debtAmount).to.be.gt(0n);
      expect(vault.debtAmount).to.be.lt(DEBT);
    });

    it("refuses a partial liquidation that leaves a residual below MIN_DEBT", async function () {
      const sys = await loadFixture(productionSystem);
      await openLiquidatablePaxgVault(sys);
      await expect(sys.vault.connect(sys.bob).liquidate(sys.alice.address, DUST_PARTIAL)).to.be.revertedWith(
        "Residual debt below minimum"
      );
    });

    it("pays the liquidator only what arrived when the collateral charges a transfer fee", async function () {
      const sys = await loadFixture(productionSystem);
      const { token, tokenAddr } = await openLiquidatableFeeVault(sys, FEE_FIVE_PERCENT, ONE);
      await sys.vault.connect(sys.bob).liquidate(sys.alice.address, 0);

      // Each recipient is paid straight from the silos and loses the fee on its own leg:
      // the liquidator receives its share net of the fee, the protocol's share arrives
      // here net of the fee and is routed on, and nothing is left behind in the vault.
      expect(await token.balanceOf(sys.bob.address)).to.be.gt(0n);
      expect((await sys.vault.vaults(sys.alice.address)).debtAmount).to.equal(0n);
      expect(await token.balanceOf(await sys.vault.getAddress())).to.equal(0n);
      expect(await sys.surplusBuffer.collateralBalance(tokenAddr)).to.be.gt(0n);
      expect(await sys.reserve.collateralBalance(tokenAddr)).to.be.gt(0n);
      expect(await sys.vault.surplusCollateral(tokenAddr)).to.equal(0n);
    });

    it("caps the repayment at what the collateral covers when the vault is underwater", async function () {
      const sys = await loadFixture(productionSystem);
      await openLiquidatablePaxgVault(sys, PRICE_1100);
      const before = await sys.stablecoin.balanceOf(sys.bob.address);
      await sys.vault.connect(sys.bob).liquidate(sys.alice.address, 0);

      // $1,100 of gold sells at the 2% underwater discount: the liquidator pays 1,078.
      expect(before - (await sys.stablecoin.balanceOf(sys.bob.address))).to.equal(ethers.parseEther("1078"));
      expect(await sys.vault.totalBadDebt()).to.be.gt(0n);
      expect((await sys.vault.vaults(sys.alice.address)).collateralAmount).to.equal(0n);
    });

    it("refuses a repayment too small to move any collateral", async function () {
      const sys = await loadFixture(productionSystem);
      await openLiquidatablePaxgVault(sys);
      await expect(sys.vault.connect(sys.bob).liquidate(sys.alice.address, 1n)).to.be.revertedWith(
        "Liquidation too small"
      );
    });

    it("sends nothing to the reserve when its penalty share is zero", async function () {
      const sys = await loadFixture(productionSystem);
      await sys.vault.setReservePenaltyShare(0);
      await openLiquidatablePaxgVault(sys);
      await expect(sys.vault.connect(sys.bob).liquidate(sys.alice.address, 0)).to.not.emit(
        sys.vault,
        "PenaltyRoutedToReserve"
      );
    });

    it("skips the reserve when its share of a dust penalty rounds to zero", async function () {
      const sys = await loadFixture(productionSystem);
      await sys.vault.setReservePenaltyShare(1);
      await openLiquidatableXautDustVault(sys);
      await expect(sys.vault.connect(sys.bob).liquidate(sys.charlie.address, 0)).to.not.emit(
        sys.vault,
        "PenaltyRoutedToReserve"
      );
      expect((await sys.vault.vaults(sys.charlie.address)).debtAmount).to.equal(0n);
    });
  });

  describe("emergencyLiquidate", function () {
    it("refuses when neither the vault nor the oracle is paused", async function () {
      const sys = await loadFixture(productionSystem);
      await openLiquidatablePaxgVault(sys);
      await expect(sys.vault.connect(sys.bob).emergencyLiquidate(sys.alice.address, 0)).to.be.revertedWith(
        "Not in emergency"
      );
    });

    it("refuses to emergency liquidate a vault with no debt", async function () {
      const sys = await loadFixture(productionSystem);
      await sys.vault.connect(sys.guardian).emergencyPause();
      await expect(sys.vault.connect(sys.bob).emergencyLiquidate(sys.alice.address, 0)).to.be.revertedWith(
        "No debt"
      );
    });

    it("refuses when neither a last known nor a live price exists", async function () {
      const sys = await loadFixture(productionSystem);
      await openPaxgVault(sys);
      const freshOracle = await (await ethers.getContractFactory("GoldOracle")).deploy(
        await sys.paxgFeed.getAddress(),
        await sys.xautFeed.getAddress(),
        await sys.paxg.getAddress(),
        await sys.xaut.getAddress(),
        3600
      );
      await sys.vault.setOracle(await freshOracle.getAddress());
      await sys.vault.connect(sys.guardian).emergencyPause();
      const ts = await time.latest();
      await sys.paxgFeed.setLatestRoundData(1, 0n, ts, ts, 1);

      await expect(sys.vault.connect(sys.bob).emergencyLiquidate(sys.alice.address, 0)).to.be.revertedWith(
        "No price"
      );
    });

    it("refuses an emergency repayment larger than the vault's debt", async function () {
      const sys = await loadFixture(productionSystem);
      await openLiquidatablePaxgVault(sys);
      await sys.vault.connect(sys.guardian).emergencyPause();
      await expect(
        sys.vault.connect(sys.bob).emergencyLiquidate(sys.alice.address, OVERSHOOT)
      ).to.be.revertedWith("Exceeds vault debt");
    });

    it("clears the whole position on a full emergency liquidation", async function () {
      const sys = await loadFixture(productionSystem);
      await openLiquidatablePaxgVault(sys);
      await sys.vault.connect(sys.guardian).emergencyPause();
      await sys.vault.connect(sys.bob).emergencyLiquidate(sys.alice.address, 0);
      expect((await sys.vault.vaults(sys.alice.address)).debtAmount).to.equal(0n);
    });

    it("repays principal pro rata on a partial emergency liquidation", async function () {
      const sys = await loadFixture(productionSystem);
      await openLiquidatablePaxgVault(sys);
      await sys.vault.connect(sys.guardian).emergencyPause();
      await sys.vault.connect(sys.bob).emergencyLiquidate(sys.alice.address, PARTIAL);
      const vault = await sys.vault.vaults(sys.alice.address);
      expect(vault.debtAmount).to.be.gt(0n);
      expect(vault.debtAmount).to.be.lt(DEBT);
    });

    it("refuses a partial emergency liquidation that leaves a residual below MIN_DEBT", async function () {
      const sys = await loadFixture(productionSystem);
      await openLiquidatablePaxgVault(sys);
      await sys.vault.connect(sys.guardian).emergencyPause();
      await expect(
        sys.vault.connect(sys.bob).emergencyLiquidate(sys.alice.address, DUST_PARTIAL)
      ).to.be.revertedWith("Residual debt below minimum");
    });

    it("pays the emergency liquidator only what arrived when the collateral charges a transfer fee", async function () {
      const sys = await loadFixture(productionSystem);
      const { token, tokenAddr } = await openLiquidatableFeeVault(sys, FEE_FIVE_PERCENT, ONE);
      await sys.oracle.connect(sys.guardian).emergencyPause();
      await sys.vault.connect(sys.bob).emergencyLiquidate(sys.alice.address, 0);

      expect(await token.balanceOf(sys.bob.address)).to.be.gt(0n);
      expect((await sys.vault.vaults(sys.alice.address)).debtAmount).to.equal(0n);
      expect(await token.balanceOf(await sys.vault.getAddress())).to.equal(0n);
      expect(await sys.surplusBuffer.collateralBalance(tokenAddr)).to.be.gt(0n);
      expect(await sys.reserve.collateralBalance(tokenAddr)).to.be.gt(0n);
      expect(await sys.vault.surplusCollateral(tokenAddr)).to.equal(0n);
    });
  });

  describe("views", function () {
    it("reports an infinite ratio when the stability module records no debt for a vault with principal", async function () {
      const sys = await loadFixture(productionSystem);
      await openPaxgVault(sys);
      await sys.stabilityModule.grantRole(await sys.stabilityModule.VAULT_ROLE(), sys.deployer.address);
      await sys.stabilityModule.clearDebt(sys.alice.address, sys.paxgId);

      expect((await sys.vault.vaults(sys.alice.address)).debtAmount).to.equal(DEBT);
      expect(await sys.vault.getCollateralisationRatio(sys.alice.address)).to.equal(ethers.MaxUint256);
    });

    it("reports zero current debt for an address without a vault", async function () {
      const sys = await loadFixture(productionSystem);
      expect(await sys.vault.getVaultCurrentDebt(sys.bob.address)).to.equal(0n);
      await openPaxgVault(sys);
      expect(await sys.vault.getVaultCurrentDebt(sys.alice.address)).to.be.gte(DEBT);
    });

    it("reports a zero liquidation price without collateral or without debt", async function () {
      const sys = await loadFixture(productionSystem);
      expect(await sys.vault.getLiquidationPrice(sys.bob.address)).to.equal(0n);

      await sys.vault.connect(sys.alice).deposit(await sys.paxg.getAddress(), ONE);
      expect(await sys.vault.getLiquidationPrice(sys.alice.address)).to.equal(0n);

      await sys.vault.connect(sys.alice).mint(DEBT);
      expect(await sys.vault.getLiquidationPrice(sys.alice.address)).to.be.gte(1320n * 10n ** 8n);
    });
  });

  describe("liquidateViaPool", function () {
    it("refuses to pool liquidate a healthy vault", async function () {
      const sys = await loadFixture(productionSystem);
      await openPaxgVault(sys);
      await expect(sys.vault.connect(sys.bob).liquidateViaPool(sys.alice.address, 0)).to.be.revertedWith(
        "Not undercollateralised"
      );
    });

    it("refuses a pool repayment larger than the vault's debt", async function () {
      const sys = await loadFixture(productionSystem);
      await openLiquidatablePaxgVault(sys);
      await expect(
        sys.vault.connect(sys.bob).liquidateViaPool(sys.alice.address, OVERSHOOT)
      ).to.be.revertedWith("Exceeds vault debt");
    });

    it("clears the whole position on a full pool liquidation", async function () {
      const sys = await loadFixture(productionSystem);
      await openLiquidatablePaxgVault(sys);
      await fundPool(sys);
      await sys.vault.connect(sys.bob).liquidateViaPool(sys.alice.address, 0);
      expect((await sys.vault.vaults(sys.alice.address)).debtAmount).to.equal(0n);
      expect(await sys.paxg.balanceOf(sys.bob.address)).to.be.gt(ethers.parseEther("100"));
    });

    it("repays principal pro rata on a partial pool liquidation", async function () {
      const sys = await loadFixture(productionSystem);
      await openLiquidatablePaxgVault(sys);
      await fundPool(sys);
      await sys.vault.connect(sys.bob).liquidateViaPool(sys.alice.address, PARTIAL);
      const vault = await sys.vault.vaults(sys.alice.address);
      expect(vault.debtAmount).to.be.gt(0n);
      expect(vault.debtAmount).to.be.lt(DEBT);
    });

    it("refuses a partial pool liquidation that leaves a residual below MIN_DEBT", async function () {
      const sys = await loadFixture(productionSystem);
      await openLiquidatablePaxgVault(sys);
      await fundPool(sys);
      await expect(
        sys.vault.connect(sys.bob).liquidateViaPool(sys.alice.address, DUST_PARTIAL)
      ).to.be.revertedWith("Residual debt below minimum");
    });

    // The silos pay the pool and the keeper directly, so
    // each leg bears its own transfer fee and the pool credits exactly what arrived; nothing
    // passes through the vault, which therefore cannot be short of a payout.
    it("pays the keeper and the pool straight from the silos when the collateral charges a transfer fee", async function () {
      const sys = await loadFixture(productionSystem);
      const { token, tokenAddr } = await openLiquidatableFeeVault(sys, FEE_NINETY_NINE_PERCENT, ONE * 10_000n);
      await fundPool(sys);
      await sys.vault.connect(sys.bob).liquidateViaPool(sys.alice.address, 0);

      expect(await token.balanceOf(sys.bob.address)).to.be.gt(0n);
      const pooled = await token.balanceOf(await sys.stabilityPool.getAddress());
      expect(pooled).to.be.gt(0n);
      expect(await sys.stabilityPool.collateralAccounted(tokenAddr)).to.equal(pooled);
      expect(await token.balanceOf(await sys.vault.getAddress())).to.equal(0n);
      expect((await sys.vault.vaults(sys.alice.address)).debtAmount).to.equal(0n);
    });

    it("pays the keeper nothing when the liquidator incentive share is zero", async function () {
      const sys = await loadFixture(productionSystem);
      await sys.vault.setLiquidatorIncentiveShare(0);
      await openLiquidatablePaxgVault(sys);
      await fundPool(sys);
      const before = await sys.paxg.balanceOf(sys.bob.address);
      await sys.vault.connect(sys.bob).liquidateViaPool(sys.alice.address, 0);

      expect(await sys.paxg.balanceOf(sys.bob.address)).to.equal(before);
      expect((await sys.vault.vaults(sys.alice.address)).debtAmount).to.equal(0n);
    });

    it("refuses once governance has unset the stability pool", async function () {
      const sys = await loadFixture(productionSystem);
      await sys.vault.setStabilityPool(ethers.ZeroAddress);
      expect(await sys.vault.stabilityPool()).to.equal(ethers.ZeroAddress);
      await expect(sys.vault.connect(sys.bob).liquidateViaPool(sys.alice.address, 0)).to.be.revertedWith(
        "StabilityPool not set"
      );
    });
  });

  describe("admin inputs", function () {
    it("refuses a zero oracle", async function () {
      const sys = await loadFixture(productionSystem);
      await expect(sys.vault.setOracle(ethers.ZeroAddress)).to.be.revertedWith("Zero address");
    });

    it("refuses to exempt the zero address from the origination fee", async function () {
      const sys = await loadFixture(productionSystem);
      await expect(sys.vault.setOriginationFeeExempt(ethers.ZeroAddress, true)).to.be.revertedWith(
        "Zero address"
      );
    });

    it("refuses a reserve penalty share above one hundred percent", async function () {
      const sys = await loadFixture(productionSystem);
      await expect(sys.vault.setReservePenaltyShare(10001)).to.be.revertedWith("Exceeds 100%");
    });

    it("refuses a silo factory that has not granted the vault VAULT_ROLE", async function () {
      const sys = await loadFixture(productionSystem);
      const stranger = await (await ethers.getContractFactory("SiloFactory")).deploy(SILO_CAP);
      await expect(sys.vault.setSiloFactory(await stranger.getAddress())).to.be.revertedWith(
        "Factory has not granted VAULT_ROLE"
      );
    });

    it("unsets the silo factory when given the zero address", async function () {
      const sys = await loadFixture(productionSystem);
      await sys.vault.setSiloFactory(ethers.ZeroAddress);
      expect(await sys.vault.siloFactory()).to.equal(ethers.ZeroAddress);
    });

    it("refuses to grant the guardian role to the zero address", async function () {
      const sys = await loadFixture(productionSystem);
      await expect(sys.vault.grantGuardianRole(ethers.ZeroAddress)).to.be.revertedWith("Zero address");
    });

    it("refuses a governance transfer to the caller", async function () {
      const sys = await loadFixture(productionSystem);
      await expect(sys.vault.transferGovernance(sys.deployer.address)).to.be.revertedWith("Would self-revoke");
    });

    it("refuses a governance transfer to the zero address", async function () {
      const sys = await loadFixture(productionSystem);
      await expect(sys.vault.transferGovernance(ethers.ZeroAddress)).to.be.revertedWith("Zero address");
    });

    it("refuses a governance transfer to an externally owned account", async function () {
      const sys = await loadFixture(productionSystem);
      await expect(sys.vault.transferGovernance(sys.alice.address)).to.be.revertedWith(
        "Timelock must be a contract"
      );
    });
  });

  describe("emergencyPause", function () {
    it("refuses an emergency pause from an account that is neither guardian nor governance", async function () {
      const sys = await loadFixture(productionSystem);
      await expect(sys.vault.connect(sys.alice).emergencyPause()).to.be.revertedWith("Not guardian or governance");
    });

    it("lets the guardian pause", async function () {
      const sys = await loadFixture(productionSystem);
      await sys.vault.connect(sys.guardian).emergencyPause();
      expect(await sys.vault.paused()).to.equal(true);
    });

    it("lets governance pause without the guardian role", async function () {
      const sys = await loadFixture(productionSystem);
      expect(await sys.vault.hasRole(await sys.vault.GUARDIAN_ROLE(), sys.deployer.address)).to.equal(false);
      await sys.vault.emergencyPause();
      expect(await sys.vault.paused()).to.equal(true);
    });
  });

  describe("role guards", function () {
    const governanceOnly: Array<[string, (sys: System) => Promise<unknown>]> = [
      [
        "addCollateralType",
        (s) => s.vault.connect(s.alice).addCollateralType(s.alice.address, MIN_RATIO, LIQ_RATIO, LIQ_PENALTY, DEBT_CEILING),
      ],
      [
        "updateCollateralRatios",
        (s) => s.vault.connect(s.alice).updateCollateralRatios(s.alice.address, MIN_RATIO, LIQ_RATIO, LIQ_PENALTY),
      ],
      ["setDebtCeiling", (s) => s.vault.connect(s.alice).setDebtCeiling(s.alice.address, DEBT_CEILING)],
      ["setOracle", (s) => s.vault.connect(s.alice).setOracle(s.alice.address)],
      ["setLiquidatorIncentiveShare", (s) => s.vault.connect(s.alice).setLiquidatorIncentiveShare(1)],
      ["setPerBlockMintCap", (s) => s.vault.connect(s.alice).setPerBlockMintCap(1)],
      ["setOriginationFeeExempt", (s) => s.vault.connect(s.alice).setOriginationFeeExempt(s.alice.address, true)],
      ["setStabilityReserve", (s) => s.vault.connect(s.alice).setStabilityReserve(s.alice.address)],
      ["setReservePenaltyShare", (s) => s.vault.connect(s.alice).setReservePenaltyShare(1)],
      ["setSurplusBuffer", (s) => s.vault.connect(s.alice).setSurplusBuffer(s.alice.address)],
      ["setStabilityPool", (s) => s.vault.connect(s.alice).setStabilityPool(s.alice.address)],
      ["setSiloFactory", (s) => s.vault.connect(s.alice).setSiloFactory(s.alice.address)],
      ["setBadDebtPauseThreshold", (s) => s.vault.connect(s.alice).setBadDebtPauseThreshold(1)],
      [
        "withdrawSurplus",
        async (s) => s.vault.connect(s.alice).withdrawSurplus(await s.paxg.getAddress(), s.alice.address, 1),
      ],
      ["pause", (s) => s.vault.connect(s.alice).pause()],
      ["unpause", (s) => s.vault.connect(s.alice).unpause(0n)],
    ];

    for (const [name, call] of governanceOnly) {
      it(`refuses ${name} from an account without GOVERNANCE_ROLE`, async function () {
        const sys = await loadFixture(productionSystem);
        await expect(call(sys)).to.be.revertedWithCustomError(sys.vault, "AccessControlUnauthorizedAccount");
      });
    }

    const adminOnly: Array<[string, (sys: System) => Promise<unknown>]> = [
      ["grantGuardianRole", (s) => s.vault.connect(s.alice).grantGuardianRole(s.alice.address)],
      ["transferGovernance", (s) => s.vault.connect(s.alice).transferGovernance(s.timelockAddr)],
    ];

    for (const [name, call] of adminOnly) {
      it(`refuses ${name} from an account without DEFAULT_ADMIN_ROLE`, async function () {
        const sys = await loadFixture(productionSystem);
        await expect(call(sys)).to.be.revertedWithCustomError(sys.vault, "AccessControlUnauthorizedAccount");
      });
    }
  });
});
