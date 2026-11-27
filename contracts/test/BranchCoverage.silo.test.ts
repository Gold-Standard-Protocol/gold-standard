import { expect } from "chai";
import { ethers } from "hardhat";
import { BaseContract } from "ethers";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";

/**
 * Branch coverage for FeeSplitter, CollateralSilo and SiloFactory: the guard, loop and
 * modifier arms the behavioural suites leave untaken. Each test names the branch it takes.
 * Both contracts are deployed standalone, mirroring FeeSplitter.test.ts and
 * CollateralSilo.test.ts.
 */

const SILO_CAP = ethers.parseEther("100");

function unauthorised(contract: BaseContract, call: Promise<unknown>) {
  return expect(call).to.be.revertedWithCustomError(contract, "AccessControlUnauthorizedAccount");
}

async function splitterSystem() {
  const [owner, vault, beneficiary, other] = await ethers.getSigners();

  const MockToken = await ethers.getContractFactory("MockERC20");
  const gsusd = await (await ethers.getContractFactory("MockGsusd")).deploy();
  const gold = await MockToken.deploy("Pax Gold", "PAXG", 18);

  const SurplusBufferF = await ethers.getContractFactory("SurplusBuffer");
  const buffer = await SurplusBufferF.deploy(await gsusd.getAddress());
  const FeeSplitterF = await ethers.getContractFactory("FeeSplitter");
  const splitter = await FeeSplitterF.deploy(await gsusd.getAddress(), await buffer.getAddress());
  const splitterAddr = await splitter.getAddress();

  await buffer.grantRole(await buffer.VAULT_ROLE(), splitterAddr);
  await splitter.grantRole(await splitter.VAULT_ROLE(), vault.address);

  await gsusd.mint(vault.address, ethers.parseEther("100000"));
  await gold.mint(vault.address, ethers.parseEther("100000"));
  await gsusd.connect(vault).approve(splitterAddr, ethers.MaxUint256);
  await gold.connect(vault).approve(splitterAddr, ethers.MaxUint256);

  return { owner, vault, beneficiary, other, gsusd, gold, buffer, splitter, splitterAddr };
}

async function siloSystem() {
  const [admin, vaultRole, other] = await ethers.getSigners();

  const MockToken = await ethers.getContractFactory("MockERC20");
  const token = await MockToken.deploy("Pax Gold", "PAXG", 18);
  const FreezableF = await ethers.getContractFactory("MockERC20Freezable");
  const freezable = await FreezableF.deploy("Frozen Gold", "FGLD");
  const SilentF = await ethers.getContractFactory("MockERC20SilentFail");
  const silent = await SilentF.deploy();

  const SiloF = await ethers.getContractFactory("SiloFactory");
  const factory = await SiloF.deploy(SILO_CAP);
  const factoryAddr = await factory.getAddress();
  await factory.grantRole(await factory.VAULT_ROLE(), vaultRole.address);

  const supply = ethers.parseEther("1000");
  await token.mint(vaultRole.address, supply);
  await freezable.mint(vaultRole.address, supply);
  await silent.mint(vaultRole.address, supply);
  await token.connect(vaultRole).approve(factoryAddr, ethers.MaxUint256);
  await freezable.connect(vaultRole).approve(factoryAddr, ethers.MaxUint256);
  await silent.connect(vaultRole).approve(factoryAddr, ethers.MaxUint256);

  return {
    admin, vaultRole, other, token, freezable, silent, factory, factoryAddr,
    tokenAddr: await token.getAddress(),
    freezableAddr: await freezable.getAddress(),
    silentAddr: await silent.getAddress(),
  };
}

describe("FeeSplitter branch coverage", function () {
  it("refuses depositFee from a caller without VAULT_ROLE", async function () {
    const { splitter, other } = await loadFixture(splitterSystem);
    await unauthorised(splitter, splitter.connect(other).depositFee(1n));
  });

  it("forwards nothing to the buffer when the deposit is zero", async function () {
    const { splitter, buffer, vault } = await loadFixture(splitterSystem);
    await expect(splitter.connect(vault).depositFee(0n)).to.emit(splitter, "FeeSplit").withArgs(vault.address, 0n, 0n);
    expect(await buffer.gsusdBalance()).to.equal(0n);
    expect(await splitter.beneficiaryAccrued()).to.equal(0n);
  });

  it("refuses depositCollateral from a caller without VAULT_ROLE", async function () {
    const { splitter, gold, other } = await loadFixture(splitterSystem);
    await unauthorised(splitter, splitter.connect(other).depositCollateral(await gold.getAddress(), 1n));
  });

  it("refuses absorbBadDebt from a caller without VAULT_ROLE", async function () {
    const { splitter, other } = await loadFixture(splitterSystem);
    await unauthorised(splitter, splitter.connect(other).absorbBadDebt(1n));
  });

  it("refuses to claim when nothing has accrued", async function () {
    const { splitter } = await loadFixture(splitterSystem);
    await expect(splitter.claimBeneficiary()).to.be.revertedWith("Nothing accrued");
  });

  it("pays the accrued fees out when the beneficiary is unset, so nothing is ever owed to nobody", async function () {
    // The "Beneficiary not set" guard inside claimBeneficiary is defence in depth: accrual
    // requires a beneficiary and setBeneficiary settles what is owed before it moves.
    const { splitter, buffer, gsusd, vault, beneficiary } = await loadFixture(splitterSystem);
    await splitter.setBeneficiary(beneficiary.address);
    await splitter.setBeneficiaryShare(5000n);
    // The buffer's automatic floor is 2,000 (2% of the 100,000 supply): 4,000 tops it up
    // and leaves 2,000 of surplus to split.
    await splitter.connect(vault).depositFee(ethers.parseEther("4000"));
    expect(await splitter.beneficiaryAccrued()).to.equal(ethers.parseEther("1000"));
    expect(await buffer.gsusdBalance()).to.equal(ethers.parseEther("3000"));

    await splitter.setBeneficiaryShare(0n);
    await expect(splitter.setBeneficiary(ethers.ZeroAddress))
      .to.emit(splitter, "BeneficiaryClaimed")
      .withArgs(beneficiary.address, ethers.parseEther("1000"));
    expect(await gsusd.balanceOf(beneficiary.address)).to.equal(ethers.parseEther("1000"));
    expect(await splitter.beneficiary()).to.equal(ethers.ZeroAddress);
    expect(await splitter.beneficiaryAccrued()).to.equal(0n);
    await expect(splitter.claimBeneficiary()).to.be.revertedWith("Nothing accrued");
  });

  it("refuses to hand governance to the caller itself", async function () {
    const { splitter, owner } = await loadFixture(splitterSystem);
    await expect(splitter.transferGovernance(owner.address)).to.be.revertedWith("Would self-revoke");
  });
});

describe("CollateralSilo branch coverage", function () {
  it("refuses a second initialisation of a deployed silo", async function () {
    const { factory, vaultRole, tokenAddr } = await loadFixture(siloSystem);
    await factory.connect(vaultRole).deposit(tokenAddr, ethers.parseEther("10"));
    const silo = await ethers.getContractAt("CollateralSilo", await factory.getSilo(tokenAddr, 0));
    expect(await silo.initialised()).to.equal(true);
    await expect(silo.initialise(tokenAddr)).to.be.revertedWith("Already initialised");
  });

  it("refuses a second initialisation of the implementation", async function () {
    const { factory, tokenAddr } = await loadFixture(siloSystem);
    const impl = await ethers.getContractAt("CollateralSilo", await factory.siloImplementation());
    await expect(impl.initialise(tokenAddr)).to.be.revertedWith("Already initialised");
  });

  it("only lets the factory withdraw from a silo", async function () {
    const { factory, vaultRole, other, tokenAddr } = await loadFixture(siloSystem);
    await factory.connect(vaultRole).deposit(tokenAddr, ethers.parseEther("10"));
    const silo = await ethers.getContractAt("CollateralSilo", await factory.getSilo(tokenAddr, 0));
    await expect(silo.connect(other).withdraw(other.address, 1n)).to.be.revertedWith("Only factory");
    await expect(silo.connect(vaultRole).withdraw(other.address, 1n)).to.be.revertedWith("Only factory");
  });
});

describe("SiloFactory branch coverage", function () {
  describe("deposit", function () {
    it("refuses a caller without VAULT_ROLE", async function () {
      const { factory, other, tokenAddr } = await loadFixture(siloSystem);
      await unauthorised(factory, factory.connect(other).deposit(tokenAddr, 1n));
    });

    it("skips a silo whose transfer returns false and delivers nothing, until the skip bound trips", async function () {
      const { factory, vaultRole, silent, silentAddr } = await loadFixture(siloSystem);
      await silent.setFailSilently(true);
      await expect(factory.connect(vaultRole).deposit(silentAddr, ethers.parseEther("10")))
        .to.be.revertedWith("Too many unusable silos");
      expect(await factory.totalCollateral(silentAddr)).to.equal(0n);

      // The same token deposits normally once its transfers deliver again.
      await silent.setFailSilently(false);
      await factory.connect(vaultRole).deposit(silentAddr, ethers.parseEther("10"));
      expect(await factory.totalCollateral(silentAddr)).to.equal(ethers.parseEther("10"));
    });

    it("skips eight pre-funded full silos and lands in the ninth", async function () {
      const { factory, vaultRole, token, tokenAddr } = await loadFixture(siloSystem);
      const maxSkips = Number(await factory.MAX_SKIPS_PER_DEPOSIT());
      for (let i = 0; i < maxSkips; i++) {
        await token.mint(await factory.predictSiloAddress(tokenAddr, i), SILO_CAP);
      }
      await factory.connect(vaultRole).deposit(tokenAddr, ethers.parseEther("1"));
      expect(await factory.currentSiloIndex(tokenAddr)).to.equal(BigInt(maxSkips));
      expect(await factory.getSiloCount(tokenAddr)).to.equal(BigInt(maxSkips + 1));
      const landing = await ethers.getContractAt("CollateralSilo", await factory.getSilo(tokenAddr, maxSkips));
      expect(await landing.balance()).to.equal(ethers.parseEther("1"));
      expect(await factory.totalCollateral(tokenAddr)).to.equal(ethers.parseEther("1"));
    });

    it("gives up once nine consecutive silos are already full", async function () {
      const { factory, vaultRole, token, tokenAddr } = await loadFixture(siloSystem);
      const maxSkips = Number(await factory.MAX_SKIPS_PER_DEPOSIT());
      for (let i = 0; i <= maxSkips; i++) {
        await token.mint(await factory.predictSiloAddress(tokenAddr, i), SILO_CAP);
      }
      await expect(factory.connect(vaultRole).deposit(tokenAddr, ethers.parseEther("1")))
        .to.be.revertedWith("Too many unusable silos");
    });
  });

  describe("withdraw", function () {
    it("refuses a caller without VAULT_ROLE", async function () {
      const { factory, other, tokenAddr } = await loadFixture(siloSystem);
      await unauthorised(factory, factory.connect(other).withdraw(tokenAddr, other.address, 0n));
    });

    it("passes over an empty later silo and draws from an earlier one", async function () {
      const { factory, vaultRole, other, token, tokenAddr } = await loadFixture(siloSystem);
      await factory.connect(vaultRole).deposit(tokenAddr, SILO_CAP);
      await factory.connect(vaultRole).deposit(tokenAddr, ethers.parseEther("50"));
      expect(await factory.getSiloCount(tokenAddr)).to.equal(2n);

      await factory.connect(vaultRole).withdraw(tokenAddr, other.address, ethers.parseEther("50"));
      const later = await ethers.getContractAt("CollateralSilo", await factory.getSilo(tokenAddr, 1));
      expect(await later.balance()).to.equal(0n);

      await factory.connect(vaultRole).withdraw(tokenAddr, other.address, ethers.parseEther("10"));
      const earlier = await ethers.getContractAt("CollateralSilo", await factory.getSilo(tokenAddr, 0));
      expect(await earlier.balance()).to.equal(ethers.parseEther("90"));
      expect(await token.balanceOf(other.address)).to.equal(ethers.parseEther("60"));
    });

    it("reverts when the only funded silo is frozen", async function () {
      const { factory, vaultRole, other, freezable, freezableAddr } = await loadFixture(siloSystem);
      await factory.connect(vaultRole).deposit(freezableAddr, ethers.parseEther("50"));
      await freezable.setFrozen(await factory.getSilo(freezableAddr, 0), true);

      await expect(factory.connect(vaultRole).withdraw(freezableAddr, other.address, ethers.parseEther("50")))
        .to.be.revertedWith("Withdrawal failed: insufficient unfrozen silo balance");
      expect(await factory.totalCollateral(freezableAddr)).to.equal(ethers.parseEther("50"));
    });
  });

  describe("administration", function () {
    it("refuses setCurrentSiloIndex from a caller without DEFAULT_ADMIN_ROLE", async function () {
      const { factory, other, tokenAddr } = await loadFixture(siloSystem);
      await unauthorised(factory, factory.connect(other).setCurrentSiloIndex(tokenAddr, 1n));
    });

    it("refuses setSiloCap from a caller without DEFAULT_ADMIN_ROLE", async function () {
      const { factory, other } = await loadFixture(siloSystem);
      await unauthorised(factory, factory.connect(other).setSiloCap(SILO_CAP));
    });
  });
});
