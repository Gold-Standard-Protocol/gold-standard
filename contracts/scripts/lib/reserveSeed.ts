/**
 * Calldata for seeding the Gold Stability Reserve from a Safe (docs/MAINNET.md section 5): the
 * token's `approve(reserve, amount)`, then the reserve's `seedCollateral(token, amount)`, both
 * signed by the Safe that holds the gold.
 *
 * `seedCollateral` is permissionless: it has no role check, because it can only add to the
 * reserve. It pulls the tokens with transferFrom and credits what arrived to collateralBalance,
 * the figure swaps draw on and governance can withdraw from. That credit is the whole point: a
 * plain ERC-20 transfer to the reserve address raises its token balance and nothing else. The
 * contract has no function that counts or returns tokens sent that way, so they are locked for
 * good. The printer therefore never prints a transfer, and says so.
 */
import { Contract, Interface, ZeroAddress, formatUnits, getAddress, parseUnits } from "ethers";
import type { Provider } from "ethers";

export interface SafeTransaction {
  to: string;
  value: "0";
  data: string;
  /** The call in words, for the signer to read against the Safe's own decoding. */
  decoded: string;
}

export interface ReserveSeed {
  reserve: string;
  token: string;
  /** In the token's smallest unit. */
  amount: bigint;
}

/** What the printer reads from the chain before it prints anything. */
export interface SeedContext {
  symbol: string;
  decimals: number;
  /** GoldStabilityReserve.assets(token).supported: false makes seedCollateral revert "Unsupported token". */
  supported: boolean;
  /** The reserve's counted balance of the token before the seed. */
  collateralBalance: bigint;
}

const tokenInterface = new Interface([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function balanceOf(address account) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
]);

const reserveInterface = new Interface([
  "function seedCollateral(address token, uint256 amount)",
  "function assets(address token) view returns (bool supported, uint64 pausedUntil, uint8 decimals, uint256 minReserve, uint256 dailyCapPpm, bool listed)",
  "function collateralBalance(address token) view returns (uint256)",
]);

/** The loud line every run prints: the one mistake this step cannot take back. */
export const DIRECT_TRANSFER_WARNING = [
  "WARNING: NEVER SEND THE TOKEN TO THE RESERVE WITH A PLAIN TRANSFER.",
  "A transfer raises the reserve's token balance but is not counted as reserve: no swap can draw",
  "on it, governance cannot withdraw it, and the contract has no function that recovers it.",
  "Tokens sent that way are locked for good. Only the two transactions below seed the reserve.",
];

/**
 * SEED_AMOUNT as typed, in whole tokens with a decimal point ("25", "0.5"), scaled by the
 * token's own decimals. Zero is refused (seedCollateral reverts "Zero amount"), as is a fraction
 * finer than the token can hold, which must not be rounded away in silence.
 */
export function parseSeedAmount(raw: string | undefined, decimals: number, symbol: string): bigint {
  const value = raw?.trim();
  if (!value) throw new Error(`Set SEED_AMOUNT, the amount of ${symbol} to seed in whole tokens (for example 25 or 0.5).`);
  if (!/^\d+(\.\d+)?$/.test(value)) throw new Error(`SEED_AMOUNT must be a plain decimal number of ${symbol}, got "${value}"`);
  const fraction = value.split(".")[1] ?? "";
  if (fraction.length > decimals) throw new Error(`SEED_AMOUNT carries ${fraction.length} decimal places; ${symbol} has ${decimals}`);
  const amount = parseUnits(value, decimals);
  if (amount === 0n) throw new Error("SEED_AMOUNT must be above zero; seedCollateral refuses a zero amount.");
  return amount;
}

/** SEED_TOKEN as typed: paxg (the default), xaut, or a token address; resolved against the snapshot's tokens. */
export function resolveSeedToken(raw: string | undefined, tokens: { paxgToken: string; xautToken: string }): string {
  const value = (raw ?? "paxg").trim();
  if (value.toLowerCase() === "paxg") return getAddress(tokens.paxgToken);
  if (value.toLowerCase() === "xaut") return getAddress(tokens.xautToken);
  try {
    return getAddress(value);
  } catch {
    throw new Error(`SEED_TOKEN must be paxg, xaut or a token address, got "${value}"`);
  }
}

function assertSeedShape(seed: ReserveSeed): void {
  if (getAddress(seed.reserve) === ZeroAddress) throw new Error("reserve must not be the zero address");
  if (getAddress(seed.token) === ZeroAddress) throw new Error("token must not be the zero address");
  if (getAddress(seed.token) === getAddress(seed.reserve)) throw new Error("token and reserve are the same address");
  if (seed.amount <= 0n) throw new Error("amount must be above zero");
}

/** Transaction 1: the Safe lets the reserve pull exactly `amount`. `to` is the token. */
export function encodeApprove(seed: ReserveSeed, context: Pick<SeedContext, "symbol" | "decimals">): SafeTransaction {
  assertSeedShape(seed);
  return {
    to: getAddress(seed.token),
    value: "0",
    data: tokenInterface.encodeFunctionData("approve", [seed.reserve, seed.amount]),
    decoded: `${context.symbol}.approve(spender ${getAddress(seed.reserve)}, amount ${seed.amount}) = ${formatUnits(seed.amount, context.decimals)} ${context.symbol}`,
  };
}

/** Transaction 2: the reserve pulls the tokens and counts them. `to` is the reserve. */
export function encodeSeed(seed: ReserveSeed, context: Pick<SeedContext, "symbol" | "decimals">): SafeTransaction {
  assertSeedShape(seed);
  return {
    to: getAddress(seed.reserve),
    value: "0",
    data: reserveInterface.encodeFunctionData("seedCollateral", [seed.token, seed.amount]),
    decoded: `GoldStabilityReserve.seedCollateral(token ${getAddress(seed.token)}, amount ${seed.amount}) = ${formatUnits(seed.amount, context.decimals)} ${context.symbol}`,
  };
}

/** The token's own symbol and decimals, and what the reserve says about it. Read-only. */
export async function readSeedContext(provider: Provider, reserve: string, token: string): Promise<SeedContext> {
  if ((await provider.getCode(reserve)) === "0x") throw new Error(`The reserve ${reserve} has no code on this chain.`);
  if ((await provider.getCode(token)) === "0x") throw new Error(`The token ${token} has no code on this chain.`);
  const erc20 = new Contract(token, tokenInterface, provider);
  const gsr = new Contract(reserve, reserveInterface, provider);
  const [symbol, decimals, asset, collateralBalance] = await Promise.all([
    erc20.symbol() as Promise<string>,
    erc20.decimals() as Promise<bigint>,
    gsr.assets(token) as Promise<{ supported: boolean }>,
    gsr.collateralBalance(token) as Promise<bigint>,
  ]);
  return { symbol, decimals: Number(decimals), supported: asset.supported, collateralBalance };
}

/** Refuses a token the reserve does not accept, before any calldata is printed for it. */
export function assertSeedable(token: string, context: SeedContext): void {
  if (!context.supported) {
    throw new Error(
      `The reserve does not accept ${context.symbol} (${token}): GoldStabilityReserve.assets(token).supported is false, so seedCollateral would revert "Unsupported token". ` +
        "Nothing is printed. Only a token governance has configured with setAssetConfig can be seeded; at launch that is PAXG."
    );
  }
}

/** What the Safe named in SEED_FROM holds and has already approved; the printer warns from these. */
export async function readHolder(provider: Provider, seed: ReserveSeed, holder: string): Promise<{ balance: bigint; allowance: bigint }> {
  const erc20 = new Contract(seed.token, tokenInterface, provider);
  const [balance, allowance] = await Promise.all([erc20.balanceOf(holder) as Promise<bigint>, erc20.allowance(holder, seed.reserve) as Promise<bigint>]);
  return { balance, allowance };
}
