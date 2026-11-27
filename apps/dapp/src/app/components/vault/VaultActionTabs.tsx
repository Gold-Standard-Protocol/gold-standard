import { Card, Tabs, TabsList, TabsTrigger, TabsContent } from '@goldstandard/ui';
import { useVaultContext, useVaultStateActions } from '@goldstandard/hooks';
import type { VaultActionType } from '@goldstandard/hooks';
import { VaultDepositForm } from './VaultDepositForm';
import { VaultMintForm } from './VaultMintForm';
import { VaultRepayForm } from './VaultRepayForm';
import { VaultWithdrawForm } from './VaultWithdrawForm';
import { VaultButton } from './VaultButton';

const tabs: { value: VaultActionType; label: string; hint: string }[] = [
	{
		value: 'deposit',
		label: 'Deposit',
		hint: 'Add tokenised gold to your vault as collateral.',
	},
	{
		value: 'mint',
		label: 'Mint',
		hint: 'Borrow GSUSD against your gold, up to a safe limit.',
	},
	{
		value: 'repay',
		label: 'Repay',
		hint: 'Return GSUSD to reduce your debt and lower liquidation risk.',
	},
	{
		value: 'withdraw',
		label: 'Withdraw',
		hint: 'Take back gold once your collateral ratio allows it.',
	},
];

export function VaultActionTabs() {
	const { state } = useVaultContext();
	const { setActiveTab } = useVaultStateActions();

	const activeHint = tabs.find((tab) => tab.value === state.activeTab)?.hint;

	return (
		<Card className="p-4 sm:p-5">
			<Tabs
				value={state.activeTab}
				onValueChange={(val) => setActiveTab(val as VaultActionType)}
				className="w-full"
			>
				<TabsList className="grid w-full grid-cols-4">
					{tabs.map(tab => (
						<TabsTrigger key={tab.value} value={tab.value}>
							{tab.label}
						</TabsTrigger>
					))}
				</TabsList>

				{activeHint && (
					<p
						className="mt-4 text-center text-xs leading-relaxed text-muted-foreground text-pretty"
						aria-live="polite"
					>
						{activeHint}
					</p>
				)}

				<TabsContent value="deposit" className="mt-5">
					<VaultDepositForm />
				</TabsContent>
				<TabsContent value="mint" className="mt-5">
					<VaultMintForm />
				</TabsContent>
				<TabsContent value="repay" className="mt-5">
					<VaultRepayForm />
				</TabsContent>
				<TabsContent value="withdraw" className="mt-5">
					<VaultWithdrawForm />
				</TabsContent>
			</Tabs>

			<div className="mt-5">
				<VaultButton />
			</div>
		</Card>
	);
}
