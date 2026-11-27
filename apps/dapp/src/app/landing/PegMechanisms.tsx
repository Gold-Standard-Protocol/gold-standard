import { Card, CardContent } from '@goldstandard/ui';
import { Reveal } from '../components/Reveal';
import { Section, SectionHeader } from '../components/marketing/Section';
import { PEG_MECHANISMS, type Mechanism } from '../content/site';

const LEAD_TITLE = 'Stability swap';

/** The reserve leads at full width: it is the mechanism no other gold stablecoin has. */
function LeadMechanism({ mechanism }: { mechanism: Mechanism }) {
  return (
    <Card className="relative overflow-hidden">
      <div aria-hidden className="gold-hairline absolute inset-x-8 top-0 rounded-full" />
      <CardContent className="grid gap-6 p-7 sm:p-8 lg:grid-cols-12 lg:gap-12">
        <div className="lg:col-span-5">
          <h3 className="font-serif text-2xl font-semibold tracking-tight text-foreground">{mechanism.title}</h3>
          <p className="mt-3 font-medium text-foreground">{mechanism.summary}</p>
        </div>
        <p className="text-[0.95rem] leading-relaxed text-muted-foreground lg:col-span-7">{mechanism.detail}</p>
      </CardContent>
    </Card>
  );
}

function SupportingMechanism({ mechanism }: { mechanism: Mechanism }) {
  return (
    <li className="border-t border-border pt-6">
      <h3 className="font-serif text-xl font-semibold tracking-tight text-foreground">{mechanism.title}</h3>
      <p className="mt-2 font-medium text-foreground">{mechanism.summary}</p>
      <p className="mt-3 text-[0.95rem] leading-relaxed text-muted-foreground">{mechanism.detail}</p>
    </li>
  );
}

/** The three forces that hold the GSUSD peg, weighted by how much each one is the point. */
export function PegMechanisms() {
  const lead = PEG_MECHANISMS.find((m) => m.title === LEAD_TITLE) ?? PEG_MECHANISMS[0];
  const supporting = PEG_MECHANISMS.filter((m) => m !== lead);

  return (
    <Section>
      <div className="container">
        <SectionHeader
          variant="broadsheet"
          title="What holds the peg"
          lead="Over-collateralisation and liquidation, the stability swap against a protocol-owned gold reserve and the stability fee keep GSUSD anchored to a dollar of gold."
        />
        <Reveal className="mt-12">
          <LeadMechanism mechanism={lead} />
          <ul className="mt-10 grid gap-8 sm:grid-cols-2">
            {supporting.map((mechanism) => (
              <SupportingMechanism key={mechanism.title} mechanism={mechanism} />
            ))}
          </ul>
        </Reveal>
      </div>
    </Section>
  );
}
