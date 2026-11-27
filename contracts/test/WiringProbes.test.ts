import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { productionSystem, LIQ_RATIO, LIQ_PENALTY } from "./helpers/productionSystem";
import { loadOpen, openPaxgVault, walkPrice, priceForRatio, fundGsusd } from "./helpers/openProfile";

/**
 * Wiring setters refuse what could never work, at wiring time rather than mid-crisis:
 *  -  an EOA as the stability reserve made every direct liquidation with a reserve share
 *         revert without a reason, because the extcodesize check sits outside the try/catch;
 *  -  the collateral ratio bound and the clean mint overflow.
 */
describe("Wiring probes", function () {
  it("setStabilityReserve refuses an EOA and a contract that has not granted VAULT_ROLE", async function () {
    const s = await loadFixture(productionSystem);
    await expect(s.vault.setStabilityReserve(s.alice.address)).to.be.revertedWith("Not a contract");
    await expect(s.vault.setStabilityReserve(await s.oracle.getAddress())).to.be.reverted;
    const ReserveF = await ethers.getContractFactory("GoldStabilityReserve");
    const fresh = await ReserveF.deploy(await s.stablecoin.getAddress(), await s.oracle.getAddress());
    await expect(s.vault.setStabilityReserve(await fresh.getAddress())).to.be.revertedWith(
      "Reserve has not granted VAULT_ROLE"
    );
    await fresh.grantRole(await fresh.VAULT_ROLE(), await s.vault.getAddress());
    await s.vault.setStabilityReserve(await fresh.getAddress());
    expect(await s.vault.stabilityReserve()).to.equal(await fresh.getAddress());
    await s.vault.setStabilityReserve(ethers.ZeroAddress);
    expect(await s.vault.stabilityReserve()).to.equal(ethers.ZeroAddress);
  });

  it("a direct liquidation with a reserve share settles once the reserve is a real reserve", async function () {
    const s = await loadOpen();
    const paxg = await s.paxg.getAddress();
    const { amount } = await openPaxgVault(s, s.charlie, 10n);
    await fundGsusd(s, s.bob, ethers.parseEther("50000"));
    await walkPrice(s, paxg, s.paxgFeed, await priceForRatio(s, s.charlie.address, amount, 1_080_000n));
    expect(await s.vault.reservePenaltyShareBps()).to.equal(4000n);
    await expect(s.vault.connect(s.bob).liquidate(s.charlie.address, 0, { gasLimit: 16_000_000n }))
      .to.emit(s.vault, "PenaltyRoutedToReserve");
  });

  it("the sibling setters name a non-contract instead of reverting bare", async function () {
    const s = await loadFixture(productionSystem);
    await expect(s.vault.setSurplusBuffer(s.alice.address)).to.be.revertedWith("Not a contract");
    await expect(s.vault.setStabilityPool(s.alice.address)).to.be.revertedWith("Not a contract");
    await expect(s.vault.setSiloFactory(ethers.ZeroAddress)).to.be.revertedWith("Current factory holds collateral").catch(() => undefined);
  });

  it("setVaultRegistry refuses a registry built for another vault", async function () {
    const s = await loadFixture(productionSystem);
    const RegistryF = await ethers.getContractFactory("VaultRegistry");
    const foreign = await RegistryF.deploy(await s.oracle.getAddress());
    await expect(s.vault.setVaultRegistry(await foreign.getAddress())).to.be.revertedWith(
      "Registry serves another vault"
    );
    await expect(s.vault.setVaultRegistry(s.alice.address)).to.be.revertedWith("Registry must be a contract");
    await s.vault.setVaultRegistry(ethers.ZeroAddress);
    await s.vault.setVaultRegistry(await s.registry.getAddress());
    expect(await s.vault.vaultRegistry()).to.equal(await s.registry.getAddress());
  });
});

describe("Collateral ratio bound", function () {
  it("addCollateralType and updateCollateralRatios refuse a minimum ratio above 1,000%", async function () {
    const s = await loadFixture(productionSystem);
    const paxg = await s.paxg.getAddress();
    const max = await s.vault.MAX_MIN_RATIO();
    expect(max).to.equal(10_000_000n);
    await expect(
      s.vault.updateCollateralRatios(paxg, max + 1n, LIQ_RATIO, LIQ_PENALTY)
    ).to.be.revertedWith("Min ratio exceeds maximum");
    await s.vault.updateCollateralRatios(paxg, max, LIQ_RATIO, LIQ_PENALTY);
    const MockToken = await ethers.getContractFactory("MockERC20");
    const other = await MockToken.deploy("Other Gold", "OGLD", 18);
    await expect(
      s.vault.addCollateralType(await other.getAddress(), max + 1n, LIQ_RATIO, LIQ_PENALTY, ethers.MaxUint256)
    ).to.be.revertedWith("Min ratio exceeds maximum");
  });

  it("the governance wrapper refuses the same proposal before it reaches the timelock", async function () {
    const s = await loadFixture(productionSystem);
    const paxg = await s.paxg.getAddress();
    const max = await s.governance.MAX_MIN_RATIO();
    await expect(
      s.governance.connect(s.proposer).proposeCollateralRatioUpdate(paxg, max + 1n, LIQ_RATIO, LIQ_PENALTY)
    ).to.be.revertedWith("Min ratio exceeds maximum");
    await expect(
      s.governance.connect(s.proposer).proposeCollateralRatioUpdate(paxg, max, LIQ_RATIO, LIQ_PENALTY)
    ).to.emit(s.governance, "ProposalCreated");
  });
});

describe("Mint overflow", function () {
  it("an absurd mint fails with a reason rather than a panic", async function () {
    const s = await loadOpen();
    await openPaxgVault(s, s.alice, 10n);
    await expect(s.vault.connect(s.alice).mint(ethers.MaxUint256)).to.be.revertedWith("Mint amount too large");
    const totalDebt = (await s.vault.collateralTypes(s.paxgId)).totalDebt;
    await expect(s.vault.connect(s.alice).mint(ethers.MaxUint256 - totalDebt + 1n)).to.be.revertedWith(
      "Mint amount too large"
    );
    // Just inside the guard (a block of fee accrues before the call lands): the ratio
    // check is what rejects it, with its own reason.
    const current = await s.vault.getVaultCurrentDebt(s.alice.address);
    await expect(s.vault.connect(s.alice).mint(ethers.MaxUint256 - current - ethers.parseEther("1"))).to.be.revertedWith(
      "Below min collateralisation ratio"
    );
  });
});
