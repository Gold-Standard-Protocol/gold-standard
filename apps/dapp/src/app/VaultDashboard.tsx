import { NavLink } from 'react-router-dom';
import {
	BuildingLibraryIcon,
	ScaleIcon,
} from '@heroicons/react/24/outline';
import { VaultProvider } from '@goldstandard/hooks';
import { VaultPositionCard } from './components/vault/VaultPositionCard';
import { VaultActionTabs } from './components/vault/VaultActionTabs';
import { VaultIntro } from './components/vault/VaultIntro';
import { VaultHistory } from './components/vault/VaultHistory';
import { Reveal } from './components/Reveal';
import { InfoTip } from './components/InfoTip';
import { SectionHeader } from './components/marketing/Section';

export default function VaultDashboard() {
	return (
		<div className="mx-auto w-full max-w-xl animate-rise">
			<header className="mb-6">
				<SectionHeader
					title="Your vault"
					lead="Deposit tokenised gold and mint GSUSD against it."
					as="h1"
					variant="stack"
					align="left"
				/>
				<p className="mt-3 flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground">
					<span className="text-pretty">
						Keep your collateral ratio healthy to avoid liquidation.
					</span>
					<InfoTip label="How your vault works">
						Your gold stays locked in a non-custodial contract while you hold
						the GSUSD you mint. Repay to release your gold at any time.
					</InfoTip>
				</p>

				<nav
					className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1.5 text-xs font-medium"
					aria-label="Vault resources"
				>
					<NavLink
						to="/transparency"
						className="inline-flex min-h-11 items-center gap-1.5 text-muted-foreground transition-colors hover:text-primary focus-visible:text-primary"
					>
						<BuildingLibraryIcon className="h-4 w-4" aria-hidden />
						Reserves
					</NavLink>
					<NavLink
						to="/vault/liquidate"
						className="inline-flex min-h-11 items-center gap-1.5 text-muted-foreground transition-colors hover:text-primary focus-visible:text-primary"
					>
						<ScaleIcon className="h-4 w-4" aria-hidden />
						Liquidate
					</NavLink>
				</nav>
			</header>

			<VaultProvider>
				<div className="flex w-full flex-col gap-5">
					<Reveal>
						<VaultIntro />
					</Reveal>
					<Reveal delay={40}>
						<VaultPositionCard />
					</Reveal>
					<VaultActionTabs />
					<Reveal delay={80}>
						<VaultHistory />
					</Reveal>
				</div>
			</VaultProvider>
		</div>
	);
}
