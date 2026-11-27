import { expect } from "chai";
import { ethers } from "hardhat";
import { SiloFactory, MockERC20 } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

describe("CollateralSilo & SiloFactory", function () {
  let factory: SiloFactory;
  let token: MockERC20;
  let vaultRole: HardhatEthersSigner;
  let other: HardhatEthersSigner;

  const SILO_CAP = ethers.parseEther("100"); // 100 tokens per silo
  const MAX_SILO_CAP = ethers.parseEther("1000");

  beforeEach(async function () {
    [, vaultRole, other] = await ethers.getSigners();

    const MockToken = await ethers.getContractFactory("MockERC20");
    token = await MockToken.deploy("Pax Gold", "PAXG", 18);

    const SiloF = await ethers.getContractFactory("SiloFactory");
    factory = await SiloF.deploy(SILO_CAP);

    const VAULT_ROLE = await factory.VAULT_ROLE();
    await factory.grantRole(VAULT_ROLE, vaultRole.address);

    // Mint tokens to vaultRole for deposit tests
    await token.mint(vaultRole.address, ethers.parseEther("1000"));
    await token.connect(vaultRole).approve(await factory.getAddress(), ethers.MaxUint256);
  });

  describe("Custody lock (VAULT_ROLE is permanent once locked)", function () {
    it("documents the hole the lock closes: before locking, the admin can drain every silo", async function () {
      const [admin] = await ethers.getSigners();
      await factory.connect(vaultRole).deposit(await token.getAddress(), ethers.parseEther("100"));
      await factory.grantRole(await factory.VAULT_ROLE(), admin.address);
      await factory.withdraw(await token.getAddress(), other.address, ethers.parseEther("100"));
      expect(await token.balanceOf(other.address)).to.equal(ethers.parseEther("100"));
    });

    it("after locking, nobody (admin included) can grant or revoke VAULT_ROLE", async function () {
      const [admin] = await ethers.getSigners();
      const VAULT_ROLE = await factory.VAULT_ROLE();
      await factory.lockVaultRole(vaultRole.address);
      expect(await factory.vaultRoleLocked()).to.be.true;
      expect(await factory.getRoleAdmin(VAULT_ROLE)).to.equal(await factory.LOCKED_ROLE());
      await expect(factory.grantRole(VAULT_ROLE, admin.address)).to.be.revertedWithCustomError(
        factory,
        "AccessControlUnauthorizedAccount"
      );
      await expect(factory.revokeRole(VAULT_ROLE, vaultRole.address)).to.be.revertedWithCustomError(
        factory,
        "AccessControlUnauthorizedAccount"
      );
      await expect(factory.grantRole(await factory.LOCKED_ROLE(), admin.address)).to.be.revertedWithCustomError(
        factory,
        "AccessControlUnauthorizedAccount"
      );
      // The vault keeps working as before.
      await factory.connect(vaultRole).deposit(await token.getAddress(), ethers.parseEther("10"));
      await factory.connect(vaultRole).withdraw(await token.getAddress(), other.address, ethers.parseEther("10"));
      expect(await token.balanceOf(other.address)).to.equal(ethers.parseEther("10"));
    });

    it("refuses to lock unless the vault already holds the role, and only locks once", async function () {
      await expect(factory.lockVaultRole(other.address)).to.be.revertedWith("Vault lacks VAULT_ROLE");
      await factory.lockVaultRole(vaultRole.address);
      await expect(factory.lockVaultRole(vaultRole.address)).to.be.revertedWith("Already locked");
      await expect(factory.connect(other).lockVaultRole(vaultRole.address)).to.be.revertedWithCustomError(
        factory,
        "AccessControlUnauthorizedAccount"
      );
    });

    it("refuses to lock while a second VAULT_ROLE holder exists", async function () {
      await factory.grantRole(await factory.VAULT_ROLE(), other.address);
      await expect(factory.lockVaultRole(vaultRole.address)).to.be.revertedWith(
        "VAULT_ROLE must have a sole holder"
      );
      await factory.revokeRole(await factory.VAULT_ROLE(), other.address);
      await factory.lockVaultRole(vaultRole.address);
      expect(await factory.vaultRoleLocked()).to.be.true;
    });

    // A LOCKED_ROLE grant made before the lock became the
    // permanent, self-administered admin of VAULT_ROLE once the lock installed it.
    it("refuses a LOCKED_ROLE grant before the lock, and the lock still works", async function () {
      const LOCKED_ROLE = await factory.LOCKED_ROLE();
      expect(await factory.getRoleAdmin(LOCKED_ROLE)).to.equal(LOCKED_ROLE);
      await expect(factory.grantRole(LOCKED_ROLE, other.address)).to.be.revertedWithCustomError(
        factory,
        "AccessControlUnauthorizedAccount"
      );
      await factory.lockVaultRole(vaultRole.address);
      expect(await factory.vaultRoleLocked()).to.be.true;
      expect(await factory.getRoleMemberCount(LOCKED_ROLE)).to.equal(0n);
      expect(await factory.getRoleMemberCount(await factory.VAULT_ROLE())).to.equal(1n);
      expect(await factory.getRoleMember(await factory.VAULT_ROLE(), 0)).to.equal(vaultRole.address);
    });

    it("bounds every cursor advance so an overshoot stays recoverable in steps", async function () {
      const addr = await token.getAddress();
      await expect(factory.setCurrentSiloIndex(addr, 65n)).to.be.revertedWith("Advance exceeds bound");
      await factory.setCurrentSiloIndex(addr, 64n);
      await factory.setCurrentSiloIndex(addr, 128n);
      expect(await factory.currentSiloIndex(addr)).to.equal(128n);
    });

    it("isEmpty tracks whether any silo holds collateral", async function () {
      expect(await factory.isEmpty()).to.be.true;
      await factory.connect(vaultRole).deposit(await token.getAddress(), ethers.parseEther("1"));
      expect(await factory.isEmpty()).to.be.false;
      expect(await factory.tokensHeld()).to.equal(1n);
      await factory.connect(vaultRole).withdraw(await token.getAddress(), other.address, ethers.parseEther("1"));
      expect(await factory.isEmpty()).to.be.true;
    });
  });

  describe("Implementation Lock", function () {
    it("should lock the implementation contract", async function () {
      const implAddr = await factory.siloImplementation();
      const impl = await ethers.getContractAt("CollateralSilo", implAddr);
      expect(await impl.initialised()).to.be.true;
      expect(await impl.factory()).to.not.equal(ethers.ZeroAddress);
    });
  });

  describe("Deployment", function () {
    it("should deploy with correct cap", async function () {
      expect(await factory.siloCap()).to.equal(SILO_CAP);
    });

    it("should revert with zero cap", async function () {
      const SiloF = await ethers.getContractFactory("SiloFactory");
      await expect(SiloF.deploy(0)).to.be.revertedWith("Invalid cap");
    });

    it("should revert with cap > MAX_SILO_CAP", async function () {
      const SiloF = await ethers.getContractFactory("SiloFactory");
      await expect(SiloF.deploy(MAX_SILO_CAP + 1n)).to.be.revertedWith("Invalid cap");
    });
  });

  describe("Deposit", function () {
    it("should create silo and route tokens", async function () {
      // Transfer tokens to factory first (as vault would)
      await token.connect(vaultRole).transfer(await factory.getAddress(), ethers.parseEther("50"));
      await factory.connect(vaultRole).deposit(await token.getAddress(), ethers.parseEther("50"));

      expect(await factory.getSiloCount(await token.getAddress())).to.equal(1);
      expect(await factory.totalCollateral(await token.getAddress())).to.equal(ethers.parseEther("50"));
    });

    it("should create new silo when current is full", async function () {
      // Deposit more than cap
      await token.connect(vaultRole).transfer(await factory.getAddress(), ethers.parseEther("150"));
      await factory.connect(vaultRole).deposit(await token.getAddress(), ethers.parseEther("150"));

      expect(await factory.getSiloCount(await token.getAddress())).to.equal(2);
    });

    it("should only allow VAULT_ROLE", async function () {
      await expect(
        factory.connect(other).deposit(await token.getAddress(), ethers.parseEther("10"))
      ).to.be.reverted;
    });

    it("credits actual amount received for fee-on-transfer tokens (regression)", async function () {
      // Deploy a 1% fee-on-transfer token
      const FeeToken = await ethers.getContractFactory("MockERC20FeeOnTransfer");
      const feeToken = await FeeToken.deploy("Fee Gold", "FEE", 100); // 100 bps = 1%
      await feeToken.mint(vaultRole.address, ethers.parseEther("1000"));
      await feeToken.connect(vaultRole).approve(await factory.getAddress(), ethers.MaxUint256);

      const depositAmount = ethers.parseEther("50");
      const credited = await factory.connect(vaultRole).deposit.staticCall(
        await feeToken.getAddress(),
        depositAmount
      );
      await factory.connect(vaultRole).deposit(await feeToken.getAddress(), depositAmount);

      // 1% fee means only 99% of deposit actually reaches the silo
      const expected = depositAmount * 99n / 100n;
      expect(credited).to.equal(expected);

      // totalCollateral must match what is actually in the silos so withdrawals don't revert
      const recorded = await factory.totalCollateral(await feeToken.getAddress());
      const siloAddr = await factory.silos(await feeToken.getAddress(), 0);
      const siloBalance = await feeToken.balanceOf(siloAddr);

      expect(recorded).to.equal(siloBalance);
      expect(recorded).to.equal(expected);
    });
  });

  describe("Withdraw", function () {
    beforeEach(async function () {
      await token.connect(vaultRole).transfer(await factory.getAddress(), ethers.parseEther("250"));
      await factory.connect(vaultRole).deposit(await token.getAddress(), ethers.parseEther("250"));
      // 3 silos: 100, 100, 50
    });

    it("should withdraw from latest silo first (LIFO)", async function () {
      await factory.connect(vaultRole).withdraw(await token.getAddress(), other.address, ethers.parseEther("50"));

      // Third silo should be empty, first two full
      const silo2 = await factory.getSilo(await token.getAddress(), 2);
      const siloContract = await ethers.getContractAt("CollateralSilo", silo2);
      expect(await siloContract.balance()).to.equal(0);
    });

    it("should revert if insufficient collateral", async function () {
      await expect(
        factory.connect(vaultRole).withdraw(await token.getAddress(), other.address, ethers.parseEther("300"))
      ).to.be.revertedWith("Insufficient collateral");
    });

    it("should only allow VAULT_ROLE", async function () {
      await expect(
        factory.connect(other).withdraw(await token.getAddress(), other.address, ethers.parseEther("10"))
      ).to.be.reverted;
    });

    it("should track totalCollateral correctly", async function () {
      expect(await factory.totalCollateral(await token.getAddress())).to.equal(ethers.parseEther("250"));

      await factory.connect(vaultRole).withdraw(await token.getAddress(), other.address, ethers.parseEther("100"));
      expect(await factory.totalCollateral(await token.getAddress())).to.equal(ethers.parseEther("150"));
    });
  });

  describe("setSiloCap", function () {
    it("should reject 0", async function () {
      await expect(factory.setSiloCap(0)).to.be.revertedWith("Invalid cap");
    });

    it("should reject > MAX_SILO_CAP", async function () {
      await expect(factory.setSiloCap(MAX_SILO_CAP + 1n)).to.be.revertedWith("Invalid cap");
    });

    it("should accept valid cap", async function () {
      await factory.setSiloCap(ethers.parseEther("500"));
      expect(await factory.siloCap()).to.equal(ethers.parseEther("500"));
    });
  });

  describe("predictSiloAddress", function () {
    it("should match actual deployed silo address", async function () {
      const predicted = await factory.predictSiloAddress(await token.getAddress(), 0);

      // Trigger silo creation
      await token.connect(vaultRole).transfer(await factory.getAddress(), ethers.parseEther("10"));
      await factory.connect(vaultRole).deposit(await token.getAddress(), ethers.parseEther("10"));

      const actual = await factory.getSilo(await token.getAddress(), 0);
      expect(actual).to.equal(predicted);
    });
  });

  describe("getSiloCount", function () {
    it("should return correct count", async function () {
      expect(await factory.getSiloCount(await token.getAddress())).to.equal(0);

      await token.connect(vaultRole).transfer(await factory.getAddress(), ethers.parseEther("10"));
      await factory.connect(vaultRole).deposit(await token.getAddress(), ethers.parseEther("10"));
      expect(await factory.getSiloCount(await token.getAddress())).to.equal(1);
    });
  });
});
