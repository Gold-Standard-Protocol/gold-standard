/**
 * Attack drill: try every path that could move a borrower's collateral without the
 * owner's signature, against a real deployment, on a fork.
 *
 * Runs against a Hardhat fork of the target network so it can impersonate the
 * deployer, the guardian, the mock feed owner and, after the governance handover, the
 * timelock itself, and try stateful sequences that a static call cannot. Section E2
 * records the powers governance keeps by design. Nothing here touches the live chain.
 *
 *   npx hardhat node --fork $RPC_URL --fork-block-number <head minus a few> --port 8545
 *   (in another shell; pin the block: without it Hardhat forks ~128 blocks behind
 *   the head, which lands mid-ceremony right after a deploy, and a pinned block
 *   should be recent enough for the upstream to still serve its state)
 *   DRILL_DEPLOYMENT=sepolia DRILL_TARGET=0x... \
 *     npx hardhat run scripts/attack-drill.ts --network localhost
 *
 * On a mainnet fork (docs/MAINNET.md section 2), after scripts/rehearsal/baseline.ts, PAXG and
 * its feed are real: the attacker's PAXG comes from a holder, and the PAXG/USD move goes through
 * the mock that baseline.ts put behind Chainlink's proxy.
 *   DRILL_DEPLOYMENT=localhost LOCAL_RPC_URL=http://127.0.0.1:8547 DRILL_TARGET=0x... \
 *     npx hardhat run scripts/attack-drill.ts --network localhost
 *
 * Every scenario records PASS when the protocol refused, FAIL when it did not, and
 * finishes by checking the target vault and its silo balance are exactly as found.
 */
import { ethers, network } from "hardhat";
import { freshBufferedWallet } from "./lib/bufferedWallet";
import { MAINNET } from "./lib/mainnetAddresses";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describeError, describeErrorStack } from "./lib/redact";

type Row = { scenario: string; outcome: "PASS" | "FAIL" | "INFO"; detail: string };
const rows: Row[] = [];
const record = (scenario: string, outcome: Row["outcome"], detail: string) => {
  rows.push({ scenario, outcome, detail });
  console.log(`  [${outcome}] ${scenario}: ${detail}`);
};

/** Expect the promise to revert. PASS on revert, FAIL on success. */
async function refused(scenario: string, action: () => Promise<unknown>): Promise<boolean> {
  try {
    await action();
    record(scenario, "FAIL", "call SUCCEEDED");
    return false;
  } catch (error) {
    const message = describeError(error);
    const reason =
      message.match(/reason="([^"]+)"/)?.[1] ??
      message.match(/reverted with reason string '([^']+)'/)?.[1] ??
      message.match(/custom error '([^']+)'/)?.[1] ??
      message.match(/AccessControlUnauthorizedAccount/)?.[0] ??
      message.slice(0, 80);
    record(scenario, "PASS", `reverted: ${reason}`);
    return true;
  }
}

async function impersonate(address: string) {
  await network.provider.send("hardhat_impersonateAccount", [address]);
  await network.provider.send("hardhat_setBalance", [address, "0x56BC75E2D63100000"]); // 100 ETH
  return ethers.getSigner(address);
}

async function main() {
  // The fork keeps state between runs; a drained silo from one run would make the next
  // run's refusals meaningless. Snapshot first and restore at the end, whatever happens.
  const snapshotId = (await network.provider.send("evm_snapshot", [])) as string;
  try {
    await drill();
  } finally {
    await network.provider.send("evm_revert", [snapshotId]);
  }
}

async function drill() {
  const deploymentName = process.env.DRILL_DEPLOYMENT ?? network.name;
  const snap = JSON.parse(readFileSync(resolve(__dirname, "../deployments", `${deploymentName}.json`), "utf8"));
  const a = snap.addresses;
  const target = ethers.getAddress(process.env.DRILL_TARGET ?? snap.deployer);
  const paxgAddr = ethers.getAddress(snap.config.paxgToken);

  // A fresh, unprivileged attacker with gas.
  // Buffered like the drive's wallets: an exact Hardhat estimate can land a few hundred gas
  // short of the registry hook's floor when the block timestamp moves between estimate and execution.
  const attacker = freshBufferedWallet(ethers.provider);
  await network.provider.send("hardhat_setBalance", [attacker.address, "0x56BC75E2D63100000"]);
  const deployer = await impersonate(snap.deployer);
  const guardian = await impersonate(snap.config.guardian ?? snap.deployer);

  const vault = await ethers.getContractAt("GoldVault", a.vault);
  // Whoever holds GOVERNANCE_ROLE is the governance key under test: the deployer before the
  // handover, the timelock after it. The fork can impersonate either.
  const GOVERNANCE_ROLE: string = await vault.GOVERNANCE_ROLE();
  const deployerGoverns: boolean = await vault.hasRole(GOVERNANCE_ROLE, snap.deployer);
  const governor = deployerGoverns ? deployer : await impersonate(a.timelock);
  const governorLabel = deployerGoverns ? "deployer, pre-handover" : "timelock, post-handover";
  const siloFactory = await ethers.getContractAt("SiloFactory", a.siloFactory);
  const reserve = await ethers.getContractAt("GoldStabilityReserve", a.reserve);
  const oracle = await ethers.getContractAt("GoldOracle", a.oracle);
  const gsusd = await ethers.getContractAt("GoldStablecoin", a.stablecoin);
  const paxg = await ethers.getContractAt("MockERC20", paxgAddr);
  const paxgFeed = await ethers.getContractAt("MockAggregatorV3", snap.config.paxgFeed);
  // A Sepolia deployment's PAXG and PAXG/USD feed are mocks the drill can mint and move. On a
  // mainnet fork they are the real token and Chainlink's proxy, so the fork tooling funds and
  // moves them instead (loaded only there: it insists on a localhost fork).
  const rehearsal = paxgAddr === ethers.getAddress(MAINNET.paxgToken) ? await import("./rehearsal/lib") : undefined;

  const snapshotTarget = async () => {
    const v = await vault.vaults(target);
    return { token: v[0], collateral: v[1] as bigint, debt: v[2] as bigint, silo: (await siloFactory.totalCollateral(paxgAddr)) as bigint };
  };
  const before = await snapshotTarget();
  console.log(`\nAttack drill on ${deploymentName} (fork chainId ${(await ethers.provider.getNetwork()).chainId})`);
  console.log(`Target ${target}: ${ethers.formatEther(before.collateral)} PAXG collateral, ${ethers.formatEther(before.debt)} GSUSD debt`);
  console.log(`Attacker ${attacker.address}\n`);

  const untouched = async (label: string) => {
    const now = await snapshotTarget();
    const same = now.collateral === before.collateral && now.debt === before.debt && now.token === before.token;
    record(`target vault unchanged after ${label}`, same ? "PASS" : "FAIL", `${ethers.formatEther(now.collateral)} PAXG / ${ethers.formatEther(now.debt)} GSUSD`);
  };

  console.log("A. Unprivileged attacker, direct calls");
  await refused("attacker withdraw(target's 100 PAXG)", () => vault.connect(attacker).withdraw(before.collateral));
  await refused("attacker liquidate(target)", () => vault.connect(attacker).liquidate(target, 1n));
  await refused("attacker emergencyLiquidate(target)", () => vault.connect(attacker).emergencyLiquidate(target, 1n));
  await refused("attacker liquidateViaPool(target)", () => vault.connect(attacker).liquidateViaPool(target, 1n));
  await refused("attacker withdrawSurplus(PAXG)", () => vault.connect(attacker).withdrawSurplus(paxgAddr, attacker.address, 1n));
  await refused("attacker siloFactory.withdraw(PAXG)", () => siloFactory.connect(attacker).withdraw(paxgAddr, attacker.address, 1n));
  if ((await siloFactory.getSiloCount(paxgAddr)) > 0n) {
    const silo0 = await siloFactory.getSilo(paxgAddr, 0n);
    const silo = await ethers.getContractAt("CollateralSilo", silo0);
    await refused("attacker CollateralSilo.withdraw() directly", () => silo.connect(attacker).withdraw(attacker.address, 1n));
  } else {
    record("attacker CollateralSilo.withdraw() directly", "INFO", "no PAXG silo exists yet on this fork");
  }
  await refused("attacker reserve.withdrawCollateral(PAXG)", () => reserve.connect(attacker).withdrawCollateral(paxgAddr, attacker.address, 1n));
  await refused("attacker emergencyPause()", () => vault.connect(attacker).emergencyPause());
  await untouched("A");

  console.log("\nB. Attacker with their own position and GSUSD");
  if (rehearsal) await rehearsal.fundPaxg(rehearsal.market0(), attacker.address, ethers.parseEther("20"));
  else await (await paxg.connect(attacker).mint(attacker.address, ethers.parseEther("20"))).wait();
  await (await paxg.connect(attacker).approve(a.vault, ethers.MaxUint256)).wait();
  await (await vault.connect(attacker).deposit(paxgAddr, ethers.parseEther("10"))).wait();
  const price = (await oracle.getValidatedPrice(paxgAddr))[0] as bigint;
  const mintAmount = (ethers.parseEther("10") * price) / 10n ** 8n / 2n; // 200% ratio
  await (await vault.connect(attacker).mint(mintAmount)).wait();
  record("attacker opened own vault", "INFO", `10 PAXG, minted ${ethers.formatEther(mintAmount)} GSUSD at 200%`);
  await refused("attacker liquidate(target) while holding GSUSD", () => vault.connect(attacker).liquidate(target, 1n));
  const reserveBefore = (await reserve.collateralBalance(paxgAddr)) as bigint;
  const swapIn = ethers.parseEther("1000");
  await (await gsusd.connect(attacker).approve(a.reserve, swapIn)).wait();
  try {
    await (await reserve.connect(attacker).swapGsusdForGold(paxgAddr, swapIn, 0n)).wait();
    const reserveAfter = (await reserve.collateralBalance(paxgAddr)) as bigint;
    record("attacker swaps 1,000 GSUSD at the reserve", "INFO", `reserve PAXG ${ethers.formatEther(reserveBefore)} -> ${ethers.formatEther(reserveAfter)} (paid from protocol gold)`);
  } catch (error) {
    record("attacker swaps 1,000 GSUSD at the reserve", "INFO", `refused: ${describeError(error).slice(0, 80)}`);
  }
  await untouched("B");

  console.log("\nC. Guardian pauses, then emergency liquidation");
  await (await vault.connect(guardian).emergencyPause()).wait();
  await refused("attacker emergencyLiquidate(target) while paused", () => vault.connect(attacker).emergencyLiquidate(target, 1n));
  await refused("attacker emergencyLiquidate(own healthy vault) while paused", () => vault.connect(attacker).emergencyLiquidate(attacker.address, 1n));
  // An unpause names the pause it lifts; read pauseEpoch just before the call.
  await (await vault.connect(governor).unpause(await vault.pauseEpoch())).wait();
  await untouched("C");

  console.log(`\nD. Feed manipulation (${rehearsal ? "the mock behind Chainlink's PAXG/USD proxy" : "mock feed owner = deployer"})`);
  const round = (await paxgFeed.latestRoundData())[0] as bigint;
  const setPaxgPrice = async (answer: bigint, roundId: bigint, stamp: number): Promise<void> => {
    if (rehearsal) await rehearsal.setFeed(snap.config.paxgFeed, answer);
    else await (await paxgFeed.connect(deployer).setLatestRoundData(roundId, answer, stamp, stamp, roundId)).wait();
  };
  // Stamp the round with CHAIN time: a fork's clock lags the wall clock, and a feed
  // dated in the future makes the staleness subtraction underflow (panic 0x11)
  // instead of exercising the gold band this scenario is about: PAXG alone halved, XAU/USD
  // unchanged, so no liquidation price exists until the pool confirms it.
  const now = Number((await ethers.provider.getBlock("latest"))?.timestamp ?? Math.floor(Date.now() / 1000));
  await setPaxgPrice(price / 2n, round + 1n, now);
  await refused("attacker liquidate(own vault) after a 50% single-step feed crash", () => vault.connect(attacker).liquidate(attacker.address, 1n));
  await refused("attacker liquidate(target) after the crash", () => vault.connect(attacker).liquidate(target, 1n));
  await setPaxgPrice(price, round + 2n, now + 1);
  record("feed restored", "INFO", `$${ethers.formatUnits(price, 8)}`);
  await untouched("D");

  console.log(`\nE. Governance key (${governorLabel})`);
  await refused("governance withdrawSurplus(PAXG, target's collateral)", () => vault.connect(governor).withdrawSurplus(paxgAddr, governor.address, before.collateral));
  await refused("governance liquidate(target)", () => vault.connect(governor).liquidate(target, 1n));
  await refused("governance siloFactory.withdraw(target's PAXG)", () => siloFactory.connect(governor).withdraw(paxgAddr, governor.address, before.collateral));
  await refused("governance withdraw() against the target's vault", () => vault.connect(governor).withdraw(before.collateral));
  await untouched("E");
  // The powers governance keeps by design, shown on the attacker's own vault so the target is
  // never touched, each inside a snapshot so nothing persists. The 48 hour timelock is the
  // only defence against these; that is the case for the longer delay on risky changes.
  console.log(`\nE2. Powers governance keeps by design (${governorLabel})`);
  {
    const snapE2 = (await network.provider.send("evm_snapshot", [])) as string;
    try {
      const colId = ethers.solidityPackedKeccak256(["address"], [paxgAddr]);
      const ct = await vault.collateralTypes(colId);
      const ratioBefore = Number(await vault.getCollateralisationRatio(attacker.address)) / 10_000;
      await (await vault.connect(governor).updateCollateralRatios(paxgAddr, 3_000_000n, 2_500_000n, ct.liquidationPenalty)).wait();
      const liquidatableNow = Number(await vault.getCollateralisationRatio(attacker.address)) < 2_500_000;
      record(
        "governance updateCollateralRatios(liquidation ratio 250%) makes a 200% vault liquidatable",
        "INFO",
        liquidatableNow ? `yes: attacker's ${ratioBefore.toFixed(0)}% vault is now below the ratio; only the timelock delay stands between a proposal and this` : "no (unexpected)"
      );
      const minterRole: string = await gsusd.MINTER_ROLE();
      let locked = false;
      try { locked = (await gsusd.mintersLocked()) as boolean; } catch { locked = false; }
      // A succeeding grant is not a finding before lockMinters(vault): it is the power the
      // runbook closes one-way through the timelock (docs/LAUNCH.md), so it is recorded, not failed.
      let granted = false;
      try {
        await (await gsusd.connect(governor).grantRole(minterRole, attacker.address)).wait();
        granted = true;
      } catch {
        granted = false;
      }
      record("governance grantRole(MINTER_ROLE, attacker) on GSUSD", "INFO", granted ? "succeeded: a scheduled proposal can still add a minter, 48 h in the open" : "refused");
      record("GSUSD minters locked", "INFO", locked ? "true: no key can add a minter" : "false: lockMinters(vault) through the timelock has not run yet");
    } finally {
      await network.provider.send("evm_revert", [snapE2]);
    }
  }
  await untouched("E2");

  console.log("\nF. Silo factory admin key");
  const VAULT_ROLE = await siloFactory.VAULT_ROLE();
  let locked = false;
  try {
    locked = (await siloFactory.vaultRoleLocked()) as boolean;
  } catch {
    locked = false; // pre-lock bytecode has no such function
  }
  record("siloFactory.vaultRoleLocked", "INFO", locked ? "true" : "false (deployment predates lockVaultRole)");
  const granted = await refused(`admin (${governorLabel}) grantRole(VAULT_ROLE, attacker)`, () => siloFactory.connect(governor).grantRole(VAULT_ROLE, attacker.address));
  if (!granted) {
    const drained = await refused("attacker siloFactory.withdraw(target's PAXG) with the granted role", () =>
      siloFactory.connect(attacker).withdraw(paxgAddr, attacker.address, before.collateral)
    );
    if (!drained) {
      const now2 = await snapshotTarget();
      record(
        "custody hole demonstrated",
        "FAIL",
        `silo PAXG ${ethers.formatEther(before.silo)} -> ${ethers.formatEther(now2.silo)}; vault ledger still says ${ethers.formatEther(now2.collateral)} PAXG. Fix shipped: lockVaultRole (redeploy required).`
      );
    }
  }

  console.log("\nSummary");
  const fails = rows.filter((r) => r.outcome === "FAIL");
  console.log(`  ${rows.filter((r) => r.outcome === "PASS").length} refused, ${fails.length} succeeded, ${rows.filter((r) => r.outcome === "INFO").length} informational`);
  for (const f of fails) console.log(`  FAIL: ${f.scenario}: ${f.detail}`);
  process.exitCode = fails.length === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error(describeErrorStack(error));
  process.exit(1);
});
