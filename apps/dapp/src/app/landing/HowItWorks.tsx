import { cn } from '@goldstandard/ui';
import { Reveal } from '../components/Reveal';
import { Section, SectionHeader } from '../components/marketing/Section';
import { STEPS, type Step } from '../content/site';

function StepColumn({ step, index }: { step: Step; index: number }) {
  return (
    <article
      className={cn(
        'relative pt-10 sm:pt-0',
        index > 0 && 'border-t border-border sm:border-l sm:border-t-0 sm:pl-10',
        index < STEPS.length - 1 && 'sm:pr-10'
      )}
    >
      <div className="flex items-baseline gap-4">
        <span className="nums font-serif text-5xl font-semibold leading-none text-foreground">{step.number}</span>
        <span aria-hidden className="h-px flex-1 translate-y-[-0.4rem] bg-border" />
      </div>
      <h3 className="mt-7 font-serif text-xl font-semibold tracking-tight text-foreground">{step.title}</h3>
      <p className="mt-3 text-[0.95rem] leading-relaxed text-muted-foreground">{step.detail}</p>
    </article>
  );
}

/** The three steps a borrower takes, numbered because they happen in this order. */
export function HowItWorks() {
  return (
    <Section surface>
      <div className="container">
        <SectionHeader
          variant="broadsheet"
          title="Three steps to a gold-backed dollar"
          lead="Custody stays with you at every step. Deposit gold, mint a dollar against it and exit whenever you choose."
        />
        <Reveal className="mt-16 grid gap-0 sm:grid-cols-3">
          {STEPS.map((step, index) => (
            <StepColumn key={step.number} step={step} index={index} />
          ))}
        </Reveal>
      </div>
    </Section>
  );
}
