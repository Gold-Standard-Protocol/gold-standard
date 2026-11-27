import { expect } from "chai";
import { ethers } from "hardhat";
import { impersonateAccount, loadFixture, setBalance, stopImpersonatingAccount, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { DEBT_CEILING, LIQ_PENALTY, LIQ_RATIO, MIN_RATIO, productionSystem } from "./helpers/productionSystem";
import { replacementOracle, replacementStabilityModule, replacementVault } from "./helpers/governedTargets";

/**
 * Regression checks: the governance wrapper's replacement targets; the vault's surplus
 * cannot be paid to the vault; collateral with fewer than two decimals. The matching
 * self-payment checks for GoldStabilityReserve, SurplusBuffer and FeeSplitter sit with
 * those contracts' suites.
 */

const MIN_DELAY = 48 * 3600;
const saltFor = (nonce: bigint) => ethers.zeroPadValue(ethers.toBeHex(nonce), 32);
type System = Awaited<ReturnType<typeof productionSystem>>;

describe("Replacement targets, surplus recipient and collateral decimals", function () {
  describe("the governance wrapper's replacement targets", function () {
    async function asTimelock(s: System) {
      await impersonateAccount(s.timelockAddr);
      await setBalance(s.timelockAddr, ethers.parseEther("1"));
      return s.governance.connect(await ethers.getSigner(s.timelockAddr));
    }

    for (const kind of ["vault", "oracle", "stabilityModule"] as const) {
      it(`refuses an address without code as the ${kind}`, async function () {
        const s = await loadFixture(productionSystem);
        const gov = await asTimelock(s);
        const before = await s.governance[kind]();
        try {
          await expect(gov.setGovernedContract(kind, ethers.Wallet.createRandom().address)).to.be.revertedWith("Not a contract");
        } finally {
          await stopImpersonatingAccount(s.timelockAddr);
        }
        expect(await s.governance[kind]()).to.equal(before);
      });
    }

    it("refuses a deployed contract of the wrong kind in each slot", async function () {
      const s = await loadFixture(productionSystem);
      const gov = await asTimelock(s);
      const [vault, oracle, module, token] = await Promise.all([
        s.vault.getAddress(),
        s.oracle.getAddress(),
        s.stabilityModule.getAddress(),
        s.paxg.getAddress(),
      ]);
      try {
        for (const wrong of [oracle, module, token]) await expect(gov.setGovernedContract("vault", wrong)).to.be.revertedWith("Wrong contract");
        for (const wrong of [vault, module, token]) await expect(gov.setGovernedContract("oracle", wrong)).to.be.revertedWith("Wrong contract");
        for (const wrong of [vault, oracle, token]) await expect(gov.setGovernedContract("stabilityModule", wrong)).to.be.revertedWith("Wrong contract");
      } finally {
        await stopImpersonatingAccount(s.timelockAddr);
      }
      expect(await s.governance.vault()).to.equal(vault);
      expect(await s.governance.oracle()).to.equal(oracle);
      expect(await s.governance.stabilityModule()).to.equal(module);
    });

    it("accepts a real replacement of each kind", async function () {
      const s = await loadFixture(productionSystem);
      const gov = await asTimelock(s);
      const [vault, oracle, module] = [await replacementVault(), await replacementOracle(), await replacementStabilityModule()];
      try {
        await expect(gov.setGovernedContract("vault", vault)).to.emit(s.governance, "GovernedContractUpdated").withArgs("vault", vault);
        await expect(gov.setGovernedContract("oracle", oracle)).to.emit(s.governance, "GovernedContractUpdated").withArgs("oracle", oracle);
        await expect(gov.setGovernedContract("stabilityModule", module)).to.emit(s.governance, "GovernedContractUpdated").withArgs("stabilityModule", module);
      } finally {
        await stopImpersonatingAccount(s.timelockAddr);
      }
    });

    it("a code-less target scheduled through the timelock fails at execution and is not recorded as done", async function () {
      const s = await loadFixture(productionSystem);
      const empty = ethers.Wallet.createRandom().address;
      const salt = saltFor(await s.governance.proposalNonce());
      await s.governance.connect(s.proposer).proposeGovernedContractUpdate("vault", empty);
      const data = s.governance.interface.encodeFunctionData("setGovernedContract", ["vault", empty]);
      const target = await s.governance.getAddress();
      const timelock = await ethers.getContractAt("ExpiringTimelockController", s.timelockAddr);
      const id = await timelock.hashOperation(target, 0, data, ethers.ZeroHash, salt);

      await time.increase(MIN_DELAY + 1);
      await expect(s.governance.connect(s.executor).executeProposal(target, data, salt)).to.be.revertedWith("Not a contract");
      expect(await timelock.isOperationDone(id)).to.equal(false);
      expect(await s.governance.vault()).to.equal(await s.vault.getAddress());
    });

    it("after a handover to a real replacement vault, a follow-up proposal changes the parameter on the replacement", async function () {
      const s = await loadFixture(productionSystem);
      const replacement = await ethers.getContractAt("GoldVault", await replacementVault());
      const replacementAddr = await replacement.getAddress();
      await replacement.grantRole(await replacement.GOVERNANCE_ROLE(), s.timelockAddr);
      const target = await s.governance.getAddress();

      // the handover, through the timelock
      let salt = saltFor(await s.governance.proposalNonce());
      await s.governance.connect(s.proposer).proposeGovernedContractUpdate("vault", replacementAddr);
      const handover = s.governance.interface.encodeFunctionData("setGovernedContract", ["vault", replacementAddr]);
      await time.increase(MIN_DELAY + 1);
      await s.governance.connect(s.executor).executeProposal(target, handover, salt);
      expect(await s.governance.vault()).to.equal(replacementAddr);

      // the follow-up helper proposal lands on the replacement and changes it
      const [oldShare, original] = [await replacement.liquidatorIncentiveShare(), await s.vault.liquidatorIncentiveShare()];
      const newShare = 500_000n;
      expect(oldShare).to.not.equal(newShare);
      salt = saltFor(await s.governance.proposalNonce());
      await s.governance.connect(s.proposer).proposeLiquidatorIncentiveShareUpdate(newShare);
      const change = replacement.interface.encodeFunctionData("setLiquidatorIncentiveShare", [newShare]);
      await time.increase(MIN_DELAY + 1);
      await s.governance.connect(s.executor).executeProposal(replacementAddr, change, salt);
      expect(await replacement.liquidatorIncentiveShare()).to.equal(newShare);
      expect(await s.vault.liquidatorIncentiveShare()).to.equal(original);
    });
  });

  describe("the vault's surplus cannot be paid to the vault", function () {
    it("refuses itself as the recipient and leaves the record and the tokens as they were", async function () {
      const s = await loadFixture(productionSystem);
      const [self, token] = [await s.vault.getAddress(), await s.paxg.getAddress()];
      const [recorded, held] = [await s.vault.surplusCollateral(token), await s.paxg.balanceOf(self)];
      await impersonateAccount(s.timelockAddr);
      await setBalance(s.timelockAddr, ethers.parseEther("1"));
      const holder = (await s.vault.hasRole(await s.vault.GOVERNANCE_ROLE(), s.timelockAddr)) ? await ethers.getSigner(s.timelockAddr) : s.deployer;
      try {
        await expect(s.vault.connect(holder).withdrawSurplus(token, self, 0n)).to.be.revertedWith("Self payment");
        await expect(s.vault.connect(holder).withdrawSurplus(token, self, 1n)).to.be.revertedWith("Self payment");
        await expect(s.vault.connect(holder).withdrawSurplus(token, ethers.ZeroAddress, 0n)).to.be.revertedWith("Zero address");
      } finally {
        await stopImpersonatingAccount(s.timelockAddr);
      }
      expect(await s.vault.surplusCollateral(token)).to.equal(recorded);
      expect(await s.paxg.balanceOf(self)).to.equal(held);
    });
  });

  describe("collateral needs at least two decimals", function () {
    async function governor(s: System) {
      if (await s.vault.hasRole(await s.vault.GOVERNANCE_ROLE(), s.deployer.address)) return { signer: s.deployer, done: async () => undefined };
      await impersonateAccount(s.timelockAddr);
      await setBalance(s.timelockAddr, ethers.parseEther("1"));
      return { signer: await ethers.getSigner(s.timelockAddr), done: () => stopImpersonatingAccount(s.timelockAddr) };
    }

    for (const decimals of [0, 1, 19]) {
      it(`the vault refuses to list a token with ${decimals} decimals`, async function () {
        const s = await loadFixture(productionSystem);
        const token = await (await ethers.getContractFactory("MockERC20")).deploy("Odd", "ODD", decimals);
        const g = await governor(s);
        try {
          await expect(
            s.vault.connect(g.signer).addCollateralType(await token.getAddress(), MIN_RATIO, LIQ_RATIO, LIQ_PENALTY, DEBT_CEILING)
          ).to.be.revertedWith("Decimals must be 2 to 18");
        } finally {
          await g.done();
        }
      });
    }

    for (const decimals of [2, 6, 18]) {
      it(`the vault lists a token with ${decimals} decimals`, async function () {
        const s = await loadFixture(productionSystem);
        const token = await (await ethers.getContractFactory("MockERC20")).deploy("Fine", "FINE", decimals);
        const g = await governor(s);
        try {
          await expect(
            s.vault.connect(g.signer).addCollateralType(await token.getAddress(), MIN_RATIO, LIQ_RATIO, LIQ_PENALTY, DEBT_CEILING)
          ).to.emit(s.vault, "CollateralTypeAdded");
        } finally {
          await g.done();
        }
      });
    }

    describe("the silo factory at its smallest cap", function () {
      async function factoryAtMinimumCap() {
        const [admin, vaultRole] = await ethers.getSigners();
        const factory = await (await ethers.getContractFactory("SiloFactory")).deploy(await minimumCap());
        await factory.grantRole(await factory.VAULT_ROLE(), vaultRole.address);
        return { admin, vaultRole, factory };
      }
      async function minimumCap(): Promise<bigint> {
        const probe = await (await ethers.getContractFactory("SiloFactory")).deploy(ethers.parseEther("1"));
        return probe.MIN_SILO_CAP();
      }
      async function tokenFor(decimals: number, holder: string, spender: string) {
        const token = await (await ethers.getContractFactory("MockERC20")).deploy("Odd", "ODD", decimals);
        await token.mint(holder, 10n ** BigInt(decimals) * 10n + 10n);
        await token.connect(await ethers.getSigner(holder)).approve(spender, ethers.MaxUint256);
        return token;
      }

      for (const decimals of [0, 1]) {
        it(`says the cap rounds to zero for a token with ${decimals} decimals, and takes nothing`, async function () {
          const { vaultRole, factory } = await loadFixture(factoryAtMinimumCap);
          const token = await tokenFor(decimals, vaultRole.address, await factory.getAddress());
          const before = await token.balanceOf(vaultRole.address);
          await expect(factory.connect(vaultRole).deposit(await token.getAddress(), 1n)).to.be.revertedWith("Silo cap rounds to zero");
          expect(await token.balanceOf(vaultRole.address)).to.equal(before);
        });
      }

      for (const [decimals, capUnits] of [[2, 1n], [6, 10_000n], [18, 10n ** 16n]] as const) {
        it(`holds ${capUnits} native units a silo for a token with ${decimals} decimals, and a deposit lands`, async function () {
          const { vaultRole, factory } = await loadFixture(factoryAtMinimumCap);
          const token = await tokenFor(decimals, vaultRole.address, await factory.getAddress());
          const tokenAddr = await token.getAddress();
          // two full silos and one unit of a third
          const amount = capUnits * 2n + 1n;
          await factory.connect(vaultRole).deposit(tokenAddr, amount);
          expect(await factory.totalCollateral(tokenAddr)).to.equal(amount);
          expect(await token.balanceOf(await factory.silos(tokenAddr, 0))).to.equal(capUnits);
          expect(await token.balanceOf(await factory.silos(tokenAddr, 1))).to.equal(capUnits);
          expect(await token.balanceOf(await factory.silos(tokenAddr, 2))).to.equal(1n);
        });
      }
    });
  });
});
