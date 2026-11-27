import type { BaseContract, ContractTransactionResponse, Signer } from "ethers";

/** The pool calls a test needs to stand in for the vault. */
interface AbsorbingPool extends BaseContract {
  connect(signer: Signer): AbsorbingPool;
  absorbLiquidationPrefunded(token: string, debtToAbsorb: bigint): Promise<ContractTransactionResponse>;
}

/** An ERC-20 the standing-in vault holds. */
interface TransferableToken extends BaseContract {
  connect(signer: Signer): TransferableToken;
  transfer(to: string, amount: bigint): Promise<ContractTransactionResponse>;
}

/**
 * A liquidation as the vault sends it to the pool: the seized gold reaches the pool first
 * (in production straight from the silos), then the vault asks the pool to absorb the debt
 * and the pool credits whatever arrived. `vault` holds VAULT_ROLE on the pool and the gold.
 */
export async function absorbPrefunded(
  pool: AbsorbingPool,
  token: TransferableToken,
  vault: Signer,
  debtToAbsorb: bigint,
  collateral: bigint
): Promise<ContractTransactionResponse> {
  await token.connect(vault).transfer(await pool.getAddress(), collateral);
  return pool.connect(vault).absorbLiquidationPrefunded(await token.getAddress(), debtToAbsorb);
}
