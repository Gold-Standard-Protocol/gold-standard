import { useQuery } from "@tanstack/react-query";
import { readContracts } from "@wagmi/core";
import { useCallback } from "react";
import { erc20Abi, type Address } from "viem";
import { useAccount, useChainId, useConfig, type Config } from "wagmi";
import { ChainId, CurrencyAmount, Token } from "@goldstandard/models";
import { useAllTokens } from "../token";

interface QueryTokenBalanceParams {
  chainId: ChainId;
  tokens: Record<string, Token> | undefined;
  account: Address | undefined;
  config: Config;
}

const queryFn = async ({
  chainId,
  tokens,
  account,
  config,
}: QueryTokenBalanceParams) => {
  if (!account || !chainId || !tokens) {
    return {};
  }

  const tokenAddresses = Object.values(tokens).map((token) => token.address as Address);

  const data = await readContracts(config, {
    contracts: tokenAddresses.map(
      (address) =>
        ({
          abi: erc20Abi,
          address: address,
          functionName: "balanceOf",
          args: [account],
        } as const)
    ),
  });

  // A FAILED read is not a zero balance. Coercing `undefined` to 0n meant a
  // rate-limited or unreachable RPC rendered as "you hold nothing", which is
  // the most misleading thing this screen can say. Failures are skipped so the
  // entry stays absent and the UI can show an unknown state instead.
  const failed = data.filter((d) => d.status === "failure").length;
  if (failed > 0) {
    console.warn(
      `[token-balances] ${failed}/${data.length} balanceOf calls failed; ` +
        `those balances are reported as unknown, not zero. Check the RPC endpoint.`
    );
  }

  const processedData = data.reduce<Record<string, CurrencyAmount<Token>>>(
    (acc, result, index) => {
      if (data[index].status === "failure") {
        return acc;
      }
      const amount = data[index].result ?? BigInt(0);

      if (typeof amount === "bigint") {
        acc[tokenAddresses[index]] = CurrencyAmount.fromRawAmount(
          tokens[tokenAddresses[index]],
          amount.toString()
        );
      }

      return acc;
    },
    {}
  );

  return processedData;
};

interface UseTokenBalanceQueryParams<TData> {
  chainId: ChainId | undefined;
  select?: (data: Record<string, CurrencyAmount<Token>>) => TData;
  // tokens: (Token | undefined)[]
  account: Address | undefined;
  enabled?: boolean;
}

export const useTokenBalancesQuery = <
  TData = Record<string, CurrencyAmount<Token>>
>({
  select,
  account,
  enabled = true,
}: UseTokenBalanceQueryParams<TData>) => {
  const config = useConfig();
  const chainId = useChainId();
  const { data: allTokens } = useAllTokens(chainId);

  return useQuery({
    queryKey: ["useTokenBalances", { chainId, account }],
    queryFn: () =>
      queryFn({
        chainId,
        tokens: allTokens,
        account,
        config,
      }),
    select,
    refetchInterval: 10_000,
    enabled: Boolean(chainId && account && allTokens && enabled),
  });
};

export const useAllTokenBalances = () => {
  const account = useAccount();
  const chainId = useChainId();

  const { data } = useTokenBalancesQuery({
    chainId,
    account: account?.address,
  });

  return data;
};

export const useAllGoldTokenBalances = () => {
  const account = useAccount();
  const chainId = useChainId();

  const { data, isLoading } = useTokenBalancesQuery({
    chainId,
    select: (data) =>
      Object.fromEntries(
        Object.entries(data).filter(([_, value]) => value.currency?.gold)
      ),
    account: account?.address,
    enabled: true,
  });

  return { data, isLoading };
};

export const useTokenBalance = (token: Token | undefined) => {
  const account = useAccount();
  const chainId = useChainId();

  return useTokenBalancesQuery({
    select: useCallback(
      (data: Record<string, CurrencyAmount<Token>>) => {
        if (!token) {
          return undefined;
        }
        return data[token.address];
      },
      [token]
    ),
    chainId,
    // tokens: [token],
    account: account?.address,
    enabled: Boolean(token),
  });
};

export const useTokenBalances = ({
  tokens,
  enabled,
}: {
  tokens: (Token | undefined)[];
  enabled: boolean;
}) => {
  const account = useAccount();
  const chainId = useChainId();

  return useTokenBalancesQuery({
    select: useCallback(
      (data: Record<string, CurrencyAmount<Token>>) => {
        return Object.entries(data)
          .filter(([address]) =>
            tokens.some((token) => token?.address === address)
          )
          .reduce<Record<string, CurrencyAmount<Token>>>(
            (acc, [address, tokenAmount]) => {
              acc[address] = tokenAmount;
              return acc;
            },
            {}
          );
      },
      [tokens]
    ),
    chainId,
    account: account?.address,
    enabled,
  });
};
