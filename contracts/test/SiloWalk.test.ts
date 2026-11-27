import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";

/**
 * SiloFactory routing:
 *  -  a deposit that fills a silo moves on without spending a skip, so a single large
 *         deposit may span as many silos as its gas allows;
 *  -  the withdraw walk starts at the deposit cursor, so silos left empty after a peak
 *         no longer tax every later withdrawal, and the cursor still stops on a frozen silo.
 */
const SILO_CAP = ethers.parseEther("100");

async function siloSystem() {
  const [admin, vaultRole, other] = await ethers.getSigners();
  const MockToken = await ethers.getContractFactory("MockERC20");
  const token = await MockToken.deploy("Pax Gold", "PAXG", 18);
  const FreezableF = await ethers.getContractFactory("MockERC20Freezable");
  const freezable = await FreezableF.deploy("Frozen Gold", "FGLD");
  const SiloF = await ethers.getContractFactory("SiloFactory");
  const factory = await SiloF.deploy(SILO_CAP);
  const factoryAddr = await factory.getAddress();
  await factory.grantRole(await factory.VAULT_ROLE(), vaultRole.address);
  const supply = ethers.parseEther("10000");
  await token.mint(vaultRole.address, supply);
  await freezable.mint(vaultRole.address, supply);
  await token.connect(vaultRole).approve(factoryAddr, ethers.MaxUint256);
  await freezable.connect(vaultRole).approve(factoryAddr, ethers.MaxUint256);
  return {
    admin, vaultRole, other, token, freezable, factory,
    tokenAddr: await token.getAddress(),
    freezableAddr: await freezable.getAddress(),
  };
}

async function siloBalance(factory: Awaited<ReturnType<typeof siloSystem>>["factory"], token: string, index: number) {
  const silo = await ethers.getContractAt("CollateralSilo", await factory.getSilo(token, index));
  return silo.balance();
}

describe("SiloFactory deposit span", function () {
  it("accepts a single 1,500 oz deposit across fifteen silos", async function () {
    const { factory, vaultRole, tokenAddr } = await loadFixture(siloSystem);
    const amount = ethers.parseEther("1500");
    await factory.connect(vaultRole).deposit(tokenAddr, amount, { gasLimit: 16_000_000n });
    expect(await factory.totalCollateral(tokenAddr)).to.equal(amount);
    expect(await factory.getSiloCount(tokenAddr)).to.equal(15n);
    expect(await factory.currentSiloIndex(tokenAddr)).to.equal(14n);
    for (let i = 0; i < 15; i++) {
      expect(await siloBalance(factory, tokenAddr, i)).to.equal(SILO_CAP);
    }
  });

  it("leaves the cursor on the last silo it wrote, so the next deposit tops it up", async function () {
    const { factory, vaultRole, tokenAddr } = await loadFixture(siloSystem);
    await factory.connect(vaultRole).deposit(tokenAddr, ethers.parseEther("250"), { gasLimit: 16_000_000n });
    expect(await factory.currentSiloIndex(tokenAddr)).to.equal(2n);
    await factory.connect(vaultRole).deposit(tokenAddr, ethers.parseEther("30"));
    expect(await siloBalance(factory, tokenAddr, 2)).to.equal(ethers.parseEther("80"));
    expect(await factory.getSiloCount(tokenAddr)).to.equal(3n);
  });

  it("still spends the skip budget only on silos that refuse funds", async function () {
    const { factory, vaultRole, token, tokenAddr } = await loadFixture(siloSystem);
    const maxSkips = Number(await factory.MAX_SKIPS_PER_DEPOSIT());
    for (let i = 0; i <= maxSkips; i++) {
      await token.mint(await factory.predictSiloAddress(tokenAddr, i), SILO_CAP);
    }
    await expect(factory.connect(vaultRole).deposit(tokenAddr, ethers.parseEther("1"), { gasLimit: 16_000_000n }))
      .to.be.revertedWith("Too many unusable silos");
  });
});

describe("SiloFactory withdraw walk", function () {
  it("starts at the cursor: a donation parked above it is not swept and costs nothing", async function () {
    const { factory, vaultRole, other, token, tokenAddr } = await loadFixture(siloSystem);
    await factory.connect(vaultRole).deposit(tokenAddr, ethers.parseEther("300"), { gasLimit: 16_000_000n });
    await factory.connect(vaultRole).withdraw(tokenAddr, other.address, ethers.parseEther("300"), { gasLimit: 16_000_000n });
    expect(await factory.currentSiloIndex(tokenAddr)).to.equal(0n);
    expect(await factory.getSiloCount(tokenAddr)).to.equal(3n);

    // A donor funds a trailing silo directly; it is not counted and the walk never reaches it.
    await token.mint(await factory.getSilo(tokenAddr, 2), ethers.parseEther("10"));
    await factory.connect(vaultRole).deposit(tokenAddr, ethers.parseEther("50"));
    expect(await siloBalance(factory, tokenAddr, 0)).to.equal(ethers.parseEther("50"));
    await factory.connect(vaultRole).withdraw(tokenAddr, other.address, ethers.parseEther("50"));
    expect(await siloBalance(factory, tokenAddr, 0)).to.equal(0n);
    expect(await siloBalance(factory, tokenAddr, 2)).to.equal(ethers.parseEther("10"));
  });

  it("costs the same to withdraw with thirty trailing empty silos as with none", async function () {
    const { factory, vaultRole, other, tokenAddr } = await loadFixture(siloSystem);
    const gasFor = async (amount: bigint) => {
      const tx = await factory.connect(vaultRole).withdraw(tokenAddr, other.address, amount, { gasLimit: 16_000_000n });
      const receipt = await tx.wait();
      if (receipt === null) throw new Error("no receipt");
      return receipt.gasUsed;
    };
    await factory.connect(vaultRole).deposit(tokenAddr, ethers.parseEther("20"));
    const lean = await gasFor(ethers.parseEther("1"));

    // A peak of 3,000 oz comes and goes, leaving thirty empty clones above the cursor.
    await factory.connect(vaultRole).deposit(tokenAddr, ethers.parseEther("3000"), { gasLimit: 16_000_000n });
    await factory.connect(vaultRole).withdraw(tokenAddr, other.address, ethers.parseEther("3000"), { gasLimit: 16_000_000n });
    expect(await factory.getSiloCount(tokenAddr)).to.equal(31n);
    expect(await factory.currentSiloIndex(tokenAddr)).to.equal(0n);
    const afterPeak = await gasFor(ethers.parseEther("1"));
    expect(afterPeak).to.be.lte(lean + 2_000n);
  });

  it("keeps the cursor on a frozen silo and drains it once unfrozen", async function () {
    const { factory, vaultRole, other, freezable, freezableAddr } = await loadFixture(siloSystem);
    await factory.connect(vaultRole).deposit(freezableAddr, ethers.parseEther("150"), { gasLimit: 16_000_000n });
    expect(await factory.currentSiloIndex(freezableAddr)).to.equal(1n);
    await freezable.setFrozen(await factory.getSilo(freezableAddr, 1), true);

    // 100 comes from silo 0 around the frozen silo 1; the cursor stays on silo 1.
    await factory.connect(vaultRole).withdraw(freezableAddr, other.address, ethers.parseEther("100"));
    expect(await freezable.balanceOf(other.address)).to.equal(ethers.parseEther("100"));
    expect(await siloBalance(factory, freezableAddr, 0)).to.equal(0n);
    expect(await factory.currentSiloIndex(freezableAddr)).to.equal(1n);

    await expect(
      factory.connect(vaultRole).withdraw(freezableAddr, other.address, ethers.parseEther("1"))
    ).to.be.revertedWith("Withdrawal failed: insufficient unfrozen silo balance");

    await freezable.setFrozen(await factory.getSilo(freezableAddr, 1), false);
    await factory.connect(vaultRole).withdraw(freezableAddr, other.address, ethers.parseEther("50"));
    expect(await freezable.balanceOf(other.address)).to.equal(ethers.parseEther("150"));
    expect(await factory.currentSiloIndex(freezableAddr)).to.equal(0n);
  });

  it("rewinds over a partially drained silo only as far as it is empty", async function () {
    const { factory, vaultRole, other, tokenAddr } = await loadFixture(siloSystem);
    await factory.connect(vaultRole).deposit(tokenAddr, ethers.parseEther("250"), { gasLimit: 16_000_000n });
    // Takes 50 from silo 2 and 20 from silo 1: silo 1 still holds 80, so the cursor lands there.
    await factory.connect(vaultRole).withdraw(tokenAddr, other.address, ethers.parseEther("70"));
    expect(await factory.currentSiloIndex(tokenAddr)).to.equal(1n);
    expect(await siloBalance(factory, tokenAddr, 1)).to.equal(ethers.parseEther("80"));
    // Draining silo 1 exactly leaves silo 0 as the highest funded silo.
    await factory.connect(vaultRole).withdraw(tokenAddr, other.address, ethers.parseEther("80"));
    expect(await factory.currentSiloIndex(tokenAddr)).to.equal(0n);
  });
});
