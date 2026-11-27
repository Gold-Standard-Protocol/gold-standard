import { type ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { HairlineArrow } from '../components/HairlineArrow';
import { Card, CardContent, buttonVariants, cn } from '@goldstandard/ui';
import { useProtocolStats, type ProtocolStatus } from '@goldstandard/hooks';
import { Reveal } from '../components/Reveal';
import { Section } from '../components/marketing/Section';
import { Metric } from '../components/Metric';
import { formatUsdCompact, formatTokenAmount, formatPercent } from '../lib/format';

/** The live value, or what stands in for it: Pre-launch before deploy, the failure when a read fails. */
function liveOr(status: ProtocolStatus, value: ReactNode | undefined): ReactNode {
  if (status === 'live' && value !== undefined) return value;
  if (status === 'error') {
    return (
      <span role="status" className="text-base font-normal text-muted-foreground">
        Chain read failed, retrying
      </span>
    );
  }
  return <span className="label-mono text-xs text-muted-foreground">{status === 'loading' ? 'Loading' : 'Pre-launch'}</span>;
}

/** Headline reserve metrics with a link through to the full transparency page. */
export function ReservesTeaser() {
  const { status, tvlUsd, gusdSupply, backingRatioPercent } = useProtocolStats();

  return (
    <Section>
      <div className="container">
        <Reveal>
          <Card className="overflow-hidden shadow-card">
            <CardContent className="flex flex-col gap-10 p-8 sm:p-10 lg:flex-row lg:items-center lg:justify-between">
              <div className="max-w-md">
                <h2 className="text-balance font-serif text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
                  Backing you can verify, block by block
                </h2>
                <p className="mt-4 text-pretty leading-relaxed text-muted-foreground">
                  Every GSUSD is over-collateralised by tokenised gold, and the full backing is verifiable on-chain at
                  any moment.
                </p>
                <NavLink to="/transparency" className={cn(buttonVariants({ variant: 'outline', size: 'lg' }), 'group mt-6 gap-2.5')}>
                  View full reserves
                  <HairlineArrow />
                </NavLink>
              </div>

              <div className="grid grid-cols-1 gap-6 sm:grid-cols-[repeat(3,max-content)] sm:gap-8 lg:shrink-0 lg:gap-10">
                <Metric
                  size="lg"
                  label="Total value locked"
                  info="USD value of all tokenised gold collateral held by the protocol."
                  value={liveOr(status, tvlUsd === undefined ? undefined : formatUsdCompact(tvlUsd))}
                />
                <Metric
                  size="lg"
                  label="GSUSD in circulation"
                  info="Outstanding GSUSD supply minted against gold collateral."
                  value={liveOr(status, gusdSupply === undefined ? undefined : formatTokenAmount(gusdSupply, 18, 0))}
                />
                <Metric
                  size="lg"
                  label="Backing ratio"
                  info="Collateral value divided by GSUSD outstanding. Above 100% means over-collateralised."
                  value={liveOr(status, backingRatioPercent === undefined ? undefined : formatPercent(backingRatioPercent))}
                />
              </div>
            </CardContent>
          </Card>
        </Reveal>
      </div>
    </Section>
  );
}
