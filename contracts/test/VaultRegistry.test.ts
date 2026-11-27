import { expect } from "chai";
import hre, { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { productionSystem, setValidPrice, GOLD_PRICE } from "./helpers/productionSystem";

/**
 * VaultRegistry: the on-chain list of open vaults and the agent-facing views, so a
 * liquidator or an automated agent can find and judge vaults with nothing but the
 * verified contracts. Membership rule: an owner is listed exactly while its vault holds
 * collateral or debt.
 */
describe("VaultRegistry", function () {
  const ONE = ethers.parseEther("1");
  const list = async (p: Promise<readonly string[]>) => [...(await p)];

  async function walkPriceDown(fx: Awaited<ReturnType<typeof productionSystem>>, target: bigint) {
    let price = GOLD_PRICE;
    const paxgAddr = await fx.paxg.getAddress();
    while (price > target) {
      const next = (price * 91n) / 100n > target ? (price * 91n) / 100n : target;
      await setValidPrice(fx.paxgFeed, next);
      await setValidPrice(fx.xautFeed, next);
      await fx.oracle.getTokenPrice(paxgAddr);
      await fx.oracle.getTokenPrice(await fx.xaut.getAddress());
      price = next;
    }
  }

  describe("membership", function () {
    it("lists an owner on the first deposit and only once", async function () {
      const fx = await loadFixture(productionSystem);
      expect(await fx.registry.vaultOwnerCount()).to.equal(0n);
      await expect(fx.vault.connect(fx.alice).deposit(await fx.paxg.getAddress(), ONE))
        .to.emit(fx.registry, "VaultListed").withArgs(fx.alice.address);
      await fx.vault.connect(fx.alice).deposit(await fx.paxg.getAddress(), ONE);
      expect(await fx.registry.vaultOwnerCount()).to.equal(1n);
      expect(await fx.registry.vaultOwnerAt(0)).to.equal(fx.alice.address);
      expect(await fx.registry.isVaultOwner(fx.alice.address)).to.equal(true);
      expect(await fx.registry.isVaultOwner(fx.bob.address)).to.equal(false);
    });

    it("delists an owner when the last collateral is withdrawn", async function () {
      const fx = await loadFixture(productionSystem);
      await fx.vault.connect(fx.alice).deposit(await fx.paxg.getAddress(), ONE);
      await expect(fx.vault.connect(fx.alice).withdraw(ONE))
        .to.emit(fx.registry, "VaultDelisted").withArgs(fx.alice.address);
      expect(await fx.registry.vaultOwnerCount()).to.equal(0n);
      expect(await fx.registry.isVaultOwner(fx.alice.address)).to.equal(false);
    });

    it("keeps an owner through mint and full repayment while collateral remains", async function () {
      const fx = await loadFixture(productionSystem);
      await fx.vault.connect(fx.alice).deposit(await fx.paxg.getAddress(), ONE);
      await fx.vault.connect(fx.alice).mint(ethers.parseEther("1000"));
      expect(await fx.registry.isVaultOwner(fx.alice.address)).to.equal(true);
      await fx.vault.connect(fx.alice).repay(ethers.parseEther("1100"));
      expect(await fx.registry.isVaultOwner(fx.alice.address)).to.equal(true);
      await fx.vault.connect(fx.alice).withdraw(ONE);
      expect(await fx.registry.isVaultOwner(fx.alice.address)).to.equal(false);
    });

    it("keeps a liquidated borrower who still holds leftover collateral", async function () {
      const fx = await loadFixture(productionSystem);
      await fx.vault.connect(fx.alice).deposit(await fx.paxg.getAddress(), ONE);
      await fx.vault.connect(fx.alice).mint(ethers.parseEther("1300"));
      await walkPriceDown(fx, 140000000000n); // $1,400: ratio 107%
      // 0 means the whole debt, whatever it has accrued to by the time the call lands.
      await fx.vault.connect(fx.bob).liquidate(fx.alice.address, 0);
      const v = await fx.vault.vaults(fx.alice.address);
      expect(v.debtAmount).to.equal(0n);
      expect(v.collateralAmount).to.be.greaterThan(0n);
      expect(await fx.registry.isVaultOwner(fx.alice.address)).to.equal(true);
    });

    it("delists a borrower whose vault is emptied by an underwater liquidation", async function () {
      const fx = await loadFixture(productionSystem);
      await fx.vault.connect(fx.alice).deposit(await fx.paxg.getAddress(), ONE);
      await fx.vault.connect(fx.alice).mint(ethers.parseEther("1300"));
      await walkPriceDown(fx, 110000000000n); // $1,100: collateral is worth less than the debt
      await expect(fx.vault.connect(fx.bob).liquidate(fx.alice.address, 0))
        .to.emit(fx.registry, "VaultDelisted").withArgs(fx.alice.address);
      const v = await fx.vault.vaults(fx.alice.address);
      expect(v.collateralAmount).to.equal(0n);
      expect(await fx.registry.isVaultOwner(fx.alice.address)).to.equal(false);
    });

    it("follows the emergency liquidation path while the vault is paused", async function () {
      const fx = await loadFixture(productionSystem);
      await fx.vault.connect(fx.alice).deposit(await fx.paxg.getAddress(), ONE);
      await fx.vault.connect(fx.alice).mint(ethers.parseEther("1300"));
      await walkPriceDown(fx, 110000000000n);
      await fx.vault.connect(fx.guardian).emergencyPause();
      await expect(fx.vault.connect(fx.bob).emergencyLiquidate(fx.alice.address, 0))
        .to.emit(fx.registry, "VaultDelisted").withArgs(fx.alice.address);
      expect(await fx.registry.isVaultOwner(fx.alice.address)).to.equal(false);
    });

    it("follows the pool liquidation path too", async function () {
      const fx = await loadFixture(productionSystem);
      await fx.stabilityPool.connect(fx.alice).deposit(ethers.parseEther("20000"));
      await fx.vault.connect(fx.bob).deposit(await fx.paxg.getAddress(), ONE);
      await fx.vault.connect(fx.bob).mint(ethers.parseEther("1300"));
      await walkPriceDown(fx, 110000000000n);
      await fx.vault.connect(fx.charlie).liquidateViaPool(fx.bob.address, 0);
      expect(await fx.registry.isVaultOwner(fx.bob.address)).to.equal(false);
    });
  });

  describe("pages", function () {
    it("pages through owners in insertion order and clips at the end", async function () {
      const fx = await loadFixture(productionSystem);
      await fx.vault.connect(fx.alice).deposit(await fx.paxg.getAddress(), ONE);
      await fx.vault.connect(fx.bob).deposit(await fx.paxg.getAddress(), ONE);
      await fx.vault.connect(fx.charlie).deposit(await fx.xaut.getAddress(), 1_000_000n);
      expect(await list(fx.registry.vaultOwners(0, 2))).to.deep.equal([fx.alice.address, fx.bob.address]);
      expect(await list(fx.registry.vaultOwners(2, 5))).to.deep.equal([fx.charlie.address]);
      expect(await list(fx.registry.vaultOwners(3, 1))).to.deep.equal([]);
      expect(await list(fx.registry.vaultOwners(0, 0))).to.deep.equal([]);
    });

    it("saturates a huge limit at any offset instead of overflowing", async function () {
      const fx = await loadFixture(productionSystem);
      await fx.vault.connect(fx.alice).deposit(await fx.paxg.getAddress(), ONE);
      await fx.vault.connect(fx.bob).deposit(await fx.paxg.getAddress(), ONE);
      await fx.vault.connect(fx.charlie).deposit(await fx.xaut.getAddress(), 1_000_000n);
      const all = [fx.alice.address, fx.bob.address, fx.charlie.address];
      expect(await list(fx.registry.vaultOwners(0, ethers.MaxUint256))).to.deep.equal(all);
      expect(await list(fx.registry.vaultOwners(1, ethers.MaxUint256))).to.deep.equal(all.slice(1));
      expect(await list(fx.registry.vaultOwners(2, ethers.MaxUint256 - 1n))).to.deep.equal(all.slice(2));
      expect(await list(fx.registry.vaultOwners(3, ethers.MaxUint256))).to.deep.equal([]);
      expect(await list(fx.registry.vaultOwners(ethers.MaxUint256, ethers.MaxUint256))).to.deep.equal([]);
      expect(await list(fx.registry.liquidatableVaults(1, ethers.MaxUint256))).to.deep.equal([]);
    });
  });

  describe("agent views", function () {
    it("reports liquidatable vaults from the last known price", async function () {
      const fx = await loadFixture(productionSystem);
      const paxgAddr = await fx.paxg.getAddress();
      await fx.vault.connect(fx.alice).deposit(paxgAddr, ONE);
      expect(await fx.registry.isLiquidatable(fx.alice.address)).to.equal(false); // no debt
      await fx.vault.connect(fx.alice).mint(ethers.parseEther("1300"));
      await fx.vault.connect(fx.bob).deposit(paxgAddr, ethers.parseEther("2"));
      await fx.vault.connect(fx.bob).mint(ethers.parseEther("1300"));
      expect(await fx.registry.isLiquidatable(fx.alice.address)).to.equal(false); // healthy
      await walkPriceDown(fx, 140000000000n);
      expect(await fx.registry.isLiquidatable(fx.alice.address)).to.equal(true);
      expect(await fx.registry.isLiquidatable(fx.bob.address)).to.equal(false);
      expect(await list(fx.registry.liquidatableVaults(0, 10))).to.deep.equal([fx.alice.address]);
      expect(await list(fx.registry.liquidatableVaults(1, 10))).to.deep.equal([]);
    });

    it("summarises a vault in one call", async function () {
      const fx = await loadFixture(productionSystem);
      const paxgAddr = await fx.paxg.getAddress();
      await fx.vault.connect(fx.alice).deposit(paxgAddr, ONE);
      await fx.vault.connect(fx.alice).mint(ethers.parseEther("1000"));
      const s = await fx.registry.vaultSummary(fx.alice.address);
      expect(s.token).to.equal(paxgAddr);
      expect(s.collateral).to.equal(ONE);
      expect(s.debt).to.equal(await fx.vault.getVaultCurrentDebt(fx.alice.address));
      expect(s.ratio).to.equal(await fx.vault.getCollateralisationRatio(fx.alice.address));
      expect(s.liquidationPrice).to.equal(await fx.vault.getLiquidationPrice(fx.alice.address));
      expect(s.liquidatable).to.equal(false);
    });

    it("exposes collateral types by token address", async function () {
      const fx = await loadFixture(productionSystem);
      const paxgAddr = await fx.paxg.getAddress();
      expect(await fx.registry.collateralIdOf(paxgAddr)).to.equal(fx.paxgId);
      const direct = await fx.vault.collateralTypes(fx.paxgId);
      const byAddress = await fx.registry.collateralTypeOf(paxgAddr);
      expect(byAddress.token).to.equal(direct.token);
      expect(byAddress.minRatio).to.equal(direct.minRatio);
      expect(byAddress.liquidationRatio).to.equal(direct.liquidationRatio);
      expect(byAddress.liquidationPenalty).to.equal(direct.liquidationPenalty);
      expect(byAddress.debtCeiling).to.equal(direct.debtCeiling);
      expect(byAddress.totalDebt).to.equal(direct.totalDebt);
      expect(byAddress.active).to.equal(direct.active);
    });
  });

  describe("sync and access", function () {
    it("refuses onVaultChanged from anyone but the vault", async function () {
      const fx = await loadFixture(productionSystem);
      await expect(fx.registry.connect(fx.alice).onVaultChanged(fx.alice.address, false)).to.be.revertedWith("Only vault");
    });

    it("backfills and repairs from the vault's own state, permissionlessly", async function () {
      const fx = await loadFixture(productionSystem);
      const paxgAddr = await fx.paxg.getAddress();
      const Registry = await ethers.getContractFactory("VaultRegistry");
      const fresh = await Registry.deploy(await fx.vault.getAddress());
      await fx.vault.connect(fx.alice).deposit(paxgAddr, ONE);
      expect(await fresh.isVaultOwner(fx.alice.address)).to.equal(false);
      await expect(fresh.connect(fx.charlie).sync(fx.alice.address)).to.emit(fresh, "VaultListed").withArgs(fx.alice.address);
      await fresh.connect(fx.charlie).sync(fx.bob.address);
      expect(await fresh.isVaultOwner(fx.bob.address)).to.equal(false);
      await fx.vault.connect(fx.alice).withdraw(ONE);
      expect(await fresh.isVaultOwner(fx.alice.address)).to.equal(true); // drift: not wired
      await fx.vault.connect(fx.bob).deposit(paxgAddr, ONE);
      await fresh.syncMany([fx.alice.address, fx.bob.address]);
      expect(await list(fresh.vaultOwners(0, 10))).to.deep.equal([fx.bob.address]);
    });

    it("rejects a registry that is not a contract", async function () {
      const fx = await loadFixture(productionSystem);
      const Registry = await ethers.getContractFactory("VaultRegistry");
      await expect(Registry.deploy(ethers.ZeroAddress)).to.be.revertedWith("Vault must be a contract");
      await expect(Registry.deploy(fx.alice.address)).to.be.revertedWith("Vault must be a contract");
    });
  });

  describe("vault wiring", function () {
    it("lists the owner even when the wallet sends the exact gas estimate", async function () {
      // Exact gas is a production-bytecode assertion, like LiquidationGas.test.ts.
      // Coverage instrumentation changes execution costs, and a later block can
      // accrue more interest than the estimate saw. Keep exercising both hooks
      // under coverage with the same 30% headroom used by the local rehearsal.
      const coverageRun = (hre as unknown as { __SOLIDITY_COVERAGE_RUNNING?: boolean }).__SOLIDITY_COVERAGE_RUNNING === true;
      const gasLimit = (estimate: bigint) => coverageRun ? estimate * 130n / 100n : estimate;
      const fx = await loadFixture(productionSystem);
      const paxgAddr = await fx.paxg.getAddress();
      const estimate = await fx.vault.connect(fx.alice).deposit.estimateGas(paxgAddr, ONE);
      await expect(fx.vault.connect(fx.alice).deposit(paxgAddr, ONE, { gasLimit: gasLimit(estimate) }))
        .to.emit(fx.registry, "VaultListed").withArgs(fx.alice.address)
        .and.to.not.emit(fx.vault, "VaultRegistrySyncFailed");
      const mintEstimate = await fx.vault.connect(fx.alice).mint.estimateGas(ethers.parseEther("1000"));
      await expect(fx.vault.connect(fx.alice).mint(ethers.parseEther("1000"), { gasLimit: gasLimit(mintEstimate) }))
        .to.not.emit(fx.vault, "VaultRegistrySyncFailed");
    });

    it("is wired through the governance wrapper and the 48 hour timelock after the handover", async function () {
      const fx = await loadFixture(productionSystem);
      const vaultAddr = await fx.vault.getAddress();
      const fresh = await (await ethers.getContractFactory("VaultRegistry")).deploy(vaultAddr);
      const freshAddr = await fresh.getAddress();
      await fx.vault.transferGovernance(fx.timelockAddr);
      const salt = ethers.zeroPadValue(ethers.toBeHex(await fx.governance.proposalNonce()), 32);
      await expect(fx.governance.connect(fx.alice).proposeVaultRegistryUpdate(freshAddr))
        .to.be.revertedWithCustomError(fx.governance, "AccessControlUnauthorizedAccount");
      await fx.governance.connect(fx.proposer).proposeVaultRegistryUpdate(freshAddr);
      const data = fx.vault.interface.encodeFunctionData("setVaultRegistry", [freshAddr]);
      await expect(fx.governance.connect(fx.executor).executeProposal(vaultAddr, data, salt)).to.be.reverted; // not yet
      await time.increase(48 * 60 * 60 + 1);
      await fx.governance.connect(fx.executor).executeProposal(vaultAddr, data, salt);
      expect(await fx.vault.vaultRegistry()).to.equal(freshAddr);
    });

    it("never lets a reverting registry block the vault, and says so", async function () {
      const fx = await loadFixture(productionSystem);
      const paxgAddr = await fx.paxg.getAddress();
      const broken = await (await ethers.getContractFactory("MockRevertingRegistry")).deploy(await fx.vault.getAddress());
      await fx.vault.setVaultRegistry(await broken.getAddress());
      await expect(fx.vault.connect(fx.alice).deposit(paxgAddr, ONE))
        .to.emit(fx.vault, "VaultRegistrySyncFailed").withArgs(fx.alice.address);
      await fx.vault.connect(fx.alice).mint(ethers.parseEther("1300"));
      await walkPriceDown(fx, 140000000000n);
      await expect(fx.vault.connect(fx.bob).liquidate(fx.alice.address, 0))
        .to.emit(fx.vault, "VaultRegistrySyncFailed").withArgs(fx.alice.address);
      // The real registry missed both changes and anyone can put that right.
      await fx.vault.setVaultRegistry(await fx.registry.getAddress());
      await fx.registry.connect(fx.charlie).sync(fx.alice.address);
      expect(await fx.registry.isVaultOwner(fx.alice.address)).to.equal(true);
    });


    it("lets governance alone set, replace or disable the registry", async function () {
      const fx = await loadFixture(productionSystem);
      const paxgAddr = await fx.paxg.getAddress();
      await expect(fx.vault.connect(fx.alice).setVaultRegistry(ethers.ZeroAddress))
        .to.be.revertedWithCustomError(fx.vault, "AccessControlUnauthorizedAccount");
      await expect(fx.vault.setVaultRegistry(fx.alice.address)).to.be.revertedWith("Registry must be a contract");
      await expect(fx.vault.setVaultRegistry(ethers.ZeroAddress)).to.emit(fx.vault, "VaultRegistryUpdated").withArgs(ethers.ZeroAddress);
      expect(await fx.vault.vaultRegistry()).to.equal(ethers.ZeroAddress);
      await fx.vault.connect(fx.alice).deposit(paxgAddr, ONE); // the hook is skipped, nothing reverts
      expect(await fx.registry.isVaultOwner(fx.alice.address)).to.equal(false);
      await fx.vault.setVaultRegistry(await fx.registry.getAddress());
      await fx.vault.connect(fx.alice).deposit(paxgAddr, ONE);
      expect(await fx.registry.isVaultOwner(fx.alice.address)).to.equal(true);
    });
  });
});
