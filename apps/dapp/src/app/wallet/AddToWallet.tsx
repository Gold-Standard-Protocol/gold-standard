import { useState } from 'react';
import { BaseError, UserRejectedRequestError, zeroAddress } from 'viem';
import { useConnection, useWatchAsset } from 'wagmi';
import { Button } from '@goldstandard/ui';
import { GSUSD_LOGO_URL, GSUSD_TOKEN, GUSD_ADDRESSES, TARGET_CHAIN_ID } from '@goldstandard/constants';

export interface AddTokenOutcome {
  /** `status` for what happened as asked, `alert` for what needs the reader to act. */
  role: 'status' | 'alert';
  text: string;
}

const declined = (error: unknown): boolean =>
  (error instanceof BaseError && error.walk((cause) => cause instanceof UserRejectedRequestError) !== null) ||
  (typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 4001);

/**
 * What to say after asking a wallet to list GSUSD. A wallet answers true once its owner
 * approves, false or a 4001 when they decline, and anything else means it has no such request
 * (WalletConnect sessions and some mobile wallets), where the address is the way in. Exported
 * for tests.
 */
export function addTokenOutcome(result: { added: boolean } | { error: unknown }, address: string): AddTokenOutcome {
  if ('added' in result) {
    return result.added
      ? { role: 'status', text: 'Your wallet now lists GSUSD.' }
      : { role: 'status', text: 'Not added. The request was declined in your wallet.' };
  }
  if (declined(result.error)) return { role: 'status', text: 'Not added. The request was declined in your wallet.' };
  return {
    role: 'alert',
    text: `This wallet cannot add a token from here. Add GSUSD in the wallet itself by its address: ${address}`,
  };
}

/**
 * Asks the connected wallet to list GSUSD, so the balance shows there without the holder
 * pasting an address. Shown only where it can work: a wallet on the network this build
 * targets, a deployed token, and not inside Safe{Wallet}, which lists a Safe's tokens itself.
 */
export function AddToWallet() {
  const connection = useConnection();
  const watchAsset = useWatchAsset();
  const [outcome, setOutcome] = useState<AddTokenOutcome>();
  const address = GUSD_ADDRESSES[TARGET_CHAIN_ID];

  if (!connection.isConnected || connection.chainId !== TARGET_CHAIN_ID) return null;
  if (!address || address === zeroAddress || connection.connector?.id === 'safe') return null;

  const add = () => {
    if (watchAsset.isPending) return;
    setOutcome(undefined);
    watchAsset
      .mutateAsync({
        type: 'ERC20',
        options: { address, symbol: GSUSD_TOKEN.symbol, decimals: GSUSD_TOKEN.decimals, image: GSUSD_LOGO_URL },
      })
      .then((added) => setOutcome(addTokenOutcome({ added }, address)))
      .catch((error: unknown) => setOutcome(addTokenOutcome({ error }, address)));
  };

  return (
    <>
      {/* aria-disabled, not disabled: a disabled button drops keyboard focus out of the dialog
          while the wallet is asked, and the outcome below would then be read from nowhere. */}
      <Button variant="outline" aria-disabled={watchAsset.isPending || undefined} onClick={add}
        className={watchAsset.isPending ? 'opacity-60' : undefined}>
        {watchAsset.isPending ? 'Waiting for your wallet…' : 'Add GSUSD to wallet'}
      </Button>
      {outcome && (
        // The address in the alert is one 42-character word: without wrapping anywhere it widens
        // the dialog past a phone screen.
        <p role={outcome.role} data-add-token-outcome
          className={`min-w-0 text-sm [overflow-wrap:anywhere] ${outcome.role === 'alert' ? 'text-destructive' : 'text-muted-foreground'}`}>
          {outcome.text}
        </p>
      )}
    </>
  );
}
