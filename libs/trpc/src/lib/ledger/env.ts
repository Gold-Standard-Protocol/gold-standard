import { getAddress, zeroAddress } from 'viem';
import type { Address } from 'viem';
import { loadLocalEnv } from '../config/loadEnv';
import { parseIndexerConfig } from '../indexer/config';
import { DEFAULT_MAX_ADDRESSES, MAX_MAX_ADDRESSES, MIN_MAX_ADDRESSES } from './limits';
import type { LiquidityConfig } from './liquidity';

// libs/trpc/.env first, as every module that reads the environment does.
loadLocalEnv();

export const DEFAULT_LEDGER_CONFIRMATIONS = 12;
const MIN_START_TIMESTAMP = 1_600_000_000;
const MAX_START_TIMESTAMP = 4_102_444_800;
const MAX_CONFIRMATIONS = 1_000;
const EVM_ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const WHOLE_NUMBER_PATTERN = /^\d+$/;

export interface LedgerConfig {
  rpcUrl: string;
  chainId: number;
  vault: Address;
  pool: Address;
  deployBlock: bigint;
  /** LEDGER_START_TIMESTAMP, unix seconds: usage before it is not recorded. */
  startTimestamp: number;
  /** Blocks behind the head the index stops at. */
  confirmations: number;
  /** INDEXER_MAX_BLOCK_RANGE, shared with the vault owner index: the widest eth_getLogs window asked for. */
  maxBlockRange?: bigint;
  /** LEDGER_MAX_ADDRESSES: the most address records the ledger opens; a memory guard. */
  maxAddresses: number;
  /**
   * LEDGER_LIQUIDITY_POOL_ADDRESS and LEDGER_LIQUIDITY_POSITION_MANAGER: the Uniswap v3 pool
   * whose positions are recorded and the position manager that holds them. Undefined while
   * the liquidity dimension is off.
   */
  liquidity?: LiquidityConfig;
}

export type LedgerConfigResult =
  | { ok: true; config: LedgerConfig }
  | { ok: false; reason: string }
  | { ok: false; disabled: true };

const present = (value: string | undefined): string | undefined =>
  value === undefined || value.trim() === '' ? undefined : value.trim();

const wholeNumber = (raw: string, min: number, max: number): number | undefined => {
  if (!WHOLE_NUMBER_PATTERN.test(raw)) return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= min && value <= max ? value : undefined;
};

const parseAddress = (raw: string | undefined): Address | undefined => {
  if (raw === undefined || !EVM_ADDRESS_PATTERN.test(raw)) return undefined;
  const address = getAddress(raw.toLowerCase());
  return address === zeroAddress ? undefined : address;
};

const LIQUIDITY_POOL_VARIABLE = 'LEDGER_LIQUIDITY_POOL_ADDRESS';
const LIQUIDITY_MANAGER_VARIABLE = 'LEDGER_LIQUIDITY_POSITION_MANAGER';

type LiquidityResult = { ok: true; liquidity: LiquidityConfig | undefined } | { ok: false; reason: string };

/**
 * The liquidity dimension is off when neither variable is set. One without the other, or a
 * value that is not an address, is refused: half a configuration would otherwise run the
 * ledger silently without the dimension the operator meant to turn on.
 */
const parseLiquidity = (env: Record<string, string | undefined>): LiquidityResult => {
  const rawPool = present(env[LIQUIDITY_POOL_VARIABLE]);
  const rawManager = present(env[LIQUIDITY_MANAGER_VARIABLE]);
  if (rawPool === undefined && rawManager === undefined) return { ok: true, liquidity: undefined };
  if (rawPool === undefined || rawManager === undefined) {
    const [set, missing] =
      rawPool === undefined
        ? [LIQUIDITY_MANAGER_VARIABLE, LIQUIDITY_POOL_VARIABLE]
        : [LIQUIDITY_POOL_VARIABLE, LIQUIDITY_MANAGER_VARIABLE];
    return {
      ok: false,
      reason: `${set} is set but ${missing} is not: the liquidity dimension needs both, or neither to stay off.`,
    };
  }
  const pool = parseAddress(rawPool);
  const positionManager = parseAddress(rawManager);
  if (pool === undefined || positionManager === undefined) {
    const bad = pool === undefined ? LIQUIDITY_POOL_VARIABLE : LIQUIDITY_MANAGER_VARIABLE;
    return { ok: false, reason: `${bad} must be a 20 byte hex address other than the zero address.` };
  }
  if (pool === positionManager) {
    return { ok: false, reason: `${LIQUIDITY_POOL_VARIABLE} and ${LIQUIDITY_MANAGER_VARIABLE} name the same address.` };
  }
  return { ok: true, liquidity: { pool, positionManager } };
};

/**
 * Pure parser so specs can pass explicit environment objects. The ledger is off, without
 * a reason, when LEDGER_START_TIMESTAMP is unset or blank. Once it is set, anything else
 * that is missing or malformed leaves the ledger dormant with a reason; it never throws,
 * so a bad value cannot stop the API from starting.
 */
export const parseLedgerConfig = (env: Record<string, string | undefined>): LedgerConfigResult => {
  const rawStart = present(env['LEDGER_START_TIMESTAMP']);
  if (rawStart === undefined) return { ok: false, disabled: true };
  const startTimestamp = wholeNumber(rawStart, MIN_START_TIMESTAMP, MAX_START_TIMESTAMP);
  if (startTimestamp === undefined) {
    return {
      ok: false,
      reason: `LEDGER_START_TIMESTAMP must be unix seconds between ${MIN_START_TIMESTAMP} and ${MAX_START_TIMESTAMP}.`,
    };
  }
  const pool = parseAddress(present(env['LEDGER_STABILITY_POOL_ADDRESS']));
  if (pool === undefined) {
    return {
      ok: false,
      reason: 'LEDGER_STABILITY_POOL_ADDRESS is required: a 20 byte hex address other than the zero address.',
    };
  }
  const rawConfirmations = present(env['LEDGER_CONFIRMATIONS']);
  const confirmations =
    rawConfirmations === undefined
      ? DEFAULT_LEDGER_CONFIRMATIONS
      : wholeNumber(rawConfirmations, 0, MAX_CONFIRMATIONS);
  if (confirmations === undefined) {
    return { ok: false, reason: `LEDGER_CONFIRMATIONS must be a whole number from 0 to ${MAX_CONFIRMATIONS}.` };
  }
  const rawMaxAddresses = present(env['LEDGER_MAX_ADDRESSES']);
  const maxAddresses =
    rawMaxAddresses === undefined ? DEFAULT_MAX_ADDRESSES : wholeNumber(rawMaxAddresses, MIN_MAX_ADDRESSES, MAX_MAX_ADDRESSES);
  if (maxAddresses === undefined) {
    return {
      ok: false,
      reason: `LEDGER_MAX_ADDRESSES must be a whole number from ${MIN_MAX_ADDRESSES} to ${MAX_MAX_ADDRESSES}.`,
    };
  }
  const liquidity = parseLiquidity(env);
  if (!liquidity.ok) return { ok: false, reason: liquidity.reason };
  const indexer = parseIndexerConfig(env);
  if (!indexer.ok) {
    return { ok: false, reason: `the indexer environment it reuses is not usable (${indexer.reason})` };
  }
  return {
    ok: true,
    config: {
      rpcUrl: indexer.config.rpcUrl,
      chainId: indexer.config.chainId,
      vault: indexer.config.goldVaultAddress,
      pool,
      deployBlock: indexer.config.deployBlock,
      startTimestamp,
      confirmations,
      maxAddresses,
      ...(indexer.config.maxBlockRange === undefined ? {} : { maxBlockRange: indexer.config.maxBlockRange }),
      ...(liquidity.liquidity === undefined ? {} : { liquidity: liquidity.liquidity }),
    },
  };
};

let cachedResult: LedgerConfigResult | undefined;

/**
 * Parses process.env once. Undefined when the ledger is off (silently) or dormant (the
 * reason is logged a single time), so the scheduler, the worker and the router can all
 * call this freely.
 */
export const getLedgerConfig = (): LedgerConfig | undefined => {
  if (cachedResult === undefined) {
    cachedResult = parseLedgerConfig(process.env);
    if (!cachedResult.ok && 'reason' in cachedResult) {
      console.error(`Usage ledger dormant: ${cachedResult.reason}`);
    }
  }
  return cachedResult.ok ? cachedResult.config : undefined;
};

/** True when this process keeps the usage ledger: its environment is set and usable. */
export const isLedgerOn = (): boolean => getLedgerConfig() !== undefined;

/** For specs: forget the memoised result. */
export const resetLedgerConfigForTests = (): void => {
  cachedResult = undefined;
};
