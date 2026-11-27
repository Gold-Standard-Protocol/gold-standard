import { getAddress, isAddress } from 'viem';
import type { Address } from 'viem';

export interface WatcherConfig {
  rpcUrls: readonly string[];
  deploymentFile: string;
  stateFile: string;
  dryRun: boolean;
  /** Absent only in a dry run. */
  telegram: { botToken: string; chatId: string } | undefined;
  pollSeconds: number;
  vaultOwners: readonly Address[];
  vaultRatioFloor: bigint;
  reserveCoverageFloor: bigint;
  repeatSeconds: number;
  heartbeatUrl: string | undefined;
}

type Env = Readonly<Record<string, string | undefined>>;

const text = (env: Env, name: string): string | undefined => {
  const value = env[name]?.trim();
  return value === undefined || value === '' ? undefined : value;
};

const required = (env: Env, name: string): string => {
  const value = text(env, name);
  if (value === undefined) throw new Error(`${name} is not set`);
  return value;
};

const wholeNumber = (env: Env, name: string, fallback: number, minimum: number): number => {
  const value = text(env, name);
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value) || Number(value) < minimum || !Number.isSafeInteger(Number(value)))
    throw new Error(`${name} must be a whole number of at least ${minimum}`);
  return Number(value);
};

/** An https URL with no user name or password. The message never repeats the value. */
const httpsUrl = (name: string, value: string): string => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} holds a value that is not a URL`);
  }
  if (url.protocol !== 'https:') throw new Error(`${name} must be an https URL`);
  if (url.username !== '' || url.password !== '') throw new Error(`${name} must carry no user name or password`);
  return value;
};

export const DEFAULT_VAULT_RATIO_FLOOR = 1_250_000;
export const DEFAULT_RESERVE_COVERAGE_FLOOR = 50_000;

/** Reads the watcher's whole configuration from the environment, refusing anything unclear. */
export const parseWatcherConfig = (env: Env): WatcherConfig => {
  const rpcUrls = required(env, 'WATCHER_RPC_URL')
    .split(',')
    .map((url) => url.trim())
    .filter((url) => url !== '')
    .map((url) => httpsUrl('WATCHER_RPC_URL', url));
  if (rpcUrls.length === 0) throw new Error('WATCHER_RPC_URL is not set');

  const dryRunText = text(env, 'WATCHER_DRY_RUN') ?? 'false';
  if (dryRunText !== 'true' && dryRunText !== 'false') throw new Error('WATCHER_DRY_RUN must be true or false');
  const dryRun = dryRunText === 'true';

  const botToken = text(env, 'TELEGRAM_BOT_TOKEN');
  const chatId = text(env, 'TELEGRAM_CHAT_ID');
  if (!dryRun && (botToken === undefined || chatId === undefined))
    throw new Error('TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must both be set unless WATCHER_DRY_RUN is true');
  if (botToken !== undefined && !/^\d+:[A-Za-z0-9_-]+$/.test(botToken))
    throw new Error('TELEGRAM_BOT_TOKEN does not have the shape of a bot token');
  if (chatId !== undefined && !/^-?\d+$/.test(chatId)) throw new Error('TELEGRAM_CHAT_ID must be a number');

  const vaultOwners = (text(env, 'WATCHER_VAULT_OWNERS') ?? '')
    .split(',')
    .map((owner) => owner.trim())
    .filter((owner) => owner !== '')
    .map((owner) => {
      if (!isAddress(owner)) throw new Error(`WATCHER_VAULT_OWNERS holds a value that is not an address: ${owner}`);
      return getAddress(owner);
    });

  const heartbeat = text(env, 'WATCHER_HEARTBEAT_URL');

  return {
    rpcUrls,
    deploymentFile: required(env, 'WATCHER_DEPLOYMENT_FILE'),
    stateFile: required(env, 'WATCHER_STATE_FILE'),
    dryRun,
    telegram: botToken !== undefined && chatId !== undefined ? { botToken, chatId } : undefined,
    pollSeconds: wholeNumber(env, 'WATCHER_POLL_SECONDS', 60, 5),
    vaultOwners,
    vaultRatioFloor: BigInt(wholeNumber(env, 'WATCHER_VAULT_RATIO_FLOOR', DEFAULT_VAULT_RATIO_FLOOR, 1)),
    reserveCoverageFloor: BigInt(wholeNumber(env, 'WATCHER_RESERVE_COVERAGE_FLOOR', DEFAULT_RESERVE_COVERAGE_FLOOR, 1)),
    repeatSeconds: wholeNumber(env, 'WATCHER_REPEAT_SECONDS', 21_600, 60),
    heartbeatUrl: heartbeat === undefined ? undefined : httpsUrl('WATCHER_HEARTBEAT_URL', heartbeat),
  };
};
