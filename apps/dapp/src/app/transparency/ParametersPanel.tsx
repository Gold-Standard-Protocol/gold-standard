import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@goldstandard/ui';
import type { CollateralStat } from '@goldstandard/hooks';
import { PROTOCOL_PARAMETERS } from '../content/site';
import { formatPercent } from '../lib/format';

interface ParametersPanelProps {
  isLive: boolean;
  collaterals: CollateralStat[];
}

interface ResolvedParameter {
  label: string;
  value: string;
  detail: string;
  /** True when the figure was read live from the deployed contract. */
  onChain: boolean;
}

/**
 * Resolve the displayed parameters. When the protocol is live and a collateral
 * carries on-chain values, prefer those; otherwise fall back to the documented
 * design parameters.
 */
function resolveParameters(
  isLive: boolean,
  collaterals: CollateralStat[]
): ResolvedParameter[] {
  const reference = isLive
    ? collaterals.find(
        (c) =>
          c.minRatioPercent !== undefined ||
          c.liquidationPenaltyPercent !== undefined
      )
    : undefined;

  return PROTOCOL_PARAMETERS.map((param) => {
    if (reference) {
      if (
        param.label === 'Minimum collateral ratio' &&
        reference.minRatioPercent !== undefined
      ) {
        return {
          ...param,
          value: formatPercent(reference.minRatioPercent, 0),
          onChain: true,
        };
      }
      if (
        param.label === 'Liquidation penalty' &&
        reference.liquidationPenaltyPercent !== undefined
      ) {
        return {
          ...param,
          value: formatPercent(reference.liquidationPenaltyPercent, 0),
          onChain: true,
        };
      }
    }
    return { ...param, onChain: false };
  });
}

/**
 * Protocol design parameters rendered as a definition grid. Shows live on-chain
 * values where available, otherwise the documented configuration with an honest
 * caption.
 */
export function ParametersPanel({ isLive, collaterals }: ParametersPanelProps) {
  const parameters = resolveParameters(isLive, collaterals);
  const anyOnChain = parameters.some((p) => p.onChain);

  return (
    <Card>
      <CardHeader>
        <CardTitle as="h2">Protocol parameters</CardTitle>
        <CardDescription>
          The rules that keep every vault solvent and the peg honest.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <dl className="grid gap-4 sm:grid-cols-2">
          {parameters.map((param) => (
            <div
              key={param.label}
              className="rounded-lg border border-border bg-card px-4 py-3.5"
            >
              <dt className="label-mono text-xs text-muted-foreground">
                {param.label}
              </dt>
              <dd className="nums mt-1 font-serif text-2xl font-semibold leading-none text-foreground">
                {param.value}
              </dd>
              {/* A second dd keeps the group valid: a dl may hold only dt and dd children. */}
              <dd className="mt-2 text-xs leading-relaxed text-muted-foreground">
                {param.detail}
              </dd>
            </div>
          ))}
        </dl>
        {!anyOnChain && (
          <p className="mt-4 text-xs text-muted-foreground">
            Design parameters, confirmed on-chain at launch.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
