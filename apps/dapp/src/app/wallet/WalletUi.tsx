import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useChains, useConnect, useConnection, useConnectors, useDisconnect, useSwitchChain, type Connector } from 'wagmi';
import { QRCodeSVG } from 'qrcode.react';
import { Button, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@goldstandard/ui';
import { TARGET_CHAIN_ID } from '@goldstandard/constants';
import { isPairingUri } from './universalProvider';
import { AddToWallet } from './AddToWallet';

type Mode = 'connect' | 'account' | 'chain';

/** How long WalletConnect may take to produce a pairing link before the attempt is ended. */
export const PAIRING_LINK_TIMEOUT_MS = 15_000;
const WalletUiContext = createContext<{ open(mode: Mode): void; pending: boolean } | undefined>(undefined);

export function useWalletUi() {
  const context = useContext(WalletUiContext);
  if (!context) throw new Error('Wallet controls need WalletUiProvider.');
  return context;
}

export function shortAddress(address: string): string {
  return address.slice(0, 6) + '…' + address.slice(-4);
}

/** User-selected wallet app links; the pairing key is never sent to a discovery service. */
export function mobileWalletLinks(uri: string): Array<{ name: string; href: string }> {
  if (!isPairingUri(uri)) return [];
  const encoded = encodeURIComponent(uri);
  return [
    { name: 'Open MetaMask', href: 'https://metamask.app.link/wc?uri=' + encoded },
    { name: 'Open Rainbow', href: 'https://rnbwapp.com/wc?uri=' + encoded },
  ];
}

export function connectionError(error: unknown, network: string): string {
  const code = (error as { code?: number; cause?: { code?: number } })?.code
    ?? (error as { cause?: { code?: number } })?.cause?.code;
  if (code === 4001) return 'Connection cancelled in your wallet.';
  if (code === -32002) return 'A request is already open in your wallet. Close it there before trying again.';
  const reason = (error as { reason?: string; cause?: { reason?: string } })?.reason
    ?? (error as { cause?: { reason?: string } })?.cause?.reason;
  if (reason === 'network-not-approved') {
    return `Your wallet did not approve ${network}. Connect again and approve ${network}.`;
  }
  if (code === 4901) return 'Your wallet is on a network Gold Standard does not support. Switch network in your wallet, then try again.';
  if ((error as { name?: string })?.name === 'ProviderNotFoundError') {
    return 'No browser wallet was found in this browser. Install one, or choose another option above.';
  }
  return 'Could not connect. Check your wallet and try again.';
}

/** Wagmi names its generic EIP-1193 connector "Injected"; people call it a browser wallet. */
export function walletName(connector: Pick<Connector, 'name'> | undefined): string {
  if (!connector) return 'your wallet';
  return connector.name === 'Injected' ? 'Browser wallet' : connector.name;
}

function cancelConnector(connector: Connector | undefined): void {
  if (connector && typeof connector['cancelConnect'] === 'function') connector['cancelConnect']();
}

/** One shared modal and connection lock for every Connect button in the dapp. */
export function WalletUiProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<Mode | undefined>();
  const [pending, setPending] = useState(false);
  const [uri, setUri] = useState<string>();
  const [error, setError] = useState<string>();
  const [copied, setCopied] = useState(false);
  const [pairing, setPairing] = useState(false);
  const attempt = useRef(0);
  const inFlight = useRef(false);
  // Native prompts survive closing this dialog. Reusing that connector before its
  // old promise settles could let the old completion disconnect the new session.
  const unsettledConnectors = useRef(new Set<string>());
  const selected = useRef<Connector>();
  const cancelButton = useRef<HTMLButtonElement>(null);
  const connectorButtons = useRef(new Map<string, HTMLButtonElement>());
  const returnFocus = useRef<string>();
  // The dialog opens from shared context, not a Radix trigger, so Radix cannot know
  // where to return focus on close; remember the control that opened it.
  const opener = useRef<HTMLElement | null>(null);
  const openerScope = useRef<Element | null>(null);
  const openerRegion = useRef<Element | null>(null);
  const connectors = useConnectors();
  const chains = useChains();
  const connection = useConnection();
  const connect = useConnect();
  const disconnect = useDisconnect();
  const switchChain = useSwitchChain();
  const targetNetwork = chains.find((chain) => chain.id === TARGET_CHAIN_ID)?.name ?? 'the required network';

  // The chosen connector button disables while a request is open; keep keyboard focus
  // inside the dialog on the control that can end the request.
  // When it ends without connecting, focus returns to the wallet that was tried.
  useEffect(() => {
    if (pending) {
      cancelButton.current?.focus();
    } else if (returnFocus.current) {
      connectorButtons.current.get(returnFocus.current)?.focus();
      returnFocus.current = undefined;
    }
  }, [pending]);

  // A wrong project ID or an unreachable relay never yields a link; say so instead of
  // waiting forever. Cancelling makes the adapter reject, which ends the attempt.
  useEffect(() => {
    if (!pairing || uri) return;
    const timer = setTimeout(() => {
      returnFocus.current = selected.current?.uid;
      abandon();
      setError('WalletConnect did not respond. Check your connection and try again, or choose another option.');
    }, PAIRING_LINK_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [pairing, uri]);

  // Ends the open attempt and releases the lock at once. Only WalletConnect can withdraw
  // its request; a browser or Coinbase prompt stays open in the wallet, and if it is
  // approved later startConnection disconnects it again.
  const abandon = () => {
    attempt.current += 1;
    cancelConnector(selected.current);
    selected.current = undefined;
    inFlight.current = false;
    setPairing(false);
    setPending(false);
    setUri(undefined);
  };
  const close = () => {
    abandon();
    setError(undefined);
    setMode(undefined);
  };
  const startConnection = async (connector: Connector) => {
    if (inFlight.current) return;
    if (unsettledConnectors.current.has(connector.uid)) {
      setError(connectionError({ code: -32002 }, targetNetwork));
      return;
    }
    unsettledConnectors.current.add(connector.uid);
    inFlight.current = true;
    const current = ++attempt.current;
    selected.current = connector;
    setPending(true);
    setError(undefined);
    setUri(undefined);
    setCopied(false);
    setPairing(connector.id === 'walletConnect');
    const onMessage = (message: { type: string; data?: unknown }) => {
      if (current === attempt.current && message.type === 'display_uri') {
        setUri(isPairingUri(message.data) ? message.data : undefined);
      }
    };
    connector.emitter.on('message', onMessage);
    try {
      await connect.mutateAsync({ connector, chainId: TARGET_CHAIN_ID });
      if (current === attempt.current) {
        setMode(undefined);
        setUri(undefined);
      } else {
        // Approved in the wallet after the visitor cancelled here: do not keep it.
        void disconnect.mutateAsync({ connector }).catch(() => undefined);
      }
    } catch (failure) {
      if (current === attempt.current) {
        setError(connectionError(failure, targetNetwork));
        returnFocus.current = connector.uid;
      }
    } finally {
      unsettledConnectors.current.delete(connector.uid);
      connector.emitter.off('message', onMessage);
      // A superseded attempt leaves the lock and state to the attempt that replaced it.
      if (current === attempt.current) {
        selected.current = undefined;
        inFlight.current = false;
        setPairing(false);
        setPending(false);
      }
    }
  };
  const context = useMemo(() => ({
    open: (next: Mode) => {
      opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      openerScope.current = opener.current?.closest('[role="tabpanel"], form, header, main') ?? null;
      openerRegion.current = opener.current?.closest('header, main') ?? null;
      setError(undefined);
      setCopied(false);
      setMode(next);
    },
    pending,
  }), [pending]);
  const visibleConnectors = connectors.filter((connector) => {
    if (connector.id === 'safe') return typeof window !== 'undefined' && window.self !== window.top;
    return connector.id !== 'injected' || !connectors.some((other) => other.type === 'injected' && other.id !== 'injected');
  });

  return (
    <WalletUiContext.Provider value={context}>
      {children}
      <Dialog open={mode !== undefined} onOpenChange={(open) => { if (!open) close(); }}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto" onCloseAutoFocus={(event) => {
          // Connecting/disconnecting replaces the opener. Return to the updated wallet
          // control, or the amount field when Connect opened from a transaction form.
          event.preventDefault();
          const scope = openerScope.current?.isConnected ? openerScope.current
            : openerRegion.current?.isConnected ? openerRegion.current : document;
          let fallback = scope.querySelector<HTMLElement>('input:not(:disabled, [readonly]), [data-wallet-control]:not(:disabled)');
          // Account reads can temporarily disable every field. Keep focus in the
          // transaction page while it loads rather than sending it to the header.
          if (!fallback && openerRegion.current instanceof HTMLElement && openerRegion.current.matches('main')) {
            fallback = openerRegion.current;
            if (!fallback.hasAttribute('tabindex')) fallback.setAttribute('tabindex', '-1');
          }
          fallback ??= document.querySelector<HTMLElement>('[data-wallet-control]:not(:disabled)');
          const target = opener.current?.isConnected && !opener.current.matches(':disabled') ? opener.current : fallback;
          target?.focus();
          opener.current = null;
          openerScope.current = null;
          openerRegion.current = null;
        }}>
          <DialogHeader>
            <DialogTitle>{mode === 'connect' ? 'Connect wallet' : mode === 'chain' ? 'Choose network' : 'Your wallet'}</DialogTitle>
            <DialogDescription>
              {mode === 'connect' ? 'Choose an installed wallet or connect your mobile wallet.'
                : mode === 'chain' ? 'Select the network you want to use.'
                  : 'Manage your connection to Gold Standard.'}
            </DialogDescription>
          </DialogHeader>
          {mode === 'connect' && (
            <div className="grid gap-3">
              {visibleConnectors.map((connector) => (
                <Button key={connector.uid} variant="outline" fullWidth disabled={pending}
                  ref={(element) => {
                    if (element) connectorButtons.current.set(connector.uid, element);
                    else connectorButtons.current.delete(connector.uid);
                  }}
                  onClick={() => { void startConnection(connector); }}>
                  {walletName(connector)}
                  {connector.id === 'walletConnect' && <span className="text-xs text-muted-foreground">QR / mobile</span>}
                </Button>
              ))}
              {pending && <p role="status" className="text-sm text-muted-foreground">Waiting for your wallet…</p>}
              {/* Above the pairing panel, so the focused control stays in view on a phone. */}
              {pending && <Button ref={cancelButton} variant="ghost" onClick={close}>Cancel connection</Button>}
              {!connectors.some((connector) => connector.id === 'walletConnect') && (
                <p className="text-sm text-muted-foreground">Mobile QR connections are currently unavailable. Use a browser wallet or Coinbase Wallet.</p>
              )}
              {uri && (
                <div className="grid justify-items-center gap-3">
                  <div className="w-full max-w-64 rounded-xl bg-white p-4">
                    <QRCodeSVG value={uri} size={224} level="M" className="h-auto w-full" title="WalletConnect pairing code" />
                  </div>
                  <p className="text-center text-sm text-muted-foreground">Scan with your wallet, or open it on this device.</p>
                  <a className="inline-flex min-h-11 items-center text-sm text-primary underline underline-offset-4" href={uri}>Open wallet on this device</a>
                  <div className="flex flex-wrap justify-center gap-3">
                    {mobileWalletLinks(uri).map((wallet) => (
                      <a key={wallet.name} className="inline-flex min-h-11 items-center text-sm text-primary underline underline-offset-4"
                        href={wallet.href} rel="noreferrer" referrerPolicy="no-referrer">{wallet.name}</a>
                    ))}
                  </div>
                  <Button variant="outline" onClick={() => {
                    void navigator.clipboard.writeText(uri).then(() => setCopied(true))
                      .catch(() => setError('Could not copy the link. Scan the code using your wallet instead.'));
                  }}>{copied ? 'Copied' : 'Copy connection link'}</Button>
                </div>
              )}
            </div>
          )}
          {mode === 'chain' && (
            <div className="grid gap-3">
              {chains.map((chain) => (
                <Button key={chain.id} fullWidth variant="outline" disabled={switchChain.isPending}
                  onClick={() => {
                    setError(undefined);
                    void switchChain.mutateAsync({ chainId: chain.id }).then(() => setMode(undefined))
                      .catch(() => setError('Network change was not completed. Try again in your wallet.'));
                  }}>
                  {chain.name}{chain.id === connection.chainId ? ' (connected)' : ''}
                </Button>
              ))}
            </div>
          )}
          {mode === 'account' && (
            <div className="grid gap-3">
              <p className="break-all rounded-lg bg-accent p-3 font-mono text-sm">{connection.address}</p>
              <p className="text-sm text-muted-foreground">
                Connected with {walletName(connection.connector)} on {connection.chain?.name ?? 'an unsupported network'}.
              </p>
              <Button variant="outline" onClick={() => {
                if (connection.address) void navigator.clipboard.writeText(connection.address)
                  .then(() => setCopied(true)).catch(() => setError('Could not copy the address.'));
              }}>{copied ? 'Copied' : 'Copy address'}</Button>
              <AddToWallet />
              <Button variant="outline" onClick={() => { setError(undefined); setMode('chain'); }}>Change network</Button>
              <Button variant="outline" disabled={pending || disconnect.isPending} onClick={() => {
                // End the current connection first: a new wallet must never inherit it.
                setError(undefined);
                void disconnect.mutateAsync({ connector: connection.connector }).then(() => setMode('connect'))
                  .catch(() => setError('Could not disconnect the current wallet. Try again.'));
              }}>Change wallet</Button>
              <Button disabled={disconnect.isPending} onClick={() => {
                void disconnect.mutateAsync({ connector: connection.connector }).then(() => setMode(undefined))
                  .catch(() => setError('Could not disconnect. Try again.'));
              }}>Disconnect</Button>
            </div>
          )}
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        </DialogContent>
      </Dialog>
    </WalletUiContext.Provider>
  );
}
