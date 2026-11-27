import { NavLink } from 'react-router-dom';
import { buttonVariants } from '@goldstandard/ui';
import { Reveal } from '../components/Reveal';
import { Section, SectionHeader } from '../components/marketing/Section';
import { AGENTS, type AgentPoint } from '../content/site';

function Point({ point }: { point: AgentPoint }) {
  return (
    <li className="border-t border-border pt-6">
      <h3 className="font-serif text-xl font-semibold tracking-tight text-foreground">{point.title}</h3>
      <p className="mt-3 text-[0.95rem] leading-relaxed text-muted-foreground">{point.detail}</p>
    </li>
  );
}

/**
 * The agent story: three verbs on hairlines, the same list form as the peg mechanisms, and
 * two plain links. No icons and no new accent: the claim is that the protocol needs no
 * interface, so the section does not dress one up.
 */
export function ForAgents() {
  return (
    <Section>
      <div className="container">
        <SectionHeader variant="broadsheet" title={AGENTS.title} lead={AGENTS.lead} />
        <Reveal className="mt-14">
          <ul className="grid gap-x-10 gap-y-8 sm:grid-cols-3">
            {AGENTS.points.map((point) => (
              <Point key={point.title} point={point} />
            ))}
          </ul>
          <div className="mt-12 flex flex-col items-start gap-3 sm:flex-row sm:items-center">
            <NavLink to={AGENTS.cta.to} className={buttonVariants({ variant: 'outline', size: 'lg' })}>
              {AGENTS.cta.label}
            </NavLink>
            <a
              className="label-mono inline-flex min-h-11 items-center text-xs text-muted-foreground underline underline-offset-4 transition-colors hover:text-foreground"
              href={AGENTS.manifest.href}
            >
              {AGENTS.manifest.label}
            </a>
          </div>
        </Reveal>
      </div>
    </Section>
  );
}
