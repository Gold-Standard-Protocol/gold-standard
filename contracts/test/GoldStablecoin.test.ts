import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { GoldStablecoin } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

describe("GoldStablecoin", function () {
  let stablecoin: GoldStablecoin;
  let owner: HardhatEthersSigner;
  let minter: HardhatEthersSigner;
  let user: HardhatEthersSigner;
  let other: HardhatEthersSigner;

  beforeEach(async function () {
    [owner, minter, user, other] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory("GoldStablecoin");
    stablecoin = await Factory.deploy();

    const MINTER_ROLE = await stablecoin.MINTER_ROLE();
    await stablecoin.grantRole(MINTER_ROLE, minter.address);
  });

  describe("Deployment", function () {
    it("should have correct name and symbol", async function () {
      expect(await stablecoin.name()).to.equal("Gold Standard Dollar");
      expect(await stablecoin.symbol()).to.equal("GSUSD");
    });
  });

  describe("Minting", function () {
    it("should mint with MINTER_ROLE", async function () {
      await stablecoin.connect(minter).mint(user.address, ethers.parseEther("1000"));
      expect(await stablecoin.balanceOf(user.address)).to.equal(ethers.parseEther("1000"));
    });

    it("should revert without MINTER_ROLE", async function () {
      await expect(
        stablecoin.connect(other).mint(user.address, ethers.parseEther("1000"))
      ).to.be.revertedWithCustomError(stablecoin, "AccessControlUnauthorizedAccount");
    });
  });

  describe("Burning (ERC20Burnable)", function () {
    beforeEach(async function () {
      await stablecoin.connect(minter).mint(user.address, ethers.parseEther("1000"));
    });

    it("burn(uint256) burns from msg.sender", async function () {
      await stablecoin.connect(user).burn(ethers.parseEther("500"));
      expect(await stablecoin.balanceOf(user.address)).to.equal(ethers.parseEther("500"));
    });

    it("anyone can burn their own tokens (no role required)", async function () {
      await stablecoin.connect(minter).mint(other.address, ethers.parseEther("100"));
      await stablecoin.connect(other).burn(ethers.parseEther("50"));
      expect(await stablecoin.balanceOf(other.address)).to.equal(ethers.parseEther("50"));
    });

    it("burnFrom reverts without allowance", async function () {
      await expect(
        stablecoin.connect(other).burnFrom(user.address, ethers.parseEther("100"))
      ).to.be.reverted;
    });

    it("burnFrom works with sufficient allowance", async function () {
      await stablecoin.connect(user).approve(other.address, ethers.parseEther("500"));
      await stablecoin.connect(other).burnFrom(user.address, ethers.parseEther("500"));
      expect(await stablecoin.balanceOf(user.address)).to.equal(ethers.parseEther("500"));
    });
  });

  describe("Smoothed supply", function () {
    const DAY = 24 * 60 * 60;

    it("drifts down rounding towards the higher figure", async function () {
      const supply = ethers.parseEther("1000");
      await stablecoin.connect(minter).mint(user.address, supply);
      // A day on the smoothed supply has caught up with the live supply.
      await time.increase(DAY);
      expect(await stablecoin.smoothedSupplyNow()).to.equal(supply);

      // Burning one unit banks the supply before it. For the rest of the day the drift
      // owed is a fraction of that one unit, which rounds to nothing: the smoothed supply
      // stays on the banked figure and never falls a unit early.
      await stablecoin.connect(user).burn(1n);
      expect(await stablecoin.smoothedSupply()).to.equal(supply);
      await time.increase(100);
      expect(await stablecoin.smoothedSupplyNow()).to.equal(supply);
      await time.increase(DAY / 2);
      expect(await stablecoin.smoothedSupplyNow()).to.equal(supply);

      // Once the whole day has passed it is the live supply.
      await time.increase(DAY / 2);
      expect(await stablecoin.smoothedSupplyNow()).to.equal(supply - 1n);
    });

    it("drifts down by the elapsed share of the gap, rounded down", async function () {
      const supply = ethers.parseEther("1000");
      await stablecoin.connect(minter).mint(user.address, supply);
      await time.increase(DAY);
      // A gap that does not divide by the seconds in a day.
      const burned = ethers.parseEther("100") + 7n;
      await stablecoin.connect(user).burn(burned);
      const bankedAt = await stablecoin.smoothedSupplyAt();

      await time.increase(3601);
      const elapsed = BigInt(await time.latest()) - bankedAt;
      const drift = (burned * elapsed) / BigInt(DAY);
      expect((burned * elapsed) % BigInt(DAY)).to.not.equal(0n);
      // Read in the block just mined, so the elapsed time is exact.
      expect(await stablecoin.smoothedSupplyNow({ blockTag: "latest" })).to.equal(supply - drift);
    });
  });

  describe("transferGovernance (regression)", function () {
    it("should grant DEFAULT_ADMIN_ROLE to timelock and revoke from caller", async function () {
      const ADMIN_ROLE = await stablecoin.DEFAULT_ADMIN_ROLE();
      // Destination must be a contract; the token itself serves as one in tests.
      const timelock = await stablecoin.getAddress();

      expect(await stablecoin.hasRole(ADMIN_ROLE, owner.address)).to.be.true;
      expect(await stablecoin.hasRole(ADMIN_ROLE, timelock)).to.be.false;

      await expect(stablecoin.transferGovernance(other.address)).to.be.revertedWith("Timelock must be a contract");
      await stablecoin.transferGovernance(timelock);

      expect(await stablecoin.hasRole(ADMIN_ROLE, owner.address)).to.be.false;
      expect(await stablecoin.hasRole(ADMIN_ROLE, timelock)).to.be.true;
    });

    it("should reject zero address", async function () {
      await expect(stablecoin.transferGovernance(ethers.ZeroAddress))
        .to.be.revertedWith("Zero address");
    });

    it("should reject non-admin caller", async function () {
      await expect(stablecoin.connect(other).transferGovernance(other.address))
        .to.be.reverted;
    });

    it("former admin can no longer grant MINTER_ROLE after transfer", async function () {
      const MINTER_ROLE = await stablecoin.MINTER_ROLE();
      await stablecoin.transferGovernance(await stablecoin.getAddress());
      // owner no longer holds DEFAULT_ADMIN, so cannot grant the minter role
      await expect(stablecoin.connect(owner).grantRole(MINTER_ROLE, user.address))
        .to.be.reverted;
    });
  });
});
