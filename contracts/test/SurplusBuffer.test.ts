import { expect } from "chai";
import { ethers } from "hardhat";
import { SurplusBuffer, MockERC20, MockGsusd } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

describe("SurplusBuffer", function () {
  let surplusBuffer: SurplusBuffer;
  let gsusd: MockGsusd;
  let gold: MockERC20;
  let owner: HardhatEthersSigner;
  let vault: HardhatEthersSigner;
  let governance: HardhatEthersSigner;
  let other: HardhatEthersSigner;
  let recipient: HardhatEthersSigner;

  beforeEach(async function () {
    [owner, vault, governance, other, recipient] = await ethers.getSigners();

    const MockToken = await ethers.getContractFactory("MockERC20");
    gsusd = await (await ethers.getContractFactory("MockGsusd")).deploy();
    gold = await MockToken.deploy("Pax Gold", "PAXG", 18);

    const SurplusBufferFactory = await ethers.getContractFactory("SurplusBuffer");
    surplusBuffer = await SurplusBufferFactory.deploy(await gsusd.getAddress());

    // Grant VAULT_ROLE to vault signer
    const VAULT_ROLE = await surplusBuffer.VAULT_ROLE();
    await surplusBuffer.grantRole(VAULT_ROLE, vault.address);

    // Mint tokens to vault for deposit tests
    await gsusd.mint(vault.address, ethers.parseEther("10000"));
    await gold.mint(vault.address, ethers.parseEther("10000"));

    // Approve surplus buffer to pull tokens from vault
    const bufferAddr = await surplusBuffer.getAddress();
    await gsusd.connect(vault).approve(bufferAddr, ethers.MaxUint256);
    await gold.connect(vault).approve(bufferAddr, ethers.MaxUint256);
  });

  describe("Deployment", function () {
    it("should deploy with correct GSUSD address", async function () {
      expect(await surplusBuffer.gsusd()).to.equal(await gsusd.getAddress());
    });

    it("should reject zero GSUSD address in constructor", async function () {
      const SurplusBufferFactory = await ethers.getContractFactory("SurplusBuffer");
      await expect(
        SurplusBufferFactory.deploy(ethers.ZeroAddress)
      ).to.be.revertedWith("Zero address");
    });
  });

  describe("depositFee", function () {
    it("should allow VAULT_ROLE to deposit GSUSD and increase gsusdBalance", async function () {
      const amount = ethers.parseEther("500");
      await surplusBuffer.connect(vault).depositFee(amount);

      expect(await surplusBuffer.gsusdBalance()).to.equal(amount);
      expect(await gsusd.balanceOf(await surplusBuffer.getAddress())).to.equal(amount);
    });

    it("should reject caller without VAULT_ROLE", async function () {
      const amount = ethers.parseEther("500");
      await expect(
        surplusBuffer.connect(other).depositFee(amount)
      ).to.be.reverted;
    });
  });

  describe("depositCollateral", function () {
    it("should allow VAULT_ROLE to deposit gold tokens and increase collateralBalance", async function () {
      const amount = ethers.parseEther("100");
      const goldAddr = await gold.getAddress();
      await surplusBuffer.connect(vault).depositCollateral(goldAddr, amount);

      expect(await surplusBuffer.collateralBalance(goldAddr)).to.equal(amount);
      expect(await gold.balanceOf(await surplusBuffer.getAddress())).to.equal(amount);
    });

    it("should reject caller without VAULT_ROLE", async function () {
      const amount = ethers.parseEther("100");
      await expect(
        surplusBuffer.connect(other).depositCollateral(await gold.getAddress(), amount)
      ).to.be.reverted;
    });
  });

  describe("absorbBadDebt", function () {
    const depositAmount = ethers.parseEther("1000");

    beforeEach(async function () {
      // Seed the buffer with GSUSD
      await surplusBuffer.connect(vault).depositFee(depositAmount);
    });

    it("should reduce gsusdBalance by absorbed amount and burn the GSUSD, paying the caller nothing", async function () {
      const absorbAmount = ethers.parseEther("400");
      const vaultBalanceBefore = await gsusd.balanceOf(vault.address);
      const supplyBefore = await gsusd.totalSupply();

      await surplusBuffer.connect(vault).absorbBadDebt(absorbAmount);

      expect(await surplusBuffer.gsusdBalance()).to.equal(depositAmount - absorbAmount);
      expect(await surplusBuffer.totalBadDebtAbsorbed()).to.equal(absorbAmount);
      expect(await gsusd.balanceOf(vault.address)).to.equal(vaultBalanceBefore);
      expect(supplyBefore - (await gsusd.totalSupply())).to.equal(absorbAmount);
      expect(await gsusd.balanceOf(await surplusBuffer.getAddress())).to.equal(depositAmount - absorbAmount);
    });

    it("should cap absorption at available balance (partial absorption)", async function () {
      const excessAmount = ethers.parseEther("2000"); // more than deposited
      const vaultBalanceBefore = await gsusd.balanceOf(vault.address);

      await surplusBuffer.connect(vault).absorbBadDebt(excessAmount);

      // Should only absorb, and burn, what was available
      expect(await surplusBuffer.gsusdBalance()).to.equal(0n);
      expect(await surplusBuffer.totalBadDebtAbsorbed()).to.equal(depositAmount);
      expect(await gsusd.balanceOf(vault.address)).to.equal(vaultBalanceBefore);
      expect(await gsusd.balanceOf(await surplusBuffer.getAddress())).to.equal(0n);
    });

    it("should reject caller without VAULT_ROLE", async function () {
      await expect(
        surplusBuffer.connect(other).absorbBadDebt(ethers.parseEther("100"))
      ).to.be.reverted;
    });
  });

  describe("withdrawGsusd", function () {
    const depositAmount = ethers.parseEther("1000");

    beforeEach(async function () {
      await surplusBuffer.connect(vault).depositFee(depositAmount);
    });

    it("should allow governance to withdraw GSUSD", async function () {
      const withdrawAmount = ethers.parseEther("300");
      await surplusBuffer.connect(owner).withdrawGsusd(recipient.address, withdrawAmount);

      expect(await surplusBuffer.gsusdBalance()).to.equal(depositAmount - withdrawAmount);
      expect(await gsusd.balanceOf(recipient.address)).to.equal(withdrawAmount);
    });

    it("should reject if amount exceeds balance", async function () {
      const excessAmount = ethers.parseEther("2000");
      await expect(
        surplusBuffer.connect(owner).withdrawGsusd(recipient.address, excessAmount)
      ).to.be.revertedWith("Exceeds balance");
    });

    it("should reject zero recipient address", async function () {
      await expect(
        surplusBuffer.connect(owner).withdrawGsusd(ethers.ZeroAddress, ethers.parseEther("100"))
      ).to.be.revertedWith("Zero address");
    });

    it("refuses itself as the recipient and leaves the tokens, the ledger and the counter as they were", async function () {
      const self = await surplusBuffer.getAddress();
      const [counted, held, withdrawn] = [await surplusBuffer.gsusdBalance(), await gsusd.balanceOf(self), await surplusBuffer.totalGsusdWithdrawn()];

      await expect(surplusBuffer.connect(owner).withdrawGsusd(self, ethers.parseEther("100"))).to.be.revertedWith("Self payment");
      await expect(surplusBuffer.connect(owner).withdrawGsusd(self, 0n)).to.be.revertedWith("Self payment");
      expect(await surplusBuffer.gsusdBalance()).to.equal(counted);
      expect(await gsusd.balanceOf(self)).to.equal(held);
      expect(await surplusBuffer.totalGsusdWithdrawn()).to.equal(withdrawn);
    });

    it("a payment to another address moves exactly what the ledger debits", async function () {
      const self = await surplusBuffer.getAddress();
      const amount = ethers.parseEther("100");
      const [counted, held, received] = [await surplusBuffer.gsusdBalance(), await gsusd.balanceOf(self), await gsusd.balanceOf(recipient.address)];

      await surplusBuffer.connect(owner).withdrawGsusd(recipient.address, amount);
      expect(counted - (await surplusBuffer.gsusdBalance())).to.equal(amount);
      expect(held - (await gsusd.balanceOf(self))).to.equal(amount);
      expect((await gsusd.balanceOf(recipient.address)) - received).to.equal(amount);
    });
  });

  describe("withdrawCollateral", function () {
    const depositAmount = ethers.parseEther("500");

    it("refuses itself as the recipient and leaves the tokens and the ledger as they were", async function () {
      const self = await surplusBuffer.getAddress();
      const goldAddr = await gold.getAddress();
      await surplusBuffer.connect(vault).depositCollateral(goldAddr, ethers.parseEther("5"));
      const [counted, held] = [await surplusBuffer.collateralBalance(goldAddr), await gold.balanceOf(self)];

      await expect(surplusBuffer.connect(owner).withdrawCollateral(goldAddr, self, ethers.parseEther("1"))).to.be.revertedWith("Self payment");
      expect(await surplusBuffer.collateralBalance(goldAddr)).to.equal(counted);
      expect(await gold.balanceOf(self)).to.equal(held);
    });

    beforeEach(async function () {
      await surplusBuffer.connect(vault).depositCollateral(await gold.getAddress(), depositAmount);
    });

    it("should allow governance to withdraw gold tokens", async function () {
      const withdrawAmount = ethers.parseEther("200");
      const goldAddr = await gold.getAddress();
      await surplusBuffer.connect(owner).withdrawCollateral(goldAddr, recipient.address, withdrawAmount);

      expect(await surplusBuffer.collateralBalance(goldAddr)).to.equal(depositAmount - withdrawAmount);
      expect(await gold.balanceOf(recipient.address)).to.equal(withdrawAmount);
    });

    it("should reject if amount exceeds collateral balance", async function () {
      const excessAmount = ethers.parseEther("1000");
      await expect(
        surplusBuffer.connect(owner).withdrawCollateral(await gold.getAddress(), recipient.address, excessAmount)
      ).to.be.revertedWith("Exceeds balance");
    });
  });

  describe("transferGovernance", function () {
    it("should transfer governance and admin roles to new address and revoke from deployer", async function () {
      const GOVERNANCE_ROLE = await surplusBuffer.GOVERNANCE_ROLE();
      const DEFAULT_ADMIN_ROLE = await surplusBuffer.DEFAULT_ADMIN_ROLE();

      // Owner currently has both roles
      expect(await surplusBuffer.hasRole(GOVERNANCE_ROLE, owner.address)).to.be.true;
      expect(await surplusBuffer.hasRole(DEFAULT_ADMIN_ROLE, owner.address)).to.be.true;

      const dest = await gsusd.getAddress();
      await expect(surplusBuffer.connect(owner).transferGovernance(governance.address)).to.be.revertedWith(
        "Timelock must be a contract"
      );
      await surplusBuffer.connect(owner).transferGovernance(dest);

      // New address should have both roles
      expect(await surplusBuffer.hasRole(GOVERNANCE_ROLE, dest)).to.be.true;
      expect(await surplusBuffer.hasRole(DEFAULT_ADMIN_ROLE, dest)).to.be.true;

      // Old owner should have neither role
      expect(await surplusBuffer.hasRole(GOVERNANCE_ROLE, owner.address)).to.be.false;
      expect(await surplusBuffer.hasRole(DEFAULT_ADMIN_ROLE, owner.address)).to.be.false;
    });
  });
});
