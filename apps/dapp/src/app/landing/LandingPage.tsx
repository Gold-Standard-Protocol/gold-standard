import { Hero } from './Hero';
import { TrustBar } from './TrustBar';
import { ReservesTeaser } from './ReservesTeaser';
import { HowItWorks } from './HowItWorks';
import { PegMechanisms } from './PegMechanisms';
import { CollateralStrip } from './CollateralStrip';
import { ForAgents } from './ForAgents';
import { Faq } from './Faq';
import { FinalCta } from './FinalCta';

/**
 * The marketing landing page. Proof comes first after the hero, because verifiable
 * backing is the product's argument; the mechanics follow. Every figure is live or
 * labelled Pre-launch. The hero paints immediately; each later section reveals once
 * on scroll.
 */
export default function LandingPage() {
  return (
    <div>
      <Hero />
      <TrustBar />
      <ReservesTeaser />
      <HowItWorks />
      <PegMechanisms />
      <CollateralStrip />
      <ForAgents />
      <Faq />
      <FinalCta />
    </div>
  );
}
