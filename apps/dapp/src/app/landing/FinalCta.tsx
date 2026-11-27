import { NavLink } from 'react-router-dom';
import { buttonVariants, cn } from '@goldstandard/ui';
import { Reveal } from '../components/Reveal';
import { Section } from '../components/marketing/Section';
import { HERO } from '../content/site';

/** Closing invitation: a plain text band, the same two actions as the hero, no second atmosphere. */
export function FinalCta() {
  return (
    <Section>
      <div className="container">
        <Reveal className="mx-auto flex max-w-2xl flex-col items-center border-t border-border pt-16 text-center">
          <h2 className="text-balance font-serif text-3xl font-semibold tracking-tight text-foreground sm:text-5xl">
            Bring your gold on-chain.
          </h2>
          <p className="mt-4 max-w-xl text-pretty text-lg leading-relaxed text-muted-foreground">
            Open a vault, mint a dollar that is over-collateralised by tokenised gold, and keep custody of your collateral throughout.
          </p>
          <div className="mt-9 flex flex-col items-center gap-3 sm:flex-row">
            <NavLink to={HERO.primaryCta.to} className={cn(buttonVariants({ size: 'lg' }), 'shadow-gold')}>
              {HERO.primaryCta.label}
            </NavLink>
            <NavLink to={HERO.secondaryCta.to} className={buttonVariants({ variant: 'outline', size: 'lg' })}>
              {HERO.secondaryCta.label}
            </NavLink>
          </div>
        </Reveal>
      </div>
    </Section>
  );
}
