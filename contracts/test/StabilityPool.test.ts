import { expect } from "chai";
import { ethers } from "hardhat";
import { StabilityPool, MockERC20 } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { absorbPrefunded } from "./helpers/poolAbsorb";

describe("StabilityPool", function () {
  let pool: StabilityPool;
  let gsusd: MockERC20;
  let goldToken: MockERC20;
  let owner: HardhatEthersSigner;
  let vault: HardhatEthersSigner;
  let alice: HardhatEthersSigner;
  let bob: HardhatEthersSigner;
  let other: HardhatEthersSigner;

  const PRECISION = 10n ** 18n;
  const parseE18 = ethers.parseEther;

  beforeEach(async function () {
    [owner, vault, alice, bob, other] = await ethers.getSigners();

    const MockToken = await ethers.getContractFactory("MockERC20");
    gsusd = await MockToken.deploy("Gold Standard Dollar", "GSUSD", 18);
    goldToken = await MockToken.deploy("Pax Gold", "PAXG", 18);

    const PoolFactory = await ethers.getContractFactory("StabilityPool");
    pool = await PoolFactory.deploy(await gsusd.getAddress());

    // Grant VAULT_ROLE to the vault signer
    const VAULT_ROLE = await pool.VAULT_ROLE();
    await pool.grantRole(VAULT_ROLE, vault.address);

    // Register gold collateral token
    await pool.addCollateralToken(await goldToken.getAddress());

    // Mint GSUSD to alice and bob for deposits
    await gsusd.mint(alice.address, parseE18("10000"));
    await gsusd.mint(bob.address, parseE18("10000"));

    // Approve pool to spend GSUSD
    const poolAddr = await pool.getAddress();
    await gsusd.connect(alice).approve(poolAddr, ethers.MaxUint256);
    await gsusd.connect(bob).approve(poolAddr, ethers.MaxUint256);

    // Gold for the vault signer to send to the pool ahead of each absorption, as the
    // vault's silos do in a pool liquidation.
    await goldToken.mint(vault.address, parseE18("10000"));
  });

  // ---------------------------------------------------------------------------
  // Constructor
  // ---------------------------------------------------------------------------
  describe("Constructor", function () {
    it("should revert when GSUSD address is zero", async function () {
      const PoolFactory = await ethers.getContractFactory("StabilityPool");
      await expect(PoolFactory.deploy(ethers.ZeroAddress)).to.be.revertedWith(
        "Zero address"
      );
    });
  });

  // ---------------------------------------------------------------------------
  // addCollateralToken
  // ---------------------------------------------------------------------------
  describe("addCollateralToken", function () {
    it("should allow governance to add a collateral token", async function () {
      const MockToken = await ethers.getContractFactory("MockERC20");
      const xaut = await MockToken.deploy("Tether Gold", "XAUT", 18);
      const xautAddr = await xaut.getAddress();

      await pool.addCollateralToken(xautAddr);
      expect(await pool.isCollateralToken(xautAddr)).to.be.true;
    });

    it("should revert for zero address", async function () {
      await expect(
        pool.addCollateralToken(ethers.ZeroAddress)
      ).to.be.revertedWith("Zero address");
    });

    it("should revert for duplicate token", async function () {
      const goldAddr = await goldToken.getAddress();
      // goldToken was already added in beforeEach
      await expect(pool.addCollateralToken(goldAddr)).to.be.revertedWith(
        "Already added"
      );
    });
  });

  // ---------------------------------------------------------------------------
  // deposit
  // ---------------------------------------------------------------------------
  describe("deposit", function () {
    it("should increase totalDeposits and user deposits", async function () {
      await pool.connect(alice).deposit(parseE18("500"));

      expect(await pool.totalDeposits()).to.equal(parseE18("500"));
      expect(await pool.deposits(alice.address)).to.equal(parseE18("500"));
    });

    it("should revert on zero amount", async function () {
      await expect(pool.connect(alice).deposit(0)).to.be.revertedWith(
        "Zero amount"
      );
    });
  });

  // ---------------------------------------------------------------------------
  // withdraw
  // ---------------------------------------------------------------------------
  describe("withdraw", function () {
    beforeEach(async function () {
      await pool.connect(alice).deposit(parseE18("1000"));
    });

    it("should decrease totalDeposits and transfer GSUSD back", async function () {
      const balBefore = await gsusd.balanceOf(alice.address);
      await pool.connect(alice).withdraw(parseE18("400"));

      expect(await pool.totalDeposits()).to.equal(parseE18("600"));
      expect(await pool.deposits(alice.address)).to.equal(parseE18("600"));
      expect(await gsusd.balanceOf(alice.address)).to.equal(
        balBefore + parseE18("400")
      );
    });

    it("should cap withdrawal at user deposit (cannot withdraw more than deposited)", async function () {
      const balBefore = await gsusd.balanceOf(alice.address);

      // Try to withdraw more than deposited
      await pool.connect(alice).withdraw(parseE18("5000"));

      // Should have withdrawn only the 1000 that was deposited
      expect(await pool.deposits(alice.address)).to.equal(0);
      expect(await pool.totalDeposits()).to.equal(0);
      expect(await gsusd.balanceOf(alice.address)).to.equal(
        balBefore + parseE18("1000")
      );
    });
  });

  // ---------------------------------------------------------------------------
  // absorbLiquidationPrefunded
  // ---------------------------------------------------------------------------
  describe("absorbLiquidationPrefunded", function () {
    beforeEach(async function () {
      // Alice deposits 1000 GSUSD
      await pool.connect(alice).deposit(parseE18("1000"));
    });

    it("should reduce totalDeposits, shrink P, and credit the sole depositor with the full gain", async function () {
      const goldAddr = await goldToken.getAddress();

      await absorbPrefunded(pool, goldToken, vault, parseE18("200"), parseE18("1"));

      // totalDeposits reduced by debtAbsorbed
      expect(await pool.totalDeposits()).to.equal(parseE18("800"));

      // P shrinks proportionally to the remaining fraction (800/1000) and stays strictly positive.
      expect(await pool.P()).to.equal((PRECISION * parseE18("800")) / parseE18("1000"));
      expect(await pool.P()).to.be.gt(0n);

      // Alice is the sole depositor, so she is entitled to the entire seized collateral (1 gold),
      // modulo product-sum rounding dust.
      const gain = await pool.getCollateralGain(alice.address, goldAddr);
      expect(gain).to.be.closeTo(parseE18("1"), 1000n);
    });

    it("should revert for unsupported token", async function () {
      const MockToken = await ethers.getContractFactory("MockERC20");
      const randomToken = await MockToken.deploy("Random", "RND", 18);
      const rndAddr = await randomToken.getAddress();

      await expect(
        pool.connect(vault).absorbLiquidationPrefunded(rndAddr, parseE18("100"))
      ).to.be.revertedWith("Unsupported token");
    });

    it("should revert when pool is empty", async function () {
      // Withdraw everything first
      await pool.connect(alice).withdraw(parseE18("1000"));
      const goldAddr = await goldToken.getAddress();

      await expect(
        absorbPrefunded(pool, goldToken, vault, parseE18("100"), parseE18("1"))
      ).to.be.revertedWith("Pool empty");
    });

    it("should revert when absorption would fully drain the pool", async function () {
      const goldAddr = await goldToken.getAddress();

      // Attempting to absorb >= totalDeposits is rejected. Full drain would force
      // P to 0 and break the product-sum accounting — callers must route any
      // residual through direct `vault.liquidate()` instead.
      await expect(
        absorbPrefunded(pool, goldToken, vault, parseE18("5000"), parseE18("3"))
      ).to.be.revertedWith("Absorption would drain pool");

      // And exactly-full absorption is also rejected (strict inequality).
      await expect(
        absorbPrefunded(pool, goldToken, vault, parseE18("1000"), parseE18("1"))
      ).to.be.revertedWith("Absorption would drain pool");
    });

    it("should correctly scale user deposits under the product-sum algorithm", async function () {
      const goldAddr = await goldToken.getAddress();

      // Alice already has 1000 deposited (from beforeEach). Bob adds 500 so we
      // have two users to verify proportional treatment.
      await pool.connect(bob).deposit(parseE18("500"));
      // totalDeposits = 1500

      // Absorb 750 (50%) of the pool.
      await absorbPrefunded(pool, goldToken, vault, parseE18("750"), parseE18("1"));

      // totalDeposits halved.
      expect(await pool.totalDeposits()).to.equal(parseE18("750"));

      // Effective deposits are each halved. A pool that reported the stored deposit
      // without the product factor would return the stale, unscaled values here.
      expect(await pool.getEffectiveDeposit(alice.address)).to.equal(parseE18("500"));
      expect(await pool.getEffectiveDeposit(bob.address)).to.equal(parseE18("250"));

      // Sum of effectives equals totalDeposits (product-sum invariant).
      const sum =
        (await pool.getEffectiveDeposit(alice.address)) +
        (await pool.getEffectiveDeposit(bob.address));
      expect(sum).to.equal(await pool.totalDeposits());
    });

    it("should revert without VAULT_ROLE", async function () {
      const goldAddr = await goldToken.getAddress();

      await expect(
        pool.connect(other).absorbLiquidationPrefunded(goldAddr, parseE18("100"))
      ).to.be.revertedWithCustomError(pool, "AccessControlUnauthorizedAccount");
    });
  });

  // ---------------------------------------------------------------------------
  // claimCollateral
  // ---------------------------------------------------------------------------
  describe("claimCollateral", function () {
    it("should transfer accumulated gold gains to user", async function () {
      const goldAddr = await goldToken.getAddress();

      // Alice deposits 1000 GSUSD
      await pool.connect(alice).deposit(parseE18("1000"));

      // Liquidation: 200 GSUSD debt absorbed, 1 PAXG collateral
      await absorbPrefunded(pool, goldToken, vault, parseE18("200"), parseE18("1"));

      // Alice claims collateral
      const balBefore = await goldToken.balanceOf(alice.address);
      await pool.connect(alice).claimCollateral(goldAddr);
      const balAfter = await goldToken.balanceOf(alice.address);

      // Alice should receive ~1 PAXG (sole depositor gets all gains)
      expect(balAfter - balBefore).to.equal(parseE18("1"));
    });

    it("should revert when user has no gains", async function () {
      const goldAddr = await goldToken.getAddress();

      await expect(
        pool.connect(alice).claimCollateral(goldAddr)
      ).to.be.revertedWith("No gains");
    });
  });

  // ---------------------------------------------------------------------------
  // getCollateralGain
  // ---------------------------------------------------------------------------
  describe("getCollateralGain", function () {
    it("should return correct pending gain after liquidation", async function () {
      const goldAddr = await goldToken.getAddress();

      await pool.connect(alice).deposit(parseE18("1000"));

      await absorbPrefunded(pool, goldToken, vault, parseE18("200"), parseE18("1"));

      const gain = await pool.getCollateralGain(alice.address, goldAddr);
      expect(gain).to.equal(parseE18("1"));
    });
  });

  // ---------------------------------------------------------------------------
  // Multiple depositors proportional gains
  // ---------------------------------------------------------------------------
  describe("Multiple depositors", function () {
    it("should distribute gains proportionally", async function () {
      const goldAddr = await goldToken.getAddress();

      // Alice deposits 750, Bob deposits 250 (75%/25% split)
      await pool.connect(alice).deposit(parseE18("750"));
      await pool.connect(bob).deposit(parseE18("250"));

      // Liquidation: 400 GSUSD debt, 2 PAXG collateral
      await absorbPrefunded(pool, goldToken, vault, parseE18("400"), parseE18("2"));

      const aliceGain = await pool.getCollateralGain(alice.address, goldAddr);
      const bobGain = await pool.getCollateralGain(bob.address, goldAddr);

      // Alice: 75% of 2 PAXG = 1.5 PAXG
      expect(aliceGain).to.equal(parseE18("1.5"));
      // Bob: 25% of 2 PAXG = 0.5 PAXG
      expect(bobGain).to.equal(parseE18("0.5"));
    });
  });

  // ---------------------------------------------------------------------------
  // Deposit after liquidation: new depositor shouldn't receive old gains
  // ---------------------------------------------------------------------------
  describe("Deposit after liquidation", function () {
    it("should not grant old gains to a new depositor", async function () {
      const goldAddr = await goldToken.getAddress();

      // Alice deposits 1000
      await pool.connect(alice).deposit(parseE18("1000"));

      // Liquidation happens
      await absorbPrefunded(pool, goldToken, vault, parseE18("200"), parseE18("1"));

      // Bob deposits after liquidation
      await pool.connect(bob).deposit(parseE18("500"));

      // Bob should have zero gains (he deposited after the liquidation)
      const bobGain = await pool.getCollateralGain(bob.address, goldAddr);
      expect(bobGain).to.equal(0);

      // Alice should still have her gains
      const aliceGain = await pool.getCollateralGain(alice.address, goldAddr);
      expect(aliceGain).to.equal(parseE18("1"));
    });
  });

  // ---------------------------------------------------------------------------
  // Pausable
  // ---------------------------------------------------------------------------
  describe("Pausable", function () {
    it("should reject deposit when paused", async function () {
      await pool.emergencyPause();
      await expect(pool.connect(alice).deposit(parseE18("100")))
        .to.be.revertedWithCustomError(pool, "EnforcedPause");
    });

    it("should reject withdraw when paused", async function () {
      await pool.connect(alice).deposit(parseE18("1000"));
      await pool.emergencyPause();
      await expect(pool.connect(alice).withdraw(parseE18("100")))
        .to.be.revertedWithCustomError(pool, "EnforcedPause");
    });

    it("should allow claimCollateral while paused (earned gains stay claimable)", async function () {
      await pool.emergencyPause();
      // Claims are deliberately not pause-gated: they only pay already-earned,
      // fully-accounted gains. With no gains accrued the call reaches the
      // "No gains" check instead of reverting with EnforcedPause.
      await expect(pool.connect(alice).claimCollateral(await goldToken.getAddress()))
        .to.be.revertedWith("No gains");
    });

    it("emergencyPause should be callable by guardian", async function () {
      await pool.grantGuardianRole(other.address);
      await pool.connect(other).emergencyPause();
      expect(await pool.paused()).to.be.true;
    });

    it("emergencyPause should be callable by governance", async function () {
      await pool.emergencyPause();
      expect(await pool.paused()).to.be.true;
    });

    it("emergencyPause should reject non-guardian non-governance", async function () {
      await expect(pool.connect(other).emergencyPause())
        .to.be.revertedWith("Not guardian or governance");
    });

    it("unpause should only allow governance", async function () {
      await pool.emergencyPause();
      await expect(pool.connect(other).unpause(1n)).to.be.reverted;
      await pool.unpause(await pool.pauseEpoch());
      expect(await pool.paused()).to.be.false;
    });
  });

  // ---------------------------------------------------------------------------
  // MAX_COLLATERAL_TOKENS
  // ---------------------------------------------------------------------------
  describe("MAX_COLLATERAL_TOKENS", function () {
    it("should reject adding more than MAX_COLLATERAL_TOKENS", async function () {
      const MockToken = await ethers.getContractFactory("MockERC20");
      // goldToken is already added (1 token). Add 9 more to reach limit of 10.
      for (let i = 0; i < 9; i++) {
        const t = await MockToken.deploy(`Token${i}`, `T${i}`, 18);
        await pool.addCollateralToken(await t.getAddress());
      }

      // 11th should revert
      const extra = await MockToken.deploy("Extra", "EXTRA", 18);
      await expect(pool.addCollateralToken(await extra.getAddress()))
        .to.be.revertedWith("Too many collateral tokens");
    });
  });

  // ---------------------------------------------------------------------------
  // Guardian
  // ---------------------------------------------------------------------------
  describe("grantGuardianRole", function () {
    it("should reject zero address", async function () {
      await expect(pool.grantGuardianRole(ethers.ZeroAddress))
        .to.be.revertedWith("Zero address");
    });

    it("should only allow DEFAULT_ADMIN_ROLE", async function () {
      await expect(pool.connect(other).grantGuardianRole(other.address))
        .to.be.reverted;
    });
  });

  // ---------------------------------------------------------------------------
  // transferGovernance
  // ---------------------------------------------------------------------------
  describe("transferGovernance", function () {
    it("should transfer governance and admin roles to new address", async function () {
      // Destination must be a contract now; the token stands in for the timelock.
      const dest = await gsusd.getAddress();
      const GOVERNANCE_ROLE = await pool.GOVERNANCE_ROLE();
      const DEFAULT_ADMIN_ROLE = await pool.DEFAULT_ADMIN_ROLE();

      await pool.transferGovernance(dest);

      expect(await pool.hasRole(GOVERNANCE_ROLE, dest)).to.be.true;
      expect(await pool.hasRole(DEFAULT_ADMIN_ROLE, dest)).to.be.true;
      expect(await pool.hasRole(GOVERNANCE_ROLE, owner.address)).to.be.false;
      expect(await pool.hasRole(DEFAULT_ADMIN_ROLE, owner.address)).to.be.false;
    });
  });
});
