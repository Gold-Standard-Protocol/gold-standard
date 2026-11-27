import {
	ArrowDownTrayIcon,
	BanknotesIcon,
	ArrowPathIcon,
} from '@heroicons/react/24/outline';
import { type ComponentType, type SVGProps } from 'react';
import { cn } from '@goldstandard/ui';
import { useVaultContext } from '@goldstandard/hooks';
import { STEPS } from '../../content/site';

const STEP_ICONS: ComponentType<SVGProps<SVGSVGElement>>[] = [
	ArrowDownTrayIcon,
	BanknotesIcon,
	ArrowPathIcon,
];

interface VaultIntroProps {
	className?: string;
}

/**
 * Compact orientation banner shown at the top of the vault. Composes the three
 * canonical product steps from site content so a first-time user grasps the
 * deposit -> mint -> repay loop before they touch the form.
 */
export function VaultIntro({ className }: VaultIntroProps) {
	const { position } = useVaultContext();

	// Orientation is for newcomers, hide it once a vault is open.
	if (position.hasPosition) return null;

	return (
		<div
			className={cn(
				'rounded-xl border border-border bg-card/60 p-4 sm:p-5',
				className
			)}
		>
			<p className="label-mono text-xs text-primary">
				How your vault works
			</p>
			<ol className="mt-3 grid gap-3 sm:grid-cols-3">
				{STEPS.map((step, index) => {
					const Icon = STEP_ICONS[index] ?? ArrowDownTrayIcon;
					return (
						<li key={step.number} className="flex items-start gap-3">
							<span
								className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-gold-200 bg-gold-50 text-primary"
								aria-hidden
							>
								<Icon className="h-4 w-4" />
							</span>
							<span className="min-w-0">
								<span className="block text-sm font-semibold text-foreground">
									{step.title}
								</span>
								<span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground text-pretty">
									{step.detail}
								</span>
							</span>
						</li>
					);
				})}
			</ol>
		</div>
	);
}
