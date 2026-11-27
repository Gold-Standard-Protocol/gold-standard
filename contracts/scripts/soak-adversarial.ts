import { ethers, network } from "hardhat";
import * as fs from "fs";
import { describeError, describeErrorStack } from "./lib/redact";

/**
 * Adversarial soak against a LIVE deployment (local rehearsal or Sepolia).
 *
 * Drives the real deployed contracts through the full borrower lifecycle and
 * then attacks them. Unit tests prove functions in isolation; this proves the
 * assembled, wired system behaves under abuse, with every guard exercised
 * against real deployed bytecode.
 *
 * Read-mostly and self-funding: it mints mock collateral to throwaway signers.
 * REFUSES to run on mainnet.
 *
 *   npx hardhat run scripts/soak-adversarial.ts --network localhost
 */

interface Result {
  name: string;
  ok: boolean;
  detail: string;
}
const results: Result[] = [];

const check = (name: string, ok: boolean, detail: string): void => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${name}\n        ${detail}`);
};

/** Not applicable to this deployment's current state — neither pass nor fail. */
const skip = (name: string, detail: string): void => {
  console.log(`  SKIP  ${name}\n        ${detail}`);
};

/** Assert a call reverts, and that the reason mentions `expect`. */
const expectRevert = async (
  name: string,
  promise: Promise<unknown>,
  expect: string
): Promise<void> => {
  try {
    await promise;
    check(name, false, `expected revert containing "${expect}", but it succeeded`);
  } catch (error) {
    const message = describeError(error);
    check(
      name,
      message.includes(expect),
      message.includes(expect)
        ? `reverted with "${expect}" as required`
        : `reverted, but with: ${message.slice(0, 180)}`
    );
  }
};

async function main() {
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  if (chainId === 1) {
    throw new Error("Refusing to run the adversarial soak against mainnet.");
  }

  const dep = JSON.parse(
    fs.readFileSync(`deployments/${network.name}.json`, "utf8")
  );
  const a = dep.addresses;
  const [deployer, alice, bob] = await ethers.getSigners();

  const vault = await ethers.getContractAt("GoldVault", a.vault);
  const oracle = await ethers.getContractAt("GoldOracle", a.oracle);
  const gsusd = await ethers.getContractAt("GoldStablecoin", a.stablecoin);
  const stabilityModule = await ethers.getContractAt(
    "StabilityModule",
    a.stabilityModule
  );
  const siloFactory = await ethers.getContractAt("SiloFactory", a.siloFactory);
  const paxg = await ethers.getContractAt("MockERC20", dep.config.paxgToken);
  const paxgFeed = await ethers.getContractAt(
    "MockAggregatorV3",
    dep.config.paxgFeed
  );
  const anchorFeed = await ethers.getContractAt(
    "MockAggregatorV3",
    dep.config.anchorFeed
  );

  const colId = ethers.keccak256(
    ethers.solidityPacked(["address"], [dep.config.paxgToken])
  );

  const xautFeed = await ethers.getContractAt(
    "MockAggregatorV3",
    dep.config.xautFeed
  );

  /** Stamp all three feeds at the same price: a gold-wide move, so PAXG stays inside its gold band. */
  const stamp = async (price: bigint) => {
    const latest = await ethers.provider.getBlock("latest");
    if (!latest) throw new Error("latest block unavailable");
    const now = latest.timestamp + 1;
    const round = (await paxgFeed.latestRoundData())[0] + 1n;
    await (await paxgFeed.setLatestRoundData(round, price, now, now, round)).wait();
    await (await xautFeed.setLatestRoundData(round, price, now, now, round)).wait();
    await (await anchorFeed.setLatestRoundData(round, price, now, now, round)).wait();
  };

  console.log(`\nAdversarial soak — ${network.name} (chainId ${chainId})`);
  console.log(`Vault: ${a.vault}\n`);

  // Normalise to a known starting price before asserting anything. This script
  // deliberately crashes the price and moves PAXG off its gold band, so a second run
  // would otherwise inherit the previous run's mangled feed state and fail for reasons
  // that have nothing to do with the system under test. resync is available because the
  // deployer still holds GOVERNANCE_ROLE pre-handover.
  const BASE_PRICE = 400_000_000_000n; // $4,000/oz
  await stamp(BASE_PRICE);
  await (await oracle.resyncLastKnownPrice(dep.config.paxgToken)).wait();
  await (await oracle.resyncLastKnownPrice(dep.config.xautToken)).wait();
  console.log(`Baseline price normalised to $${ethers.formatUnits(BASE_PRICE, 8)}/oz\n`);

  // ---------------------------------------------------------------------
  console.log("[1] Launch policy: the debt ceiling really is zero");
  // ---------------------------------------------------------------------
  // These two are DEPLOY-STATE assertions and only meaningful before the ramp.
  // The soak itself raises the ceiling, and on a testnet you re-run it against
  // an already-ramped deployment, so report them as skipped rather than failed.
  const paxgType = await vault.collateralTypes(colId);
  const freshDeployment = paxgType.debtCeiling === 0n;

  await (await paxg.mint(alice.address, ethers.parseEther("1000"))).wait();
  await (
    await paxg.connect(alice).approve(a.vault, ethers.MaxUint256)
  ).wait();
  await (
    await vault.connect(alice).deposit(dep.config.paxgToken, ethers.parseEther("100"))
  ).wait();

  if (freshDeployment) {
    check(
      "ceiling-zero-at-deploy",
      true,
      "PAXG debtCeiling = 0 (the safe value is the one you get by omission)"
    );
    await expectRevert(
      "mint-blocked-by-zero-ceiling",
      vault.connect(alice).mint(ethers.parseEther("1000")),
      "Debt ceiling reached"
    );
    // Ramp the ceiling the way governance will (the deployer still holds
    // GOVERNANCE_ROLE because the handover has not run yet): the ceiling alone,
    // the deployed ratios untouched.
    await (
      await vault.setDebtCeiling(
        dep.config.paxgToken,
        ethers.parseEther("250000") // week-1 ramp value from docs/LAUNCH.md
      )
    ).wait();
    console.log("        (ceiling raised to $250k, mirroring the week-1 ramp)");
  } else {
    skip(
      "ceiling-zero-at-deploy",
      `already ramped to ${ethers.formatEther(paxgType.debtCeiling)} GSUSD — deploy-state check not applicable`
    );
    skip("mint-blocked-by-zero-ceiling", "ceiling is live; see the ramp gates in docs/LAUNCH.md");
  }

  // ---------------------------------------------------------------------
  console.log("\n[2] Borrower lifecycle on real bytecode");
  // ---------------------------------------------------------------------
  await (await vault.connect(alice).mint(ethers.parseEther("20000"))).wait();
  const ratio = await vault.getCollateralisationRatio(alice.address);
  check(
    "mint-and-ratio",
    ratio > 1_500_000n,
    `minted 20k GSUSD against 100 PAXG; ratio = ${(Number(ratio) / 10000).toFixed(2)}%`
  );

  // The ratio guard only binds when it is the FIRST limit reached. Alice holds
  // $400k of collateral against a $250k ceiling, so a big mint hits the ceiling
  // or the per-block cap long before the minimum ratio. Use a deliberately thin position so
  // the ratio is genuinely the binding constraint.
  const [, , , carol] = await ethers.getSigners();
  await (await paxg.mint(carol.address, ethers.parseEther("1"))).wait();
  await (await paxg.connect(carol).approve(a.vault, ethers.MaxUint256)).wait();
  await (
    await vault.connect(carol).deposit(dep.config.paxgToken, ethers.parseEther("1"))
  ).wait();
  // Size the attempt from her ACTUAL collateral rather than a hard-coded figure:
  // she accumulates a little more on every re-run, and a fixed amount would
  // silently stop breaching the minimum ratio.
  const carolCollateral = (await vault.vaults(carol.address)).collateralAmount;
  const carolValue =
    (carolCollateral * (await oracle.getLastKnownPrice(dep.config.paxgToken))) /
    100_000_000n;
  // 120% of collateral value is comfortably under the minimum ratio (130% by default).
  const overMint = (carolValue * 100n) / 120n;
  await expectRevert(
    "over-mint-blocked-by-ratio",
    vault.connect(carol).mint(overMint),
    "Below min collateralisation ratio"
  );

  // Alice IS well collateralised, so a 60k mint passes the ratio and ceiling
  // checks and lands squarely on the 50k per-block cap.
  await expectRevert(
    "per-block-mint-cap-enforced",
    vault.connect(alice).mint(ethers.parseEther("60000")),
    "Per-block mint cap reached"
  );

  // ---------------------------------------------------------------------
  console.log("\n[3] A fee-accruing vault can actually be closed");
  // ---------------------------------------------------------------------
  // Age the position so real stability fees accrue, then close with an
  // overshoot. Before the cap this was impossible: an exact quote was stale on
  // arrival and left dust below MIN_DEBT.
  await ethers.provider.send("evm_increaseTime", [90 * 24 * 3600]);
  await ethers.provider.send("evm_mine", []);
  await stamp(400_000_000_000n);

  const owed = await vault.getVaultCurrentDebt(alice.address);
  const principal = (await vault.vaults(alice.address)).debtAmount;
  check(
    "fees-accrued",
    owed > principal,
    `principal ${ethers.formatEther(principal)} -> owed ${ethers.formatEther(owed)} after 90 days`
  );

  // Fund the fee portion from bob so alice can settle in full.
  await (await paxg.mint(bob.address, ethers.parseEther("1000"))).wait();
  await (await paxg.connect(bob).approve(a.vault, ethers.MaxUint256)).wait();
  await (
    await vault.connect(bob).deposit(dep.config.paxgToken, ethers.parseEther("100"))
  ).wait();
  await (await vault.connect(bob).mint(ethers.parseEther("20000"))).wait();
  await (
    await gsusd.connect(bob).transfer(alice.address, ethers.parseEther("5000"))
  ).wait();

  await (await gsusd.connect(alice).approve(a.vault, ethers.MaxUint256)).wait();
  const quote = await vault.getVaultCurrentDebt(alice.address);
  // Quote HIGH, exactly as the dapp's Max button now does (+0.1%).
  await (await vault.connect(alice).repay((quote * 1001n) / 1000n)).wait();

  const closed = await vault.vaults(alice.address);
  const dust = await stabilityModule.normalisedDebt(alice.address, colId);
  check(
    "full-close-with-overshoot",
    closed.debtAmount === 0n,
    `debt fully cleared by an overshoot quote`
  );
  check(
    "normalised-debt-dust-cleared",
    dust === 0n,
    `StabilityModule.normalisedDebt = ${dust} (must be exactly 0)`
  );

  await (
    await vault.connect(alice).withdraw((await vault.vaults(alice.address)).collateralAmount)
  ).wait();
  const emptied = await vault.vaults(alice.address);
  check(
    "vault-fully-released",
    emptied.collateralAmount === 0n &&
      emptied.collateralToken === ethers.ZeroAddress,
    "collateral returned and the token binding released"
  );

  // ---------------------------------------------------------------------
  console.log("\n[4] Governance cannot be self-revoked into a brick");
  // ---------------------------------------------------------------------
  const gov = await ethers.getContractAt("GoldGovernance", a.governance);
  check(
    "propose-transfer-governance-removed",
    !gov.interface.fragments.some(
      (f) => f.type === "function" && (f as { name?: string }).name === "proposeTransferGovernance"
    ),
    "the wrapper no longer exposes the bricking helper"
  );
  await expectRevert(
    "self-revoke-blocked",
    vault.transferGovernance(deployer.address),
    "Would self-revoke"
  );

  // ---------------------------------------------------------------------
  console.log("\n[5] Silo stuffing is bounded and recoverable");
  // ---------------------------------------------------------------------
  const cap = await siloFactory.siloCap();
  const maxSkips = Number(await siloFactory.MAX_SKIPS_PER_DEPOSIT());
  const idxBefore = await siloFactory.currentSiloIndex(dep.config.paxgToken);
  for (let i = 0; i <= maxSkips + 1; i++) {
    const target = await siloFactory.predictSiloAddress(
      dep.config.paxgToken,
      idxBefore + BigInt(i)
    );
    await (await paxg.mint(target, cap)).wait();
  }
  await expectRevert(
    "silo-stuffing-bounded",
    vault.connect(bob).deposit(dep.config.paxgToken, ethers.parseEther("1")),
    "Too many unusable silos"
  );

  await (
    await siloFactory.setCurrentSiloIndex(
      dep.config.paxgToken,
      idxBefore + BigInt(maxSkips + 3)
    )
  ).wait();
  // Anyone may create the silos the move left missing, so the next deposit creates none.
  // The call reverts when nothing is missing, so the count is read before every call.
  const gap: bigint = await siloFactory.missingSilos(dep.config.paxgToken);
  for (;;) {
    const left: bigint = await siloFactory.missingSilos(dep.config.paxgToken);
    if (left === 0n) break;
    await (await siloFactory.connect(bob).createSilos(dep.config.paxgToken, left > 16n ? 16n : left)).wait();
  }
  check(
    "silo-gap-filled-by-anyone",
    (await siloFactory.missingSilos(dep.config.paxgToken)) === 0n,
    `createSilos created ${gap} silos behind the moved cursor`
  );
  await (
    await vault.connect(bob).deposit(dep.config.paxgToken, ethers.parseEther("1"))
  ).wait();
  check(
    "silo-operator-lever-recovers",
    true,
    "setCurrentSiloIndex moved the cursor past the stuffed run; deposits resumed"
  );

  // ---------------------------------------------------------------------
  console.log("\n[6] Oracle: a gold-wide move is priced at once, a PAXG-only move is refused");
  // ---------------------------------------------------------------------
  // docs/ORACLE_IMPLEMENTATION_PLAN.md section 3: with every feed moving together, Chainlink
  // PAXG/USD stays inside its gold band of XAU/USD and is priced at once, however large the
  // step; there is no deviation gate to wedge on.
  await stamp(600_000_000_000n); // +50% in one step on every feed
  const goldWide = await oracle.getTokenPrice.staticCall(dep.config.paxgToken);
  check("gold-wide-move-priced-at-once", goldWide === 600_000_000_000n, `getTokenPrice reads $${ethers.formatUnits(goldWide, 8)} straight after the step`);
  await (await oracle.getTokenPrice(dep.config.paxgToken)).wait();
  const reanchored = await oracle.getLastKnownPrice(dep.config.paxgToken);
  check("permissionless-poke-re-anchors", reanchored === 600_000_000_000n, `lastKnownPrice re-anchored to ${ethers.formatUnits(reanchored, 8)} by a plain getTokenPrice`);

  // PAXG alone moving 15% leaves it outside the gold band: borrowing stops until it returns.
  {
    const latest = await ethers.provider.getBlock("latest");
    if (!latest) throw new Error("latest block unavailable");
    const round = (await paxgFeed.latestRoundData())[0] + 1n;
    await (await paxgFeed.setLatestRoundData(round, 690_000_000_000n, latest.timestamp + 1, latest.timestamp + 1, round)).wait();
  }
  await expectRevert("paxg-only-move-refused", vault.connect(bob).mint(ethers.parseEther("100")), "Off gold band");
  await stamp(600_000_000_000n);

  // ---------------------------------------------------------------------
  console.log("\n[7] Liquidation on real bytecode");
  // ---------------------------------------------------------------------
  // Walk every feed down together in 8% steps, a gradual gold-wide fall, until bob's
  // position is under its liquidation ratio.
  // 8% steps from $6,000 need ~40 iterations to push a 101 PAXG / 20k debt
  // position under 110%. Bound generously; the loop exits as soon as it lands.
  let price = 600_000_000_000n;
  for (let i = 0; i < 60; i++) {
    const r = await vault.getCollateralisationRatio(bob.address);
    if (r < 1_100_000n) break;
    price = (price * 92n) / 100n;
    await stamp(price);
    await (await oracle.getTokenPrice(dep.config.paxgToken)).wait();
  }
  const bobRatio = await vault.getCollateralisationRatio(bob.address);
  check(
    "position-driven-underwater",
    bobRatio < 1_100_000n,
    `bob's ratio = ${(Number(bobRatio) / 10000).toFixed(2)}% at $${ethers.formatUnits(price, 8)}/oz`
  );

  // Liquidator needs GSUSD: alice still holds some from bob's earlier transfer.
  const aliceBal = await gsusd.balanceOf(alice.address);
  if (aliceBal > 0n) {
    await (await gsusd.connect(alice).approve(a.vault, ethers.MaxUint256)).wait();
    const paxgBefore = await paxg.balanceOf(alice.address);
    try {
      await (
        await vault.connect(alice).liquidate(bob.address, aliceBal / 2n)
      ).wait();
      const seized = (await paxg.balanceOf(alice.address)) - paxgBefore;
      check(
        "liquidation-pays-liquidator",
        seized > 0n,
        `liquidator received ${ethers.formatEther(seized)} PAXG at a discount`
      );
    } catch (error) {
      check(
        "liquidation-pays-liquidator",
        false,
        `liquidate reverted: ${describeError(error).slice(0, 160)}`
      );
    }
  }

  // ---------------------------------------------------------------------
  console.log("\n[8] Oracle staleness and the guardian pause");
  // ---------------------------------------------------------------------
  await ethers.provider.send("evm_increaseTime", [90001]); // past the 25h bound
  await ethers.provider.send("evm_mine", []);
  // A stale Chainlink read is no valid source; with no other path to a price the oracle refuses.
  await expectRevert(
    "stale-feed-rejected",
    vault.connect(bob).mint(ethers.parseEther("100")),
    "No reliable price"
  );
  await stamp(price);

  const guardian = dep.config.guardian;
  check(
    "guardian-cannot-unpause",
    (await vault.hasRole(await vault.GUARDIAN_ROLE(), guardian)) &&
      !(await vault.hasRole(await vault.GOVERNANCE_ROLE(), guardian)),
    "guardian holds pause authority but NOT governance, so it cannot unpause"
  );

  // ---------------------------------------------------------------------
  console.log("\n[9] The Gold Stability Reserve: a stranger's swap touches no vault");
  // ---------------------------------------------------------------------
  {
    const reserve = await ethers.getContractAt("GoldStabilityReserve", a.reserve);
    const paxgAddr: string = dep.config.paxgToken;

    // Seed 10 PAXG so the floor exists, then have bob swap against it while alice
    // holds a vault. Every field of alice's vault must be byte-identical afterwards.
    await (await paxg.mint(deployer.address, ethers.parseEther("10"))).wait();
    await (await paxg.approve(a.reserve, ethers.parseEther("10"))).wait();
    await (await reserve.seedCollateral(paxgAddr, ethers.parseEther("10"))).wait();
    await stamp(price);

    const bobGsusd = await gsusd.balanceOf(bob.address);
    if (bobGsusd < ethers.parseEther("100")) {
      skip("reserve-swap", "bob holds too little GSUSD to swap; earlier stages left him short");
    } else {
      const aliceBefore = await vault.vaults(alice.address);
      const supplyBefore = await gsusd.totalSupply();
      const reserveBefore = await reserve.collateralBalance(paxgAddr);
      await (await gsusd.connect(bob).approve(a.reserve, ethers.MaxUint256)).wait();
      await (await reserve.connect(bob).swapGsusdForGold(paxgAddr, ethers.parseEther("100"), 0n)).wait();
      const aliceAfter = await vault.vaults(alice.address);

      check(
        "reserve-swap-leaves-vault-untouched",
        aliceAfter.collateralAmount === aliceBefore.collateralAmount &&
          aliceAfter.debtAmount === aliceBefore.debtAmount,
        `alice: ${ethers.formatEther(aliceBefore.collateralAmount)} PAXG / ${ethers.formatEther(aliceBefore.debtAmount)} GSUSD before and after`
      );
      check(
        "reserve-swap-is-not-a-burn",
        (await gsusd.totalSupply()) === supplyBefore,
        `totalSupply unchanged at ${ethers.formatEther(supplyBefore)}: the reserve holds the GSUSD, it does not destroy it`
      );
      check(
        "reserve-paid-from-its-own-gold",
        (await reserve.collateralBalance(paxgAddr)) < reserveBefore,
        `reserve PAXG ${ethers.formatEther(reserveBefore)} -> ${ethers.formatEther(await reserve.collateralBalance(paxgAddr))}`
      );
      check(
        "reserve-cannot-mint",
        !(await gsusd.hasRole(await gsusd.MINTER_ROLE(), a.reserve)),
        "the reserve holds no MINTER_ROLE: it owes nothing and can only be empty, never insolvent"
      );
    }

    // Drain to the floor and confirm the swap refuses rather than reaching anywhere else.
    const redeemable = await reserve.redeemableCollateral(paxgAddr);
    await (await reserve.withdrawCollateral(paxgAddr, deployer.address, redeemable)).wait();
    await stamp(price);
    await expectRevert(
      "empty-reserve-refuses",
      reserve.connect(bob).swapGsusdForGold(paxgAddr, ethers.parseEther("1"), 0n),
      "Reserve insufficient"
    );
  }

  // ---------------------------------------------------------------------
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${"=".repeat(64)}`);
  console.log(`Adversarial soak: ${passed}/${results.length} checks passed`);
  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    console.log("\nFAILED:");
    for (const f of failed) console.log(`  ✗ ${f.name}: ${f.detail}`);
    process.exitCode = 1;
  } else {
    console.log("Every adversarial case behaved as designed.");
  }
}

main().catch((error) => {
  console.error(describeErrorStack(error));
  process.exitCode = 1;
});
