import { expect } from "chai";
import { ethers } from "hardhat";
import { FeeSplitter, SurplusBuffer, MockERC20, MockERC20FeeOnTransfer, MockGsusd } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

describe("FeeSplitter", function () {
  let splitter: FeeSplitter;
  let buffer: SurplusBuffer;
  let gsusd: MockGsusd;
  let gold: MockERC20;
  let owner: HardhatEthersSigner;
  let vault: HardhatEthersSigner;
  let governance: HardhatEthersSigner;
  let beneficiary: HardhatEthersSigner;
  let other: HardhatEthersSigner;

  let splitterAddr: string;
  let bufferAddr: string;

  beforeEach(async function () {
    [owner, vault, governance, beneficiary, other] = await ethers.getSigners();

    const MockToken = await ethers.getContractFactory("MockERC20");
    gsusd = await (await ethers.getContractFactory("MockGsusd")).deploy();
    gold = await MockToken.deploy("Pax Gold", "PAXG", 18);

    const SurplusBufferFactory = await ethers.getContractFactory("SurplusBuffer");
    buffer = await SurplusBufferFactory.deploy(await gsusd.getAddress());
    bufferAddr = await buffer.getAddress();

    const FeeSplitterFactory = await ethers.getContractFactory("FeeSplitter");
    splitter = await FeeSplitterFactory.deploy(await gsusd.getAddress(), bufferAddr);
    splitterAddr = await splitter.getAddress();

    // Wiring per the activation runbook: splitter holds VAULT_ROLE on the real buffer,
    // and the vault signer holds VAULT_ROLE on the splitter
    const BUFFER_VAULT_ROLE = await buffer.VAULT_ROLE();
    await buffer.grantRole(BUFFER_VAULT_ROLE, splitterAddr);
    const SPLITTER_VAULT_ROLE = await splitter.VAULT_ROLE();
    await splitter.grantRole(SPLITTER_VAULT_ROLE, vault.address);

    // The vault signer also holds VAULT_ROLE on the buffer directly, so tests can seed
    // the buffer's accounted balance for floor scenarios
    await buffer.grantRole(BUFFER_VAULT_ROLE, vault.address);

    // Mint tokens to vault for deposit tests
    await gsusd.mint(vault.address, ethers.parseEther("100000"));
    await gold.mint(vault.address, ethers.parseEther("100000"));

    // Approve the splitter (and the buffer, for direct seeding) to pull from the vault
    await gsusd.connect(vault).approve(splitterAddr, ethers.MaxUint256);
    await gold.connect(vault).approve(splitterAddr, ethers.MaxUint256);
    await gsusd.connect(vault).approve(bufferAddr, ethers.MaxUint256);
  });

  describe("Deployment", function () {
    it("should deploy with correct GSUSD and buffer addresses", async function () {
      expect(await splitter.gsusd()).to.equal(await gsusd.getAddress());
      expect(await splitter.buffer()).to.equal(bufferAddr);
    });

    it("should default to fee switch OFF (share 0, beneficiary unset, floor 0)", async function () {
      expect(await splitter.beneficiaryShareBps()).to.equal(0n);
      expect(await splitter.beneficiary()).to.equal(ethers.ZeroAddress);
      expect(await splitter.bufferFloor()).to.equal(0n);
      expect(await splitter.totalPaidToBeneficiary()).to.equal(0n);
    });

    it("should expose a 50% hard cap on the beneficiary share", async function () {
      expect(await splitter.MAX_BENEFICIARY_SHARE_BPS()).to.equal(5000n);
      expect(await splitter.BPS()).to.equal(10000n);
    });

    it("should reject zero GSUSD address in constructor", async function () {
      const FeeSplitterFactory = await ethers.getContractFactory("FeeSplitter");
      await expect(
        FeeSplitterFactory.deploy(ethers.ZeroAddress, bufferAddr)
      ).to.be.revertedWith("Zero address");
    });

    it("should reject zero buffer address in constructor", async function () {
      const FeeSplitterFactory = await ethers.getContractFactory("FeeSplitter");
      await expect(
        FeeSplitterFactory.deploy(await gsusd.getAddress(), ethers.ZeroAddress)
      ).to.be.revertedWith("Zero address");
    });

    it("should probe gsusdBalance() on the buffer and reject a non-buffer address", async function () {
      const FeeSplitterFactory = await ethers.getContractFactory("FeeSplitter");
      await expect(
        FeeSplitterFactory.deploy(await gsusd.getAddress(), other.address)
      ).to.be.reverted;
    });

    it("should grant admin and governance roles to the deployer", async function () {
      const GOVERNANCE_ROLE = await splitter.GOVERNANCE_ROLE();
      const DEFAULT_ADMIN_ROLE = await splitter.DEFAULT_ADMIN_ROLE();
      expect(await splitter.hasRole(GOVERNANCE_ROLE, owner.address)).to.be.true;
      expect(await splitter.hasRole(DEFAULT_ADMIN_ROLE, owner.address)).to.be.true;
    });
  });

  describe("depositFee with share 0 (default)", function () {
    it("should forward the entire deposit to the buffer", async function () {
      const amount = ethers.parseEther("500");
      await expect(splitter.connect(vault).depositFee(amount))
        .to.emit(splitter, "FeeSplit")
        .withArgs(vault.address, amount, 0n);

      expect(await buffer.gsusdBalance()).to.equal(amount);
      expect(await gsusd.balanceOf(bufferAddr)).to.equal(amount);
      expect(await splitter.totalPaidToBeneficiary()).to.equal(0n);
    });

    it("keeps per-source attribution the buffer can no longer see", async function () {
      await splitter.grantRole(await splitter.VAULT_ROLE(), other.address);
      await gsusd.mint(other.address, ethers.parseEther("40"));
      await gsusd.connect(other).approve(splitterAddr, ethers.MaxUint256);
      await splitter.connect(vault).depositFee(ethers.parseEther("100"));
      await expect(splitter.connect(other).depositFee(ethers.parseEther("40")))
        .to.emit(splitter, "FeeSplit")
        .withArgs(other.address, ethers.parseEther("40"), 0n);
      expect(await splitter.totalFeesReceivedFrom(vault.address)).to.equal(ethers.parseEther("100"));
      expect(await splitter.totalFeesReceivedFrom(other.address)).to.equal(ethers.parseEther("40"));
      // The buffer sees one source, the splitter: that is why the splitter keeps the split.
      expect(await buffer.totalFeesReceivedFrom(splitterAddr)).to.equal(ethers.parseEther("140"));
    });

    it("should hold no GSUSD balance after the deposit", async function () {
      await splitter.connect(vault).depositFee(ethers.parseEther("500"));
      expect(await gsusd.balanceOf(splitterAddr)).to.equal(0n);
    });

    it("refuses itself as the beneficiary", async function () {
      await expect(splitter.connect(owner).setBeneficiary(splitterAddr)).to.be.revertedWith("Self payment");
      expect(await splitter.beneficiary()).to.equal(ethers.ZeroAddress);
      await expect(splitter.connect(owner).setBeneficiary(beneficiary.address)).to.emit(splitter, "BeneficiaryUpdated");
    });

    it("should still send everything to the buffer when a beneficiary is set but the share is 0", async function () {
      await splitter.connect(owner).setBeneficiary(beneficiary.address);
      const amount = ethers.parseEther("100");
      await splitter.connect(vault).depositFee(amount);

      expect(await buffer.gsusdBalance()).to.equal(amount);
      expect(await gsusd.balanceOf(beneficiary.address)).to.equal(0n);
    });

    it("should reject caller without VAULT_ROLE", async function () {
      await expect(
        splitter.connect(other).depositFee(ethers.parseEther("100"))
      ).to.be.reverted;
    });

    it("should revert if the splitter lacks VAULT_ROLE on the real buffer (wiring test)", async function () {
      const SurplusBufferFactory = await ethers.getContractFactory("SurplusBuffer");
      const unwiredBuffer = await SurplusBufferFactory.deploy(await gsusd.getAddress());
      const FeeSplitterFactory = await ethers.getContractFactory("FeeSplitter");
      const unwiredSplitter = await FeeSplitterFactory.deploy(
        await gsusd.getAddress(),
        await unwiredBuffer.getAddress()
      );
      const VAULT_ROLE = await unwiredSplitter.VAULT_ROLE();
      await unwiredSplitter.grantRole(VAULT_ROLE, vault.address);
      await gsusd.connect(vault).approve(await unwiredSplitter.getAddress(), ethers.MaxUint256);

      await expect(
        unwiredSplitter.connect(vault).depositFee(ethers.parseEther("100"))
      ).to.be.reverted;
    });
  });

  describe("depositFee with an active split", function () {
    // The vault holds the whole 100,000 GSUSD supply, so the buffer's automatic floor is
    // 2,000 (2%). Every split test first fills the buffer to it, so the arithmetic below
    // is the governed bufferFloor's, offset by AUTO.
    const AUTO = ethers.parseEther("2000");
    const e = (n: string) => ethers.parseEther(n);

    beforeEach(async function () {
      await splitter.connect(owner).setBeneficiary(beneficiary.address);
      await splitter.connect(owner).setBeneficiaryShare(5000n);
    });

    it("should report the buffer's automatic floor as the effective floor while bufferFloor is zero", async function () {
      expect(await splitter.bufferFloor()).to.equal(0n);
      expect(await buffer.effectiveMinGsusdReserve()).to.equal(AUTO);
      expect(await splitter.effectiveBufferFloor()).to.equal(AUTO);
      await splitter.connect(owner).setBufferFloor(AUTO + 1n);
      expect(await splitter.effectiveBufferFloor()).to.equal(AUTO + 1n);
    });

    it("should split nothing while the buffer is below its automatic floor, even with bufferFloor at zero", async function () {
      await expect(splitter.connect(vault).depositFee(e("100")))
        .to.emit(splitter, "FeeSplit")
        .withArgs(vault.address, e("100"), 0n);
      expect(await splitter.beneficiaryAccrued()).to.equal(0n);
    });

    it("should top the buffer up to its automatic floor before splitting", async function () {
      // Buffer at 1,980, automatic floor 2,000, deposit 50: shortfall 20, surplus 30,
      // beneficiary 15, buffer 35
      await buffer.connect(vault).depositFee(AUTO - e("20"));
      await expect(splitter.connect(vault).depositFee(e("50")))
        .to.emit(splitter, "FeeSplit")
        .withArgs(vault.address, e("35"), e("15"));
    });

    it("should split 50/50 once the buffer holds its floor", async function () {
      await buffer.connect(vault).depositFee(AUTO);
      const amount = e("100");
      await expect(splitter.connect(vault).depositFee(amount))
        .to.emit(splitter, "FeeSplit")
        .withArgs(vault.address, e("50"), e("50"));

      expect(await buffer.gsusdBalance()).to.equal(AUTO + e("50"));
      // Pull model: earned immediately, paid on claim. Nothing is pushed inline,
      // because this runs inside repay/liquidate/redeem and a reverting beneficiary
      // must never be able to brick them.
      expect(await splitter.beneficiaryAccrued()).to.equal(e("50"));
      expect(await gsusd.balanceOf(beneficiary.address)).to.equal(0n);
      await splitter.claimBeneficiary();
      expect(await gsusd.balanceOf(beneficiary.address)).to.equal(e("50"));
      expect(await splitter.totalPaidToBeneficiary()).to.equal(e("50"));
      expect(await splitter.beneficiaryAccrued()).to.equal(0n);
      expect(await gsusd.balanceOf(splitterAddr)).to.equal(0n);
    });

    it("should top the buffer up to the floor before splitting (worked example)", async function () {
      // Buffer at AUTO + 80, floor AUTO + 100, deposit 50, share 50%:
      // shortfall 20, surplus 30, beneficiary 15, buffer 35
      await buffer.connect(vault).depositFee(AUTO + e("80"));
      await splitter.connect(owner).setBufferFloor(AUTO + e("100"));

      await expect(splitter.connect(vault).depositFee(e("50")))
        .to.emit(splitter, "FeeSplit")
        .withArgs(vault.address, e("35"), e("15"));

      expect(await buffer.gsusdBalance()).to.equal(AUTO + e("115"));
      expect(await splitter.beneficiaryAccrued()).to.equal(e("15"));
      await splitter.claimBeneficiary();
      expect(await gsusd.balanceOf(beneficiary.address)).to.equal(e("15"));
      expect(await splitter.totalPaidToBeneficiary()).to.equal(e("15"));
    });

    it("should send everything to the buffer when the deposit cannot cover the shortfall", async function () {
      await buffer.connect(vault).depositFee(AUTO + e("80"));
      await splitter.connect(owner).setBufferFloor(AUTO + e("200"));

      await expect(splitter.connect(vault).depositFee(e("50")))
        .to.emit(splitter, "FeeSplit")
        .withArgs(vault.address, e("50"), 0n);

      expect(await buffer.gsusdBalance()).to.equal(AUTO + e("130"));
      expect(await gsusd.balanceOf(beneficiary.address)).to.equal(0n);
    });

    it("should treat the whole deposit as surplus when the buffer sits exactly at the floor", async function () {
      await buffer.connect(vault).depositFee(AUTO + e("100"));
      await splitter.connect(owner).setBufferFloor(AUTO + e("100"));

      await expect(splitter.connect(vault).depositFee(e("50")))
        .to.emit(splitter, "FeeSplit")
        .withArgs(vault.address, e("25"), e("25"));
    });

    it("should treat the whole deposit as surplus when the buffer is above the floor", async function () {
      await buffer.connect(vault).depositFee(AUTO + e("150"));
      await splitter.connect(owner).setBufferFloor(AUTO + e("100"));

      await expect(splitter.connect(vault).depositFee(e("40")))
        .to.emit(splitter, "FeeSplit")
        .withArgs(vault.address, e("20"), e("20"));
    });

    it("should round in favour of the buffer (floor division)", async function () {
      await buffer.connect(vault).depositFee(AUTO);
      // 3 wei surplus at 50%: beneficiary floor(3 * 5000 / 10000) = 1 wei, buffer 2 wei
      await expect(splitter.connect(vault).depositFee(3n))
        .to.emit(splitter, "FeeSplit")
        .withArgs(vault.address, 2n, 1n);

      // 1 wei surplus at 50%: beneficiary 0, buffer 1 wei
      await expect(splitter.connect(vault).depositFee(1n))
        .to.emit(splitter, "FeeSplit")
        .withArgs(vault.address, 1n, 0n);
    });

    it("should accumulate totalPaidToBeneficiary across deposits", async function () {
      await buffer.connect(vault).depositFee(AUTO);
      await splitter.connect(vault).depositFee(e("100"));
      await splitter.connect(vault).depositFee(e("60"));

      expect(await splitter.beneficiaryAccrued()).to.equal(e("80"));
      await splitter.claimBeneficiary();
      expect(await splitter.totalPaidToBeneficiary()).to.equal(e("80"));
      expect(await gsusd.balanceOf(beneficiary.address)).to.equal(e("80"));
    });

    it("should read the buffer floor against accounted state, not raw token balance", async function () {
      // Donate GSUSD directly to the buffer: raw balance rises but gsusdBalance does not,
      // so the donation must not count toward the floor
      await gsusd.mint(bufferAddr, ethers.parseEther("100"));
      await splitter.connect(owner).setBufferFloor(ethers.parseEther("100"));

      await expect(splitter.connect(vault).depositFee(ethers.parseEther("50")))
        .to.emit(splitter, "FeeSplit")
        .withArgs(vault.address, ethers.parseEther("50"), 0n);
    });
  });

  describe("depositCollateral", function () {
    it("should forward collateral to the buffer with no split", async function () {
      // Activate the split to prove collateral is never split
      await splitter.connect(owner).setBeneficiary(beneficiary.address);
      await splitter.connect(owner).setBeneficiaryShare(5000n);

      const amount = ethers.parseEther("100");
      const goldAddr = await gold.getAddress();
      await expect(splitter.connect(vault).depositCollateral(goldAddr, amount))
        .to.emit(splitter, "CollateralForwarded")
        .withArgs(goldAddr, amount);

      expect(await buffer.collateralBalance(goldAddr)).to.equal(amount);
      expect(await gold.balanceOf(bufferAddr)).to.equal(amount);
      expect(await gold.balanceOf(splitterAddr)).to.equal(0n);
      expect(await gold.balanceOf(beneficiary.address)).to.equal(0n);
    });

    it("should handle fee-on-transfer collateral by forwarding the measured receipt", async function () {
      const FeeToken = await ethers.getContractFactory("MockERC20FeeOnTransfer");
      const feeGold: MockERC20FeeOnTransfer = await FeeToken.deploy("Fee Gold", "FPAXG", 100n); // 1% fee
      const feeGoldAddr = await feeGold.getAddress();
      await feeGold.mint(vault.address, ethers.parseEther("1000"));
      await feeGold.connect(vault).approve(splitterAddr, ethers.MaxUint256);

      const amount = ethers.parseEther("100");
      const splitterReceived = ethers.parseEther("99"); // 1% lost vault -> splitter
      const bufferReceived = ethers.parseEther("98.01"); // 1% lost again splitter -> buffer

      await expect(splitter.connect(vault).depositCollateral(feeGoldAddr, amount))
        .to.emit(splitter, "CollateralForwarded")
        .withArgs(feeGoldAddr, splitterReceived);

      expect(await buffer.collateralBalance(feeGoldAddr)).to.equal(bufferReceived);
      expect(await feeGold.balanceOf(bufferAddr)).to.equal(bufferReceived);
      expect(await feeGold.balanceOf(splitterAddr)).to.equal(0n);
    });

    it("should reject caller without VAULT_ROLE", async function () {
      await expect(
        splitter.connect(other).depositCollateral(await gold.getAddress(), ethers.parseEther("100"))
      ).to.be.reverted;
    });
  });

  describe("absorbBadDebt", function () {
    const seedAmount = ethers.parseEther("1000");

    beforeEach(async function () {
      await splitter.connect(vault).depositFee(seedAmount);
    });

    it("should pass absorption through, report the burn and forward nothing to the caller", async function () {
      const absorbAmount = ethers.parseEther("400");
      const vaultBalanceBefore = await gsusd.balanceOf(vault.address);
      const supplyBefore = await gsusd.totalSupply();

      await expect(splitter.connect(vault).absorbBadDebt(absorbAmount))
        .to.emit(splitter, "BadDebtPassedThrough")
        .withArgs(absorbAmount, absorbAmount);

      expect(await gsusd.balanceOf(vault.address)).to.equal(vaultBalanceBefore);
      expect(supplyBefore - (await gsusd.totalSupply())).to.equal(absorbAmount);
      expect(await buffer.gsusdBalance()).to.equal(seedAmount - absorbAmount);
      expect(await buffer.totalBadDebtAbsorbed()).to.equal(absorbAmount);
      expect(await gsusd.balanceOf(splitterAddr)).to.equal(0n);
    });

    it("should report only the partial absorption when the buffer cannot cover the request", async function () {
      const excessAmount = ethers.parseEther("2000");
      const vaultBalanceBefore = await gsusd.balanceOf(vault.address);

      await expect(splitter.connect(vault).absorbBadDebt(excessAmount))
        .to.emit(splitter, "BadDebtPassedThrough")
        .withArgs(excessAmount, seedAmount);

      expect(await gsusd.balanceOf(vault.address)).to.equal(vaultBalanceBefore);
      expect(await buffer.gsusdBalance()).to.equal(0n);
      expect(await gsusd.balanceOf(splitterAddr)).to.equal(0n);
    });

    it("should emit zero absorbed when the buffer is empty", async function () {
      await splitter.connect(vault).absorbBadDebt(seedAmount); // drain the buffer
      const requested = ethers.parseEther("100");

      await expect(splitter.connect(vault).absorbBadDebt(requested))
        .to.emit(splitter, "BadDebtPassedThrough")
        .withArgs(requested, 0n);
    });

    it("should reject caller without VAULT_ROLE", async function () {
      await expect(
        splitter.connect(other).absorbBadDebt(ethers.parseEther("100"))
      ).to.be.reverted;
    });
  });

  describe("gsusdBalance", function () {
    it("should mirror the real buffer's accounted balance", async function () {
      expect(await splitter.gsusdBalance()).to.equal(0n);
      await splitter.connect(vault).depositFee(ethers.parseEther("250"));
      expect(await splitter.gsusdBalance()).to.equal(ethers.parseEther("250"));
      expect(await splitter.gsusdBalance()).to.equal(await buffer.gsusdBalance());
    });
  });

  describe("Governance setters", function () {
    it("should set the buffer floor and emit BufferFloorUpdated", async function () {
      const floor = ethers.parseEther("100000");
      await expect(splitter.connect(owner).setBufferFloor(floor))
        .to.emit(splitter, "BufferFloorUpdated")
        .withArgs(floor);
      expect(await splitter.bufferFloor()).to.equal(floor);
    });

    it("should set the beneficiary and emit BeneficiaryUpdated", async function () {
      await expect(splitter.connect(owner).setBeneficiary(beneficiary.address))
        .to.emit(splitter, "BeneficiaryUpdated")
        .withArgs(beneficiary.address);
      expect(await splitter.beneficiary()).to.equal(beneficiary.address);
    });

    it("should set the beneficiary share and emit BeneficiaryShareUpdated", async function () {
      await splitter.connect(owner).setBeneficiary(beneficiary.address);
      await expect(splitter.connect(owner).setBeneficiaryShare(2500n))
        .to.emit(splitter, "BeneficiaryShareUpdated")
        .withArgs(2500n);
      expect(await splitter.beneficiaryShareBps()).to.equal(2500n);
    });

    it("should enforce the 50% hard cap on the beneficiary share", async function () {
      await splitter.connect(owner).setBeneficiary(beneficiary.address);
      await expect(
        splitter.connect(owner).setBeneficiaryShare(5001n)
      ).to.be.revertedWith("Share exceeds cap");
      await splitter.connect(owner).setBeneficiaryShare(5000n);
      expect(await splitter.beneficiaryShareBps()).to.equal(5000n);
    });

    it("should reject a non-zero share while the beneficiary is unset", async function () {
      await expect(
        splitter.connect(owner).setBeneficiaryShare(1n)
      ).to.be.revertedWith("Beneficiary not set");
    });

    it("should allow setting the share to zero while the beneficiary is unset", async function () {
      await splitter.connect(owner).setBeneficiaryShare(0n);
      expect(await splitter.beneficiaryShareBps()).to.equal(0n);
    });

    it("should reject clearing the beneficiary while the share is active", async function () {
      await splitter.connect(owner).setBeneficiary(beneficiary.address);
      await splitter.connect(owner).setBeneficiaryShare(1000n);
      await expect(
        splitter.connect(owner).setBeneficiary(ethers.ZeroAddress)
      ).to.be.revertedWith("Share active");
    });

    it("should allow clearing the beneficiary once the share returns to zero", async function () {
      await splitter.connect(owner).setBeneficiary(beneficiary.address);
      await splitter.connect(owner).setBeneficiaryShare(1000n);
      await splitter.connect(owner).setBeneficiaryShare(0n);
      await splitter.connect(owner).setBeneficiary(ethers.ZeroAddress);
      expect(await splitter.beneficiary()).to.equal(ethers.ZeroAddress);
    });

    it("should reject setters from callers without GOVERNANCE_ROLE", async function () {
      await expect(splitter.connect(other).setBufferFloor(1n)).to.be.reverted;
      await expect(splitter.connect(other).setBeneficiaryShare(0n)).to.be.reverted;
      await expect(splitter.connect(other).setBeneficiary(beneficiary.address)).to.be.reverted;
    });
  });

  describe("transferGovernance", function () {
    it("should transfer governance and admin roles to new address and revoke from deployer", async function () {
      const GOVERNANCE_ROLE = await splitter.GOVERNANCE_ROLE();
      const DEFAULT_ADMIN_ROLE = await splitter.DEFAULT_ADMIN_ROLE();

      expect(await splitter.hasRole(GOVERNANCE_ROLE, owner.address)).to.be.true;
      expect(await splitter.hasRole(DEFAULT_ADMIN_ROLE, owner.address)).to.be.true;

      const dest = await gsusd.getAddress();
      await expect(splitter.connect(owner).transferGovernance(governance.address)).to.be.revertedWith(
        "Timelock must be a contract"
      );
      await splitter.connect(owner).transferGovernance(dest);

      expect(await splitter.hasRole(GOVERNANCE_ROLE, dest)).to.be.true;
      expect(await splitter.hasRole(DEFAULT_ADMIN_ROLE, dest)).to.be.true;
      expect(await splitter.hasRole(GOVERNANCE_ROLE, owner.address)).to.be.false;
      expect(await splitter.hasRole(DEFAULT_ADMIN_ROLE, owner.address)).to.be.false;
    });

    it("should reject zero address", async function () {
      await expect(
        splitter.connect(owner).transferGovernance(ethers.ZeroAddress)
      ).to.be.revertedWith("Zero address");
    });

    it("should reject callers without DEFAULT_ADMIN_ROLE", async function () {
      await expect(
        splitter.connect(other).transferGovernance(governance.address)
      ).to.be.reverted;
    });
  });
  describe("changing the beneficiary while fees are owed", function () {
    const AUTO = ethers.parseEther("2000");
    const e = (n: string) => ethers.parseEther(n);

    beforeEach(async function () {
      await splitter.connect(owner).setBeneficiary(beneficiary.address);
      await splitter.connect(owner).setBeneficiaryShare(5000n);
      await buffer.connect(vault).depositFee(AUTO);
    });

    it("pays what is owed to the outgoing beneficiary, then switches", async function () {
      await splitter.connect(vault).depositFee(e("100"));
      expect(await splitter.beneficiaryAccrued()).to.equal(e("50"));

      const tx = splitter.connect(owner).setBeneficiary(other.address);
      await expect(tx).to.emit(splitter, "BeneficiaryClaimed").withArgs(beneficiary.address, e("50"));
      await expect(tx).to.emit(splitter, "BeneficiaryUpdated").withArgs(other.address);

      expect(await gsusd.balanceOf(beneficiary.address)).to.equal(e("50"));
      expect(await gsusd.balanceOf(other.address)).to.equal(0n);
      expect(await splitter.beneficiaryAccrued()).to.equal(0n);
      expect(await splitter.totalPaidToBeneficiary()).to.equal(e("50"));
      expect(await splitter.beneficiary()).to.equal(other.address);
      expect(await gsusd.balanceOf(splitterAddr)).to.equal(0n);
    });

    it("cannot be held up by a fee that lands just before the change", async function () {
      // Any fee-paying transaction accrues something, the smallest included. The change used
      // to revert while anything was accrued.
      await splitter.connect(vault).depositFee(2n);
      expect(await splitter.beneficiaryAccrued()).to.equal(1n);
      await splitter.connect(owner).setBeneficiary(other.address);
      expect(await gsusd.balanceOf(beneficiary.address)).to.equal(1n);
      expect(await splitter.beneficiary()).to.equal(other.address);
    });

    it("cannot be held up by somebody claiming just before the change", async function () {
      // Batching a claim ahead of the change used to revert when a third party claimed first.
      await splitter.connect(vault).depositFee(e("100"));
      await splitter.connect(other).claimBeneficiary();
      const tx = splitter.connect(owner).setBeneficiary(other.address);
      await expect(tx).to.emit(splitter, "BeneficiaryUpdated").withArgs(other.address);
      await expect(tx).not.to.emit(splitter, "BeneficiaryClaimed");
      expect(await gsusd.balanceOf(beneficiary.address)).to.equal(e("50"));
      expect(await splitter.totalPaidToBeneficiary()).to.equal(e("50"));
    });

    it("gives fees earned after the change to the new beneficiary only", async function () {
      await splitter.connect(vault).depositFee(e("100"));
      await splitter.connect(owner).setBeneficiary(other.address);
      await splitter.connect(vault).depositFee(e("40"));
      expect(await splitter.beneficiaryAccrued()).to.equal(e("20"));
      await splitter.claimBeneficiary();
      expect(await gsusd.balanceOf(other.address)).to.equal(e("20"));
      expect(await gsusd.balanceOf(beneficiary.address)).to.equal(e("50"));
      expect(await splitter.totalPaidToBeneficiary()).to.equal(e("70"));
    });

    it("settles the outgoing beneficiary when the beneficiary is cleared", async function () {
      await splitter.connect(vault).depositFee(e("100"));
      await splitter.connect(owner).setBeneficiaryShare(0n);
      await expect(splitter.connect(owner).setBeneficiary(ethers.ZeroAddress))
        .to.emit(splitter, "BeneficiaryClaimed")
        .withArgs(beneficiary.address, e("50"));
      expect(await splitter.beneficiary()).to.equal(ethers.ZeroAddress);
      expect(await splitter.beneficiaryAccrued()).to.equal(0n);
      expect(await gsusd.balanceOf(beneficiary.address)).to.equal(e("50"));
      // Nothing can accrue to the zero address afterwards.
      await splitter.connect(vault).depositFee(e("100"));
      expect(await splitter.beneficiaryAccrued()).to.equal(0n);
    });

    it("settles when the same beneficiary is set again", async function () {
      await splitter.connect(vault).depositFee(e("100"));
      await splitter.connect(owner).setBeneficiary(beneficiary.address);
      expect(await gsusd.balanceOf(beneficiary.address)).to.equal(e("50"));
      expect(await splitter.beneficiaryAccrued()).to.equal(0n);
    });

    it("still refuses the splitter itself, the zero address under an active share and other callers", async function () {
      await splitter.connect(vault).depositFee(e("100"));
      await expect(splitter.connect(owner).setBeneficiary(splitterAddr)).to.be.revertedWith("Self payment");
      await expect(splitter.connect(owner).setBeneficiary(ethers.ZeroAddress)).to.be.revertedWith("Share active");
      await expect(splitter.connect(other).setBeneficiary(other.address)).to.be.reverted;
      // A refused change settles nothing.
      expect(await splitter.beneficiaryAccrued()).to.equal(e("50"));
      expect(await gsusd.balanceOf(beneficiary.address)).to.equal(0n);
    });

    it("pays an outgoing beneficiary that is a contract with no way to refuse GSUSD", async function () {
      const contractBeneficiary = await gold.getAddress();
      await splitter.connect(owner).setBeneficiary(contractBeneficiary);
      await splitter.connect(vault).depositFee(e("100"));
      await splitter.connect(owner).setBeneficiary(other.address);
      expect(await gsusd.balanceOf(contractBeneficiary)).to.equal(e("50"));
    });

    it("keeps every GSUSD accounted for across changes: fees in equal buffer plus paid plus owed", async function () {
      const bufferBefore = await buffer.gsusdBalance();
      const holders = [other.address, governance.address, beneficiary.address, other.address];
      let deposited = 0n;
      for (let i = 0; i < holders.length; i++) {
        const amount = e(String(10 * (i + 1))) + BigInt(i);
        await splitter.connect(vault).depositFee(amount);
        deposited += amount;
        await splitter.connect(owner).setBeneficiary(holders[i]);
        expect(await splitter.beneficiaryAccrued()).to.equal(0n);
      }
      await splitter.connect(vault).depositFee(e("7"));
      deposited += e("7");
      const toBuffer = (await buffer.gsusdBalance()) - bufferBefore;
      expect(toBuffer + (await splitter.totalPaidToBeneficiary()) + (await splitter.beneficiaryAccrued())).to.equal(deposited);
      expect(await gsusd.balanceOf(splitterAddr)).to.equal(await splitter.beneficiaryAccrued());
    });
  });
});
