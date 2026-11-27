import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { TERMS_COPY } from '../content/terms';
import TermsPage from './TermsPage';

afterEach(cleanup);

const open = () =>
	render(
		<MemoryRouter initialEntries={['/terms']}>
			<TermsPage />
		</MemoryRouter>
	);

describe('TermsPage', () => {
	it('opens with one first level heading and its six sections in order', () => {
		open();
		expect(screen.getByRole('heading', { level: 1, name: 'Terms' })).toBeTruthy();
		expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
		expect(screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent)).toEqual([
			'What the software is',
			'What GSUSD is not',
			'Risks',
			'Use at your own risk',
			'The Usage Ledger',
			'License',
		]);
	});

	it('shows the Usage Ledger clause in the policy wording, as plain text', () => {
		open();
		const clause = screen.getByTestId('terms-ledger-clause');
		expect(clause.textContent).toBe('No token exists, no token is promised, the ledger confers no rights and may never confer any.');
		expect(clause.closest('details, [role="tooltip"], [aria-expanded]')).toBeNull();
	});

	it('shows every statement of the content file', () => {
		const { container } = open();
		const text = container.textContent ?? '';
		const { software, isNot, risks, ownRisk, license, ledger } = TERMS_COPY;
		for (const statement of ownRisk.statements) expect(text).toContain(statement);
		for (const statement of [...software.statements, ...license.statements, ...ledger.statements, isNot.after, risks.lead, risks.others]) {
			expect(text).toContain(statement.text);
		}
		for (const item of isNot.items) expect(text).toContain(item);
		for (const risk of risks.items) expect(text).toContain(`${risk.name} ${risk.text}`);
		expect(screen.getAllByRole('listitem')).toHaveLength(isNot.items.length + risks.items.length);
	});

	it('states the software as pre-launch in a build that is not for mainnet, as the security page does', () => {
		const { container } = open();
		expect(container.textContent).toContain(
			'This is experimental, pre-launch software. Interacting with it carries the risks above and others.'
		);
	});

	it('links to the pages the security page names and to the security page, and to the ledger only in a build that has it', () => {
		open();
		expect(screen.getByRole('link', { name: 'Governance' }).getAttribute('href')).toBe('/docs/governance');
		expect(screen.getByRole('link', { name: 'Oracle' }).getAttribute('href')).toBe('/docs/oracle');
		expect(screen.getByRole('link', { name: 'Risk parameters' }).getAttribute('href')).toBe('/docs/parameters');
		expect(screen.getByRole('link', { name: 'Security' }).getAttribute('href')).toBe('/docs/security');
		// The tests run without VITE_LEDGER_ENABLED, so the page that is not in the build is not linked.
		expect(screen.queryByRole('link', { name: 'Usage Ledger' })).toBeNull();
	});

	it('has nothing to fill in or agree to', () => {
		const { container } = open();
		expect(container.querySelectorAll('input, button, form, select, textarea')).toHaveLength(0);
	});
});
