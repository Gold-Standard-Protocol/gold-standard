import { trpc } from '@goldstandard/trpc-react';

export interface GoldPrices {
  /** Live USD price of Paxos Gold (PAXG), one token ≈ one troy ounce. */
  paxg: number | undefined;
  /** Live USD price of Tether Gold (XAUT), one token ≈ one troy ounce. */
  xaut: number | undefined;
  isLoading: boolean;
  /** True when the price API did not answer; callers name the failure rather than show a dash. */
  isError: boolean;
}

/**
 * Live USD prices for the gold collateral assets, sourced from the price API
 * (CoinGecko upstream). Used by the marketing and transparency surfaces so that
 * every gold figure shown to a prospective depositor is real, not invented.
 */
export function useGoldPrices(): GoldPrices {
  const { data, isLoading, isError } = trpc.pricesRouter.prices.useQuery(
    { priceIds: ['pax-gold', 'tether-gold'] },
    {
      select: (d) => ({
        paxg: d['pax-gold']?.usd ? Number(d['pax-gold'].usd) : undefined,
        xaut: d['tether-gold']?.usd ? Number(d['tether-gold'].usd) : undefined,
      }),
      refetchInterval: 30_000,
    }
  );

  return {
    paxg: data?.paxg,
    xaut: data?.xaut,
    isLoading,
    isError,
  };
}
