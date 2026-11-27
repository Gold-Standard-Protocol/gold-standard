import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { productionSystem, setValidPrice, GOLD_PRICE, MIN_RATIO, LIQ_RATIO, LIQ_PENALTY, DEBT_CEILING } from "./helpers/productionSystem";

/**
 * The SurplusBuffer burns the GSUSD it absorbs instead
 * of transferring it to the caller, so a VAULT_ROLE holder can at most destroy buffer GSUSD and
 * never take it past the automatic 3% floor. GoldVault books the absorption from the fall in
 * GSUSD supply, capped at the outstanding bad debt, so no buffer can revert a liquidation or
 * underflow totalBadDebt.
 *
 * The underwater vault uses a zero rate collateral, so it books a fixed 122 GSUSD of bad debt
 * and supply minus principal minus unabsorbed bad debt (the GSUSD minted outside the vault)
 * stays constant through every liquidation and absorption.
 */

type System = Awaited<ReturnType<typeof productionSystem>>;
type Feed = System["paxgFeed"];

const ONE = ethers.parseEther("1");
const DEBT = ethers.parseEther("1200");
const BOOKED = ethers.parseEther("122");
const PRICE_1100 = 1100n * 10n ** 8n;
const MODE = { Revert: 0, BurnNothing: 1, BurnEverything: 2 } as const;

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

async function underwaterSystem() {
  const sys = await productionSystem();
  const token = await (await ethers.getContractFactory("MockERC20")).deploy("Zero Fee Gold", "ZERO", 18);
  const tokenAddr = await token.getAddress();
  const feed = await (await ethers.getContractFactory("MockAggregatorV3")).deploy(8);
  await setValidPrice(feed, GOLD_PRICE);
  await sys.oracle.addFeed(tokenAddr, await feed.getAddress());
  await sys.vault.addCollateralType(tokenAddr, MIN_RATIO, LIQ_RATIO, LIQ_PENALTY, DEBT_CEILING);
  const zeroId = ethers.keccak256(ethers.solidityPacked(["address"], [tokenAddr]));
  await sys.stabilityModule.initCollateral(zeroId, 0);
  await sys.stabilityPool.addCollateralToken(tokenAddr);
  await sys.reserve.setAssetConfig(tokenAddr, true, 0n, 1_000_000n);
  await sys.oracle.getTokenPrice(tokenAddr);
  await token.mint(sys.alice.address, ONE);
  await token.connect(sys.alice).approve(await sys.vault.getAddress(), ethers.MaxUint256);
  await sys.vault.connect(sys.alice).deposit(tokenAddr, ONE);
  await sys.vault.connect(sys.alice).mint(DEBT);
  await walkPrice(sys, feed, tokenAddr, PRICE_1100);
  await sys.surplusBuffer.grantRole(await sys.surplusBuffer.VAULT_ROLE(), sys.deployer.address);
  return { ...sys, zeroId };
}

type Underwater = Awaited<ReturnType<typeof underwaterSystem>>;

async function fundBuffer(sys: Underwater, amount: bigint) {
  await sys.stablecoin.mint(sys.deployer.address, amount);
  await sys.stablecoin.approve(await sys.surplusBuffer.getAddress(), amount);
  await sys.surplusBuffer.depositFee(amount);
}

/** GSUSD supply less outstanding principal less unabsorbed bad debt: constant unless GSUSD is minted outside a vault. */
async function backingGap(sys: Underwater): Promise<bigint> {
  let principal = 0n;
  for (const id of [sys.paxgId, sys.xautId, sys.zeroId]) principal += (await sys.vault.collateralTypes(id)).totalDebt;
  return (await sys.stablecoin.totalSupply()) - principal - (await sys.vault.totalBadDebt());
}

async function wireMock(sys: Underwater, mode: number) {
  const mock = await (await ethers.getContractFactory("MockBadDebtBuffer")).deploy(await sys.stablecoin.getAddress(), mode);
  await sys.vault.setSurplusBuffer(await mock.getAddress());
  return mock;
}

describe("Bad debt absorption burns in the buffer", function () {
  it("pays a VAULT_ROLE holder other than the vault nothing and burns the absorbed GSUSD", async function () {
    const sys = await loadFixture(underwaterSystem);
    await fundBuffer(sys, ethers.parseEther("1000"));
    const intruder = sys.charlie;
    await sys.surplusBuffer.grantRole(await sys.surplusBuffer.VAULT_ROLE(), intruder.address);
    const supplyBefore = await sys.stablecoin.totalSupply();
    const heldBefore = await sys.stablecoin.balanceOf(intruder.address);

    await expect(sys.surplusBuffer.connect(intruder).absorbBadDebt(ethers.MaxUint256))
      .to.emit(sys.surplusBuffer, "BadDebtAbsorbed")
      .withArgs(ethers.parseEther("1000"));

    expect(await sys.stablecoin.balanceOf(intruder.address)).to.equal(heldBefore);
    expect(supplyBefore - (await sys.stablecoin.totalSupply())).to.equal(ethers.parseEther("1000"));
    expect(await sys.stablecoin.balanceOf(await sys.surplusBuffer.getAddress())).to.equal(0n);
    expect(await sys.surplusBuffer.gsusdBalance()).to.equal(0n);
  });

  it("burns exactly the bad debt when the buffer covers it in full", async function () {
    const sys = await loadFixture(underwaterSystem);
    await fundBuffer(sys, ethers.parseEther("1000"));
    const gap = await backingGap(sys);

    await sys.vault.connect(sys.bob).liquidate(sys.alice.address, 0);

    expect(await sys.vault.totalBadDebt()).to.equal(0n);
    expect(await sys.surplusBuffer.gsusdBalance()).to.equal(ethers.parseEther("1000") - BOOKED);
    expect(await sys.stablecoin.balanceOf(await sys.surplusBuffer.getAddress())).to.equal(ethers.parseEther("1000") - BOOKED);
    expect(await sys.stablecoin.balanceOf(await sys.vault.getAddress())).to.equal(0n);
    expect(await backingGap(sys)).to.equal(gap);
  });

  it("burns the whole buffer and books the rest when it covers part", async function () {
    const sys = await loadFixture(underwaterSystem);
    const part = ethers.parseEther("50");
    await fundBuffer(sys, part);
    const gap = await backingGap(sys);

    await sys.vault.connect(sys.bob).liquidate(sys.alice.address, 0);

    expect(await sys.vault.totalBadDebt()).to.equal(BOOKED - part);
    expect(await sys.surplusBuffer.gsusdBalance()).to.equal(0n);
    expect(await sys.stablecoin.balanceOf(await sys.vault.getAddress())).to.equal(0n);
    expect(await backingGap(sys)).to.equal(gap);
  });

  it("absorbs the rest on retry once the buffer is refilled", async function () {
    const sys = await loadFixture(underwaterSystem);
    await sys.vault.connect(sys.bob).liquidate(sys.alice.address, 0);
    expect(await sys.vault.totalBadDebt()).to.equal(BOOKED);
    await expect(sys.vault.retryBadDebtAbsorption()).to.be.revertedWith("Nothing absorbed");

    const topUp = ethers.parseEther("60");
    await fundBuffer(sys, topUp);
    const gap = await backingGap(sys);
    await expect(sys.vault.retryBadDebtAbsorption()).to.emit(sys.vault, "BadDebtRetried").withArgs(topUp);
    expect(await sys.vault.totalBadDebt()).to.equal(BOOKED - topUp);
    expect(await backingGap(sys)).to.equal(gap);

    await fundBuffer(sys, ethers.parseEther("1000"));
    await sys.vault.retryBadDebtAbsorption();
    expect(await sys.vault.totalBadDebt()).to.equal(0n);
    expect(await sys.stablecoin.balanceOf(await sys.vault.getAddress())).to.equal(0n);
  });

  describe("a misbehaving buffer", function () {
    it("that reverts never reverts a liquidation", async function () {
      const sys = await loadFixture(underwaterSystem);
      await wireMock(sys, MODE.Revert);
      await expect(sys.vault.connect(sys.bob).liquidate(sys.alice.address, 0))
        .to.emit(sys.vault, "BadDebtAbsorptionFailed")
        .withArgs(BOOKED);
      expect(await sys.vault.totalBadDebt()).to.equal(BOOKED);
      await expect(sys.vault.retryBadDebtAbsorption()).to.be.revertedWith("Nothing absorbed");
    });

    it("that burns nothing absorbs nothing", async function () {
      const sys = await loadFixture(underwaterSystem);
      const mock = await wireMock(sys, MODE.BurnNothing);
      await sys.stablecoin.mint(await mock.getAddress(), ethers.parseEther("500"));
      await sys.vault.connect(sys.bob).liquidate(sys.alice.address, 0);
      expect(await sys.vault.totalBadDebt()).to.equal(BOOKED);
      expect(await sys.stablecoin.balanceOf(await mock.getAddress())).to.equal(ethers.parseEther("500"));
    });

    it("that burns more than asked is capped at the outstanding bad debt", async function () {
      const sys = await loadFixture(underwaterSystem);
      const mock = await wireMock(sys, MODE.BurnEverything);
      await sys.stablecoin.mint(await mock.getAddress(), ethers.parseEther("5000"));
      await sys.vault.connect(sys.bob).liquidate(sys.alice.address, 0);
      expect(await sys.vault.totalBadDebt()).to.equal(0n);
      expect(await sys.stablecoin.balanceOf(await mock.getAddress())).to.equal(0n);

      // Nothing is left to retry: the cap took totalBadDebt to zero, not below it.
      await expect(sys.vault.retryBadDebtAbsorption()).to.be.revertedWith("No bad debt");
    });

    it("that over burns on retry reports only the outstanding bad debt", async function () {
      const sys = await loadFixture(underwaterSystem);
      const mock = await wireMock(sys, MODE.BurnNothing);
      await sys.vault.connect(sys.bob).liquidate(sys.alice.address, 0);
      await sys.stablecoin.mint(await mock.getAddress(), ethers.parseEther("5000"));
      await mock.setMode(MODE.BurnEverything);
      await expect(sys.vault.retryBadDebtAbsorption()).to.emit(sys.vault, "BadDebtRetried").withArgs(BOOKED);
      expect(await sys.vault.totalBadDebt()).to.equal(0n);
    });
  });

  it("works through a FeeSplitter in front of the buffer, which forwards nothing", async function () {
    const sys = await loadFixture(underwaterSystem);
    await fundBuffer(sys, ethers.parseEther("1000"));
    const splitter = await (await ethers.getContractFactory("FeeSplitter")).deploy(
      await sys.stablecoin.getAddress(),
      await sys.surplusBuffer.getAddress()
    );
    await sys.surplusBuffer.grantRole(await sys.surplusBuffer.VAULT_ROLE(), await splitter.getAddress());
    await splitter.grantRole(await splitter.VAULT_ROLE(), await sys.vault.getAddress());
    await sys.vault.setSurplusBuffer(await splitter.getAddress());

    await expect(sys.vault.connect(sys.bob).liquidate(sys.alice.address, 0))
      .to.emit(splitter, "BadDebtPassedThrough")
      .withArgs(BOOKED, BOOKED);

    expect(await sys.vault.totalBadDebt()).to.equal(0n);
    expect(await sys.surplusBuffer.gsusdBalance()).to.equal(ethers.parseEther("1000") - BOOKED);
    expect(await sys.stablecoin.balanceOf(await splitter.getAddress())).to.equal(0n);
    expect(await sys.stablecoin.balanceOf(await sys.vault.getAddress())).to.equal(0n);
  });
});
