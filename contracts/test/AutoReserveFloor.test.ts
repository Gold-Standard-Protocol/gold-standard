import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import type { GoldStablecoin, SurplusBuffer } from "../typechain-types";

type HardhatEthersSigner = Awaited<ReturnType<typeof ethers.getSigners>>[number];

/**
 * The automatic reserve floor (docs/BUSINESS_MODEL.md section 5): withdrawGsusd leaves at
 * least 2% of max(live supply, one day smoothed supply), rounded up, with minGsusdReserve
 * as an optional higher governed minimum. absorbBadDebt is not bound by it. Uses the real
 * GoldStablecoin so the smoothing is the token's own.
 */
describe("SurplusBuffer automatic reserve floor", function () {
  const e = (n: string) => ethers.parseEther(n);
  let gsusd: GoldStablecoin;
  let buffer: SurplusBuffer;
  let deployer: HardhatEthersSigner;
  let holder: HardhatEthersSigner;
  let ops: HardhatEthersSigner;

  beforeEach(async function () {
    [deployer, holder, ops] = await ethers.getSigners();
    gsusd = await (await ethers.getContractFactory("GoldStablecoin")).deploy();
    await gsusd.grantRole(await gsusd.MINTER_ROLE(), deployer.address);
    buffer = await (await ethers.getContractFactory("SurplusBuffer")).deploy(await gsusd.getAddress());
    await buffer.grantRole(await buffer.VAULT_ROLE(), deployer.address);
    await gsusd.approve(await buffer.getAddress(), ethers.MaxUint256);
  });

  async function fund(amount: bigint): Promise<void> {
    await gsusd.mint(deployer.address, amount);
    await buffer.depositFee(amount);
  }

  it("needs no floor at zero supply", async function () {
    expect(await buffer.AUTO_FLOOR_BPS()).to.equal(200n);
    expect(await buffer.autoMinGsusdReserve()).to.equal(0n);
    expect(await buffer.effectiveMinGsusdReserve()).to.equal(0n);
  });

  it("grows with supply at once, and rounds up", async function () {
    await gsusd.mint(holder.address, e("100000"));
    expect(await buffer.effectiveMinGsusdReserve()).to.equal(e("2000"));
    await gsusd.mint(holder.address, e("100000"));
    expect(await buffer.effectiveMinGsusdReserve()).to.equal(e("4000"));
    await gsusd.mint(holder.address, 1n);
    // 2% of (200,000 GSUSD + 1 wei) is 4,000 GSUSD + 0.02 wei: kept as 4,000 GSUSD + 1 wei.
    expect(await buffer.autoMinGsusdReserve()).to.equal(e("4000") + 1n);
  });

  it("does not fall for a burn inside the smoothing window, and follows it a day later", async function () {
    await gsusd.mint(holder.address, e("100000"));
    await time.increase(2 * 24 * 60 * 60);
    await gsusd.connect(holder).burn(e("50000"));
    expect(await gsusd.totalSupply()).to.equal(e("50000"));
    expect(await buffer.effectiveMinGsusdReserve()).to.equal(e("2000"));
    await time.increase(24 * 60 * 60);
    expect(await buffer.effectiveMinGsusdReserve()).to.equal(e("1000"));
  });

  it("refuses a withdrawal that a fresh burn would otherwise have unlocked", async function () {
    await gsusd.mint(holder.address, e("100000"));
    await fund(e("4000")); // supply 104,000: floor 2,080
    await time.increase(2 * 24 * 60 * 60);
    await gsusd.connect(holder).burn(e("100000")); // live supply 4,000
    await expect(buffer.withdrawGsusd(ops.address, e("3000"))).to.be.revertedWith("Would breach min GSUSD reserve");
    await buffer.withdrawGsusd(ops.address, e("1920"));
    expect(await buffer.gsusdBalance()).to.equal(e("2080"));
  });

  it("allows a withdrawal exactly to the floor and refuses one wei more", async function () {
    await gsusd.mint(holder.address, e("96000"));
    await fund(e("4000")); // supply 100,000: floor 2,000
    await expect(buffer.withdrawGsusd(ops.address, e("2000") + 1n)).to.be.revertedWith(
      "Would breach min GSUSD reserve"
    );
    await expect(buffer.withdrawGsusd(ops.address, e("2000")))
      .to.emit(buffer, "GsusdWithdrawn")
      .withArgs(ops.address, e("2000"));
    expect(await buffer.gsusdBalance()).to.equal(e("2000"));
    await expect(buffer.withdrawGsusd(ops.address, 1n)).to.be.revertedWith("Would breach min GSUSD reserve");
  });

  it("lets a governed minimum above the automatic floor bind, and ignores one below it", async function () {
    await gsusd.mint(holder.address, e("96000"));
    await fund(e("4000"));
    await buffer.setMinGsusdReserve(e("3500"));
    expect(await buffer.autoMinGsusdReserve()).to.equal(e("2000"));
    expect(await buffer.effectiveMinGsusdReserve()).to.equal(e("3500"));
    await expect(buffer.withdrawGsusd(ops.address, e("500") + 1n)).to.be.revertedWith(
      "Would breach min GSUSD reserve"
    );
    await buffer.setMinGsusdReserve(e("1"));
    expect(await buffer.effectiveMinGsusdReserve()).to.equal(e("2000"));
    await buffer.withdrawGsusd(ops.address, e("1000"));
    expect(await buffer.gsusdBalance()).to.equal(e("3000"));
  });

  it("lets absorbBadDebt take the whole balance, floor or not", async function () {
    await gsusd.mint(holder.address, e("96000"));
    await fund(e("4000"));
    await buffer.setMinGsusdReserve(e("4000"));
    const supplyBefore = await gsusd.totalSupply();
    const heldBefore = await gsusd.balanceOf(deployer.address);
    await expect(buffer.absorbBadDebt(e("10000"))).to.emit(buffer, "BadDebtAbsorbed").withArgs(e("4000"));
    expect(await buffer.gsusdBalance()).to.equal(0n);
    expect(supplyBefore - (await gsusd.totalSupply())).to.equal(e("4000"));
    expect(await gsusd.balanceOf(deployer.address)).to.equal(heldBefore);
  });

  it("fails closed for a GSUSD without smoothedSupplyNow: no withdrawal, bad debt still absorbed", async function () {
    const plain = await (await ethers.getContractFactory("MockERC20")).deploy("Plain", "P", 18);
    const bare = await (await ethers.getContractFactory("SurplusBuffer")).deploy(await plain.getAddress());
    await bare.grantRole(await bare.VAULT_ROLE(), deployer.address);
    await plain.mint(deployer.address, e("1000"));
    await plain.approve(await bare.getAddress(), ethers.MaxUint256);
    await bare.depositFee(e("1000"));
    await expect(bare.withdrawGsusd(ops.address, 1n)).to.be.reverted;
    await bare.absorbBadDebt(e("1000"));
    expect(await bare.gsusdBalance()).to.equal(0n);
  });
});
