import { ArrowTopRightOnSquareIcon } from '@heroicons/react/24/outline';
import { Card, CardContent } from '@goldstandard/ui';
import { GSUSD_BUY_URL } from '@goldstandard/constants';
import { OUTSIDE_MARKET_COPY } from '../../content/swap';

/**
 * The way to GSUSD for a visitor who holds none: the Uniswap page for the pool the build
 * names. A plain link to another site, opened in a new tab without a referrer; the dapp loads
 * nothing from there. A build that names no market renders nothing.
 */
export function OutsideMarketLink({ href = GSUSD_BUY_URL }: { href?: string | undefined }) {
  if (!href) return null;
  return (
    <Card data-outside-market>
      <CardContent className="flex flex-col gap-3 p-5 sm:flex-row sm:items-center sm:justify-between sm:gap-6 sm:p-6">
        <div className="min-w-0">
          <h2 className="text-sm font-medium text-foreground">{OUTSIDE_MARKET_COPY.title}</h2>
          <p className="mt-0.5 text-pretty text-sm leading-relaxed text-muted-foreground">{OUTSIDE_MARKET_COPY.detail}</p>
        </div>
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`${OUTSIDE_MARKET_COPY.link} ${OUTSIDE_MARKET_COPY.newTab}`}
          className="inline-flex min-h-11 shrink-0 items-center gap-1.5 self-start rounded-md text-sm font-medium text-primary underline underline-offset-4 outline-none transition-colors hover:text-gold-700 focus-visible:ring-2 focus-visible:ring-ring sm:self-center"
        >
          {OUTSIDE_MARKET_COPY.link}
          <ArrowTopRightOnSquareIcon aria-hidden className="h-3.5 w-3.5" />
        </a>
      </CardContent>
    </Card>
  );
}
