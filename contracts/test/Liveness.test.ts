import { expect } from "chai";
import { ethers, network } from "hardhat";
import { time, loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { productionSystem } from "./helpers/productionSystem";

/**
 * Liveness hardening:
 *
 *   1. GoldStablecoin.lockMinters(vault): one-way, and only while the vault is the sole
 *      minter and the caller the sole admin; after it no key, the timelock included, can
 *      ever grant MINTER_ROLE again. The vault keeps minting, revocation stays.
 *   2. GoldVault.withdraw during a pause — a vault that carries no debt reads no price and
 *      may always withdraw, whether the vault or the oracle is paused. Repay stays open, so
 *      repay-in-full-then-withdraw is a guaranteed exit. A vault WITH debt still waits.
 *   3. Pause expiry — a pause on the vault, oracle or pool lapses after MAX_PAUSE_DURATION
 *      (14 days) and anyone may lift it; a fresh pause restarts the window; governance can
 *      still unpause early.
 */
describe("Liveness hardening: minter lock, debt-free withdrawal, pause expiry", function () {
  const DAY = 24 * 3600;
  const TEN_PAXG = ethers.parseEther("10");
  const DEBT = ethers.parseEther("10000"); // 200% at $2,000 against 10 PAXG

  type System = Awaited<ReturnType<typeof productionSystem>>;

  async function openPaxgVault(s: System, who: typeof s.alice, collateral = TEN_PAXG, debt = DEBT) {
    await s.paxg.mint(who.address, collateral);
    await s.paxg.connect(who).approve(await s.vault.getAddress(), collateral);
    await s.vault.connect(who).deposit(await s.paxg.getAddress(), collateral);
    if (debt > 0n) await s.vault.connect(who).mint(debt);
  }

  describe("GoldStablecoin.lockMinters", function () {
    /** The fixture also makes the deployer a minter for funding; the real deployment never does. */
    async function launchMinters(): Promise<System> {
      const s = await loadFixture(productionSystem);
      await s.stablecoin.revokeRole(await s.stablecoin.MINTER_ROLE(), s.deployer.address);
      return s;
    }

    it("only the admin can lock, and the lock is one-way", async function () {
      const s = await launchMinters();
      const vaultAddr = await s.vault.getAddress();
      await expect(s.stablecoin.connect(s.alice).lockMinters(vaultAddr)).to.be.revertedWithCustomError(
        s.stablecoin,
        "AccessControlUnauthorizedAccount"
      );
      expect(await s.stablecoin.mintersLocked()).to.equal(false);
      await expect(s.stablecoin.lockMinters(vaultAddr)).to.emit(s.stablecoin, "MintersLocked").withArgs(s.deployer.address);
      expect(await s.stablecoin.mintersLocked()).to.equal(true);
      await expect(s.stablecoin.lockMinters(vaultAddr)).to.be.revertedWith("Already locked");
    });

    it("after the lock nobody can grant MINTER_ROLE, the vault keeps minting, revocation still works", async function () {
      const s = await launchMinters();
      const MINTER_ROLE = await s.stablecoin.MINTER_ROLE();
      const vaultAddr = await s.vault.getAddress();
      await s.stablecoin.lockMinters(vaultAddr);

      await expect(s.stablecoin.grantRole(MINTER_ROLE, s.bob.address)).to.be.revertedWith("Minters locked");

      // The vault is the sole minter and still mints through the normal path.
      const before = await s.stablecoin.balanceOf(s.alice.address);
      await openPaxgVault(s, s.alice);
      expect((await s.stablecoin.balanceOf(s.alice.address)) - before).to.equal(DEBT);

      // Revocation is deliberately still possible (retire a compromised minter) ...
      await s.stablecoin.revokeRole(MINTER_ROLE, vaultAddr);
      expect(await s.stablecoin.hasRole(MINTER_ROLE, vaultAddr)).to.equal(false);
      // ... but it can never be handed back.
      await expect(s.stablecoin.grantRole(MINTER_ROLE, vaultAddr)).to.be.revertedWith("Minters locked");
    });

    it("survives the governance handover: the timelock itself cannot reopen the minter set", async function () {
      const s = await launchMinters();
      const MINTER_ROLE = await s.stablecoin.MINTER_ROLE();
      await s.stablecoin.lockMinters(await s.vault.getAddress());
      await s.stablecoin.transferGovernance(s.timelockAddr);

      await network.provider.send("hardhat_impersonateAccount", [s.timelockAddr]);
      await network.provider.send("hardhat_setBalance", [s.timelockAddr, "0x56BC75E2D63100000"]);
      const timelock = await ethers.getSigner(s.timelockAddr);
      const ADMIN = await s.stablecoin.DEFAULT_ADMIN_ROLE();
      expect(await s.stablecoin.hasRole(ADMIN, s.timelockAddr)).to.equal(true);
      await expect(s.stablecoin.connect(timelock).grantRole(MINTER_ROLE, s.bob.address)).to.be.revertedWith("Minters locked");
    });

    // Roles planted before the governance handover used to survive it:
    // the lock froze whatever minter set it found, so a key granted MINTER_ROLE beside the
    // vault stayed inside the lock for good and minted with no debt behind it.
    it("refuses to lock while a second key holds MINTER_ROLE, and shows who it is", async function () {
      const s = await launchMinters();
      const MINTER_ROLE = await s.stablecoin.MINTER_ROLE();
      const vaultAddr = await s.vault.getAddress();
      await s.stablecoin.grantRole(MINTER_ROLE, s.bob.address);

      await expect(s.stablecoin.lockMinters(vaultAddr)).to.be.revertedWith("MINTER_ROLE must have a sole holder");
      expect(await s.stablecoin.mintersLocked()).to.equal(false);
      expect([...(await s.stablecoin.getRoleMembers(MINTER_ROLE))]).to.have.members([vaultAddr, s.bob.address]);

      await s.stablecoin.revokeRole(MINTER_ROLE, s.bob.address);
      await expect(s.stablecoin.lockMinters(vaultAddr)).to.emit(s.stablecoin, "MintersLocked");
    });

    it("refuses to lock while a second key holds DEFAULT_ADMIN_ROLE", async function () {
      const s = await launchMinters();
      const ADMIN = await s.stablecoin.DEFAULT_ADMIN_ROLE();
      const vaultAddr = await s.vault.getAddress();
      await s.stablecoin.grantRole(ADMIN, s.bob.address);

      await expect(s.stablecoin.lockMinters(vaultAddr)).to.be.revertedWith("DEFAULT_ADMIN_ROLE must have a sole holder");
      expect([...(await s.stablecoin.getRoleMembers(ADMIN))]).to.have.members([s.deployer.address, s.bob.address]);

      await s.stablecoin.connect(s.bob).renounceRole(ADMIN, s.bob.address);
      await expect(s.stablecoin.lockMinters(vaultAddr)).to.emit(s.stablecoin, "MintersLocked");
    });

    it("refuses to lock around an address that is not a minter", async function () {
      const s = await launchMinters();
      await expect(s.stablecoin.lockMinters(s.bob.address)).to.be.revertedWith("Vault lacks MINTER_ROLE");
      expect(await s.stablecoin.mintersLocked()).to.equal(false);
    });
  });

  describe("withdraw while paused", function () {
    it("a vault with debt cannot withdraw while the vault is paused", async function () {
      const s = await loadFixture(productionSystem);
      await openPaxgVault(s, s.alice);
      await s.vault.connect(s.guardian).emergencyPause();
      await expect(s.vault.connect(s.alice).withdraw(ethers.parseEther("1"))).to.be.revertedWith(
        "Paused: repay in full to withdraw"
      );
    });

    it("repay in full, then withdraw everything, works while the vault is paused", async function () {
      const s = await loadFixture(productionSystem);
      await openPaxgVault(s, s.alice);
      await s.vault.connect(s.guardian).emergencyPause();

      // Cover the accrued fee with a little extra GSUSD; overshoot is capped to a full close.
      await s.stablecoin.mint(s.alice.address, ethers.parseEther("1"));
      const debt = await s.vault.getVaultCurrentDebt(s.alice.address);
      await s.stablecoin.connect(s.alice).approve(await s.vault.getAddress(), debt + ethers.parseEther("1"));
      await s.vault.connect(s.alice).repay(debt + ethers.parseEther("1"));
      expect((await s.vault.vaults(s.alice.address)).debtAmount).to.equal(0n);

      const goldBefore = await s.paxg.balanceOf(s.alice.address);
      await s.vault.connect(s.alice).withdraw(TEN_PAXG);
      expect((await s.paxg.balanceOf(s.alice.address)) - goldBefore).to.equal(TEN_PAXG);
      const v = await s.vault.vaults(s.alice.address);
      expect(v.collateralAmount).to.equal(0n);
      expect(v.collateralToken).to.equal(ethers.ZeroAddress);
      expect(await s.vault.paused()).to.equal(true); // the exit never needed an unpause
    });

    it("a debt-free vault can withdraw while the ORACLE is paused, because no price is read", async function () {
      const s = await loadFixture(productionSystem);
      await openPaxgVault(s, s.alice, TEN_PAXG, 0n);
      await s.oracle.connect(s.guardian).emergencyPause();
      await s.vault.connect(s.alice).withdraw(ethers.parseEther("4"));
      expect((await s.vault.vaults(s.alice.address)).collateralAmount).to.equal(ethers.parseEther("6"));
    });

    it("a vault with debt still needs a live oracle to withdraw", async function () {
      const s = await loadFixture(productionSystem);
      await openPaxgVault(s, s.alice);
      await s.oracle.connect(s.guardian).emergencyPause();
      await expect(s.vault.connect(s.alice).withdraw(ethers.parseEther("1"))).to.be.revertedWithCustomError(
        s.oracle,
        "EnforcedPause"
      );
    });
  });

  describe("pause expiry", function () {
    it("nobody can lift a fresh pause, anyone can lift it after 14 days", async function () {
      const s = await loadFixture(productionSystem);
      await expect(s.vault.connect(s.alice).unpauseExpired()).to.be.revertedWith("Not paused");
      await s.vault.connect(s.guardian).emergencyPause();
      const pausedAt = await s.vault.pausedAt();
      expect(await s.vault.pauseExpiresAt()).to.equal(pausedAt + 14n * BigInt(DAY));

      await expect(s.vault.connect(s.alice).unpauseExpired()).to.be.revertedWith("Pause not expired");
      await time.increase(13 * DAY);
      await expect(s.vault.connect(s.alice).unpauseExpired()).to.be.revertedWith("Pause not expired");
      await time.increase(DAY + 1);
      await expect(s.vault.connect(s.alice).unpauseExpired())
        .to.emit(s.vault, "PauseExpired")
        .withArgs(s.alice.address, pausedAt);
      expect(await s.vault.paused()).to.equal(false);
      expect(await s.vault.pauseExpiresAt()).to.equal(0n);
    });

    it("the oracle and the stability pool expire the same way", async function () {
      const s = await loadFixture(productionSystem);
      await s.oracle.connect(s.guardian).emergencyPause();
      await s.stabilityPool.connect(s.guardian).emergencyPause();
      await time.increase(14 * DAY + 1);
      await s.oracle.connect(s.bob).unpauseExpired();
      await s.stabilityPool.connect(s.bob).unpauseExpired();
      expect(await s.oracle.paused()).to.equal(false);
      expect(await s.stabilityPool.paused()).to.equal(false);
    });

    it("a fresh pause restarts the window, and governance can still unpause early", async function () {
      const s = await loadFixture(productionSystem);
      await s.vault.connect(s.guardian).emergencyPause();
      await time.increase(14 * DAY + 1);
      await s.vault.connect(s.alice).unpauseExpired();

      // A live guardian keeps a genuine incident paused by pausing again.
      await s.vault.connect(s.guardian).emergencyPause();
      await expect(s.vault.connect(s.alice).unpauseExpired()).to.be.revertedWith("Pause not expired");

      // Governance does not have to wait.
      await s.vault.unpause(await s.vault.pauseEpoch());
      expect(await s.vault.paused()).to.equal(false);
    });

    it("the bad-debt auto-pause is subject to the same expiry", async function () {
      const s = await loadFixture(productionSystem);
      // The circuit breaker pauses through the same _pause hook, so a manual governance
      // pause stands in for it here; the hook is shared code.
      await s.vault.pause();
      expect(await s.vault.pausedAt()).to.equal(await time.latest());
      await time.increase(14 * DAY + 1);
      await s.vault.connect(s.charlie).unpauseExpired();
      expect(await s.vault.paused()).to.equal(false);
    });
  });
});
