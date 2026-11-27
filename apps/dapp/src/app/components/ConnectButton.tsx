import { WalletIcon } from '@heroicons/react/20/solid';
import { useConnection } from 'wagmi';
import { Button, cn, type ButtonProps } from '@goldstandard/ui';
import { TARGET_CHAIN_ID } from '@goldstandard/constants';
import { shortAddress, useWalletUi } from '../wallet/WalletUi';

export type ConnectButtonProps = ButtonProps;

export const ConnectButton = (props: ConnectButtonProps) => {
  const connection = useConnection();
  const walletUi = useWalletUi();
  if (!connection.isConnected || !connection.address) {
    // Every connect goes through the wallet dialog, whose lock is walletUi.pending. Wagmi's
    // own "connecting" stays set while a cancelled prompt is still open in a browser
    // wallet, so it must not lock the button; reconnecting on page load still does.
    const pending = walletUi.pending || connection.isReconnecting;
    return (
      <Button {...props} data-wallet-control disabled={props.disabled || pending} loading={pending}
        onClick={() => walletUi.open('connect')}>
        <WalletIcon className="h-4 w-4" aria-hidden="true" />
        Connect<span className="hidden min-[380px]:inline">&nbsp;Wallet</span>
      </Button>
    );
  }
  if (!connection.chain) {
    return <Button {...props} data-wallet-control variant="destructive" onClick={() => walletUi.open('chain')}>Unsupported Network</Button>;
  }
  // A phone has no room for a separate network chip, so when the wallet is not on the
  // network the dapp targets, the account button names that network instead of the
  // address, with a warning dot. The account dialog offers the switch at every width.
  const offTarget = connection.chain.id !== TARGET_CHAIN_ID;
  return (
    <div className="flex items-center gap-2">
      <button onClick={() => walletUi.open('chain')} type="button"
        className="hidden min-h-11 items-center gap-2 rounded-md border border-border bg-card px-2.5 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-accent sm:flex">
        {connection.chain.name}
      </button>
      <Button {...props} data-wallet-control variant="outline" onClick={() => walletUi.open('account')}
        aria-label={`Wallet ${connection.address} on ${connection.chain.name}`}>
        <span aria-hidden="true" className={cn('mr-1.5 h-2 w-2 rounded-full', offTarget ? 'bg-warning' : 'bg-success')} />
        <span className={cn('font-mono text-[0.8rem]', offTarget && 'hidden sm:inline')}>{shortAddress(connection.address)}</span>
        {offTarget && <span className="text-sm sm:hidden">{connection.chain.name}</span>}
      </Button>
    </div>
  );
};
