import { describe, expect, it } from 'vitest';
import { collateralValuationPrice } from './useProtocolStats';

const E8 = 10n ** 8n;
const ok = (result: unknown) => ({ status: 'success' as const, result });
const failed = { status: 'failure' as const };

describe('collateralValuationPrice', () => {
	it('values holdings at quoteValuationPrice, the lower of market and gold, not the market feed alone', () => {
		// Market feed C at $4,100, gold G at $4,000: the protocol values PAXG at $4,000.
		expect(collateralValuationPrice(ok(4_000n * E8), ok([4_100n * E8, true]), ok(4_100n * E8))).toBe(4_000);
	});

	it('falls back to the validated feed when a stopped feed makes the valuation zero', () => {
		expect(collateralValuationPrice(ok(0n), ok([4_100n * E8, true]), ok(4_050n * E8))).toBe(4_100);
	});

	it('falls back to the last known price when neither answers', () => {
		expect(collateralValuationPrice(failed, ok([4_100n * E8, false]), ok(4_050n * E8))).toBe(4_050);
		expect(collateralValuationPrice(failed, failed, failed)).toBeUndefined();
	});
});
