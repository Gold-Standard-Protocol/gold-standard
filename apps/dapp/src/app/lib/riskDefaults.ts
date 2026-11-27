import { ratioStatus, type CollateralParams, type RatioStatus } from '@goldstandard/hooks';

/**
 * The launch parameters for every collateral (GoldVault minRatio 1_300_000 and
 * liquidationRatio 1_100_000), used only while the live read is loading or has failed.
 * The forms used to fall back to a 150% floor for their maths while the withdraw copy
 * said 130%, so they refused or under quoted mints the protocol would accept.
 */
export const LAUNCH_MIN_RATIO_PERCENT = 130;
export const LAUNCH_LIQUIDATION_RATIO_PERCENT = 110;

export interface RiskRatios {
	minRatio: number;
	liquidationRatio: number;
}

/** The live ratios when the vault has answered, otherwise the launch values. */
export function riskRatios(
	params: Pick<CollateralParams, 'minRatioPercent' | 'liquidationRatioPercent'>
): RiskRatios {
	return {
		minRatio: params.minRatioPercent ?? LAUNCH_MIN_RATIO_PERCENT,
		liquidationRatio: params.liquidationRatioPercent ?? LAUNCH_LIQUIDATION_RATIO_PERCENT,
	};
}

/**
 * A ratio's verdict on the governed bands of its collateral:
 * the badge, the gauge and the preview used to colour at a fixed 150% and 120%, so a vault
 * between the 130% minimum and 120% read as caution while it could no longer mint.
 */
export function healthStatus(ratioPercent: number | undefined, ratios: RiskRatios): RatioStatus {
	return ratioStatus(ratioPercent, {
		minRatioPercent: ratios.minRatio,
		liquidationRatioPercent: ratios.liquidationRatio,
	});
}

/** The text colour for each verdict. */
export const HEALTH_TEXT: Record<RatioStatus, string> = {
	healthy: 'text-success',
	warning: 'text-warning',
	danger: 'text-danger',
	liquidatable: 'text-danger',
	none: 'text-muted-foreground',
};
