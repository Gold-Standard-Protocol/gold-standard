import { type CSSProperties, type ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { Skeleton } from '@goldstandard/ui';
import { useGoldPrices, useProtocolStats } from '@goldstandard/hooks';
import { HairlineArrow } from '../components/HairlineArrow';
import { GoldTicker } from '../components/GoldTicker';
import { HERO } from '../content/site';
import { formatUsd, formatUsdCompact } from '../lib/format';

/** A single live statistic shown beneath the hero call to action. */
function HeroStat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 px-8 py-1 text-center">
      <span className="label-mono text-xs text-muted-foreground">{label}</span>
      <span className="nums font-serif text-xl font-semibold leading-none text-foreground">{children}</span>
    </div>
  );
}

/** What a statistic shows when its source has not answered: the cause, never a dash. */
function Unavailable({ children }: { children: ReactNode }) {
  return (
    <span role="status" className="text-sm font-normal text-muted-foreground">
      {children}
    </span>
  );
}

/**
 * Landing hero: a typography-led statement on warm paper, at rest from the first paint
 * (no load animation). Prices and
 * the peg target are real; backing reads Pre-launch until the contracts are deployed and
 * names the failure when a feed does not answer.
 */
export function Hero() {
  const { paxg, isLoading: pricesLoading, isError: pricesError } = useGoldPrices();
  const { tvlUsd, status } = useProtocolStats();

  return (
    <section className="relative isolate overflow-hidden border-b border-border bg-background">
      {/* Atmosphere: the engraved guilloche and paper grain. */}
      <div aria-hidden className="pointer-events-none absolute inset-0">
        <div className="bg-guilloche absolute left-1/2 top-1/2 h-[34rem] w-[34rem] -translate-x-1/2 -translate-y-1/2 opacity-[0.06] [mask-image:radial-gradient(closest-side,black,transparent)]" />
        <div className="grain absolute inset-0" />
      </div>

      <div className="container relative">
        <div className="mx-auto flex max-w-3xl flex-col items-center pb-16 pt-20 text-center sm:pb-20 sm:pt-28">
          <h1
            className="text-balance font-serif font-semibold leading-[1.03] tracking-[-0.02em] text-foreground"
            style={{ fontSize: 'var(--step-display)' }}
          >
            <span className="line-mask">
              <span className="line-inner" style={{ '--i': 0 } as CSSProperties}>
                The dollar,
              </span>
            </span>
            <span className="line-mask">
              <span className="line-inner" style={{ '--i': 1 } as CSSProperties}>
                <span className="text-gold-leaf headline-gold">back on the gold standard.</span>
              </span>
            </span>
          </h1>

          <p
            className="mt-7 max-w-2xl text-pretty text-[1.075rem] leading-relaxed text-muted-foreground"
          >
            {HERO.subtitle}
          </p>

          <div
            className="mt-9 flex flex-col items-center gap-3 sm:flex-row"
          >
            <NavLink
              to={HERO.primaryCta.to}
              className="sheen group inline-flex min-h-11 items-center gap-2.5 rounded-xl bg-gradient-to-b from-gold-700 to-gold-800 px-6 py-3.5 text-sm font-semibold tracking-tight text-gold-50 shadow-gold ring-1 ring-inset ring-gold-300/40"
            >
              {HERO.primaryCta.label}
              <HairlineArrow />
            </NavLink>
            <NavLink
              to={HERO.secondaryCta.to}
              className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-border bg-card px-6 py-3.5 text-sm font-semibold tracking-tight text-foreground transition-colors hover:border-primary/30 hover:bg-accent"
            >
              {HERO.secondaryCta.label}
            </NavLink>
          </div>

          <div
            className="relative mt-14 flex flex-col items-stretch divide-y divide-border overflow-hidden rounded-2xl border border-border bg-card shadow-card sm:flex-row sm:divide-x sm:divide-y-0"
          >
            <div aria-hidden className="gold-hairline absolute inset-x-10 top-0" />
            <HeroStat label="Market price (PAXG)">
              {pricesLoading ? (
                <Skeleton className="h-5 w-20" />
              ) : pricesError || paxg === undefined ? (
                <Unavailable>Price feed unavailable, retrying</Unavailable>
              ) : (
                <>
                  {formatUsd(paxg)}
                  <span className="ml-1 text-sm font-normal text-muted-foreground">/oz</span>
                </>
              )}
            </HeroStat>
            <HeroStat label="Peg target">$1.00</HeroStat>
            <HeroStat label="Value locked">
              {status === 'live' && tvlUsd !== undefined ? (
                formatUsdCompact(tvlUsd)
              ) : status === 'error' ? (
                <Unavailable>Chain read failed, retrying</Unavailable>
              ) : status === 'loading' ? (
                <Skeleton className="h-5 w-20" />
              ) : (
                <span className="label-mono text-xs text-muted-foreground">Pre-launch</span>
              )}
            </HeroStat>
          </div>
        </div>
      </div>

      <GoldTicker />
    </section>
  );
}
