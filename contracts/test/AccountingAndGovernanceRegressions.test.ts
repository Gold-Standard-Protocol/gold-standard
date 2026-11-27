import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import {
  GoldVault,
  GoldOracle,
  GoldStablecoin,
  StabilityModule,
  StabilityPool,
  SiloFactory,
  GoldGovernance,
  MockAggregatorV3,
  MockERC20,
} from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

/**
 * Regression tests, one group per fault they guard against:
 *
 *   -  normalised-debt dust survives a full vault close
 *   -  SiloFactory.deposit over-credits when advancing to a pre-funded silo
 *   -  proposeTransferGovernance accepts an arbitrary destination
 *   -  StabilityPool pause blocks claiming already-earned collateral gains
 *   -  minting against a vault-registered but module-uninitialised collateral
 *      panics with division-by-zero instead of a clear revert
 *   -  origination fee, revenue accounting and the reserve swap that holds GSUSD
 */
describe("Accounting and governance regressions", function () {
  const GOLD_PRICE = 200000000000n; // $2000, 8 decimals
  const MIN_RATIO = 1500000n; // 150%
  const LIQ_RATIO = 1100000n; // 110%
  const LIQ_PENALTY = 50000n; // 5%
  const DEBT_CEILING = ethers.parseEther("10000000");

  let owner: HardhatEthersSigner;
  let user: HardhatEthersSigner;
  let redeemer: HardhatEthersSigner;
  let other: HardhatEthersSigner;

  let oracle: GoldOracle;
  let stablecoin: GoldStablecoin;
  let stabilityModule: StabilityModule;
  let vault: GoldVault;
  let paxgFeed: MockAggregatorV3;
  let xautFeed: MockAggregatorV3;
  let paxg: MockERC20;
  let xaut: MockERC20;

  async function setValidPrice(feed: MockAggregatorV3, price: bigint) {
    const ts = await time.latest();
    await feed.setLatestRoundData(1, price, ts, ts, 1);
  }

  async function refreshPrices() {
    await setValidPrice(paxgFeed, GOLD_PRICE);
    await setValidPrice(xautFeed, GOLD_PRICE);
  }

  beforeEach(async function () {
    [owner, user, redeemer, other] = await ethers.getSigners();

    const MockAgg = await ethers.getContractFactory("MockAggregatorV3");
    paxgFeed = await MockAgg.deploy(8);
    xautFeed = await MockAgg.deploy(8);

    const MockToken = await ethers.getContractFactory("MockERC20");
    paxg = await MockToken.deploy("Pax Gold", "PAXG", 18);
    xaut = await MockToken.deploy("Tether Gold", "XAUT", 6);

    await refreshPrices();

    const OracleF = await ethers.getContractFactory("GoldOracle");
    oracle = await OracleF.deploy(
      await paxgFeed.getAddress(),
      await xautFeed.getAddress(),
      await paxg.getAddress(),
      await xaut.getAddress(),
      90000
    );
    await oracle.getTokenPrice(await paxg.getAddress());
    await oracle.getTokenPrice(await xaut.getAddress());

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

    await stablecoin.grantRole(await stablecoin.MINTER_ROLE(), await vault.getAddress());
    await stabilityModule.grantRole(await stabilityModule.VAULT_ROLE(), await vault.getAddress());
  });

  function colId(token: string): string {
    return ethers.keccak256(ethers.solidityPacked(["address"], [token]));
  }

  async function addPaxgCollateral(annualRateBps = 200n) {
    const id = colId(await paxg.getAddress());
    await vault.addCollateralType(
      await paxg.getAddress(),
      MIN_RATIO,
      LIQ_RATIO,
      LIQ_PENALTY,
      DEBT_CEILING
    );
    await stabilityModule.initCollateral(id, annualRateBps);
    return id;
  }

  async function openVault(signer: HardhatEthersSigner, collateral: bigint, debt: bigint) {
    await paxg.mint(signer.address, collateral);
    await paxg.connect(signer).approve(await vault.getAddress(), collateral);
    await vault.connect(signer).deposit(await paxg.getAddress(), collateral);
    await vault.connect(signer).mint(debt);
  }

  // ---------------------------------------------------------------------------
  // The redemption fee double-decay is closed by removal: the RedemptionModule and
  // its volume-decay fee were retired with vault-targeting redemption. The
  // GoldStabilityReserve prices by reserve utilisation instead; see
  // test/GoldStabilityReserve.test.ts.
  // ---------------------------------------------------------------------------


  // ------------------------------------------------------------------
  // A full close must leave zero normalised debt for the user
  // ------------------------------------------------------------------
  describe("normalised-debt dust cleared on full close", function () {
    it("zeroes normalisedDebt after a full repay with accrued fees", async function () {
      const id = await addPaxgCollateral(500n); // 5% so dust definitely accrues
      await openVault(user, ethers.parseEther("100"), ethers.parseEther("50000"));

      // Accrue a year of fees, then repay in full.
      await time.increase(365 * 24 * 60 * 60);
      await refreshPrices();
      await stabilityModule.accrueInterest(id);

      const currentDebt: bigint = await vault.getVaultCurrentDebt(user.address);
      expect(currentDebt).to.be.gt(ethers.parseEther("50000"));

      // Top the user up with the fee portion (someone else's GSUSD).
      await openVault(other, ethers.parseEther("100"), ethers.parseEther("10000"));
      await stablecoin.connect(other).transfer(user.address, ethers.parseEther("5000"));

      // Real-world full close: quote the debt off-chain, add a buffer for the
      // interest that accrues before inclusion, and let the vault cap at the true
      // current debt. Quoting exactly is impossible on a per-second accruing position.
      const buffer = ethers.parseEther("1");
      await stablecoin.connect(user).approve(await vault.getAddress(), currentDebt + buffer);
      const quote: bigint = await vault.getVaultCurrentDebt(user.address);
      await vault.connect(user).repay(quote + buffer);

      const v = await vault.vaults(user.address);
      expect(v.debtAmount).to.equal(0n);
      expect(await stabilityModule.normalisedDebt(user.address, id)).to.equal(0n);
    });

    it("zeroes normalisedDebt after a full liquidation that ends in bad debt", async function () {
      const id = await addPaxgCollateral(0n);
      await openVault(user, ethers.parseEther("100"), ethers.parseEther("100000"));

      // Crash the price so the vault is deeply underwater (collateral < debt).
      // Move in <10% steps to dodge the deviation breaker: $2000 -> ~$900.
      let price = GOLD_PRICE;
      while (price > 90000000000n) {
        price = (price * 91n) / 100n;
        if (price < 90000000000n) price = 90000000000n;
        await setValidPrice(paxgFeed, price);
        await setValidPrice(xautFeed, price);
        await oracle.getTokenPrice(await paxg.getAddress());
        await oracle.getTokenPrice(await xaut.getAddress());
      }

      // Fund a liquidator with GSUSD.
      await openVault(other, ethers.parseEther("10000"), ethers.parseEther("120000"));
      await stablecoin.connect(other).approve(await vault.getAddress(), ethers.parseEther("120000"));
      await vault.connect(other).liquidate(user.address, 0);

      const v = await vault.vaults(user.address);
      expect(v.debtAmount).to.equal(0n);
      expect(await stabilityModule.normalisedDebt(user.address, id)).to.equal(0n);
    });
  });

  // ------------------------------------------------------------------------
  // SiloFactory.deposit must not credit pre-donated silo balances
  // ------------------------------------------------------------------------
  describe("silo advance reads the real balance", function () {
    it("does not over-credit when the next silo was pre-funded by donation", async function () {
      const cap = ethers.parseEther("10");
      const factory: SiloFactory = await (
        await ethers.getContractFactory("SiloFactory")
      ).deploy(cap);
      await factory.grantRole(await factory.VAULT_ROLE(), owner.address);

      const token = await paxg.getAddress();
      await paxg.mint(owner.address, ethers.parseEther("100"));
      await paxg.approve(await factory.getAddress(), ethers.parseEther("100"));

      // Fill silo 0 exactly to cap.
      await factory.deposit(token, cap);
      expect(await factory.totalCollateral(token)).to.equal(cap);

      // Donate straight to the predicted address of silo 1.
      const donation = ethers.parseEther("3");
      const predicted = await factory.predictSiloAddress(token, 1);
      await paxg.mint(owner.address, donation);
      await paxg.transfer(predicted, donation);

      // Deposit 5 more. Correct credit is exactly 5; the over-credit bug credits 8.
      const amount = ethers.parseEther("5");
      await factory.deposit(token, amount);
      expect(await factory.totalCollateral(token)).to.equal(cap + amount);
    });

    it("routes around a chain of donation-filled silos without over-crediting", async function () {
      const cap = ethers.parseEther("10");
      const factory: SiloFactory = await (
        await ethers.getContractFactory("SiloFactory")
      ).deploy(cap);
      await factory.grantRole(await factory.VAULT_ROLE(), owner.address);

      const token = await paxg.getAddress();
      await paxg.mint(owner.address, ethers.parseEther("200"));
      await paxg.approve(await factory.getAddress(), ethers.parseEther("200"));

      await factory.deposit(token, cap); // silo 0 full

      // Fully pre-fund silos 1 and 2 by donation (cap each).
      for (const idx of [1, 2]) {
        const predicted = await factory.predictSiloAddress(token, idx);
        await paxg.mint(owner.address, cap);
        await paxg.transfer(predicted, cap);
      }

      const amount = ethers.parseEther("4");
      await factory.deposit(token, amount);
      expect(await factory.totalCollateral(token)).to.equal(cap + amount);
    });
  });

  // ---------------------------------------------------------------------------
  // Pinning the destination made the ONLY permitted destination the one that bricks
  // governance forever. The helper is gone; every transferGovernance now refuses
  // to revoke the roles it just granted to itself.
  // ---------------------------------------------------------------------------
  describe("transferGovernance cannot self-revoke", function () {
    it("no longer exposes proposeTransferGovernance on the wrapper", async function () {
      const gov: GoldGovernance = await (
        await ethers.getContractFactory("GoldGovernance")
      ).deploy(
        [owner.address],
        [owner.address],
        await vault.getAddress(),
        await oracle.getAddress(),
        await stabilityModule.getAddress()
      );
      expect(
        gov.interface.fragments.some(
          (f) => f.type === "function" && (f as { name?: string }).name === "proposeTransferGovernance"
        )
      ).to.equal(false);
    });

    it("reverts when the destination is the caller, which would leave zero role holders", async function () {
      // Reproduces the exact production shape: the timelock is already admin, and the
      // call arrives FROM the timelock. Grants become no-ops, revokes would be total.
      const gov: GoldGovernance = await (
        await ethers.getContractFactory("GoldGovernance")
      ).deploy(
        [owner.address],
        [owner.address],
        await vault.getAddress(),
        await oracle.getAddress(),
        await stabilityModule.getAddress()
      );
      const timelockAddr = await gov.getTimelockAddress();

      const pool: StabilityPool = await (
        await ethers.getContractFactory("StabilityPool")
      ).deploy(await stablecoin.getAddress());

      // Perform the real handover: deployer -> timelock.
      await pool.transferGovernance(timelockAddr);
      const ADMIN = await pool.DEFAULT_ADMIN_ROLE();
      const GOV = await pool.GOVERNANCE_ROLE();
      expect(await pool.hasRole(ADMIN, timelockAddr)).to.equal(true);
      expect(await pool.hasRole(GOV, timelockAddr)).to.equal(true);

      // Now the timelock itself attempts the self-directed transfer. Previously this
      // succeeded and left NOBODY holding either role.
      await ethers.provider.send("hardhat_impersonateAccount", [timelockAddr]);
      await ethers.provider.send("hardhat_setBalance", [timelockAddr, "0x56bc75e2d63100000"]);
      const asTimelock = await ethers.getSigner(timelockAddr);

      await expect(
        pool.connect(asTimelock).transferGovernance(timelockAddr)
      ).to.be.revertedWith("Would self-revoke");

      await ethers.provider.send("hardhat_stopImpersonatingAccount", [timelockAddr]);

      // Governance survives intact — the system can still be unpaused.
      expect(await pool.hasRole(ADMIN, timelockAddr)).to.equal(true);
      expect(await pool.hasRole(GOV, timelockAddr)).to.equal(true);
    });

    it("still permits a genuine forward handover to a different address", async function () {
      const pool: StabilityPool = await (
        await ethers.getContractFactory("StabilityPool")
      ).deploy(await stablecoin.getAddress());
      // The destination must be a contract now: an EOA typo in a one-shot handover
      // was a dead protocol. Any contract address demonstrates the forward path.
      const dest = await stablecoin.getAddress();
      await expect(pool.transferGovernance(other.address)).to.be.revertedWith("Timelock must be a contract");
      await expect(pool.transferGovernance(dest)).to.not.be.reverted;
      expect(await pool.hasRole(await pool.DEFAULT_ADMIN_ROLE(), dest)).to.equal(true);
      expect(await pool.hasRole(await pool.DEFAULT_ADMIN_ROLE(), owner.address)).to.equal(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Origination fee. Ships at ZERO; the point is the slot, not the charge.
  // ---------------------------------------------------------------------------
  describe("origination fee", function () {
    async function withBuffer() {
      const buffer = await (
        await ethers.getContractFactory("SurplusBuffer")
      ).deploy(await stablecoin.getAddress());
      await buffer.grantRole(await buffer.VAULT_ROLE(), await vault.getAddress());
      await vault.setSurplusBuffer(await buffer.getAddress());
      return buffer;
    }

    it("defaults to zero and charges nothing", async function () {
      await addPaxgCollateral();
      expect(await vault.originationFeeBps()).to.equal(0n);
      await openVault(user, ethers.parseEther("100"), ethers.parseEther("10000"));
      expect(await stablecoin.balanceOf(user.address)).to.equal(ethers.parseEther("10000"));
      expect(await vault.totalOriginationFees()).to.equal(0n);
    });

    it("charges the borrower on what they receive, not on what they owe", async function () {
      const buffer = await withBuffer();
      await addPaxgCollateral();
      await vault.setOriginationFeeBps(25n); // 25 bps

      await paxg.mint(user.address, ethers.parseEther("100"));
      await paxg.connect(user).approve(await vault.getAddress(), ethers.MaxUint256);
      await vault.connect(user).deposit(await paxg.getAddress(), ethers.parseEther("100"));

      const amount = ethers.parseEther("10000");
      const expectedFee = (amount * 25n) / 10000n;
      await vault.connect(user).mint(amount);

      // Receives less...
      expect(await stablecoin.balanceOf(user.address)).to.equal(amount - expectedFee);
      // ...but owes the full amount.
      expect((await vault.vaults(user.address)).debtAmount).to.equal(amount);
      // And the fee is banked, not burned.
      expect(await buffer.gsusdBalance()).to.equal(expectedFee);
      expect(await vault.totalOriginationFees()).to.equal(expectedFee);
    });

    it("preserves supply == aggregate debt, the reason the buffer is mandatory", async function () {
      await withBuffer();
      const id = await addPaxgCollateral();
      await vault.setOriginationFeeBps(100n); // the cap

      await paxg.mint(user.address, ethers.parseEther("100"));
      await paxg.connect(user).approve(await vault.getAddress(), ethers.MaxUint256);
      await vault.connect(user).deposit(await paxg.getAddress(), ethers.parseEther("100"));
      await vault.connect(user).mint(ethers.parseEther("10000"));

      const colType = await vault.collateralTypes(id);
      expect(await stablecoin.totalSupply()).to.equal(colType.totalDebt);
    });

    it("refuses to arm without a buffer, and refuses to remove the buffer while armed", async function () {
      await addPaxgCollateral();
      // No buffer yet: arming would burn the fee and break conservation.
      await expect(vault.setOriginationFeeBps(25n)).to.be.revertedWith("Buffer required");

      await withBuffer();
      await vault.setOriginationFeeBps(25n);
      await expect(vault.setSurplusBuffer(ethers.ZeroAddress)).to.be.revertedWith(
        "Disable origination fee first"
      );
      await vault.setOriginationFeeBps(0n);
      await expect(vault.setSurplusBuffer(ethers.ZeroAddress)).to.not.be.reverted;
    });

    it("caps at 100 bps, the point where the fee starts moving the peg", async function () {
      await withBuffer();
      await expect(vault.setOriginationFeeBps(101n)).to.be.revertedWith(
        "Exceeds max origination fee"
      );
      await expect(vault.setOriginationFeeBps(100n)).to.not.be.reverted;
    });

    it("exempts protocol-owned vaults so the TGE run-rate is not self-inflated", async function () {
      const buffer = await withBuffer();
      await addPaxgCollateral();
      await vault.setOriginationFeeBps(100n);
      await vault.setOriginationFeeExempt(user.address, true);

      await openVault(user, ethers.parseEther("100"), ethers.parseEther("10000"));
      expect(await stablecoin.balanceOf(user.address)).to.equal(ethers.parseEther("10000"));
      expect(await buffer.gsusdBalance()).to.equal(0n);
      expect(await vault.totalOriginationFees()).to.equal(0n);
    });

    it("is governance-only", async function () {
      await withBuffer();
      await expect(vault.connect(user).setOriginationFeeBps(25n)).to.be.reverted;
      await expect(vault.connect(user).setOriginationFeeExempt(user.address, true)).to.be.reverted;
    });
  });

  // ---------------------------------------------------------------------------
  // Lifetime revenue must be reconstructable, and a beneficiary must never
  // be able to brick a user action.
  // ---------------------------------------------------------------------------
  describe("revenue accounting and payout safety", function () {
    it("records lifetime revenue per source, and survives a withdrawal", async function () {
      const id = await addPaxgCollateral(500n);
      const buffer = await (
        await ethers.getContractFactory("SurplusBuffer")
      ).deploy(await stablecoin.getAddress());
      await buffer.grantRole(await buffer.VAULT_ROLE(), await vault.getAddress());
      await vault.setSurplusBuffer(await buffer.getAddress());

      await openVault(user, ethers.parseEther("100"), ethers.parseEther("50000"));
      await time.increase(365 * 24 * 60 * 60);
      await refreshPrices();
      await stabilityModule.accrueInterest(id);

      await stablecoin.connect(user).approve(await vault.getAddress(), ethers.MaxUint256);
      await vault.connect(user).repay(ethers.parseEther("40000"));

      const lifetime = await buffer.totalFeesReceived();
      expect(lifetime).to.be.gt(0n);
      // Attributed to the vault, so the stability-fee line can be told apart from
      // the redemption-fee line even though both arrive via depositFee.
      expect(await buffer.totalFeesReceivedFrom(await vault.getAddress())).to.equal(lifetime);
      expect(await buffer.gsusdBalance()).to.equal(lifetime);

      // Spend everything above the automatic floor (3% of supply). The NET reserve
      // falls; lifetime revenue does not.
      const floor = await buffer.effectiveMinGsusdReserve();
      expect(floor).to.be.gt(0n);
      const spend = lifetime - floor;
      await buffer.withdrawGsusd(other.address, spend);
      expect(await buffer.gsusdBalance()).to.equal(floor);
      expect(await buffer.totalFeesReceived()).to.equal(lifetime);
      expect(await buffer.totalGsusdWithdrawn()).to.equal(spend);
    });

    it("exposes outstanding accrued fee, the counterpart to realised revenue", async function () {
      const id = await addPaxgCollateral(500n);
      await openVault(user, ethers.parseEther("100"), ethers.parseEther("50000"));
      await time.increase(365 * 24 * 60 * 60);
      await refreshPrices();

      const principal = (await vault.vaults(user.address)).debtAmount;
      const accrued = await stabilityModule.getOutstandingAccruedFee(user.address, id, principal);
      const current = await vault.getVaultCurrentDebt(user.address);
      expect(accrued).to.be.gt(0n);
      expect(accrued).to.equal(current - principal);
    });

    it("a reverting beneficiary cannot brick repay (pull payment)", async function () {
      const id = await addPaxgCollateral(500n);
      const buffer = await (
        await ethers.getContractFactory("SurplusBuffer")
      ).deploy(await stablecoin.getAddress());
      const splitter = await (
        await ethers.getContractFactory("FeeSplitter")
      ).deploy(await stablecoin.getAddress(), await buffer.getAddress());

      await buffer.grantRole(await buffer.VAULT_ROLE(), await splitter.getAddress());
      await splitter.grantRole(await splitter.VAULT_ROLE(), await vault.getAddress());
      await vault.setSurplusBuffer(await splitter.getAddress());

      // A beneficiary that reverts on receipt: the SurplusBuffer itself has no
      // receive path for a plain transfer target that rejects, so use a contract
      // with no fallback — the GoldOracle — which cannot hold GSUSD logic but is a
      // valid address. Under the old push model any revert here bricked repay.
      await splitter.setBeneficiary(await oracle.getAddress());
      await splitter.setBeneficiaryShare(5000n); // 50%, the hard cap

      await openVault(user, ethers.parseEther("100"), ethers.parseEther("50000"));
      await time.increase(365 * 24 * 60 * 60);
      await refreshPrices();
      await stabilityModule.accrueInterest(id);

      await stablecoin.connect(user).approve(await vault.getAddress(), ethers.MaxUint256);
      // The user action succeeds regardless of the beneficiary. A repayment large enough
      // that its fee share tops the buffer past its automatic floor, so a split happens.
      await expect(vault.connect(user).repay(ethers.parseEther("40000"))).to.not.be.reverted;
      expect(await splitter.beneficiaryAccrued()).to.be.gt(0n);
    });

    it("governance cannot redirect fees a beneficiary has already earned", async function () {
      const buffer = await (
        await ethers.getContractFactory("SurplusBuffer")
      ).deploy(await stablecoin.getAddress());
      const splitter = await (
        await ethers.getContractFactory("FeeSplitter")
      ).deploy(await stablecoin.getAddress(), await buffer.getAddress());
      await buffer.grantRole(await buffer.VAULT_ROLE(), await splitter.getAddress());
      await splitter.grantRole(await splitter.VAULT_ROLE(), owner.address);
      await splitter.setBeneficiary(other.address);
      await splitter.setBeneficiaryShare(5000n);

      // Give owner some GSUSD to push through the splitter.
      await addPaxgCollateral();
      await openVault(owner, ethers.parseEther("100"), ethers.parseEther("50000"));
      await stablecoin.approve(await splitter.getAddress(), ethers.MaxUint256);
      // 2,000 more than tops the buffer up to its automatic floor (3% of 50,000).
      await splitter.depositFee(ethers.parseEther("2000"));
      expect(await splitter.beneficiaryAccrued()).to.be.gt(0n);

      // The change pays the outgoing beneficiary first, so earned fees are never redirected.
      const owed = await splitter.beneficiaryAccrued();
      await expect(splitter.setBeneficiary(redeemer.address))
        .to.emit(splitter, "BeneficiaryClaimed")
        .withArgs(other.address, owed);
      expect(await stablecoin.balanceOf(other.address)).to.equal(owed);
      expect(await stablecoin.balanceOf(redeemer.address)).to.equal(0n);
      expect(await splitter.beneficiaryAccrued()).to.equal(0n);
    });
  });

  // ---------------------------------------------------------------------------
  // Reserve: a stability swap is a SWAP, not a burn.
  //
  // The former vault-path test asserted principal burned + fee banked; the former
  // inventory-path test asserted "the whole amount is burned". Both paths are gone.
  // The reserve holds every GSUSD it receives: burning it would destroy GSUSD a
  // borrower still owes and break totalSupply == Σ borrowerPrincipal. The old
  // inventory assertion enshrined exactly that bug.
  // ---------------------------------------------------------------------------
  describe("reserve: a stability swap holds GSUSD, it never burns", function () {
    it("supply and every vault are unchanged; only the spread reaches insurance", async function () {
      await addPaxgCollateral();
      const buffer = await (
        await ethers.getContractFactory("SurplusBuffer")
      ).deploy(await stablecoin.getAddress());
      const reserve = await (
        await ethers.getContractFactory("GoldStabilityReserve")
      ).deploy(await stablecoin.getAddress(), await oracle.getAddress());
      await buffer.grantRole(await buffer.VAULT_ROLE(), await reserve.getAddress());
      await reserve.setSurplusBuffer(await buffer.getAddress());
      await reserve.setAssetConfig(await paxg.getAddress(), true, 0n, 1_000_000n);
      await reserve.setSpreadCurve([{ coverageAtLeastPpm: 10_000n, spreadPpm: 5_000n }], 20_000n);

      // Seed the reserve and open a borrower vault the swap must not touch.
      await paxg.mint(owner.address, ethers.parseEther("50"));
      await paxg.approve(await reserve.getAddress(), ethers.MaxUint256);
      await reserve.seedCollateral(await paxg.getAddress(), ethers.parseEther("50"));
      await openVault(user, ethers.parseEther("100"), ethers.parseEther("20000"));

      await stablecoin.connect(user).transfer(redeemer.address, ethers.parseEther("5000"));
      await stablecoin.connect(redeemer).approve(await reserve.getAddress(), ethers.MaxUint256);

      const vaultBefore = await vault.vaults(user.address);
      const supplyBefore = await stablecoin.totalSupply();
      const amount = ethers.parseEther("1000");
      await refreshPrices();
      await reserve.connect(redeemer).swapGsusdForGold(await paxg.getAddress(), amount, 0n);

      // A swap, not a burn.
      expect(await stablecoin.totalSupply()).to.equal(supplyBefore);
      // The borrower's vault is byte-identical.
      const vaultAfter = await vault.vaults(user.address);
      expect(vaultAfter.collateralAmount).to.equal(vaultBefore.collateralAmount);
      expect(vaultAfter.debtAmount).to.equal(vaultBefore.debtAmount);
      // 0.5% spread is revenue; the rest is inventory, NOT revenue.
      const fee = (amount * 5_000n) / 1_000_000n;
      expect(await buffer.totalFeesReceived()).to.equal(fee);
      expect(await reserve.gsusdInventory()).to.equal(amount - fee);
      expect(await reserve.totalSpreadPaid()).to.equal(fee);
    });
  });

  // ---------------------------------------------------------------------------
  // SiloFactory.deposit must make bounded forward progress and route around
  // silos it cannot transfer INTO (issuer freeze), not revert every deposit.
  // ---------------------------------------------------------------------------
  describe("silo deposit is bounded and freeze-tolerant", function () {
    async function freezableFactory(cap: bigint) {
      const token = await (
        await ethers.getContractFactory("MockERC20Freezable")
      ).deploy("Pax Gold", "PAXG");
      const factory: SiloFactory = await (
        await ethers.getContractFactory("SiloFactory")
      ).deploy(cap);
      await factory.grantRole(await factory.VAULT_ROLE(), owner.address);
      return { token, factory };
    }

    it("bounds the gas a donation-stuffed run of silos can impose", async function () {
      const cap = ethers.parseEther("10");
      const { token, factory } = await freezableFactory(cap);
      const addr = await token.getAddress();

      await token.mint(owner.address, ethers.parseEther("1000"));
      await token.approve(await factory.getAddress(), ethers.parseEther("1000"));
      await factory.deposit(addr, cap); // fill silo 0

      // Stuff more consecutive future silos than one deposit may skip.
      const maxSkips = Number(await factory.MAX_SKIPS_PER_DEPOSIT());
      for (let i = 1; i <= maxSkips + 1; i++) {
        await token.mint(owner.address, cap);
        await token.transfer(await factory.predictSiloAddress(addr, i), cap);
      }

      // Fails fast with a clear reason instead of grinding toward an OOG.
      await expect(factory.deposit(addr, ethers.parseEther("5"))).to.be.revertedWith(
        "Too many unusable silos"
      );

      // The operator lever clears it.
      await factory.setCurrentSiloIndex(addr, maxSkips + 2);
      await expect(factory.deposit(addr, ethers.parseEther("5"))).to.not.be.reverted;
      expect(await factory.totalCollateral(addr)).to.equal(cap + ethers.parseEther("5"));
    });

    it("routes deposits around a frozen silo instead of reverting", async function () {
      const cap = ethers.parseEther("10");
      const { token, factory } = await freezableFactory(cap);
      const addr = await token.getAddress();

      await token.mint(owner.address, ethers.parseEther("100"));
      await token.approve(await factory.getAddress(), ethers.parseEther("100"));

      // Freeze the very first silo the factory routes into.
      const silo0 = await factory.predictSiloAddress(addr, 0);
      await token.setFrozen(silo0, true);

      // Before the deposit-leg try/catch this reverted "Recipient frozen" and no
      // deposit for this token could ever succeed again.
      await expect(factory.deposit(addr, ethers.parseEther("5"))).to.emit(factory, "SiloSkipped");

      expect(await factory.totalCollateral(addr)).to.equal(ethers.parseEther("5"));
      expect(await token.balanceOf(silo0)).to.equal(0n);
    });

    it("setCurrentSiloIndex only moves forward", async function () {
      const { factory, token } = await freezableFactory(ethers.parseEther("10"));
      const addr = await token.getAddress();
      await factory.setCurrentSiloIndex(addr, 3);
      await expect(factory.setCurrentSiloIndex(addr, 3)).to.be.revertedWith("Index must advance");
      await expect(factory.setCurrentSiloIndex(addr, 2)).to.be.revertedWith("Index must advance");
    });
  });

  // ---------------------------------------------------------------------
  // Already-earned collateral gains stay claimable while paused
  // ---------------------------------------------------------------------
  describe("StabilityPool claims while paused", function () {
    it("lets a depositor claim earned gains during a pause", async function () {
      const pool: StabilityPool = await (
        await ethers.getContractFactory("StabilityPool")
      ).deploy(await stablecoin.getAddress());
      await pool.addCollateralToken(await paxg.getAddress());
      await pool.grantRole(await pool.VAULT_ROLE(), owner.address);

      await addPaxgCollateral();
      await openVault(user, ethers.parseEther("100"), ethers.parseEther("50000"));

      // user deposits GSUSD into the pool
      await stablecoin.connect(user).approve(await pool.getAddress(), ethers.parseEther("50000"));
      await pool.connect(user).deposit(ethers.parseEther("50000"));

      // Simulate an absorption: owner (with VAULT_ROLE) sends collateral, takes GSUSD.
      await paxg.mint(await pool.getAddress(), ethers.parseEther("5"));
      await pool.absorbLiquidationPrefunded(await paxg.getAddress(), ethers.parseEther("10000"));

      const gain = await pool.getCollateralGain(user.address, await paxg.getAddress());
      expect(gain).to.be.gt(0n);

      await pool.emergencyPause();

      // deposit/withdraw stay blocked...
      await expect(pool.connect(user).withdraw(1n)).to.be.revertedWithCustomError(
        pool,
        "EnforcedPause"
      );
      // ...but claiming already-earned gains works.
      const balBefore = await paxg.balanceOf(user.address);
      await pool.connect(user).claimCollateral(await paxg.getAddress());
      expect(await paxg.balanceOf(user.address)).to.be.gt(balBefore);
    });
  });

  // ----------------------------------------------------------------------
  // Uninitialised collateral must revert clearly, not panic
  // ----------------------------------------------------------------------
  describe("uninitialised stability-fee collateral", function () {
    it("reverts minting with a clear message when initCollateral was skipped", async function () {
      // Register on the vault but deliberately skip stabilityModule.initCollateral.
      await vault.addCollateralType(
        await paxg.getAddress(),
        MIN_RATIO,
        LIQ_RATIO,
        LIQ_PENALTY,
        DEBT_CEILING
      );

      await paxg.mint(user.address, ethers.parseEther("100"));
      await paxg.connect(user).approve(await vault.getAddress(), ethers.parseEther("100"));
      await vault.connect(user).deposit(await paxg.getAddress(), ethers.parseEther("100"));

      await expect(
        vault.connect(user).mint(ethers.parseEther("1000"))
      ).to.be.revertedWith("Collateral not initialised");
    });
  });
});
