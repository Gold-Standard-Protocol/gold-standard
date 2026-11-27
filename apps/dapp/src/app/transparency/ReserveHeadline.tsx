import { Metric } from '../components/Metric';
import {
  formatPercent,
  formatTokenAmount,
  formatUsdCompact,
} from '../lib/format';

interface ReserveHeadlineProps {
  isDeployed: boolean;
  tvlUsd: number | undefined;
  gusdSupply: bigint | undefined;
  backingRatioPercent: number | undefined;
}

const PRE_LAUNCH = 'Pre-launch';

/**
 * The three headline reserve figures. Every value is read live from chain;
 * before deployment each renders an honest "Pre-launch" state rather than an
 * invented number.
 */
export function ReserveHeadline({
  isDeployed,
  tvlUsd,
  gusdSupply,
  backingRatioPercent,
}: ReserveHeadlineProps) {
  return (
    <div>
      <div className="grid gap-4 md:grid-cols-3">
        <Metric
          bordered
          size="lg"
          label="Total value locked"
          value={tvlUsd !== undefined ? formatUsdCompact(tvlUsd) : PRE_LAUNCH}
          info="The live USD value of all tokenised gold held as collateral by the protocol, priced at the oracle gold price."
        />
        <Metric
          bordered
          size="lg"
          label="GSUSD in circulation"
          value={
            gusdSupply !== undefined
              ? formatTokenAmount(gusdSupply, 18, 0)
              : PRE_LAUNCH
          }
          unit={gusdSupply !== undefined ? 'GSUSD' : undefined}
          info="Total GSUSD minted across every vault. Each unit is a claim on a dollar of gold collateral."
        />
        <Metric
          bordered
          accent
          size="lg"
          label="Backing ratio"
          value={
            backingRatioPercent !== undefined
              ? formatPercent(backingRatioPercent)
              : PRE_LAUNCH
          }
          info="Collateral value divided by GSUSD outstanding. Above 100% means every GSUSD is over-collateralised by gold."
        />
      </div>
      {!isDeployed && (
        <p className="mt-3 text-xs text-muted-foreground">
          Updates live once the protocol is deployed.
        </p>
      )}
    </div>
  );
}
