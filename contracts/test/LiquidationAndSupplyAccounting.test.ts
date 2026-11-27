import { expect } from "chai";
import { ethers, network } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { loadOpen, walkPrice, openPaxgVault, priceForRatio, type System } from "./helpers/openProfile";

/**
 * Liquidation and supply accounting on the production fixture (silos, registry, reserve
 * and buffer wired). The issuer-freeze mechanics need a mocked PAXG revert and live in
 * test-foundry/LiquidationAndSupplyAccounting.t.sol; here the same paths run end to end.
 */
describe("Liquidation and supply accounting", function () {
  this.timeout(180_000);

  const GAS = { gasLimit: 16_000_000n };
  const e = (n: string) => ethers.parseEther(n);

  async function liquidatable(s: System, ratioPpm = 1_070_000n, oz = 10n) {
    const paxg = await s.paxg.getAddress();
    const { amount } = await openPaxgVault(s, s.charlie, oz);
    const price = await priceForRatio(s, s.charlie.address, amount, ratioPpm);
    await walkPrice(s, paxg, s.paxgFeed, price);
    return { paxg, amount, price };
  }

  describe("the protocol share never blocks a liquidation", function () {
    it("routes the reserve's slice to the buffer when the reserve refuses it", async function () {
      const s = await loadOpen();
      const { paxg } = await liquidatable(s);
      await s.reserve.revokeRole(await s.reserve.VAULT_ROLE(), await s.vault.getAddress());
      await expect(s.vault.connect(s.bob).liquidate(s.charlie.address, 0, GAS)).to.emit(s.vault, "ReserveRoutingFailed");
      expect(await s.reserve.collateralBalance(paxg)).to.equal(0n);
      expect(await s.surplusBuffer.collateralBalance(paxg)).to.be.gt(0n);
      expect(await s.paxg.allowance(await s.vault.getAddress(), await s.reserve.getAddress())).to.equal(0n);
    });

    it("keeps the rest in surplusCollateral when the buffer refuses it", async function () {
      const s = await loadOpen();
      const { paxg } = await liquidatable(s);
      await s.surplusBuffer.revokeRole(await s.surplusBuffer.VAULT_ROLE(), await s.vault.getAddress());
      await expect(s.vault.connect(s.bob).liquidate(s.charlie.address, 0, GAS)).to.emit(s.vault, "SurplusRoutingFailed");
      const kept = await s.vault.surplusCollateral(paxg);
      expect(kept).to.be.gt(0n);
      expect(await s.paxg.balanceOf(await s.vault.getAddress())).to.equal(kept);
    });
  });

  describe("the pool path never routes gold through the vault", function () {
    it("pays the pool and the keeper from the silos and credits what arrived", async function () {
      const s = await loadOpen();
      await s.stabilityPool.connect(s.alice).deposit(e("40000"));
      const { paxg } = await liquidatable(s);
      const poolAddr = await s.stabilityPool.getAddress();
      const keeperBefore = await s.paxg.balanceOf(s.bob.address);

      await s.vault.connect(s.bob).liquidateViaPool(s.charlie.address, 0, GAS);

      expect((await s.vault.vaults(s.charlie.address)).debtAmount).to.equal(0n);
      expect(await s.paxg.balanceOf(s.bob.address)).to.be.gt(keeperBefore);
      expect(await s.paxg.balanceOf(await s.vault.getAddress())).to.equal(0n);
      const held = await s.paxg.balanceOf(poolAddr);
      expect(await s.stabilityPool.collateralAccounted(paxg)).to.equal(held);

      const gain = await s.stabilityPool.getCollateralGain(s.alice.address, paxg);
      await s.stabilityPool.connect(s.alice).claimCollateral(paxg);
      expect(await s.stabilityPool.collateralAccounted(paxg)).to.equal(held - gain);
    });

    it("refuses a prefunded absorption from anyone but the vault", async function () {
      const s = await loadOpen();
      await expect(
        s.stabilityPool.connect(s.bob).absorbLiquidationPrefunded(await s.paxg.getAddress(), 1n)
      ).to.be.revertedWithCustomError(s.stabilityPool, "AccessControlUnauthorizedAccount");
    });
  });

  describe("the pool path works while the vault is paused", function () {
    it("liquidates through the pool during a guardian pause; liquidate and mint stay paused", async function () {
      const s = await loadOpen();
      await s.stabilityPool.connect(s.alice).deposit(e("40000"));
      await liquidatable(s);
      await s.vault.connect(s.guardian).emergencyPause();

      await expect(s.vault.connect(s.bob).liquidate(s.charlie.address, 0, GAS)).to.be.revertedWithCustomError(
        s.vault,
        "EnforcedPause"
      );
      await expect(s.vault.connect(s.alice).mint(e("1"))).to.be.revertedWithCustomError(s.vault, "EnforcedPause");

      const before = await s.stabilityPool.getTotalDeposits();
      await s.vault.connect(s.bob).liquidateViaPool(s.charlie.address, 0, GAS);
      expect((await s.vault.vaults(s.charlie.address)).debtAmount).to.equal(0n);
      expect(await s.stabilityPool.getTotalDeposits()).to.be.lt(before);
      expect(await s.vault.paused()).to.equal(true);
    });

    it("still refuses a healthy vault while paused", async function () {
      const s = await loadOpen();
      await s.stabilityPool.connect(s.alice).deposit(e("40000"));
      await openPaxgVault(s, s.charlie, 10n);
      await s.vault.connect(s.guardian).emergencyPause();
      await expect(s.vault.connect(s.bob).liquidateViaPool(s.charlie.address, 0, GAS)).to.be.revertedWith(
        "Not undercollateralised"
      );
    });
  });

  describe("a thin solvent vault takes a pro rata partial", function () {
    it("lets a pool smaller than the vault work it down without worsening its ratio", async function () {
      const s = await loadOpen();
      await s.vault.setMinDebt(e("1000"));
      const { amount } = await liquidatable(s, 1_040_000n, 40n);
      await s.stabilityPool.connect(s.alice).deposit(e("40000"));
      await expect(s.vault.connect(s.bob).liquidateViaPool(s.charlie.address, 0, GAS)).to.be.revertedWith(
        "Pool insufficient"
      );

      const ratioBefore = await s.vault.getCollateralisationRatio(s.charlie.address);
      const debt = await s.vault.getVaultCurrentDebt(s.charlie.address);
      await s.vault.connect(s.bob).liquidateViaPool(s.charlie.address, debt / 2n, GAS);

      const v = await s.vault.vaults(s.charlie.address);
      expect(v.collateralAmount).to.be.closeTo(amount / 2n, amount / 100_000n);
      expect(await s.vault.getCollateralisationRatio(s.charlie.address)).to.be.closeTo(ratioBefore, 50n);
      expect(await s.vault.totalBadDebt()).to.equal(0n);
    });

    it("still refuses a partial on an underwater vault", async function () {
      const s = await loadOpen();
      const { paxg, amount } = await liquidatable(s, 1_040_000n, 10n);
      const under = await priceForRatio(s, s.charlie.address, amount, 960_000n);
      await walkPrice(s, paxg, s.paxgFeed, under);
      const debt = await s.vault.getVaultCurrentDebt(s.charlie.address);
      await expect(s.vault.connect(s.bob).liquidate(s.charlie.address, debt / 2n, GAS)).to.be.revertedWith(
        "Thin vault: liquidate in full"
      );
    });
  });

  describe("per-block mint cap nets a mint repaid in its own block", function () {
    async function inOneBlock(sends: Array<() => Promise<{ wait: () => Promise<unknown> }>>) {
      await network.provider.send("evm_setAutomine", [false]);
      try {
        const sent = [];
        for (const send of sends) sent.push(await send());
        await network.provider.send("evm_mine");
        return await Promise.allSettled(sent.map((tx) => tx.wait()));
      } finally {
        await network.provider.send("evm_setAutomine", [true]);
      }
    }

    it("mint then repay in one block leaves the cap for everyone else", async function () {
      const s = await loadOpen();
      const paxg = await s.paxg.getAddress();
      await s.vault.setPerBlockMintCap(e("50000"));
      await s.vault.connect(s.bob).deposit(paxg, e("60"), GAS);
      await s.vault.connect(s.alice).deposit(paxg, e("10"), GAS);
      const tx = { gasLimit: 3_000_000n };

      const results = await inOneBlock([
        () => s.vault.connect(s.bob).mint(e("50000"), tx),
        () => s.vault.connect(s.bob).repay(ethers.MaxUint256, tx),
        () => s.vault.connect(s.alice).mint(e("1000"), tx),
      ]);
      expect(results.map((r) => r.status)).to.deep.equal(["fulfilled", "fulfilled", "fulfilled"]);
      const block = await ethers.provider.getBlockNumber();
      expect(await s.vault.blockMinted(block)).to.equal(e("1000"));
      expect((await s.vault.vaults(s.bob.address)).debtAmount).to.equal(0n);
    });

    it("a second repay in the block retires no more cap room than the account minted", async function () {
      const s = await loadOpen();
      const paxg = await s.paxg.getAddress();
      await s.vault.connect(s.bob).deposit(paxg, e("60"), GAS);
      await s.vault.connect(s.alice).deposit(paxg, e("10"), GAS);
      await s.vault.connect(s.charlie).deposit(await s.xaut.getAddress(), 10_000_000n, GAS);
      // Debt from an earlier block: repaying it must never make room under this block's cap.
      await s.vault.connect(s.bob).mint(e("5000"), GAS);
      await s.vault.setPerBlockMintCap(e("10000"));
      const tx = { gasLimit: 3_000_000n };

      const results = await inOneBlock([
        () => s.vault.connect(s.alice).mint(e("6000"), tx),
        () => s.vault.connect(s.bob).mint(e("1000"), tx),
        () => s.vault.connect(s.bob).repay(e("1000"), tx),
        () => s.vault.connect(s.bob).repay(e("1000"), tx),
        // Alice's 6,000 is still out, so 4,000 of room is left and not one unit more.
        () => s.vault.connect(s.charlie).mint(e("4001"), tx),
        () => s.vault.connect(s.charlie).mint(e("4000"), tx),
      ]);
      expect(results.map((r) => r.status)).to.deep.equal([
        "fulfilled",
        "fulfilled",
        "fulfilled",
        "fulfilled",
        "rejected",
        "fulfilled",
      ]);
      const block = await ethers.provider.getBlockNumber();
      // The two repayments together retired exactly the 1,000 Bob minted in the block.
      expect(await s.vault.blockMinted(block)).to.equal(e("10000"));
    });

    it("control: a mint that stays out fills the cap", async function () {
      const s = await loadOpen();
      const paxg = await s.paxg.getAddress();
      await s.vault.setPerBlockMintCap(e("50000"));
      await s.vault.connect(s.bob).deposit(paxg, e("60"), GAS);
      await s.vault.connect(s.alice).deposit(paxg, e("10"), GAS);
      const tx = { gasLimit: 3_000_000n };

      const results = await inOneBlock([
        () => s.vault.connect(s.bob).mint(e("50000"), tx),
        () => s.vault.connect(s.alice).mint(e("1000"), tx),
      ]);
      expect(results.map((r) => r.status)).to.deep.equal(["fulfilled", "rejected"]);
    });
  });

  describe("every burn is damped from the supply before it", function () {
    it("banks the pre-burn supply even when the average lags recent growth", async function () {
      const s = await loadOpen();
      await time.increase(2 * 24 * 60 * 60);
      await s.stablecoin.mint(s.bob.address, e("1000000"));
      expect(await s.stablecoin.smoothedSupplyNow()).to.be.lt(await s.stablecoin.totalSupply());

      const before = await s.stablecoin.totalSupply();
      await s.stablecoin.connect(s.bob).burn(e("500000"));
      expect(await s.stablecoin.smoothedSupply()).to.equal(before);
      expect(await s.reserve.dampedCirculatingSupply()).to.be.gt(before - e("1000"));
    });
  });

  describe("StabilityPool.getCollateralGain for an unlisted token", function () {
    it("answers zero instead of dividing by zero", async function () {
      const s = await loadOpen();
      await s.stabilityPool.connect(s.alice).deposit(e("1000"));
      expect(await s.stabilityPool.getCollateralGain(s.alice.address, ethers.Wallet.createRandom().address)).to.equal(0n);
    });
  });
});
