import {
  BaseError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
  ExecutionRevertedError,
  RawContractError,
} from 'viem';
import { describeError, redactUrls } from './decode';

/**
 * Why an eth_call failed, in the three shapes a job must treat differently:
 *   - revert: the contract refused, and a transaction would be refused for the same
 *     reason ("Off gold band", "No reliable price", "Token frozen");
 *   - no-data: the address answered with nothing, so the deployed contract lacks the
 *     function (an oracle from before the final pricing rules) or is not a contract;
 *   - unreachable: the RPC itself failed, and nothing is known about the contract.
 */
export type CallFailure =
  | { kind: 'revert'; reason: string }
  | { kind: 'no-data'; detail: string }
  | { kind: 'unreachable'; detail: string };

const PLAIN_REVERT = /execution reverted(?::\s*(.+))?/i;
const PLAIN_NO_DATA = /returned no data/i;

const revertedReason = (error: ContractFunctionRevertedError): string => {
  if (error.reason !== undefined) return error.reason;
  if (error.data?.errorName !== undefined) return error.data.errorName;
  if (error.signature !== undefined) return `custom error ${error.signature}`;
  return error.shortMessage;
};

const classifyViemError = (error: BaseError): CallFailure => {
  if (error.walk((cause) => cause instanceof ContractFunctionZeroDataError) !== null) {
    return { kind: 'no-data', detail: redactUrls(error.shortMessage) };
  }
  const reverted = error.walk((cause) => cause instanceof ContractFunctionRevertedError);
  if (reverted instanceof ContractFunctionRevertedError) {
    return { kind: 'revert', reason: redactUrls(revertedReason(reverted)) };
  }
  const raw = error.walk(
    (cause) => cause instanceof ExecutionRevertedError || cause instanceof RawContractError
  );
  if (raw instanceof BaseError) {
    return { kind: 'revert', reason: redactUrls(raw.details || raw.shortMessage) };
  }
  return { kind: 'unreachable', detail: describeError(error) };
};

/**
 * Classifies a failed read. viem errors are walked to their cause; anything else (the
 * stub clients in specs, a wrapped transport error) is read from its message, where
 * "execution reverted" is the node's own wording for a revert.
 */
export const classifyCallError = (error: unknown): CallFailure => {
  if (error instanceof BaseError) {
    return classifyViemError(error);
  }
  const message = describeError(error);
  if (PLAIN_NO_DATA.test(message)) {
    return { kind: 'no-data', detail: message };
  }
  const match = PLAIN_REVERT.exec(message);
  if (match !== null) {
    return { kind: 'revert', reason: match[1]?.trim() || message };
  }
  return { kind: 'unreachable', detail: message };
};
