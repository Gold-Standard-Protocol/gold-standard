// How the bundle reads a contract address from its VITE_* environment. goldVault.ts and dex.ts
// both read through this, so the bundle uses the value the build guard judged: buildEnv.ts
// trims a value before it checks it, and a host that passes variables through the process
// environment (not an .env file, which Vite's parser trims) can carry a trailing space or a
// newline that would otherwise ship as an invalid address.
import { type Address, isAddress } from 'viem';

/** What an unset address reads as. Never a contract to call: consumers treat it as "not configured". */
export const UNSET_ADDRESS: Address = '0x0000000000000000000000000000000000000000';

export type AddressEnv = Readonly<Record<string, string | undefined>>;

const reportedInvalid = new Set<string>();

const reportInvalidOnce = (key: string, value: string): void => {
	if (reportedInvalid.has(key)) return;
	reportedInvalid.add(key);
	console.error(`${key} is not a valid address ("${value}"); the contract is treated as not configured.`);
};

/**
 * The address `key` names in `env`, with surrounding whitespace removed. An unset or blank
 * value reads as UNSET_ADDRESS. So does a value that is not an address (a truncated paste, a
 * broken EIP-55 checksum), which is reported once: every read against it would throw.
 */
export const contractAddressFromEnv = (env: AddressEnv, key: string): Address => {
	const value = env[key]?.trim() ?? '';
	if (value === '') return UNSET_ADDRESS;
	if (isAddress(value)) return value;
	reportInvalidOnce(key, value);
	return UNSET_ADDRESS;
};
