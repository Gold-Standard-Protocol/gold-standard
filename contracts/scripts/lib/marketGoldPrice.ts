/**
 * Resolve a testnet price argument: a USD figure, or "market" for the live PAXG/USD price
 * from CoinGecko (the same source apps/api uses), so the mock feeds can track real gold.
 * Returns the price in the feeds' 8-decimal convention. Testnet helpers only.
 */
import { ethers } from "hardhat";

const COINGECKO = "https://api.coingecko.com/api/v3/simple/price?ids=pax-gold&vs_currencies=usd";

export async function fetchMarketGoldPriceUsd(): Promise<string> {
  const res = await fetch(COINGECKO, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`CoinGecko answered ${res.status}`);
  const body = (await res.json()) as { "pax-gold"?: { usd?: number } };
  const usd = body["pax-gold"]?.usd;
  if (typeof usd !== "number" || !(usd > 0)) throw new Error("CoinGecko returned no pax-gold price");
  return usd.toFixed(2);
}

/** "market" -> live CoinGecko price; anything else is parsed as a USD figure. */
export async function resolvePriceUsd8(raw: string | undefined): Promise<bigint> {
  if (!raw) throw new Error("Set a price in USD, or \"market\" for the live PAXG price");
  const usd = raw.trim().toLowerCase() === "market" ? await fetchMarketGoldPriceUsd() : raw;
  const price = ethers.parseUnits(usd, 8);
  if (price <= 0n) throw new Error(`Bad price: ${raw}`);
  return price;
}
