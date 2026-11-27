import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { productionSystem } from "./helpers/productionSystem";

describe("Reserve swap received-amount protection", function () {
  async function feeTokenSystem() {
    const s = await productionSystem();
    const token = await (await ethers.getContractFactory("MockERC20FeeOnTransfer")).deploy("Fee Gold", "FGLD", 100);
    const address = await token.getAddress();
    await s.oracle.addFeed(address, await s.paxgFeed.getAddress());
    await s.oracle.getTokenPrice(address);
    await s.reserve.setAssetConfig(address, true, 0, 1_000_000);
    await token.mint(s.deployer.address, ethers.parseEther("10"));
    await token.approve(await s.reserve.getAddress(), ethers.MaxUint256);
    await s.reserve.seedCollateral(address, ethers.parseEther("10"));
    return { ...s, token, address };
  }

  it("reverts the entire swap if a transfer fee takes the receipt below minGoldOut", async function () {
    const s = await loadFixture(feeTokenSystem);
    const input = ethers.parseEther("100");
    const [quote] = await s.reserve.quoteGoldOut(s.address, input);
    const before = await s.stablecoin.balanceOf(s.alice.address);
    await expect(s.reserve.connect(s.alice).swapGsusdForGold(s.address, input, quote))
      .to.be.revertedWith("Slippage");
    expect(await s.stablecoin.balanceOf(s.alice.address)).to.equal(before);
    expect(await s.token.balanceOf(s.alice.address)).to.equal(0n);
  });

  it("reports the actual receipt and accounts for the full gold amount sent", async function () {
    const s = await loadFixture(feeTokenSystem);
    const input = ethers.parseEther("100");
    const [quote, spread] = await s.reserve.quoteGoldOut(s.address, input);
    const received = quote - quote / 100n;
    const before = await s.reserve.collateralBalance(s.address);
    await expect(s.reserve.connect(s.alice).swapGsusdForGold(s.address, input, received))
      .to.emit(s.reserve, "Swapped")
      .withArgs(s.alice.address, s.address, input, received, spread, input * spread / 1_000_000n);
    expect(await s.token.balanceOf(s.alice.address)).to.equal(received);
    expect(await s.reserve.collateralBalance(s.address)).to.equal(before - quote);
    expect(await s.reserve.totalGoldSwappedOut(s.address)).to.equal(quote);
  });
});
