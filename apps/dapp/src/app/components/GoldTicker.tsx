import { useState } from 'react';
import { useCollateralParams, useGoldPrices } from '@goldstandard/hooks';
import { TARGET_CHAIN_ID, TOKEN_LIST } from '@goldstandard/constants';
import { type Address } from 'viem';
import { formatUsd } from '../lib/format';

/**
 * The primary gold collateral on the target chain, used to source the live risk
 * parameters below. TOKEN_LIST is ordered, so this is the headline collateral.
 */
const primaryGold = TOKEN_LIST.find(
  (t) => t.gold && !!t.addresses[TARGET_CHAIN_ID]
);

/**
 * A quiet, continuous tape of live gold prices and fixed protocol facts. Price
 * rows appear only when the oracle feed returns a value, so the tape never
 * shows a placeholder. The second track only fills the loop and is hidden from
 * assistive technology; the first carries the readable figures.
 */
export function GoldTicker() {
  const { paxg, xaut } = useGoldPrices();
  const [paused, setPaused] = useState(false);

  // Read live, never hardcode. These are governance-settable per collateral, and the
  // tape quoting "150%" while the vault enforced 130% told every visitor the wrong
  // number on the most prominent surface the protocol has. Same rule as the vault
  // forms: if the value is not available, the row is omitted rather than guessed.
  const params = useCollateralParams(
    TARGET_CHAIN_ID,
    primaryGold?.addresses[TARGET_CHAIN_ID] as Address | undefined
  );

  const items: string[] = [
    ...(paxg !== undefined ? [`PAXG ${formatUsd(paxg)} / oz`] : []),
    ...(xaut !== undefined ? [`XAUT ${formatUsd(xaut)} / oz`] : []),
    'Peg target $1.00',
    ...(params.minRatioPercent !== undefined
      ? [`Min collateral ${params.minRatioPercent}%`]
      : []),
    ...(params.liquidationRatioPercent !== undefined
      ? [`Liquidation ${params.liquidationRatioPercent}%`]
      : []),
    'Convertible via the Stability Reserve',
    'Non-custodial · on-chain',
  ];

  // Called as a function, not mounted as a component: a component declared inside render is a
  // new type on every render, so each price refresh would remount the tracks and restart the scroll.
  const renderTrack = (copy: 'reading' | 'decorative') => (
    <div
      className="animate-marquee flex shrink-0 items-center gap-12 px-6"
      aria-hidden={copy === 'decorative' ? true : undefined}
    >
      {items.map((t, i) => (
        <span key={i} className="flex items-center gap-12 whitespace-nowrap">
          <span className="nums label-mono text-xs text-foreground/65">{t}</span>
          <span className="h-3 w-px bg-primary/25" aria-hidden />
        </span>
      ))}
    </div>
  );

  return (
    <div className="relative">
    <div
      role="marquee"
      data-paused={paused || undefined}
      className="ticker relative flex w-full overflow-hidden border-t border-border bg-muted/50 py-3 [mask-image:linear-gradient(90deg,transparent,black_7%,black_93%,transparent)]"
      aria-label="Live gold prices and protocol parameters"
    >
      {renderTrack('reading')}
      {renderTrack('decorative')}
    </div>
      {/* WCAG 2.2.2: hover and focus pause the tape for a mouse or a
          keyboard; this pauses it on touch too. Reduced motion already stops it, so the
          control is hidden there. */}
      <button
        type="button"
        onClick={() => setPaused((current) => !current)}
        aria-label={paused ? 'Play the price tape' : 'Pause the price tape'}
        className="label-mono absolute right-[max(0.75rem,env(safe-area-inset-right))] top-1/2 -translate-y-1/2 rounded-sm border border-border bg-background px-2 py-1 text-xs text-muted-foreground transition-colors after:absolute after:-inset-2.5 after:content-[''] hover:text-foreground motion-reduce:hidden"
      >
        {paused ? 'Play' : 'Pause'}
      </button>
    </div>
  );
}
