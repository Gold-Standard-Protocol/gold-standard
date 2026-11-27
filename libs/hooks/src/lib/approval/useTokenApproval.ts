import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BaseError,
  type Hash,
  type SendTransactionReturnType,
  UserRejectedRequestError,
  type Address,
  erc20Abi,
} from "viem";
import {
  useAccount,
  useChainId,
  usePublicClient,
  useSimulateContract,
  useWriteContract,
} from "wagmi";
import { useQueryClient } from "@tanstack/react-query";
import { useTokenAllowance } from "./useTokenAllowance";
import { isSafeConnector } from "../tx/safeProposal";
import { useSafeProposal } from "../tx/useSafeProposal";
import { isRefreshedQuery } from "../tx/refreshFamilies";
import { scheduleConfirmationRefresh } from "../tx/refreshScheduler";
import { REFRESH_DELAYS_MS } from "../tx/scheduleRefreshes";
import { retrySimulationFailure } from "../tx/simulateQuery";
import { CurrencyAmount, Token } from "@goldstandard/models";
import { MaxUint256 } from "@goldstandard/utils";

export enum ApprovalState {
  LOADING = "LOADING",
  UNKNOWN = "UNKNOWN",
  NOT_APPROVED = "NOT_APPROVED",
  PENDING = "PENDING",
  APPROVED = "APPROVED",
}

/**
 * Why the last approval did not land. 'reverted' is a mined transaction that failed;
 * 'error' is anything the wallet or the RPC refused before or while it was sent;
 * 'unconfirmed' is a sent approval whose receipt the chain could not be read for, which
 * may still be mined. A user rejection is none of these: the user knows, and the button
 * simply returns.
 */
export type ApprovalFailure =
  | { kind: "reverted" }
  | { kind: "error"; error: Error }
  | { kind: "unconfirmed" };

/** The follow-up refreshes after an approval lands; the first one runs at once. */
const FOLLOW_UP_DELAYS_MS = REFRESH_DELAYS_MS.filter((ms) => ms > 0);

const isUserRejection = (error: Error): boolean =>
  error instanceof UserRejectedRequestError ||
  (error instanceof BaseError &&
    Boolean(error.walk((cause) => cause instanceof UserRejectedRequestError)));

/** An approval a Safe holds as a proposal, with what it would approve once executed. */
interface ProposedApproval {
  safeTxHash: Hash;
  token: string;
  spender: Address;
  /** The allowance the proposal sets: the exact amount, or the largest there is. */
  allowance: bigint;
}

type ApprovalRequest = Omit<ProposedApproval, "safeTxHash">;

interface UseTokenApprovalParams {
  amount: CurrencyAmount<Token> | undefined;
  approveMax?: boolean;
  spender: Address | undefined;
  enabled?: boolean;
}

export const useTokenApproval = ({
  amount,
  spender,
  enabled = true,
  approveMax,
}: UseTokenApprovalParams) => {
  const { address, connector } = useAccount();
  const chainId = useChainId();
  const [pending, setPending] = useState(false);
  // A sent approval with no receipt read for it yet: the allowance is read on a timer until it
  // lands, because the receipt wait can fail while the approval is still in the mempool.
  const [awaitsAllowance, setAwaitsAllowance] = useState(false);
  const [failure, setFailure] = useState<ApprovalFailure | undefined>(undefined);
  // Inside Safe{Wallet} an approval is a proposal the owners have yet to sign. The wallet
  // answers with the proposal's hash, which no chain node knows, so it is followed through
  // the Safe (safeProposal) and never waited on as a transaction.
  const proposes = isSafeConnector(connector);
  const [proposal, setProposal] = useState<ProposedApproval | undefined>(undefined);
  const execution = useSafeProposal({
    connector,
    safe: address,
    safeTxHash: proposes ? proposal?.safeTxHash : undefined,
  });
  const tokenAddress = amount?.currency?.wrapped?.address;
  const wanted = amount ? BigInt(amount.quotient.toString()) : undefined;
  // What the Approve button asks for now, kept at the click: the form can change before the
  // wallet answers, and a proposal can sit unsigned for days.
  const request = useMemo<ApprovalRequest | undefined>(
    () =>
      tokenAddress && spender && wanted !== undefined
        ? { token: tokenAddress, spender, allowance: approveMax ? BigInt(MaxUint256.toString()) : wanted }
        : undefined,
    [tokenAddress, spender, wanted, approveMax]
  );
  const requested = useRef<ApprovalRequest | undefined>(undefined);
  // A synchronous lock: two clicks inside one frame both saw isPending false and sent
  // two approvals. Released when the wallet answers, whichever way.
  const sending = useRef(false);
  const client = usePublicClient();
  const queryClient = useQueryClient();

  const {
    data: allowance,
    isLoading: isAllowanceLoading,
    isError: isAllowanceError,
    refetch,
  } = useTokenAllowance({
    token: amount?.currency,
    owner: address,
    spender,
    chainId: chainId,
    enabled: Boolean(amount?.currency?.isToken && enabled),
    // Inside a Safe the approval can execute with no proposal being followed here: the form
    // was left and reopened, or the approval was proposed in Safe{Wallet} itself.
    pollWhileBelow: proposes || awaitsAllowance ? wanted : undefined,
  });

  const { data: simulation, isLoading: isSimulationLoading } =
    useSimulateContract({
      query: {
        // Only while the allowance is short: an approval that is not needed is not checked.
        enabled: Boolean(
          amount && spender && address && allowance && allowance.lessThan(amount) && enabled
        ),
        retry: retrySimulationFailure,
      },
      chainId: amount?.currency.chainId,
      abi: erc20Abi,
      address: amount?.currency?.wrapped?.address as Address,
      functionName: "approve",
      args: [
        spender as Address,
        approveMax
          ? BigInt(MaxUint256.toString())
          : BigInt(amount?.quotient?.toString() ?? "0"),
      ],
    });

  // The reads a landed approval can change, now and on the schedule a confirmed transaction
  // uses. Every cached query used to be invalidated here, so the vault history scan, the
  // price feed and the token list all refetched for an allowance.
  // The follow-ups matter since a reverted simulation is no longer retried: a node still
  // behind the approval would otherwise leave ERC20InsufficientAllowance standing.
  const refreshAfterApproval = useCallback(async () => {
    const refresh = () => queryClient.invalidateQueries({ predicate: isRefreshedQuery });
    scheduleConfirmationRefresh(() => void refresh(), FOLLOW_UP_DELAYS_MS);
    await refresh();
  }, [queryClient]);

  const refreshAllowance = useCallback(async () => {
    await refetch();
    // Refetching the allowance is not enough. The action the user is trying to take
    // has its own useSimulateContract, which failed earlier with
    // ERC20InsufficientAllowance and is cached with that error. Without invalidating
    // it the button stays disabled behind a stale message until something else
    // happens to refetch, which is why approving then depositing appeared to fail
    // until the page was reloaded.
    await refreshAfterApproval();
  }, [refetch, refreshAfterApproval]);

  const onSuccess = useCallback(
    async (data: SendTransactionReturnType) => {
      if (!amount) return;
      // Waiting on a proposal's hash ran into viem's 180 seconds and reported a failure
      // under a live Approve button, for an approval the owners had simply not signed yet.
      if (proposes) {
        if (requested.current) setProposal({ safeTxHash: data, ...requested.current });
        return;
      }

      setPending(true);
      setAwaitsAllowance(true);
      try {
        // No deadline, as wagmi's own wait for every other transaction: viem's default of 180
        // seconds re-armed Approve under an error while a low-fee approval was still pending.
        const receipt = await client?.waitForTransactionReceipt({
          hash: data,
          timeout: 0,
        });
        setAwaitsAllowance(false);
        // viem resolves, rather than throws, for a receipt mined as reverted. Without
        // this check the button fell back to "Approve" with no word on what happened.
        if (receipt?.status === "reverted") {
          setFailure({ kind: "reverted" });
        }
        await refreshAllowance();
      } catch {
        // The wait could not read the chain. The approval may still be mined, so this is not
        // a failure, and the allowance read on its timer is what notices it landing.
        setFailure({ kind: "unconfirmed" });
      } finally {
        setPending(false);
      }
    },
    [client, amount, proposes, refreshAllowance]
  );

  // The Safe has executed the proposed approval: the same moment a receipt is for a wallet
  // that sends transactions.
  useEffect(() => {
    if (!proposal || !execution) return;
    setProposal(undefined);
    if (execution.failed) setFailure({ kind: "reverted" });
    refreshAllowance().catch((error: unknown) => {
      setFailure({
        kind: "error",
        error: error instanceof Error ? error : new Error(String(error)),
      });
    });
  }, [proposal, execution, refreshAllowance]);

  // A proposal belongs to the Safe that holds it: it is not asked about under another account.
  // A sent approval is awaited by its account only, and the line saying it was unconfirmed
  // goes with the await: nothing else could clear it, and another account sent nothing.
  useEffect(() => {
    setProposal(undefined);
    setAwaitsAllowance(false);
    setFailure((last) => (last?.kind === "unconfirmed" ? undefined : last));
  }, [address, chainId]);

  // An allowance that grew with no proposal or receipt followed for it (the slow read above
  // found it): the reads that failed for want of it are refreshed, as they are after a receipt.
  const allowanceWei = allowance ? BigInt(allowance.quotient.toString()) : undefined;
  const allowanceOf = `${tokenAddress ?? ""}:${spender ?? ""}`;
  const lastAllowance = useRef({ of: allowanceOf, wei: allowanceWei });
  useEffect(() => {
    const last = lastAllowance.current;
    lastAllowance.current = { of: allowanceOf, wei: allowanceWei };
    const watched = proposes || awaitsAllowance;
    if (!watched || last.of !== allowanceOf || last.wei === undefined || allowanceWei === undefined) return;
    if (allowanceWei > last.wei) void refreshAfterApproval();
  }, [proposes, awaitsAllowance, allowanceOf, allowanceWei, refreshAfterApproval]);

  // The approval whose receipt could not be read has landed: the timer stops, and the line
  // saying it was unconfirmed goes before a larger amount can show it under a new Approve.
  // Landed means it reached what was sent, not what the form asks for now: an exact approval
  // mined after the amount was raised kept the line, and the timer, until the page was left.
  useEffect(() => {
    if (!awaitsAllowance || pending || allowanceWei === undefined) return;
    const sent = requested.current;
    const sentHere = sent && `${sent.token}:${sent.spender}` === allowanceOf ? sent.allowance : undefined;
    const landsAt =
      sentHere === undefined ? wanted : wanted === undefined || sentHere < wanted ? sentHere : wanted;
    if (landsAt === undefined || allowanceWei < landsAt) return;
    setAwaitsAllowance(false);
    setFailure((last) => (last?.kind === "unconfirmed" ? undefined : last));
  }, [awaitsAllowance, pending, wanted, allowanceWei, allowanceOf]);

  const onError = useCallback((e: Error) => {
    if (!isUserRejection(e)) setFailure({ kind: "error", error: e });
  }, []);

  const execute = useWriteContract({
    mutation: {
      onError,
      onSuccess,
    },
  });

  // A reset on an account or chain change detaches the write, so onSettled never fires;
  // the wallet no longer holding the request is the other moment the lock must open.
  useEffect(() => {
    if (!execute.isPending) sending.current = false;
  }, [execute.isPending]);

  const approve = useMemo(() => {
    if (!execute.writeContract || !simulation?.request) return;

    return () => {
      if (sending.current) return;
      sending.current = true;
      setFailure(undefined);
      requested.current = request;
      execute.writeContract(simulation.request, {
        onSettled: () => {
          sending.current = false;
        },
      });
    };
  }, [execute, simulation?.request, request]);

  return useMemo(() => {
    let state = ApprovalState.UNKNOWN;

    if (allowance && amount && allowance.greaterThan(amount))
      state = ApprovalState.APPROVED;
    else if (allowance && amount && allowance.equalTo(amount))
      state = ApprovalState.APPROVED;
    else if (pending) state = ApprovalState.PENDING;
    else if (isAllowanceLoading || isSimulationLoading)
      state = ApprovalState.LOADING;
    else if (allowance && amount && allowance.lessThan(amount))
      state = ApprovalState.NOT_APPROVED;

    return {
      state,
      approve,
      /** The wallet holds the request: show the wait and ignore further clicks. */
      isAwaitingWallet: execute.isPending,
      /**
       * A Safe holds, as a proposal, an approval that covers what the button asks for now.
       * Nothing is approved until its owners sign, which can take days, so the button stays
       * live and the state is not PENDING. A proposal for another token, another spender or
       * a smaller exact amount is still followed, and is not reported here.
       */
      isProposed: Boolean(
        proposal &&
          request &&
          proposal.token === request.token &&
          proposal.spender === request.spender &&
          proposal.allowance >= (wanted ?? 0n)
      ),
      failure,
      /**
       * The allowance could not be read, so there is nothing to simulate an approval against
       * and the button is disabled; the read is retried on a timer (useTokenAllowance).
       */
      isAllowanceUnread: isAllowanceError && !allowance,
    };
  }, [
    allowance,
    amount,
    pending,
    isAllowanceLoading,
    isSimulationLoading,
    approve,
    execute.isPending,
    proposal,
    request,
    wanted,
    failure,
    isAllowanceError,
  ]);
};
