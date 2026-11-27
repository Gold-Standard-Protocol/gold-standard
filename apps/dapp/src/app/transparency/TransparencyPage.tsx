import { useProtocolStats, type ProtocolStatus } from '@goldstandard/hooks';
import { Reveal } from '../components/Reveal';
import { SectionHeader } from '../components/marketing/Section';
import { ReserveHeadline } from './ReserveHeadline';
import { CollateralBreakdown } from './CollateralBreakdown';
import { PegPanel } from './PegPanel';
import { ParametersPanel } from './ParametersPanel';
import { RevenuePanel } from './RevenuePanel';
import { StabilityReservePanel } from './StabilityReservePanel';
import { ContractsPanel } from './ContractsPanel';
import { listedCollaterals } from './listedCollaterals';

function Status({ status, paused }: { status: ProtocolStatus; paused: boolean | undefined }) {
  let text: string;
  if (paused) {
    text = 'Paused';
  } else if (status === 'live') {
    text = 'Live';
  } else if (status === 'error') {
    text = 'Chain read failed, retrying';
  } else if (status === 'loading') {
    text = 'Loading';
  } else {
    text = 'Pre-launch';
  }
  return (
    <span role="status" className={`label-mono text-xs ${paused ? 'text-warning' : 'text-muted-foreground'}`}>
      {text}
    </span>
  );
}

/**
 * Proof-of-reserves dashboard. Reads protocol stats once and passes honest
 * slices to each panel. Gold prices and the dollar peg target are real; backing
 * and TVL render explicit pre-launch states until the contracts are deployed.
 */
export default function TransparencyPage() {
  const stats = useProtocolStats();
  const collaterals = listedCollaterals(stats.collaterals);

  return (
    <div className="mx-auto w-full max-w-5xl">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <SectionHeader
          title="Proof of reserves"
          lead="Every GSUSD is backed by tokenised gold you can verify on-chain, block by block."
          as="h1"
          variant="stack"
          align="left"
        />
        <div className="pt-1">
          <Status status={stats.status} paused={stats.paused} />
        </div>
      </div>

      <div className="mt-8 space-y-6">
        <Reveal as="section" delay={60}>
          <ReserveHeadline
            isDeployed={stats.isDeployed}
            tvlUsd={stats.tvlUsd}
            gusdSupply={stats.gusdSupply}
            backingRatioPercent={stats.backingRatioPercent}
          />
        </Reveal>

        <Reveal as="section" delay={120}>
          <CollateralBreakdown
            collaterals={collaterals}
            tvlUsd={stats.tvlUsd}
            status={stats.status}
          />
        </Reveal>

        <div className="grid gap-6 lg:grid-cols-2">
          <Reveal as="section" delay={180}>
            <PegPanel />
          </Reveal>
          <Reveal as="section" delay={240}>
            <ParametersPanel
              isLive={stats.status === 'live'}
              collaterals={collaterals}
            />
          </Reveal>
        </div>

        <Reveal as="section" delay={300}>
          <StabilityReservePanel />
        </Reveal>

        <Reveal as="section" delay={330}>
          <RevenuePanel />
        </Reveal>

        <Reveal as="section" delay={360}>
          <ContractsPanel />
        </Reveal>
      </div>
    </div>
  );
}
