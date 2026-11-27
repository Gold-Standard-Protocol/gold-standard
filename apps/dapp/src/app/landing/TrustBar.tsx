import { cn } from '@goldstandard/ui';
import { Reveal } from '../components/Reveal';
import { TRUST_SIGNALS, type TrustSignal } from '../content/site';

function TrustItem({ signal, index }: { signal: TrustSignal; index: number }) {
  return (
    <li className={cn('relative', index > 0 && 'border-t border-border pt-8 sm:border-l sm:border-t-0 sm:pl-8 sm:pt-0')}>
      <h2 className="font-serif text-[1.05rem] font-semibold tracking-tight text-foreground">{signal.title}</h2>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{signal.detail}</p>
    </li>
  );
}

/** The four properties of the protocol a depositor relies on, each a fact of the design. */
export function TrustBar() {
  return (
    <section className="border-b border-border bg-card">
      <div className="container">
        <Reveal as="div">
          <ul className="grid grid-cols-2 gap-x-8 gap-y-8 py-12 sm:grid-cols-4 sm:gap-y-0 sm:py-14">
            {TRUST_SIGNALS.map((signal, index) => (
              <TrustItem key={signal.title} signal={signal} index={index} />
            ))}
          </ul>
        </Reveal>
      </div>
    </section>
  );
}
