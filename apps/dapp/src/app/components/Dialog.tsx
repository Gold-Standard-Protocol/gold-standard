import type * as DialogPrimitive from '@radix-ui/react-dialog';
import { EXPLORER_BASE_URL, TARGET_CHAIN_ID } from '@goldstandard/constants';
import type { ConfirmationStatus } from '@goldstandard/hooks';
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Spinner,
} from '@goldstandard/ui';
import {
  createContext,
  Dispatch,
  FC,
  ReactNode,
  SetStateAction,
  useCallback,
  useContext,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';

enum DialogType {
  Review = 'REVIEW',
  Confirm = 'CONFIRM',
}

interface DialogReviewProps
  extends Omit<
    React.ComponentPropsWithoutRef<typeof DialogPrimitive.Root>,
    'children' | 'open' | 'onOpenChange'
  > {
  children: ({ showConfirmDialog }: { showConfirmDialog(): void }) => ReactNode;
  /**
   * False while the wallet holds a request: Escape and clicks outside are ignored, so a
   * late receipt never opens over whatever the user moved on to. Rejecting in the wallet
   * is the way to cancel.
   */
  dismissable?: boolean;
  /** The user closed the review without confirming: the moment to forget the attempt. */
  onDismiss?: () => void;
}

const DialogReview: FC<DialogReviewProps> = ({ children, dismissable = true, onDismiss, ...props }) => {
  const { showConfirmDialog, open, setOpen } = useDialog(DialogType.Review);
  const handleOpenChange = (next: boolean) => {
    if (!next && !dismissable) return;
    setOpen(next);
    if (!next) onDismiss?.();
  };
  return (
    <Dialog {...props} open={open} onOpenChange={handleOpenChange}>
      {children({ showConfirmDialog })}
    </Dialog>
  );
};
DialogReview.displayName = 'DialogReview';

/**
 * Said while the receipt wait cannot read the chain. Fixed wording: the caller's error
 * message describes a revert or a refusal, and neither is known to have happened.
 */
const UNCONFIRMED_MESSAGE =
  'Chain read failed, retrying. The transaction was sent and may still succeed. Check Etherscan before sending it again.';

/**
 * Said for a write made inside Safe{Wallet}. The Safe holds a proposal; the caller's success
 * and error messages describe a transaction, and there is none until the owners sign.
 */
const PROPOSED_MESSAGE = 'Nothing has changed on-chain yet. The transaction executes once the owners have signed.';

/**
 * Said when the wallet cancelled the transaction or sent another on its nonce. What was mined
 * is a self-send or some other call, so the caller's success message would describe an action
 * that never ran, and its error message a revert that never happened.
 */
const REPLACED_MESSAGE =
  'Your wallet cancelled this transaction or sent another in its place, so it was not carried out. The link opens the transaction mined instead.';

interface DialogConfirmProps
  extends Omit<
    React.ComponentPropsWithoutRef<typeof DialogPrimitive.Root>,
    'children' | 'open' | 'onOpenChange'
  > {
  closeButtonText: string;
  status: ConfirmationStatus;
  successMessage: ReactNode;
  txHash: string | undefined;
  /** Explorer link for txHash, when the chain is known. */
  explorerUrl?: string | undefined;
  /** Readable reason the transaction failed or was never sent. */
  errorMessage?: string | undefined;
  /** Called when the user closes a successful receipt or a proposal: the moment to clear the form. */
  onClosed?: () => void;
  /** Called whenever the receipt closes, whatever it showed: the moment to reset the write. */
  onDismissed?: () => void;
}

interface ConfirmView {
  status: ConfirmationStatus;
  txHash: string | undefined;
  errorMessage: string | undefined;
  successMessage: ReactNode;
}

const DialogConfirm: FC<DialogConfirmProps> = ({
  closeButtonText,
  status,
  successMessage,
  txHash,
  explorerUrl,
  errorMessage,
  onClosed,
  onDismissed,
  ...props
}) => {
  const { open, setOpen, restoreFocus } = useDialog(DialogType.Confirm);
  const headingId = useId();
  // Every build targets one chain, so the explorer is known even when a caller does not
  // pass one; a submitted hash should always be one click from Etherscan.
  const explorer = explorerUrl ?? EXPLORER_BASE_URL[TARGET_CHAIN_ID];
  // Closing the receipt resets the write, which would repaint a confirmed receipt as "Not
  // submitted" during its exit animation; the last view shown while open is kept instead.
  const lastOpenView = useRef<ConfirmView>({ status, txHash, errorMessage, successMessage });
  if (open) lastOpenView.current = { status, txHash, errorMessage, successMessage };
  const view = open ? { status, txHash, errorMessage, successMessage } : lastOpenView.current;

  const isSuccess = view.status === 'success';
  // `useWaitForTransactionReceipt` reports 'pending' whenever it has no hash to wait
  // on, which includes the case where the write never happened at all. Reporting that
  // as "Transaction submitted" told users their transaction was in flight when nothing
  // had been sent, and the dialog then sat there forever. A hash is the only proof a
  // transaction actually exists, so gate the wording on it.
  const isSubmitted = Boolean(view.txHash);
  const isPending = view.status === 'pending' && isSubmitted;
  // The wait could not read the chain, so nothing is known about the transaction. Saying
  // "reverted" here sent users to repeat a transaction that had in fact been mined.
  const isUnconfirmed = view.status === 'unconfirmed' && isSubmitted;
  // The Safe took the transaction as a proposal. Its owners may sign in a minute or in a
  // week, so this is a state to read and close, not a wait to sit through.
  const isProposed = view.status === 'proposed' && isSubmitted;
  // A cancel or a replacement from the wallet is final, and nothing reviewed here was done.
  const isReplaced = view.status === 'replaced' && isSubmitted;
  const isStalled = view.status !== 'success' && view.status !== 'error' && !isSubmitted;
  // The wait goes on in both states, so both keep the spinner.
  const isWaiting = isPending || isUnconfirmed;

  const title = isPending
    ? 'Waiting for confirmation'
    : isUnconfirmed
    ? 'Not confirmed yet'
    : isProposed
    ? 'Proposed to your Safe'
    : isReplaced
    ? 'Cancelled or replaced'
    : isSuccess
    ? 'Confirmed'
    : isStalled
    ? 'Not submitted'
    : 'Transaction failed';

  // Clearing the form while the review dialog is still animating out kept that dialog
  // mounted beside the receipt, so the form is cleared only once the receipt is closed.
  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) return;
    // A proposal clears the form too: the amount is with the Safe now, and a form left
    // filled invites a second proposal of the same transaction.
    if (isSuccess || isProposed) onClosed?.();
    onDismissed?.();
  };

  return (
    <Dialog {...props} open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        onCloseAutoFocus={(event) => {
          // The receipt has no trigger of its own, so Radix would leave focus on the page body.
          event.preventDefault();
          restoreFocus();
        }}
      >
        <DialogHeader>
          {/* One node for every state: a live region that is replaced rather than updated is not announced. */}
          <div role="status" aria-live="polite" aria-atomic="true" aria-labelledby={headingId} className="space-y-1.5">
            <div className={isWaiting ? 'flex items-center gap-2.5' : undefined}>
              {isWaiting && <Spinner className="h-[1.125rem] w-[1.125rem]" />}
              <DialogTitle>
                <span id={headingId}>{title}</span>
              </DialogTitle>
            </div>
            <DialogDescription>
              {isPending ? (
                'Transaction submitted. Waiting for it to be included in a block.'
              ) : isUnconfirmed ? (
                UNCONFIRMED_MESSAGE
              ) : isProposed ? (
                PROPOSED_MESSAGE
              ) : isReplaced ? (
                REPLACED_MESSAGE
              ) : isSuccess ? (
                <span>{view.successMessage}</span>
              ) : (
                <span>
                  {view.errorMessage ??
                    (isStalled
                      ? 'Your wallet did not send this transaction. It may have been rejected, or the protocol would not accept it.'
                      : 'The transaction was sent but reverted on-chain.')}
                </span>
              )}
            </DialogDescription>
          </div>
          {/* A proposal's hash is the Safe's own: no explorer knows it until the proposal executes. */}
          {view.txHash && !isProposed && (
            <a
              className="inline-flex items-center gap-1.5 text-sm font-medium text-primary underline underline-offset-4"
              href={`${explorer}/tx/${view.txHash}`}
              target="_blank"
              rel="noreferrer noopener"
            >
              View on Etherscan
              <span className="nums text-xs text-muted-foreground">
                {view.txHash.slice(0, 10)}…{view.txHash.slice(-6)}
              </span>
            </a>
          )}
          <DialogFooter>
            <DialogClose asChild>
              <Button fullWidth size="lg">
                {closeButtonText}
              </Button>
            </DialogClose>
          </DialogFooter>
        </DialogHeader>
      </DialogContent>
    </Dialog>
  );
};
DialogConfirm.displayName = 'DialogConfirm';

interface DialogProviderProps {
  children: ReactNode;
}

interface DialogContextValue {
  state: Record<DialogType, boolean>;
  showConfirmDialog(): void;
  setState: Dispatch<SetStateAction<Record<DialogType, boolean>>>;
  rememberFocus(): void;
  restoreFocus(): void;
}

interface ReturnFocus {
  trigger: HTMLElement | null;
  scope: Element | null;
}

// The panel that held the control, so a fallback never lands in another tab's form.
const FOCUS_SCOPE = '[role="tabpanel"], form, main';
const AMOUNT_FIELD = 'input:is([inputmode="decimal"], [inputmode="numeric"]):not(:disabled, [readonly])';
const MAIN_ID = 'main';

const captureFocus = (): ReturnFocus => {
  const active = document.activeElement;
  // Safari and Firefox on macOS do not focus a button on click, so this can be the body.
  const trigger = active instanceof HTMLElement && active !== document.body ? active : null;
  return { trigger, scope: trigger?.closest(FOCUS_SCOPE) ?? null };
};

const isUsable = (element: HTMLElement): boolean =>
  element.isConnected && !element.matches(':disabled') && element.getAttribute('aria-disabled') !== 'true';

// The form clears when a successful receipt closes, so the control that opened the review
// can be disabled or gone by now: fall back to the amount field, then to the page region.
const focusReturnTarget = (record: ReturnFocus | null): void => {
  if (record?.trigger && isUsable(record.trigger)) {
    record.trigger.focus();
    return;
  }
  const scope = record?.scope?.isConnected ? record.scope : document;
  const field = scope.querySelector<HTMLElement>(AMOUNT_FIELD);
  if (field) {
    field.focus();
    return;
  }
  const main = document.getElementById(MAIN_ID);
  if (!main) return;
  if (!main.hasAttribute('tabindex')) main.setAttribute('tabindex', '-1');
  main.focus();
};

const DialogContext = createContext<DialogContextValue | undefined>(undefined);

const DialogProvider: FC<DialogProviderProps> = ({ children }) => {
  const [state, setState] = useState<Record<DialogType, boolean>>({
    [DialogType.Review]: false,
    [DialogType.Confirm]: false,
  });

  const showConfirmDialog = useCallback(() => {
    setState({
      [DialogType.Review]: false,
      [DialogType.Confirm]: true,
    });
  }, []);

  const returnFocus = useRef<ReturnFocus | null>(null);
  const rememberFocus = useCallback(() => {
    returnFocus.current = captureFocus();
  }, []);
  const restoreFocus = useCallback(() => {
    const record = returnFocus.current;
    returnFocus.current = null;
    focusReturnTarget(record);
  }, []);

  return (
    <DialogContext.Provider value={{ state, showConfirmDialog, setState, rememberFocus, restoreFocus }}>
      {children}
    </DialogContext.Provider>
  );
};

type UseDialog<T> = T extends DialogType
  ? {
      open: boolean;
      setOpen(open: boolean): void;
      showConfirmDialog(): void;
      restoreFocus(): void;
    }
  : {
      open: boolean;
      setOpen(open: boolean): void;
      restoreFocus(): void;
    };

const useDialog = <T extends DialogType>(type: T): UseDialog<T> => {
  const context = useContext(DialogContext);

  if (!context) {
    throw new Error('useDialog must be used within a DialogProvider');
  }

  const { state, setState, showConfirmDialog, rememberFocus, restoreFocus } = context;

  return useMemo(() => {
    if (type === DialogType.Review) {
      return {
        open: Boolean(state[type]),
        setOpen: (val) => {
          if (val) rememberFocus();
          setState((prev) => ({ ...prev, [DialogType.Review]: val }));
        },
        showConfirmDialog,
        restoreFocus,
      } as UseDialog<T>;
    } else {
      return {
        open: Boolean(state[type]),
        setOpen: (val) =>
          setState((prev) => ({ ...prev, [DialogType.Confirm]: val })),
        restoreFocus,
      } as UseDialog<T>;
    }
  }, [type, state, showConfirmDialog, setState, rememberFocus, restoreFocus]);
};

export {
  DialogConfirm,
  DialogProvider,
  DialogReview,
  DialogContext,
  DialogType,
  useDialog,
};
