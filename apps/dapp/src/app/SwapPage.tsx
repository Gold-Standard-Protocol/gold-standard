import { useChainId } from 'wagmi';
import { Card, CardContent } from '@goldstandard/ui';
import { getDexConfig, getStabilityReserveContractConfig, type GoldVaultChainId } from '@goldstandard/constants';
import { Reveal } from './components/Reveal';
import { SectionHeader } from './components/marketing/Section';
import { SwapPanel } from './components/swap/SwapPanel';
import { swapPageCopy } from './content/swap';

export default function SwapPage() {
  const chainId = useChainId() as GoldVaultChainId;
  const reserveConfig = getStabilityReserveContractConfig(chainId);
  const dexConfig = getDexConfig(chainId);
  const anyVenue = Boolean(reserveConfig || dexConfig);
  // The words follow the routes this build offers (content/swap.ts).
  const copy = swapPageCopy(Boolean(dexConfig));

  return (
    <div className="mx-auto w-full max-w-2xl animate-rise">
      <div className="mb-6">
        <SectionHeader
          title={copy.title}
          lead={copy.lead}
          as="h1"
          variant="stack"
          align="left"
        />
      </div>

      <Reveal className="mb-6">
        <Card>
          <CardContent className="p-5 sm:p-6">
            <h2 className="label-mono mb-5 text-xs text-primary">
              How swapping works
            </h2>
            <ol className="space-y-4">
              {copy.points.map((point) => (
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

      {anyVenue ? (
        <Reveal delay={80}>
          <SwapPanel chainId={chainId} />
        </Reveal>
      ) : (
        <Reveal delay={80}>
          <Card>
            <CardContent className="p-5 sm:p-6">
              <p className="text-sm leading-relaxed text-muted-foreground">
                Swaps open with the protocol launch. Market quotes from Uniswap
                v3, the reserve&apos;s live spread and capacity, and your expected
                gold output will appear here once the contracts are deployed.
              </p>
            </CardContent>
          </Card>
        </Reveal>
      )}
    </div>
  );
}
