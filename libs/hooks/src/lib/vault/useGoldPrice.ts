import { trpc } from '@goldstandard/trpc-react';

/**
 * Fetches the current USD price of PAXG (gold) via the price API.
 * Used for real-time simulation of vault position changes.
 */
export function useGoldPrice() {
	const { data, isLoading } = trpc.pricesRouter.prices.useQuery(
		{ priceIds: ['pax-gold'] },
		{
			select: (d) => {
				const raw = d['pax-gold']?.usd;
				return raw ? Number(raw) : undefined;
			},
			refetchInterval: 30_000,
		}
	);

	return { goldPrice: data, isLoading };
}
