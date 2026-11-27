import { describe, expect, it, vi } from 'vitest';
import {
  ABANDONED_LINK_WAIT_MS, DISCONNECT_WAIT_MS, UniversalWallet, isPairingUri, toProviderError, type WalletSession,
} from './universalProvider';
import { FakeUniversalProvider } from './fakeUniversalProvider';

const ACCOUNT = '0x0000000000000000000000000000000000000001';
const OTHER = '0x0000000000000000000000000000000000000002';
const URI = 'wc:' + '1'.repeat(64) + '@2?relay-protocol=irn&symKey=' + '2'.repeat(64);
const NOW = 1_800_000_000_000;
const BOTH = ['eip155:1:' + ACCOUNT, 'eip155:11155111:' + OTHER];

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function fixture(options: { remembered?: string; stored?: WalletSession[]; now?: () => number } = {}) {
  const now = options.now ?? (() => NOW);
  const sdk = new FakeUniversalProvider({ now, stored: options.stored });
  let remembered = options.remembered;
  const load = vi.fn(async (topic?: string) => sdk.init(topic));
  const remember = vi.fn(async (topic: string | undefined) => { remembered = topic; });
  const displayUri = vi.fn();
  const wallet = new UniversalWallet({
    chains: [1, 11155111],
    rpcMap: { '1': 'https://mainnet.example', '11155111': 'https://testnet.example' },
    load,
    rememberedTopic: async () => remembered,
    remember,
    displayUri,
    now,
  });
  const provider = wallet.provider();
  const events = { accountsChanged: vi.fn(), chainChanged: vi.fn(), disconnect: vi.fn() };
  provider.on('accountsChanged', events.accountsChanged);
  provider.on('chainChanged', events.chainChanged);
  provider.on('disconnect', events.disconnect);
  /** Starts a connect and waits until the wallet has the proposal. */
  const propose = async () => {
    const seen = sdk.proposals.length;
    const pending = wallet.connect();
    pending.catch(() => undefined);
    await vi.waitFor(() => expect(sdk.proposals.length).toBe(seen + 1));
    return { pending, proposal: sdk.proposals[seen] };
  };
  const connect = async (accounts = BOTH, topic?: string) => {
    const { pending, proposal } = await propose();
    proposal.approve({ accounts, topic });
    return pending;
  };
  return { wallet, sdk, provider, load, remember, displayUri, events, propose, connect, remembered: () => remembered };
}

const stored = (topic: string, accounts = BOTH, expiry = NOW / 1000 + 300): WalletSession =>
  ({ topic, expiry, namespaces: { eip155: { accounts } } });

describe('UniversalWallet connection', () => {
  it('does not load a client or contact a relay for an unremembered wallet', async () => {
    const f = fixture();
    expect(await f.wallet.restore()).toBe(false);
    expect(f.load).not.toHaveBeenCalled();
    expect(await f.provider.request({ method: 'eth_accounts' })).toEqual([]);
  });

  it('proposes every configured chain as optional and records the approved topic', async () => {
    const f = fixture();
    f.wallet.selectChain(11155111);
    expect(await f.connect(BOTH, 'mine')).toEqual([OTHER]);
    expect(f.sdk.proposals[0].optionalChains).toEqual(['eip155:1', 'eip155:11155111']);
    // Approved chains switch locally: the wallet is not asked.
    expect(f.sdk.walletRequests).toEqual([]);
    expect(f.wallet.chainId()).toBe(11155111);
    expect(f.remembered()).toBe('mine');
  });

  it('refuses and closes a session that lacks the required chain, whatever the proposal asked', async () => {
    const f = fixture();
    f.wallet.selectChain(11155111);
    await expect(f.connect(['eip155:1:' + ACCOUNT], 'mainnet-only'))
      .rejects.toMatchObject({ code: 4901, reason: 'network-not-approved' });
    // Refused before any prompt: the wallet is never asked to switch outside the session.
    expect(f.sdk.walletRequests).toEqual([]);
    expect(f.sdk.client.closed).toEqual(['mainnet-only']);
    expect(f.wallet.accounts()).toEqual([]);
    expect(f.remembered()).toBeUndefined();
  });

  it('never reuses a stored session on an explicit connect, such as an older dapp session', async () => {
    const f = fixture({ stored: [stored('rainbowkit-era', ['eip155:1:' + OTHER])] });
    const { pending, proposal } = await f.propose();
    expect(f.sdk.client.closed).toEqual(['rainbowkit-era']);
    expect(f.wallet.accounts()).toEqual([]);
    proposal.approve({ accounts: ['eip155:1:' + ACCOUNT], topic: 'fresh' });
    expect(await pending).toEqual([ACCOUNT]);
    expect(f.remembered()).toBe('fresh');
  });

  it('restores the remembered topic even when another session is stored first', async () => {
    const f = fixture({ remembered: 'mine', stored: [stored('orphan', ['eip155:1:' + OTHER]), stored('mine')] });
    expect(await f.wallet.restore()).toBe(true);
    expect(f.load).toHaveBeenCalledWith('mine');
    expect(f.wallet.accounts()).toEqual([ACCOUNT]);
    expect(f.sdk.proposals).toHaveLength(0);
  });

  it('does not restore when the remembered topic is no longer stored', async () => {
    const f = fixture({ remembered: 'gone', stored: [stored('late-approval')] });
    expect(await f.wallet.restore()).toBe(false);
    expect(f.wallet.accounts()).toEqual([]);
    expect(f.remembered()).toBeUndefined();
    // The next explicit connect loads afresh and works.
    expect(await f.connect(BOTH, 'new')).toEqual([ACCOUNT]);
  });

  it('clears an expired remembered session and refuses malformed accounts', async () => {
    const expired = fixture({ remembered: 'old', stored: [stored('old', BOTH, NOW / 1000 - 1)] });
    expect(await expired.wallet.restore()).toBe(false);
    expect(expired.remember).toHaveBeenCalledWith(undefined);
    const malformed = fixture({ remembered: 'bad', stored: [stored('bad', ['eip155:1:bad-address'])] });
    expect(await malformed.wallet.restore()).toBe(false);
  });

  it('connects again after expiry although closing the expired topic throws', async () => {
    const f = fixture({ stored: [stored('old', BOTH, NOW / 1000 - 1)] });
    f.sdk.init();
    f.sdk.client.sessions.delete('old');
    await expect(f.sdk.disconnect()).rejects.toThrow();
    expect(await f.connect(BOTH, 'renewed')).toEqual([ACCOUNT]);
  });

  it('maps a rejected proposal to 4001 and leaves no authorised account', async () => {
    const f = fixture();
    const { pending, proposal } = await f.propose();
    proposal.reject({ message: 'User rejected.', code: 5000 });
    await expect(pending).rejects.toMatchObject({ code: 4001 });
    expect(f.wallet.accounts()).toEqual([]);
    expect(f.remember).not.toHaveBeenCalledWith(expect.any(String));
  });

  it('closes the session and fails if recording it fails', async () => {
    const f = fixture();
    f.remember.mockImplementation(async (topic) => { if (topic) throw new Error('storage full'); });
    await expect(f.connect(BOTH, 'unrecorded')).rejects.toThrow('storage full');
    expect(f.wallet.accounts()).toEqual([]);
    expect(f.sdk.client.closed).toContain('unrecorded');
  });
});

describe('UniversalWallet cancellation and retry', () => {
  it('rejects a second simultaneous request but not a retry after cancelling', async () => {
    const f = fixture();
    const first = await f.propose();
    await expect(f.wallet.connect()).rejects.toMatchObject({ code: -32002 });
    f.wallet.cancel();
    await expect(first.pending).rejects.toMatchObject({ code: 4001 });
    // The retry starts at once, without waiting for the abandoned proposal to expire.
    const retry = await f.propose();
    retry.proposal.approve({ accounts: BOTH, topic: 'retry' });
    expect(await retry.pending).toEqual([ACCOUNT]);
  });

  it('deletes only the cancelled pairing and never delivers its late approval', async () => {
    const f = fixture();
    const { pending, proposal } = await f.propose();
    await vi.waitFor(() => expect(f.displayUri).toHaveBeenCalledWith(expect.stringMatching(/^wc:/)));
    f.wallet.cancel();
    await expect(pending).rejects.toMatchObject({ code: 4001 });
    expect(f.sdk.client.deletedPairings).toEqual([proposal.pairingTopic]);
    proposal.approve({ accounts: BOTH, topic: 'late' });
    expect(f.sdk.session).toBeUndefined();
    expect(f.wallet.accounts()).toEqual([]);
    expect(f.events.accountsChanged).not.toHaveBeenCalled();
    expect(f.displayUri).toHaveBeenLastCalledWith(undefined);
  });

  it('never shows an abandoned attempt\'s link for the retry that follows it', async () => {
    const f = fixture();
    const release = f.sdk.holdRelay();
    const first = f.wallet.connect();
    first.catch(() => undefined);
    await vi.waitFor(() => expect(f.load).toHaveBeenCalled());
    await tick();
    f.wallet.cancel(); // before the relay produced the first link
    await expect(first).rejects.toMatchObject({ code: 4001 });
    const retry = f.wallet.connect();
    retry.catch(() => undefined);
    release();
    await vi.waitFor(() => expect(f.sdk.proposals).toHaveLength(2));
    await vi.waitFor(() => expect(f.displayUri).toHaveBeenCalledWith(expect.stringMatching(/^wc:/)));
    const shown = f.displayUri.mock.calls.map(([uri]) => uri).filter((uri): uri is string => typeof uri === 'string');
    expect(shown).toHaveLength(1);
    expect(shown[0]).toContain(f.sdk.proposals[1].pairingTopic);
    expect(f.sdk.client.deletedPairings).toEqual([f.sdk.proposals[0].pairingTopic]);
    f.sdk.proposals[1].approve({ accounts: BOTH, topic: 'retry' });
    expect(await retry).toEqual([ACCOUNT]);
  });

  it('closes a late approval of an abandoned attempt without disturbing the retry', async () => {
    const f = fixture();
    const first = await f.propose();
    f.wallet.cancel();
    await expect(first.pending).rejects.toMatchObject({ code: 4001 });
    const retry = await f.propose();
    first.proposal.subscribed = true; // the relay delivers the old approval regardless
    first.proposal.approve({ accounts: BOTH, topic: 'late' });
    await vi.waitFor(() => expect(f.sdk.client.closed).toContain('late'));
    // Closed through SignClient alone: the provider's cleanup would expire the retry's pairing.
    expect(f.sdk.cleanups).toBe(0);
    expect(retry.proposal.subscribed).toBe(true);
    retry.proposal.approve({ accounts: BOTH, topic: 'retry' });
    expect(await retry.pending).toEqual([ACCOUNT]);
    expect(f.wallet.accounts()).toEqual([ACCOUNT]);
  });

  it('refuses a retry while an abandoned attempt never produces its link', async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      f.sdk.holdRelay();
      const first = f.wallet.connect();
      first.catch(() => undefined);
      await vi.advanceTimersByTimeAsync(0);
      f.wallet.cancel();
      await expect(first).rejects.toMatchObject({ code: 4001 });
      const retry = f.wallet.connect();
      retry.catch(() => undefined);
      await vi.advanceTimersByTimeAsync(ABANDONED_LINK_WAIT_MS);
      await expect(retry).rejects.toMatchObject({ code: -32002 });
      expect(f.displayUri).not.toHaveBeenCalledWith(expect.stringMatching(/^wc:/));
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not propose a session if cancelled while the SDK is loading', async () => {
    const f = fixture();
    const loading = deferred<FakeUniversalProvider>();
    f.load.mockReturnValueOnce(loading.promise);
    const pending = f.wallet.connect();
    f.wallet.cancel();
    await expect(pending).rejects.toMatchObject({ code: 4001 });
    loading.resolve(f.sdk);
    await tick();
    expect(f.sdk.proposals).toHaveLength(0);
  });

  it('does not propose a session if cancelled while an old session is being closed', async () => {
    const f = fixture({ stored: [stored('old')] });
    const closing = deferred<void>();
    const original = f.sdk.disconnect.bind(f.sdk);
    vi.spyOn(f.sdk, 'disconnect').mockImplementationOnce(async () => { await closing.promise; await original(); });
    const pending = f.wallet.connect();
    await vi.waitFor(() => expect(f.sdk.disconnect).toHaveBeenCalled());
    f.wallet.cancel();
    await expect(pending).rejects.toMatchObject({ code: 4001 });
    closing.resolve();
    await tick();
    expect(f.sdk.proposals).toHaveLength(0);
  });

  it('does not activate or remember an approval cancelled while it is being recorded', async () => {
    const f = fixture();
    const recording = deferred<void>();
    f.remember.mockImplementationOnce(async () => undefined); // the reset before proposing
    f.remember.mockImplementationOnce(async () => { await recording.promise; });
    const { pending, proposal } = await f.propose();
    proposal.approve({ accounts: BOTH, topic: 'approved' });
    await vi.waitFor(() => expect(f.remember).toHaveBeenCalledWith('approved'));
    f.wallet.cancel();
    await expect(pending).rejects.toMatchObject({ code: 4001 });
    recording.resolve();
    await vi.waitFor(() => expect(f.sdk.client.closed).toContain('approved'));
    expect(f.wallet.accounts()).toEqual([]);
  });

  it('ends the attempt when the pairing link is not a WalletConnect v2 URI', async () => {
    const f = fixture();
    const release = f.sdk.holdRelay();
    const pending = f.wallet.connect();
    pending.catch(() => undefined);
    await vi.waitFor(() => expect(f.load).toHaveBeenCalled());
    await tick();
    f.sdk.emitDisplayUri('https://phishing.example');
    await expect(pending).rejects.toMatchObject({ code: 4001 });
    expect(f.displayUri).not.toHaveBeenCalledWith('https://phishing.example');
    release();
  });
});

describe('UniversalWallet session lifecycle', () => {
  it('ends the connection when SignClient expires the session', async () => {
    const f = fixture();
    await f.connect(BOTH, 'live');
    f.sdk.expire('live');
    expect(f.events.disconnect).toHaveBeenCalledTimes(1);
    expect(f.wallet.accounts()).toEqual([]);
    expect(f.remembered()).toBeUndefined();
    await expect(f.provider.request({ method: 'personal_sign', params: ['0x00', ACCOUNT] })).rejects.toMatchObject({ code: 4900 });
  });

  it('follows a wallet extension of the session past its original expiry', async () => {
    let now = NOW;
    const f = fixture({ now: () => now });
    const { pending, proposal } = await f.propose();
    proposal.approve({ accounts: BOTH, topic: 'live', expiry: NOW / 1000 + 60 });
    await pending;
    f.sdk.walletExtends('live', NOW / 1000 + 3600);
    now = NOW + 120_000;
    await expect(f.provider.request({ method: 'personal_sign', params: ['0x00', ACCOUNT] })).resolves.toBe('signed');
    now = NOW + 3_601_000;
    await expect(f.provider.request({ method: 'personal_sign', params: ['0x00', ACCOUNT] })).rejects.toMatchObject({ code: 4900 });
  });

  it('forwards a wallet-side delete of its own session once and ignores other topics', async () => {
    const f = fixture();
    await f.connect(BOTH, 'live');
    f.sdk.walletDeletes('someone-else');
    expect(f.events.disconnect).not.toHaveBeenCalled();
    f.sdk.walletDeletes('live');
    expect(f.events.disconnect).toHaveBeenCalledTimes(1);
    expect(f.wallet.accounts()).toEqual([]);
    await f.wallet.disconnect();
    expect(f.remembered()).toBeUndefined();
  });

  it('disconnects locally even when the wallet session is already gone', async () => {
    const f = fixture();
    await f.connect(BOTH, 'live');
    f.sdk.client.sessions.delete('live');
    await expect(f.wallet.disconnect()).resolves.toBeUndefined();
    expect(f.wallet.accounts()).toEqual([]);
  });

  it('does not hold a disconnect on a relay that never acknowledges', async () => {
    const f = fixture();
    await f.connect(BOTH, 'live');
    vi.spyOn(f.sdk, 'disconnect').mockReturnValue(new Promise(() => undefined));
    vi.useFakeTimers();
    try {
      const done = f.wallet.disconnect();
      await vi.advanceTimersByTimeAsync(DISCONNECT_WAIT_MS);
      await expect(done).resolves.toBeUndefined();
      expect(f.wallet.accounts()).toEqual([]);
      expect(f.remembered()).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('follows wallet-selected accounts and closes the session when the wallet withdraws them all', async () => {
    const f = fixture();
    await f.connect([...BOTH, 'eip155:1:' + OTHER], 'live');
    f.sdk.walletEvent('live', 'eip155:1', 'accountsChanged', ['eip155:1:' + OTHER]);
    expect(f.wallet.accounts()).toEqual([OTHER]);
    f.sdk.walletEvent('live', 'eip155:1', 'accountsChanged', []);
    expect(f.wallet.accounts()).toEqual([]);
    await vi.waitFor(() => expect(f.sdk.client.closed).toContain('live'));
    await expect(f.provider.request({ method: 'personal_sign', params: ['0x00', OTHER] })).rejects.toMatchObject({ code: 4900 });
  });

  it('ignores an account the session never approved and events on another chain', async () => {
    const f = fixture();
    await f.connect(BOTH, 'live');
    f.sdk.walletEvent('live', 'eip155:1', 'accountsChanged', ['eip155:1:0x0000000000000000000000000000000000000009']);
    expect(f.wallet.accounts()).toEqual([]);
    const g = fixture();
    await g.connect(BOTH, 'live');
    g.sdk.walletEvent('live', 'eip155:11155111', 'accountsChanged', []);
    expect(g.wallet.accounts()).toEqual([ACCOUNT]);
  });

  it('removes revoked accounts when the wallet updates the session', async () => {
    const f = fixture();
    await f.connect(BOTH, 'live');
    f.sdk.walletUpdates('live', ['eip155:11155111:' + OTHER]);
    expect(f.wallet.accounts()).toEqual([]);
    await expect(f.provider.request({ method: 'personal_sign', params: ['0x00', ACCOUNT] })).rejects.toMatchObject({ code: 4900 });
  });

  it('keeps the connection on an unsupported wallet chain instead of reporting a disconnect', async () => {
    const f = fixture();
    await f.connect([...BOTH, 'eip155:31337:' + ACCOUNT], 'live');
    f.events.accountsChanged.mockClear();
    f.sdk.walletEvent('live', 'eip155:31337', 'chainChanged', 31337);
    expect(f.events.chainChanged).toHaveBeenLastCalledWith('0x7a69');
    // An empty accountsChanged would make Wagmi's injected connector disconnect.
    expect(f.events.accountsChanged).not.toHaveBeenCalled();
    expect(f.events.disconnect).not.toHaveBeenCalled();
    await expect(f.provider.request({ method: 'personal_sign', params: ['0x00', ACCOUNT] })).rejects.toMatchObject({ code: 4901 });
    await f.provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x1' }] });
    expect(f.wallet.accounts()).toEqual([ACCOUNT]);
    expect(f.events.accountsChanged).toHaveBeenLastCalledWith([ACCOUNT]);
  });
});

describe('UniversalWallet requests', () => {
  it('forwards signing and transactions in the approved active-chain namespace', async () => {
    const f = fixture();
    await f.connect(BOTH, 'live');
    const requests = [
      { method: 'eth_sendTransaction', params: [{ from: ACCOUNT, to: OTHER }] },
      { method: 'personal_sign', params: ['0x00', ACCOUNT] },
      { method: 'eth_signTypedData_v4', params: [ACCOUNT, '{}'] },
      { method: 'eth_estimateGas', params: [{ from: ACCOUNT, to: OTHER }] },
    ];
    for (const request of requests) await expect(f.provider.request(request as never)).resolves.toBe('signed');
    expect(f.sdk.walletRequests.map((entry) => entry.chain)).toEqual(['eip155:1', 'eip155:1', 'eip155:1', 'eip155:1']);
  });

  it('refuses to sign for an account or network the session did not approve', async () => {
    const f = fixture();
    await f.connect(BOTH, 'live');
    await expect(f.provider.request({ method: 'personal_sign', params: ['0x00', OTHER] })).rejects.toMatchObject({ code: 4100 });
    await expect(f.provider.request({ method: 'eth_signTypedData_v4', params: [OTHER, '{}'] })).rejects.toMatchObject({ code: 4100 });
    await expect(f.provider.request({ method: 'eth_sendTransaction', params: [{ from: OTHER }] } as never)).rejects.toMatchObject({ code: 4100 });
    await expect(f.provider.request({ method: 'eth_sendTransaction', params: [{ from: ACCOUNT, chainId: '0xaa36a7' }] } as never))
      .rejects.toMatchObject({ code: 4901 });
    await expect(f.provider.request({ method: 'personal_sign', params: { message: '0x00' } } as never))
      .rejects.toMatchObject({ code: -32602 });
    expect(f.sdk.walletRequests).toEqual([]);
  });

  it('refuses wallet methods that would bypass the signer checks', async () => {
    const f = fixture();
    await f.connect(BOTH, 'live');
    for (const method of ['wallet_sendTransaction', 'wallet_sendCalls', 'eth_sign', 'eth_signTransaction', 'eth_signTypedData', 'personal_ecRecover']) {
      await expect(f.provider.request({ method, params: [] } as never)).rejects.toMatchObject({ code: 4200 });
    }
    expect(f.sdk.walletRequests).toEqual([]);
  });

  it('maps a wallet refusal of a request to 4001', async () => {
    const f = fixture();
    await f.connect(BOTH, 'live');
    f.sdk.respond = () => { throw { message: 'User rejected.', code: 5000 }; };
    await expect(f.provider.request({ method: 'personal_sign', params: ['0x00', ACCOUNT] })).rejects.toMatchObject({ code: 4001 });
  });

  it('switches between approved chains locally and forwards both events', async () => {
    const f = fixture();
    await f.connect(BOTH, 'live');
    await f.provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0xaa36a7' }] });
    expect(f.events.chainChanged).toHaveBeenCalledWith('0xaa36a7');
    expect(f.events.accountsChanged).toHaveBeenLastCalledWith([OTHER]);
    expect(f.sdk.walletRequests).toEqual([]);
  });

  it('refuses a configured chain the session lacks without dropping the session', async () => {
    const f = fixture();
    await f.connect(['eip155:1:' + ACCOUNT], 'live');
    await expect(f.provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0xaa36a7' }] }))
      .rejects.toMatchObject({ code: 4901, reason: 'network-not-approved' });
    expect(f.wallet.accounts()).toEqual([ACCOUNT]);
    expect(f.wallet.chainId()).toBe(1);
  });

  it('rejects an unconfigured network before sending a switch request', async () => {
    const f = fixture();
    await f.connect(BOTH, 'live');
    await expect(f.provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x7a69' }] }))
      .rejects.toMatchObject({ code: 4901 });
    expect(f.sdk.walletRequests).toEqual([]);
  });
});

describe('provider errors and pairing links', () => {
  it('maps WalletConnect and message-only refusals to 4001 and leaves other errors alone', () => {
    expect(toProviderError({ code: 5000, message: 'User rejected.' })).toMatchObject({ code: 4001 });
    expect(toProviderError({ code: 5002, message: 'User rejected methods.' })).toMatchObject({ code: 4001 });
    expect(toProviderError(new Error('User denied transaction signature'))).toMatchObject({ code: 4001 });
    const other = { code: -32000, message: 'insufficient funds' };
    expect(toProviderError(other)).toBe(other);
    const disconnected = { code: 6000, message: 'User disconnected.' };
    expect(toProviderError(disconnected)).toBe(disconnected);
  });

  it('accepts only complete WalletConnect v2 links', () => {
    expect(isPairingUri(URI)).toBe(true);
    for (const value of [undefined, '', 'https://example.com', 'javascript:alert(1)', 'wc:bad@2', URI.replace('irn', 'unknown')]) {
      expect(isPairingUri(value)).toBe(false);
    }
  });
});
