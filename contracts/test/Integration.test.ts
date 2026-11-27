import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import {
  GoldVault,
  GoldOracle,
  GoldStablecoin,
  StabilityModule,
  SurplusBuffer,
  StabilityPool,
  GoldStabilityReserve,
  MockAggregatorV3,
  MockERC20,
} from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

describe("Integration: GoldVault + SurplusBuffer + StabilityPool + GoldStabilityReserve", function () {
  let vault: GoldVault;
  let oracle: GoldOracle;
  let stablecoin: GoldStablecoin;
  let stabilityModule: StabilityModule;
  let surplusBuffer: SurplusBuffer;
  let stabilityPool: StabilityPool;
  let reserve: GoldStabilityReserve;
  let paxgFeed: MockAggregatorV3;
  let xautFeed: MockAggregatorV3;
  let paxg: MockERC20; // 18 dec
  let xaut: MockERC20; // 6 dec

  let owner: HardhatEthersSigner;
  let user: HardhatEthersSigner;
  let liquidator: HardhatEthersSigner;
  let depositor: HardhatEthersSigner;
  let redeemer: HardhatEthersSigner;
  let other: HardhatEthersSigner;

  const GOLD_PRICE = 200000000000n; // $2000, 8 decimals
  const MIN_RATIO = 1500000n; // 150%
  const LIQ_RATIO = 1100000n; // 110%
  const LIQ_PENALTY = 50000n; // 5%
  const DEBT_CEILING = ethers.parseEther("1000000000"); // 1B GSUSD (1e27 worth)

  async function setValidPrice(feed: MockAggregatorV3, price: bigint) {
    const ts = await time.latest();
    await feed.setLatestRoundData(1, price, ts, ts, 1);
  }

  // Move price stepwise to avoid 10% deviation circuit breaker.
  // Always updates both PAXG and XAUT feeds to satisfy cross-feed consistency.
  async function setOraclePrice(newPrice: bigint) {
    const paxgAddr = await paxg.getAddress();
    const xautAddr = await xaut.getAddress();

    const currentPaxg = await oracle.lastKnownPaxgPrice();
    if (currentPaxg === 0n) {
      await setValidPrice(paxgFeed, newPrice);
      await setValidPrice(xautFeed, newPrice);
      await oracle.getTokenPrice(paxgAddr);
      await oracle.getTokenPrice(xautAddr);
      return;
    }

    let current = currentPaxg;
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

  async function refreshPrices() {
    await setValidPrice(paxgFeed, GOLD_PRICE);
    await setValidPrice(xautFeed, GOLD_PRICE);
  }

  /**
   * Deploy the full system. Options allow selectively disabling certain wirings
   * so individual tests can verify fallbacks / permission failures.
   */
  async function deploySystem(opts?: {
    skipSurplusBuffer?: boolean;
    skipStabilityPool?: boolean;
    skipStabilityReserve?: boolean;
  }) {
    [owner, user, liquidator, depositor, redeemer, other] = await ethers.getSigners();

    // ---- Mocks ----
    const MockAgg = await ethers.getContractFactory("MockAggregatorV3");
    paxgFeed = await MockAgg.deploy(8);
    xautFeed = await MockAgg.deploy(8);

    const MockToken = await ethers.getContractFactory("MockERC20");
    paxg = await MockToken.deploy("Pax Gold", "PAXG", 18);
    xaut = await MockToken.deploy("Tether Gold", "XAUT", 6);

    await setValidPrice(paxgFeed, GOLD_PRICE);
    await setValidPrice(xautFeed, GOLD_PRICE);

    // ---- Core ----
    const OracleF = await ethers.getContractFactory("GoldOracle");
    oracle = await OracleF.deploy(
      await paxgFeed.getAddress(),
      await xautFeed.getAddress(),
      await paxg.getAddress(),
      await xaut.getAddress(),
      3600
    );

    const StablecoinF = await ethers.getContractFactory("GoldStablecoin");
    stablecoin = await StablecoinF.deploy();

    const StabModF = await ethers.getContractFactory("StabilityModule");
    stabilityModule = await StabModF.deploy();

    const VaultF = await ethers.getContractFactory("GoldVault");
    vault = await VaultF.deploy(
      await oracle.getAddress(),
      await stablecoin.getAddress(),
      await stabilityModule.getAddress()
    );

    // ---- New peripherals ----
    const SurplusF = await ethers.getContractFactory("SurplusBuffer");
    surplusBuffer = await SurplusF.deploy(await stablecoin.getAddress());

    const PoolF = await ethers.getContractFactory("StabilityPool");
    stabilityPool = await PoolF.deploy(await stablecoin.getAddress());

    const ReserveF = await ethers.getContractFactory("GoldStabilityReserve");
    reserve = await ReserveF.deploy(await stablecoin.getAddress(), await oracle.getAddress());

    // ---- Roles ----
    const MINTER_ROLE = await stablecoin.MINTER_ROLE();
    await stablecoin.grantRole(MINTER_ROLE, await vault.getAddress());
    // Grant MINTER_ROLE to owner so we can mint test GSUSD
    await stablecoin.grantRole(MINTER_ROLE, owner.address);

    const VAULT_ROLE_SM = await stabilityModule.VAULT_ROLE();
    await stabilityModule.grantRole(VAULT_ROLE_SM, await vault.getAddress());

    const VAULT_ROLE_SB = await surplusBuffer.VAULT_ROLE();
    await surplusBuffer.grantRole(VAULT_ROLE_SB, await vault.getAddress());
    await surplusBuffer.grantRole(VAULT_ROLE_SB, await reserve.getAddress());
    await reserve.grantRole(await reserve.VAULT_ROLE(), await vault.getAddress());

    const VAULT_ROLE_SP = await stabilityPool.VAULT_ROLE();
    await stabilityPool.grantRole(VAULT_ROLE_SP, await vault.getAddress());

    // ---- Wiring ----
    if (!opts?.skipSurplusBuffer) {
      await vault.setSurplusBuffer(await surplusBuffer.getAddress());
    }
    if (!opts?.skipStabilityPool) {
      await vault.setStabilityPool(await stabilityPool.getAddress());
    }
    if (!opts?.skipStabilityReserve) {
      await vault.setStabilityReserve(await reserve.getAddress());
      await vault.setReservePenaltyShare(4000n);
      await reserve.setSurplusBuffer(await surplusBuffer.getAddress());
      await reserve.setAssetConfig(await paxg.getAddress(), true, 0n, 1_000_000n);
      await reserve.setSpreadCurve([{ coverageAtLeastPpm: 10_000n, spreadPpm: 5_000n }], 20_000n);
    }

    // ---- Register collateral ----
    await vault.addCollateralType(
      await paxg.getAddress(),
      MIN_RATIO,
      LIQ_RATIO,
      LIQ_PENALTY,
      DEBT_CEILING
    );

    const paxgId = ethers.keccak256(
      ethers.solidityPacked(["address"], [await paxg.getAddress()])
    );
    await stabilityModule.initCollateral(paxgId, 200); // 2% APR

    await stabilityPool.addCollateralToken(await paxg.getAddress());

    // Initialise oracle lastKnown prices
    await oracle.getTokenPrice(await paxg.getAddress());
    await oracle.getTokenPrice(await xaut.getAddress());

    // ---- Test users ----
    // User: a typical vault owner
    await paxg.mint(user.address, ethers.parseEther("100"));
    await paxg.connect(user).approve(await vault.getAddress(), ethers.MaxUint256);
    await stablecoin
      .connect(user)
      .approve(await vault.getAddress(), ethers.MaxUint256);

    // Liquidator: holds spare GSUSD to liquidate others
    await stablecoin.mint(liquidator.address, ethers.parseEther("50000"));
    await stablecoin
      .connect(liquidator)
      .approve(await vault.getAddress(), ethers.MaxUint256);

    // Depositor: provides GSUSD to the stability pool
    await stablecoin.mint(depositor.address, ethers.parseEther("50000"));
    await stablecoin
      .connect(depositor)
      .approve(await stabilityPool.getAddress(), ethers.MaxUint256);

    // Redeemer: holds GSUSD to swap through the reserve
    await stablecoin.mint(redeemer.address, ethers.parseEther("50000"));
    await stablecoin
      .connect(redeemer)
      .approve(await reserve.getAddress(), ethers.MaxUint256);
  }

  // Open a standard vault: 10 PAXG, 12,000 GSUSD debt (ratio = 166% at $2000)
  async function openStandardVault(signer: HardhatEthersSigner = user) {
    await refreshPrices();
    await vault
      .connect(signer)
      .deposit(await paxg.getAddress(), ethers.parseEther("10"));
    await refreshPrices();
    await vault.connect(signer).mint(ethers.parseEther("12000"));
  }

  // ==========================================================================
  // 1. Fee routing — repay after fees accrue routes feeportion to SurplusBuffer
  // ==========================================================================
  it("routes stability-fee portion of repay to SurplusBuffer", async function () {
    await deploySystem();
    await openStandardVault();

    // Advance ~30 days to accrue fees
    await time.increase(30 * 24 * 3600);
    await refreshPrices();

    const paxgId = ethers.keccak256(
      ethers.solidityPacked(["address"], [await paxg.getAddress()])
    );
    const currentDebt = await stabilityModule.getCurrentDebt(user.address, paxgId);
    const vBefore = await vault.vaults(user.address);
    const principalBefore = vBefore.debtAmount;

    // Current debt > principal (fees have accrued)
    expect(currentDebt).to.be.gt(principalBefore);

    // Give the user a little extra GSUSD to cover fees
    await stablecoin.mint(user.address, ethers.parseEther("1000"));

    const bufferBalBefore = await surplusBuffer.gsusdBalance();
    const supplyBefore = await stablecoin.totalSupply();

    // Partially repay ~half of currentDebt. Principal reduced pro-rata, fee portion
    // routes to the SurplusBuffer. Remaining principal stays well above MIN_DEBT.
    const repayAmount = currentDebt / 2n;
    await vault.connect(user).repay(repayAmount);

    const bufferBalAfter = await surplusBuffer.gsusdBalance();
    const supplyAfter = await stablecoin.totalSupply();
    const vAfter = await vault.vaults(user.address);

    // Buffer received a positive fee amount
    expect(bufferBalAfter).to.be.gt(bufferBalBefore);

    // Principal burned = principalBefore - principalAfter. Supply must have dropped by
    // exactly that amount (fees routed to buffer, NOT burned).
    const principalBurned = principalBefore - vAfter.debtAmount;
    const supplyDrop = supplyBefore - supplyAfter;
    expect(supplyDrop).to.equal(principalBurned);

    // And the fee landed in the buffer matches (total repay = principal burned + fee)
    const feeRouted = bufferBalAfter - bufferBalBefore;
    expect(principalBurned + feeRouted).to.equal(repayAmount);
  });

  // ==========================================================================
  // 2. Penalty routing — liquidation penalty flows to SurplusBuffer.collateralBalance
  // ==========================================================================
  it("routes liquidation penalty collateral to SurplusBuffer when wired", async function () {
    await deploySystem();
    await openStandardVault();

    // Price drops to $1,280: 106.67%, liquidatable and above 100% plus the penalty, so a
    // partial is accepted (below that line a full liquidation is demanded)
    await setOraclePrice(128000000000n);

    const paxgAddr = await paxg.getAddress();
    const bufferColBefore = await surplusBuffer.collateralBalance(paxgAddr);
    const legacySurplusBefore = await vault.surplusCollateral(paxgAddr);

    await vault
      .connect(liquidator)
      .liquidate(user.address, ethers.parseEther("6000"));

    const bufferColAfter = await surplusBuffer.collateralBalance(paxgAddr);
    const legacySurplusAfter = await vault.surplusCollateral(paxgAddr);

    // Buffer picked up the penalty share
    expect(bufferColAfter).to.be.gt(bufferColBefore);
    // Legacy map should NOT have been touched when buffer is configured
    expect(legacySurplusAfter).to.equal(legacySurplusBefore);
  });

  // ==========================================================================
  // 3. No SurplusBuffer — fees burned, penalty stays in surplusCollateral mapping
  // ==========================================================================
  it("falls back to burning fees and legacy surplusCollateral when SurplusBuffer is not set", async function () {
    await deploySystem();
    await openStandardVault();

    // Disable the buffer
    await vault.setSurplusBuffer(ethers.ZeroAddress);

    // ---- Repay with fees ----
    await time.increase(30 * 24 * 3600);
    await refreshPrices();
    const paxgId = ethers.keccak256(
      ethers.solidityPacked(["address"], [await paxg.getAddress()])
    );
    const currentDebt = await stabilityModule.getCurrentDebt(user.address, paxgId);
    await stablecoin.mint(user.address, ethers.parseEther("1000"));

    const supplyBefore = await stablecoin.totalSupply();
    // Partial repay so the MIN_DEBT floor isn't tripped by intra-block fee growth
    const repayAmount = currentDebt / 2n;
    await vault.connect(user).repay(repayAmount);
    const supplyAfter = await stablecoin.totalSupply();

    // With no SurplusBuffer, the full amount paid is burned (principal + fee portion).
    const supplyDrop = supplyBefore - supplyAfter;
    expect(supplyDrop).to.equal(repayAmount);

    // ---- Liquidation with penalty into surplusCollateral ----
    // Open another vault (user now has none). Use `other` as vault owner.
    await paxg.mint(other.address, ethers.parseEther("100"));
    await paxg
      .connect(other)
      .approve(await vault.getAddress(), ethers.MaxUint256);
    await stablecoin
      .connect(other)
      .approve(await vault.getAddress(), ethers.MaxUint256);
    await refreshPrices();
    await vault
      .connect(other)
      .deposit(await paxg.getAddress(), ethers.parseEther("10"));
    await vault.connect(other).mint(ethers.parseEther("12000"));

    await setOraclePrice(128000000000n); // 106.67%: a partial is still accepted

    const paxgAddr = await paxg.getAddress();
    const legacyBefore = await vault.surplusCollateral(paxgAddr);
    await vault
      .connect(liquidator)
      .liquidate(other.address, ethers.parseEther("6000"));
    const legacyAfter = await vault.surplusCollateral(paxgAddr);

    expect(legacyAfter).to.be.gt(legacyBefore);
  });

  // ==========================================================================
  // 4. liquidateViaPool — pool absorbs, keeper gets bounty
  // ==========================================================================
  it("liquidates via StabilityPool using pooled GSUSD and rewards the keeper", async function () {
    await deploySystem();
    await openStandardVault();

    // Depositor seeds the pool with 20k GSUSD
    await stabilityPool
      .connect(depositor)
      .deposit(ethers.parseEther("20000"));

    // Vault drops to 106.67%, where a partial is still accepted
    await setOraclePrice(128000000000n);

    const paxgAddr = await paxg.getAddress();
    const depositsBefore = await stabilityPool.getTotalDeposits();
    const keeperBalBefore = await paxg.balanceOf(other.address);
    const poolColBefore = await paxg.balanceOf(await stabilityPool.getAddress());

    // Anyone can be the keeper — use `other`
    await expect(
      vault.connect(other).liquidateViaPool(user.address, ethers.parseEther("6000"))
    ).to.emit(vault, "LiquidatedViaPool");

    const depositsAfter = await stabilityPool.getTotalDeposits();
    const keeperBalAfter = await paxg.balanceOf(other.address);
    const poolColAfter = await paxg.balanceOf(await stabilityPool.getAddress());

    // Pool deposits went down (GSUSD was used to cover debt)
    expect(depositsAfter).to.be.lt(depositsBefore);
    // Pool received collateral
    expect(poolColAfter).to.be.gt(poolColBefore);
    // Keeper received bounty in collateral token
    expect(keeperBalAfter).to.be.gt(keeperBalBefore);

    // And depositor's claimable gain on PAXG is non-zero
    const gain = await stabilityPool.getCollateralGain(depositor.address, paxgAddr);
    expect(gain).to.be.gt(0);
  });

  // ==========================================================================
  // 5. liquidateViaPool reverts when pool not set
  // ==========================================================================
  it("reverts liquidateViaPool when StabilityPool is not configured", async function () {
    await deploySystem({ skipStabilityPool: true });
    await openStandardVault();

    await setOraclePrice(120000000000n);

    await expect(
      vault.connect(other).liquidateViaPool(user.address, ethers.parseEther("6000"))
    ).to.be.revertedWith("StabilityPool not set");
  });

  // ==========================================================================
  // 6. liquidateViaPool reverts when pool has insufficient GSUSD
  // ==========================================================================
  it("reverts liquidateViaPool when pool has insufficient deposits", async function () {
    await deploySystem();
    await openStandardVault();

    // Seed pool with only 1000 GSUSD — not enough for 12k debt
    await stabilityPool.connect(depositor).deposit(ethers.parseEther("1000"));

    await setOraclePrice(120000000000n);

    // Full liquidation (0): the pool cannot cover the repayment. The sufficiency check
    // runs after sizing, so a partial on this thin vault reports the
    // sizing rule first.
    await expect(
      vault.connect(other).liquidateViaPool(user.address, 0)
    ).to.be.revertedWith("Pool insufficient");
    await expect(
      vault.connect(other).liquidateViaPool(user.address, ethers.parseEther("12000"))
    ).to.be.revertedWith("Thin vault: liquidate in full");
  });

  // ==========================================================================
  // 7. No code path lets a stranger's swap reach a borrower's vault
  // ==========================================================================
  it("the vault exposes no redemption entry point at all", async function () {
    await deploySystem();
    // The function was deleted, not gated.
    expect(vault.interface.hasFunction("redeemCollateral")).to.be.false;
    expect(vault.interface.hasFunction("setRedemptionModule")).to.be.false;
  });

  // ==========================================================================
  // 8. A stability swap draws from the reserve and leaves every vault byte-identical
  // ==========================================================================
  it("swaps GSUSD for reserve gold without touching the borrower's vault", async function () {
    await deploySystem();
    await openStandardVault();
    await paxg.mint(owner.address, ethers.parseEther("50"));
    await paxg.approve(await reserve.getAddress(), ethers.MaxUint256);
    await reserve.seedCollateral(await paxg.getAddress(), ethers.parseEther("50"));

    const vBefore = await vault.vaults(user.address);
    const redeemerPaxgBefore = await paxg.balanceOf(redeemer.address);
    const supplyBefore = await stablecoin.totalSupply();
    await refreshPrices();

    await expect(
      reserve.connect(redeemer).swapGsusdForGold(await paxg.getAddress(), ethers.parseEther("1000"), 0n)
    ).to.emit(reserve, "Swapped");

    const vAfter = await vault.vaults(user.address);
    expect(vAfter.debtAmount).to.equal(vBefore.debtAmount);
    expect(vAfter.collateralAmount).to.equal(vBefore.collateralAmount);
    expect(await paxg.balanceOf(redeemer.address)).to.be.gt(redeemerPaxgBefore);
    // A swap, not a burn.
    expect(await stablecoin.totalSupply()).to.equal(supplyBefore);
  });

  // ==========================================================================
  // 9. An empty reserve refuses; it never reaches for a vault
  // ==========================================================================
  it("refuses with 'Reserve insufficient' rather than drawing on any vault", async function () {
    await deploySystem();
    await openStandardVault();
    const vBefore = await vault.vaults(user.address);
    await refreshPrices();

    await expect(
      reserve.connect(redeemer).swapGsusdForGold(await paxg.getAddress(), ethers.parseEther("1000"), 0n)
    ).to.be.revertedWith("Reserve insufficient");

    const vAfter = await vault.vaults(user.address);
    expect(vAfter.debtAmount).to.equal(vBefore.debtAmount);
    expect(vAfter.collateralAmount).to.equal(vBefore.collateralAmount);
  });

  // ==========================================================================
  // 10. Bad-debt socialisation — vault wipes out, BadDebt emitted, totalBadDebt > 0
  // ==========================================================================
  it("socialises bad debt when collateral is insufficient to cover debt", async function () {
    await deploySystem();

    // Small vault: 1 PAXG ($2000) collateral, 1000 GSUSD debt (ratio = 200%)
    await refreshPrices();
    await vault
      .connect(user)
      .deposit(await paxg.getAddress(), ethers.parseEther("1"));
    await vault.connect(user).mint(ethers.parseEther("1000"));

    // Crash price so collateral is worth far less than debt.
    // 1 PAXG at $400 = $400 vs $1000 debt => clearly insufficient.
    await setOraclePrice(40000000000n); // $400

    // Liquidator needs enough GSUSD to attempt full repay
    await stablecoin.mint(liquidator.address, ethers.parseEther("5000"));

    const totalBadDebtBefore = await vault.totalBadDebt();

    // Full liquidation (0 = full). With collateral cap, debtToRepay is scaled down
    // and remaining debt (with zero collateral) becomes bad debt.
    const tx = await vault.connect(liquidator).liquidate(user.address, 0);

    // Event was emitted
    await expect(tx).to.emit(vault, "BadDebt");

    const vAfter = await vault.vaults(user.address);
    // Vault fully wiped
    expect(vAfter.collateralAmount).to.equal(0);
    expect(vAfter.debtAmount).to.equal(0);

    // Bad-debt counter increased (may have been partially offset by SurplusBuffer
    // if it had any GSUSD — in this test it doesn't, so totalBadDebt stays > 0)
    const totalBadDebtAfter = await vault.totalBadDebt();
    expect(totalBadDebtAfter).to.be.gt(totalBadDebtBefore);
  });
});
