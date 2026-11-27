import { useReadContracts } from 'wagmi';
import { type Address } from 'viem';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Separator,
  Skeleton,
} from '@goldstandard/ui';
import {
  TARGET_CHAIN_ID,
  TOKEN_LIST,
  getStabilityReserveContractConfig,
} from '@goldstandard/constants';
import { Metric } from '../components/Metric';
import { formatPercent, formatTokenAmount, formatTokenAmountPrecise } from '../lib/format';

const TARGET_CHAIN = TARGET_CHAIN_ID;
const PRE_LAUNCH = 'Pre-launch';
const UNAVAILABLE = 'Unavailable';

/** Gold assets on the target chain; decimals MUST match the on-chain token. */
const goldTokens = TOKEN_LIST.filter(
  (t) => t.gold && !!t.addresses[TARGET_CHAIN]
);

/** Undefined until VITE_STABILITY_RESERVE_ADDRESS is a real deployment. */
const reserve = getStabilityReserveContractConfig(TARGET_CHAIN);

/**
 * Reserve-wide reads first, then four per asset. Coverage and spread are what a
 * holder needs to judge the floor; the GSUSD figures exist to show that swap
 * proceeds are held as inventory and are never counted as revenue.
 */
const READS = [
  'coveragePpm',
  'currentSpreadPpm',
  'reserveValueUsd',
  'gsusdInventory',
  'totalGsusdReceived',
  'totalSpreadPaid',
] as const;

const PER_ASSET = [
  'collateralBalance',
  'redeemableCollateral',
  'remainingDailyCapacity',
  'totalGoldSwappedOut',
] as const;

/**
 * Every read names the target chain: without it wagmi reads whichever configured chain the
 * wallet is on. Exported for tests.
 */
export const RESERVE_PANEL_READS = reserve
  ? [
      ...READS.map((functionName) => ({ ...reserve, functionName, chainId: TARGET_CHAIN }) as const),
      ...goldTokens.flatMap((t) =>
        PER_ASSET.map(
          (functionName) =>
            ({
              ...reserve,
              functionName,
              args: [t.addresses[TARGET_CHAIN] as Address] as const,
              chainId: TARGET_CHAIN,
            }) as const
        )
      ),
    ]
  : [];

/**
 * What coveragePpm answers when no GSUSD circulates outside the reserve: PPM * 1000, a
 * sentinel for unlimited coverage, not a measurement.
 */
export const COVERAGE_SENTINEL_PPM = 1_000_000_000n;

interface ReadResult {
  status: 'success' | 'failure';
  result?: unknown;
}

function asBigint(res: ReadResult | undefined): bigint | undefined {
  return res && res.status === 'success' && typeof res.result === 'bigint'
    ? res.result
    : undefined;
}

function display(
  value: bigint | undefined,
  isConfigured: boolean,
  render: (v: bigint) => string
): string {
  if (!isConfigured) return PRE_LAUNCH;
  // A failed read must never look like a genuine zero.
  if (value === undefined) return UNAVAILABLE;
  return render(value);
}

const ppmToPercent = (v: bigint) => formatPercent(Number(v) / 10_000, 2);

/**
 * Coverage as a percentage, or "n/a" for the no-supply sentinel, which would otherwise read
 * as "100,000.00%" before launch. Exported for tests.
 */
export function formatCoverage(coveragePpm: bigint): string {
  return coveragePpm >= COVERAGE_SENTINEL_PPM ? 'n/a' : ppmToPercent(coveragePpm);
}

interface AssetRowProps {
  symbol: string;
  name: string;
  decimals: number;
  held: bigint | undefined;
  redeemable: bigint | undefined;
  remainingToday: bigint | undefined;
  swappedOut: bigint | undefined;
  isConfigured: boolean;
}

function AssetRow({
  symbol,
  name,
  decimals,
  held,
  redeemable,
  remainingToday,
  swappedOut,
  isConfigured,
}: AssetRowProps) {
  const gold = (v: bigint | undefined) =>
    display(v, isConfigured, (x) => `${formatTokenAmount(x, decimals)} ${symbol}`);
  return (
    <div className="py-2 text-sm">
      <div className="flex items-center justify-between gap-3">
        <span className="label-mono text-xs text-muted-foreground">
          {name} ({symbol})
        </span>
        <span className="nums font-medium text-foreground">{gold(held)}</span>
      </div>
      {isConfigured && (
        <dl className="mt-1 grid grid-cols-3 gap-2 text-xs text-muted-foreground">
          <div>
            <dt>Above floor</dt>
            <dd className="nums text-foreground">{gold(redeemable)}</dd>
          </div>
          <div>
            <dt>Left today</dt>
            <dd className="nums text-foreground">{gold(remainingToday)}</dd>
          </div>
          <div>
            <dt>Swapped out to date</dt>
            <dd className="nums text-foreground">{gold(swappedOut)}</dd>
          </div>
        </dl>
      )}
    </div>
  );
}

/**
 * The Gold Stability Reserve, shown apart from the insurance buffer on purpose:
 * the same gold must never be counted as both peg defence and bad-debt cover.
 * The reserve never mints; it only ever pays out gold it already holds.
 */
export function StabilityReservePanel() {
  const isConfigured = reserve !== undefined;

  const { data, isLoading } = useReadContracts({
    contracts: RESERVE_PANEL_READS,
    query: { enabled: isConfigured, refetchInterval: 30_000 },
  });

  const results: readonly ReadResult[] = data ?? [];
  const coverage = asBigint(results[0]);
  const spread = asBigint(results[1]);
  const valueUsd = asBigint(results[2]);
  const inventory = asBigint(results[3]);
  const received = asBigint(results[4]);
  const spreadPaid = asBigint(results[5]);
  const showSkeleton = isConfigured && isLoading;
  const floorAbsent = isConfigured && coverage === 0n;
  const noSupply = coverage !== undefined && coverage >= COVERAGE_SENTINEL_PPM;

  return (
    <Card>
      <CardHeader>
        <CardTitle as="h2">Gold Stability Reserve</CardTitle>
        <CardDescription>
          Protocol-owned gold that GSUSD converts into at the quoted price, up
          to available capacity. Separate from the insurance buffer, and it
          never mints.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {showSkeleton ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <Skeleton className="h-[88px] w-full rounded-xl" />
            <Skeleton className="h-[88px] w-full rounded-xl" />
            <Skeleton className="h-[88px] w-full rounded-xl" />
            <Skeleton className="h-[88px] w-full rounded-xl" />
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            <Metric
              bordered
              label="Reserve coverage"
              value={display(coverage, isConfigured, formatCoverage)}
              hint={noSupply ? 'No GSUSD circulates outside the reserve yet.' : undefined}
              info="Redeemable reserve gold, valued at the lower of its market price and the gold price, divided by GSUSD in circulation outside the reserve. A gold token whose price feed is stale counts as zero. The floor is depth-limited: this is its depth."
            />
            <Metric
              bordered
              label="Current spread"
              value={display(spread, isConfigured, ppmToPercent)}
              info="What a swap pays right now, below the reserve price (the higher of the market price and the gold price). It steps up as coverage falls, between 0.5% and 5%. The spread is revenue and goes to the insurance buffer."
            />
            <Metric
              bordered
              label="Redeemable gold value"
              value={display(
                valueUsd,
                isConfigured,
                (v) => `$${formatTokenAmount(v, 18, 0)}`
              )}
              info="USD value of reserve gold above each asset's floor, at the lower of its market price and the gold price. Zero for a gold token whose price feed is stale."
            />
            <Metric
              bordered
              label="GSUSD held (not revenue)"
              value={display(
                inventory,
                isConfigured,
                (v) => `${formatTokenAmountPrecise(v, 18, 2)} GSUSD`
              )}
              info="GSUSD received from swaps and held as inventory. Gold of equal value left the reserve, so this is not earnings and never touches the fee counters. It is never burned."
            />
          </div>
        )}

        {floorAbsent && (
          <p role="status" className="text-sm text-destructive">
            The reserve holds no redeemable gold right now. GSUSD still trades on
            open markets, but the reserve floor is absent until it is funded.
          </p>
        )}

        <div className="space-y-1.5 text-sm">
          <div className="flex items-center justify-between gap-3">
            <span className="label-mono text-xs text-muted-foreground">GSUSD received from swaps to date</span>
            <span className="nums font-medium text-foreground">
              {display(received, isConfigured, (v) => `${formatTokenAmount(v, 18, 0)} GSUSD`)}
            </span>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="label-mono text-xs text-muted-foreground">Spread paid into the insurance buffer</span>
            <span className="nums font-medium text-foreground">
              {display(spreadPaid, isConfigured, (v) => `${formatTokenAmountPrecise(v, 18, 2)} GSUSD`)}
            </span>
          </div>
        </div>

        <Separator />

        <div>
          <p className="label-mono mb-1 text-xs text-muted-foreground">
            Reserve gold held
          </p>
          {showSkeleton ? (
            <div className="space-y-2 pt-2">
              {goldTokens.map((t) => (
                <Skeleton key={t.symbol} className="h-14 w-full rounded-lg" />
              ))}
            </div>
          ) : (
            goldTokens.map((t, index) => {
              const base = READS.length + index * PER_ASSET.length;
              return (
                <AssetRow
                  key={t.symbol}
                  symbol={t.symbol}
                  name={t.name}
                  decimals={t.decimals}
                  held={asBigint(results[base])}
                  redeemable={asBigint(results[base + 1])}
                  remainingToday={asBigint(results[base + 2])}
                  swappedOut={asBigint(results[base + 3])}
                  isConfigured={isConfigured}
                />
              );
            })
          )}
        </div>

        <p className="text-pretty text-sm leading-relaxed text-muted-foreground">
          Funded by a treasury seed and a governed share of liquidation
          penalties. No borrower&apos;s vault is ever drawn on by a swap; the
          only thing that moves a vault is its owner, or a liquidation below
          the threshold.
        </p>

        {!isConfigured && (
          <p className="text-xs text-muted-foreground">
            Updates live once the reserve is deployed.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
