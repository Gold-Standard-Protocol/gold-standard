import { describe, expect, it } from 'vitest';
import { riskRatios } from './riskDefaults';

describe('riskRatios', () => {
	// The forms computed with a 150% floor while the withdraw copy said 130%, and the
	// launch minimum is 130%: maths and copy must fall back to the same figure.
	it('falls back to the launch minimum of 130% and liquidation ratio of 110% while the read is missing', () => {
		expect(riskRatios({ minRatioPercent: undefined, liquidationRatioPercent: undefined })).toEqual({
			minRatio: 130,
			liquidationRatio: 110,
		});
	});

	it('uses the live parameters once the vault has answered', () => {
		expect(riskRatios({ minRatioPercent: 140, liquidationRatioPercent: 120 })).toEqual({
			minRatio: 140,
			liquidationRatio: 120,
		});
	});
});
