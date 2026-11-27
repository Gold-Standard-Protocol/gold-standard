import { expect } from "chai";
import hre, { ethers } from "hardhat";
import { takeSnapshot } from "@nomicfoundation/hardhat-network-helpers";
import { loadOpen, walkPrice, openPaxgVault, fundGsusd, type System } from "./helpers/openProfile";

/**
 * Liquidation gas grows with the silos a vault spans, and the open launch profile
 * expects whales. These bounds pin the cost at 1, 5, 10 and 20 silos (100 oz each) so a
 * regression is caught, and a second group pins that silos left empty after a peak cost nothing.
 * The keeper derives its gas from estimateGas with a margin, not from these figures.
 */
describe("Liquidation gas by silo count", function () {
  this.timeout(300_000);

  // Measured 2026-10-24 on Hardhat: 522k, 589k, 669k, 830k; about 16k per extra silo.
  const LIQUIDATE_BOUND: Record<number, bigint> = { 1: 575_000n, 5: 650_000n, 10: 740_000n, 20: 915_000n };
  // Measured 2026-10-24 on Hardhat: 419k, 486k, 567k, 728k.
  const VIA_POOL_BOUND: Record<number, bigint> = { 1: 465_000n, 5: 535_000n, 10: 625_000n, 20: 800_000n };

  async function gasOf(tx: Promise<{ wait: () => Promise<{ gasUsed: bigint } | null> }>) {
    const receipt = await (await tx).wait();
    if (receipt === null) throw new Error("no receipt");
    return receipt.gasUsed;
  }

  async function liquidatableWhale(s: System, oz: bigint) {
    const paxg = await s.paxg.getAddress();
    const { debt } = await openPaxgVault(s, s.charlie, oz);
    await fundGsusd(s, s.bob, debt * 2n);
    await fundGsusd(s, s.alice, debt * 2n);
    await s.stabilityPool.connect(s.alice).deposit(debt * 2n);
    await walkPrice(s, paxg, s.paxgFeed, 165_000_000_000n);
    expect(await s.vault.getCollateralisationRatio(s.charlie.address)).to.be.lt(1_100_000n);
  }

  const measured: Array<[number, bigint, bigint]> = [];

  // solidity-coverage instruments the bytecode, which adds about 6% to every call, so the
  // absolute budgets hold only on normal bytecode. Under `npm run coverage` both paths still
  // run for coverage; the budgets are enforced by `npm test` in contracts-ci.
  // The flag is an untyped property solidity-coverage sets on the runtime environment.
  const coverageRun = (hre as unknown as { __SOLIDITY_COVERAGE_RUNNING?: boolean }).__SOLIDITY_COVERAGE_RUNNING === true;

  for (const silos of [1, 5, 10, 20]) {
    it(`a ${silos * 100} oz vault across ${silos} silos stays under the bound on both paths`, async function () {
      const s = await loadOpen();
      await liquidatableWhale(s, BigInt(silos * 100));
      expect(await s.siloFactory.getSiloCount(await s.paxg.getAddress())).to.equal(BigInt(silos));
      const snap = await takeSnapshot();
      const viaPool = await gasOf(s.vault.connect(s.bob).liquidateViaPool(s.charlie.address, 0, { gasLimit: 16_000_000n }));
      await snap.restore();
      const direct = await gasOf(s.vault.connect(s.bob).liquidate(s.charlie.address, 0, { gasLimit: 16_000_000n }));
      measured.push([silos, direct, viaPool]);
      if (coverageRun) return;
      expect(direct, "liquidate").to.be.lte(LIQUIDATE_BOUND[silos]);
      expect(viaPool, "liquidateViaPool").to.be.lte(VIA_POOL_BOUND[silos]);
    });
  }

  after(function () {
    for (const [silos, direct, viaPool] of measured) {
      // eslint-disable-next-line no-console
      console.log(`      ${String(silos).padStart(2)} silos: liquidate ${direct} gas, liquidateViaPool ${viaPool} gas`);
    }
  });

  it("silos left empty after a 3,000 oz peak add nothing to a later liquidation", async function () {
    const s = await loadOpen();
    const paxg = await s.paxg.getAddress();
    const costOfSmallLiquidation = async () => {
      const { debt } = await openPaxgVault(s, s.charlie, 20n);
      await fundGsusd(s, s.bob, debt * 2n);
      await walkPrice(s, paxg, s.paxgFeed, 165_000_000_000n);
      return gasOf(s.vault.connect(s.bob).liquidate(s.charlie.address, 0, { gasLimit: 16_000_000n }));
    };
    const snap = await takeSnapshot();
    const lean = await costOfSmallLiquidation();
    await snap.restore();

    // A whale parks 3,000 oz debt free and leaves: thirty empty clones above the cursor.
    const amount = ethers.parseEther("3000");
    await s.paxg.mint(s.deployer.address, amount);
    await s.paxg.approve(await s.vault.getAddress(), amount);
    await s.vault.deposit(paxg, amount, { gasLimit: 16_000_000n });
    await s.vault.withdraw(amount, { gasLimit: 16_000_000n });
    expect(await s.siloFactory.getSiloCount(paxg)).to.equal(30n);
    const afterPeak = await costOfSmallLiquidation();
    expect(afterPeak).to.be.lte(lean + 5_000n);
  });
});
