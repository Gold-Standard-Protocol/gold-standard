import type { Address } from 'viem';
import { TARGET_CHAIN_ID } from '@goldstandard/constants';
import { trpc } from '../../trpc';

/** The index advances once a minute, so the page asks again at the same pace. */
const LEDGER_REFETCH_MS = 60_000;

/** A placeholder for the disabled account query: tRPC needs an input even when nothing is sent. */
const NO_ADDRESS: Address = '0x0000000000000000000000000000000000000000';

/** What the ledger records and the block it is recorded to. Needs no wallet. */
export function useLedgerStatus() {
	return trpc.ledgerRouter.status.useQuery({ chainId: TARGET_CHAIN_ID }, { refetchInterval: LEDGER_REFETCH_MS });
}

/** The record of one wallet, asked only while a wallet is connected. */
export function useLedgerAccount(address: Address | undefined) {
	return trpc.ledgerRouter.account.useQuery(
		{ chainId: TARGET_CHAIN_ID, address: address ?? NO_ADDRESS },
		{ enabled: Boolean(address), refetchInterval: LEDGER_REFETCH_MS }
	);
}

/** What a card needs from a query: the answer, or why there is none. */
export interface QueryView<T> {
	data: T | undefined;
	isLoading: boolean;
	isError: boolean;
}
