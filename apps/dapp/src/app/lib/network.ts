import { TARGET_CHAIN_ID } from '@goldstandard/constants';
import { ChainId } from '@goldstandard/models';

/**
 * Network wording for copy about this deployment. The chain is
 * fixed at build time, and pages that said "Sepolia" or "testnet" outright would have told
 * the visitors of a mainnet build they were on a test network. Copy that names the network
 * switches on these instead.
 */
export const networkNameFor = (chainId: number): string =>
	chainId === ChainId.MAINNET ? 'Ethereum mainnet' : 'Sepolia testnet';

export const IS_MAINNET_BUILD = TARGET_CHAIN_ID === ChainId.MAINNET;
export const NETWORK_NAME = networkNameFor(TARGET_CHAIN_ID);
