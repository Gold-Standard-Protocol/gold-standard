import { useTokenBalance } from '@goldstandard/hooks';
import { Token } from '@goldstandard/models';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Skeleton,
} from '@goldstandard/ui';

function TokenRow({
  token,
  onTokenSelected,
}: {
  token: Token;
  onTokenSelected: (token: Token) => void;
}) {
  const { data: amount, isLoading } = useTokenBalance(token);
  return (
    <button
      type="button"
      className="flex w-full items-center gap-3 rounded-lg border border-transparent px-2.5 py-2.5 text-left transition-colors hover:border-border hover:bg-accent"
      key={token.symbol}
      onClick={() => {
        onTokenSelected(token);
      }}
    >
      <img className="h-9 w-9 rounded-full" src={token.image} alt={token.name} />
      <div className="flex flex-1 flex-col">
        <span className="text-sm font-semibold text-foreground">{token.name}</span>
        <span className="text-xs text-muted-foreground">{token.symbol}</span>
      </div>
      <div className="text-right">
        {isLoading ? (
          <Skeleton className="h-5 w-[60px]" />
        ) : (
          <span className="nums text-sm font-medium text-foreground">
            {amount ? `${amount.toSignificant(6)} ${token.symbol}` : 'Balance unavailable'}
          </span>
        )}
      </div>
    </button>
  );
}

interface TokenSelectionDialogProps {
  description: string;
  onTokenSelected: (token: Token) => void;
  open: boolean;
  setOpen: (open: boolean) => void;
  title: string;
  tokens: {
    [key: string]: Token | undefined;
  } | undefined;
}

export function TokenSelectionDialog({
  open,
  setOpen,
  title,
  description,
  onTokenSelected,
  tokens,
}: TokenSelectionDialogProps) {
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {(() => {
          const available = tokens
            ? Object.entries(tokens).filter(([, t]) => Boolean(t))
            : [];
          // An empty dialog with only a close button is a dead end: pre-launch (and on
          // any unsupported chain) no token resolves, so the user opened this and was
          // told nothing at all. Always say why the list is empty.
          if (available.length === 0) {
            return (
              <p className="py-6 text-center text-sm text-muted-foreground">
                No collateral tokens are available on this network yet. Gold collateral
                becomes selectable once the protocol contracts are deployed.
              </p>
            );
          }
          return available.map(([k, t]) => (
            <TokenRow key={k} onTokenSelected={onTokenSelected} token={t as Token} />
          ));
        })()}
      </DialogContent>
    </Dialog>
  );
}
