import {
  CallExecutionError,
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
  encodeErrorResult,
  HttpRequestError,
  parseAbi,
} from 'viem';
import { classifyCallError } from './callErrors';

const ABI = parseAbi([
  'function quoteTokenPrice(address token) view returns (uint256)',
  'error EnforcedPause()',
]);
const ORACLE = '0x0000000000000000000000000000000000000002';

const wrap = (cause: Error): ContractFunctionExecutionError =>
  new ContractFunctionExecutionError(cause as ContractFunctionRevertedError, {
    abi: ABI,
    functionName: 'quoteTokenPrice',
    args: [ORACLE],
    contractAddress: ORACLE,
  });

const requireRevert = (reason: string): ContractFunctionExecutionError =>
  wrap(
    new ContractFunctionRevertedError({
      abi: ABI,
      functionName: 'quoteTokenPrice',
      data: encodeErrorResult({
        abi: parseAbi(['error Error(string)']),
        errorName: 'Error',
        args: [reason],
      }),
    })
  );

describe('classifyCallError', () => {
  it.each(['Off gold band', 'No reliable price', 'No price', 'Token frozen'])(
    'reads the require reason %s out of a viem contract revert',
    (reason) => {
      expect(classifyCallError(requireRevert(reason))).toEqual({ kind: 'revert', reason });
    }
  );

  it('names a decoded custom error such as the pause', () => {
    const error = wrap(
      new ContractFunctionRevertedError({
        abi: ABI,
        functionName: 'quoteTokenPrice',
        data: encodeErrorResult({ abi: ABI, errorName: 'EnforcedPause' }),
      })
    );
    expect(classifyCallError(error)).toEqual({ kind: 'revert', reason: 'EnforcedPause' });
  });

  it('treats an HTTP failure as an unreachable RPC rather than a revert and redacts the URL', () => {
    const error = wrap(
      new CallExecutionError(
        new HttpRequestError({
          url: 'https://rpc.example.org/v3/secret-key',
          status: 503,
          details: 'Service Unavailable',
        }),
        {}
      )
    );
    const failure = classifyCallError(error);
    expect(failure.kind).toBe('unreachable');
    expect(JSON.stringify(failure)).not.toContain('secret-key');
  });

  it('reports a function the deployed oracle lacks as no data', () => {
    const error = wrap(new ContractFunctionZeroDataError({ functionName: 'quoteTokenPrice' }));
    expect(classifyCallError(error).kind).toBe('no-data');
  });

  it('reads the reason out of a plain execution reverted message', () => {
    expect(classifyCallError(new Error('execution reverted: No reliable price'))).toEqual({
      kind: 'revert',
      reason: 'No reliable price',
    });
  });

  it('treats a plain network error as unreachable', () => {
    expect(classifyCallError(new Error('fetch failed')).kind).toBe('unreachable');
    expect(classifyCallError('socket hang up').kind).toBe('unreachable');
  });
});
