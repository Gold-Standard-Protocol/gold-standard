import { expect } from "chai";
import { ethers } from "hardhat";
import {
  loadFixture,
  time,
  impersonateAccount,
  stopImpersonatingAccount,
  setBalance,
} from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { productionSystem } from "./helpers/productionSystem";
import { replacementOracle, replacementStabilityModule, replacementVault } from "./helpers/governedTargets";

/**
 * Branch coverage for GoldGovernance: the handover guards, every PROPOSER_ROLE gate,
 * both arms of the executor check (restricted and open executor) and each name branch
 * of setGovernedContract as called by the timelock itself.
 */

type System = Awaited<ReturnType<typeof productionSystem>>;

const MIN_DELAY = 48 * 3600;
const PRECISION = 10n ** 18n;
const SECONDS_PER_YEAR = 365n * 86400n;

function saltFor(nonce: bigint): string {
  return ethers.zeroPadValue(ethers.toBeHex(nonce), 32);
}

describe("GoldGovernance branch coverage", function () {
  describe("transferGovernance", function () {
    it("reverts for a caller without DEFAULT_ADMIN_ROLE", async function () {
      const s = await loadFixture(productionSystem);
      await expect(
        s.governance.connect(s.alice).transferGovernance(s.timelockAddr)
      ).to.be.revertedWithCustomError(s.governance, "AccessControlUnauthorizedAccount");
    });

    it("reverts on the zero address", async function () {
      const s = await loadFixture(productionSystem);
      await expect(s.governance.transferGovernance(ethers.ZeroAddress)).to.be.revertedWith("Zero address");
    });

    it("reverts when the admin would hand over to itself", async function () {
      const s = await loadFixture(productionSystem);
      await expect(s.governance.transferGovernance(s.deployer.address)).to.be.revertedWith("Would self-revoke");
    });

    it("reverts when the destination is not a contract", async function () {
      const s = await loadFixture(productionSystem);
      await expect(s.governance.transferGovernance(s.alice.address)).to.be.revertedWith("Timelock must be a contract");
    });

    it("hands admin of the wrapper to the timelock and strips the deployer", async function () {
      const s = await loadFixture(productionSystem);
      const ADMIN = await s.governance.DEFAULT_ADMIN_ROLE();
      await s.governance.transferGovernance(s.timelockAddr);
      expect(await s.governance.hasRole(ADMIN, s.timelockAddr)).to.equal(true);
      expect(await s.governance.hasRole(ADMIN, s.deployer.address)).to.equal(false);
    });
  });

  describe("PROPOSER_ROLE gates", function () {
    const proposals: Array<[string, (s: System, target: string) => Promise<unknown>]> = [
      [
        "proposeCollateralRatioUpdate",
        (s, target) => s.governance.connect(s.alice).proposeCollateralRatioUpdate(target, 1_500_000n, 1_100_000n, 50_000n),
      ],
      ["proposeDebtCeilingUpdate", (s, target) => s.governance.connect(s.alice).proposeDebtCeilingUpdate(target, 1n)],
      ["proposeStabilityFeeUpdate", (s) => s.governance.connect(s.alice).proposeStabilityFeeUpdate(s.paxgId, 100n)],
      ["proposeSurplusBufferUpdate", (s, target) => s.governance.connect(s.alice).proposeSurplusBufferUpdate(target)],
      ["proposeStabilityPoolUpdate", (s, target) => s.governance.connect(s.alice).proposeStabilityPoolUpdate(target)],
      ["proposeStabilityReserveUpdate", (s, target) => s.governance.connect(s.alice).proposeStabilityReserveUpdate(target)],
      ["proposeReservePenaltyShare", (s) => s.governance.connect(s.alice).proposeReservePenaltyShare(4000n)],
      [
        "proposeLiquidatorIncentiveShareUpdate",
        (s) => s.governance.connect(s.alice).proposeLiquidatorIncentiveShareUpdate(500_000n),
      ],
      ["proposeOracleFeedUpdate", (s, target) => s.governance.connect(s.alice).proposeOracleFeedUpdate("PAXG", target)],
      [
        "proposeGovernedContractUpdate",
        (s, target) => s.governance.connect(s.alice).proposeGovernedContractUpdate("vault", target),
      ],
      ["proposeSiloFactoryUpdate", (s, target) => s.governance.connect(s.alice).proposeSiloFactoryUpdate(target)],
      ["proposeVaultRegistryUpdate", (s, target) => s.governance.connect(s.alice).proposeVaultRegistryUpdate(target)],
      ["proposeMinDebtUpdate", (s) => s.governance.connect(s.alice).proposeMinDebtUpdate(ethers.parseEther("500"))],
      ["proposeUnderwaterDiscountUpdate", (s) => s.governance.connect(s.alice).proposeUnderwaterDiscountUpdate(10_000n)],
      ["proposeBadDebtPauseThreshold", (s) => s.governance.connect(s.alice).proposeBadDebtPauseThreshold(1n)],
      ["proposeGoldBandUpdate", (s, target) => s.governance.connect(s.alice).proposeGoldBandUpdate(target, 20_000n)],
      ["proposeLiquidationClampUpdate", (s, target) => s.governance.connect(s.alice).proposeLiquidationClampUpdate(target, 20_000n)],
    ];

    for (const [name, call] of proposals) {
      it(`${name} reverts for a caller without PROPOSER_ROLE`, async function () {
        const s = await loadFixture(productionSystem);
        await expect(call(s, s.bob.address)).to.be.revertedWithCustomError(
          s.governance,
          "AccessControlUnauthorizedAccount"
        );
      });
    }
  });

  describe("executeProposal", function () {
    it("reverts for a stranger while the executor set is restricted, before and after maturity", async function () {
      const s = await loadFixture(productionSystem);
      const target = await s.stabilityModule.getAddress();
      const salt = saltFor(await s.governance.proposalNonce());
      await s.governance.connect(s.proposer).proposeStabilityFeeUpdate(s.paxgId, 300n);
      const data = s.stabilityModule.interface.encodeFunctionData("setStabilityFee", [s.paxgId, 300n]);

      expect(await s.governance.hasRole(await s.governance.EXECUTOR_ROLE(), ethers.ZeroAddress)).to.equal(false);
      await expect(s.governance.connect(s.alice).executeProposal(target, data, salt)).to.be.revertedWith("Not executor");
      await time.increase(MIN_DELAY + 1);
      await expect(s.governance.connect(s.alice).executeProposal(target, data, salt)).to.be.revertedWith("Not executor");
    });

    it("lets the restricted executor land a matured stability fee change", async function () {
      const s = await loadFixture(productionSystem);
      // The fixture leaves GOVERNANCE_ROLE with the deployer; the timelock needs it to apply the change.
      await s.stabilityModule.grantRole(await s.stabilityModule.GOVERNANCE_ROLE(), s.timelockAddr);
      const target = await s.stabilityModule.getAddress();
      const salt = saltFor(await s.governance.proposalNonce());
      await s.governance.connect(s.proposer).proposeStabilityFeeUpdate(s.paxgId, 300n);
      const data = s.stabilityModule.interface.encodeFunctionData("setStabilityFee", [s.paxgId, 300n]);

      await time.increase(MIN_DELAY + 1);
      await s.governance.connect(s.executor).executeProposal(target, data, salt);

      const expected = PRECISION + (300n * PRECISION) / (10000n * SECONDS_PER_YEAR);
      expect(await s.stabilityModule.stabilityFeeRate(s.paxgId)).to.equal(expected);
    });

    it("lets anyone execute once EXECUTOR_ROLE is held by the zero address (open executor)", async function () {
      const s = await loadFixture(productionSystem);
      const GovF = await ethers.getContractFactory("GoldGovernance");
      const openGov = await GovF.deploy(
        [s.proposer.address],
        [ethers.ZeroAddress],
        await s.vault.getAddress(),
        await s.oracle.getAddress(),
        await s.stabilityModule.getAddress()
      );
      const EXECUTOR_ROLE = await openGov.EXECUTOR_ROLE();
      expect(await openGov.hasRole(EXECUTOR_ROLE, ethers.ZeroAddress)).to.equal(true);
      expect(await openGov.hasRole(EXECUTOR_ROLE, s.alice.address)).to.equal(false);

      const replacement = await replacementOracle();
      const salt = saltFor(await openGov.proposalNonce());
      await openGov.connect(s.proposer).proposeGovernedContractUpdate("oracle", replacement);
      const data = openGov.interface.encodeFunctionData("setGovernedContract", ["oracle", replacement]);
      const target = await openGov.getAddress();

      await time.increase(MIN_DELAY + 1);
      await expect(openGov.connect(s.alice).executeProposal(target, data, salt))
        .to.emit(openGov, "GovernedContractUpdated")
        .withArgs("oracle", replacement);
      expect(await openGov.oracle()).to.equal(replacement);
    });

    it("the restricted executor can repoint the stability module through the timelock", async function () {
      const s = await loadFixture(productionSystem);
      const replacement = await replacementStabilityModule();
      const salt = saltFor(await s.governance.proposalNonce());
      await s.governance.connect(s.proposer).proposeGovernedContractUpdate("stabilityModule", replacement);
      const data = s.governance.interface.encodeFunctionData("setGovernedContract", ["stabilityModule", replacement]);
      const target = await s.governance.getAddress();

      await time.increase(MIN_DELAY + 1);
      await expect(s.governance.connect(s.executor).executeProposal(target, data, salt))
        .to.emit(s.governance, "GovernedContractUpdated")
        .withArgs("stabilityModule", replacement);
      expect(await s.governance.stabilityModule()).to.equal(replacement);
    });
  });

  describe("setGovernedContract", function () {
    it("reverts for any caller other than the timelock", async function () {
      const s = await loadFixture(productionSystem);
      await expect(
        s.governance.setGovernedContract("vault", s.alice.address)
      ).to.be.revertedWith("Only timelock");
      await expect(
        s.governance.connect(s.proposer).setGovernedContract("vault", s.alice.address)
      ).to.be.revertedWith("Only timelock");
    });

    describe("called by the timelock", function () {
      async function asTimelock(s: System) {
        await impersonateAccount(s.timelockAddr);
        await setBalance(s.timelockAddr, ethers.parseEther("1"));
        const timelock = await ethers.getSigner(s.timelockAddr);
        return s.governance.connect(timelock);
      }

      it("reverts on the zero address", async function () {
        const s = await loadFixture(productionSystem);
        const gov = await asTimelock(s);
        try {
          await expect(gov.setGovernedContract("vault", ethers.ZeroAddress)).to.be.revertedWith("Zero address");
        } finally {
          await stopImpersonatingAccount(s.timelockAddr);
        }
      });

      it("repoints the vault", async function () {
        const s = await loadFixture(productionSystem);
        const gov = await asTimelock(s);
        const replacement = await replacementVault();
        try {
          await expect(gov.setGovernedContract("vault", replacement))
            .to.emit(s.governance, "GovernedContractUpdated")
            .withArgs("vault", replacement);
          expect(await s.governance.vault()).to.equal(replacement);
          expect(await s.governance.oracle()).to.equal(await s.oracle.getAddress());
        } finally {
          await stopImpersonatingAccount(s.timelockAddr);
        }
      });

      it("repoints the oracle", async function () {
        const s = await loadFixture(productionSystem);
        const gov = await asTimelock(s);
        const replacement = await replacementOracle();
        try {
          await expect(gov.setGovernedContract("oracle", replacement))
            .to.emit(s.governance, "GovernedContractUpdated")
            .withArgs("oracle", replacement);
          expect(await s.governance.oracle()).to.equal(replacement);
          expect(await s.governance.vault()).to.equal(await s.vault.getAddress());
        } finally {
          await stopImpersonatingAccount(s.timelockAddr);
        }
      });

      it("repoints the stability module", async function () {
        const s = await loadFixture(productionSystem);
        const gov = await asTimelock(s);
        const replacement = await replacementStabilityModule();
        try {
          await expect(gov.setGovernedContract("stabilityModule", replacement))
            .to.emit(s.governance, "GovernedContractUpdated")
            .withArgs("stabilityModule", replacement);
          expect(await s.governance.stabilityModule()).to.equal(replacement);
          expect(await s.governance.vault()).to.equal(await s.vault.getAddress());
        } finally {
          await stopImpersonatingAccount(s.timelockAddr);
        }
      });

      it("reverts on a name it does not govern", async function () {
        const s = await loadFixture(productionSystem);
        const gov = await asTimelock(s);
        try {
          await expect(gov.setGovernedContract("treasury", s.alice.address)).to.be.revertedWith("Unknown contract");
        } finally {
          await stopImpersonatingAccount(s.timelockAddr);
        }
      });
    });
  });
});
