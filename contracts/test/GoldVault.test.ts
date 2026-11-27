import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import {
  GoldVault,
  GoldOracle,
  GoldStablecoin,
  StabilityModule,
  MockAggregatorV3,
  MockERC20,
} from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

describe("GoldVault", function () {
  let vault: GoldVault;
  let oracle: GoldOracle;
  let stablecoin: GoldStablecoin;
  let stabilityModule: StabilityModule;
  let paxgFeed: MockAggregatorV3;
  let xautFeed: MockAggregatorV3;
  let paxg: MockERC20; // 18 decimals
  let xaut: MockERC20; // 6 decimals
  let owner: HardhatEthersSigner;
  let user: HardhatEthersSigner;
  let liquidator: HardhatEthersSigner;
  let other: HardhatEthersSigner;

  const GOLD_PRICE = 200000000000n; // $2000, 8 decimals
  const PRECISION = 1000000n; // 1e6
  const MIN_RATIO = 1500000n; // 150%
  const LIQ_RATIO = 1100000n; // 110%
  const LIQ_PENALTY = 50000n; // 5%
  const DEBT_CEILING = ethers.parseEther("1000000"); // 1M GSUSD

  async function setValidPrice(feed: MockAggregatorV3, price: bigint) {
    const ts = await time.latest();
    await feed.setLatestRoundData(1, price, ts, ts, 1);
  }

  // Move price to target in small steps to avoid circuit breaker and cross-feed issues.
  // Both feeds are always updated together to maintain cross-feed consistency.
  async function setOraclePrice(newPrice: bigint) {
    const currentPaxg = await oracle.lastKnownPaxgPrice();
    const currentXaut = await oracle.lastKnownXautPrice();

    // If no lastKnown set yet, just set directly
    if (currentPaxg === 0n || currentXaut === 0n) {
      await setValidPrice(paxgFeed, newPrice);
      await setValidPrice(xautFeed, newPrice);
      await oracle.getTokenPrice(await paxg.getAddress());
      await oracle.getTokenPrice(await xaut.getAddress());
      return;
    }

    // Move in steps of max 9% to stay under 10% deviation threshold
    let current = currentPaxg;
    while (current !== newPrice) {
      let next: bigint;
      if (newPrice < current) {
        next = current * 91n / 100n; // 9% decrease
        if (next < newPrice) next = newPrice;
      } else {
        next = current * 109n / 100n; // 9% increase
        if (next > newPrice) next = newPrice;
      }

      await setValidPrice(paxgFeed, next);
      await setValidPrice(xautFeed, next);
      await oracle.getTokenPrice(await paxg.getAddress());
      await oracle.getTokenPrice(await xaut.getAddress());
      current = next;
    }
  }

  async function deploySystem() {
    [owner, user, liquidator, other] = await ethers.getSigners();

    // Deploy mocks
    const MockAgg = await ethers.getContractFactory("MockAggregatorV3");
    paxgFeed = await MockAgg.deploy(8);
    xautFeed = await MockAgg.deploy(8);

    const MockToken = await ethers.getContractFactory("MockERC20");
    paxg = await MockToken.deploy("Pax Gold", "PAXG", 18);
    xaut = await MockToken.deploy("Tether Gold", "XAUT", 6);

    await setValidPrice(paxgFeed, GOLD_PRICE);
    await setValidPrice(xautFeed, GOLD_PRICE);

    // Deploy oracle
    const OracleF = await ethers.getContractFactory("GoldOracle");
    oracle = await OracleF.deploy(
      await paxgFeed.getAddress(),
      await xautFeed.getAddress(),
      await paxg.getAddress(),
      await xaut.getAddress(),
      3600
    );

    // Deploy stablecoin
    const StablecoinF = await ethers.getContractFactory("GoldStablecoin");
    stablecoin = await StablecoinF.deploy();

    // Deploy stability module
    const StabModF = await ethers.getContractFactory("StabilityModule");
    stabilityModule = await StabModF.deploy();

    // Deploy vault
    const VaultF = await ethers.getContractFactory("GoldVault");
    vault = await VaultF.deploy(
      await oracle.getAddress(),
      await stablecoin.getAddress(),
      await stabilityModule.getAddress()
    );

    // Grant roles
    const MINTER_ROLE = await stablecoin.MINTER_ROLE();
    await stablecoin.grantRole(MINTER_ROLE, await vault.getAddress());

    const VAULT_ROLE = await stabilityModule.VAULT_ROLE();
    await stabilityModule.grantRole(VAULT_ROLE, await vault.getAddress());

    // Register collateral types
    const paxgId = ethers.keccak256(ethers.solidityPacked(["address"], [await paxg.getAddress()]));
    const xautId = ethers.keccak256(ethers.solidityPacked(["address"], [await xaut.getAddress()]));
    await vault.addCollateralType(await paxg.getAddress(), MIN_RATIO, LIQ_RATIO, LIQ_PENALTY, DEBT_CEILING);
    await vault.addCollateralType(await xaut.getAddress(), MIN_RATIO, LIQ_RATIO, LIQ_PENALTY, DEBT_CEILING);

    // Init collateral in stability module
    await stabilityModule.initCollateral(paxgId, 200); // 2% annual
    await stabilityModule.initCollateral(xautId, 200);

    // Initialize oracle lastKnownPrices
    await oracle.getTokenPrice(await paxg.getAddress());
    await oracle.getTokenPrice(await xaut.getAddress());

    // Mint tokens to user
    await paxg.mint(user.address, ethers.parseEther("100")); // 100 PAXG
    await xaut.mint(user.address, 100_000_000n); // 100 XAUT (6 dec)

    // Approve vault
    await paxg.connect(user).approve(await vault.getAddress(), ethers.MaxUint256);
    await xaut.connect(user).approve(await vault.getAddress(), ethers.MaxUint256);
  }

  beforeEach(async function () {
    await deploySystem();
  });

  // ========== Constructor ==========
  describe("Constructor", function () {
    it("should revert with zero oracle address", async function () {
      const F = await ethers.getContractFactory("GoldVault");
      await expect(
        F.deploy(ethers.ZeroAddress, await stablecoin.getAddress(), await stabilityModule.getAddress())
      ).to.be.revertedWith("Zero address");
    });

    it("should revert with zero stablecoin address", async function () {
      const F = await ethers.getContractFactory("GoldVault");
      await expect(
        F.deploy(await oracle.getAddress(), ethers.ZeroAddress, await stabilityModule.getAddress())
      ).to.be.revertedWith("Zero address");
    });

    it("should revert with zero stabilityModule address", async function () {
      const F = await ethers.getContractFactory("GoldVault");
      await expect(
        F.deploy(await oracle.getAddress(), await stablecoin.getAddress(), ethers.ZeroAddress)
      ).to.be.revertedWith("Zero address");
    });
  });

  // ========== Collateral Types ==========
  describe("Collateral Types", function () {
    it("should add collateral type with valid params", async function () {
      const MockToken = await ethers.getContractFactory("MockERC20");
      const newToken = await MockToken.deploy("New", "NEW", 18);
      await expect(
        vault.addCollateralType(await newToken.getAddress(), MIN_RATIO, LIQ_RATIO, LIQ_PENALTY, DEBT_CEILING)
      ).to.not.be.reverted;
    });

    it("should revert if already exists", async function () {
      await expect(
        vault.addCollateralType(await paxg.getAddress(), MIN_RATIO, LIQ_RATIO, LIQ_PENALTY, DEBT_CEILING)
      ).to.be.revertedWith("Already exists");
    });

    it("should revert if minRatio <= liquidationRatio", async function () {
      const MockToken = await ethers.getContractFactory("MockERC20");
      const newToken = await MockToken.deploy("New", "NEW", 18);
      await expect(
        vault.addCollateralType(await newToken.getAddress(), LIQ_RATIO, LIQ_RATIO, LIQ_PENALTY, DEBT_CEILING)
      ).to.be.revertedWith("Min ratio must exceed liquidation ratio");
    });

    it("should revert if liquidationRatio < 105%, the headroom the largest oracle clamp needs", async function () {
      const MockToken = await ethers.getContractFactory("MockERC20");
      const newToken = await MockToken.deploy("New", "NEW", 18);
      await expect(
        vault.addCollateralType(await newToken.getAddress(), MIN_RATIO, PRECISION + 49_999n, LIQ_PENALTY, DEBT_CEILING)
      ).to.be.revertedWith("Liquidation ratio must be >= 105%");
      await vault.addCollateralType(await newToken.getAddress(), MIN_RATIO, PRECISION + 50_000n, LIQ_PENALTY, DEBT_CEILING);
    });

    it("should revert if penalty > 200000 (20%)", async function () {
      const MockToken = await ethers.getContractFactory("MockERC20");
      const newToken = await MockToken.deploy("New", "NEW", 18);
      await expect(
        vault.addCollateralType(await newToken.getAddress(), MIN_RATIO, LIQ_RATIO, 200001n, DEBT_CEILING)
      ).to.be.revertedWith("Penalty exceeds 20% max");
    });

    it("updateCollateralRatios should validate same constraints", async function () {
      await expect(
        vault.updateCollateralRatios(await paxg.getAddress(), LIQ_RATIO, LIQ_RATIO, LIQ_PENALTY)
      ).to.be.revertedWith("Min ratio must exceed liquidation ratio");

      await expect(
        vault.updateCollateralRatios(await paxg.getAddress(), MIN_RATIO, PRECISION + 49_999n, LIQ_PENALTY)
      ).to.be.revertedWith("Liquidation ratio must be >= 105%");

      await expect(
        vault.updateCollateralRatios(await paxg.getAddress(), MIN_RATIO, LIQ_RATIO, 200001n)
      ).to.be.revertedWith("Penalty exceeds 20% max");
    });

    // Each setter changes its own fields and nothing else, so a
    // pending operation for one can never restore stale values of the other.
    it("updateCollateralRatios leaves the ceiling alone and setDebtCeiling leaves the ratios alone", async function () {
      const token = await paxg.getAddress();
      const id = ethers.solidityPackedKeccak256(["address"], [token]);
      const before = await vault.collateralTypes(id);
      await expect(vault.updateCollateralRatios(token, MIN_RATIO + 100_000n, LIQ_RATIO + 50_000n, LIQ_PENALTY + 10_000n))
        .to.emit(vault, "CollateralTypeUpdated")
        .withArgs(id);
      let after = await vault.collateralTypes(id);
      expect(after.minRatio).to.equal(MIN_RATIO + 100_000n);
      expect(after.liquidationRatio).to.equal(LIQ_RATIO + 50_000n);
      expect(after.liquidationPenalty).to.equal(LIQ_PENALTY + 10_000n);
      expect(after.debtCeiling).to.equal(before.debtCeiling);

      await expect(vault.setDebtCeiling(token, 7n)).to.emit(vault, "CollateralTypeUpdated").withArgs(id);
      after = await vault.collateralTypes(id);
      expect(after.debtCeiling).to.equal(7n);
      expect(after.minRatio).to.equal(MIN_RATIO + 100_000n);
      expect(after.liquidationRatio).to.equal(LIQ_RATIO + 50_000n);
      expect(after.liquidationPenalty).to.equal(LIQ_PENALTY + 10_000n);
      // Any ceiling is accepted, as before: zero closes minting, the maximum lifts the limit.
      await vault.setDebtCeiling(token, 0n);
      await vault.setDebtCeiling(token, ethers.MaxUint256);
      expect((await vault.collateralTypes(id)).debtCeiling).to.equal(ethers.MaxUint256);
    });
  });

  // Helper to refresh oracle prices to avoid staleness
  async function refreshPrices() {
    await setValidPrice(paxgFeed, GOLD_PRICE);
    await setValidPrice(xautFeed, GOLD_PRICE);
  }

  // ========== Deposit ==========
  describe("Deposit", function () {
    it("should deposit PAXG (18 dec) correctly", async function () {
      const amount = ethers.parseEther("10");
      await vault.connect(user).deposit(await paxg.getAddress(), amount);

      const v = await vault.vaults(user.address);
      expect(v.collateralAmount).to.equal(amount);
      expect(v.collateralToken).to.equal(await paxg.getAddress());
    });

    it("should deposit XAUT (6 dec) correctly", async function () {
      const amount = 10_000_000n; // 10 XAUT
      await vault.connect(user).deposit(await xaut.getAddress(), amount);

      const v = await vault.vaults(user.address);
      expect(v.collateralAmount).to.equal(amount);
    });

    it("should revert with zero amount", async function () {
      await expect(vault.connect(user).deposit(await paxg.getAddress(), 0)).to.be.revertedWith("Zero amount");
    });

    it("should revert with inactive collateral type", async function () {
      const MockToken = await ethers.getContractFactory("MockERC20");
      const unknown = await MockToken.deploy("Unknown", "UNK", 18);
      await unknown.mint(user.address, ethers.parseEther("10"));
      await unknown.connect(user).approve(await vault.getAddress(), ethers.MaxUint256);
      await expect(
        vault.connect(user).deposit(await unknown.getAddress(), ethers.parseEther("1"))
      ).to.be.revertedWith("Collateral type not active");
    });

    it("should revert if second deposit uses different token", async function () {
      await vault.connect(user).deposit(await paxg.getAddress(), ethers.parseEther("5"));
      await expect(
        vault.connect(user).deposit(await xaut.getAddress(), 5_000_000n)
      ).to.be.revertedWith("Collateral token mismatch");
    });

    it("should credit actual received amount for fee-on-transfer tokens", async function () {
      // Deploy fee-on-transfer token
      const FeeToken = await ethers.getContractFactory("MockERC20FeeOnTransfer");
      const feeToken = await FeeToken.deploy("Fee Gold", "FEE", 100); // 1% fee
      await feeToken.mint(user.address, ethers.parseEther("100"));
      await feeToken.connect(user).approve(await vault.getAddress(), ethers.MaxUint256);

      // Register as collateral
      await vault.addCollateralType(await feeToken.getAddress(), MIN_RATIO, LIQ_RATIO, LIQ_PENALTY, DEBT_CEILING);
      const feeTokenId = ethers.keccak256(ethers.solidityPacked(["address"], [await feeToken.getAddress()]));
      await stabilityModule.initCollateral(feeTokenId, 200);

      const depositAmount = ethers.parseEther("10");
      await vault.connect(user).deposit(await feeToken.getAddress(), depositAmount);

      const v = await vault.vaults(user.address);
      // Should credit 99% (1% fee deducted)
      const expected = depositAmount * 99n / 100n;
      expect(v.collateralAmount).to.equal(expected);
    });

    it("refuses a deposit that credits nothing, and leaves no trace of it", async function () {
      // A token whose transfer delivers nothing: the whole amount is taken as a fee.
      const FeeToken = await ethers.getContractFactory("MockERC20FeeOnTransfer");
      const feeToken = await FeeToken.deploy("Fee Gold", "FEE", 10_000);
      const feeAddress = await feeToken.getAddress();
      await feeToken.mint(user.address, ethers.parseEther("100"));
      await feeToken.connect(user).approve(await vault.getAddress(), ethers.MaxUint256);
      await vault.addCollateralType(feeAddress, MIN_RATIO, LIQ_RATIO, LIQ_PENALTY, DEBT_CEILING);

      await expect(vault.connect(user).deposit(feeAddress, ethers.parseEther("10"))).to.be.revertedWith(
        "Nothing credited"
      );
      const v = await vault.vaults(user.address);
      expect(v.collateralToken).to.equal(ethers.ZeroAddress);
      expect(v.collateralAmount).to.equal(0n);
      expect(await feeToken.balanceOf(user.address)).to.equal(ethers.parseEther("100"));
      // The vault did not record itself as holding collateral, so a silo factory can still be
      // wired, which is refused once the vault has taken a deposit without one.
      const factory = await (await ethers.getContractFactory("SiloFactory")).deploy(ethers.parseEther("100"));
      await factory.grantRole(await factory.VAULT_ROLE(), await vault.getAddress());
      await vault.setSiloFactory(await factory.getAddress());
      // The address is not bound to the token, so an ordinary deposit of gold still works.
      await vault.connect(user).deposit(await paxg.getAddress(), ethers.parseEther("1"));
      expect((await vault.vaults(user.address)).collateralToken).to.equal(await paxg.getAddress());
    });

    it("refuses a zero credit through the silo factory as well", async function () {
      const FeeToken = await ethers.getContractFactory("MockERC20FeeOnTransfer");
      const feeToken = await FeeToken.deploy("Fee Gold", "FEE", 10_000);
      const feeAddress = await feeToken.getAddress();
      await feeToken.mint(user.address, ethers.parseEther("100"));
      await feeToken.connect(user).approve(await vault.getAddress(), ethers.MaxUint256);
      await vault.addCollateralType(feeAddress, MIN_RATIO, LIQ_RATIO, LIQ_PENALTY, DEBT_CEILING);
      const factory = await (await ethers.getContractFactory("SiloFactory")).deploy(ethers.parseEther("100"));
      await factory.grantRole(await factory.VAULT_ROLE(), await vault.getAddress());
      await vault.setSiloFactory(await factory.getAddress());

      await expect(vault.connect(user).deposit(feeAddress, ethers.parseEther("10"))).to.be.revertedWith(
        "Nothing credited"
      );
      expect(await factory.getSiloCount(feeAddress)).to.equal(0n);
      expect((await vault.vaults(user.address)).collateralToken).to.equal(ethers.ZeroAddress);
    });
  });

  // ========== Withdraw ==========
  describe("Withdraw", function () {
    beforeEach(async function () {
      await refreshPrices();
      await vault.connect(user).deposit(await paxg.getAddress(), ethers.parseEther("10"));
    });

    it("should withdraw full collateral (no debt)", async function () {
      await vault.connect(user).withdraw(ethers.parseEther("10"));
      const v = await vault.vaults(user.address);
      expect(v.collateralAmount).to.equal(0);
    });

    it("should revert if below min ratio with debt", async function () {
      // Mint large debt so withdrawing most collateral drops below 150%
      await refreshPrices();
      await vault.connect(user).mint(ethers.parseEther("12000"));
      // Refresh prices again for withdraw
      await refreshPrices();
      // 1 PAXG remaining ($2000) vs $12000 debt = 16.7% — well below 150%
      await expect(vault.connect(user).withdraw(ethers.parseEther("9")))
        .to.be.revertedWith("Below min ratio");
    });

    it("holds a withdrawal to the minimum ratio, not the liquidation ratio, and to it exactly", async function () {
      // No stability fee, so the debt is the principal and the boundary is exact.
      const cId = ethers.keccak256(ethers.solidityPacked(["address"], [await paxg.getAddress()]));
      await stabilityModule.setStabilityFee(cId, 0);
      await vault.connect(user).mint(ethers.parseEther("12000"));

      // 8 PAXG left would be $16,000 against 12,000: 133%, above the 110% liquidation
      // ratio and below the 150% minimum. Refused.
      await expect(vault.connect(user).withdraw(ethers.parseEther("2"))).to.be.revertedWith("Below min ratio");
      // 9 PAXG left is exactly 150%: one unit more out is refused, exactly that is allowed.
      await expect(vault.connect(user).withdraw(ethers.parseEther("1") + 1n)).to.be.revertedWith("Below min ratio");
      await vault.connect(user).withdraw(ethers.parseEther("1"));
      expect((await vault.vaults(user.address)).collateralAmount).to.equal(ethers.parseEther("9"));
    });

    it("should revert with zero amount", async function () {
      await expect(vault.connect(user).withdraw(0)).to.be.revertedWith("Zero amount");
    });

    it("should reset collateralToken to address(0) when fully empty", async function () {
      await vault.connect(user).withdraw(ethers.parseEther("10"));
      const v = await vault.vaults(user.address);
      expect(v.collateralToken).to.equal(ethers.ZeroAddress);
    });
  });

  // ========== Mint ==========
  describe("Mint", function () {
    it("should mint GSUSD against PAXG collateral", async function () {
      await vault.connect(user).deposit(await paxg.getAddress(), ethers.parseEther("10"));
      // 10 PAXG * $2000 = $20,000 collateral value
      // At 150% min ratio, max debt ~ $13,333
      await vault.connect(user).mint(ethers.parseEther("1000"));
      expect(await stablecoin.balanceOf(user.address)).to.equal(ethers.parseEther("1000"));
    });

    it("should mint GSUSD against XAUT (6 dec) — ratio correct", async function () {
      // Deposit 10 XAUT (6 dec)
      await vault.connect(user).deposit(await xaut.getAddress(), 10_000_000n);
      // 10 XAUT * $2000 = $20,000 collateral value
      await vault.connect(user).mint(ethers.parseEther("1000"));
      expect(await stablecoin.balanceOf(user.address)).to.equal(ethers.parseEther("1000"));
    });

    it("should revert below min ratio", async function () {
      await vault.connect(user).deposit(await paxg.getAddress(), ethers.parseEther("1"));
      // 1 PAXG = $2000. At 150% min ratio, max debt = $1333
      await expect(vault.connect(user).mint(ethers.parseEther("1400")))
        .to.be.revertedWith("Below min collateralisation ratio");
    });

    it("should revert if exceeds debt ceiling", async function () {
      // Update ceiling to tiny amount
      await vault.setDebtCeiling(await paxg.getAddress(), ethers.parseEther("500"));
      await vault.connect(user).deposit(await paxg.getAddress(), ethers.parseEther("10"));
      await expect(vault.connect(user).mint(ethers.parseEther("501")))
        .to.be.revertedWith("Debt ceiling reached");
    });

    it("counts accrued fees in the ratio a mint must keep", async function () {
      const cId = ethers.keccak256(ethers.solidityPacked(["address"], [await paxg.getAddress()]));
      await vault.connect(user).deposit(await paxg.getAddress(), ethers.parseEther("10"));
      await vault.connect(user).mint(ethers.parseEther("1000"));
      // A year of fees, then the rate goes to zero so the debt stands still below.
      await time.increase(365 * 24 * 60 * 60);
      await stabilityModule.setStabilityFee(cId, 0);
      await refreshPrices();
      const principal = (await vault.vaults(user.address)).debtAmount;
      const owed = await stabilityModule.getCurrentDebt(user.address, cId);
      expect(owed - principal).to.be.gt(ethers.parseEther("19"));

      // $20,000 of gold carries at most 13,333.33 of debt at 150%, fees included.
      const most = (ethers.parseEther("20000") * PRECISION) / MIN_RATIO;
      // Enough room if only the principal counted; refused because the fee counts too.
      await expect(vault.connect(user).mint(most - principal)).to.be.revertedWith("Below min collateralisation ratio");
      await expect(vault.connect(user).mint(most - owed + 1n)).to.be.revertedWith("Below min collateralisation ratio");
      await vault.connect(user).mint(most - owed);
      expect(await stabilityModule.getCurrentDebt(user.address, cId)).to.be.closeTo(most, 1n);
    });

    it("values a mint and a withdrawal at the borrowing price, the lower of the market and gold", async function () {
      const cId = ethers.keccak256(ethers.solidityPacked(["address"], [await paxg.getAddress()]));
      await stabilityModule.setStabilityFee(cId, 0);
      // Gold at $2,000 and the token's own market 1% above it, inside the band: borrowing
      // is valued at $2,000 while a liquidation would be sized at $2,020.
      const gold = await (await ethers.getContractFactory("MockAggregatorV3")).deploy(8);
      await setValidPrice(gold, GOLD_PRICE);
      await oracle.setAnchorFeed(await gold.getAddress());
      await setValidPrice(paxgFeed, (GOLD_PRICE * 101n) / 100n);
      expect(await oracle.quoteBorrowPrice(await paxg.getAddress())).to.equal(GOLD_PRICE);
      expect(await oracle.quoteTokenPrice(await paxg.getAddress())).to.equal((GOLD_PRICE * 101n) / 100n);

      await vault.connect(user).deposit(await paxg.getAddress(), ethers.parseEther("10"));
      // 10 PAXG is $20,000 at the borrowing price: 13,333.33 of debt at most. At $2,020 it
      // would be 13,466.66.
      const most = (ethers.parseEther("20000") * PRECISION) / MIN_RATIO;
      await expect(vault.connect(user).mint(most + 1n)).to.be.revertedWith("Below min collateralisation ratio");
      await vault.connect(user).mint(ethers.parseEther("12000"));

      // 9 PAXG is exactly 150% of 12,000 at $2,000; at $2,020 a little less gold would do.
      await expect(vault.connect(user).withdraw(ethers.parseEther("1") + 1n)).to.be.revertedWith("Below min ratio");
      await vault.connect(user).withdraw(ethers.parseEther("1"));
    });

    it("mints up to exactly the debt ceiling and not one wei over", async function () {
      const ceiling = ethers.parseEther("500");
      await vault.setDebtCeiling(await paxg.getAddress(), ceiling);
      await vault.connect(user).deposit(await paxg.getAddress(), ethers.parseEther("10"));
      await expect(vault.connect(user).mint(ceiling + 1n)).to.be.revertedWith("Debt ceiling reached");
      await vault.connect(user).mint(ceiling);
      const cId = ethers.keccak256(ethers.solidityPacked(["address"], [await paxg.getAddress()]));
      expect((await vault.collateralTypes(cId)).totalDebt).to.equal(ceiling);
      // Full: the next unit is refused.
      await expect(vault.connect(user).mint(1n)).to.be.revertedWith("Debt ceiling reached");
    });

    it("should revert with zero amount", async function () {
      await vault.connect(user).deposit(await paxg.getAddress(), ethers.parseEther("10"));
      await expect(vault.connect(user).mint(0)).to.be.revertedWith("Zero amount");
    });

    it("should revert if total debt < MIN_DEBT (100 GSUSD)", async function () {
      await vault.connect(user).deposit(await paxg.getAddress(), ethers.parseEther("10"));
      await expect(vault.connect(user).mint(ethers.parseEther("99")))
        .to.be.revertedWith("Below minimum debt");
    });

    it("should accept exactly MIN_DEBT", async function () {
      await vault.connect(user).deposit(await paxg.getAddress(), ethers.parseEther("10"));
      await expect(vault.connect(user).mint(ethers.parseEther("100"))).to.not.be.reverted;
    });
  });

  // ========== Repay ==========
  describe("Repay", function () {
    beforeEach(async function () {
      // Refresh prices
      await setValidPrice(paxgFeed, GOLD_PRICE);
      await setValidPrice(xautFeed, GOLD_PRICE);

      await vault.connect(user).deposit(await paxg.getAddress(), ethers.parseEther("10"));
      await vault.connect(user).mint(ethers.parseEther("1000"));
      // Approve vault to take stablecoin for repay
      await stablecoin.connect(user).approve(await vault.getAddress(), ethers.MaxUint256);
    });

    it("should fully repay and clear debt", async function () {
      // Use 0% fee to avoid time-dependent debt growth between read and repay
      const cId = ethers.keccak256(ethers.solidityPacked(["address"], [await paxg.getAddress()]));
      // Set stability fee to 0 so debt doesn't grow between blocks
      await stabilityModule.setStabilityFee(cId, 0);

      const currentDebt = await stabilityModule.getCurrentDebt(user.address, cId);
      const MINTER_ROLE = await stablecoin.MINTER_ROLE();
      await stablecoin.grantRole(MINTER_ROLE, owner.address);
      await stablecoin.mint(user.address, ethers.parseEther("10"));
      await vault.connect(user).repay(currentDebt);
      const v = await vault.vaults(user.address);
      expect(v.debtAmount).to.equal(0);
    });

    it("should reduce principal pro-rata on partial repay", async function () {
      const cId = ethers.keccak256(ethers.solidityPacked(["address"], [await paxg.getAddress()]));
      // Advance time to accrue meaningful fees
      await time.increase(365 * 24 * 3600);
      await refreshPrices();

      const currentDebt = await stabilityModule.getCurrentDebt(user.address, cId);
      const vBefore = await vault.vaults(user.address);
      const principalBefore = vBefore.debtAmount;

      // Repay 40% of current debt (enough that remaining debt > MIN_DEBT)
      const repayAmount = currentDebt * 40n / 100n;
      // Mint extra stablecoin to cover fees
      const MINTER_ROLE = await stablecoin.MINTER_ROLE();
      await stablecoin.grantRole(MINTER_ROLE, owner.address);
      await stablecoin.mint(user.address, ethers.parseEther("500")); // extra for fees

      await vault.connect(user).repay(repayAmount);

      const vAfter = await vault.vaults(user.address);
      // Principal should be reduced by ~40% (pro-rata)
      const expectedPrincipal = principalBefore * 60n / 100n;
      // Allow tolerance for rounding and time advancement
      const tolerance = principalBefore / 100n; // 1% tolerance
      expect(vAfter.debtAmount).to.be.closeTo(expectedPrincipal, tolerance);
    });

    it("caps an overshoot at currentDebt and fully closes the vault", async function () {
      const cId = ethers.keccak256(ethers.solidityPacked(["address"], [await paxg.getAddress()]));
      const currentDebt = await stabilityModule.getCurrentDebt(user.address, cId);
      // Mint extra so we have enough tokens
      const MINTER_ROLE = await stablecoin.MINTER_ROLE();
      await stablecoin.grantRole(MINTER_ROLE, owner.address);
      await stablecoin.mint(user.address, ethers.parseEther("100"));

      const balBefore = await stablecoin.balanceOf(user.address);
      await stablecoin.connect(user).approve(await vault.getAddress(), balBefore);
      await vault.connect(user).repay(currentDebt + ethers.parseEther("50"));

      // Debt is fully cleared and only the true current debt was pulled — the
      // 50 GSUSD overshoot stays with the user.
      const v = await vault.vaults(user.address);
      expect(v.debtAmount).to.equal(0n);
      const paid = balBefore - (await stablecoin.balanceOf(user.address));
      expect(paid).to.be.closeTo(currentDebt, ethers.parseEther("1"));
      expect(await stabilityModule.normalisedDebt(user.address, cId)).to.equal(0n);
    });

    it("should revert with zero amount", async function () {
      await expect(vault.connect(user).repay(0)).to.be.revertedWith("Zero amount");
    });

    it("should revert if remaining debt < MIN_DEBT", async function () {
      // Repay almost everything leaving < 100 GSUSD principal
      // Current debt ~ 1000, try to repay 950 leaving 50
      await expect(vault.connect(user).repay(ethers.parseEther("950")))
        .to.be.revertedWith("Remaining debt below minimum");
    });

    it("a repayment leaving exactly minDebt succeeds, and one unit more repaid is refused", async function () {
      // A second borrower with no stability fee, so principal and debt are the same figure.
      const cId = ethers.keccak256(ethers.solidityPacked(["address"], [await paxg.getAddress()]));
      await stabilityModule.setStabilityFee(cId, 0);
      await paxg.mint(other.address, ethers.parseEther("10"));
      await paxg.connect(other).approve(await vault.getAddress(), ethers.MaxUint256);
      await vault.connect(other).deposit(await paxg.getAddress(), ethers.parseEther("10"));
      await vault.connect(other).mint(ethers.parseEther("1000"));
      await stablecoin.connect(other).approve(await vault.getAddress(), ethers.MaxUint256);
      const minDebt = await vault.minDebt();

      const toFloor = ethers.parseEther("1000") - minDebt;
      await expect(vault.connect(other).repay(toFloor + 1n)).to.be.revertedWith("Remaining debt below minimum");
      await vault.connect(other).repay(toFloor);
      expect((await vault.vaults(other.address)).debtAmount).to.equal(minDebt);
      expect(await stabilityModule.getCurrentDebt(other.address, cId)).to.equal(minDebt);
    });

    it("splits a partial repayment with the principal share rounded down", async function () {
      // Wire a buffer so the fee share is banked and can be read back to the wei.
      const buffer = await (await ethers.getContractFactory("SurplusBuffer")).deploy(await stablecoin.getAddress());
      await buffer.grantRole(await buffer.VAULT_ROLE(), await vault.getAddress());
      await vault.setSurplusBuffer(await buffer.getAddress());

      // A year of fees, then the rate goes to zero so the debt stands still between the
      // read below and the repayment.
      const cId = ethers.keccak256(ethers.solidityPacked(["address"], [await paxg.getAddress()]));
      await time.increase(365 * 24 * 60 * 60);
      await stabilityModule.setStabilityFee(cId, 0);
      const principal = (await vault.vaults(user.address)).debtAmount;
      const currentDebt = await stabilityModule.getCurrentDebt(user.address, cId);
      expect(currentDebt).to.be.gt(principal);

      const amount = ethers.parseEther("333") + 1n;
      // The split is not whole, so the rounding direction decides the last unit.
      expect((principal * amount) % currentDebt).to.not.equal(0n);
      const principalShare = (principal * amount) / currentDebt;
      const supplyBefore = await stablecoin.totalSupply();
      const balanceBefore = await stablecoin.balanceOf(user.address);

      await vault.connect(user).repay(amount);

      expect((await vault.vaults(user.address)).debtAmount).to.equal(principal - principalShare);
      expect((await vault.collateralTypes(cId)).totalDebt).to.equal(principal - principalShare);
      expect(await buffer.totalFeesReceived()).to.equal(amount - principalShare);
      expect(supplyBefore - (await stablecoin.totalSupply())).to.equal(principalShare);
      expect(balanceBefore - (await stablecoin.balanceOf(user.address))).to.equal(amount);
    });

    it("should work when oracle is paused (repay has no whenNotPaused)", async function () {
      // Set 0% fee to avoid time-dependent issues
      const cId = ethers.keccak256(ethers.solidityPacked(["address"], [await paxg.getAddress()]));
      await stabilityModule.setStabilityFee(cId, 0);

      // Pause the vault directly (repay has no whenNotPaused, so it should still work)
      await vault.pause();

      // repay doesn't have whenNotPaused, so it should work even when vault is paused
      const currentDebt = await stabilityModule.getCurrentDebt(user.address, cId);
      const MINTER_ROLE = await stablecoin.MINTER_ROLE();
      await stablecoin.grantRole(MINTER_ROLE, owner.address);
      await stablecoin.mint(user.address, ethers.parseEther("10"));
      await expect(vault.connect(user).repay(currentDebt)).to.not.be.reverted;
    });
  });

  // ========== Liquidation ==========
  describe("Liquidation", function () {
    beforeEach(async function () {
      // Refresh prices
      await setValidPrice(paxgFeed, GOLD_PRICE);
      await setValidPrice(xautFeed, GOLD_PRICE);

      // User deposits 10 PAXG ($20,000) and mints 12,000 GSUSD (ratio = 166%)
      await vault.connect(user).deposit(await paxg.getAddress(), ethers.parseEther("10"));
      await vault.connect(user).mint(ethers.parseEther("12000"));

      // Give liquidator stablecoin
      const MINTER_ROLE = await stablecoin.MINTER_ROLE();
      await stablecoin.grantRole(MINTER_ROLE, owner.address);
      await stablecoin.mint(liquidator.address, ethers.parseEther("20000"));
      await stablecoin.connect(liquidator).approve(await vault.getAddress(), ethers.MaxUint256);
    });

    it("should liquidate undercollateralised vault", async function () {
      // Drop price to make vault undercollateralised (below 110%)
      const lowPrice = 120000000000n; // $1200
      await setOraclePrice(lowPrice);

      // 0 = the whole fee-inclusive debt. Passing the 12,000 principal is a partial
      // (fees have accrued), and below 100% plus the penalty every partial is refused:
      // it would strand principal the gold could have paid.
      await expect(
        vault.connect(liquidator).liquidate(user.address, ethers.parseEther("12000"))
      ).to.be.revertedWith("Thin vault: liquidate in full");
      await expect(
        vault.connect(liquidator).liquidate(user.address, 0)
      ).to.emit(vault, "Liquidated");
      const v = await vault.vaults(user.address);
      expect(v.debtAmount).to.equal(0);
      // 10 PAXG at $1,200 is worth exactly the 12,000 principal and the accrued fee puts
      // the vault a hair under water. The underwater discount is capped at the shortfall,
      // so the bad debt is at most twice that fraction of a cent of fee, not the
      // flat 240 GSUSD discount a borrower could once collect from the buffer.
      const bad = await vault.totalBadDebt();
      expect(bad).to.be.gt(0n);
      expect(bad).to.be.lt(ethers.parseEther("0.01"));
    });

    it("should revert if ratio >= liquidationRatio", async function () {
      // Price stays at $2000, ratio = 166% > 110%
      await expect(
        vault.connect(liquidator).liquidate(user.address, ethers.parseEther("1000"))
      ).to.be.revertedWith("Not undercollateralised");
    });

    it("should retain penalty as surplusCollateral", async function () {
      // $1,280: 106.67%, inside the liquidation band and above 100% plus the penalty,
      // so a partial is accepted (partials are refused below that line).
      const lowPrice = 128000000000n;
      await setOraclePrice(lowPrice);

      const surplusBefore = await vault.surplusCollateral(await paxg.getAddress());
      await vault.connect(liquidator).liquidate(user.address, ethers.parseEther("6000"));
      const surplusAfter = await vault.surplusCollateral(await paxg.getAddress());

      expect(surplusAfter).to.be.gt(surplusBefore);
    });

    it("should give liquidator a bonus (incentive share of penalty)", async function () {
      const lowPrice = 128000000000n; // $1280, 106.67%
      await setOraclePrice(lowPrice);

      const liqBalBefore = await paxg.balanceOf(liquidator.address);
      await vault.connect(liquidator).liquidate(user.address, ethers.parseEther("6000"));
      const liqBalAfter = await paxg.balanceOf(liquidator.address);

      const received = liqBalAfter - liqBalBefore;
      // Debt-equivalent collateral at $1280: 6000 / 1280 = 4.6875 PAXG
      const debtEquiv = ethers.parseEther("4.6875");
      // Liquidator should receive MORE than debt-equivalent (their bonus share of penalty)
      expect(received).to.be.gt(debtEquiv);
    });

    it("should handle bad debt prevention (insufficient collateral)", async function () {
      // Extreme price drop — collateral worth less than debt
      const veryLowPrice = 50000000000n; // $500
      await setOraclePrice(veryLowPrice);

      // Full liquidation attempt — should not revert, should proportionally reduce
      await expect(
        vault.connect(liquidator).liquidate(user.address, 0) // 0 = full
      ).to.not.be.reverted;

      const v = await vault.vaults(user.address);
      expect(v.collateralAmount).to.equal(0);
    });

    it("should correctly compute collateral for XAUT (6 dec)", async function () {
      // New user with XAUT
      await refreshPrices();
      await xaut.mint(other.address, 10_000_000n); // 10 XAUT
      await xaut.connect(other).approve(await vault.getAddress(), ethers.MaxUint256);
      await vault.connect(other).deposit(await xaut.getAddress(), 10_000_000n);
      await refreshPrices();
      await vault.connect(other).mint(ethers.parseEther("12000"));

      // Drop price to $1280 (106.67%), where a partial is still accepted
      const lowPrice = 128000000000n;
      await setOraclePrice(lowPrice);

      await stablecoin.mint(liquidator.address, ethers.parseEther("20000"));

      const liqBalBefore = await xaut.balanceOf(liquidator.address);
      await vault.connect(liquidator).liquidate(other.address, ethers.parseEther("6000"));
      const liqBalAfter = await xaut.balanceOf(liquidator.address);

      // Liquidator should receive XAUT in 6-decimal units
      expect(liqBalAfter - liqBalBefore).to.be.gt(0);
    });

    it("should seize exact collateral amounts for PAXG (18 dec) liquidation", async function () {
      // Setup: 10 PAXG @ $2000 = $20,000, debt = 12,000 GSUSD, ratio = 166%
      // Drop to $1280 → ratio = 106.67% < 110% → liquidatable, and above 105% so a
      // partial is accepted
      // Partial liquidation of 6000 GSUSD
      //
      // Formula verification:
      //   decimalScale = 10^(18-18) = 1
      //   collateralToSeize = 6000e18 * (1e6 + 50000) * 1e8 / (1280e8 * 1e6 * 1) = 4.921875e18
      //   debtEquivCollateral = 6000e18 * 1e8 / (1280e8 * 1) = 4.6875e18
      //   totalPenalty = 0.234375e18
      //   liquidatorBonus = 0.234375e18 * 600000 / 1e6 = 0.140625e18
      //   protocolShare = 0.09375e18
      //   liquidatorCollateral = 4.6875e18 + 0.140625e18 = 4.828125e18
      const lowPrice = 128000000000n; // $1280 (8 decimals)
      await setOraclePrice(lowPrice);

      const liqBalBefore = await paxg.balanceOf(liquidator.address);
      const surplusBefore = await vault.surplusCollateral(await paxg.getAddress());
      const vaultBefore = await vault.vaults(user.address);

      await vault.connect(liquidator).liquidate(user.address, ethers.parseEther("6000"));

      const liqBalAfter = await paxg.balanceOf(liquidator.address);
      const surplusAfter = await vault.surplusCollateral(await paxg.getAddress());
      const vaultAfter = await vault.vaults(user.address);

      const liquidatorReceived = liqBalAfter - liqBalBefore;
      const surplusGained = surplusAfter - surplusBefore;
      const collateralSeized = vaultBefore.collateralAmount - vaultAfter.collateralAmount;

      // Exact expected values
      const expectedCollateralToSeize = ethers.parseEther("4.921875");
      const expectedLiquidatorCollateral = ethers.parseEther("4.828125");
      const expectedProtocolShare = ethers.parseEther("0.09375");

      expect(collateralSeized).to.equal(expectedCollateralToSeize);
      expect(liquidatorReceived).to.equal(expectedLiquidatorCollateral);
      expect(surplusGained).to.equal(expectedProtocolShare);
    });

    it("should seize exact collateral amounts for XAUT (6 dec) liquidation", async function () {
      // Setup: separate user deposits 10 XAUT @ $2000, mints 12000 GSUSD
      await refreshPrices();
      await xaut.mint(other.address, 10_000_000n); // 10 XAUT (6 dec)
      await xaut.connect(other).approve(await vault.getAddress(), ethers.MaxUint256);
      await vault.connect(other).deposit(await xaut.getAddress(), 10_000_000n);
      await refreshPrices();
      await vault.connect(other).mint(ethers.parseEther("12000"));
      await stablecoin.mint(liquidator.address, ethers.parseEther("20000"));

      // Drop to $1280 → ratio = 106.67% < 110%, above 105% so a partial is accepted
      const lowPrice = 128000000000n; // $1280
      await setOraclePrice(lowPrice);

      // Formula verification for XAUT (6 dec):
      //   decimalScale = 10^(18-6) = 1e12
      //   collateralToSeize = 6000e18 * 1050000 * 1e8 / (1280e8 * 1e6 * 1e12) = 4_921_875
      //   debtEquivCollateral = 6000e18 * 1e8 / (1280e8 * 1e12) = 4_687_500
      //   totalPenalty = 234_375
      //   liquidatorBonus = 234_375 * 600_000 / 1e6 = 140_625
      //   protocolShare = 93_750
      //   liquidatorCollateral = 4_687_500 + 140_625 = 4_828_125
      const liqBalBefore = await xaut.balanceOf(liquidator.address);
      const surplusBefore = await vault.surplusCollateral(await xaut.getAddress());
      const vaultBefore = await vault.vaults(other.address);

      await vault.connect(liquidator).liquidate(other.address, ethers.parseEther("6000"));

      const liqBalAfter = await xaut.balanceOf(liquidator.address);
      const surplusAfter = await vault.surplusCollateral(await xaut.getAddress());
      const vaultAfter = await vault.vaults(other.address);

      const liquidatorReceived = liqBalAfter - liqBalBefore;
      const surplusGained = surplusAfter - surplusBefore;
      const collateralSeized = vaultBefore.collateralAmount - vaultAfter.collateralAmount;

      expect(collateralSeized).to.equal(4_921_875n);
      expect(liquidatorReceived).to.equal(4_828_125n);
      expect(surplusGained).to.equal(93_750n);
    });

    it("should seize exact amounts for full liquidation of PAXG vault", async function () {
      // 10 PAXG @ $1200 = $12,000 collateral, ~12,000 GSUSD debt → ratio ≈ 100%
      // Full liquidation (debtToRepay = currentDebt)
      const lowPrice = 120000000000n; // $1200
      await setOraclePrice(lowPrice);

      const paxgAddr = await paxg.getAddress();
      const colId = ethers.keccak256(ethers.solidityPacked(["address"], [paxgAddr]));
      const currentDebt = await stabilityModule.getCurrentDebt(user.address, colId);

      // For full liquidation:
      //   collateralToSeize = currentDebt * 1.05 / 1200 (in 18-dec PAXG)
      //   If collateralToSeize > 10 PAXG, it gets capped at 10 PAXG and debtToRepay is reduced
      const expectedSeize = (currentDebt * 1050000n * 100000000n) / (120000000000n * 1000000n);

      const liqBalBefore = await paxg.balanceOf(liquidator.address);
      const vaultBefore = await vault.vaults(user.address);

      await vault.connect(liquidator).liquidate(user.address, 0); // 0 = full

      const liqBalAfter = await paxg.balanceOf(liquidator.address);
      const vaultAfter = await vault.vaults(user.address);

      if (expectedSeize <= vaultBefore.collateralAmount) {
        // Normal full liquidation — exact amounts
        const collateralSeized = vaultBefore.collateralAmount - vaultAfter.collateralAmount;
        expect(collateralSeized).to.equal(expectedSeize);

        const debtEquiv = (currentDebt * 100000000n) / 120000000000n;
        const totalPenalty = expectedSeize - debtEquiv;
        const liquidatorBonus = (totalPenalty * 600000n) / 1000000n;
        const expectedLiquidatorCollateral = debtEquiv + liquidatorBonus;
        expect(liqBalAfter - liqBalBefore).to.equal(expectedLiquidatorCollateral);
      } else {
        // Bad debt path — all collateral seized
        expect(vaultAfter.collateralAmount).to.equal(0n);
      }
    });
  });

  // ========== Emergency Liquidation ==========
  describe("Emergency Liquidation", function () {
    beforeEach(async function () {
      // Refresh prices
      await setValidPrice(paxgFeed, GOLD_PRICE);
      await setValidPrice(xautFeed, GOLD_PRICE);

      await vault.connect(user).deposit(await paxg.getAddress(), ethers.parseEther("10"));
      await vault.connect(user).mint(ethers.parseEther("12000"));

      const MINTER_ROLE = await stablecoin.MINTER_ROLE();
      await stablecoin.grantRole(MINTER_ROLE, owner.address);
      await stablecoin.mint(liquidator.address, ethers.parseEther("20000"));
      await stablecoin.connect(liquidator).approve(await vault.getAddress(), ethers.MaxUint256);
    });

    it("should work when vault is paused", async function () {
      // Move price down to $1280 (undercollateralised at 106.67%) in steps
      const lowPrice = 128000000000n; // $1280
      await setOraclePrice(lowPrice);

      // Now trigger pause via circuit breaker (spike price up significantly)
      const spikePrice = lowPrice * 2n; // $2560, more than 10% from $1280
      await setValidPrice(paxgFeed, spikePrice);
      await setValidPrice(xautFeed, spikePrice);
      // This will trigger circuit breaker, pause oracle, but also update lastKnown
      // So lastKnown becomes spikePrice. We need lastKnown to stay at lowPrice.
      // Different approach: trigger pause by reading just PAXG with spike.
      // After pause, lastKnownPaxg = spikePrice (updated after deviation check runs).
      // We need lastKnown to be at a low price for emergency liquidation to work.
      //
      // Better approach: set feeds to low price, getTokenPrice to update lastKnown,
      // then just use vault.pause() to simulate the paused state.
      await setValidPrice(paxgFeed, lowPrice);
      await setValidPrice(xautFeed, lowPrice);

      // Pause the vault directly (simulates oracle-triggered pause)
      await vault.pause();

      // Now lastKnownPaxgPrice = $1280, vault is undercollateralised
      // emergencyLiquidate requires vault to be paused, uses getLastKnownPrice
      await vault.connect(liquidator).emergencyLiquidate(user.address, ethers.parseEther("6000"));

      const v = await vault.vaults(user.address);
      expect(v.debtAmount).to.be.lt(ethers.parseEther("12000"));
    });

    it("should revert when NOT paused", async function () {
      await expect(
        vault.connect(liquidator).emergencyLiquidate(user.address, ethers.parseEther("1000"))
      ).to.be.revertedWith("Not in emergency");
    });

    /** Sets the XAU/USD gold reference: the single-feed glitch protection now rests on the gold band. */
    async function goldReferenceAt(price: bigint) {
      const anchor = await (await ethers.getContractFactory("MockAggregatorV3")).deploy(8);
      await setValidPrice(anchor, price);
      await oracle.setAnchorFeed(await anchor.getAddress());
      return anchor;
    }

    it("during a crash, fires once gold confirms the move when ONLY the oracle is paused", async function () {
      // Vault: 10 PAXG / 12000 debt. lastKnown = $2000 (set during mint in beforeEach).
      const anchor = await goldReferenceAt(GOLD_PRICE);
      const crashPrice = 128000000000n; // $1280
      await setValidPrice(paxgFeed, crashPrice); // PAXG alone prints $1280; gold holds
      await oracle.emergencyPause();

      expect(await oracle.paused()).to.be.true;
      expect(await vault.paused()).to.be.false;

      // No rule gives a normal price, so emergencyLiquidate prices at the floor
      // max(lastKnown $2000, live $1280) = $2000, at which the vault is healthy.
      await expect(
        vault.connect(liquidator).emergencyLiquidate(user.address, ethers.parseEther("6000"))
      ).to.be.revertedWith("Not undercollateralised");

      // Gold itself falls: XAU/USD corroborates the move and the normal price is $1280, so the
      // emergency liquidation fires at the true price with no resync.
      await setValidPrice(anchor, crashPrice);
      await setValidPrice(paxgFeed, crashPrice);
      await expect(
        vault.connect(liquidator).emergencyLiquidate(user.address, ethers.parseEther("6000"))
      ).to.emit(vault, "Liquidated");

      const v = await vault.vaults(user.address);
      expect(v.debtAmount).to.be.lt(ethers.parseEther("12000"));
    });

    it("refuses to seize a vault healthy at the live price even if a stale anchor says otherwise", async function () {
      // Drive lastKnown DOWN to $1200 (stale-low), then spike the live feed UP to $2400 and pause.
      await setOraclePrice(120000000000n); // lastKnown = $1200
      const spikePrice = 240000000000n; // live $2400
      await setValidPrice(paxgFeed, spikePrice);
      await setValidPrice(xautFeed, spikePrice);
      await oracle.emergencyPause(); // oracle pauses; lastKnown stays $1200

      expect(await oracle.paused()).to.be.true;

      // At max(lastKnown $1200, live $2400) = $2400 the vault is 200% collateralised (healthy). The
      // stale $1200 anchor must NOT be usable to seize it -- the over-seizure exploit, blocked.
      await expect(
        vault.connect(liquidator).emergencyLiquidate(user.address, ethers.parseEther("6000"))
      ).to.be.revertedWith("Not undercollateralised");
    });

    it("refuses to seize a healthy vault on a transient single-feed glitch-DOWN (regression)", async function () {
      // A transient anomalous PAXG round prints $1300 while gold holds: liquidation values
      // the collateral at gold, $2000, and the vault stays healthy.
      await goldReferenceAt(GOLD_PRICE);
      await setValidPrice(paxgFeed, 130000000000n);
      expect(await oracle.quoteTokenPrice(await paxg.getAddress())).to.equal(GOLD_PRICE);
      await expect(
        vault.connect(liquidator).liquidate(user.address, ethers.parseEther("6000"))
      ).to.be.revertedWith("Not undercollateralised");
      await oracle.freezeToken(await paxg.getAddress()); // the guardian's manual stop
      expect(await oracle.tokenFrozen(await paxg.getAddress())).to.be.true;

      // Frozen and not paused: the freeze stops every seizure, emergency ones included.
      await expect(
        vault.connect(liquidator).emergencyLiquidate(user.address, ethers.parseEther("6000"))
      ).to.be.revertedWith("Token frozen");
    });

    it("under a guardian pause, a single-feed glitch-DOWN still cannot seize a healthy vault", async function () {
      await goldReferenceAt(GOLD_PRICE);
      await setValidPrice(paxgFeed, 130000000000n); // $1300 glitch, lastKnown $2000
      await oracle.emergencyPause();
      // The rules value the glitch at gold, $2000: the vault stays at 166%.
      await expect(
        vault.connect(liquidator).emergencyLiquidate(user.address, ethers.parseEther("6000"))
      ).to.be.revertedWith("Not undercollateralised");
    });
  });

  // ========== Surplus ==========
  describe("Surplus", function () {
    it("should withdraw surplus to recipient", async function () {
      // Refresh prices
      await setValidPrice(paxgFeed, GOLD_PRICE);
      await setValidPrice(xautFeed, GOLD_PRICE);

      // Create surplus via liquidation
      await vault.connect(user).deposit(await paxg.getAddress(), ethers.parseEther("10"));
      await vault.connect(user).mint(ethers.parseEther("12000"));

      const MINTER_ROLE = await stablecoin.MINTER_ROLE();
      await stablecoin.grantRole(MINTER_ROLE, owner.address);
      await stablecoin.mint(liquidator.address, ethers.parseEther("20000"));
      await stablecoin.connect(liquidator).approve(await vault.getAddress(), ethers.MaxUint256);

      const lowPrice = 128000000000n; // $1280: a partial is accepted above 105%
      await setOraclePrice(lowPrice);

      await vault.connect(liquidator).liquidate(user.address, ethers.parseEther("6000"));

      const surplus = await vault.surplusCollateral(await paxg.getAddress());
      expect(surplus).to.be.gt(0);

      const recipientBalBefore = await paxg.balanceOf(other.address);
      await vault.withdrawSurplus(await paxg.getAddress(), other.address, surplus);
      const recipientBalAfter = await paxg.balanceOf(other.address);
      expect(recipientBalAfter - recipientBalBefore).to.equal(surplus);
    });

    it("should revert if exceeds surplus", async function () {
      await expect(
        vault.withdrawSurplus(await paxg.getAddress(), other.address, 1)
      ).to.be.revertedWith("Exceeds surplus");
    });

    it("should revert with zero address recipient", async function () {
      await expect(
        vault.withdrawSurplus(await paxg.getAddress(), ethers.ZeroAddress, 0)
      ).to.be.revertedWith("Zero address");
    });
  });

  // ========== Admin ==========
  describe("Admin", function () {
    it("setOracle should reject zero address", async function () {
      await expect(vault.setOracle(ethers.ZeroAddress)).to.be.revertedWith("Zero address");
    });

    it("setLiquidatorIncentiveShare should update share", async function () {
      await vault.setLiquidatorIncentiveShare(800000); // 80%
      expect(await vault.liquidatorIncentiveShare()).to.equal(800000);
    });

    it("setLiquidatorIncentiveShare should reject > 100%", async function () {
      await expect(vault.setLiquidatorIncentiveShare(1000001))
        .to.be.revertedWith("Share exceeds 100%");
    });

    it("transferGovernance should transfer roles and revoke deployer", async function () {
      const GOVERNANCE_ROLE = await vault.GOVERNANCE_ROLE();
      const DEFAULT_ADMIN = await vault.DEFAULT_ADMIN_ROLE();
      // Must be a contract: an EOA typo in this one-shot handover was a dead protocol.
      const newAdmin = await stablecoin.getAddress();

      await expect(vault.transferGovernance(other.address)).to.be.revertedWith("Timelock must be a contract");
      await vault.transferGovernance(newAdmin);

      expect(await vault.hasRole(GOVERNANCE_ROLE, newAdmin)).to.be.true;
      expect(await vault.hasRole(DEFAULT_ADMIN, newAdmin)).to.be.true;
      expect(await vault.hasRole(GOVERNANCE_ROLE, owner.address)).to.be.false;
      expect(await vault.hasRole(DEFAULT_ADMIN, owner.address)).to.be.false;
    });

    it("transferGovernance should reject zero address", async function () {
      await expect(vault.transferGovernance(ethers.ZeroAddress))
        .to.be.revertedWith("Zero address");
    });
  });

  // ========== SiloFactory Integration ==========
  describe("SiloFactory Integration", function () {
    it("setSiloFactory should accept a factory that has granted the vault VAULT_ROLE", async function () {
      const SiloF = await ethers.getContractFactory("SiloFactory");
      const siloFactory = await SiloF.deploy(ethers.parseEther("100"));
      await siloFactory.grantRole(await siloFactory.VAULT_ROLE(), await vault.getAddress());
      await vault.setSiloFactory(await siloFactory.getAddress());
      expect(await vault.siloFactory()).to.equal(await siloFactory.getAddress());
    });

    it("setSiloFactory refuses a factory that would reject every deposit", async function () {
      const SiloF = await ethers.getContractFactory("SiloFactory");
      const siloFactory = await SiloF.deploy(ethers.parseEther("100"));
      await expect(vault.setSiloFactory(await siloFactory.getAddress())).to.be.revertedWith(
        "Factory has not granted VAULT_ROLE"
      );
    });

    it("setSiloFactory should accept address(0) to disable", async function () {
      await vault.setSiloFactory(ethers.ZeroAddress);
    });

    it("setSiloFactory should only allow GOVERNANCE_ROLE", async function () {
      await expect(vault.connect(other).setSiloFactory(ethers.ZeroAddress)).to.be.reverted;
    });

    it("with VAULT_ROLE locked, no key can reach silo gold except through the vault", async function () {
      const SiloF = await ethers.getContractFactory("SiloFactory");
      const siloFactory = await SiloF.deploy(ethers.parseEther("100"));
      await siloFactory.grantRole(await siloFactory.VAULT_ROLE(), await vault.getAddress());
      await siloFactory.lockVaultRole(await vault.getAddress());
      await vault.setSiloFactory(await siloFactory.getAddress());

      await paxg.mint(user.address, ethers.parseEther("1"));
      await paxg.connect(user).approve(await vault.getAddress(), ethers.MaxUint256);
      await vault.connect(user).deposit(await paxg.getAddress(), ethers.parseEther("1"));

      // The factory admin (deployer) cannot grant itself the role that moves gold.
      await expect(
        siloFactory.grantRole(await siloFactory.VAULT_ROLE(), owner.address)
      ).to.be.revertedWithCustomError(siloFactory, "AccessControlUnauthorizedAccount");
      await expect(
        siloFactory.withdraw(await paxg.getAddress(), owner.address, ethers.parseEther("1"))
      ).to.be.revertedWithCustomError(siloFactory, "AccessControlUnauthorizedAccount");

      // The owner still gets their gold back the ordinary way.
      const before = await paxg.balanceOf(user.address);
      await vault.connect(user).withdraw(ethers.parseEther("1"));
      expect((await paxg.balanceOf(user.address)) - before).to.equal(ethers.parseEther("1"));
    });
  });

  // ========== Pause matrix and bad-debt resilience ==========
  describe("Pause matrix", function () {
    it("deposits stay open while paused, so borrowers can defend against emergency liquidation", async function () {
      await paxg.mint(user.address, ethers.parseEther("2"));
      await paxg.connect(user).approve(await vault.getAddress(), ethers.MaxUint256);
      await vault.connect(user).deposit(await paxg.getAddress(), ethers.parseEther("1"));
      await vault.pause();
      await vault.connect(user).deposit(await paxg.getAddress(), ethers.parseEther("1"));
      expect((await vault.vaults(user.address))[1]).to.equal(ethers.parseEther("2"));
      // A vault WITHOUT debt reads no price, so it may still take its gold back while paused.
      await vault.connect(user).withdraw(ethers.parseEther("1"));
      expect((await vault.vaults(user.address))[1]).to.equal(ethers.parseEther("1"));
      // A vault WITH debt prices its remaining collateral, so it waits until it has repaid.
      await vault.unpause(await vault.pauseEpoch());
      await vault.connect(user).mint(ethers.parseEther("100"));
      await vault.pause();
      await expect(vault.connect(user).withdraw(ethers.parseEther("0.5"))).to.be.revertedWith(
        "Paused: repay in full to withdraw"
      );
      await vault.unpause(await vault.pauseEpoch());
    });
  });

  describe("Bad debt absorption resilience", function () {
    it("setSurplusBuffer refuses a buffer that has not granted the vault VAULT_ROLE", async function () {
      const Buffer = await ethers.getContractFactory("SurplusBuffer");
      const fresh = await Buffer.deploy(await stablecoin.getAddress());
      await expect(vault.setSurplusBuffer(await fresh.getAddress())).to.be.revertedWith(
        "Buffer has not granted VAULT_ROLE"
      );
      await fresh.grantRole(await fresh.VAULT_ROLE(), await vault.getAddress());
      await vault.setSurplusBuffer(await fresh.getAddress());
      expect(await vault.surplusBuffer()).to.equal(await fresh.getAddress());
    });

    it("retryBadDebtAbsorption rejects no-ops honestly", async function () {
      await expect(vault.retryBadDebtAbsorption()).to.be.revertedWith("No buffer");
      const buffer = await (await ethers.getContractFactory("SurplusBuffer")).deploy(await stablecoin.getAddress());
      await buffer.grantRole(await buffer.VAULT_ROLE(), await vault.getAddress());
      await vault.setSurplusBuffer(await buffer.getAddress());
      await expect(vault.retryBadDebtAbsorption()).to.be.revertedWith("No bad debt");
    });
  });

  // ========== Bad Debt Auto-Pause ==========
  describe("Bad Debt Auto-Pause", function () {
    it("setBadDebtPauseThreshold should update threshold", async function () {
      await vault.setBadDebtPauseThreshold(ethers.parseEther("1000"));
      expect(await vault.badDebtPauseThreshold()).to.equal(ethers.parseEther("1000"));
    });

    it("should auto-pause when bad debt exceeds threshold", async function () {
      // Set a low threshold
      await vault.setBadDebtPauseThreshold(ethers.parseEther("100"));

      await refreshPrices();
      // Open vault: 1 PAXG ($2000), borrow 1000 GSUSD
      await vault.connect(user).deposit(await paxg.getAddress(), ethers.parseEther("1"));
      await vault.connect(user).mint(ethers.parseEther("1000"));

      // Crash price to create bad debt
      const veryLowPrice = 50000000000n; // $500
      await setOraclePrice(veryLowPrice);

      // Fund liquidator
      const MINTER_ROLE = await stablecoin.MINTER_ROLE();
      await stablecoin.grantRole(MINTER_ROLE, owner.address);
      await stablecoin.mint(liquidator.address, ethers.parseEther("5000"));
      await stablecoin.connect(liquidator).approve(await vault.getAddress(), ethers.MaxUint256);

      // Liquidate — creates bad debt > 100 GSUSD threshold
      await vault.connect(liquidator).liquidate(user.address, 0);

      // Vault should now be paused
      expect(await vault.paused()).to.be.true;
      expect(await vault.totalBadDebt()).to.be.gt(ethers.parseEther("100"));
    });

    it("should not auto-pause when threshold is 0 (disabled)", async function () {
      // Threshold defaults to 0 (disabled)
      expect(await vault.badDebtPauseThreshold()).to.equal(0);

      await refreshPrices();
      await vault.connect(user).deposit(await paxg.getAddress(), ethers.parseEther("1"));
      await vault.connect(user).mint(ethers.parseEther("1000"));

      const veryLowPrice = 50000000000n;
      await setOraclePrice(veryLowPrice);

      const MINTER_ROLE = await stablecoin.MINTER_ROLE();
      await stablecoin.grantRole(MINTER_ROLE, owner.address);
      await stablecoin.mint(liquidator.address, ethers.parseEther("5000"));
      await stablecoin.connect(liquidator).approve(await vault.getAddress(), ethers.MaxUint256);

      await vault.connect(liquidator).liquidate(user.address, 0);

      // Should NOT be paused
      expect(await vault.paused()).to.be.false;
    });

    it("emergencyLiquidate should not revert if bad-debt threshold is exceeded while already paused (regression)", async function () {
      // Configure threshold low enough that any bad-debt event would trip it
      await vault.setBadDebtPauseThreshold(ethers.parseEther("1"));

      await refreshPrices();
      await vault.connect(user).deposit(await paxg.getAddress(), ethers.parseEther("1"));
      await vault.connect(user).mint(ethers.parseEther("1000"));

      // Drop to a level that creates bad debt
      const veryLowPrice = 50000000000n; // $500
      await setOraclePrice(veryLowPrice);

      // Pause the vault explicitly to mimic an oracle-driven emergency
      await vault.pause();

      const MINTER_ROLE = await stablecoin.MINTER_ROLE();
      await stablecoin.grantRole(MINTER_ROLE, owner.address);
      await stablecoin.mint(liquidator.address, ethers.parseEther("5000"));
      await stablecoin.connect(liquidator).approve(await vault.getAddress(), ethers.MaxUint256);

      // Without the guard this would revert because _handleBadDebt would call
      // _pause() on an already-paused contract.
      await expect(
        vault.connect(liquidator).emergencyLiquidate(user.address, 0)
      ).to.emit(vault, "Liquidated");

      // Vault remains paused (pause was never undone, never re-set)
      expect(await vault.paused()).to.be.true;
      expect(await vault.totalBadDebt()).to.be.gt(0);
    });
  });

  // ========== View Functions ==========
  describe("View Functions", function () {
    beforeEach(async function () {
      // Refresh prices
      await setValidPrice(paxgFeed, GOLD_PRICE);
      await setValidPrice(xautFeed, GOLD_PRICE);
      await vault.connect(user).deposit(await paxg.getAddress(), ethers.parseEther("10"));
      await vault.connect(user).mint(ethers.parseEther("1000"));
    });

    it("getCollateralisationRatio returns correct value", async function () {
      const ratio = await vault.getCollateralisationRatio(user.address);
      // 10 PAXG * $2000 = $20,000 / $1,000 = 20x = 20,000,000 (in PRECISION=1e6 units)
      expect(ratio).to.be.gt(19_000_000n); // > 1900%
    });

    it("getCollateralisationRatio returns max for zero debt", async function () {
      const ratio = await vault.getCollateralisationRatio(other.address);
      expect(ratio).to.equal(ethers.MaxUint256);
    });

    it("getLiquidationPrice normalises decimals for XAUT", async function () {
      // Setup XAUT vault
      await xaut.mint(other.address, 10_000_000n); // 10 XAUT
      await xaut.connect(other).approve(await vault.getAddress(), ethers.MaxUint256);
      await vault.connect(other).deposit(await xaut.getAddress(), 10_000_000n);
      await oracle.getTokenPrice(await xaut.getAddress());
      await vault.connect(other).mint(ethers.parseEther("1000"));

      const liqPrice = await vault.getLiquidationPrice(other.address);
      // Should be a reasonable price (not wildly off due to decimal mismatch)
      expect(liqPrice).to.be.gt(0);
      expect(liqPrice).to.be.lt(GOLD_PRICE); // liquidation price should be below current price
    });

    it("getLiquidationPrice returns 0 for empty vault", async function () {
      expect(await vault.getLiquidationPrice(other.address)).to.equal(0);
    });
  });
});
