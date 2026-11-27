import { useChainId } from 'wagmi';
import { Card, CardContent } from '@goldstandard/ui';
import { getDexConfig, getStabilityReserveContractConfig, type GoldVaultChainId } from '@goldstandard/constants';
import { Reveal } from './components/Reveal';
import { SectionHeader } from './components/marketing/Section';
import { SwapPanel } from './components/swap/SwapPanel';

interface SwapPoint {
  numeral: string;
  title: string;
  detail: string;
}

const HOW_IT_WORKS: SwapPoint[] = [
  {
    numeral: '01',
    title: 'Market swap: the everyday route',
    detail:
      'GSUSD trades against PAXG on Uniswap v3, in either direction, at whatever the pool will pay. XAUT joins once governance activates it and a pool exists. The pool fee goes to whoever provides liquidity at the traded price, and the protocol earns a share only through liquidity positions it owns.',
  },
  {
    numeral: '02',
    title: 'The reserve holds the floor',
    detail:
      'The Gold Stability Reserve pays gold at the oracle price minus a spread that starts at 0.5% and rises as coverage falls, never above 5%. It exists so that anyone can buy GSUSD below par and swap it for gold here, which pulls the market back to par. At par the market will usually pay more. The reserve is sized to hold that floor, not to be the exit for freshly minted GSUSD: minting against gold and draining the reserve with it would leave nothing for the arbitrage that keeps the peg.',
  },
  {
    numeral: '03',
    title: 'No vault is ever touched',
    detail:
      'A market swap trades against pooled liquidity. A reserve swap draws only on protocol-owned gold, up to its available capacity for the day. Borrowers keep every gram of their collateral: the only thing that can move a vault is its owner, or a liquidation below the threshold.',
  },
];

export default function SwapPage() {
  const chainId = useChainId() as GoldVaultChainId;
  const reserveConfig = getStabilityReserveContractConfig(chainId);
  const dexConfig = getDexConfig(chainId);
  const anyVenue = Boolean(reserveConfig || dexConfig);

  return (
    <div className="mx-auto w-full max-w-2xl animate-rise">
      <div className="mb-6">
        <SectionHeader
          title="Swap GSUSD and gold"
          lead="Trade GSUSD against tokenised gold on the open market through Uniswap v3. The Gold Stability Reserve sits alongside as the arbitrage floor that holds the peg."
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
