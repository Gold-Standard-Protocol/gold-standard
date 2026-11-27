import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { productionSystem, setValidPrice, GOLD_PRICE } from "./helpers/productionSystem";

/**
 * Regression tests for silo custody, pool claims, freezes, pauses and governance scheduling.
 * Each block names the fault it guards against.
 */
const DAY = 24 * 3600;
const SILO_CAP = ethers.parseEther("100");

type System = Awaited<ReturnType<typeof productionSystem>>;

// ---------------------------------------------------------------------------
// The cursor rewind undid setCurrentSiloIndex over a run of issuer-frozen,
// empty silos. The silo cap now has a floor.
// ---------------------------------------------------------------------------
describe("SiloFactory: the cursor never rewinds below governance's advance", function () {
  async function frozenRun() {
    const [admin, vaultRole, other] = await ethers.getSigners();
    const token = await (await ethers.getContractFactory("MockERC20Freezable")).deploy("Pax Gold", "PAXG");
    const factory = await (await ethers.getContractFactory("SiloFactory")).deploy(SILO_CAP);
    const tokenAddr = await token.getAddress();
    await factory.grantRole(await factory.VAULT_ROLE(), vaultRole.address);
    await token.mint(vaultRole.address, ethers.parseEther("10000"));
    await token.connect(vaultRole).approve(await factory.getAddress(), ethers.MaxUint256);

    // Silo 0 is full. The issuer pre-freezes the next nine silo addresses, one more than a
    // deposit may skip, so every deposit stops until governance moves the cursor past them.
    await factory.connect(vaultRole).deposit(tokenAddr, SILO_CAP);
    const maxSkips = Number(await factory.MAX_SKIPS_PER_DEPOSIT());
    const runEnd = maxSkips + 1;
    for (let i = 1; i <= runEnd; i++) {
      await token.setFrozen(await factory.predictSiloAddress(tokenAddr, i), true);
    }
    await expect(
      factory.connect(vaultRole).deposit(tokenAddr, ethers.parseEther("1"), { gasLimit: 16_000_000n })
    ).to.be.revertedWith("Too many unusable silos");

    const past = runEnd + 1;
    await expect(factory.setCurrentSiloIndex(tokenAddr, past))
      .to.emit(factory, "CurrentSiloIndexSet")
      .withArgs(tokenAddr, past);
    return { admin, vaultRole, other, token, tokenAddr, factory, past };
  }

  it("records governance's advance as the floor", async function () {
    const { factory, tokenAddr, past } = await loadFixture(frozenRun);
    expect(await factory.minSiloIndex(tokenAddr)).to.equal(BigInt(past));
    expect(await factory.currentSiloIndex(tokenAddr)).to.equal(BigInt(past));
  });

  it("a withdrawal that empties the silo above the run leaves the cursor there, and deposits keep working", async function () {
    const { factory, vaultRole, other, tokenAddr, past } = await loadFixture(frozenRun);
    const small = ethers.parseEther("5");
    await factory.connect(vaultRole).deposit(tokenAddr, small, { gasLimit: 16_000_000n });
    expect(await factory.currentSiloIndex(tokenAddr)).to.equal(BigInt(past));

    // Emptying silo `past` used to walk the cursor back over the empty frozen run to silo 0.
    await factory.connect(vaultRole).withdraw(tokenAddr, other.address, small, { gasLimit: 16_000_000n });
    expect(await factory.currentSiloIndex(tokenAddr)).to.equal(BigInt(past));

    await factory.connect(vaultRole).deposit(tokenAddr, small, { gasLimit: 16_000_000n });
    expect(await factory.totalCollateral(tokenAddr)).to.equal(SILO_CAP + small);
  });

  it("a withdrawal reaching below the floor still pays out of the older silos and keeps the cursor at the floor", async function () {
    const { factory, vaultRole, other, token, tokenAddr, past } = await loadFixture(frozenRun);
    const small = ethers.parseEther("5");
    await factory.connect(vaultRole).deposit(tokenAddr, small, { gasLimit: 16_000_000n });

    // 5 from silo `past`, 45 from silo 0, which keeps a balance: the walk's holder is silo 0.
    await factory.connect(vaultRole).withdraw(tokenAddr, other.address, ethers.parseEther("50"), { gasLimit: 16_000_000n });
    expect(await token.balanceOf(other.address)).to.equal(ethers.parseEther("50"));
    expect(await factory.currentSiloIndex(tokenAddr)).to.equal(BigInt(past));

    await factory.connect(vaultRole).deposit(tokenAddr, small, { gasLimit: 16_000_000n });
    // What sits below the floor stays withdrawable.
    await factory.connect(vaultRole).withdraw(tokenAddr, other.address, ethers.parseEther("60"), { gasLimit: 16_000_000n });
    expect(await factory.totalCollateral(tokenAddr)).to.equal(0n);
    expect(await factory.currentSiloIndex(tokenAddr)).to.equal(BigInt(past));
  });
});

describe("SiloFactory: minimum silo cap", function () {
  it("refuses a cap below 0.01 oz in the constructor and in setSiloCap", async function () {
    const SiloF = await ethers.getContractFactory("SiloFactory");
    const min = ethers.parseEther("0.01");
    expect(min).to.equal(10n ** 16n);
    await expect(SiloF.deploy(min - 1n)).to.be.revertedWith("Invalid cap");
    const factory = await SiloF.deploy(min);
    expect(await factory.MIN_SILO_CAP()).to.equal(min);
    await expect(factory.setSiloCap(min - 1n)).to.be.revertedWith("Invalid cap");
    await factory.setSiloCap(min);
    expect(await factory.siloCap()).to.equal(min);
  });

  it("at the minimum cap a 6-decimal token still fills silos instead of finding every silo full", async function () {
    const [, vaultRole] = await ethers.getSigners();
    const xaut = await (await ethers.getContractFactory("MockERC20")).deploy("Tether Gold", "XAUT", 6);
    const factory = await (await ethers.getContractFactory("SiloFactory")).deploy(10n ** 16n);
    await factory.grantRole(await factory.VAULT_ROLE(), vaultRole.address);
    await xaut.mint(vaultRole.address, 1_000_000n);
    await xaut.connect(vaultRole).approve(await factory.getAddress(), ethers.MaxUint256);
    // 0.01 oz is 10,000 units of a 6-decimal token: 25,000 units span three silos.
    await factory.connect(vaultRole).deposit(await xaut.getAddress(), 25_000n, { gasLimit: 16_000_000n });
    expect(await factory.getSiloCount(await xaut.getAddress())).to.equal(3n);
    expect(await factory.totalCollateral(await xaut.getAddress())).to.equal(25_000n);
  });
});

// ---------------------------------------------------------------------------
// A claim larger than what the pool holds after an issuer wipe reverted and
// trapped the gold that remained.
// ---------------------------------------------------------------------------
describe("StabilityPool.claimCollateral after an issuer wipe", function () {
  async function wipedPool() {
    const [, vault, alice, bob, issuer] = await ethers.getSigners();
    const gsusd = await (await ethers.getContractFactory("MockERC20")).deploy("Gold Standard Dollar", "GSUSD", 18);
    const gold = await (await ethers.getContractFactory("MockERC20Freezable")).deploy("Pax Gold", "PAXG");
    const pool = await (await ethers.getContractFactory("StabilityPool")).deploy(await gsusd.getAddress());
    const poolAddr = await pool.getAddress();
    const goldAddr = await gold.getAddress();
    await pool.grantRole(await pool.VAULT_ROLE(), vault.address);
    await pool.addCollateralToken(goldAddr);
    for (const who of [alice, bob]) {
      await gsusd.mint(who.address, ethers.parseEther("1000"));
      await gsusd.connect(who).approve(poolAddr, ethers.MaxUint256);
      await pool.connect(who).deposit(ethers.parseEther("1000"));
    }
    // Ten ounces sent to the pool and absorbed against 500 GSUSD: five ounces earned by
    // each depositor.
    await gold.mint(poolAddr, ethers.parseEther("10"));
    await pool.connect(vault).absorbLiquidationPrefunded(goldAddr, ethers.parseEther("500"));
    expect(await pool.getCollateralGain(alice.address, goldAddr)).to.equal(ethers.parseEther("5"));

    // The issuer freezes the pool, wipes it and releases it.
    await gold.setFrozen(poolAddr, true);
    await gold.wipeFrozenAddress(poolAddr);
    await gold.setFrozen(poolAddr, false);
    expect(await gold.balanceOf(poolAddr)).to.equal(0n);
    await gold.mint(issuer.address, ethers.parseEther("10"));
    return { pool, gold, goldAddr, poolAddr, alice, bob, issuer };
  }

  it("pays what the pool holds and keeps the rest pending", async function () {
    const { pool, gold, goldAddr, poolAddr, alice, bob, issuer } = await loadFixture(wipedPool);
    // Three ounces come back (a reissue, a donation): less than alice's five.
    await gold.connect(issuer).transfer(poolAddr, ethers.parseEther("3"));

    await expect(pool.connect(alice).claimCollateral(goldAddr))
      .to.emit(pool, "CollateralClaimed")
      .withArgs(alice.address, goldAddr, ethers.parseEther("3"));
    expect(await gold.balanceOf(alice.address)).to.equal(ethers.parseEther("3"));
    expect(await pool.pendingCollateralGain(alice.address, goldAddr)).to.equal(ethers.parseEther("2"));
    expect(await pool.getCollateralGain(alice.address, goldAddr)).to.equal(ethers.parseEther("2"));

    // Nothing left: a clear refusal, and bob's five ounces stay owed to him.
    await expect(pool.connect(bob).claimCollateral(goldAddr)).to.be.revertedWith("No collateral held");
    expect(await pool.getCollateralGain(bob.address, goldAddr)).to.equal(ethers.parseEther("5"));

    // The rest arrives and both claims complete.
    await gold.connect(issuer).transfer(poolAddr, ethers.parseEther("7"));
    await pool.connect(alice).claimCollateral(goldAddr);
    await pool.connect(bob).claimCollateral(goldAddr);
    expect(await gold.balanceOf(alice.address)).to.equal(ethers.parseEther("5"));
    expect(await gold.balanceOf(bob.address)).to.equal(ethers.parseEther("5"));
    expect(await pool.pendingCollateralGain(alice.address, goldAddr)).to.equal(0n);
    expect(await pool.pendingCollateralGain(bob.address, goldAddr)).to.equal(0n);
    await expect(pool.connect(alice).claimCollateral(goldAddr)).to.be.revertedWith("No gains");
  });

  it("a claim within the balance is paid in full, as before", async function () {
    const { pool, gold, goldAddr, poolAddr, alice, issuer } = await loadFixture(wipedPool);
    await gold.connect(issuer).transfer(poolAddr, ethers.parseEther("10"));
    await pool.connect(alice).claimCollateral(goldAddr);
    expect(await gold.balanceOf(alice.address)).to.equal(ethers.parseEther("5"));
    expect(await pool.pendingCollateralGain(alice.address, goldAddr)).to.equal(0n);
  });
});

// ---------------------------------------------------------------------------
// The guardian's freeze stops seizures of the token during a pause as well.
// ---------------------------------------------------------------------------
describe("A frozen token cannot be seized during a pause", function () {
  const UNDERWATER = 130000000000n; // $1,300: 10 PAXG against 12,000 GSUSD is 108%

  async function frozenInAPause() {
    const s = await productionSystem();
    const paxgAddr = await s.paxg.getAddress();
    await s.vault.connect(s.alice).deposit(paxgAddr, ethers.parseEther("10"));
    await s.vault.connect(s.alice).mint(ethers.parseEther("12000"));
    await s.stabilityPool.connect(s.alice).deposit(ethers.parseEther("30000"));
    await setValidPrice(s.paxgFeed, UNDERWATER);
    await s.oracle.connect(s.guardian).freezeToken(paxgAddr);
    return { ...s, paxgAddr };
  }

  it("refuses emergencyLiquidate and liquidateViaPool while the vault is paused", async function () {
    const s = await loadFixture(frozenInAPause);
    await s.vault.connect(s.guardian).emergencyPause();
    await expect(s.vault.connect(s.bob).emergencyLiquidate(s.alice.address, 0)).to.be.revertedWith("Token frozen");
    await expect(s.vault.connect(s.bob).liquidateViaPool(s.alice.address, 0)).to.be.revertedWith("Token frozen");
  });

  it("refuses both while the oracle is paused", async function () {
    const s = await loadFixture(frozenInAPause);
    await s.oracle.connect(s.guardian).emergencyPause();
    await expect(s.vault.connect(s.bob).emergencyLiquidate(s.alice.address, 0)).to.be.revertedWith("Token frozen");
    await expect(s.vault.connect(s.bob).liquidateViaPool(s.alice.address, 0)).to.be.revertedWith("Token frozen");
  });

  it("the guardian can lift the freeze while both are paused, and the seizure then proceeds", async function () {
    const s = await loadFixture(frozenInAPause);
    await s.vault.connect(s.guardian).emergencyPause();
    await s.oracle.connect(s.guardian).emergencyPause();
    await expect(s.oracle.connect(s.guardian).guardianUnfreezeToken(s.paxgAddr, await s.oracle.freezeEpoch(s.paxgAddr)))
      .to.emit(s.oracle, "TokenUnfrozen")
      .withArgs(s.paxgAddr, s.guardian.address, UNDERWATER);
    await s.vault.connect(s.bob).liquidateViaPool(s.alice.address, 0);
    expect((await s.vault.vaults(s.alice.address)).debtAmount).to.equal(0n);
  });

  it("with nobody acting, the freeze lapses after 14 days and the paused vault can be liquidated", async function () {
    const s = await loadFixture(frozenInAPause);
    await s.vault.connect(s.guardian).emergencyPause();
    await time.increase(14 * DAY - 60);
    await setValidPrice(s.paxgFeed, UNDERWATER);
    await expect(s.vault.connect(s.bob).emergencyLiquidate(s.alice.address, 0)).to.be.revertedWith("Token frozen");
    await time.increase(120);
    await setValidPrice(s.paxgFeed, UNDERWATER);
    expect(await s.oracle.tokenFrozen(s.paxgAddr)).to.equal(false);
    expect(await s.vault.paused()).to.equal(true);
    await s.vault.connect(s.bob).emergencyLiquidate(s.alice.address, 0);
    expect((await s.vault.vaults(s.alice.address)).debtAmount).to.equal(0n);
  });
});

// ---------------------------------------------------------------------------
// The reserve's per-asset pause lapses after 14 days.
// remainingDailyCapacity honours the aggregate USD cap.
// ---------------------------------------------------------------------------
describe("GoldStabilityReserve asset pause lapses", function () {
  async function seeded() {
    const s = await productionSystem();
    const paxgAddr = await s.paxg.getAddress();
    const xautAddr = await s.xaut.getAddress();
    await s.paxg.connect(s.alice).approve(await s.reserve.getAddress(), ethers.MaxUint256);
    await s.reserve.connect(s.alice).seedCollateral(paxgAddr, ethers.parseEther("10"));
    await s.xaut.connect(s.charlie).approve(await s.reserve.getAddress(), ethers.MaxUint256);
    await s.reserve.connect(s.charlie).seedCollateral(xautAddr, 10_000_000n);
    return { ...s, paxgAddr, xautAddr };
  }

  async function fresh(s: System) {
    await setValidPrice(s.paxgFeed, GOLD_PRICE);
    await setValidPrice(s.xautFeed, GOLD_PRICE);
  }

  it("stops swaps for 14 days, then lifts with nobody acting", async function () {
    const s = await loadFixture(seeded);
    await s.reserve.connect(s.guardian).pauseAsset(s.paxgAddr);
    expect(await s.reserve.ASSET_PAUSE_DURATION()).to.equal(BigInt(14 * DAY));
    expect(await s.reserve.assetPaused(s.paxgAddr)).to.equal(true);
    expect(await s.reserve.remainingDailyCapacity(s.paxgAddr)).to.equal(0n);
    await expect(s.reserve.connect(s.alice).swapGsusdForGold(s.paxgAddr, ethers.parseEther("100"), 0)).to.be.revertedWith(
      "Asset paused"
    );
    // XAUT keeps swapping: the pause is per asset.
    await s.reserve.connect(s.alice).swapGsusdForGold(s.xautAddr, ethers.parseEther("100"), 0);

    await time.increase(14 * DAY - 60);
    await fresh(s);
    expect(await s.reserve.assetPaused(s.paxgAddr)).to.equal(true);
    await time.increase(120);
    await fresh(s);
    expect(await s.reserve.assetPaused(s.paxgAddr)).to.equal(false);
    expect(await s.reserve.remainingDailyCapacity(s.paxgAddr)).to.be.greaterThan(0n);
    await s.reserve.connect(s.alice).swapGsusdForGold(s.paxgAddr, ethers.parseEther("100"), 0);
  });

  it("the guardian extends an active pause by pausing again", async function () {
    const s = await loadFixture(seeded);
    await s.reserve.connect(s.guardian).pauseAsset(s.paxgAddr);
    await time.increase(10 * DAY);
    await s.reserve.connect(s.guardian).pauseAsset(s.paxgAddr);
    const until = (await s.reserve.assets(s.paxgAddr)).pausedUntil;
    expect(until).to.equal(BigInt(await time.latest()) + BigInt(14 * DAY));
    await time.increase(10 * DAY);
    expect(await s.reserve.assetPaused(s.paxgAddr)).to.equal(true);
    await time.increaseTo(until);
    expect(await s.reserve.assetPaused(s.paxgAddr)).to.equal(false);
  });

  it("governance lifts it early; the guardian and strangers cannot", async function () {
    const s = await loadFixture(seeded);
    await s.reserve.connect(s.guardian).pauseAsset(s.paxgAddr);
    await expect(s.reserve.connect(s.guardian).unpauseAsset(s.paxgAddr, 1n)).to.be.revertedWithCustomError(
      s.reserve,
      "AccessControlUnauthorizedAccount"
    );
    await expect(s.reserve.connect(s.bob).pauseAsset(s.paxgAddr)).to.be.revertedWith("Not guardian or governance");
    await expect(s.reserve.unpauseAsset(s.paxgAddr, await s.reserve.assetPauseEpoch(s.paxgAddr))).to.emit(s.reserve, "AssetUnpaused").withArgs(s.paxgAddr);
    expect(await s.reserve.assetPaused(s.paxgAddr)).to.equal(false);
    expect((await s.reserve.assets(s.paxgAddr)).pausedUntil).to.equal(0n);
    await s.reserve.connect(s.alice).swapGsusdForGold(s.paxgAddr, ethers.parseEther("100"), 0);
  });

  it("a paused asset counts toward coverage again once its pause lapses", async function () {
    const s = await loadFixture(seeded);
    const before = await s.reserve.reserveValueUsd();
    await s.reserve.connect(s.guardian).pauseAsset(s.paxgAddr);
    expect(await s.reserve.reserveValueUsd()).to.be.lessThan(before);
    await time.increase(14 * DAY);
    await fresh(s);
    expect(await s.reserve.reserveValueUsd()).to.equal(before);
  });
});

describe("GoldStabilityReserve.remainingDailyCapacity and the aggregate cap", function () {
  async function capped() {
    const s = await productionSystem();
    const paxgAddr = await s.paxg.getAddress();
    const xautAddr = await s.xaut.getAddress();
    await s.paxg.connect(s.alice).approve(await s.reserve.getAddress(), ethers.MaxUint256);
    await s.reserve.connect(s.alice).seedCollateral(paxgAddr, ethers.parseEther("10"));
    await s.xaut.connect(s.charlie).approve(await s.reserve.getAddress(), ethers.MaxUint256);
    await s.reserve.connect(s.charlie).seedCollateral(xautAddr, 10_000_000n);
    // $3,000 a day across every asset: 1.5 oz at $2,000.
    await s.reserve.setAggregateDailyCap(ethers.parseEther("3000"));
    return { ...s, paxgAddr, xautAddr };
  }

  it("answers the smaller of the per-asset room and the aggregate room, for 18 and 6 decimals", async function () {
    const s = await loadFixture(capped);
    expect(await s.reserve.remainingDailyCapacity(s.paxgAddr)).to.equal(ethers.parseEther("1.5"));
    expect(await s.reserve.remainingDailyCapacity(s.xautAddr)).to.equal(1_500_000n);
  });

  it("a swap within the answer succeeds and the answer shrinks across assets; one beyond it is refused", async function () {
    const s = await loadFixture(capped);
    // 3,000 GSUSD at a 0.5% spread: 2,985 net, 1.4925 oz.
    await s.reserve.connect(s.alice).swapGsusdForGold(s.paxgAddr, ethers.parseEther("3000"), 0);
    // $15 of the day is left, shared by both assets.
    expect(await s.reserve.remainingDailyCapacity(s.paxgAddr)).to.equal(ethers.parseEther("0.0075"));
    expect(await s.reserve.remainingDailyCapacity(s.xautAddr)).to.equal(7_500n);
    const [over] = await s.reserve.quoteGoldOut(s.paxgAddr, ethers.parseEther("20"));
    expect(over).to.be.greaterThan(ethers.parseEther("0.0075"));
    await expect(
      s.reserve.connect(s.alice).swapGsusdForGold(s.paxgAddr, ethers.parseEther("20"), 0)
    ).to.be.revertedWith("Aggregate daily cap reached");
    await s.reserve.connect(s.alice).swapGsusdForGold(s.paxgAddr, ethers.parseEther("15"), 0);
  });

  it("answers 0 with no reserve price, with the cap on and with it off, and the per-asset room once the price is back", async function () {
    const s = await loadFixture(capped);
    await time.increase(7200); // past the fixture's one hour staleness bound
    expect(await s.reserve.remainingDailyCapacity(s.paxgAddr)).to.equal(0n);
    // No swap can run without a reserve price, whatever the aggregate cap is set to.
    await s.reserve.setAggregateDailyCap(0n);
    expect(await s.reserve.remainingDailyCapacity(s.paxgAddr)).to.equal(0n);
    await expect(
      s.reserve.connect(s.alice).swapGsusdForGold(s.paxgAddr, ethers.parseEther("100"), 0)
    ).to.be.revertedWith("No reliable price");
    await setValidPrice(s.paxgFeed, GOLD_PRICE);
    await setValidPrice(s.xautFeed, GOLD_PRICE);
    expect(await s.reserve.remainingDailyCapacity(s.paxgAddr)).to.equal(ethers.parseEther("10"));
  });
});

// ---------------------------------------------------------------------------
// The GoldGovernance helpers schedule at the timelock's live delay.
// Proposal-time range guards on minDebt and the underwater discount.
// ---------------------------------------------------------------------------
describe("GoldGovernance scheduling", function () {
  async function governed() {
    const [, proposer, executor] = await ethers.getSigners();
    const vault = ethers.Wallet.createRandom().address;
    const governance = await (await ethers.getContractFactory("GoldGovernance")).deploy(
      [proposer.address],
      [executor.address],
      vault,
      ethers.Wallet.createRandom().address,
      ethers.Wallet.createRandom().address
    );
    const timelock = await ethers.getContractAt("TimelockController", await governance.getTimelockAddress());
    return { governance, timelock, proposer, executor, vault };
  }

  async function proposalOf(s: Awaited<ReturnType<typeof governed>>, tx: Promise<{ wait: () => Promise<unknown> }>) {
    const receipt = (await (await tx).wait()) as { logs: Parameters<typeof s.governance.interface.parseLog>[0][] };
    const event = receipt.logs
      .map((log) => s.governance.interface.parseLog(log))
      .find((parsed) => parsed?.name === "ProposalCreated");
    return { id: event!.args.id as string, eta: event!.args.eta as bigint };
  }

  async function raiseDelay(s: Awaited<ReturnType<typeof governed>>, seconds: number) {
    const addr = await s.timelock.getAddress();
    const data = s.timelock.interface.encodeFunctionData("updateDelay", [seconds]);
    const salt = ethers.id("raise delay");
    const current = await s.timelock.getMinDelay();
    await s.timelock.connect(s.proposer).schedule(addr, 0, data, ethers.ZeroHash, salt, current);
    await time.increase(Number(current));
    await s.timelock.connect(s.executor).execute(addr, 0, data, ethers.ZeroHash, salt);
    expect(await s.timelock.getMinDelay()).to.equal(BigInt(seconds));
  }

  it("keeps working after the timelock delay is raised, and schedules at the new delay", async function () {
    const s = await loadFixture(governed);
    const raised = 72 * 3600;
    await raiseDelay(s, raised);

    const { id, eta } = await proposalOf(s, s.governance.connect(s.proposer).proposeMinDebtUpdate(ethers.parseEther("500")));
    const now = BigInt(await time.latest());
    expect(eta).to.equal(now + BigInt(raised));
    expect(await s.timelock.getTimestamp(id)).to.equal(now + BigInt(raised));

    await time.increase(48 * 3600 + 1);
    expect(await s.timelock.isOperationReady(id)).to.equal(false);
    await time.increase(24 * 3600);
    expect(await s.timelock.isOperationReady(id)).to.equal(true);
  });

  it("still schedules at MIN_DELAY at launch", async function () {
    const s = await loadFixture(governed);
    const { id, eta } = await proposalOf(s, s.governance.connect(s.proposer).proposeUnderwaterDiscountUpdate(20_000n));
    const launch = BigInt(await time.latest()) + (await s.governance.MIN_DELAY());
    expect(eta).to.equal(launch);
    expect(await s.timelock.getTimestamp(id)).to.equal(launch);
  });

  it("refuses a minimum debt outside the vault's own bounds at proposal time", async function () {
    const s = await loadFixture(governed);
    await expect(
      s.governance.connect(s.proposer).proposeMinDebtUpdate(ethers.parseEther("100") - 1n)
    ).to.be.revertedWith("Min debt out of range");
    await expect(
      s.governance.connect(s.proposer).proposeMinDebtUpdate(ethers.parseEther("10000") + 1n)
    ).to.be.revertedWith("Min debt out of range");
    await s.governance.connect(s.proposer).proposeMinDebtUpdate(ethers.parseEther("100"));
    await s.governance.connect(s.proposer).proposeMinDebtUpdate(ethers.parseEther("10000"));
  });

  it("refuses an underwater discount above 5% at proposal time", async function () {
    const s = await loadFixture(governed);
    await expect(s.governance.connect(s.proposer).proposeUnderwaterDiscountUpdate(50_001n)).to.be.revertedWith(
      "Discount exceeds 5%"
    );
    await s.governance.connect(s.proposer).proposeUnderwaterDiscountUpdate(50_000n);
  });
});
