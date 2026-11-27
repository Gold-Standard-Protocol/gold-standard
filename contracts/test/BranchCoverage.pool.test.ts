import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { productionSystem } from "./helpers/productionSystem";
import { absorbPrefunded } from "./helpers/poolAbsorb";

/**
 * Branch coverage for StabilityPool and SurplusBuffer: the revert arms of the role and
 * pause modifiers, the input requires, and the product-sum epoch and scale transitions
 * that the functional suites never drive.
 */

type System = Awaited<ReturnType<typeof productionSystem>>;

const ONE = ethers.parseEther("1");
const POOL_DEPOSIT = ethers.parseEther("1000"); // 1e21
const PRECISION = 10n ** 18n;
const SCALE_FACTOR = 10n ** 9n;

/** The deployer stands in for the vault: VAULT_ROLE on the pool plus PAXG to hand over. */
async function poolAsVault(s: System) {
  const pool = s.stabilityPool;
  await pool.grantRole(await pool.VAULT_ROLE(), s.deployer.address);
  await s.paxg.mint(s.deployer.address, ethers.parseEther("10"));
  return pool;
}

/** The deployer stands in for the vault on the buffer, holding GSUSD and PAXG to deposit. */
async function bufferAsVault(s: System) {
  const buffer = s.surplusBuffer;
  await buffer.grantRole(await buffer.VAULT_ROLE(), s.deployer.address);
  await s.stablecoin.mint(s.deployer.address, ethers.parseEther("10000"));
  await s.stablecoin.approve(await buffer.getAddress(), ethers.MaxUint256);
  await s.paxg.mint(s.deployer.address, ethers.parseEther("10"));
  await s.paxg.approve(await buffer.getAddress(), ethers.MaxUint256);
  return buffer;
}

describe("StabilityPool branch coverage", function () {
  describe("addCollateralToken", function () {
    it("reverts for a caller without GOVERNANCE_ROLE", async function () {
      const s = await loadFixture(productionSystem);
      await expect(
        s.stabilityPool.connect(s.alice).addCollateralToken(await s.paxg.getAddress())
      ).to.be.revertedWithCustomError(s.stabilityPool, "AccessControlUnauthorizedAccount");
    });

    it("reverts on the zero address", async function () {
      const s = await loadFixture(productionSystem);
      await expect(s.stabilityPool.addCollateralToken(ethers.ZeroAddress)).to.be.revertedWith("Zero address");
    });

    it("reverts when the token is already registered", async function () {
      const s = await loadFixture(productionSystem);
      await expect(
        s.stabilityPool.addCollateralToken(await s.paxg.getAddress())
      ).to.be.revertedWith("Already added");
    });

    it("reverts when the token has more than 18 decimals", async function () {
      const s = await loadFixture(productionSystem);
      const MockToken = await ethers.getContractFactory("MockERC20");
      const wide = await MockToken.deploy("Wide Gold", "WIDE", 24);
      await expect(
        s.stabilityPool.addCollateralToken(await wide.getAddress())
      ).to.be.revertedWith("Decimals must be <= 18");
    });

    it("reverts once ten collateral tokens are registered", async function () {
      const s = await loadFixture(productionSystem);
      const MockToken = await ethers.getContractFactory("MockERC20");
      const max = Number(await s.stabilityPool.MAX_COLLATERAL_TOKENS());
      // The fixture registers PAXG and XAUT, so eight more reach the cap.
      for (let i = 2; i < max; i++) {
        const extra = await MockToken.deploy(`Gold ${i}`, `G${i}`, 18);
        await s.stabilityPool.addCollateralToken(await extra.getAddress());
      }
      const oneTooMany = await MockToken.deploy("Gold overflow", "GOV", 18);
      await expect(
        s.stabilityPool.addCollateralToken(await oneTooMany.getAddress())
      ).to.be.revertedWith("Too many collateral tokens");
    });
  });

  describe("deposit and withdraw gates", function () {
    it("deposit reverts while the pool is paused", async function () {
      const s = await loadFixture(productionSystem);
      await s.stabilityPool.connect(s.guardian).emergencyPause();
      await expect(
        s.stabilityPool.connect(s.alice).deposit(ONE)
      ).to.be.revertedWithCustomError(s.stabilityPool, "EnforcedPause");
    });

    it("withdraw reverts while the pool is paused", async function () {
      const s = await loadFixture(productionSystem);
      await s.stabilityPool.connect(s.alice).deposit(ONE);
      await s.stabilityPool.connect(s.guardian).emergencyPause();
      await expect(
        s.stabilityPool.connect(s.alice).withdraw(ONE)
      ).to.be.revertedWithCustomError(s.stabilityPool, "EnforcedPause");
    });

    it("deposit reverts on a zero amount", async function () {
      const s = await loadFixture(productionSystem);
      await expect(s.stabilityPool.connect(s.alice).deposit(0)).to.be.revertedWith("Zero amount");
    });

    it("withdraw reverts on a zero amount", async function () {
      const s = await loadFixture(productionSystem);
      await expect(s.stabilityPool.connect(s.alice).withdraw(0)).to.be.revertedWith("Zero amount");
    });

    it("withdraw caps at the effective deposit instead of reverting", async function () {
      const s = await loadFixture(productionSystem);
      await s.stabilityPool.connect(s.alice).deposit(ONE);
      await expect(s.stabilityPool.connect(s.alice).withdraw(ONE * 2n))
        .to.emit(s.stabilityPool, "Withdrawn")
        .withArgs(s.alice.address, ONE);
      expect(await s.stabilityPool.totalDeposits()).to.equal(0n);
    });
  });

  describe("absorbLiquidationPrefunded", function () {
    it("reverts for a caller without VAULT_ROLE", async function () {
      const s = await loadFixture(productionSystem);
      await expect(
        s.stabilityPool.connect(s.alice).absorbLiquidationPrefunded(await s.paxg.getAddress(), 1n)
      ).to.be.revertedWithCustomError(s.stabilityPool, "AccessControlUnauthorizedAccount");
    });

    it("reverts for an unsupported token", async function () {
      const s = await loadFixture(productionSystem);
      const pool = await poolAsVault(s);
      await expect(
        pool.absorbLiquidationPrefunded(await s.stablecoin.getAddress(), 1n)
      ).to.be.revertedWith("Unsupported token");
    });

    it("reverts while the pool is empty", async function () {
      const s = await loadFixture(productionSystem);
      const pool = await poolAsVault(s);
      await expect(
        pool.absorbLiquidationPrefunded(await s.paxg.getAddress(), 1n)
      ).to.be.revertedWith("Pool empty");
    });

    it("reverts when the absorption would drain the pool", async function () {
      const s = await loadFixture(productionSystem);
      const pool = await poolAsVault(s);
      await pool.connect(s.alice).deposit(POOL_DEPOSIT);
      await expect(
        pool.absorbLiquidationPrefunded(await s.paxg.getAddress(), POOL_DEPOSIT)
      ).to.be.revertedWith("Absorption would drain pool");
    });
  });

  describe("claimCollateral", function () {
    it("reverts when the caller has no gains", async function () {
      const s = await loadFixture(productionSystem);
      await expect(
        s.stabilityPool.connect(s.alice).claimCollateral(await s.paxg.getAddress())
      ).to.be.revertedWith("No gains");
    });
  });

  describe("epoch reset", function () {
    it("a near total drain opens a new epoch, zeroes the effective deposit and keeps the gain claimable", async function () {
      const s = await loadFixture(productionSystem);
      const pool = await poolAsVault(s);
      const paxg = await s.paxg.getAddress();
      await pool.connect(s.alice).deposit(POOL_DEPOSIT);

      // Take the pool through a scale change first, so the scale and the product both sit
      // away from their starting values when the epoch resets: 1e13 left of 1e21 brings the
      // product to 1e10, and 1e11 left of that changes scale and leaves it at 1e17.
      await absorbPrefunded(pool, s.paxg, s.deployer, POOL_DEPOSIT - 10n ** 13n, 0n);
      await absorbPrefunded(pool, s.paxg, s.deployer, 10n ** 13n - 10n ** 11n, 0n);
      expect(await pool.currentEpoch()).to.equal(0n);
      expect(await pool.currentScale()).to.equal(1n);
      expect(await pool.P()).to.equal(10n ** 17n);
      expect(await pool.getEffectiveDeposit(s.alice.address)).to.equal(10n ** 11n);

      // Leaving one wei of 1e11 gives a product factor of 1e7, below SCALE_FACTOR.
      await expect(absorbPrefunded(pool, s.paxg, s.deployer, 10n ** 11n - 1n, ONE))
        .to.emit(pool, "EpochReset")
        .withArgs(1n);

      expect(await pool.currentEpoch()).to.equal(1n);
      expect(await pool.currentScale()).to.equal(0n);
      expect(await pool.P()).to.equal(PRECISION);
      expect(await pool.totalDeposits()).to.equal(1n);

      // The snapshot epoch is behind the pool epoch: the deposit is gone.
      expect(await pool.getEffectiveDeposit(s.alice.address)).to.equal(0n);
      // The gain from the old epoch bucket is still owed in full.
      expect(await pool.getCollateralGain(s.alice.address, paxg)).to.equal(ONE);

      const before = await s.paxg.balanceOf(s.alice.address);
      await expect(pool.connect(s.alice).claimCollateral(paxg))
        .to.emit(pool, "CollateralClaimed")
        .withArgs(s.alice.address, paxg, ONE);
      expect(await s.paxg.balanceOf(s.alice.address)).to.equal(before + ONE);
      expect(await pool.deposits(s.alice.address)).to.equal(0n);

      // A fresh deposit anchors to the new epoch and is whole again.
      await pool.connect(s.alice).deposit(ONE);
      expect(await pool.getEffectiveDeposit(s.alice.address)).to.equal(ONE);
      const snapshot = await pool.snapshots(s.alice.address);
      expect(snapshot.epoch).to.equal(1n);
    });
  });

  describe("scale changes", function () {
    it("one scale change divides the effective deposit by the scale factor and two scale changes zero it", async function () {
      const s = await loadFixture(productionSystem);
      const pool = await poolAsVault(s);
      const paxg = await s.paxg.getAddress();
      await pool.connect(s.alice).deposit(POOL_DEPOSIT);

      // First absorption leaves 1e15 of 1e21: P falls to 1e12 with no scale change.
      await absorbPrefunded(pool, s.paxg, s.deployer, POOL_DEPOSIT - 10n ** 15n, ONE);
      expect(await pool.P()).to.equal(10n ** 12n);
      expect(await pool.currentScale()).to.equal(0n);
      expect(await pool.getEffectiveDeposit(s.alice.address)).to.equal(10n ** 15n);

      // Second leaves 1e9 of 1e15: the raw new P would be 1e6, so it is scaled to 1e15 and the scale bumps.
      await absorbPrefunded(pool, s.paxg, s.deployer, 10n ** 15n - 10n ** 9n, ONE);
      expect(await pool.P()).to.equal(10n ** 15n);
      expect(await pool.currentScale()).to.equal(1n);
      expect(await pool.currentEpoch()).to.equal(0n);
      expect(await pool.getEffectiveDeposit(s.alice.address)).to.equal(10n ** 9n);
      expect(await pool.getEffectiveDeposit(s.alice.address)).to.equal(
        (POOL_DEPOSIT * 10n ** 15n) / PRECISION / SCALE_FACTOR
      );

      // Third leaves 999 of 1e9: the scale bumps again and the deposit sits two scales behind.
      await absorbPrefunded(pool, s.paxg, s.deployer, 10n ** 9n - 999n, ONE);
      expect(await pool.currentScale()).to.equal(2n);
      expect(await pool.currentEpoch()).to.equal(0n);
      expect(await pool.getEffectiveDeposit(s.alice.address)).to.equal(0n);

      // Gains span the first scale boundary only, so the first two absorptions plus the third
      // (booked under scale 1 and read through the second portion) all count: three PAXG.
      expect(await pool.getCollateralGain(s.alice.address, paxg)).to.equal(ONE * 3n);
      const before = await s.paxg.balanceOf(s.alice.address);
      await pool.connect(s.alice).claimCollateral(paxg);
      expect(await s.paxg.balanceOf(s.alice.address)).to.equal(before + ONE * 3n);
    });
  });

  describe("view guards", function () {
    it("getEffectiveDeposit and getCollateralGain return zero for an address with no deposit", async function () {
      const s = await loadFixture(productionSystem);
      expect(await s.stabilityPool.getEffectiveDeposit(s.charlie.address)).to.equal(0n);
      expect(
        await s.stabilityPool.getCollateralGain(s.charlie.address, await s.paxg.getAddress())
      ).to.equal(0n);
    });
  });

  describe("transferGovernance", function () {
    it("reverts for a caller without DEFAULT_ADMIN_ROLE", async function () {
      const s = await loadFixture(productionSystem);
      await expect(
        s.stabilityPool.connect(s.alice).transferGovernance(s.timelockAddr)
      ).to.be.revertedWithCustomError(s.stabilityPool, "AccessControlUnauthorizedAccount");
    });

    it("reverts on the zero address", async function () {
      const s = await loadFixture(productionSystem);
      await expect(s.stabilityPool.transferGovernance(ethers.ZeroAddress)).to.be.revertedWith("Zero address");
    });

    it("reverts when the admin would hand over to itself", async function () {
      const s = await loadFixture(productionSystem);
      await expect(s.stabilityPool.transferGovernance(s.deployer.address)).to.be.revertedWith("Would self-revoke");
    });

    it("reverts when the destination is not a contract", async function () {
      const s = await loadFixture(productionSystem);
      await expect(
        s.stabilityPool.transferGovernance(s.alice.address)
      ).to.be.revertedWith("Timelock must be a contract");
    });

    it("hands both roles to the timelock and strips the deployer", async function () {
      const s = await loadFixture(productionSystem);
      const pool = s.stabilityPool;
      const ADMIN = await pool.DEFAULT_ADMIN_ROLE();
      const GOV = await pool.GOVERNANCE_ROLE();
      await pool.transferGovernance(s.timelockAddr);
      expect(await pool.hasRole(ADMIN, s.timelockAddr)).to.equal(true);
      expect(await pool.hasRole(GOV, s.timelockAddr)).to.equal(true);
      expect(await pool.hasRole(ADMIN, s.deployer.address)).to.equal(false);
      expect(await pool.hasRole(GOV, s.deployer.address)).to.equal(false);
    });
  });
});

describe("SurplusBuffer branch coverage", function () {
  describe("VAULT_ROLE gates", function () {
    it("depositFee reverts for a caller without VAULT_ROLE", async function () {
      const s = await loadFixture(productionSystem);
      await expect(
        s.surplusBuffer.connect(s.alice).depositFee(ONE)
      ).to.be.revertedWithCustomError(s.surplusBuffer, "AccessControlUnauthorizedAccount");
    });

    it("depositCollateral reverts for a caller without VAULT_ROLE", async function () {
      const s = await loadFixture(productionSystem);
      await expect(
        s.surplusBuffer.connect(s.alice).depositCollateral(await s.paxg.getAddress(), ONE)
      ).to.be.revertedWithCustomError(s.surplusBuffer, "AccessControlUnauthorizedAccount");
    });

    it("absorbBadDebt reverts for a caller without VAULT_ROLE", async function () {
      const s = await loadFixture(productionSystem);
      await expect(
        s.surplusBuffer.connect(s.alice).absorbBadDebt(ONE)
      ).to.be.revertedWithCustomError(s.surplusBuffer, "AccessControlUnauthorizedAccount");
    });
  });

  describe("absorbBadDebt", function () {
    it("is a no-op at zero and caps at the GSUSD balance", async function () {
      const s = await loadFixture(productionSystem);
      const buffer = await bufferAsVault(s);
      const fee = ethers.parseEther("1000");
      await buffer.depositFee(fee);

      await expect(buffer.absorbBadDebt(0)).to.not.emit(buffer, "BadDebtAbsorbed");
      expect(await buffer.gsusdBalance()).to.equal(fee);

      await expect(buffer.absorbBadDebt(fee * 5n)).to.emit(buffer, "BadDebtAbsorbed").withArgs(fee);
      expect(await buffer.gsusdBalance()).to.equal(0n);
      expect(await buffer.totalBadDebtAbsorbed()).to.equal(fee);
    });
  });

  describe("withdrawGsusd", function () {
    it("reverts for a caller without GOVERNANCE_ROLE", async function () {
      const s = await loadFixture(productionSystem);
      await expect(
        s.surplusBuffer.connect(s.alice).withdrawGsusd(s.alice.address, 1n)
      ).to.be.revertedWithCustomError(s.surplusBuffer, "AccessControlUnauthorizedAccount");
    });

    it("reverts on a zero recipient", async function () {
      const s = await loadFixture(productionSystem);
      await expect(s.surplusBuffer.withdrawGsusd(ethers.ZeroAddress, 1n)).to.be.revertedWith("Zero address");
    });

    it("reverts when the amount exceeds the balance", async function () {
      const s = await loadFixture(productionSystem);
      await expect(s.surplusBuffer.withdrawGsusd(s.alice.address, 1n)).to.be.revertedWith("Exceeds balance");
    });

    it("reverts when the withdrawal would breach the minimum GSUSD reserve", async function () {
      const s = await loadFixture(productionSystem);
      const buffer = await bufferAsVault(s);
      await buffer.depositFee(ethers.parseEther("1000"));
      await buffer.setMinGsusdReserve(ethers.parseEther("800"));
      await expect(
        buffer.withdrawGsusd(s.alice.address, ethers.parseEther("300"))
      ).to.be.revertedWith("Would breach min GSUSD reserve");
    });

    it("pays out when the balance stays at or above a governed minimum above the automatic floor", async function () {
      const s = await loadFixture(productionSystem);
      const buffer = await bufferAsVault(s);
      const auto = await buffer.autoMinGsusdReserve();
      const governed = auto + ethers.parseEther("800");
      await buffer.depositFee(auto + ethers.parseEther("1000"));
      await buffer.setMinGsusdReserve(governed);
      expect(await buffer.effectiveMinGsusdReserve()).to.equal(governed);
      const before = await s.stablecoin.balanceOf(s.alice.address);
      await expect(buffer.withdrawGsusd(s.alice.address, ethers.parseEther("200")))
        .to.emit(buffer, "GsusdWithdrawn")
        .withArgs(s.alice.address, ethers.parseEther("200"));
      expect(await s.stablecoin.balanceOf(s.alice.address)).to.equal(before + ethers.parseEther("200"));
      expect(await buffer.gsusdBalance()).to.equal(governed);
    });

    it("pays out down to exactly the automatic floor, and not one wei further", async function () {
      const s = await loadFixture(productionSystem);
      const buffer = await bufferAsVault(s);
      const auto = await buffer.autoMinGsusdReserve();
      expect(auto).to.equal(((await s.stablecoin.totalSupply()) * 200n + 9_999n) / 10_000n);
      await buffer.depositFee(auto + ethers.parseEther("1000"));
      expect(await buffer.effectiveMinGsusdReserve()).to.equal(auto);
      await expect(
        buffer.withdrawGsusd(s.alice.address, ethers.parseEther("1000") + 1n)
      ).to.be.revertedWith("Would breach min GSUSD reserve");
      await buffer.withdrawGsusd(s.alice.address, ethers.parseEther("1000"));
      expect(await buffer.gsusdBalance()).to.equal(auto);
    });
  });

  describe("withdrawCollateral", function () {
    it("reverts for a caller without GOVERNANCE_ROLE", async function () {
      const s = await loadFixture(productionSystem);
      await expect(
        s.surplusBuffer.connect(s.alice).withdrawCollateral(await s.paxg.getAddress(), s.alice.address, 1n)
      ).to.be.revertedWithCustomError(s.surplusBuffer, "AccessControlUnauthorizedAccount");
    });

    it("reverts on a zero recipient", async function () {
      const s = await loadFixture(productionSystem);
      await expect(
        s.surplusBuffer.withdrawCollateral(await s.paxg.getAddress(), ethers.ZeroAddress, 1n)
      ).to.be.revertedWith("Zero address");
    });

    it("reverts when the amount exceeds the collateral balance", async function () {
      const s = await loadFixture(productionSystem);
      await expect(
        s.surplusBuffer.withdrawCollateral(await s.paxg.getAddress(), s.alice.address, 1n)
      ).to.be.revertedWith("Exceeds balance");
    });

    it("reverts when the withdrawal would breach the minimum collateral reserve", async function () {
      const s = await loadFixture(productionSystem);
      const buffer = await bufferAsVault(s);
      const paxg = await s.paxg.getAddress();
      await buffer.depositCollateral(paxg, ONE * 10n);
      await buffer.setMinCollateralReserve(paxg, ONE * 8n);
      await expect(
        buffer.withdrawCollateral(paxg, s.alice.address, ONE * 3n)
      ).to.be.revertedWith("Would breach min collateral reserve");
    });

    it("pays out when the balance stays at or above the minimum collateral reserve", async function () {
      const s = await loadFixture(productionSystem);
      const buffer = await bufferAsVault(s);
      const paxg = await s.paxg.getAddress();
      await buffer.depositCollateral(paxg, ONE * 10n);
      await buffer.setMinCollateralReserve(paxg, ONE * 8n);
      const before = await s.paxg.balanceOf(s.alice.address);
      await expect(buffer.withdrawCollateral(paxg, s.alice.address, ONE * 2n))
        .to.emit(buffer, "CollateralWithdrawn")
        .withArgs(paxg, s.alice.address, ONE * 2n);
      expect(await s.paxg.balanceOf(s.alice.address)).to.equal(before + ONE * 2n);
      expect(await buffer.collateralBalance(paxg)).to.equal(ONE * 8n);
    });
  });

  describe("reserve setters", function () {
    it("setMinGsusdReserve reverts for a caller without GOVERNANCE_ROLE", async function () {
      const s = await loadFixture(productionSystem);
      await expect(
        s.surplusBuffer.connect(s.alice).setMinGsusdReserve(1n)
      ).to.be.revertedWithCustomError(s.surplusBuffer, "AccessControlUnauthorizedAccount");
    });

    it("setMinCollateralReserve reverts for a caller without GOVERNANCE_ROLE", async function () {
      const s = await loadFixture(productionSystem);
      await expect(
        s.surplusBuffer.connect(s.alice).setMinCollateralReserve(await s.paxg.getAddress(), 1n)
      ).to.be.revertedWithCustomError(s.surplusBuffer, "AccessControlUnauthorizedAccount");
    });

    it("setMinCollateralReserve reverts on the zero token", async function () {
      const s = await loadFixture(productionSystem);
      await expect(
        s.surplusBuffer.setMinCollateralReserve(ethers.ZeroAddress, 1n)
      ).to.be.revertedWith("Zero address");
    });
  });

  describe("transferGovernance", function () {
    it("reverts for a caller without DEFAULT_ADMIN_ROLE", async function () {
      const s = await loadFixture(productionSystem);
      await expect(
        s.surplusBuffer.connect(s.alice).transferGovernance(s.timelockAddr)
      ).to.be.revertedWithCustomError(s.surplusBuffer, "AccessControlUnauthorizedAccount");
    });

    it("reverts on the zero address", async function () {
      const s = await loadFixture(productionSystem);
      await expect(s.surplusBuffer.transferGovernance(ethers.ZeroAddress)).to.be.revertedWith("Zero address");
    });

    it("reverts when the admin would hand over to itself", async function () {
      const s = await loadFixture(productionSystem);
      await expect(
        s.surplusBuffer.transferGovernance(s.deployer.address)
      ).to.be.revertedWith("Would self-revoke");
    });

    it("reverts when the destination is not a contract", async function () {
      const s = await loadFixture(productionSystem);
      await expect(
        s.surplusBuffer.transferGovernance(s.alice.address)
      ).to.be.revertedWith("Timelock must be a contract");
    });

    it("hands both roles to the timelock and strips the deployer", async function () {
      const s = await loadFixture(productionSystem);
      const buffer = s.surplusBuffer;
      const ADMIN = await buffer.DEFAULT_ADMIN_ROLE();
      const GOV = await buffer.GOVERNANCE_ROLE();
      await buffer.transferGovernance(s.timelockAddr);
      expect(await buffer.hasRole(ADMIN, s.timelockAddr)).to.equal(true);
      expect(await buffer.hasRole(GOV, s.timelockAddr)).to.equal(true);
      expect(await buffer.hasRole(ADMIN, s.deployer.address)).to.equal(false);
      expect(await buffer.hasRole(GOV, s.deployer.address)).to.equal(false);
    });
  });
});
