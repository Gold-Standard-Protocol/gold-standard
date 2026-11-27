import { expect } from "chai";
import { ethers } from "hardhat";
import { takeSnapshot } from "@nomicfoundation/hardhat-network-helpers";
import { loadOpen, walkPrice, openPaxgVault, priceForRatio, fundGsusd, type System } from "./helpers/openProfile";

/**
 * Between 100% and 100% plus the
 * penalty a partial is taken pro rata on every path. A partial sized at the full (1 + penalty)
 * multiple paid the liquidator more than a full liquidation and left 1 wei of gold against
 * thousands of GSUSD; refusing every partial instead left a vault larger than the pool with no
 * pool path at all. Pro rata, the same share of the gold leaves as of the debt, so the ratio
 * is unchanged and no zombie is possible; the MIN_DEBT floor still applies. Above the line
 * partials behave as before.
 */
describe("Liquidation below 100% plus the penalty", function () {
  this.timeout(120_000);

  const OZ = 400n;
  const PENALTY = 50_000n;
  const MIN_DEBT = ethers.parseEther("1000");

  async function thinVault(s: System, ratioPpm: bigint) {
    const paxg = await s.paxg.getAddress();
    await s.vault.setMinDebt(MIN_DEBT);
    const { amount } = await openPaxgVault(s, s.charlie, OZ);
    await fundGsusd(s, s.bob, ethers.parseEther("2000000"));
    await fundGsusd(s, s.alice, ethers.parseEther("3000000"));
    const price = await priceForRatio(s, s.charlie.address, amount, ratioPpm);
    await walkPrice(s, paxg, s.paxgFeed, price);
    return { amount, price };
  }

  /** The largest partial whose own seizure still fits inside the vault's collateral. */
  function largestFittingPartial(collateral: bigint, price: bigint): bigint {
    const seizeOf = (d: bigint) => (d * (1_000_000n + PENALTY) * 100_000_000n) / (price * 1_000_000n);
    let x = (collateral * price * 1_000_000n) / (100_000_000n * (1_000_000n + PENALTY));
    while (seizeOf(x) > collateral) x -= 1n;
    return x;
  }

  it("takes a partial at 104% pro rata on liquidate, liquidateViaPool and emergencyLiquidate", async function () {
    const s = await loadOpen();
    const { amount, price } = await thinVault(s, 1_040_000n);
    const ratio = await s.vault.getCollateralisationRatio(s.charlie.address);
    expect(ratio).to.be.within(1_039_000n, 1_041_000n);
    // The stranding shape: the largest partial that would fit at the full penalty multiple.
    const partial = largestFittingPartial(amount, price);
    const debt = await s.vault.getVaultCurrentDebt(s.charlie.address);
    expect(partial).to.be.lt(debt);
    await expect(
      s.vault.connect(s.bob).liquidate(s.charlie.address, debt - ethers.parseEther("1"), { gasLimit: 16_000_000n })
    ).to.be.revertedWith("Residual debt below minimum");

    await s.stabilityPool.connect(s.alice).deposit(ethers.parseEther("1800000"));
    const snap = await takeSnapshot();
    const proRata = async (run: () => Promise<unknown>) => {
      await run();
      const v = await s.vault.vaults(s.charlie.address);
      expect(v.collateralAmount).to.be.gt(0n);
      // The same share of the gold as of the debt: the ratio stays where it was.
      expect(await s.vault.getCollateralisationRatio(s.charlie.address)).to.be.closeTo(ratio, 100n);
      expect(await s.vault.totalBadDebt()).to.equal(0n);
    };
    const gas = { gasLimit: 16_000_000n };
    await proRata(() => s.vault.connect(s.bob).liquidate(s.charlie.address, partial, gas));
    await snap.restore();
    await proRata(() => s.vault.connect(s.bob).liquidateViaPool(s.charlie.address, partial, gas));
    await snap.restore();
    await s.vault.pause();
    await proRata(() => s.vault.connect(s.bob).emergencyLiquidate(s.charlie.address, debt / 2n, gas));
  });

  it("accepts a full liquidation at 104% on each path and books no bad debt", async function () {
    const s = await loadOpen();
    const { price } = await thinVault(s, 1_040_000n);
    await s.stabilityPool.connect(s.alice).deposit(ethers.parseEther("1800000"));
    const snap = await takeSnapshot();

    const settle = async (run: () => Promise<unknown>) => {
      const debt = await s.vault.getVaultCurrentDebt(s.charlie.address);
      await run();
      const v = await s.vault.vaults(s.charlie.address);
      expect(v.debtAmount).to.equal(0n);
      expect(v.collateralAmount).to.equal(0n);
      expect(await s.vault.totalBadDebt()).to.equal(0n);
      return debt;
    };

    const gold0 = await s.paxg.balanceOf(s.bob.address);
    const gsusd0 = await s.stablecoin.balanceOf(s.bob.address);
    const debt = await settle(() => s.vault.connect(s.bob).liquidate(s.charlie.address, 0, { gasLimit: 16_000_000n }));
    // The liquidator pays the whole debt (one more block of fee accrues before the call
    // lands) and receives the debt's worth of gold plus its share of what is left, which at
    // 104% is less than the full penalty.
    const paid = gsusd0 - (await s.stablecoin.balanceOf(s.bob.address));
    expect(paid).to.be.closeTo(debt, ethers.parseEther("1"));
    const received = (await s.paxg.balanceOf(s.bob.address)) - gold0;
    const debtEquivalent = (paid * 100_000_000n) / price;
    expect(received).to.be.gt(debtEquivalent);
    expect(received).to.be.lt((debtEquivalent * (1_000_000n + PENALTY)) / 1_000_000n);

    await snap.restore();
    await settle(() => s.vault.connect(s.bob).liquidateViaPool(s.charlie.address, 0, { gasLimit: 16_000_000n }));

    await snap.restore();
    await s.vault.pause();
    await settle(() => s.vault.connect(s.bob).emergencyLiquidate(s.charlie.address, 0, { gasLimit: 16_000_000n }));
  });

  it("still accepts a partial at 106%, which leaves a healthy remainder", async function () {
    const s = await loadOpen();
    const { amount } = await thinVault(s, 1_060_000n);
    expect(await s.vault.getCollateralisationRatio(s.charlie.address)).to.be.within(1_059_000n, 1_061_000n);
    const debt = await s.vault.getVaultCurrentDebt(s.charlie.address);
    await s.vault.connect(s.bob).liquidate(s.charlie.address, (debt * 90n) / 100n, { gasLimit: 16_000_000n });
    const v = await s.vault.vaults(s.charlie.address);
    expect(v.debtAmount).to.be.gte(MIN_DEBT);
    expect(v.collateralAmount).to.be.gt(0n);
    expect(v.collateralAmount).to.be.lt(amount);
    // A partial at the full penalty multiple strips gold faster than debt, but above the
    // line the remainder is still worth more than it owes.
    expect(await s.vault.getCollateralisationRatio(s.charlie.address)).to.be.gte(1_000_000n);
    expect(await s.vault.totalBadDebt()).to.equal(0n);
  });

  it("sits exactly on the line: a half partial settles on either side of it", async function () {
    const s = await loadOpen();
    await thinVault(s, 1_050_000n);
    const debt = await s.vault.getVaultCurrentDebt(s.charlie.address);
    const half = debt / 2n;
    // Pro rata below the line, at the full penalty multiple above it; both settle solvent.
    await expect(s.vault.connect(s.bob).liquidate(s.charlie.address, half, { gasLimit: 16_000_000n })).to.emit(
      s.vault,
      "Liquidated"
    );
    expect(await s.vault.getCollateralisationRatio(s.charlie.address)).to.be.gte(1_000_000n);
    expect(await s.vault.totalBadDebt()).to.equal(0n);
  });
});
