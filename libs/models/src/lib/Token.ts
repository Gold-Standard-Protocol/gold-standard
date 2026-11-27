import { Token as UniswapToken } from "@uniswap/sdk-core";

export class Token extends UniswapToken {
  public readonly gold: boolean;
  public readonly image: string;
  public readonly priceApiId: string;

  public constructor({
    address,
    chainId,
    decimals,
    image,
    gold,
    priceApiId,
    symbol,
    name
  }: {
    chainId: number,
    address: string,
    decimals: number,
    image: string,
    gold: boolean,
    priceApiId: string,
    symbol?: string,
    name?: string,
  }) {
    super(chainId, address, decimals, symbol, name);
    this.image = image;
    this.gold = gold ?? false;
    this.priceApiId = priceApiId;
  }
}
