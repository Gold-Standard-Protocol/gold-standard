import { ChevronDownIcon } from '@heroicons/react/24/outline';
import { Section, SectionHeader } from '../components/marketing/Section';
import { Reveal } from '../components/Reveal';
import { FAQ, type FaqItem } from '../content/site';

function FaqEntry({ item }: { item: FaqItem }) {
  return (
    <details className="group border-b border-border">
      <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-4 py-5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
        <span className="font-serif text-lg font-medium tracking-tight text-foreground">{item.question}</span>
        <ChevronDownIcon
          aria-hidden
          className="h-5 w-5 shrink-0 text-muted-foreground transition-transform duration-200 group-open:rotate-180"
        />
      </summary>
      <p className="pb-5 pr-9 text-pretty leading-relaxed text-muted-foreground">{item.answer}</p>
    </details>
  );
}

/** Questions depositors ask, on native details/summary so the keyboard and screen readers get them for free. */
export function Faq() {
  return (
    <Section surface>
      <div className="container">
        <SectionHeader title="Frequently asked" />
        <Reveal className="mt-10 max-w-3xl border-t border-border">
          {FAQ.map((item) => (
            <FaqEntry key={item.question} item={item} />
          ))}
        </Reveal>
      </div>
    </Section>
  );
}
