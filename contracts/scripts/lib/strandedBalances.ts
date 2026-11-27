/**
 * Tokens a contract holds but does not count. The reserve and the surplus buffer book what
 * arrives through their own functions (seedCollateral, depositCollateral, depositFee, a swap)
 * and release only what they booked. A plain ERC-20 transfer raises balanceOf and nothing
 * else: no swap can draw on it, withdrawCollateral and withdrawGsusd revert "Exceeds balance"
 * or "Exceeds inventory" on it, and no function recovers it. verify-deployment.ts lists each
 * such excess as a warning, so a mistaken transfer is seen on the next run instead of when a
 * withdrawal of the whole token balance reverts.
 */

/** One balance a contract keeps in its own storage, beside the token balance it really holds. */
export interface CountedBalance {
  /** Check name suffix, for example "reserve.paxg" or "buffer.gsusd". */
  label: string;
  /** The contract's own figure: collateralBalance(token), gsusdInventory or gsusdBalance. */
  counted: bigint;
  /** token.balanceOf(contract) at the same block. */
  held: bigint;
  decimals: number;
  symbol: string;
}

export interface StrandedFinding {
  name: string;
  /** Undefined when the two figures agree. */
  warning?: string;
  /** Set when the contract counts more than it holds, which no transfer can cause. */
  failure?: string;
}

function formatUnits(value: bigint, decimals: number): string {
  const base = 10n ** BigInt(decimals);
  const whole = value / base;
  const fraction = (value % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return fraction.length > 0 ? `${whole}.${fraction}` : whole.toString();
}

/** Compare one counted balance with the token balance behind it. */
export function strandedFinding(balance: CountedBalance): StrandedFinding {
  const name = `stranded:${balance.label}`;
  const amount = (value: bigint) => `${formatUnits(value, balance.decimals)} ${balance.symbol}`;
  if (balance.held > balance.counted) {
    return {
      name,
      warning:
        `holds ${amount(balance.held)} but counts ${amount(balance.counted)}: ${amount(balance.held - balance.counted)} ` +
        "arrived by a plain transfer. It is not counted, no swap or withdrawal can move it and no function recovers it. " +
        "A withdrawal sized from the token balance reverts; size every withdrawal from the counted figure.",
    };
  }
  if (balance.held < balance.counted) {
    return {
      name,
      failure: `counts ${amount(balance.counted)} but holds only ${amount(balance.held)}: the contract owes more than it has`,
    };
  }
  return { name };
}

export function strandedFindings(balances: CountedBalance[]): StrandedFinding[] {
  return balances.map(strandedFinding);
}

interface TokenReader {
  balanceOf(holder: string): Promise<bigint>;
  decimals(): Promise<bigint>;
  symbol(): Promise<string>;
}

/** Read one counted balance and the token balance behind it at a single block. */
export async function readCountedBalance(input: {
  label: string;
  token: TokenReader;
  holder: string;
  counted: () => Promise<bigint>;
}): Promise<CountedBalance> {
  const [counted, held, decimals, symbol] = await Promise.all([
    input.counted(),
    input.token.balanceOf(input.holder),
    input.token.decimals(),
    input.token.symbol(),
  ]);
  return { label: input.label, counted, held, decimals: Number(decimals), symbol };
}
