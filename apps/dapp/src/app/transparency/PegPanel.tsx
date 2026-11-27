import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Separator,
} from '@goldstandard/ui';
import { useGoldPrices } from '@goldstandard/hooks';
import { ScaleIcon } from '@heroicons/react/24/outline';
import { formatUsd } from '../lib/format';

interface PegRowProps {
  label: string;
  priceUsd: number | undefined;
  /** Said in place of the price when there is none: the cause, never a dash. */
  missing: string;
}

function GoldPriceRow({ label, priceUsd, missing }: PegRowProps) {
  return (
    <div className="flex items-center justify-between gap-3 py-2 text-sm">
      <span className="label-mono text-xs text-muted-foreground">
        {label}
      </span>
      <span className="inline-flex items-center gap-2">
        <span className="nums font-medium text-foreground">
          {priceUsd !== undefined ? (
            `${formatUsd(priceUsd)} / oz`
          ) : (
            <span className="font-normal text-muted-foreground">{missing}</span>
          )}
        </span>
        {priceUsd !== undefined && (
          <span className="label-mono text-xs text-primary">Live</span>
        )}
      </span>
    </div>
  );
}

/**
 * Explains the peg: GSUSD is convertible to protocol-owned gold at the Stability
 * Reserve's price, the oracle price minus a spread. The floor is exactly as deep
 * as the reserve, and the reserve is shown on this page. The $1.00 target is
 * real; the supporting gold prices are live.
 */
export function PegPanel() {
  const { paxg, xaut, isLoading } = useGoldPrices();
  const missing = isLoading ? 'Loading' : 'Price feed unavailable, retrying';

  return (
    <Card>
      <CardHeader>
        <CardTitle as="h2">The peg</CardTitle>
        <CardDescription>
          A protocol-owned gold reserve that holds GSUSD at a dollar of gold.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="rounded-xl border border-primary/20 bg-accent px-5 py-6 text-center">
          <span className="label-mono inline-flex items-center gap-1.5 text-xs text-primary">
            <ScaleIcon aria-hidden className="h-3.5 w-3.5" />
            Peg target
          </span>
          <p className="nums mt-2 font-serif text-4xl font-semibold leading-none text-foreground sm:text-5xl">
            1 GSUSD = $1.00
          </p>
        </div>

        <p className="text-pretty text-sm leading-relaxed text-muted-foreground">
          Anyone can swap GSUSD for protocol-owned gold in the Stability Reserve
          at the oracle price, minus a spread. That quote puts a floor under the
          price one spread-width below a dollar: if GSUSD trades beneath it,
          swapping is profitable and arbitrage pushes it back towards par. The
          floor is exactly as deep as the reserve, and the reserve is shown on
          this page. No borrower's vault is involved in any swap. The dollar is
          defined by gold, not by a balance sheet you cannot see.
        </p>

        <Separator />

        <div>
          <p className="label-mono mb-1 text-xs text-muted-foreground">
            Live gold reference
          </p>
          <GoldPriceRow label="Gold (PAXG)" priceUsd={paxg} missing={missing} />
          <GoldPriceRow label="Gold (XAUT)" priceUsd={xaut} missing={missing} />
        </div>
      </CardContent>
    </Card>
  );
}
