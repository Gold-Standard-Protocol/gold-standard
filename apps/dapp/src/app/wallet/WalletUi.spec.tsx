import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mainnet, sepolia } from 'viem/chains';
import { ConnectButton } from '../components/ConnectButton';
import { PAIRING_LINK_TIMEOUT_MS, WalletUiProvider, mobileWalletLinks, walletName } from './WalletUi';

const state = vi.hoisted(() => ({
  connection: { address: undefined, isConnected: false, chain: undefined, chainId: undefined, connector: undefined } as Record<string, unknown>,
  connect: vi.fn(),
  disconnect: vi.fn(),
  switchChain: vi.fn(),
  connectors: [] as Array<Record<string, unknown>>,
}));
vi.mock('wagmi', () => ({
  useChains: () => [mainnet, sepolia],
  useConnectors: () => state.connectors,
  useConnection: () => state.connection,
  useConnect: () => ({ mutateAsync: state.connect }),
  useDisconnect: () => ({ mutateAsync: state.disconnect, isPending: false }),
  useSwitchChain: () => ({ mutateAsync: state.switchChain, isPending: false }),
}));
vi.mock('@goldstandard/constants', () => ({ TARGET_CHAIN_ID: 1 }));
// The control has its own spec (AddToWallet.spec.tsx); here only its place in the dialog is checked.
vi.mock('./AddToWallet', () => ({ AddToWallet: () => <button type="button">Add GSUSD to wallet</button> }));

const ADDRESS = '0x0000000000000000000000000000000000000001';
const URI = 'wc:' + '1'.repeat(64) + '@2?relay-protocol=irn&symKey=' + '2'.repeat(64);

function connector(id: string, name: string) {
  const handlers = new Set<(message: { type: string; data?: unknown }) => void>();
  return {
    id, uid: id, name, type: id === 'injected' || id.startsWith('io.') ? 'injected' : id,
    emitter: {
      on: vi.fn((_event: string, handler: (message: { type: string; data?: unknown }) => void) => { handlers.add(handler); }),
      off: vi.fn((_event: string, handler: (message: { type: string; data?: unknown }) => void) => { handlers.delete(handler); }),
    },
    cancelConnect: vi.fn(),
    message: (data: unknown) => { for (const handler of handlers) handler({ type: 'display_uri', data }); },
  };
}
function deferred() {
  let resolve!: (value: unknown) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function mount() {
  return render(<WalletUiProvider><ConnectButton /><ConnectButton /></WalletUiProvider>);
}
function openConnect() {
  fireEvent.click(screen.getAllByRole('button', { name: /Connect\s*Wallet/i })[0]);
}

beforeEach(() => {
  vi.clearAllMocks();
  state.connection = { isConnected: false };
  state.connectors = [connector('injected', 'Injected'), connector('coinbaseWallet', 'Coinbase Wallet'), connector('walletConnect', 'WalletConnect')];
  state.connect.mockResolvedValue({});
  state.disconnect.mockResolvedValue(undefined);
  state.switchChain.mockResolvedValue(mainnet);
});
afterEach(cleanup);

describe('wallet controls', () => {
  it('preserves browser, Coinbase and QR/mobile choices and connects on the selected chain', async () => {
    mount();
    openConnect();
    expect(screen.getByRole('button', { name: 'Browser wallet' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Coinbase Wallet' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /WalletConnect/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Coinbase Wallet' }));
    await waitFor(() => expect(state.connect).toHaveBeenCalledWith({ connector: state.connectors[1], chainId: 1 }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('locks duplicate connection clicks synchronously across shared controls', async () => {
    const pending = deferred();
    state.connect.mockReturnValue(pending.promise);
    mount();
    openConnect();
    const button = screen.getByRole('button', { name: 'Coinbase Wallet' });
    act(() => { fireEvent.click(button); fireEvent.click(button); });
    expect(state.connect).toHaveBeenCalledTimes(1);
    await act(async () => { pending.resolve({}); });
  });

  it('shows the pairing code and only validated, encoded mobile app links', async () => {
    const pending = deferred();
    state.connect.mockReturnValue(pending.promise);
    mount();
    openConnect();
    fireEvent.click(screen.getByRole('button', { name: /WalletConnect/ }));
    act(() => { (state.connectors[2] as ReturnType<typeof connector>).message(URI); });
    expect(screen.getByTitle('WalletConnect pairing code')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open MetaMask' }).getAttribute('href'))
      .toBe('https://metamask.app.link/wc?uri=' + encodeURIComponent(URI));
    act(() => { (state.connectors[2] as ReturnType<typeof connector>).message('javascript:bad'); });
    expect(screen.queryByTitle('WalletConnect pairing code')).toBeNull();
    await act(async () => { pending.resolve({}); });
  });

  it('clears pairing data and ignores completion after the modal is cancelled', async () => {
    const pending = deferred();
    state.connect.mockReturnValue(pending.promise);
    mount();
    openConnect();
    fireEvent.click(screen.getByRole('button', { name: /WalletConnect/ }));
    act(() => { (state.connectors[2] as ReturnType<typeof connector>).message(URI); });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel connection' }));
    expect((state.connectors[2] as ReturnType<typeof connector>).cancelConnect).toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
    await act(async () => { pending.resolve({}); });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect((state.connectors[2] as ReturnType<typeof connector>).emitter.off).toHaveBeenCalled();
  });

  it('reports a user rejection without exposing SDK internals', async () => {
    state.connect.mockRejectedValue(Object.assign(new Error('internal relay detail'), { code: 4001 }));
    mount();
    openConnect();
    fireEvent.click(screen.getByRole('button', { name: 'Coinbase Wallet' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Connection cancelled in your wallet.'));
  });

  it('offers network switching and disconnect for a connected account', async () => {
    state.connection = { address: ADDRESS, isConnected: true, chain: mainnet, chainId: 1, connector: state.connectors[1] };
    mount();
    fireEvent.click(screen.getAllByRole('button', { name: 'Ethereum' })[0]);
    fireEvent.click(screen.getByRole('button', { name: 'Sepolia' }));
    await waitFor(() => expect(state.switchChain).toHaveBeenCalledWith({ chainId: sepolia.id }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    fireEvent.click(screen.getAllByRole('button', { name: /0x0000/ })[0]);
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    await waitFor(() => expect(state.disconnect).toHaveBeenCalledWith({ connector: state.connectors[1] }));
  });

  it('names the network a wallet refused to approve', async () => {
    state.connect.mockRejectedValue(Object.assign(new Error('relay detail'), { code: 4901, reason: 'network-not-approved' }));
    mount();
    openConnect();
    fireEvent.click(screen.getByRole('button', { name: /WalletConnect/ }));
    await waitFor(() => expect(screen.getByRole('alert').textContent)
      .toBe('Your wallet did not approve Ethereum. Connect again and approve Ethereum.'));
  });

  it('says when no browser wallet exists and returns focus to the option tried', async () => {
    state.connect.mockRejectedValue(Object.assign(new Error('Provider not found.'), { name: 'ProviderNotFoundError' }));
    mount();
    openConnect();
    const browserWallet = screen.getByRole('button', { name: 'Browser wallet' });
    fireEvent.click(browserWallet);
    await waitFor(() => expect(screen.getByRole('alert').textContent)
      .toBe('No browser wallet was found in this browser. Install one, or choose another option above.'));
    await waitFor(() => expect(document.activeElement).toBe(browserWallet));
  });

  it('returns focus to the control that opened the dialog when it closes', async () => {
    mount();
    const opener = screen.getAllByRole('button', { name: /Connect\s*Wallet/i })[1];
    opener.focus();
    fireEvent.click(opener);
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it('ends a WalletConnect attempt that never produces a pairing link and says why', async () => {
    vi.useFakeTimers();
    try {
      const pending = deferred();
      state.connect.mockReturnValue(pending.promise);
      const walletConnect = state.connectors[2] as ReturnType<typeof connector>;
      walletConnect.cancelConnect.mockImplementation(() => pending.reject(Object.assign(new Error('cancelled'), { code: 4001 })));
      mount();
      openConnect();
      fireEvent.click(screen.getByRole('button', { name: /WalletConnect/ }));
      await act(async () => { vi.advanceTimersByTime(PAIRING_LINK_TIMEOUT_MS); });
      expect(walletConnect.cancelConnect).toHaveBeenCalled();
      expect(screen.getByRole('alert').textContent)
        .toBe('WalletConnect did not respond. Check your connection and try again, or choose another option.');
      expect(screen.queryByRole('status')).toBeNull();
      expect(document.activeElement).toBe(screen.getByRole('button', { name: /WalletConnect/ }));
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps waiting once a pairing link is shown', async () => {
    vi.useFakeTimers();
    try {
      const pending = deferred();
      state.connect.mockReturnValue(pending.promise);
      const walletConnect = state.connectors[2] as ReturnType<typeof connector>;
      mount();
      openConnect();
      fireEvent.click(screen.getByRole('button', { name: /WalletConnect/ }));
      act(() => { walletConnect.message(URI); });
      await act(async () => { vi.advanceTimersByTime(PAIRING_LINK_TIMEOUT_MS * 2); });
      expect(walletConnect.cancelConnect).not.toHaveBeenCalled();
      expect(screen.getByTitle('WalletConnect pairing code')).toBeTruthy();
      await act(async () => { pending.resolve({}); });
    } finally {
      vi.useRealTimers();
    }
  });

  it('tells a wallet on an unsupported network to switch rather than to approve', async () => {
    state.connect.mockRejectedValue(Object.assign(new Error('chain'), { code: 4901 }));
    mount();
    openConnect();
    fireEvent.click(screen.getByRole('button', { name: 'Browser wallet' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent)
      .toBe('Your wallet is on a network Gold Standard does not support. Switch network in your wallet, then try again.'));
  });

  it('releases the lock when a wallet that cannot withdraw its prompt is cancelled, and drops its late approval', async () => {
    const pending = deferred();
    state.connect.mockReturnValue(pending.promise);
    const coinbase = state.connectors[1] as Record<string, unknown>;
    delete coinbase['cancelConnect'];
    mount();
    openConnect();
    fireEvent.click(screen.getByRole('button', { name: 'Coinbase Wallet' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel connection' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const [header] = screen.getAllByRole('button', { name: /Connect\s*Wallet/i });
    expect((header as HTMLButtonElement).disabled).toBe(false);
    // The visitor can start again at once.
    fireEvent.click(header);
    expect(screen.getByRole('button', { name: 'Browser wallet' })).toBeTruthy();
    // The wallet approves the abandoned prompt later: it is disconnected, not kept.
    await act(async () => { pending.resolve({}); });
    await waitFor(() => expect(state.disconnect).toHaveBeenCalledWith({ connector: coinbase }));
  });

  it('does not start a second request for a wallet whose abandoned prompt is still open', async () => {
    const pending = deferred();
    state.connect.mockReturnValueOnce(pending.promise);
    mount();
    openConnect();
    fireEvent.click(screen.getByRole('button', { name: 'Browser wallet' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel connection' }));
    openConnect();
    fireEvent.click(screen.getByRole('button', { name: 'Browser wallet' }));
    expect(state.connect).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('alert').textContent).toContain('already open');
    // Other wallets remain available while that native prompt cannot be withdrawn.
    fireEvent.click(screen.getByRole('button', { name: 'Coinbase Wallet' }));
    await waitFor(() => expect(state.connect).toHaveBeenCalledTimes(2));
    await act(async () => { pending.resolve({}); });
    expect(state.disconnect).toHaveBeenCalledWith({ connector: state.connectors[0] });
  });

  it('returns keyboard focus to the replacement wallet control after connecting', async () => {
    state.connect.mockImplementation(async () => {
      state.connection = { address: ADDRESS, isConnected: true, chain: mainnet, chainId: 1, connector: state.connectors[0] };
      return {};
    });
    mount();
    const opener = screen.getAllByRole('button', { name: /Connect\s*Wallet/i })[0];
    opener.focus();
    fireEvent.click(opener);
    fireEvent.click(screen.getByRole('button', { name: 'Browser wallet' }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getAllByRole('button', { name: /^Wallet / })[0]));
  });

  it('returns keyboard focus to Connect when disconnect replaces the account control', async () => {
    state.connection = { address: ADDRESS, isConnected: true, chain: mainnet, chainId: 1, connector: state.connectors[0] };
    const view = mount();
    state.disconnect.mockImplementation(async () => {
      state.connection = { isConnected: false };
      // Simulate the Wagmi subscription updating the controls before closing.
      view.rerender(<WalletUiProvider><ConnectButton /><ConnectButton /></WalletUiProvider>);
    });
    const opener = screen.getAllByRole('button', { name: /^Wallet / })[0];
    opener.focus();
    fireEvent.click(opener);
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getAllByRole('button', { name: /Connect\s*Wallet/i })[0]));
  });

  it.each([false, true])('keeps focus in the transaction page when connecting replaces its tab panel (loading: %s)', async (loading) => {
    const content = (key: string) => <WalletUiProvider>
      <header><ConnectButton /></header>
      <main><div role="tabpanel" key={key}>
        <input aria-label="Deposit amount" disabled={loading} />
        {key === 'disconnected' ? <ConnectButton /> : <button disabled={loading}>Deposit</button>}
      </div></main>
    </WalletUiProvider>;
    const view = render(content('disconnected'));
    state.connect.mockImplementation(async () => {
      state.connection = { address: ADDRESS, isConnected: true, chain: mainnet, chainId: 1, connector: state.connectors[0] };
      view.rerender(content('connected'));
      return {};
    });
    const opener = screen.getAllByRole('button', { name: /Connect\s*Wallet/i })[1];
    opener.focus();
    fireEvent.click(opener);
    fireEvent.click(screen.getByRole('button', { name: 'Browser wallet' }));
    await waitFor(() => expect(document.activeElement).toBe(loading ? screen.getByRole('main') : screen.getByRole('textbox', { name: 'Deposit amount' })));
  });

  it('keeps Connect available while an abandoned prompt holds Wagmi in connecting, but not while reconnecting', () => {
    state.connection = { isConnected: false, isConnecting: true };
    const { unmount } = mount();
    expect((screen.getAllByRole('button', { name: /Connect\s*Wallet/i })[0] as HTMLButtonElement).disabled).toBe(false);
    unmount();
    state.connection = { isConnected: false, isReconnecting: true };
    mount();
    expect((screen.getAllByRole('button', { name: /Connect/i })[0] as HTMLButtonElement).disabled).toBe(true);
  });

  it('moves focus to Cancel while a connection is open', async () => {
    const pending = deferred();
    state.connect.mockReturnValue(pending.promise);
    mount();
    openConnect();
    fireEvent.click(screen.getByRole('button', { name: /WalletConnect/ }));
    await waitFor(() => expect(document.activeElement?.textContent).toBe('Cancel connection'));
    await act(async () => { pending.resolve({}); });
  });

  it('ends the current connection before offering another wallet', async () => {
    const order: string[] = [];
    state.disconnect.mockImplementation(async () => { order.push('disconnect'); });
    state.connection = { address: ADDRESS, isConnected: true, chain: mainnet, chainId: 1, connector: state.connectors[2] };
    mount();
    fireEvent.click(screen.getAllByRole('button', { name: /0x0000/ })[0]);
    fireEvent.click(screen.getByRole('button', { name: 'Change wallet' }));
    await waitFor(() => expect(state.disconnect).toHaveBeenCalledWith({ connector: state.connectors[2] }));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Connect wallet' })).toBeTruthy());
    expect(order).toEqual(['disconnect']);
  });

  it('names an off-target network in the account button and offers the switch', () => {
    state.connection = { address: ADDRESS, isConnected: true, chain: sepolia, chainId: sepolia.id, connector: state.connectors[1] };
    mount();
    const [account] = screen.getAllByRole('button', { name: `Wallet ${ADDRESS} on Sepolia` });
    expect(account.textContent).toContain('Sepolia');
    expect(account.querySelector('.bg-warning')).toBeTruthy();
    fireEvent.click(account);
    fireEvent.click(screen.getByRole('button', { name: 'Change network' }));
    expect(screen.getByRole('heading', { name: 'Choose network' })).toBeTruthy();
  });

  it('shows the address and a success dot on the target network', () => {
    state.connection = { address: ADDRESS, isConnected: true, chain: mainnet, chainId: 1, connector: state.connectors[1] };
    mount();
    const [account] = screen.getAllByRole('button', { name: `Wallet ${ADDRESS} on Ethereum` });
    expect(account.textContent).toContain('0x0000…0001');
    expect(account.textContent).not.toContain('Ethereum');
    expect(account.querySelector('.bg-success')).toBeTruthy();
  });

  it('offers adding GSUSD to the wallet in the account dialog, between the address and the connection controls', () => {
    state.connection = { address: ADDRESS, isConnected: true, chain: mainnet, chainId: 1, connector: state.connectors[1] };
    mount();
    fireEvent.click(screen.getAllByRole('button', { name: `Wallet ${ADDRESS} on Ethereum` })[0]);
    const names = within(screen.getByRole('dialog')).getAllByRole('button').map((button) => button.textContent);
    expect(names.slice(0, 5)).toEqual(['Copy address', 'Add GSUSD to wallet', 'Change network', 'Change wallet', 'Disconnect']);
  });

  it('prefers discovered browser wallets to the generic injected fallback', () => {
    state.connectors.push(connector('io.metamask', 'MetaMask'));
    mount();
    openConnect();
    expect(screen.getByRole('button', { name: 'MetaMask' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Browser wallet' })).toBeNull();
  });
});

it('never creates external wallet app links from an arbitrary URI', () => {
  expect(mobileWalletLinks('https://example.com')).toEqual([]);
  expect(mobileWalletLinks(URI)).toHaveLength(2);
});

it('names the generic injected connector as a browser wallet everywhere', () => {
  expect(walletName({ name: 'Injected' })).toBe('Browser wallet');
  expect(walletName({ name: 'Coinbase Wallet' })).toBe('Coinbase Wallet');
  expect(walletName(undefined)).toBe('your wallet');
});
