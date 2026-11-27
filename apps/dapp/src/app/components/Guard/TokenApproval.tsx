import { type ApprovalFailure, ApprovalState, useTokenApproval } from "@goldstandard/hooks";
import { CurrencyAmount, Token } from "@goldstandard/models";
import { Button, ButtonProps } from "@goldstandard/ui";
import { type Address } from "viem";
import { describeTxError } from "../../lib/txError";

/** One sentence for why the last approval did not land. */
const describeFailure = (failure: ApprovalFailure, tokenSymbol: string | undefined): string | undefined => {
  if (failure.kind === "reverted") return "The approval failed on chain, so nothing was approved. Try again.";
  // The receipt wait could not read the chain: nothing is known, so this is not a failure.
  // The allowance is read again on a timer, and the next step appears once it lands.
  if (failure.kind === "unconfirmed") {
    return "Chain read failed, retrying. The approval was sent and may still go through, so check your wallet before approving again.";
  }
  return describeTxError(failure.error, { tokenSymbol });
};


export interface TokenApprovalProps extends ButtonProps {
  amount: CurrencyAmount<Token> | undefined;
  enabled: boolean;
  spender: Address | undefined;
  /**
   * Unlimited approvals are the default (see below) and are scoped to the protocol's
   * own contracts. A third-party spender such as the Uniswap router is outside that
   * accepted-risk envelope, so the market swap passes false and approves the exact
   * amount each time.
   */
  approveMax?: boolean;
  /**
   * One sentence on why an approval comes first and what follows it. A bare
   * "Approve PAXG" button with no explanation was the first thing a new user met.
   */
  explanation?: string;
}

export const TokenApproval = ({
  amount,
  enabled,
  spender,
  approveMax = true,
  explanation,
  fullWidth = true,
  size = "lg",
  children,
  ...props
}: TokenApprovalProps) => {
  const { approve, state: tokenApprovalState, isAwaitingWallet, isProposed, failure, isAllowanceUnread } = useTokenApproval({
    amount,
    spender,
    // Unlimited approvals are a ratified product decision (decided on
    // 10 June 2026): one approval per spender instead of one per transaction.
    // Accepted risk: a compromised spender contract could drain the approved
    // token balance. Spenders are this protocol's own contracts only, unless a caller opts out
    // for an external spender such as the DEX router. The line under the button
    // tells the user the approval is unlimited.
    approveMax,
    enabled,
  });

  if (!enabled || tokenApprovalState === ApprovalState.APPROVED) {
    return children;
  }

  const pending = tokenApprovalState === ApprovalState.PENDING;
  const symbol = amount?.currency?.symbol ?? "";
  const label = isAwaitingWallet
    ? "Waiting for your wallet"
    : pending
      ? `Approving ${symbol}`
      : `Approve ${symbol}`;
  // Hidden while a new attempt is in flight, so an old failure never sits under a live wait.
  const failureMessage =
    failure && !isAwaitingWallet && !pending ? describeFailure(failure, amount?.currency?.symbol) : undefined;
  return (
    <div className="flex flex-col gap-2">
      <Button
        onClick={() => approve?.()}
        fullWidth={fullWidth}
        // Loading also disables: the wallet already holds a request, and a second click
        // used to queue a second approval behind the first prompt.
        loading={tokenApprovalState === ApprovalState.LOADING || pending || isAwaitingWallet}
        disabled={!approve}
        {...props}
      >
        {label}
      </Button>
      {failureMessage && (
        <p role="alert" className="text-sm leading-relaxed text-destructive">
          {failureMessage}
        </p>
      )}
      {/* With no allowance there is nothing to approve against, so the button is disabled: say why. */}
      {isAllowanceUnread && (
        <p role="alert" className="text-sm leading-relaxed text-destructive">
          {symbol} allowance read failed, retrying.
        </p>
      )}
      {/* Inside Safe{Wallet} the approval waits on the owners, perhaps for days: the button stays live. */}
      {isProposed && !isAwaitingWallet && !pending && (
        <p role="status" className="text-sm leading-relaxed text-foreground">
          Approval of {symbol} proposed to your Safe. The next step appears once the owners have signed and it has
          executed.
        </p>
      )}
      {explanation && (
        <p className="text-xs leading-relaxed text-muted-foreground">
          {pending ? "Waiting for the approval to confirm. The next step appears as soon as it does." : explanation}
        </p>
      )}
      {/* Said wherever it is true: the default approval has no limit. */}
      {approveMax && (
        <p className="text-xs leading-relaxed text-muted-foreground">
          This approval is unlimited: the contract may move any amount of {symbol} from this wallet until you revoke
          it.
        </p>
      )}
    </div>
  );
};
