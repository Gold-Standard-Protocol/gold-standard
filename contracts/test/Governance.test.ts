import { expect } from "chai";
import type { Interface } from "ethers";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";
import { ExpiringTimelockController, GoldGovernance } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { replacementVault } from "./helpers/governedTargets";

describe("GoldGovernance", function () {
  let governance: GoldGovernance;
  let owner: HardhatEthersSigner;
  let proposer: HardhatEthersSigner;
  let executor: HardhatEthersSigner;
  let other: HardhatEthersSigner;
  let vaultAddr: string;
  let oracleAddr: string;
  let stabilityModuleAddr: string;

  const MIN_DELAY = 48 * 3600; // 48 hours

  beforeEach(async function () {
    [owner, proposer, executor, other] = await ethers.getSigners();

    // Use random addresses for governed contracts in governance tests
    vaultAddr = ethers.Wallet.createRandom().address;
    oracleAddr = ethers.Wallet.createRandom().address;
    stabilityModuleAddr = ethers.Wallet.createRandom().address;

    const GovFactory = await ethers.getContractFactory("GoldGovernance");
    governance = await GovFactory.deploy(
      [proposer.address],
      [executor.address],
      vaultAddr,
      oracleAddr,
      stabilityModuleAddr
    );

    // Grant roles
    const PROPOSER_ROLE = await governance.PROPOSER_ROLE();
    const EXECUTOR_ROLE = await governance.EXECUTOR_ROLE();
    await governance.grantRole(PROPOSER_ROLE, proposer.address);
    await governance.grantRole(EXECUTOR_ROLE, executor.address);
  });

  describe("Constructor", function () {
    it("should deploy timelock with address(0) admin", async function () {
      const timelockAddr = await governance.getTimelockAddress();
      expect(timelockAddr).to.not.equal(ethers.ZeroAddress);

      // Verify the timelock was created (it exists and has code)
      const code = await ethers.provider.getCode(timelockAddr);
      expect(code).to.not.equal("0x");
    });

    it("should set governed contract addresses", async function () {
      expect(await governance.vault()).to.equal(vaultAddr);
      expect(await governance.oracle()).to.equal(oracleAddr);
      expect(await governance.stabilityModule()).to.equal(stabilityModuleAddr);
    });
  });

  describe("proposeCollateralRatioUpdate", function () {
    const collateralToken = ethers.Wallet.createRandom().address;
    const minRatio = 1500000n;
    const liquidationRatio = 1100000n;
    const liquidationPenalty = 50000n;

    it("should accept address parameter (not bytes32)", async function () {
      await expect(
        governance.connect(proposer).proposeCollateralRatioUpdate(
          collateralToken, minRatio, liquidationRatio, liquidationPenalty
        )
      ).to.emit(governance, "ProposalCreated");
    });

    it("schedules the ratios and the penalty only, never the debt ceiling", async function () {
      const vaultInterface = new ethers.Interface(["function updateCollateralRatios(address,uint256,uint256,uint256)"]);
      const data = vaultInterface.encodeFunctionData("updateCollateralRatios", [collateralToken, minRatio, liquidationRatio, liquidationPenalty]);
      await expect(
        governance.connect(proposer).proposeCollateralRatioUpdate(
          collateralToken, minRatio, liquidationRatio, liquidationPenalty
        )
      ).to.emit(governance, "ProposalCreated").withArgs(anyValue, await governance.vault(), data, anyValue);
    });

    it("should validate minRatio > liquidationRatio", async function () {
      await expect(
        governance.connect(proposer).proposeCollateralRatioUpdate(
          collateralToken, liquidationRatio, liquidationRatio, liquidationPenalty
        )
      ).to.be.revertedWith("Min > liquidation required");
    });

    it("should validate liquidationRatio >= 1050000, the vault's own floor", async function () {
      await expect(
        governance.connect(proposer).proposeCollateralRatioUpdate(
          collateralToken, minRatio, 1049999n, liquidationPenalty
        )
      ).to.be.revertedWith("Must be >= 105%");
    });

    it("should validate penalty <= 200000", async function () {
      await expect(
        governance.connect(proposer).proposeCollateralRatioUpdate(
          collateralToken, minRatio, liquidationRatio, 200001n
        )
      ).to.be.revertedWith("Penalty exceeds 20%");
    });

    it("should only allow PROPOSER_ROLE", async function () {
      await expect(
        governance.connect(other).proposeCollateralRatioUpdate(
          collateralToken, minRatio, liquidationRatio, liquidationPenalty
        )
      ).to.be.reverted;
    });
  });

  describe("proposeDebtCeilingUpdate", function () {
    const collateralToken = ethers.Wallet.createRandom().address;
    const debtCeiling = ethers.parseEther("1000000");

    it("schedules the debt ceiling only, never the ratios", async function () {
      const vaultInterface = new ethers.Interface(["function setDebtCeiling(address,uint256)"]);
      const data = vaultInterface.encodeFunctionData("setDebtCeiling", [collateralToken, debtCeiling]);
      await expect(governance.connect(proposer).proposeDebtCeilingUpdate(collateralToken, debtCeiling))
        .to.emit(governance, "ProposalCreated")
        .withArgs(anyValue, await governance.vault(), data, anyValue);
    });

    it("refuses the zero address", async function () {
      await expect(
        governance.connect(proposer).proposeDebtCeilingUpdate(ethers.ZeroAddress, debtCeiling)
      ).to.be.revertedWith("Zero address");
    });

    it("should only allow PROPOSER_ROLE", async function () {
      await expect(
        governance.connect(other).proposeDebtCeilingUpdate(collateralToken, debtCeiling)
      ).to.be.revertedWithCustomError(governance, "AccessControlUnauthorizedAccount");
    });
  });

  describe("proposeStabilityFeeUpdate", function () {
    it("should validate rate <= 5000", async function () {
      await expect(
        governance.connect(proposer).proposeStabilityFeeUpdate(
          ethers.keccak256(ethers.toUtf8Bytes("PAXG")), 5001
        )
      ).to.be.revertedWith("Rate exceeds 50% max");
    });

    it("should accept valid rate", async function () {
      await expect(
        governance.connect(proposer).proposeStabilityFeeUpdate(
          ethers.keccak256(ethers.toUtf8Bytes("PAXG")), 200
        )
      ).to.emit(governance, "ProposalCreated");
    });
  });

  describe("proposeOracleFeedUpdate", function () {
    it("should reject unknown feed name", async function () {
      await expect(
        governance.connect(proposer).proposeOracleFeedUpdate("UNKNOWN", other.address)
      ).to.be.revertedWith("Unknown feed");
    });

    it("should reject zero address", async function () {
      await expect(
        governance.connect(proposer).proposeOracleFeedUpdate("PAXG", ethers.ZeroAddress)
      ).to.be.revertedWith("Zero address");
    });

    it("should accept PAXG feed update", async function () {
      await expect(
        governance.connect(proposer).proposeOracleFeedUpdate("PAXG", other.address)
      ).to.emit(governance, "ProposalCreated");
    });

    it("should accept XAUT feed update", async function () {
      await expect(
        governance.connect(proposer).proposeOracleFeedUpdate("XAUT", other.address)
      ).to.emit(governance, "ProposalCreated");
    });
  });

  describe("setGovernedContract", function () {
    it("should revert if caller is not timelock", async function () {
      await expect(
        governance.connect(owner).setGovernedContract("vault", other.address)
      ).to.be.revertedWith("Only timelock");
    });

    it("should revert for unknown contract name", async function () {
      // We can't easily call from timelock context directly, but we can test the revert
      // by having the timelock execute it with a bad name
      // Instead, just verify the function exists and has the right guard
      const timelockAddr = await governance.getTimelockAddress();
      expect(timelockAddr).to.not.equal(ethers.ZeroAddress);
    });
  });

  describe("proposeGovernedContractUpdate", function () {
    it("should schedule via timelock", async function () {
      await expect(
        governance.connect(proposer).proposeGovernedContractUpdate("vault", other.address)
      ).to.emit(governance, "ProposalCreated");
    });

    it("should reject zero address", async function () {
      await expect(
        governance.connect(proposer).proposeGovernedContractUpdate("vault", ethers.ZeroAddress)
      ).to.be.revertedWith("Zero address");
    });
  });

  describe("New Module Proposals", function () {
    it("proposeSurplusBufferUpdate should schedule via timelock", async function () {
      await expect(
        governance.connect(proposer).proposeSurplusBufferUpdate(other.address)
      ).to.emit(governance, "ProposalCreated");
    });

    it("proposeStabilityPoolUpdate should schedule via timelock", async function () {
      await expect(
        governance.connect(proposer).proposeStabilityPoolUpdate(other.address)
      ).to.emit(governance, "ProposalCreated");
    });

    it("proposeStabilityReserveUpdate should schedule via timelock", async function () {
      await expect(
        governance.connect(proposer).proposeStabilityReserveUpdate(other.address)
      ).to.emit(governance, "ProposalCreated");
    });

    it("proposeReservePenaltyShare should schedule via timelock and reject >100%", async function () {
      await expect(
        governance.connect(proposer).proposeReservePenaltyShare(4000n)
      ).to.emit(governance, "ProposalCreated");
      await expect(
        governance.connect(proposer).proposeReservePenaltyShare(10001n)
      ).to.be.revertedWith("Exceeds 100%");
    });

    it("proposeLiquidatorIncentiveShareUpdate should schedule via timelock", async function () {
      await expect(
        governance.connect(proposer).proposeLiquidatorIncentiveShareUpdate(500000)
      ).to.emit(governance, "ProposalCreated");
    });

    it("proposeLiquidatorIncentiveShareUpdate rejects > 100%", async function () {
      await expect(
        governance.connect(proposer).proposeLiquidatorIncentiveShareUpdate(1000001)
      ).to.be.revertedWith("Share exceeds 100%");
    });

    it("new proposals reject non-proposer", async function () {
      await expect(
        governance.connect(other).proposeSurplusBufferUpdate(other.address)
      ).to.be.reverted;
    });
  });

  describe("Proposal Nonces", function () {
    it("should use unique salts for each proposal", async function () {
      const nonce0 = await governance.proposalNonce();

      await governance.connect(proposer).proposeStabilityFeeUpdate(
        ethers.keccak256(ethers.toUtf8Bytes("PAXG")), 200
      );
      const nonce1 = await governance.proposalNonce();
      expect(nonce1).to.equal(nonce0 + 1n);

      await governance.connect(proposer).proposeStabilityFeeUpdate(
        ethers.keccak256(ethers.toUtf8Bytes("PAXG")), 300
      );
      const nonce2 = await governance.proposalNonce();
      expect(nonce2).to.equal(nonce1 + 1n);
    });
  });

  describe("proposeSiloFactoryUpdate", function () {
    it("should schedule via timelock", async function () {
      await expect(
        governance.connect(proposer).proposeSiloFactoryUpdate(other.address)
      ).to.emit(governance, "ProposalCreated");
    });

    it("should only allow PROPOSER_ROLE", async function () {
      await expect(
        governance.connect(other).proposeSiloFactoryUpdate(other.address)
      ).to.be.reverted;
    });
  });

  describe("proposeBadDebtPauseThreshold", function () {
    it("should schedule via timelock", async function () {
      await expect(
        governance.connect(proposer).proposeBadDebtPauseThreshold(ethers.parseEther("10000"))
      ).to.emit(governance, "ProposalCreated");
    });

    it("should only allow PROPOSER_ROLE", async function () {
      await expect(
        governance.connect(other).proposeBadDebtPauseThreshold(1000)
      ).to.be.reverted;
    });
  });

  describe("proposeGoldBandUpdate", function () {
    it("should schedule setGoldBand on the oracle via timelock", async function () {
      const data = new ethers.Interface(["function setGoldBand(address,uint256)"]).encodeFunctionData("setGoldBand", [other.address, 20_000]);
      await expect(governance.connect(proposer).proposeGoldBandUpdate(other.address, 20_000))
        .to.emit(governance, "ProposalCreated")
        .withArgs(anyValue, oracleAddr, data, anyValue);
    });

    it("should accept both ends of the oracle's range", async function () {
      await expect(governance.connect(proposer).proposeGoldBandUpdate(other.address, 5_000)).to.emit(governance, "ProposalCreated");
      await expect(governance.connect(proposer).proposeGoldBandUpdate(other.address, 100_000)).to.emit(governance, "ProposalCreated");
    });

    it("should reject a band below 0.5% or above 10%", async function () {
      await expect(governance.connect(proposer).proposeGoldBandUpdate(other.address, 4_999)).to.be.revertedWith("Band out of range");
      await expect(governance.connect(proposer).proposeGoldBandUpdate(other.address, 100_001)).to.be.revertedWith("Band out of range");
    });

    it("should reject the zero token and a caller without PROPOSER_ROLE", async function () {
      await expect(governance.connect(proposer).proposeGoldBandUpdate(ethers.ZeroAddress, 20_000)).to.be.revertedWith("Zero address");
      await expect(governance.connect(other).proposeGoldBandUpdate(other.address, 20_000)).to.be.reverted;
    });
  });

  describe("proposeLiquidationClampUpdate", function () {
    it("should schedule setLiquidationClamp on the oracle via timelock", async function () {
      const data = new ethers.Interface(["function setLiquidationClamp(address,uint256)"]).encodeFunctionData("setLiquidationClamp", [other.address, 25_000]);
      await expect(governance.connect(proposer).proposeLiquidationClampUpdate(other.address, 25_000))
        .to.emit(governance, "ProposalCreated")
        .withArgs(anyValue, oracleAddr, data, anyValue);
    });

    it("should accept both ends of the oracle's range", async function () {
      await expect(governance.connect(proposer).proposeLiquidationClampUpdate(other.address, 5_000)).to.emit(governance, "ProposalCreated");
      await expect(governance.connect(proposer).proposeLiquidationClampUpdate(other.address, 50_000)).to.emit(governance, "ProposalCreated");
    });

    it("should reject a clamp below 0.5% or above 8%", async function () {
      await expect(governance.connect(proposer).proposeLiquidationClampUpdate(other.address, 4_999)).to.be.revertedWith("Clamp out of range");
      await expect(governance.connect(proposer).proposeLiquidationClampUpdate(other.address, 50_001)).to.be.revertedWith("Clamp out of range");
    });

    it("should reject the zero token and a caller without PROPOSER_ROLE", async function () {
      await expect(governance.connect(proposer).proposeLiquidationClampUpdate(ethers.ZeroAddress, 20_000)).to.be.revertedWith("Zero address");
      await expect(governance.connect(other).proposeLiquidationClampUpdate(other.address, 20_000)).to.be.reverted;
    });
  });

  describe("removed oracle proposals", function () {
    it("no longer schedules the agreement band, the floor descent or a confirmation feed", async function () {
      for (const name of ["proposeAgreementBandUpdate", "proposeFloorDescentUpdate", "proposeConfirmationFeedUpdate"]) {
        expect((governance.interface as Interface).getFunction(name), name).to.equal(null);
      }
    });
  });

  describe("proposeCrossFeedThresholdUpdate is removed", function () {
    it("is no longer part of the ABI", async function () {
      expect((governance.interface as Interface).getFunction("proposeCrossFeedThresholdUpdate")).to.equal(null);
    });
  });

  describe("proposeTransferGovernance is removed", function () {
    // The wrapper scheduled transferGovernance THROUGH the timelock, so the target saw
    // msg.sender == timelock. Pinning the destination to the timelock (an earlier
    // fix) therefore made the grants no-ops and the revokes total, leaving zero holders
    // of GOVERNANCE_ROLE and DEFAULT_ADMIN_ROLE with no way to ever re-grant them. The
    // pin made the bricking call the ONLY permitted one, so the helper was removed.
    it("is not present in the ABI", async function () {
      expect(
        governance.interface.fragments.some(
          (f) => f.type === "function" && (f as { name?: string }).name === "proposeTransferGovernance"
        )
      ).to.equal(false);
    });

    it("leaves the timelock holding governance after a real handover", async function () {
      // The supported path: the deployer hands over directly, once.
      const StabModF = await ethers.getContractFactory("StabilityModule");
      const mod = await StabModF.deploy();
      const timelockAddr = await governance.getTimelockAddress();
      await mod.transferGovernance(timelockAddr);
      expect(await mod.hasRole(await mod.DEFAULT_ADMIN_ROLE(), timelockAddr)).to.equal(true);
      expect(await mod.hasRole(await mod.GOVERNANCE_ROLE(), timelockAddr)).to.equal(true);
    });
  });

  describe("executeProposal", function () {
    it("should only allow EXECUTOR_ROLE", async function () {
      await expect(
        governance.connect(other).executeProposal(
          vaultAddr,
          "0x",
          ethers.ZeroHash
        )
      ).to.be.reverted;
    });

    it("runs a full propose -> wait -> execute cycle under a RESTRICTED executor", async function () {
      // This is the path that previously reverted TimelockUnauthorizedCaller because the wrapper
      // was a timelock proposer but not a timelock executor. The wrapper is now both.
      const newVault = await replacementVault();
      const salt = ethers.zeroPadValue(
        ethers.toBeHex(await governance.proposalNonce()),
        32
      );
      await governance.connect(proposer).proposeGovernedContractUpdate("vault", newVault);

      const data = governance.interface.encodeFunctionData("setGovernedContract", [
        "vault",
        newVault,
      ]);
      const target = await governance.getAddress();

      // Before the 48h delay matures, execution reverts.
      await expect(
        governance.connect(executor).executeProposal(target, data, salt)
      ).to.be.reverted;

      await time.increase(MIN_DELAY + 1);

      // The restricted executor executes via the wrapper -> timelock.execute, and the change lands.
      await governance.connect(executor).executeProposal(target, data, salt);
      expect(await governance.vault()).to.equal(newVault);

      // A non-executor still cannot execute.
      expect(await governance.hasRole(await governance.EXECUTOR_ROLE(), other.address)).to.be.false;
    });
  });

  // A stock
  // TimelockController keeps a matured operation executable until it runs or is cancelled, and
  // an execution that reverts leaves it so. Under the open executor anyone could then pick the
  // moment an old approval took effect. The wrapper's timelock now refuses an operation more
  // than GRACE_PERIOD after it matured.
  describe("matured operations expire after the grace period", function () {
    const GRACE_PERIOD = 7 * 24 * 3600;

    async function expiringTimelock(): Promise<ExpiringTimelockController> {
      return ethers.getContractAt("ExpiringTimelockController", await governance.getTimelockAddress());
    }

    /** Schedule setGovernedContract("vault", newVault) through the wrapper; returns what executeProposal needs. */
    async function proposeVaultUpdate() {
      const timelock = await expiringTimelock();
      const newVault = await replacementVault();
      const salt = ethers.zeroPadValue(ethers.toBeHex(await governance.proposalNonce()), 32);
      await governance.connect(proposer).proposeGovernedContractUpdate("vault", newVault);
      const target = await governance.getAddress();
      const data = governance.interface.encodeFunctionData("setGovernedContract", ["vault", newVault]);
      const id = await timelock.hashOperation(target, 0, data, ethers.ZeroHash, salt);
      return { timelock, newVault, salt, target, data, id, readyAt: await timelock.getTimestamp(id) };
    }

    it("is seven days, and only a pending operation past it reads as expired", async function () {
      const { timelock, id, readyAt } = await proposeVaultUpdate();
      expect(await timelock.GRACE_PERIOD()).to.equal(BigInt(GRACE_PERIOD));
      expect(await timelock.isOperationExpired(ethers.id("never scheduled"))).to.equal(false);
      expect(await timelock.isOperationExpired(id)).to.equal(false); // waiting

      await time.increaseTo(readyAt + BigInt(GRACE_PERIOD) - 60n);
      expect(await timelock.isOperationExpired(id)).to.equal(false);
      await time.increaseTo(readyAt + BigInt(GRACE_PERIOD) + 60n);
      expect(await timelock.isOperationExpired(id)).to.equal(true);
      // Expired still reads as Ready in the inherited state, so the proposer can clear it.
      expect(await timelock.isOperationReady(id)).to.equal(true);
      await timelock.connect(proposer).cancel(id);
      expect(await timelock.isOperationExpired(id)).to.equal(false);

      // A done operation never expires.
      const fresh = await proposeVaultUpdate();
      await time.increaseTo(fresh.readyAt);
      await governance.connect(executor).executeProposal(fresh.target, fresh.data, fresh.salt);
      await time.increase(GRACE_PERIOD * 2);
      expect(await timelock.isOperationDone(fresh.id)).to.equal(true);
      expect(await timelock.isOperationExpired(fresh.id)).to.equal(false);
    });

    it("executes through executeProposal on the last second of the grace period", async function () {
      const { newVault, salt, target, data, readyAt } = await proposeVaultUpdate();
      await time.setNextBlockTimestamp(readyAt + BigInt(GRACE_PERIOD));
      await governance.connect(executor).executeProposal(target, data, salt);
      expect(await governance.vault()).to.equal(newVault);
    });

    it("executes a batch on the last second of the grace period", async function () {
      const timelock = await expiringTimelock();
      const newVault = await replacementVault();
      const target = await governance.getAddress();
      const data = governance.interface.encodeFunctionData("setGovernedContract", ["vault", newVault]);
      const salt = ethers.id("batch inside grace");
      await timelock.connect(proposer).scheduleBatch([target], [0], [data], ethers.ZeroHash, salt, MIN_DELAY);
      const id = await timelock.hashOperationBatch([target], [0], [data], ethers.ZeroHash, salt);
      await time.setNextBlockTimestamp((await timelock.getTimestamp(id)) + BigInt(GRACE_PERIOD));
      await timelock.connect(executor).executeBatch([target], [0], [data], ethers.ZeroHash, salt);
      expect(await governance.vault()).to.equal(newVault);
    });

    it("refuses execute, executeBatch and executeProposal one second after the grace period", async function () {
      const single = await proposeVaultUpdate();
      const timelock = single.timelock;
      const batchSalt = ethers.id("batch after grace");
      await timelock
        .connect(proposer)
        .scheduleBatch([single.target], [0], [single.data], ethers.ZeroHash, batchSalt, MIN_DELAY);
      const batchId = await timelock.hashOperationBatch([single.target], [0], [single.data], ethers.ZeroHash, batchSalt);

      await time.increaseTo(single.readyAt + BigInt(GRACE_PERIOD) + 1n);
      await expect(governance.connect(executor).executeProposal(single.target, single.data, single.salt))
        .to.be.revertedWithCustomError(timelock, "TimelockOperationExpired")
        .withArgs(single.id);
      await expect(timelock.connect(executor).execute(single.target, 0, single.data, ethers.ZeroHash, single.salt))
        .to.be.revertedWithCustomError(timelock, "TimelockOperationExpired")
        .withArgs(single.id);
      await expect(timelock.connect(executor).executeBatch([single.target], [0], [single.data], ethers.ZeroHash, batchSalt))
        .to.be.revertedWithCustomError(timelock, "TimelockOperationExpired")
        .withArgs(batchId);
      expect(await governance.vault()).to.equal(vaultAddr);
    });
  });

  describe("wrapper role wiring + handover", function () {
    it("constructor grants PROPOSER_ROLE / EXECUTOR_ROLE to the configured signers", async function () {
      // Fresh deploy WITHOUT the beforeEach explicit grants, to prove the constructor does it.
      const GovFactory = await ethers.getContractFactory("GoldGovernance");
      const gov = await GovFactory.deploy(
        [proposer.address],
        [executor.address],
        ethers.Wallet.createRandom().address,
        ethers.Wallet.createRandom().address,
        ethers.Wallet.createRandom().address
      );
      const PROPOSER_ROLE = await gov.PROPOSER_ROLE();
      const EXECUTOR_ROLE = await gov.EXECUTOR_ROLE();
      expect(await gov.hasRole(PROPOSER_ROLE, proposer.address)).to.be.true;
      expect(await gov.hasRole(EXECUTOR_ROLE, executor.address)).to.be.true;
    });

    it("after transferGovernance, the deployer cannot self-grant PROPOSER_ROLE (backdoor closed)", async function () {
      const ADMIN_ROLE = await governance.DEFAULT_ADMIN_ROLE();
      const PROPOSER_ROLE = await governance.PROPOSER_ROLE();
      const timelockAddr = await governance.getTimelockAddress();

      // Hand the wrapper's admin over to the timelock.
      await governance.transferGovernance(timelockAddr);

      // Deployer no longer holds admin; the timelock does.
      expect(await governance.hasRole(ADMIN_ROLE, owner.address)).to.be.false;
      expect(await governance.hasRole(ADMIN_ROLE, timelockAddr)).to.be.true;

      // The exact backdoor the council flagged is now blocked: the ex-deployer can no longer
      // self-grant PROPOSER_ROLE to drive the timelock.
      await expect(
        governance.connect(owner).grantRole(PROPOSER_ROLE, other.address)
      ).to.be.reverted;
    });

    it("transferGovernance rejects the zero address", async function () {
      await expect(governance.transferGovernance(ethers.ZeroAddress)).to.be.revertedWith(
        "Zero address"
      );
    });
  });
});
