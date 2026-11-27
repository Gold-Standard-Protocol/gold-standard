// The indexer never asked its RPC
// endpoint which chain it serves, so an endpoint for another chain than INDEXER_CHAIN_ID was
// scanned and its answer stored under the configured chain's keys.
import { HttpRequestError } from 'viem';
import { createChainCheck } from './chainCheck';

describe('createChainCheck', () => {
  let consoleError: jest.SpyInstance;
  beforeEach(() => {
    consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    consoleError.mockRestore();
  });

  it('lets the run through once the endpoint serves the configured chain, and asks only once', async () => {
    const getChainId = jest.fn(async () => 11155111);
    const check = createChainCheck(getChainId, 11155111);

    await expect(check()).resolves.toBe(true);
    await expect(check()).resolves.toBe(true);
    expect(getChainId).toHaveBeenCalledTimes(1);
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('refuses every run while the endpoint serves another chain, naming both ids', async () => {
    const getChainId = jest.fn(async () => 1);
    const check = createChainCheck(getChainId, 11155111);

    await expect(check()).resolves.toBe(false);
    await expect(check()).resolves.toBe(false);
    expect(getChainId).toHaveBeenCalledTimes(2);
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('serves chain 1'));
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('INDEXER_CHAIN_ID is 11155111'));
  });

  it('skips a run whose check fails and asks again on the next one, without logging the RPC key', async () => {
    const getChainId = jest
      .fn<Promise<number>, []>()
      .mockRejectedValueOnce(
        new HttpRequestError({ url: 'https://rpc.example.org/v2/s3cretKey', status: 503, details: 'Service Unavailable' })
      )
      .mockResolvedValue(11155111);
    const check = createChainCheck(getChainId, 11155111);

    await expect(check()).resolves.toBe(false);
    await expect(check()).resolves.toBe(true);
    expect(getChainId).toHaveBeenCalledTimes(2);
    const printed = consoleError.mock.calls.flat().map(String).join(' ');
    expect(printed).toContain('Service Unavailable');
    expect(printed).not.toContain('s3cretKey');
  });

  it('names the vault owner index in its log lines by default and another job when given one', async () => {
    await createChainCheck(async () => 1, 11155111)();
    expect(consoleError).toHaveBeenLastCalledWith(expect.stringMatching(/^Vault owner indexing refused: /));

    await createChainCheck(async () => 1, 11155111, 'Usage ledger indexing')();
    expect(consoleError).toHaveBeenLastCalledWith(expect.stringMatching(/^Usage ledger indexing refused: /));

    await createChainCheck(async () => Promise.reject(new Error('offline')), 11155111, 'Usage ledger indexing')();
    expect(consoleError).toHaveBeenLastCalledWith(expect.stringMatching(/^Usage ledger indexing skipped: /), 'offline');
  });
});
