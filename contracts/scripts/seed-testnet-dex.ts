import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";
import { describeErrorStack } from "./lib/redact";

/**
 * Seed a GSUSD/PAXG Uniswap v3 pool on a testnet so the market swap leg has a route.
 *
 * The swap page offers two venues. The market swap (Uniswap v3) is the everyday route,
 * where the protocol earns fees through its own liquidity positions; the reserve is
 * the price floor for arbitrage. Until a pool with liquidity exists the market tab can
 * only say "No DEX liquidity for this pair yet", so this script:
 *
 *   1. creates the pool at the configured fee tier if the factory has none, and
 *      initialises it at the oracle PAXG price (sqrtPriceX96 computed for the
 *      factory's token0/token1 ordering; both tokens carry 18 decimals);
 *   2. obtains the GSUSD side by depositing PAXG into the GoldVault and minting at
 *      roughly 150% collateralisation from a DEDICATED liquidity wallet;
 *   3. mints one full-range position holding PAXG_LP PAXG and the matching GSUSD;
 *   4. prints the pool address, the position tokenId and a QuoterV2 quote for
 *      1000 GSUSD, which is exactly what the dapp will show.
 *
 * The liquidity wallet is deliberately NOT the deployer: the deployer wallet is the
 * one used in the browser, and a wallet that both holds the position and tests swaps
 * against it proves nothing about the route. Set LP_PRIVATE_KEY to a funded Sepolia
 * key (ETH for gas; the PAXG mock is mintable, so gold is minted on demand).
 *
 *   LP_PRIVATE_KEY=0x... PAXG_LP=5 npx hardhat run scripts/seed-testnet-dex.ts --network sepolia
 *
 * Env (defaults are the Sepolia Uniswap v3 deployment):
 *   LP_PRIVATE_KEY            required; the liquidity wallet
 *   PAXG_LP                   PAXG in the position (default 5)
 *   POOL_FEE                  fee tier (default 3000 = 0.30%; matches VITE_DEX_POOL_FEE)
 *   UNISWAP_FACTORY           default 0x0227628f3F023bb0B980b67D528571c95c6DaC1c
 *   UNISWAP_POSITION_MANAGER  default 0x1238536071E1c677A632429e3655c799b22cDA52
 *   UNISWAP_QUOTER            default 0xEd1f6473345F45b75F8179591dd5bA1888cf2FB3
 *
 * Testnet only. On mainnet the protocol's liquidity is a treasury decision.
 */

const SEPOLIA_DEFAULTS = {
  factory: "0x0227628f3F023bb0B980b67D528571c95c6DaC1c",
  positionManager: "0x1238536071E1c677A632429e3655c799b22cDA52",
  quoter: "0xEd1f6473345F45b75F8179591dd5bA1888cf2FB3",
};

/** Tick spacing per fee tier, as enabled on a stock UniswapV3Factory. */
const TICK_SPACING: Record<number, number> = { 100: 1, 500: 10, 3000: 60, 10000: 200 };
/** TickMath.MIN_TICK / MAX_TICK; a full-range position uses the nearest usable ticks. */
const MAX_TICK = 887272;

const ORACLE_PRICE_SCALE = 10n ** 8n;
const Q96 = 2n ** 96n;
const PRECISION = 1_000_000n; // GoldVault ratio precision: 1_500_000 = 150%
const TARGET_RATIO = 1_500_000n;

const FACTORY_ABI = [
  "function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)",
  "function createPool(address tokenA, address tokenB, uint24 fee) returns (address pool)",
];
const POOL_ABI = [
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "function initialize(uint160 sqrtPriceX96)",
  "function liquidity() view returns (uint128)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
];
const POSITION_MANAGER_ABI = [
  "function mint((address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, address recipient, uint256 deadline) params) payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)",
  "event IncreaseLiquidity(uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)",
];
const QUOTER_ABI = [
  "function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
];
const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function mint(address to, uint256 amount)",
];

/** Integer square root by Newton's method; exact floor for any non-negative bigint. */
function isqrt(n: bigint): bigint {
  if (n < 0n) throw new Error("isqrt of a negative number");
  if (n < 2n) return n;
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  return x;
}

/**
 * Uniswap's sqrtPriceX96 = sqrt(token1 per token0, in raw units) × 2^96. With GSUSD
 * at $1 and both tokens at 18 decimals, the raw ratio is the oracle price itself
 * (GSUSD per PAXG) when PAXG is token0, and its inverse when GSUSD is token0.
 * A worked check sits in the comment at the bottom of this file.
 */
function sqrtPriceX96FromOracle(price8: bigint, gsusdIsToken0: boolean): bigint {
  if (price8 <= 0n) throw new Error("Oracle price must be positive");
  return gsusdIsToken0
    ? isqrt((ORACLE_PRICE_SCALE * Q96 * Q96) / price8)
    : isqrt((price8 * Q96 * Q96) / ORACLE_PRICE_SCALE);
}

/** Nearest tick inside [-MAX_TICK, MAX_TICK] that the tier's spacing allows. */
function fullRangeTicks(fee: number): { tickLower: number; tickUpper: number } {
  const spacing = TICK_SPACING[fee];
  if (!spacing) throw new Error(`Unsupported fee tier ${fee}; expected 100, 500, 3000 or 10000.`);
  const usable = Math.floor(MAX_TICK / spacing) * spacing;
  return { tickLower: -usable, tickUpper: usable };
}

async function main() {
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  if (chainId === 1) throw new Error("Refusing to seed DEX liquidity on mainnet from a script.");

  // A dedicated liquidity wallet by key on a testnet; on the local end-to-end node one of
  // its own unlocked accounts by address (LP_ADDRESS), so no key is involved at all.
  const lpKey = process.env.LP_PRIVATE_KEY;
  const lpAddress = process.env.LP_ADDRESS;
  if (!lpKey && !lpAddress) {
    throw new Error("Set LP_PRIVATE_KEY (a dedicated liquidity wallet, not the deployer) or, on a local node, LP_ADDRESS.");
  }
  if (lpAddress && network.name !== "e2e") {
    throw new Error("LP_ADDRESS is for the local end-to-end node only; use LP_PRIVATE_KEY elsewhere.");
  }
  const lp = lpKey
    ? new ethers.Wallet(lpKey, ethers.provider)
    : await ethers.getSigner(ethers.getAddress(lpAddress ?? ""));

  const snapshotPath = path.join(__dirname, "..", "deployments", `${network.name}.json`);
  const dep = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
  if (lp.address.toLowerCase() === String(dep.deployer).toLowerCase()) {
    throw new Error("LP_PRIVATE_KEY is the deployer key. The position must belong to a separate wallet.");
  }

  const vaultAddr: string = dep.addresses.vault;
  const oracleAddr: string = dep.addresses.oracle;
  const gsusdAddr: string = dep.addresses.stablecoin;
  const paxgAddr: string = dep.config.paxgToken;

  const factoryAddr = process.env.UNISWAP_FACTORY ?? SEPOLIA_DEFAULTS.factory;
  const positionManagerAddr = process.env.UNISWAP_POSITION_MANAGER ?? SEPOLIA_DEFAULTS.positionManager;
  const quoterAddr = process.env.UNISWAP_QUOTER ?? SEPOLIA_DEFAULTS.quoter;
  const fee = Number(process.env.POOL_FEE ?? "3000");
  const { tickLower, tickUpper } = fullRangeTicks(fee);

  const paxgLp = ethers.parseUnits(process.env.PAXG_LP ?? "5", 18);

  console.log(`Network: ${network.name} (chain ${chainId})`);
  console.log(`Liquidity wallet: ${lp.address}`);
  console.log(`GSUSD ${gsusdAddr}\nPAXG  ${paxgAddr}\nFee   ${fee} (${(fee / 10_000).toFixed(2)}%)\n`);

  const ethBalance = await ethers.provider.getBalance(lp.address);
  if (ethBalance === 0n) throw new Error("The liquidity wallet holds no ETH for gas.");

  // --- 1. Oracle price and sizing ---------------------------------------------------
  const oracle = await ethers.getContractAt("GoldOracle", oracleAddr, lp);
  const [price8, ok] = await oracle.getValidatedPrice(paxgAddr);
  if (!ok || price8 === 0n) throw new Error("The oracle has no validated PAXG price; refresh the testnet feeds first.");
  console.log(`Oracle PAXG price: $${ethers.formatUnits(price8, 8)}`);

  // A full-range position at price P holds GSUSD worth exactly its PAXG: gsusd = paxg × P.
  const gsusdForPosition = (paxgLp * price8) / ORACLE_PRICE_SCALE;

  // --- 2. GSUSD from the vault at ~150% -------------------------------------------
  const paxg = new ethers.Contract(paxgAddr, ERC20_ABI, lp);
  const gsusd = new ethers.Contract(gsusdAddr, ERC20_ABI, lp);
  const vault = await ethers.getContractAt("GoldVault", vaultAddr, lp);

  let gsusdBalance: bigint = await gsusd.balanceOf(lp.address);
  let collateralNeeded = 0n;
  let mintAmount = 0n;
  if (gsusdBalance < gsusdForPosition) {
    // Origination fees come out of what the minter RECEIVES, so gross the mint up.
    let feeBps = 0n;
    try {
      feeBps = BigInt(await vault.originationFeeBps());
    } catch {
      feeBps = 0n;
    }
    const shortfall = gsusdForPosition - gsusdBalance;
    mintAmount = feeBps > 0n ? (shortfall * 10_000n) / (10_000n - feeBps) + 1n : shortfall;
    // collateral value = 150% of debt; PAXG = value / price.
    collateralNeeded = ((mintAmount * TARGET_RATIO) / PRECISION) * ORACLE_PRICE_SCALE / price8 + 1n;
  }

  const paxgNeeded = paxgLp + collateralNeeded;
  let paxgBalance: bigint = await paxg.balanceOf(lp.address);
  console.log(`LP holds ${ethers.formatUnits(paxgBalance, 18)} PAXG and ${ethers.formatUnits(gsusdBalance, 18)} GSUSD`);
  console.log(`Needs   ${ethers.formatUnits(paxgNeeded, 18)} PAXG (${ethers.formatUnits(paxgLp, 18)} for the position + ${ethers.formatUnits(collateralNeeded, 18)} as collateral)`);
  if (paxgBalance < paxgNeeded) {
    // Testnet mocks are mintable by anyone; let a real token's revert surface.
    try {
      await (await paxg.mint(lp.address, paxgNeeded - paxgBalance)).wait();
      paxgBalance = await paxg.balanceOf(lp.address);
      console.log(`Minted test PAXG; LP now holds ${ethers.formatUnits(paxgBalance, 18)}`);
    } catch {
      throw new Error("Not enough PAXG, and the token is not a mintable mock.");
    }
  }

  if (mintAmount > 0n) {
    console.log(`\nDepositing ${ethers.formatUnits(collateralNeeded, 18)} PAXG into the vault...`);
    await (await paxg.approve(vaultAddr, collateralNeeded)).wait();
    await (await vault.deposit(paxgAddr, collateralNeeded)).wait();
    console.log(`Minting ${ethers.formatUnits(mintAmount, 18)} GSUSD...`);
    await (await vault.mint(mintAmount)).wait();
    gsusdBalance = await gsusd.balanceOf(lp.address);
    const ratio = await vault.getCollateralisationRatio(lp.address);
    console.log(`LP vault ratio: ${Number(ratio) / 10_000}%; LP now holds ${ethers.formatUnits(gsusdBalance, 18)} GSUSD`);
  }
  if (gsusdBalance < gsusdForPosition) {
    throw new Error("Still short of GSUSD for the position after minting; check the vault's fee and ceiling.");
  }

  // --- 3. Pool: create and initialise if absent --------------------------------------
  const gsusdIsToken0 = gsusdAddr.toLowerCase() < paxgAddr.toLowerCase();
  const token0 = gsusdIsToken0 ? gsusdAddr : paxgAddr;
  const token1 = gsusdIsToken0 ? paxgAddr : gsusdAddr;

  const factory = new ethers.Contract(factoryAddr, FACTORY_ABI, lp);
  let poolAddr: string = await factory.getPool(token0, token1, fee);
  if (poolAddr === ethers.ZeroAddress) {
    console.log(`\nNo pool at fee ${fee}; creating...`);
    await (await factory.createPool(token0, token1, fee)).wait();
    poolAddr = await factory.getPool(token0, token1, fee);
    if (poolAddr === ethers.ZeroAddress) throw new Error("createPool succeeded but getPool still returns zero.");
  }
  console.log(`\nPool: ${poolAddr} (token0 ${gsusdIsToken0 ? "GSUSD" : "PAXG"}, token1 ${gsusdIsToken0 ? "PAXG" : "GSUSD"})`);

  const pool = new ethers.Contract(poolAddr, POOL_ABI, lp);
  const slot0 = await pool.slot0();
  if (slot0.sqrtPriceX96 === 0n) {
    const sqrtPriceX96 = sqrtPriceX96FromOracle(price8, gsusdIsToken0);
    console.log(`Initialising at the oracle price (sqrtPriceX96 ${sqrtPriceX96})...`);
    await (await pool.initialize(sqrtPriceX96)).wait();
  } else {
    console.log(`Pool already initialised (sqrtPriceX96 ${slot0.sqrtPriceX96}, tick ${slot0.tick}); leaving its price alone.`);
  }

  // --- 4. Full-range position ---------------------------------------------------------
  const amount0Desired = gsusdIsToken0 ? gsusdForPosition : paxgLp;
  const amount1Desired = gsusdIsToken0 ? paxgLp : gsusdForPosition;

  console.log(`\nApproving the position manager for ${ethers.formatUnits(gsusdForPosition, 18)} GSUSD and ${ethers.formatUnits(paxgLp, 18)} PAXG...`);
  await (await gsusd.approve(positionManagerAddr, gsusdForPosition)).wait();
  await (await paxg.approve(positionManagerAddr, paxgLp)).wait();

  const positionManager = new ethers.Contract(positionManagerAddr, POSITION_MANAGER_ABI, lp);
  const params = {
    token0,
    token1,
    fee,
    tickLower,
    tickUpper,
    amount0Desired,
    amount1Desired,
    // Testnet: the pool price is whatever it is; a fresh pool takes both sides in full.
    amount0Min: 0n,
    amount1Min: 0n,
    recipient: lp.address,
    deadline: BigInt(Math.floor(Date.now() / 1000) + 20 * 60),
  };
  console.log(`Minting a full-range position (ticks ${tickLower} to ${tickUpper})...`);
  const mintTx = await positionManager.mint(params);
  const receipt = await mintTx.wait();

  let tokenId: bigint | undefined;
  for (const log of receipt.logs) {
    try {
      const parsed = positionManager.interface.parseLog({ topics: [...log.topics], data: log.data });
      if (parsed?.name === "IncreaseLiquidity") {
        tokenId = parsed.args.tokenId;
        console.log(`Position minted: tokenId ${tokenId}, liquidity ${parsed.args.liquidity}`);
        console.log(`  token0 in: ${ethers.formatUnits(parsed.args.amount0, 18)}, token1 in: ${ethers.formatUnits(parsed.args.amount1, 18)}`);
      }
    } catch {
      // Not a position manager event; the receipt also carries ERC20 transfers.
    }
  }

  // --- 5. Report ----------------------------------------------------------------------
  const liquidity = await pool.liquidity();
  const quoter = new ethers.Contract(quoterAddr, QUOTER_ABI, lp);
  const oneThousand = ethers.parseUnits("1000", 18);
  const quote = await quoter.quoteExactInputSingle.staticCall({
    tokenIn: gsusdAddr,
    tokenOut: paxgAddr,
    amountIn: oneThousand,
    fee,
    sqrtPriceLimitX96: 0n,
  });

  console.log(`\nPool address:     ${poolAddr}`);
  console.log(`Position tokenId: ${tokenId ?? "(not found in logs; check the explorer)"}`);
  console.log(`Pool liquidity:   ${liquidity}`);
  console.log(`Quote:            1000 GSUSD -> ${ethers.formatUnits(quote.amountOut, 18)} PAXG (implied $${(1000 / Number(ethers.formatUnits(quote.amountOut, 18))).toFixed(2)}/oz, oracle $${ethers.formatUnits(price8, 8)})`);
  console.log(`\nDapp env: VITE_UNISWAP_QUOTER=${quoterAddr}  VITE_DEX_POOL_FEE=${fee}`);
}

main().catch((e) => {
  console.error(describeErrorStack(e));
  process.exitCode = 1;
});

// Sanity check for sqrtPriceX96FromOracle at $2000 (price8 = 2000n * 10n ** 8n):
//   PAXG as token0:  sqrt(2000) × 2^96 ≈ 3.5432e30
//     sqrtPriceX96FromOracle(price8, false) = 3543191142285914205922034323214n; squared / 2^192 = 2000.0
//   GSUSD as token0: sqrt(1/2000) × 2^96 ≈ 1.7716e27
//     sqrtPriceX96FromOracle(price8, true)  = 1771595571142957102961017161n; 1 / (squared / 2^192) = 2000.0
