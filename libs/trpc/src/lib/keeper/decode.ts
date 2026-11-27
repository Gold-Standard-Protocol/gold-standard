import { getAddress, isAddress } from 'viem';
import type { Address } from 'viem';

// Runtime narrowing for KeeperReadClient results. readContract returns
// `unknown` by design (the DI seam erases viem's generics), so every job
// validates the decoded shape before acting on it: an ABI that drifts from
// the deployed contract then fails loudly inside the job's try/catch instead
// of silently corrupting a comparison.

export const expectBigInt = (value: unknown, label: string): bigint => {
  if (typeof value !== 'bigint') {
    throw new Error(`${label} did not decode to a bigint`);
  }
  return value;
};

export const expectBoolean = (value: unknown, label: string): boolean => {
  if (typeof value !== 'boolean') {
    throw new Error(`${label} did not decode to a boolean`);
  }
  return value;
};

export const expectAddress = (value: unknown, label: string): Address => {
  if (typeof value !== 'string' || !isAddress(value)) {
    throw new Error(`${label} did not decode to an address`);
  }
  return getAddress(value);
};

export const expectTuple = (
  value: unknown,
  minLength: number,
  label: string
): readonly unknown[] => {
  if (!Array.isArray(value) || value.length < minLength) {
    throw new Error(
      `${label} did not decode to a tuple of at least ${minLength} values`
    );
  }
  return value;
};

// URL redaction is shared with the indexer; every keeper module keeps importing it here.
export { describeError, redactUrls } from '../config/redact';
