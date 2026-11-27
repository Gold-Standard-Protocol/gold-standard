import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";

/**
 * The production system fixture, mirroring scripts/deploy.ts step by step: same order,
 * same role grants, same wiring. Shared by the end-to-end rehearsal and the liveness
 * tests so there is exactly one mirror of the ceremony to keep honest.
 */

export const GOLD_PRICE = 200000000000n;
export const MIN_RATIO = 1500000n;
export const LIQ_RATIO = 1100000n;
export const LIQ_PENALTY = 50000n;
export const DEBT_CEILING = ethers.parseEther("1000000");
export const SILO_CAP = ethers.parseEther("100");

export async function setValidPrice(feed: { setLatestRoundData: (a: number, b: bigint, c: number, d: number, e: number) => Promise<unknown> }, price: bigint) {
  const ts = await time.latest();
  await feed.setLatestRoundData(1, price, ts, ts, 1);
}

export async function productionSystem() {
  const [deployer, proposer, executor, guardian, alice, bob, charlie] = await ethers.getSigners();

  const MockAgg = await ethers.getContractFactory("MockAggregatorV3");
  const paxgFeed = await MockAgg.deploy(8);
  const xautFeed = await MockAgg.deploy(8);

  const MockToken = await ethers.getContractFactory("MockERC20");
  const paxg = await MockToken.deploy("Pax Gold", "PAXG", 18);
  const xaut = await MockToken.deploy("Tether Gold", "XAUT", 6);

  await setValidPrice(paxgFeed, GOLD_PRICE);
  await setValidPrice(xautFeed, GOLD_PRICE);

  const OracleF = await ethers.getContractFactory("GoldOracle");
  const oracle = await OracleF.deploy(
    await paxgFeed.getAddress(),
    await xautFeed.getAddress(),
    await paxg.getAddress(),
    await xaut.getAddress(),
    3600
  );

  const StablecoinF = await ethers.getContractFactory("GoldStablecoin");
  const stablecoin = await StablecoinF.deploy();

  const StabModF = await ethers.getContractFactory("StabilityModule");
  const stabilityModule = await StabModF.deploy();

  const VaultF = await ethers.getContractFactory("GoldVault");
  const vault = await VaultF.deploy(
    await oracle.getAddress(),
    await stablecoin.getAddress(),
    await stabilityModule.getAddress()
  );

  const SurplusF = await ethers.getContractFactory("SurplusBuffer");
  const surplusBuffer = await SurplusF.deploy(await stablecoin.getAddress());

  const PoolF = await ethers.getContractFactory("StabilityPool");
  const stabilityPool = await PoolF.deploy(await stablecoin.getAddress());

  const ReserveF = await ethers.getContractFactory("GoldStabilityReserve");
  const reserve = await ReserveF.deploy(await stablecoin.getAddress(), await oracle.getAddress());

  const SiloF = await ethers.getContractFactory("SiloFactory");
  const siloFactory = await SiloF.deploy(SILO_CAP);

  const GovF = await ethers.getContractFactory("GoldGovernance");
  const governance = await GovF.deploy(
    [proposer.address],
    [executor.address],
    await vault.getAddress(),
    await oracle.getAddress(),
    await stabilityModule.getAddress()
  );
  const timelockAddr = await governance.getTimelockAddress();

  // Role wiring — mirror of scripts/deploy.ts
  const MINTER_ROLE = await stablecoin.MINTER_ROLE();
  const VAULT_ROLE_SM = await stabilityModule.VAULT_ROLE();
  const VAULT_ROLE_SB = await surplusBuffer.VAULT_ROLE();
  const VAULT_ROLE_SP = await stabilityPool.VAULT_ROLE();
  const VAULT_ROLE_SF = await siloFactory.VAULT_ROLE();

  await stablecoin.grantRole(MINTER_ROLE, await vault.getAddress());
  await stabilityModule.grantRole(VAULT_ROLE_SM, await vault.getAddress());
  await surplusBuffer.grantRole(VAULT_ROLE_SB, await vault.getAddress());
  await surplusBuffer.grantRole(VAULT_ROLE_SB, await reserve.getAddress());
  await reserve.grantRole(await reserve.VAULT_ROLE(), await vault.getAddress());
  await stabilityPool.grantRole(VAULT_ROLE_SP, await vault.getAddress());
  await siloFactory.grantRole(VAULT_ROLE_SF, await vault.getAddress());

  // Wiring
  await vault.setSurplusBuffer(await surplusBuffer.getAddress());
  await vault.setStabilityPool(await stabilityPool.getAddress());
  await vault.setStabilityReserve(await reserve.getAddress());
  await vault.setReservePenaltyShare(4000n);
  await vault.setSiloFactory(await siloFactory.getAddress());
  const RegistryF = await ethers.getContractFactory("VaultRegistry");
  const registry = await RegistryF.deploy(await vault.getAddress());
  await vault.setVaultRegistry(await registry.getAddress());
  await reserve.setSurplusBuffer(await surplusBuffer.getAddress());
  await reserve.setAssetConfig(await paxg.getAddress(), true, 0n, 1_000_000n);
  await reserve.setAssetConfig(await xaut.getAddress(), true, 0n, 1_000_000n);
  await reserve.setSpreadCurve([{ coverageAtLeastPpm: 10_000n, spreadPpm: 5_000n }], 20_000n);

  // Guardian
  await vault.grantGuardianRole(guardian.address);
  await oracle.grantGuardianRole(guardian.address);
  await reserve.grantGuardianRole(guardian.address);
  await stabilityPool.grantGuardianRole(guardian.address);

  // Collateral types
  await vault.addCollateralType(
    await paxg.getAddress(),
    MIN_RATIO,
    LIQ_RATIO,
    LIQ_PENALTY,
    DEBT_CEILING
  );
  await vault.addCollateralType(
    await xaut.getAddress(),
    MIN_RATIO,
    LIQ_RATIO,
    LIQ_PENALTY,
    DEBT_CEILING
  );

  const paxgId = ethers.keccak256(ethers.solidityPacked(["address"], [await paxg.getAddress()]));
  const xautId = ethers.keccak256(ethers.solidityPacked(["address"], [await xaut.getAddress()]));
  await stabilityModule.initCollateral(paxgId, 200);
  await stabilityModule.initCollateral(xautId, 200);

  await stabilityPool.addCollateralToken(await paxg.getAddress());
  await stabilityPool.addCollateralToken(await xaut.getAddress());

  // Initialise oracle lastKnown so subsequent reads work cleanly
  await oracle.getTokenPrice(await paxg.getAddress());
  await oracle.getTokenPrice(await xaut.getAddress());

  // Pre-fund users
  await paxg.mint(alice.address, ethers.parseEther("100"));
  await paxg.mint(bob.address, ethers.parseEther("100"));
  await xaut.mint(charlie.address, 100_000_000n);
  await paxg.connect(alice).approve(await vault.getAddress(), ethers.MaxUint256);
  await paxg.connect(bob).approve(await vault.getAddress(), ethers.MaxUint256);
  await xaut.connect(charlie).approve(await vault.getAddress(), ethers.MaxUint256);

  // Stablecoin minting for liquidators
  await stablecoin.grantRole(MINTER_ROLE, deployer.address);
  await stablecoin.mint(bob.address, ethers.parseEther("50000"));
  await stablecoin.connect(bob).approve(await vault.getAddress(), ethers.MaxUint256);
  await stablecoin.mint(alice.address, ethers.parseEther("50000"));
  await stablecoin.connect(alice).approve(await vault.getAddress(), ethers.MaxUint256);
  await stablecoin.connect(alice).approve(await stabilityPool.getAddress(), ethers.MaxUint256);
  await stablecoin.connect(alice).approve(await reserve.getAddress(), ethers.MaxUint256);

  return {
    deployer, proposer, executor, guardian, alice, bob, charlie,
    paxg, xaut, paxgFeed, xautFeed,
    oracle, stablecoin, stabilityModule, vault,
    surplusBuffer, stabilityPool, reserve, siloFactory,
    governance, timelockAddr, registry,
    paxgId, xautId,
  };
}
