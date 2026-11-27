import { formatUnits } from 'viem';

import { contractKeyOf } from './deployment';
import type { Deployment } from './deployment';
import { CONTRACT_NAMES, GRANT_ROLE_SELECTOR, ROLE_NAMES } from './rules';
import type { ContractKey, EventRule, Severity } from './rules';

/** A decoded log of a watched contract. */
export interface WatchedLog {
  address: string;
  eventName: string;
  args: Readonly<Record<string, unknown>>;
  blockNumber: number;
  logIndex: number;
  transactionHash: string;
}

export interface Notification {
  severity: Severity;
  text: string;
}

/** Arguments that are GSUSD amounts, 18 decimals. Gold amounts stay raw: decimals differ by token. */
const GSUSD_ARGUMENTS = new Set(['amount', 'debtRepaid', 'gsusdIn', 'fee']);
const MAX_BYTES_SHOWN = 138;

const heading = (severity: Severity): string => (severity === 'page' ? 'PAGE' : 'NOTE');

const labelAddress = (deployment: Deployment, address: string): string => {
  const key = contractKeyOf(deployment, address);
  return key === undefined ? address : `${address} (${CONTRACT_NAMES[key]})`;
};

const shorten = (hex: string): string =>
  hex.length > MAX_BYTES_SHOWN ? `${hex.slice(0, MAX_BYTES_SHOWN)}… (${(hex.length - 2) / 2} bytes)` : hex;

const formatArgument = (deployment: Deployment, eventName: string, name: string, value: unknown): string => {
  if (name === 'role' && typeof value === 'string') return ROLE_NAMES[value.toLowerCase()] ?? value;
  if (typeof value === 'bigint') {
    if (GSUSD_ARGUMENTS.has(name) && eventName !== 'ReserveRoutingFailed' && eventName !== 'SurplusRoutingFailed')
      return `${formatUnits(value, 18)} GSUSD`;
    if (name === 'until' || name === 'pausedAt') return `${new Date(Number(value) * 1000).toISOString()} (${value})`;
    if (name === 'delay') return `${value} seconds`;
    if (name === 'spreadPpm') return `${formatUnits(value, 4)}%`;
    return value.toString();
  }
  if (typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value)) return labelAddress(deployment, value);
  if (typeof value === 'string') return shorten(value);
  return String(value);
};

/** The extra line for a proposal: what it calls, and whether that call grants a role. */
const proposalLine = (args: Readonly<Record<string, unknown>>): string | undefined => {
  const data = args['data'];
  if (typeof data !== 'string' || data.length < 10) return undefined;
  const selector = data.slice(0, 10).toLowerCase();
  return selector === GRANT_ROLE_SELECTOR
    ? `ALARM: the call is grantRole (${selector}). Read the launch sheet, section 5, before anything else.`
    : `Call selector: ${selector}`;
};

export const formatEvent = (
  deployment: Deployment,
  explorerUrl: string,
  contract: ContractKey,
  rule: EventRule,
  log: WatchedLog
): Notification => {
  const lines = [
    `${heading(rule.severity)}: ${log.eventName} on ${CONTRACT_NAMES[contract]}`,
    rule.meaning,
    ...Object.entries(log.args).map(
      ([name, value]) => `${name}: ${formatArgument(deployment, log.eventName, name, value)}`
    ),
  ];
  if (log.eventName === 'CallScheduled' || log.eventName === 'CallExecuted') {
    const extra = proposalLine(log.args);
    if (extra !== undefined) lines.push(extra);
  }
  lines.push(`Block ${log.blockNumber}`, `${explorerUrl}/tx/${log.transactionHash}`);
  return { severity: rule.severity, text: lines.join('\n') };
};

/** Parts per million as a percentage with two decimals: 1538105 is 153.81%. */
export const formatPpm = (value: bigint): string => {
  const hundredths = value / 100n;
  return `${hundredths / 100n}.${(hundredths % 100n).toString().padStart(2, '0')}%`;
};
