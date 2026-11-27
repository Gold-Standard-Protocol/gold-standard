import { fireEvent, render, screen } from '@testing-library/react';
import { vi } from 'vitest';
import { CurrencyAmount, Token } from '@goldstandard/models';
import type { ApprovalFailure } from '@goldstandard/hooks';
import { TokenApproval } from './TokenApproval';

const token = new Token({
	chainId: 11155111,
	address: '0x00000000000000000000000000000000000000bb',
	decimals: 18,
	image: '',
	gold: false,
	priceApiId: '',
	symbol: 'GSUSD',
});
const amount = CurrencyAmount.fromRawAmount(token, (10n ** 18n).toString());

const approval = vi.hoisted(() => ({
	approve: vi.fn(),
	isAwaitingWallet: false,
	isProposed: false,
	failure: undefined as ApprovalFailure | undefined,
	isAllowanceUnread: false,
	/** Whether the hook has an approval it can send. */
	canApprove: true,
}));

vi.mock('@goldstandard/hooks', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@goldstandard/hooks')>();
	return {
		...actual,
		useTokenApproval: () => ({
			state: actual.ApprovalState.NOT_APPROVED,
			approve: approval.canApprove ? approval.approve : undefined,
			isAwaitingWallet: approval.isAwaitingWallet,
			isProposed: approval.isProposed,
			failure: approval.failure,
			isAllowanceUnread: approval.isAllowanceUnread,
		}),
	};
});

const renderGuard = () =>
	render(
		<TokenApproval amount={amount} enabled spender="0x00000000000000000000000000000000000000ee">
			<span>Deposit</span>
		</TokenApproval>
	);

describe('TokenApproval', () => {
	beforeEach(() => {
		approval.approve.mockClear();
		approval.isAwaitingWallet = false;
		approval.isProposed = false;
		approval.failure = undefined;
		approval.isAllowanceUnread = false;
		approval.canApprove = true;
	});

	it('shows the wallet wait and ignores clicks while the wallet holds the request', () => {
		approval.isAwaitingWallet = true;
		renderGuard();
		const button = screen.getByRole('button') as HTMLButtonElement;
		expect(button.textContent).toMatch(/Waiting for your wallet/);
		expect(button.disabled).toBe(true);
		fireEvent.click(button);
		expect(approval.approve).not.toHaveBeenCalled();
	});

	it('says the approval failed on chain after a reverted receipt', () => {
		approval.failure = { kind: 'reverted' };
		renderGuard();
		expect(screen.getByRole('alert').textContent).toMatch(/The approval failed on chain/);
	});

	it('explains a wallet or RPC failure in a sentence', () => {
		approval.failure = { kind: 'error', error: new Error('RPC unavailable\nstack detail') };
		renderGuard();
		expect(screen.getByRole('alert').textContent).toBe('RPC unavailable');
	});

	// A receipt wait that could not read the chain used to say the approval had
	// failed, under a live button, while it was still pending.
	it('says a sent approval may still go through when its receipt could not be read', () => {
		approval.failure = { kind: 'unconfirmed' };
		renderGuard();
		const alert = screen.getByRole('alert').textContent;
		expect(alert).toBe(
			'Chain read failed, retrying. The approval was sent and may still go through, so check your wallet before approving again.'
		);
		expect(alert).not.toMatch(/failed on chain|reverted/);
	});

	// A failed allowance read left "Approve GSUSD" disabled with no reason given.
	it('says why the button is disabled when the allowance could not be read', () => {
		approval.isAllowanceUnread = true;
		approval.canApprove = false;
		renderGuard();
		expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(true);
		expect(screen.getByRole('alert').textContent).toBe('GSUSD allowance read failed, retrying.');
	});

	it('shows no alert before anything has gone wrong', () => {
		renderGuard();
		expect(screen.queryByRole('alert')).toBeNull();
		expect(screen.queryByRole('status')).toBeNull();
		expect(screen.getByRole('button').textContent).toMatch(/Approve GSUSD/);
	});

	// Inside Safe{Wallet} the approval is a proposal the owners have yet to sign.
	it('says the approval is proposed to the Safe, under a button that stays live', () => {
		approval.isProposed = true;
		renderGuard();
		// The token is named: one guard serves a form whose token can change under the notice.
		expect(screen.getByRole('status').textContent?.replace(/\s+/g, ' ')).toBe(
			'Approval of GSUSD proposed to your Safe. The next step appears once the owners have signed and it has executed.'
		);
		expect(screen.queryByRole('alert')).toBeNull();
		const button = screen.getByRole('button') as HTMLButtonElement;
		expect(button.textContent).toMatch(/Approve GSUSD/);
		expect(button.disabled).toBe(false);
	});

	it('hides the proposal line while a new request is with the wallet', () => {
		approval.isProposed = true;
		approval.isAwaitingWallet = true;
		renderGuard();
		expect(screen.queryByRole('status')).toBeNull();
	});

	it('says the default approval is unlimited', () => {
		renderGuard();
		expect(
			screen.getByText('This approval is unlimited: the contract may move any amount of GSUSD from this wallet until you revoke it.')
		).toBeTruthy();
	});

	it('does not call an exact approval unlimited', () => {
		render(
			<TokenApproval amount={amount} enabled approveMax={false} spender="0x00000000000000000000000000000000000000ee">
				<span>Swap</span>
			</TokenApproval>
		);
		expect(screen.queryByText(/This approval is unlimited/)).toBeNull();
	});
});
