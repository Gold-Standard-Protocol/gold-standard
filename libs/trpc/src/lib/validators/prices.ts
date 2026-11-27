import { z } from 'zod';

/** CoinGecko ids are lowercase slugs ("pax-gold"); the dapp asks for a handful per page. */
const PRICE_ID = /^[a-z0-9-]+$/;
const MAX_PRICE_ID_LENGTH = 64;
const MAX_PRICE_IDS = 50;

export const pricesSchema = z.object({
  priceIds: z.array(z.string().max(MAX_PRICE_ID_LENGTH).regex(PRICE_ID)).max(MAX_PRICE_IDS),
});

export type PricesInput = z.infer<typeof pricesSchema>;
