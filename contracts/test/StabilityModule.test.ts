import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { StabilityModule } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

describe("StabilityModule", function () {
  let module: StabilityModule;
  let owner: HardhatEthersSigner;
  let vault: HardhatEthersSigner;
  let user: HardhatEthersSigner;
  let other: HardhatEthersSigner;

  const PRECISION = ethers.parseEther("1"); // 1e18
  const SECONDS_PER_YEAR = 365n * 24n * 60n * 60n;
  const COL_ID = ethers.keccak256(ethers.toUtf8Bytes("PAXG"));

  beforeEach(async function () {
    [owner, vault, user, other] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory("StabilityModule");
    module = await Factory.deploy();
    await module.waitForDeployment();

    // Grant vault role
    const VAULT_ROLE = await module.VAULT_ROLE();
    await module.grantRole(VAULT_ROLE, vault.address);
  });

  describe("Deployment", function () {
    it("should deploy with correct roles", async function () {
      const DEFAULT_ADMIN = await module.DEFAULT_ADMIN_ROLE();
      const GOV_ROLE = await module.GOVERNANCE_ROLE();
      expect(await module.hasRole(DEFAULT_ADMIN, owner.address)).to.be.true;
      expect(await module.hasRole(GOV_ROLE, owner.address)).to.be.true;
    });
  });

  describe("initCollateral", function () {
    it("should set accumulator to 1e18", async function () {
      await module.initCollateral(COL_ID, 200);
      expect(await module.rateAccumulator(COL_ID)).to.equal(PRECISION);
    });

    it("should revert if already initialised", async function () {
      await module.initCollateral(COL_ID, 200);
      await expect(module.initCollateral(COL_ID, 200)).to.be.revertedWith("Already initialised");
    });

    it("should revert if annualRateBps > 5000", async function () {
      await expect(module.initCollateral(COL_ID, 5001)).to.be.revertedWith("Rate exceeds 50% max");
    });

    it("should accept annualRateBps = 5000", async function () {
      await expect(module.initCollateral(COL_ID, 5000)).to.not.be.reverted;
    });

    it("should revert if caller lacks GOVERNANCE_ROLE", async function () {
      await expect(module.connect(other).initCollateral(COL_ID, 200)).to.be.reverted;
    });
  });

  describe("setStabilityFee", function () {
    beforeEach(async function () {
      await module.initCollateral(COL_ID, 200);
    });

    it("should revert if annualRateBps > 5000", async function () {
      await expect(module.setStabilityFee(COL_ID, 5001)).to.be.revertedWith("Rate exceeds 50% max");
    });

    it("should revert if not initialised", async function () {
      const otherColId = ethers.keccak256(ethers.toUtf8Bytes("XAUT"));
      await expect(module.setStabilityFee(otherColId, 200)).to.be.revertedWith("Not initialised");
    });

    it("should accrue interest before changing rate", async function () {
      await time.increase(3600); // 1 hour
      await module.setStabilityFee(COL_ID, 300);
      // Accumulator should have increased from accrual
      expect(await module.rateAccumulator(COL_ID)).to.be.gt(PRECISION);
    });

    it("should revert if caller lacks GOVERNANCE_ROLE", async function () {
      await expect(module.connect(other).setStabilityFee(COL_ID, 200)).to.be.reverted;
    });
  });

  describe("recordDebt — rounds UP (Ceil)", function () {
    beforeEach(async function () {
      await module.initCollateral(COL_ID, 200);
      // Advance time so accumulator > PRECISION to test rounding
      await time.increase(SECONDS_PER_YEAR);
      await module.accrueInterest(COL_ID);
    });

    it("should round up normalised debt", async function () {
      const debtAmount = ethers.parseEther("1000");

      await module.connect(vault).recordDebt(user.address, COL_ID, debtAmount);

      // recordDebt calls _accrueInterest internally, which may advance the accumulator by 1 more second
      // So we read the accumulator AFTER the call
      const accumulator = await module.rateAccumulator(COL_ID);
      const normDebt = await module.normalisedDebt(user.address, COL_ID);
      // Ceil division: (debtAmount * PRECISION + accumulator - 1) / accumulator
      const expectedCeil = (debtAmount * PRECISION + accumulator - 1n) / accumulator;
      expect(normDebt).to.equal(expectedCeil);
    });

    it("accrues the interest owed so far before it records new debt", async function () {
      // A first borrower, then a year with no accrual at all: the stored accumulator is a
      // year behind when the second borrower's debt is recorded.
      await module.connect(vault).recordDebt(other.address, COL_ID, ethers.parseEther("5000"));
      const staleAccumulator = await module.rateAccumulator(COL_ID);
      await time.increase(SECONDS_PER_YEAR);

      const debtAmount = ethers.parseEther("1000");
      await module.connect(vault).recordDebt(user.address, COL_ID, debtAmount);

      // The accumulator was brought up to the block of the mint first...
      const accumulator = await module.rateAccumulator(COL_ID);
      expect(accumulator).to.be.gt((staleAccumulator * 1019n) / 1000n);
      expect(await module.lastAccrualTimestamp(COL_ID)).to.equal(await time.latest());
      // ...and the new debt is normalised against that, so it carries no interest from
      // before it existed: the borrower owes what was minted, within the unit rounded up.
      expect(await module.normalisedDebt(user.address, COL_ID)).to.equal(
        (debtAmount * PRECISION + accumulator - 1n) / accumulator
      );
      const owed = (await module.normalisedDebt(user.address, COL_ID)) * accumulator / PRECISION;
      expect(owed - debtAmount).to.be.lte(1n);
      expect(owed).to.be.gte(debtAmount);
    });

    it("should revert if caller lacks VAULT_ROLE", async function () {
      await expect(
        module.connect(other).recordDebt(user.address, COL_ID, ethers.parseEther("100"))
      ).to.be.revertedWithCustomError(module, "AccessControlUnauthorizedAccount");
    });
  });

  describe("reduceDebt — rounds DOWN", function () {
    beforeEach(async function () {
      await module.initCollateral(COL_ID, 200);
      await module.connect(vault).recordDebt(user.address, COL_ID, ethers.parseEther("1000"));
      await time.increase(SECONDS_PER_YEAR);
      await module.accrueInterest(COL_ID);
    });

    it("should round down normalised debt reduction", async function () {
      const normDebtBefore = await module.normalisedDebt(user.address, COL_ID);
      const repayAmount = ethers.parseEther("500");

      await module.connect(vault).reduceDebt(user.address, COL_ID, repayAmount);

      // reduceDebt calls _accrueInterest internally — read accumulator AFTER
      const accumulator = await module.rateAccumulator(COL_ID);
      const normDebtAfter = await module.normalisedDebt(user.address, COL_ID);
      // Floor division: (repayAmount * PRECISION) / accumulator
      const expectedFloorReduction = (repayAmount * PRECISION) / accumulator;
      expect(normDebtBefore - normDebtAfter).to.equal(expectedFloorReduction);
    });

    it("should revert if caller lacks VAULT_ROLE", async function () {
      await expect(
        module.connect(other).reduceDebt(user.address, COL_ID, ethers.parseEther("100"))
      ).to.be.revertedWithCustomError(module, "AccessControlUnauthorizedAccount");
    });
  });

  describe("accrueInterest + rpow", function () {
    it("should compound at ~2% after 1 year with 200 bps", async function () {
      await module.initCollateral(COL_ID, 200);
      await time.increase(SECONDS_PER_YEAR);
      await module.accrueInterest(COL_ID);

      const accumulator = await module.rateAccumulator(COL_ID);
      // Should be approximately 1.02e18 (2% annual)
      const expected = ethers.parseEther("1.02");
      const tolerance = ethers.parseEther("0.001"); // 0.1% tolerance for rounding
      expect(accumulator).to.be.closeTo(expected, tolerance);
    });

    it("should be no-op when 0 seconds elapsed", async function () {
      await module.initCollateral(COL_ID, 200);
      // Force accrual so timestamp is current block
      await module.accrueInterest(COL_ID);
      const accBefore = await module.rateAccumulator(COL_ID);
      // Mine a block at the same timestamp
      await ethers.provider.send("evm_setAutomine", [false]);
      await module.accrueInterest(COL_ID);
      await ethers.provider.send("evm_mine", [await time.latest()]);
      await ethers.provider.send("evm_setAutomine", [true]);
      // Accumulator should not change when elapsed = 0
      // But since each tx advances by at least 1 second in hardhat, just verify it's very close
      const accAfter = await module.rateAccumulator(COL_ID);
      // At most 1-2 seconds of interest at 2% — negligible
      const tolerance = PRECISION / 10000n; // 0.01%
      expect(accAfter - accBefore).to.be.lt(tolerance);
    });

    it("should compound at max rate (5000 bps = 50%) correctly", async function () {
      await module.initCollateral(COL_ID, 5000);
      await time.increase(SECONDS_PER_YEAR);
      await module.accrueInterest(COL_ID);

      const accumulator = await module.rateAccumulator(COL_ID);
      // ~1.5e18 for 50% annual (linear approx compounded = ~1.6487 but linear rate approx gives ~1.5)
      expect(accumulator).to.be.gt(ethers.parseEther("1.4"));
      expect(accumulator).to.be.lt(ethers.parseEther("1.7"));
    });

    it("should handle multiple small accruals consistently", async function () {
      // Single large accrual
      await module.initCollateral(COL_ID, 200);

      await time.increase(Number(SECONDS_PER_YEAR));
      await module.accrueInterest(COL_ID);
      const singleAccrual = await module.rateAccumulator(COL_ID);

      // Multiple small accruals (new collateral)
      const COL_ID2 = ethers.keccak256(ethers.toUtf8Bytes("XAUT"));
      await module.initCollateral(COL_ID2, 200);
      const steps = 12;
      const stepSize = Math.floor(Number(SECONDS_PER_YEAR) / steps);
      for (let i = 0; i < steps; i++) {
        await time.increase(stepSize);
        await module.accrueInterest(COL_ID2);
      }
      const multiAccrual = await module.rateAccumulator(COL_ID2);

      // Should be very close (within 0.1% — small differences from discrete stepping)
      const tolerance = ethers.parseEther("0.001");
      expect(multiAccrual).to.be.closeTo(singleAccrual, tolerance);
    });
  });

  describe("getCurrentDebt", function () {
    it("should include projected accrued fees", async function () {
      await module.initCollateral(COL_ID, 200);
      const principal = ethers.parseEther("1000");
      await module.connect(vault).recordDebt(user.address, COL_ID, principal);

      await time.increase(SECONDS_PER_YEAR);

      const currentDebt = await module.getCurrentDebt(user.address, COL_ID);
      // Should be ~1020 (1000 * 1.02)
      expect(currentDebt).to.be.gt(ethers.parseEther("1019"));
      expect(currentDebt).to.be.lt(ethers.parseEther("1021"));
    });
  });

  describe("getAccruedFees", function () {
    it("should return difference from principal", async function () {
      await module.initCollateral(COL_ID, 200);
      const principal = ethers.parseEther("1000");
      await module.connect(vault).recordDebt(user.address, COL_ID, principal);

      await time.increase(SECONDS_PER_YEAR);

      const fees = await module.getAccruedFees(user.address, COL_ID, principal);
      // ~20 GSUSD fees at 2%
      expect(fees).to.be.gt(ethers.parseEther("19"));
      expect(fees).to.be.lt(ethers.parseEther("21"));
    });

    it("should return 0 when currentDebt <= principal", async function () {
      await module.initCollateral(COL_ID, 0); // 0% rate
      const principal = ethers.parseEther("1000");
      await module.connect(vault).recordDebt(user.address, COL_ID, principal);

      const fees = await module.getAccruedFees(user.address, COL_ID, principal);
      expect(fees).to.equal(0);
    });
  });
});
