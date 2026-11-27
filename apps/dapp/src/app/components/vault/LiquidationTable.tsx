import { useCallback, useState } from 'react';
import { useAccount } from 'wagmi';
import { CheckCircleIcon, InboxStackIcon } from '@heroicons/react/24/outline';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Skeleton,
} from '@goldstandard/ui';
import { useUndercollateralisedVaults } from '@goldstandard/hooks';
import { TARGET_CHAIN_ID } from '@goldstandard/constants';
import { LiquidationRow, type LiquidationRoute } from './LiquidationRow';
import { shortAddress } from '../../lib/format';

interface LiquidationTableProps {
  knownVaultOwners: `0x${string}`[];
}

export function LiquidationTable({
  knownVaultOwners,
}: LiquidationTableProps) {
  // The deployment's own chain, whatever network the wallet is on.
  const chainId = TARGET_CHAIN_ID;
  const { undercollateralised, judgedAtStoredPrice, isLoading, isError } =
    useUndercollateralisedVaults(chainId, knownVaultOwners);
  // Eligibility is judged at the live liquidation quote; a
  // collateral whose quote was refused is judged at the stored price, and says so.
  // A confirmation re-reads the list, so a fully liquidated vault leaves it at once and
  // takes its row's success line along; the outcome is kept here instead. It says the
  // proceeds are in "your wallet", so it shows to the account that liquidated only.
  const { address } = useAccount();
  const [confirmed, setConfirmed] = useState<{
    owner: `0x${string}`;
    route: LiquidationRoute;
    by: `0x${string}` | undefined;
  }>();
  const handleConfirmed = useCallback(
    (owner: `0x${string}`, route: LiquidationRoute) => setConfirmed({ owner, route, by: address }),
    [address]
  );
  const confirmedNote = confirmed && address && confirmed.by === address ? (
    <p
      role="status"
      className="flex items-center gap-1.5 px-5 py-3 text-pretty text-xs font-medium text-success"
    >
      <CheckCircleIcon className="h-4 w-4 shrink-0" aria-hidden />
      {confirmed.route === 'pool'
        ? `Vault ${shortAddress(confirmed.owner)} liquidated from the pool; your bounty is in your wallet.`
        : `Vault ${shortAddress(confirmed.owner)} liquidated; the seized gold is in your wallet.`}
    </p>
  ) : null;
  const storedPriceNote = judgedAtStoredPrice ? (
    <p className="px-5 py-3 text-pretty text-xs leading-relaxed text-warning">
      Live gold price unavailable. Some positions are judged at the last price the oracle
      recorded, which can lag the market.
    </p>
  ) : null;

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Eligible positions</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2.5">
          <Skeleton className="h-12 w-full rounded-lg" />
          <Skeleton className="h-12 w-full rounded-lg" />
          <Skeleton className="h-12 w-full rounded-lg" />
        </CardContent>
      </Card>
    );
  }

  if (isError) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Eligible positions</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col items-center gap-2 py-10 text-center">
            <p className="text-sm font-medium text-foreground">
              Unable to load vault data
            </p>
            <p className="max-w-sm text-sm text-muted-foreground">
              We could not read vault positions from the network. Please check
              your connection and try again.
            </p>
          </div>
        </CardContent>
      </Card>
    );
  }

  const count = undercollateralised.length;

  if (count === 0) {
    return (
      <Card>
        <CardContent className="p-0">
          <div className="flex flex-col items-center gap-4 px-6 py-14 text-center">
            <div
              className="grid h-14 w-14 place-items-center rounded-2xl border border-border bg-muted text-muted-foreground"
              aria-hidden
            >
              <InboxStackIcon className="h-6 w-6" />
            </div>
            <div className="space-y-1.5">
              <h3 className="font-serif text-lg font-semibold text-foreground text-balance">
                No vaults are currently eligible for liquidation
              </h3>
              <p className="mx-auto max-w-sm text-pretty text-sm leading-relaxed text-muted-foreground">
                A position appears here as soon as its collateral ratio falls
                below the liquidation ratio for its gold token.
              </p>
            </div>
          </div>
          {confirmedNote}
          {storedPriceNote}
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle>Eligible positions</CardTitle>
        <span className="label-mono text-xs text-primary">
          {count} eligible
        </span>
      </CardHeader>
      <CardContent className="p-0">
        {confirmedNote}
        {storedPriceNote}
        {/* A list of disclosure rows, not an ARIA table: each
            row is a button that opens a form, which a table row cannot hold as cells. The
            header is visual only; every row's button names each value with its label.
            role="list" keeps the list in Safari, which drops it for list-style: none. */}
        <div
          aria-hidden
          className="label-mono grid grid-cols-[1.3fr_1fr_1fr_4.5rem] items-center gap-2 sm:gap-x-6 border-b border-border px-5 py-2.5 text-xs text-muted-foreground"
        >
          <span>Vault owner</span>
          <span className="text-right">Collateral</span>
          <span className="text-right">Debt</span>
          <span className="text-right">Ratio</span>
        </div>
        {/* eslint-disable-next-line jsx-a11y/no-redundant-roles -- Safari drops the implicit role under list-style: none */}
        <ul
          role="list"
          aria-label="Vaults eligible for liquidation"
          className="divide-y divide-border"
        >
          {undercollateralised.map((vault) => (
            <LiquidationRow
              key={vault.owner}
              vault={vault}
              chainId={chainId}
              onConfirmed={handleConfirmed}
            />
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
