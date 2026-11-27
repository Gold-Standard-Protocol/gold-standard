/** What a mint delivers once GoldVault takes its origination fee. */
export interface MintFeeSplit {
	/** The fee in basis points of the amount minted; 0 when the account is exempt. */
	bps: bigint;
	/** GSUSD kept by the protocol, in wei. */
	fee: bigint;
	/** GSUSD that reaches the minter's wallet, in wei. The debt still rises by the full amount. */
	received: bigint;
}

/**
 * The split GoldVault.mint applies: `fee = amount * originationFeeBps / 10000`, rounded down,
 * and nothing at all for an exempt account. Mirrors the contract so the review screen states
 * the figure the wallet will actually receive.
 */
export function originationFeeSplit(amount: bigint, feeBps: bigint, exempt: boolean): MintFeeSplit {
	const bps = exempt ? 0n : feeBps;
	const fee = bps === 0n || amount <= 0n ? 0n : (amount * bps) / 10_000n;
	return { bps, fee, received: amount - fee };
}

/** "0.05%" for 5 bps: the fee as a borrower reads it. */
export function formatFeeBps(bps: bigint): string {
	const percent = Number(bps) / 100;
	return `${percent.toLocaleString('en-US', { maximumFractionDigits: 2 })}%`;
}
