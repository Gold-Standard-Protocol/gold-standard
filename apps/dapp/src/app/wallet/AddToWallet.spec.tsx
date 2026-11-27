import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UserRejectedRequestError } from 'viem';
import { AddToWallet, addTokenOutcome } from './AddToWallet';

const GSUSD = '0x24C3597eF975bdB565fd146f61438Ef14e15601D';
const LOGO = 'https://goldstandard.finance/brand/gsusd-256.png';

const state = vi.hoisted(() => ({
  connection: {} as Record<string, unknown>,
  watchAsset: vi.fn(),
  isPending: false,
  gsusd: '' as string,
}));
vi.mock('wagmi', () => ({
  useConnection: () => state.connection,
  useWatchAsset: () => ({ mutateAsync: state.watchAsset, isPending: state.isPending }),
}));
vi.mock('@goldstandard/constants', () => ({
  TARGET_CHAIN_ID: 1,
  GSUSD_TOKEN: { name: 'Gold Standard Dollar', symbol: 'GSUSD', decimals: 18 },
  GSUSD_LOGO_URL: 'https://goldstandard.finance/brand/gsusd-256.png',
  get GUSD_ADDRESSES() {
    return { 1: state.gsusd };
  },
}));

const button = () => screen.queryByRole('button', { name: 'Add GSUSD to wallet' });

beforeEach(() => {
  vi.clearAllMocks();
  state.connection = { isConnected: true, chainId: 1, connector: { id: 'io.metamask' } };
  state.isPending = false;
  state.gsusd = GSUSD;
  state.watchAsset.mockResolvedValue(true);
});
afterEach(cleanup);

describe('AddToWallet', () => {
  it('asks the wallet to list GSUSD with its address, symbol, decimals and logo', async () => {
    render(<AddToWallet />);
    fireEvent.click(button() as HTMLElement);
    expect(state.watchAsset).toHaveBeenCalledWith({
      type: 'ERC20',
      options: { address: GSUSD, symbol: 'GSUSD', decimals: 18, image: LOGO },
    });
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Your wallet now lists GSUSD.'));
  });

  it('says the request was declined, as a status and never as a failure', async () => {
    state.watchAsset.mockRejectedValue(new UserRejectedRequestError(new Error('User rejected the request.')));
    render(<AddToWallet />);
    fireEvent.click(button() as HTMLElement);
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Not added. The request was declined in your wallet.'));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('gives the address when the wallet has no such request', async () => {
    state.watchAsset.mockRejectedValue(Object.assign(new Error('Method not found'), { code: -32601 }));
    render(<AddToWallet />);
    fireEvent.click(button() as HTMLElement);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(
      `This wallet cannot add a token from here. Add GSUSD in the wallet itself by its address: ${GSUSD}`
    ));
    // The address must wrap inside a phone-width dialog.
    expect(screen.getByRole('alert').className).toContain('[overflow-wrap:anywhere]');
  });

  it('clears the last outcome when asked again', async () => {
    state.watchAsset.mockRejectedValueOnce(Object.assign(new Error('declined'), { code: 4001 }));
    render(<AddToWallet />);
    fireEvent.click(button() as HTMLElement);
    await screen.findByText('Not added. The request was declined in your wallet.');
    fireEvent.click(button() as HTMLElement);
    await screen.findByText('Your wallet now lists GSUSD.');
    expect(screen.queryByText('Not added. The request was declined in your wallet.')).toBeNull();
  });

  it('waits on the wallet without a second request, and keeps keyboard focus on the button', () => {
    state.isPending = true;
    render(<AddToWallet />);
    const waiting = screen.getByRole('button', { name: /Waiting for your wallet/ }) as HTMLButtonElement;
    // A disabled button would drop focus out of the dialog; this one stays focusable and inert.
    expect(waiting.disabled).toBe(false);
    expect(waiting.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(waiting);
    expect(state.watchAsset).not.toHaveBeenCalled();
  });

  it.each([
    ['no wallet is connected', () => { state.connection = { isConnected: false }; }],
    ['the wallet is on another network', () => { state.connection = { isConnected: true, chainId: 11155111, connector: { id: 'io.metamask' } }; }],
    ['the dapp runs inside Safe', () => { state.connection = { isConnected: true, chainId: 1, connector: { id: 'safe' } }; }],
    ['GSUSD is not deployed', () => { state.gsusd = '0x0000000000000000000000000000000000000000'; }],
  ])('is not offered when %s', (_case, arrange) => {
    arrange();
    render(<AddToWallet />);
    expect(button()).toBeNull();
  });
});

describe('addTokenOutcome', () => {
  it('reads a false answer as a declined request', () => {
    expect(addTokenOutcome({ added: false }, GSUSD)).toEqual({ role: 'status', text: 'Not added. The request was declined in your wallet.' });
  });
});
