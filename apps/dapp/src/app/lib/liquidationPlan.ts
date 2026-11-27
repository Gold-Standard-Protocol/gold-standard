/** GoldVault.PRECISION: ratios, penalties and shares are 1e6 fixed point. */
const PRECISION = 1_000_000n;
/** Oracle prices carry 8 decimals; GSUSD carries 18. */
const PRICE_DECIMALS = 100_000_000n;

export interface LiquidationPreview {
	/** GSUSD the liquidator actually repays: the request, or what the gold is worth if less. */
	debtRepaid: bigint;
	/** Collateral taken from the vault, token decimals. */
	collateralSeized: bigint;
	/** What the liquidator receives: debt-equivalent gold plus their share of the penalty. */
	liquidatorPayout: bigint;
	/** The penalty gold that goes to the protocol (insurance and reserve). */
	protocolPayout: bigint;
	/** Everything seized beyond the debt-equivalent gold, before the split. */
	totalPenalty: bigint;
	/** Liquidator's effective discount on the gold they buy, percent. */
	bonusPercent: number;
	/**
	 * True when the vault's gold cannot pay the full penalty on all its debt (below 100% plus
	 * the penalty): the seizure is pro rata, the same share of the gold as of the debt, and
	 * a full liquidation takes the whole vault.
	 */
	clamped: boolean;
	/** True when the gold is worth less than the debt: the repayment is cut to its value. */
	underwater: boolean;
	/**
	 * True when the request is a partial on an underwater vault, which the contract refuses
	 * ("Thin vault: liquidate in full"); only a full liquidation is accepted there.
	 */
	refused: boolean;
}

/**
 * Mirrors GoldVault._sizeSeizure exactly:
 *   collateralToSeize = debt × (1 + penalty) / price         (token decimals)
 *   debtEquivalent    = debt / price
 *   liquidatorBonus   = (seize − debtEquivalent) × liquidatorIncentiveShare
 * When the full penalty on the WHOLE debt does not fit in the vault, the seizure is pro
 * rata: the same share of the gold as of the debt, so the vault's ratio is unchanged and
 * the penalty is whatever the gold holds above the debt's value. A full liquidation
 * then takes everything. Only when the gold is worth less than the debt is a partial
 * refused and the repayment cut, to the gold's value less the underwater discount, but
 * never below twice the gold's value minus the debt, so the discount never exceeds the
 * shortfall. The earlier shapes cut the DEBT to keep the whole penalty, which
 * booked bad debt on solvent vaults, and let a partial take the full penalty
 * multiple, leaving a vault with no gold and thousands of GSUSD of debt.
 *
 * @param debtToRepay   GSUSD, 18 decimals.
 * @param currentDebt   The vault's fee-inclusive debt, 18 decimals.
 * @param vaultCollateral Vault collateral, token decimals.
 * @param price8        Oracle price, 8 decimals.
 * @param penaltyPpm    Collateral type liquidation penalty, 1e6 = 100%.
 * @param sharePpm      liquidatorIncentiveShare, 1e6 = 100%.
 * @param decimals      Collateral token decimals.
 * @param underwaterDiscountPpm GoldVault.underwaterDiscountPpm, 1e6 = 100%.
 */
export function previewLiquidation(
	debtToRepay: bigint,
	currentDebt: bigint,
	vaultCollateral: bigint,
	price8: bigint,
	penaltyPpm: bigint,
	sharePpm: bigint,
	decimals: number,
	underwaterDiscountPpm: bigint
): LiquidationPreview | undefined {
	if (debtToRepay <= 0n || price8 <= 0n) return undefined;
	const scale = 10n ** BigInt(18 - decimals);
	const priceScale = price8 * scale;
	const seizeFor = (amount: bigint) => (amount * (PRECISION + penaltyPpm) * PRICE_DECIMALS) / (priceScale * PRECISION);
	const fullSeize = seizeFor(currentDebt);
	const clamped = fullSeize > vaultCollateral;
	const coverable = (vaultCollateral * priceScale) / PRICE_DECIMALS;
	const underwater = clamped && coverable < currentDebt;
	const refused = underwater && debtToRepay !== currentDebt;
	const seized = clamped ? (vaultCollateral * debtToRepay) / currentDebt : seizeFor(debtToRepay);
	const debt = underwater ? underwaterRepay(coverable, currentDebt, underwaterDiscountPpm) : debtToRepay;
	const debtEquivalent = (debt * PRICE_DECIMALS) / priceScale;
	const totalPenalty = seized > debtEquivalent ? seized - debtEquivalent : 0n;
	const liquidatorBonus = (totalPenalty * sharePpm) / PRECISION;
	const liquidatorPayout = debtEquivalent + liquidatorBonus;
	const bonusPercent = debtEquivalent > 0n ? Number((liquidatorBonus * 1_000_000n) / debtEquivalent) / 10_000 : 0;
	// protocolPayout assumes the vault receives the full seizure; a fee-on-transfer
	// collateral would deliver slightly less and the contract splits what it received.
	return {
		debtRepaid: debt,
		collateralSeized: seized,
		liquidatorPayout,
		protocolPayout: seized - liquidatorPayout,
		totalPenalty,
		bonusPercent,
		clamped,
		underwater,
		refused,
	};
}

/** GoldVault's underwater repayment: max(coverable × (1 − discount), 2 × coverable − debt). */
function underwaterRepay(coverable: bigint, currentDebt: bigint, discountPpm: bigint): bigint {
	const discounted = (coverable * (PRECISION - discountPpm)) / PRECISION;
	const floor = 2n * coverable > currentDebt ? 2n * coverable - currentDebt : 0n;
	return floor > discounted ? floor : discounted;
}

/**
 * GoldVault.liquidateViaPool pays the keeper half the liquidator share of the penalty:
 * mulDiv(totalPenalty, liquidatorIncentiveShare / 2, PRECISION). Computed from the
 * penalty itself; reconstructing it from the protocol's cut divided by (1 − share)
 * was off by a wei and divided by zero at a 100% share, which governance may set.
 */
export function keeperBounty(preview: LiquidationPreview, sharePpm: bigint): bigint {
	return (preview.totalPenalty * (sharePpm / 2n)) / PRECISION;
}
