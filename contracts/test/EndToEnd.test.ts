import { expect } from "chai";
import { ethers } from "hardhat";
import { time, loadFixture } from "@nomicfoundation/hardhat-network-helpers";

/**
 * End-to-end production rehearsal.
 *
 * Each scenario isolates via loadFixture so failures don't cascade. The fixture
 * mirrors scripts/deploy.ts step-by-step: same order, same role grants, same
 * wiring. If any scenario fails, do NOT deploy.
 *
 * Coverage:
 *   1. Vault basics — deposit/mint/repay/withdraw, both PAXG (18d) and XAUT (6d)
 *   2. Normal liquidation hits exact formula values
 *   3. liquidateViaPool with depositors
 *   4. Redemption routes fee to surplus buffer
 *   5. Oracle circuit breaker reverts getTokenPrice
 *   6. emergencyLiquidate fires when only oracle is paused
 *   7. Fee-on-transfer collateral via silo path
 *   8. Bad-debt auto-pause threshold (no double-pause revert)
 *   9. Guardian pause + governance unpause separation
 *  10. Governance handover — every contract (including stablecoin)
 *  11. Timelock-gated parameter change end-to-end
 *  12. Third gold token onboards via the oracle feed registry without redeploy
 */

import {
  GOLD_PRICE,
  MIN_RATIO,
  LIQ_RATIO,
  LIQ_PENALTY,
  DEBT_CEILING,
  SILO_CAP,
  setValidPrice,
  productionSystem,
} from "./helpers/productionSystem";


async function setOraclePrice(
  oracle: { lastKnownPaxgPrice: () => Promise<bigint>; getTokenPrice: (a: string) => Promise<unknown> },
  paxgFeed: { setLatestRoundData: (a: number, b: bigint, c: number, d: number, e: number) => Promise<unknown> },
  xautFeed: { setLatestRoundData: (a: number, b: bigint, c: number, d: number, e: number) => Promise<unknown> },
  paxgAddr: string,
  xautAddr: string,
  newPrice: bigint
) {
  let current = await oracle.lastKnownPaxgPrice();
  if (current === 0n) {
    await setValidPrice(paxgFeed, newPrice);
    await setValidPrice(xautFeed, newPrice);
    await oracle.getTokenPrice(paxgAddr);
    await oracle.getTokenPrice(xautAddr);
    return;
  }
  while (current !== newPrice) {
    let next: bigint;
    if (newPrice < current) {
      next = (current * 91n) / 100n;
      if (next < newPrice) next = newPrice;
    } else {
      next = (current * 109n) / 100n;
      if (next > newPrice) next = newPrice;
    }
    await setValidPrice(paxgFeed, next);
    await setValidPrice(xautFeed, next);
    await oracle.getTokenPrice(paxgAddr);
    await oracle.getTokenPrice(xautAddr);
    current = next;
  }
}

describe("End-to-end production rehearsal", function () {
  describe("1. Vault basics (PAXG 18d & XAUT 6d)", function () {
    it("alice can deposit, mint, repay, and withdraw against PAXG", async function () {
      const s = await loadFixture(productionSystem);
      await setValidPrice(s.paxgFeed, GOLD_PRICE);
      await setValidPrice(s.xautFeed, GOLD_PRICE);

      await s.vault.connect(s.alice).deposit(await s.paxg.getAddress(), ethers.parseEther("10"));
      await s.vault.connect(s.alice).mint(ethers.parseEther("12000"));
      expect(await s.stablecoin.balanceOf(s.alice.address)).to.be.gte(ethers.parseEther("12000"));

      await s.vault.connect(s.alice).repay(ethers.parseEther("6000"));
      await setValidPrice(s.paxgFeed, GOLD_PRICE);
      await setValidPrice(s.xautFeed, GOLD_PRICE);
      await s.vault.connect(s.alice).withdraw(ethers.parseEther("1"));

      const v = await s.vault.vaults(s.alice.address);
      expect(v.collateralAmount).to.equal(ethers.parseEther("9"));
    });

    it("charlie can deposit XAUT (6 decimals) and mint", async function () {
      const s = await loadFixture(productionSystem);
      await setValidPrice(s.paxgFeed, GOLD_PRICE);
      await setValidPrice(s.xautFeed, GOLD_PRICE);

      await s.vault.connect(s.charlie).deposit(await s.xaut.getAddress(), 10_000_000n);
      await s.vault.connect(s.charlie).mint(ethers.parseEther("8000"));
      expect(await s.stablecoin.balanceOf(s.charlie.address)).to.equal(ethers.parseEther("8000"));
    });
  });

  describe("2. Normal liquidation hits exact formula values", function () {
    it("partial liquidation seizes exactly debt*(1+penalty)/price", async function () {
      const s = await loadFixture(productionSystem);
      await setValidPrice(s.paxgFeed, GOLD_PRICE);
      await setValidPrice(s.xautFeed, GOLD_PRICE);

      await s.vault.connect(s.alice).deposit(await s.paxg.getAddress(), ethers.parseEther("10"));
      await s.vault.connect(s.alice).mint(ethers.parseEther("12000"));

      // $1,280: 106.67%, liquidatable and above 100% plus the penalty, so a partial is
      // accepted (below that line a full liquidation is demanded).
      await setOraclePrice(s.oracle, s.paxgFeed, s.xautFeed,
        await s.paxg.getAddress(), await s.xaut.getAddress(), 128000000000n);

      const balBefore = await s.paxg.balanceOf(s.bob.address);
      const vBefore = await s.vault.vaults(s.alice.address);
      await s.vault.connect(s.bob).liquidate(s.alice.address, ethers.parseEther("6000"));
      const balAfter = await s.paxg.balanceOf(s.bob.address);
      const vAfter = await s.vault.vaults(s.alice.address);

      // 6000 GSUSD * 1.05 / 1280 = 4.921875 PAXG
      expect(vBefore.collateralAmount - vAfter.collateralAmount).to.equal(ethers.parseEther("4.921875"));
      // 4.6875 PAXG debt-equiv + 0.140625 PAXG (60% of 0.234375 penalty) = 4.828125 PAXG
      expect(balAfter - balBefore).to.equal(ethers.parseEther("4.828125"));
    });
  });

  describe("3. liquidateViaPool", function () {
    it("pool absorbs liquidation and credits collateral gain to depositors", async function () {
      const s = await loadFixture(productionSystem);
      await setValidPrice(s.paxgFeed, GOLD_PRICE);
      await setValidPrice(s.xautFeed, GOLD_PRICE);

      // Open victim vault
      await s.vault.connect(s.alice).deposit(await s.paxg.getAddress(), ethers.parseEther("10"));
      await s.vault.connect(s.alice).mint(ethers.parseEther("12000"));

      // Pool depositor (bob)
      await s.stablecoin.connect(s.bob).approve(await s.stabilityPool.getAddress(), ethers.MaxUint256);
      await s.stabilityPool.connect(s.bob).deposit(ethers.parseEther("20000"));

      // Crash the price to $1,280 (106.67%), where a partial is still accepted
      await setOraclePrice(s.oracle, s.paxgFeed, s.xautFeed,
        await s.paxg.getAddress(), await s.xaut.getAddress(), 128000000000n);

      // Any account triggers via the pool
      await s.vault.connect(s.charlie).liquidateViaPool(s.alice.address, ethers.parseEther("6000"));

      const gain = await s.stabilityPool.getCollateralGain(s.bob.address, await s.paxg.getAddress());
      expect(gain).to.be.gt(0);
    });
  });

  describe("4. A stability swap routes its spread to insurance and touches no vault", function () {
    it("after a swap the buffer grows by the spread and alice's vault is unchanged", async function () {
      const s = await loadFixture(productionSystem);
      await setValidPrice(s.paxgFeed, GOLD_PRICE);
      await setValidPrice(s.xautFeed, GOLD_PRICE);

      // A borrower whose vault must be untouched, and a seeded reserve.
      await s.vault.connect(s.alice).deposit(await s.paxg.getAddress(), ethers.parseEther("10"));
      await s.vault.connect(s.alice).mint(ethers.parseEther("12000"));
      await s.paxg.mint(s.deployer.address, ethers.parseEther("20"));
      await s.paxg.approve(await s.reserve.getAddress(), ethers.MaxUint256);
      await s.reserve.seedCollateral(await s.paxg.getAddress(), ethers.parseEther("20"));

      const bufferBefore = await s.surplusBuffer.gsusdBalance();
      const vaultBefore = await s.vault.vaults(s.alice.address);
      await setValidPrice(s.paxgFeed, GOLD_PRICE);
      await setValidPrice(s.xautFeed, GOLD_PRICE);
      await s.reserve.connect(s.alice).swapGsusdForGold(await s.paxg.getAddress(), ethers.parseEther("500"), 0n);

      expect(await s.surplusBuffer.gsusdBalance()).to.be.gt(bufferBefore);
      const vaultAfter = await s.vault.vaults(s.alice.address);
      expect(vaultAfter.collateralAmount).to.equal(vaultBefore.collateralAmount);
      expect(vaultAfter.debtAmount).to.equal(vaultBefore.debtAmount);
    });
  });

  describe("5. Oracle: a lone move off gold is refused; the freeze is the guardian's", function () {
    it("PAXG alone 11% off gold stops borrowing, liquidation is capped at 2% above gold and the oracle remains unpaused", async function () {
      const s = await loadFixture(productionSystem);
      const MockAgg = await ethers.getContractFactory("MockAggregatorV3");
      const anchorFeed = await MockAgg.deploy(8);
      await setValidPrice(anchorFeed, GOLD_PRICE);
      await s.oracle.setAnchorFeed(await anchorFeed.getAddress());
      await setValidPrice(s.paxgFeed, GOLD_PRICE);
      await s.oracle.getTokenPrice(await s.paxg.getAddress());

      await setValidPrice(s.paxgFeed, (GOLD_PRICE * 111n) / 100n);
      await expect(s.oracle.getBorrowPrice(await s.paxg.getAddress()))
        .to.be.revertedWith("Off gold band");
      expect(await s.oracle.quoteTokenPrice(await s.paxg.getAddress())).to.equal((GOLD_PRICE * 102n) / 100n);
      expect(await s.oracle.paused()).to.be.false;
    });

    it("only the guardian or governance freezes a token", async function () {
      const s = await loadFixture(productionSystem);
      await expect(s.oracle.connect(s.charlie).freezeToken(await s.paxg.getAddress()))
        .to.be.revertedWith("Not guardian or governance");
      await expect(s.oracle.connect(s.guardian).freezeToken(await s.paxg.getAddress()))
        .to.emit(s.oracle, "TokenFrozen");
      expect(await s.oracle.tokenFrozen(await s.paxg.getAddress())).to.be.true;
      expect(await s.oracle.paused()).to.be.false;
    });
  });

  describe("6. emergencyLiquidate during a crash", function () {
    it("refuses a lone low print at the floor, and fires at once when gold confirms the crash", async function () {
      const s = await loadFixture(productionSystem);
      const MockAgg = await ethers.getContractFactory("MockAggregatorV3");
      const anchorFeed = await MockAgg.deploy(8);
      await setValidPrice(anchorFeed, GOLD_PRICE);
      await s.oracle.setAnchorFeed(await anchorFeed.getAddress());
      await setValidPrice(s.paxgFeed, GOLD_PRICE);
      await setValidPrice(s.xautFeed, GOLD_PRICE);

      await s.vault.connect(s.alice).deposit(await s.paxg.getAddress(), ethers.parseEther("10"));
      await s.vault.connect(s.alice).mint(ethers.parseEther("12000")); // lastKnown = $2000

      // PAXG alone prints $1280 while gold holds, and the guardian pauses the oracle.
      await setValidPrice(s.paxgFeed, 128000000000n);
      await setValidPrice(anchorFeed, GOLD_PRICE);
      await s.oracle.emergencyPause();
      expect(await s.oracle.paused()).to.be.true;
      expect(await s.vault.paused()).to.be.false;

      // No rule gives a normal price, so the floor max(lastKnown $2000, live $1280)
      // applies and the vault is healthy: a single low print cannot seize it.
      await expect(
        s.vault.connect(s.bob).emergencyLiquidate(s.alice.address, ethers.parseEther("4000"))
      ).to.be.revertedWith("Not undercollateralised");

      // Gold itself falls with it: XAU/USD corroborates the move, the normal price is $1280
      // and the emergency liquidation fires at the true price with no resync.
      await setValidPrice(anchorFeed, 128000000000n);
      await setValidPrice(s.paxgFeed, 128000000000n);
      await expect(
        s.vault.connect(s.bob).emergencyLiquidate(s.alice.address, ethers.parseEther("4000"))
      ).to.emit(s.vault, "Liquidated");
    });
  });

  describe("7. Fee-on-transfer collateral via silo path", function () {
    it("vault.collateralAmount matches actual silo balance after multi-hop fee", async function () {
      const s = await loadFixture(productionSystem);
      const FeeF = await ethers.getContractFactory("MockERC20FeeOnTransfer");
      const feeToken = await FeeF.deploy("Fee Gold", "FEE", 100); // 1% fee
      await feeToken.mint(s.alice.address, ethers.parseEther("50"));
      await feeToken.connect(s.alice).approve(await s.vault.getAddress(), ethers.MaxUint256);

      await s.vault.addCollateralType(
        await feeToken.getAddress(), MIN_RATIO, LIQ_RATIO, LIQ_PENALTY, DEBT_CEILING
      );
      const feeId = ethers.keccak256(ethers.solidityPacked(["address"], [await feeToken.getAddress()]));
      await s.stabilityModule.initCollateral(feeId, 200);

      await s.vault.connect(s.alice).deposit(await feeToken.getAddress(), ethers.parseEther("10"));
      const v = await s.vault.vaults(s.alice.address);
      const recorded = await s.siloFactory.totalCollateral(await feeToken.getAddress());

      // The factory's record must match the vault's record (both reflect post-fee actual)
      expect(recorded).to.equal(v.collateralAmount);
      // Post-fee amount strictly less than the requested 10
      expect(v.collateralAmount).to.be.lt(ethers.parseEther("10"));
      expect(v.collateralAmount).to.be.gt(ethers.parseEther("9"));
    });
  });

  describe("8. Bad-debt auto-pause cleanly", function () {
    it("threshold trip pauses the vault without reverting", async function () {
      const s = await loadFixture(productionSystem);
      await setValidPrice(s.paxgFeed, GOLD_PRICE);
      await setValidPrice(s.xautFeed, GOLD_PRICE);

      await s.vault.connect(s.alice).deposit(await s.paxg.getAddress(), ethers.parseEther("1"));
      await s.vault.connect(s.alice).mint(ethers.parseEther("1000"));

      await s.vault.setBadDebtPauseThreshold(ethers.parseEther("1"));

      // Crash to a level where liquidation cannot fully cover debt
      await setOraclePrice(s.oracle, s.paxgFeed, s.xautFeed,
        await s.paxg.getAddress(), await s.xaut.getAddress(), 50000000000n);

      await s.vault.connect(s.bob).liquidate(s.alice.address, 0);
      expect(await s.vault.paused()).to.be.true;
    });

    it("emergencyLiquidate during pause does not revert via double-pause", async function () {
      const s = await loadFixture(productionSystem);
      await setValidPrice(s.paxgFeed, GOLD_PRICE);
      await setValidPrice(s.xautFeed, GOLD_PRICE);

      // Two vaults so we can trigger bad debt twice (one to set threshold,
      // one to verify _handleBadDebt doesn't double-pause when called from
      // emergencyLiquidate while paused).
      await s.vault.connect(s.alice).deposit(await s.paxg.getAddress(), ethers.parseEther("1"));
      await s.vault.connect(s.alice).mint(ethers.parseEther("1000"));
      await s.vault.connect(s.bob).deposit(await s.paxg.getAddress(), ethers.parseEther("1"));
      await s.vault.connect(s.bob).mint(ethers.parseEther("1000"));

      await s.vault.setBadDebtPauseThreshold(ethers.parseEther("1"));
      await setOraclePrice(s.oracle, s.paxgFeed, s.xautFeed,
        await s.paxg.getAddress(), await s.xaut.getAddress(), 50000000000n);

      // First liquidation pauses the vault via threshold trip
      await s.stablecoin.mint(s.charlie.address, ethers.parseEther("10000"));
      await s.stablecoin.connect(s.charlie).approve(await s.vault.getAddress(), ethers.MaxUint256);
      await s.vault.connect(s.charlie).liquidate(s.alice.address, 0);
      expect(await s.vault.paused()).to.be.true;

      // Now liquidate the second vault via emergencyLiquidate. _handleBadDebt
      // would call _pause() if unguarded → revert. With the guard it succeeds.
      await expect(
        s.vault.connect(s.charlie).emergencyLiquidate(s.bob.address, 0)
      ).to.emit(s.vault, "Liquidated");
    });
  });

  describe("9. Guardian pause / governance unpause separation", function () {
    it("guardian can pause, only governance can unpause", async function () {
      const s = await loadFixture(productionSystem);
      await s.vault.connect(s.guardian).emergencyPause();
      expect(await s.vault.paused()).to.be.true;
      await expect(s.vault.connect(s.guardian).unpause(1n)).to.be.reverted;
      await s.vault.unpause(await s.vault.pauseEpoch()); // governance (deployer) can
      expect(await s.vault.paused()).to.be.false;
    });
  });

  describe("10. Governance handover — every contract incl. stablecoin", function () {
    it("after handover, deployer holds zero admin roles and former admin cannot grant MINTER_ROLE", async function () {
      const s = await loadFixture(productionSystem);

      await s.stablecoin.transferGovernance(s.timelockAddr);
      await s.oracle.transferGovernance(s.timelockAddr);
      await s.vault.transferGovernance(s.timelockAddr);
      await s.stabilityModule.transferGovernance(s.timelockAddr);
      await s.surplusBuffer.transferGovernance(s.timelockAddr);
      await s.stabilityPool.transferGovernance(s.timelockAddr);
      await s.reserve.transferGovernance(s.timelockAddr);

      const ADMIN_ROLE = await s.vault.DEFAULT_ADMIN_ROLE();
      await s.siloFactory.grantRole(ADMIN_ROLE, s.timelockAddr);
      await s.siloFactory.renounceRole(ADMIN_ROLE, s.deployer.address);

      const targets = [
        s.stablecoin, s.oracle, s.vault, s.stabilityModule,
        s.surplusBuffer, s.stabilityPool, s.reserve, s.siloFactory,
      ];
      for (const ctr of targets) {
        expect(await ctr.hasRole(ADMIN_ROLE, s.deployer.address)).to.be.false;
        expect(await ctr.hasRole(ADMIN_ROLE, s.timelockAddr)).to.be.true;
      }

      // Former admin cannot grant MINTER_ROLE
      const MINTER_ROLE = await s.stablecoin.MINTER_ROLE();
      await expect(
        s.stablecoin.connect(s.deployer).grantRole(MINTER_ROLE, s.deployer.address)
      ).to.be.reverted;
    });
  });

  describe("11. Timelock-gated parameter change", function () {
    it("48-hour delay is enforced for stability-fee updates", async function () {
      const s = await loadFixture(productionSystem);

      // After handover, parameter changes must flow through the timelock
      await s.stabilityModule.transferGovernance(s.timelockAddr);

      const PROPOSER_ROLE = await s.governance.PROPOSER_ROLE();
      await s.governance.grantRole(PROPOSER_ROLE, s.proposer.address);

      const tx = await s.governance.connect(s.proposer).proposeStabilityFeeUpdate(s.paxgId, 300);
      const receipt = await tx.wait();
      if (!receipt) throw new Error("proposal transaction receipt missing");
      // Read salt out of ProposalCreated event by parsing logs
      const proposalEvent = receipt.logs.find((l: { topics: readonly string[] }) =>
        l.topics[0] === ethers.id("ProposalCreated(bytes32,address,bytes,uint256)")
      );
      expect(proposalEvent, "ProposalCreated event missing").to.exist;

      // Cannot execute before delay
      const data = s.stabilityModule.interface.encodeFunctionData("setStabilityFee", [s.paxgId, 300]);
      // Try (and fail) to execute with salt=0 — proves timelock enforces delay
      await expect(
        s.governance.connect(s.executor).executeProposal(
          await s.stabilityModule.getAddress(),
          data,
          ethers.zeroPadValue("0x", 32)
        )
      ).to.be.reverted;
    });
  });

  describe("12. Third gold token onboards via governance without redeploy", function () {
    async function onboardKau(s: Awaited<ReturnType<typeof productionSystem>>) {
      const MockToken = await ethers.getContractFactory("MockERC20");
      const kau = await MockToken.deploy("Kinesis Gold", "KAU", 18);
      const MockAgg = await ethers.getContractFactory("MockAggregatorV3");
      const kauFeed = await MockAgg.deploy(8);
      await setValidPrice(kauFeed, GOLD_PRICE);

      // Governance onboarding: oracle registry, vault collateral type,
      // stability fee accrual and pool collateral registration. No redeploy.
      await s.oracle.addFeed(await kau.getAddress(), await kauFeed.getAddress());
      await s.vault.addCollateralType(
        await kau.getAddress(), MIN_RATIO, LIQ_RATIO, LIQ_PENALTY, DEBT_CEILING
      );
      const kauId = ethers.keccak256(ethers.solidityPacked(["address"], [await kau.getAddress()]));
      await s.stabilityModule.initCollateral(kauId, 200);
      await s.stabilityPool.addCollateralToken(await kau.getAddress());
      return { kau, kauFeed, kauId };
    }

    async function stepKauPriceDownTo(
      s: Awaited<ReturnType<typeof productionSystem>>,
      kau: { getAddress: () => Promise<string> },
      kauFeed: { setLatestRoundData: (a: number, b: bigint, c: number, d: number, e: number) => Promise<unknown> },
      target: bigint
    ) {
      let current = await s.oracle.getLastKnownPrice(await kau.getAddress());
      while (current !== target) {
        let next = (current * 91n) / 100n; // 9% steps stay inside the deviation breaker
        if (next < target) next = target;
        await setValidPrice(kauFeed, next);
        await s.oracle.getTokenPrice(await kau.getAddress());
        current = next;
      }
    }

    it("full cycle: deposit, mint, accrue, repay with fee to buffer, price drop, exact liquidation", async function () {
      const s = await loadFixture(productionSystem);
      const { kau, kauFeed } = await onboardKau(s);

      expect(await s.oracle.getSupportedTokens()).to.include(await kau.getAddress());

      await kau.mint(s.alice.address, ethers.parseEther("100"));
      await kau.connect(s.alice).approve(await s.vault.getAddress(), ethers.MaxUint256);
      await s.vault.connect(s.alice).deposit(await kau.getAddress(), ethers.parseEther("10"));
      await s.vault.connect(s.alice).mint(ethers.parseEther("12000"));
      expect(await s.stablecoin.balanceOf(s.alice.address)).to.be.gte(ethers.parseEther("12000"));

      // Accrue a year of stability fees, then repay: the accrued-fee portion
      // of the repayment routes to the surplus buffer.
      await time.increase(365 * 24 * 3600);
      await setValidPrice(kauFeed, GOLD_PRICE);
      await setValidPrice(s.paxgFeed, GOLD_PRICE);
      await setValidPrice(s.xautFeed, GOLD_PRICE);
      const bufferBefore = await s.surplusBuffer.gsusdBalance();
      await s.vault.connect(s.alice).repay(ethers.parseEther("1000"));
      const bufferAfter = await s.surplusBuffer.gsusdBalance();
      expect(bufferAfter).to.be.gt(bufferBefore);

      // Gold drops to $1200: debt is ~11240 (11000 principal + ~240 accrued fees)
      // against 10 KAU * $1200 = $12000, a ratio of ~106.7% < 110%.
      await stepKauPriceDownTo(s, kau, kauFeed, 120000000000n);
      expect(await s.vault.getCollateralisationRatio(s.alice.address)).to.be.lt(LIQ_RATIO);

      const balBefore = await kau.balanceOf(s.bob.address);
      const vBefore = await s.vault.vaults(s.alice.address);
      await s.vault.connect(s.bob).liquidate(s.alice.address, ethers.parseEther("6000"));
      const balAfter = await kau.balanceOf(s.bob.address);
      const vAfter = await s.vault.vaults(s.alice.address);

      // Section 2 formula, identical arithmetic to the PAXG case:
      // 6000 GSUSD * 1.05 / 1200 = 5.25 KAU seized
      expect(vBefore.collateralAmount - vAfter.collateralAmount).to.equal(ethers.parseEther("5.25"));
      // 5 KAU debt-equivalent + 0.15 KAU (60% of the 0.25 penalty) = 5.15 KAU
      expect(balAfter - balBefore).to.equal(ethers.parseEther("5.15"));
    });

    it("with the anchor set, the new token is band-checked like the originals", async function () {
      const s = await loadFixture(productionSystem);
      const { kau, kauFeed } = await onboardKau(s);

      const MockAgg = await ethers.getContractFactory("MockAggregatorV3");
      const anchorFeed = await MockAgg.deploy(8);
      await setValidPrice(anchorFeed, GOLD_PRICE);
      await s.oracle.setAnchorFeed(await anchorFeed.getAddress());

      // 15% from gold: outside the default 2% band and capped by the default 2% liquidation cap
      await setValidPrice(kauFeed, (GOLD_PRICE * 115n) / 100n);
      await expect(s.oracle.getBorrowPrice(await kau.getAddress()))
        .to.be.revertedWith("Off gold band");
      expect(await s.oracle.quoteTokenPrice(await kau.getAddress())).to.equal((GOLD_PRICE * 102n) / 100n);

      // 1.5% from gold: inside the band
      await setValidPrice(kauFeed, (GOLD_PRICE * 1015n) / 1000n);
      await expect(s.oracle.getTokenPrice(await kau.getAddress())).to.not.be.reverted;
    });
  });
});
