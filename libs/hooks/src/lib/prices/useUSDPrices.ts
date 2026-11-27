import { Token } from '@goldstandard/models';
import { trpc } from '@goldstandard/trpc-react';

export function useUSDPrice({
  inputToken,
  outputToken,
}: {
  inputToken: Token | undefined;
  outputToken: Token | undefined;
}) {
  return trpc.pricesRouter.prices.useQuery(
    {
      priceIds: [inputToken?.priceApiId, outputToken?.priceApiId].filter(
        Boolean
      ) as string[],
    },
    {
      enabled: Boolean(inputToken && outputToken),
      select: (data) => ({
        inputTokenPrice: inputToken
          ? data[inputToken.priceApiId]?.usd ?? '0'
          : '0',
        outputTokenPrice: outputToken
          ? data[outputToken.priceApiId]?.usd ?? '0'
          : '0',
      }),
      refetchInterval: 30_000,
    }
  );
}
