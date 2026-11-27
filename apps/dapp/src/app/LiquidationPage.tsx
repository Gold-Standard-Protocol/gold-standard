import { useMemo } from 'react';
import { isAddress } from 'viem';
import { Card, CardContent, Skeleton } from '@goldstandard/ui';
import { TARGET_CHAIN_ID } from '@goldstandard/constants';
import { useRegistryVaultOwners } from '@goldstandard/hooks';
import { trpc } from '../trpc';
import { LiquidationTable } from './components/vault/LiquidationTable';
import { Reveal } from './components/Reveal';
import { SectionHeader } from './components/marketing/Section';

interface LiquidationPoint {
  numeral: string;
  title: string;
  detail: string;
}

const HOW_IT_WORKS: LiquidationPoint[] = [
  {
    numeral: '01',
    title: 'Anyone can repay',
    detail:
      'When a vault falls below its liquidation ratio, anyone may liquidate it. Partial liquidations are allowed while the collateral covers its debt; an underwater vault must be settled in full.',
  },
  {
    numeral: '02',
    title: 'Seize gold at a discount',
    detail:
      'The liquidator receives gold at the contract\'s liquidation price, with the incentive limited by the collateral available.',
  },
  {
    numeral: '03',
    title: 'Settle shortfalls',
    detail:
      'Liquidations retire debt and recover collateral. The surplus buffer absorbs a shortfall up to its available balance; losses can remain if the buffer is exhausted.',
  },
];

export default function LiquidationPage() {
  // Vault owners are discovered server-side by indexing CollateralDeposited
  // events. When the cache holds nothing or cannot be read, the API says so with
  // status 'unavailable' rather than an empty list.
  const ownersQuery = trpc.vaultsRouter.owners.useQuery(
    { chainId: TARGET_CHAIN_ID },
    { refetchInterval: 60_000 }
  );

  // Same validator as the server (viem isAddress) so the two layers can
  // never diverge on what counts as an address.
  const vaultOwners = useMemo(
    () =>
      (ownersQuery.data?.owners ?? []).filter(
        (owner): owner is `0x${string}` => isAddress(owner)
      ),
    [ownersQuery.data]
  );
  const indexUnavailable = ownersQuery.data?.status === 'unavailable';
  const apiListMissing = (ownersQuery.isError && !ownersQuery.data) || indexUnavailable;

  // Without the API's list, the on-chain VaultRegistry still
  // names every open vault, read in bounded pages. Only when it too is missing or fails
  // does the page fall back to saying that eligible positions cannot be shown.
  const registry = useRegistryVaultOwners(TARGET_CHAIN_ID, apiListMissing);
  const fromRegistry = apiListMissing && registry.isDeployed && !registry.isError;
  const registryOwners = useMemo(() => registry.owners ?? [], [registry.owners]);

  return (
    <div className="mx-auto w-full max-w-2xl animate-rise">
      <div className="mb-6">
        <SectionHeader
          title="Liquidations"
          lead="Repay the debt of undercollateralised vaults to claim their gold collateral at a discount. A position is eligible once its collateral ratio falls below the liquidation ratio set for its gold token."
          as="h1"
          variant="stack"
          align="left"
        />
      </div>

      <Reveal className="mb-6">
        <Card>
          <CardContent className="p-5 sm:p-6">
            <h2 className="label-mono mb-5 text-xs text-primary">
              How liquidation works
            </h2>
            <ol className="space-y-4">
              {HOW_IT_WORKS.map((point) => (
                <li key={point.title} className="flex gap-3.5">
                  <span
                    className="shrink-0 font-serif text-lg font-semibold leading-none text-primary"
                    aria-hidden
                  >
                    {point.numeral}
                  </span>
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-foreground">
                      {point.title}
                    </p>
                    <p className="mt-0.5 text-pretty text-sm leading-relaxed text-muted-foreground">
                      {point.detail}
                    </p>
                  </div>
                </li>
              ))}
            </ol>
          </CardContent>
        </Card>
      </Reveal>

      {/* With no owner list at all there is nothing to check on-chain, so the table
          must not render its "no vaults are eligible" empty state under this notice:
          during an API outage that read as a verdict rather than as missing data. */}
      {fromRegistry ? (
        <Reveal className="mb-6" delay={40}>
          <Card>
            <CardContent className="p-5 sm:p-6">
              <p className="text-sm font-medium text-foreground">
                Reading open vaults from the chain
              </p>
              <p className="mt-0.5 text-pretty text-sm leading-relaxed text-muted-foreground">
                The vault indexer is unavailable, so this list comes from the on-chain
                vault registry instead. The page checks the indexer again every minute.
              </p>
            </CardContent>
          </Card>
        </Reveal>
      ) : null}

      {ownersQuery.isError && !fromRegistry ? (
        <Reveal className="mb-6" delay={40}>
          <Card>
            <CardContent className="p-5 sm:p-6">
              <p className="text-sm font-medium text-foreground">
                Vault discovery is temporarily unavailable
              </p>
              <p className="mt-0.5 text-pretty text-sm leading-relaxed text-muted-foreground">
                We could not reach the vault indexer, so the list of eligible
                positions may be incomplete. It will refresh automatically
                once the service reconnects.
              </p>
            </CardContent>
          </Card>
        </Reveal>
      ) : null}

      {/* An empty owner set from a cache outage is not "nothing to liquidate". The table
          read it that way and told liquidators to wait for opportunities that might exist. */}
      {indexUnavailable && !fromRegistry ? (
        <Reveal className="mb-6" delay={40}>
          <Card>
            <CardContent className="p-5 sm:p-6">
              <p className="text-sm font-medium text-foreground">
                The vault owner index is not available
              </p>
              <p className="mt-0.5 text-pretty text-sm leading-relaxed text-muted-foreground">
                The list of vault owners could not be loaded, so eligible positions
                cannot be shown. This is not a sign that none exist. The page checks
                again every minute.
              </p>
            </CardContent>
          </Card>
        </Reveal>
      ) : null}

      {ownersQuery.isLoading || (fromRegistry && registry.isLoading) ? (
        <Skeleton className="h-48 w-full rounded-xl" />
      ) : apiListMissing && !fromRegistry ? null : (
        // Eligibility is read from the chain per vault (its liquidation price against the
        // oracle's live liquidation quote), so the list never waits on a market price feed:
        // an unreachable price API used to hide every opportunity behind a placeholder.
        <Reveal delay={80}>
          <LiquidationTable knownVaultOwners={fromRegistry ? registryOwners : vaultOwners} />
        </Reveal>
      )}
    </div>
  );
}
