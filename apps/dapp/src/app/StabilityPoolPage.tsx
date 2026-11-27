import { Card, CardContent } from '@goldstandard/ui';
import { Reveal } from './components/Reveal';
import { SectionHeader } from './components/marketing/Section';
import { PoolPositionCard } from './components/pool/PoolPositionCard';
import { PoolActionTabs } from './components/pool/PoolActionTabs';

interface PoolPoint {
  numeral: string;
  title: string;
  detail: string;
}

const HOW_IT_WORKS: PoolPoint[] = [
  {
    numeral: '01',
    title: 'Deposits absorb liquidated debt',
    detail:
      'When a vault is liquidated through the pool, GSUSD from pool deposits is used to cancel the vault debt. No outside capital is needed.',
  },
  {
    numeral: '02',
    title: 'Deposits are drawn down',
    detail:
      'Your deposit shrinks in proportion to your share of the pool each time a liquidation is absorbed. A stability pool deposit is at risk and is not a savings balance.',
  },
  {
    numeral: '03',
    title: 'Seized gold is credited as gains',
    detail:
      'In exchange, the seized gold collateral is distributed to depositors as liquidation collateral gains, which you can claim at any time.',
  },
];

export default function StabilityPoolPage() {
  return (
    <div className="mx-auto w-full max-w-2xl animate-rise">
      <div className="mb-6">
        <SectionHeader
          title="Stability pool"
          lead="Deposit GSUSD to absorb liquidated debt and receive liquidation collateral gains in tokenised gold."
          as="h1"
          variant="stack"
          align="left"
        />
      </div>

      <Reveal className="mb-6">
        <Card>
          <CardContent className="p-5 sm:p-6">
            <h2 className="label-mono mb-5 text-xs text-primary">
              How the pool works
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
            <p className="mt-5 border-t border-border pt-4 text-pretty text-xs leading-relaxed text-muted-foreground">
              Liquidation collateral gains depend entirely on liquidations
              occurring. The protocol promises no yield and quotes no rate of
              return.
            </p>
          </CardContent>
        </Card>
      </Reveal>

      <Reveal className="mb-6" delay={80}>
        <PoolPositionCard />
      </Reveal>

      <Reveal delay={120}>
        <PoolActionTabs />
      </Reveal>
    </div>
  );
}
