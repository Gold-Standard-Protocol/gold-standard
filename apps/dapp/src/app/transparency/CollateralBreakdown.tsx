import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@goldstandard/ui';
import type { CollateralStat, ProtocolStatus } from '@goldstandard/hooks';
import {
  formatTokenAmount,
  formatUsd,
  formatUsdCompact,
} from '../lib/format';

interface CollateralBreakdownProps {
  collaterals: CollateralStat[];
  tvlUsd: number | undefined;
  status: ProtocolStatus;
}

/**
 * What a cell says in place of a value it does not have: the cause,
 * never a dash, and "Pre-launch" only before the contracts exist. A failed read on a
 * deployed chain used to read as pre-launch.
 */
function missingText(status: ProtocolStatus, what: 'price' | 'chain'): string {
  if (status === 'loading') return 'Loading';
  if (status === 'error') return 'Chain read failed, retrying';
  if (status === 'pre-launch') return what === 'price' ? 'Price feed unavailable, retrying' : 'Pre-launch';
  return what === 'price' ? 'Price unavailable, retrying' : 'Chain read failed, retrying';
}

function sharePercent(
  valueUsd: number | undefined,
  tvlUsd: number | undefined
): number | undefined {
  if (valueUsd === undefined || tvlUsd === undefined || tvlUsd <= 0) {
    return undefined;
  }
  return Math.min(100, Math.max(0, (valueUsd / tvlUsd) * 100));
}

function TokenIdentity({ asset }: { asset: CollateralStat }) {
  return (
    <span className="flex items-center gap-3">
      <img
        src={asset.image}
        alt=""
        aria-hidden
        className="h-9 w-9 shrink-0 rounded-full border border-border bg-card object-cover"
      />
      <span className="flex flex-col">
        <span className="font-medium leading-tight text-foreground">
          {asset.symbol}
        </span>
        <span className="text-xs leading-tight text-muted-foreground">
          {asset.name}
        </span>
      </span>
    </span>
  );
}

function LivePrice({
  priceUsd,
  priceSource,
  missing,
}: {
  priceUsd: number | undefined;
  priceSource: 'oracle' | 'market' | undefined;
  missing: string;
}) {
  if (priceUsd === undefined) {
    return <span className="text-muted-foreground">{missing}</span>;
  }
  // The badge names the SOURCE: "Oracle" is the price the contracts compute with;
  // "Market" only ever appears pre-launch, when no oracle exists to read.
  return (
    <span className="inline-flex items-center gap-2">
      <span className="nums whitespace-nowrap text-foreground">{formatUsd(priceUsd)} / oz</span>
      <span className="label-mono ml-1 text-xs text-muted-foreground">
        {priceSource === 'oracle' ? 'Oracle' : 'Market'}
      </span>
    </span>
  );
}

function ShareBar({ share }: { share: number | undefined }) {
  if (share === undefined) {
    return <span className="text-xs text-muted-foreground">n/a</span>;
  }
  return (
    <span className="flex items-center gap-2">
      <span
        className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted"
        aria-hidden
      >
        <span
          className="block h-full rounded-full bg-primary"
          style={{ width: `${share}%` }}
        />
      </span>
      <span className="nums w-12 shrink-0 text-right text-xs text-muted-foreground">
        {share.toFixed(1)}%
      </span>
    </span>
  );
}

/**
 * Per-asset collateral reserves. Renders a semantic table on larger screens and
 * stacked cards on mobile. Gold prices are live; a value that is missing says why
 * (loading, a failed read, or pre-launch before the contracts exist).
 */
export function CollateralBreakdown({
  collaterals,
  tvlUsd,
  status,
}: CollateralBreakdownProps) {
  const showShare = tvlUsd !== undefined && tvlUsd > 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle as="h2">Collateral reserves</CardTitle>
        <CardDescription>
          The tokenised gold held against GSUSD, priced live and verifiable
          on-chain.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {/* Table, sm and up */}
        <div
          className="hidden overflow-x-auto focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:block"
          role="region"
          aria-label="Collateral reserves table"
          tabIndex={0}
        >
          <table className="w-full min-w-[40rem] border-collapse text-sm">
            <thead>
              <tr className="border-b border-border text-left">
                <th className="label-mono pb-3 pr-4 text-xs text-muted-foreground">
                  Asset
                </th>
                <th className="label-mono pb-3 pr-4 text-xs text-muted-foreground">
                  Live price
                </th>
                <th className="label-mono pb-3 pr-4 text-right text-xs text-muted-foreground">
                  Held
                </th>
                <th className="label-mono pb-3 pr-4 text-right text-xs text-muted-foreground">
                  Value
                </th>
                {showShare && (
                  <th className="label-mono pb-3 text-xs text-muted-foreground">
                    Share of TVL
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {collaterals.map((asset) => (
                <tr
                  key={asset.address}
                  className="border-b border-border/60 last:border-0"
                >
                  <td className="py-4 pr-4 align-middle">
                    <TokenIdentity asset={asset} />
                  </td>
                  <td className="whitespace-nowrap py-4 pr-4 align-middle">
                    <LivePrice priceUsd={asset.priceUsd} priceSource={asset.priceSource} missing={missingText(status, 'price')} />
                  </td>
                  <td className="nums whitespace-nowrap py-4 pr-4 text-right align-middle text-foreground">
                    {asset.balance !== undefined
                      ? `${formatTokenAmount(asset.balance, asset.decimals)} ${asset.symbol}`
                      : missingText(status, 'chain')}
                  </td>
                  <td className="nums whitespace-nowrap py-4 pr-4 text-right align-middle text-foreground">
                    {asset.valueUsd !== undefined
                      ? formatUsdCompact(asset.valueUsd)
                      : missingText(status, asset.balance === undefined ? 'chain' : 'price')}
                  </td>
                  {showShare && (
                    <td className="w-44 py-4 align-middle">
                      <ShareBar
                        share={sharePercent(asset.valueUsd, tvlUsd)}
                      />
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Cards, mobile */}
        <ul className="space-y-3 sm:hidden">
          {collaterals.map((asset) => (
            <li
              key={asset.address}
              className="rounded-lg border border-border bg-card p-4"
            >
              <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
                <TokenIdentity asset={asset} />
                <LivePrice priceUsd={asset.priceUsd} priceSource={asset.priceSource} missing={missingText(status, 'price')} />
              </div>
              <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
                <div>
                  <dt className="label-mono text-xs text-muted-foreground">
                    Held
                  </dt>
                  <dd className="nums mt-0.5 text-foreground">
                    {asset.balance !== undefined
                      ? `${formatTokenAmount(asset.balance, asset.decimals)} ${asset.symbol}`
                      : missingText(status, 'chain')}
                  </dd>
                </div>
                <div className="text-right">
                  <dt className="label-mono text-xs text-muted-foreground">
                    Value
                  </dt>
                  <dd className="nums mt-0.5 text-foreground">
                    {asset.valueUsd !== undefined
                      ? formatUsdCompact(asset.valueUsd)
                      : missingText(status, asset.balance === undefined ? 'chain' : 'price')}
                  </dd>
                </div>
              </dl>
              {showShare && (
                <div className="mt-4">
                  <p className="label-mono mb-1.5 text-xs text-muted-foreground">
                    Share of TVL
                  </p>
                  <ShareBar share={sharePercent(asset.valueUsd, tvlUsd)} />
                </div>
              )}
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
