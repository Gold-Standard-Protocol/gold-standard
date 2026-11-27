import { render } from '@testing-library/react';
import { Callout, DocTable, tableName } from './DocComponents';

describe('DocTable', () => {
	it('wraps the table in a named, focusable scroll region', () => {
		const { getByRole } = render(<DocTable head={['Parameter', 'Default', 'Description']} rows={[['a', 'b', 'c']]} />);
		const region = getByRole('region', { name: 'Table of Parameter, Default and Description' });
		expect(region.tabIndex).toBe(0);
		expect(region.querySelector('table')).not.toBeNull();
	});

	it('prefers an explicit label', () => {
		const { getByRole } = render(<DocTable head={['Term', 'Meaning']} rows={[]} label="Glossary, D to L" />);
		expect(getByRole('region', { name: 'Glossary, D to L' })).toBeTruthy();
	});

	it('gives a blank first column header a visually hidden name', () => {
		const { getAllByRole } = render(<DocTable head={['', 'PAXG', 'XAUT']} rows={[['Decimals', '18', '6']]} />);
		const headers = getAllByRole('columnheader');
		expect(headers).toHaveLength(3);
		expect(headers[0].textContent).toBe('Property');
		expect(headers[0].querySelector('.sr-only')).not.toBeNull();
		for (const header of headers) expect(header.getAttribute('scope')).toBe('col');
	});
});

describe('tableName', () => {
	it('ignores blank and non-string headers', () => {
		expect(tableName(['', 'PAXG', 'XAUT'])).toBe('Table of PAXG and XAUT');
		expect(tableName([<strong key="k">Constraint</strong>, 'Value'])).toBe('Table of Value');
		expect(tableName([])).toBe('Table');
	});
});

describe('Callout', () => {
	it('sets the body in the stronger secondary ink so it clears 4.5:1 on every fill', () => {
		for (const variant of ['note', 'tip', 'warning', 'danger'] as const) {
			const { container, unmount } = render(
				<Callout variant={variant}>
					<p>body</p>
				</Callout>
			);
			const body = container.querySelector('.callout-body');
			expect(body, variant).not.toBeNull();
			expect(body?.className, variant).not.toContain('text-muted-foreground');
			unmount();
		}
	});
});
