import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@goldstandard/ui';
import { ArrowTopRightOnSquareIcon } from '@heroicons/react/24/outline';
import { zeroAddress, type Address } from 'viem';
import {
  GOLD_VAULT_ADDRESSES,
  GUSD_ADDRESSES,
  STABILITY_MODULE_ADDRESSES,
  TARGET_CHAIN_ID,
  explorerAddressUrl,
} from '@goldstandard/constants';
import { shortAddress } from '../lib/format';
import { IS_MAINNET_BUILD } from '../lib/network';

interface ContractEntry {
  name: string;
  detail: string;
  address: Address | undefined;
}

const CONTRACTS: ContractEntry[] = [
  {
    name: 'GoldVault',
    detail: 'Holds collateral, mints GSUSD and runs liquidations.',
    address: GOLD_VAULT_ADDRESSES[TARGET_CHAIN_ID],
  },
  {
    name: 'GSUSD',
    detail: 'The gold-backed dollar token.',
    address: GUSD_ADDRESSES[TARGET_CHAIN_ID],
  },
  {
    name: 'StabilityModule',
    detail: 'Collects stability fees.',
    address: STABILITY_MODULE_ADDRESSES[TARGET_CHAIN_ID],
  },
];

function isDeployedAddress(address: Address | undefined): address is Address {
  return !!address && address !== zeroAddress;
}

function ContractRow({ entry }: { entry: ContractEntry }) {
  // A local const so the type guard narrows the address for the JSX below.
  const address = entry.address;
  const deployed = isDeployedAddress(address);

  return (
    <li className="flex items-center justify-between gap-4 py-4 first:pt-0 last:pb-0">
      <span className="flex flex-col">
        <span className="font-medium leading-tight text-foreground">
          {entry.name}
        </span>
        <span className="mt-0.5 text-xs leading-snug text-muted-foreground">
          {entry.detail}
        </span>
      </span>
      {deployed ? (
        <a
          href={explorerAddressUrl(TARGET_CHAIN_ID, address)}
          target="_blank"
          rel="noreferrer"
          className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-md font-mono text-sm text-primary outline-none transition-colors hover:text-gold-700 focus-visible:ring-2 focus-visible:ring-ring"
        >
          {shortAddress(address)}
          <ArrowTopRightOnSquareIcon aria-hidden className="h-3.5 w-3.5" />
          <span className="sr-only">View {entry.name} on Etherscan</span>
        </a>
      ) : (
        <span className="label-mono shrink-0 text-xs text-muted-foreground">
          Not yet deployed
        </span>
      )}
    </li>
  );
}

/**
 * The protocol's on-chain contracts on the build's target chain. Each links to Etherscan once
 * deployed, or shows an honest "Not yet deployed" badge while the address is the
 * zero address.
 */
export function ContractsPanel() {
  return (
    <Card>
      <CardHeader>
        <CardTitle as="h2">Contracts</CardTitle>
        <CardDescription>
          {/* The network follows the build. */}
          Every contract is public and verifiable on {IS_MAINNET_BUILD ? 'Ethereum mainnet' : 'Sepolia'}.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="divide-y divide-border/60">
          {CONTRACTS.map((entry) => (
            <ContractRow key={entry.name} entry={entry} />
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
