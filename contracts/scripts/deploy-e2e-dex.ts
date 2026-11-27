/**
 * Deploy a real Uniswap v3 on the local end-to-end chain (apps/dapp-e2e): factory,
 * position manager, SwapRouter02 and QuoterV2 from the vendored artifacts in
 * apps/dapp-e2e/tools/uniswap, with a mock ERC20 standing in for WETH9 (no native-ETH
 * path is ever used). The addresses are written into deployments/e2e.json under
 * config.uniswap for the bootstrap and the dapp. Refuses to run anywhere but e2e.
 *
 *   npx hardhat run scripts/deploy-e2e-dex.ts --network e2e
 */
import { ethers, network } from "hardhat";
import type { InterfaceAbi } from "ethers";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describeError } from "./lib/redact";

const ARTIFACTS = resolve(__dirname, "../../apps/dapp-e2e/tools/uniswap");
const POOL_FEE = 3000;

interface Artifact {
  abi: InterfaceAbi;
  bytecode: string;
}

function artifact(name: string): Artifact {
  return JSON.parse(readFileSync(resolve(ARTIFACTS, `${name}.json`), "utf8")) as Artifact;
}

async function main() {
  if (network.name !== "e2e") {
    throw new Error(`Refusing on ${network.name}: this deploys a test Uniswap for the local end-to-end chain only.`);
  }
  const snapPath = resolve(__dirname, "../deployments/e2e.json");
  const snap = JSON.parse(readFileSync(snapPath, "utf8"));
  const [deployer] = await ethers.getSigners();

  const deploy = async (name: string, args: unknown[]): Promise<string> => {
    const { abi, bytecode } = artifact(name);
    const contract = await new ethers.ContractFactory(abi, bytecode, deployer).deploy(...args);
    await contract.waitForDeployment();
    const address = await contract.getAddress();
    console.log(`${name.padEnd(28)} ${address}`);
    return address;
  };

  const weth = await (await ethers.getContractFactory("MockERC20", deployer)).deploy("Wrapped Ether", "WETH", 18);
  await weth.waitForDeployment();
  const wethAddress = await weth.getAddress();
  console.log(`${"WETH9 stand-in".padEnd(28)} ${wethAddress}`);

  const factory = await deploy("UniswapV3Factory", []);
  const positionManager = await deploy("NonfungiblePositionManager", [factory, wethAddress, ethers.ZeroAddress]);
  const router = await deploy("SwapRouter02", [ethers.ZeroAddress, factory, positionManager, wethAddress]);
  const quoter = await deploy("QuoterV2", [factory, wethAddress]);

  snap.config.uniswap = { factory, positionManager, router, quoter, poolFee: POOL_FEE };
  writeFileSync(snapPath, JSON.stringify(snap, null, 2) + "\n");
  console.log(`Snapshot updated: ${snapPath}`);
}

main().catch((error) => {
  console.error(describeError(error));
  process.exit(1);
});
