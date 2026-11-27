import { fetchCachedPrices, type QuotedPriceRecord } from '../jobs/fetchPrices';
import { publicProcedure, router } from '../trpc';
import { pricesSchema } from '../validators/prices';

export const pricesRouter = router({
  prices: publicProcedure
    .input(pricesSchema)
    .query(async ({ input }): Promise<Record<string, QuotedPriceRecord>> => {
      return fetchCachedPrices(input.priceIds);
    }),
});
