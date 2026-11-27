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
  getSurplusBufferContractConfig,
} from '@goldstandard/constants';
import { Metric } from '../components/Metric';
import { formatTokenAmount, formatTokenAmountPrecise } from '../lib/format';

const TARGET_CHAIN = TARGET_CHAIN_ID;
const PRE_LAUNCH = 'Pre-launch';
const UNAVAILABLE = 'Unavailable';

/**
 * Gold collateral assets that have an address on the target chain.
 * `t.decimals` MUST match the on-chain token decimals exactly (PAXG 18,
 * XAUT 6): the contract stores raw token units, so a mis-registered decimals
 * value in TOKEN_LIST would silently inflate or shrink displayed balances.
 */
const goldTokens = TOKEN_LIST.filter(
  (t) => t.gold && !!t.addresses[TARGET_CHAIN]
);

/**
 * Static contract config; stays undefined until VITE_SURPLUS_BUFFER_ADDRESS is
 * set to a real deployment address (the zero-address fallback is treated as
 * unconfigured by the constants layer).
 */
const surplusBuffer = getSurplusBufferContractConfig(TARGET_CHAIN);

/**
 * Fixed read order. Lifetime counters come first because they are the honest
 * revenue figures: the buffer's live GSUSD balance is a RESERVE, and it falls
 * when governance withdraws or when bad debt is absorbed. Reporting that
 * balance as "revenue" would restate earnings downwards every time the buffer
 * did its job, which is precisely backwards.
 *
 * The floor is effectiveMinGsusdReserve, the number withdrawGsusd enforces:
 * AUTO_FLOOR_BPS of outstanding supply (2% from 2 November 2026, 3% before), kept
 * automatically, or the governed minGsusdReserve when that is higher. The rate is
 * read from the contract, so the label always names what the deployed buffer enforces. A buffer deployed before the automatic floor has no such
 * getter; minGsusdReserve, read last, is then a confirmed lower bound. A failed
 * getter alone cannot distinguish that deployment from an unavailable RPC read.
 */
const READS = [
  'totalFeesReceived',
  'gsusdBalance',
  'effectiveMinGsusdReserve',
  'totalGsusdWithdrawn',
  'totalBadDebtAbsorbed',
  'minGsusdReserve',
  'AUTO_FLOOR_BPS',
] as const;

const contracts = surplusBuffer
  ? [
      ...READS.map(
        (functionName) =>
          ({
            chainId: TARGET_CHAIN_ID,
            ...surplusBuffer,
            functionName,
          }) as const
      ),
      // Per token: what is held right now, then what has ever arrived.
      ...goldTokens.flatMap((t) => [
        {
          chainId: TARGET_CHAIN_ID,
          ...surplusBuffer,
          functionName: 'collateralBalance',
          args: [t.addresses[TARGET_CHAIN] as Address],
        } as const,
        {
          chainId: TARGET_CHAIN_ID,
          ...surplusBuffer,
          functionName: 'totalCollateralReceived',
          args: [t.addresses[TARGET_CHAIN] as Address],
        } as const,
      ]),
    ]
  : [];

interface ReadResult {
  status: 'success' | 'failure';
  result?: unknown;
}

function asBigint(res: ReadResult | undefined): bigint | undefined {
  return res && res.status === 'success' && typeof res.result === 'bigint'
    ? res.result
    : undefined;
}

/** Renders a GSUSD figure, or an honest non-numeric state. */
function gsusd(
  value: bigint | undefined,
  isConfigured: boolean
): string {
  if (!isConfigured) return PRE_LAUNCH;
  // A failed read must never look like a genuine zero.
  if (value === undefined) return UNAVAILABLE;
  return `${formatTokenAmountPrecise(value, 18, 2)} GSUSD`;
}

interface PenaltyRowProps {
  symbol: string;
  name: string;
  decimals: number;
  held: bigint | undefined;
  lifetime: bigint | undefined;
  isConfigured: boolean;
}

function PenaltyRow({
  symbol,
  name,
  decimals,
  held,
  lifetime,
  isConfigured,
}: PenaltyRowProps) {
  let display: string;
  if (!isConfigured) {
    display = PRE_LAUNCH;
  } else if (held !== undefined) {
    display = `${formatTokenAmount(held, decimals)} ${symbol}`;
  } else {
    display = UNAVAILABLE;
  }

  // Only worth showing once the two diverge, i.e. once something has been sold
  // or swept. Before that it is the same number twice.
  const showLifetime =
    isConfigured &&
    held !== undefined &&
    lifetime !== undefined &&
    lifetime !== held;

  return (
    <div className="flex items-center justify-between gap-3 py-2 text-sm">
      <span className="label-mono text-xs text-muted-foreground">
        {name} ({symbol})
      </span>
      <span className="text-right">
        <span className="nums font-medium text-foreground">{display}</span>
        {showLifetime && (
          <span className="nums block text-xs text-muted-foreground">
            {formatTokenAmount(lifetime, decimals)} received to date
          </span>
        )}
      </span>
    </div>
  );
}

/**
 * On-chain revenue transparency for the surplus buffer.
 *
 * The distinction this panel exists to make: LIFETIME FEES RECEIVED is what the
 * protocol has earned and never decreases; the BUFFER BALANCE is what is left
 * after withdrawals and bad-debt absorption, and is a first-loss reserve rather
 * than a revenue figure. Every number is read live from the contract, and
 * before deployment each renders an honest pre-launch state.
 */
export function RevenuePanel() {
  const isConfigured = surplusBuffer !== undefined;

  const { data, isLoading } = useReadContracts({
    contracts,
    query: { enabled: isConfigured, refetchInterval: 30_000 },
  });

  const results: readonly ReadResult[] = data ?? [];
  const feesReceived = asBigint(results[0]);
  const gsusdBalance = asBigint(results[1]);
  const effectiveFloor = asBigint(results[2]);
  const withdrawn = asBigint(results[3]);
  const badDebtAbsorbed = asBigint(results[4]);
  const governedFloor = asBigint(results[5]);
  const floorBps = asBigint(results[6]);
  const floorRate = floorBps === undefined ? 'a share' : `${Number(floorBps) / 100}%`;
  const isAutomaticFloor = effectiveFloor !== undefined;
  const reserveFloor = effectiveFloor ?? governedFloor;
  const showSkeleton = isConfigured && isLoading;

  return (
    <Card>
      <CardHeader>
        <CardTitle as="h2">Protocol revenue</CardTitle>
        <CardDescription>
          What the protocol has earned, and what it still holds, verifiable
          on-chain.
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
              label="Lifetime fees earned"
              value={gsusd(feesReceived, isConfigured)}
              info="Every GSUSD fee the protocol has ever banked, from stability fees, liquidations, reserve swap spreads and origination. A fee lands here when it is paid: on a repayment, a liquidation or a reserve swap. A mint starts a stability fee accruing on the vault but banks nothing until it is paid. A cumulative counter: it never decreases, so it is unaffected by withdrawals or bad debt."
            />
            <Metric
              bordered
              label="Buffer reserve"
              value={gsusd(gsusdBalance, isConfigured)}
              info="GSUSD held in the buffer right now. This is a first-loss reserve, not an earnings figure: it falls when governance withdraws and when the buffer absorbs bad debt."
            />
            <Metric
              bordered
              label="Withdrawn by governance"
              value={gsusd(withdrawn, isConfigured)}
              info="Cumulative GSUSD withdrawn from the buffer by governance. Withdrawals cannot take the reserve below the floor below."
            />
            <Metric
              bordered
              label="Bad debt absorbed"
              value={gsusd(badDebtAbsorbed, isConfigured)}
              info="Cumulative GSUSD the buffer has burned to cover vaults that liquidated for less than they owed. This is the reserve doing its job, and it is the gap between fees earned and fees kept."
            />
          </div>
        )}

        <div className="flex items-center justify-between gap-3 text-sm">
          <span className="label-mono text-xs text-muted-foreground">
            {isAutomaticFloor || !isConfigured
              ? `Reserve floor (${floorRate} of supply, contract-enforced)`
              : governedFloor !== undefined
              ? 'Governed minimum (effective floor unavailable)'
              : 'Reserve floor'}
          </span>
          <span className="nums font-medium text-foreground">
            {gsusd(reserveFloor, isConfigured)}
          </span>
        </div>

        <p className="text-pretty text-sm leading-relaxed text-muted-foreground">
          {isAutomaticFloor || !isConfigured
            ? `Fees are banked as GSUSD rather than burned, and accumulate here as the first-loss reserve against bad debt. The contract keeps at least ${floorRate} of outstanding GSUSD here by itself, measured against the larger of today's supply and its one day average, so the floor rises with supply and a quick repayment cannot shrink it. Governance can withdraw only the amount above the floor; bad debt can use all of it.`
            : governedFloor !== undefined
            ? 'Fees accumulate here as the first-loss reserve against bad debt. The effective reserve floor could not be read. The governed minimum shown is a confirmed lower bound; the effective floor may be higher. This read does not establish which buffer version is deployed.'
            : 'Fees accumulate here as the first-loss reserve against bad debt. The reserve floor is unavailable. These reads cannot confirm a floor amount or which buffer version is deployed.'}
        </p>

        <Separator />

        <div>
          <p className="label-mono mb-1 text-xs text-muted-foreground">
            Penalty collateral held
          </p>
          {showSkeleton ? (
            <div className="space-y-2 pt-2">
              {goldTokens.map((t) => (
                <Skeleton key={t.symbol} className="h-9 w-full rounded-lg" />
              ))}
            </div>
          ) : (
            goldTokens.map((t, index) => (
              <PenaltyRow
                key={t.symbol}
                symbol={t.symbol}
                name={t.name}
                decimals={t.decimals}
                held={asBigint(results[READS.length + index * 2])}
                lifetime={asBigint(results[READS.length + index * 2 + 1])}
                isConfigured={isConfigured}
              />
            ))
          )}
        </div>

        {!isConfigured && (
          <p className="text-xs text-muted-foreground">
            Updates live once the protocol is deployed.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
