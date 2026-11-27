import { erc20Abi, type Address } from "viem";
import { useReadContract } from "wagmi";
import { ChainId, CurrencyAmount, Token } from "@goldstandard/models";

interface UseTokenAllowanceParams {
  chainId: ChainId;
  token?: Token;
  owner: Address | undefined;
  spender: Address | undefined;
  enabled?: boolean;
  /**
   * Read the allowance again on a slow timer for as long as it is below this amount. For an
   * allowance that can arrive with nobody watching for it: inside Safe{Wallet} an approval
   * executes whenever the owners sign, perhaps after the form that proposed it was left.
   */
  pollWhileBelow?: bigint;
}

/** How often an awaited or unread allowance is read again. */
const AWAITED_ALLOWANCE_POLL_MS = 15_000;

/** The parts of the allowance query that decide whether it is read again. */
interface AllowanceReadState {
  status: "error" | "pending" | "success";
  data: bigint | undefined;
}

/**
 * When to read the allowance again: on a slow timer while it is short of an awaited amount,
 * and after a failed read. React Query gives up after its retries, and a failed read left the
 * approve simulation off and the Approve button dead until the window regained focus.
 */
export function allowancePollInterval(state: AllowanceReadState, pollWhileBelow: bigint | undefined): number | false {
  if (state.status === "error") return AWAITED_ALLOWANCE_POLL_MS;
  return pollWhileBelow !== undefined && (state.data === undefined || state.data < pollWhileBelow)
    ? AWAITED_ALLOWANCE_POLL_MS
    : false;
}

export const useTokenAllowance = ({
  chainId,
  token,
  owner,
  spender,
  enabled = true,
  pollWhileBelow,
}: UseTokenAllowanceParams) => {
  const result = useReadContract({
    chainId,
    address: (token?.address as Address) ?? undefined,
    abi: erc20Abi,
    functionName: "allowance",
    args: [owner as Address, spender as Address],
    query: {
      select: (data) => {
        if (token) {
          return CurrencyAmount.fromRawAmount(
            token,
            data.toString()
          );
        }
      },
      enabled: Boolean(chainId && token && owner && spender && enabled),
      refetchInterval: (query) => allowancePollInterval(query.state, pollWhileBelow),
    },
  });
  return result;
};
