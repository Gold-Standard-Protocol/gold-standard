import { ethers, network } from "hardhat";
import { describeErrorStack } from "./lib/redact";

/**
 * Mint mock gold collateral to a test address (Sepolia dry-run only).
 *
 * MockERC20.mint is unpermissioned by design, so anyone soaking the testnet
 * deployment can fund themselves. Reads PAXG_TOKEN / XAUT_TOKEN from the env
 * written by deploy-testnet-mocks.ts.
 *
 * Usage:
 *   MINT_TO=0xYourWallet MINT_PAXG=50 npx hardhat run scripts/mint-testnet-collateral.ts --network sepolia
 */
async function main() {
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  if (chainId === 1) {
    throw new Error("Refusing to mint mock gold on mainnet.");
  }

  const [signer] = await ethers.getSigners();
  const to = process.env.MINT_TO ?? signer.address;
  const paxgAddr = process.env.PAXG_TOKEN;
  const xautAddr = process.env.XAUT_TOKEN;
  if (!paxgAddr) {
    throw new Error("PAXG_TOKEN is not set; run deploy-testnet-mocks.ts first.");
  }

  const paxgAmount = ethers.parseUnits(process.env.MINT_PAXG ?? "50", 18);
  const xautAmount = ethers.parseUnits(process.env.MINT_XAUT ?? "50", 6);

  console.log(`Network: ${network.name}\nRecipient: ${to}\n`);

  const paxg = await ethers.getContractAt("MockERC20", paxgAddr);
  await (await paxg.mint(to, paxgAmount)).wait();
  console.log(`Minted ${ethers.formatUnits(paxgAmount, 18)} PAXG -> ${to}`);

  if (xautAddr) {
    const xaut = await ethers.getContractAt("MockERC20", xautAddr);
    await (await xaut.mint(to, xautAmount)).wait();
    console.log(`Minted ${ethers.formatUnits(xautAmount, 6)} XAUT -> ${to}`);
    console.log(
      "\nNote: the XAUT debt ceiling is ZERO by launch policy (docs/ORACLES.md),\n" +
        "so XAUT can be deposited but nothing can be minted against it."
    );
  }
}

main().catch((error) => {
  console.error(describeErrorStack(error));
  process.exitCode = 1;
});
