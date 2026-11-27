import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { FramedNotice, framingVerdict } from './frameGuard';

const parent = {};
const self = {};

/** A window as framingVerdict sees it: framed or not, with or without ancestorOrigins. */
function view(framed: boolean, ancestors?: string[]) {
	return {
		self,
		top: framed ? parent : self,
		location: ancestors === undefined ? {} : { ancestorOrigins: Object.assign([...ancestors], { length: ancestors.length }) },
	};
}

describe('framingVerdict', () => {
	it('lets the top window through', () => {
		expect(framingVerdict(view(false, []), '')).toBe('top');
	});

	it('trusts Safe{Wallet} as the only ancestor', () => {
		expect(framingVerdict(view(true, ['https://app.safe.global']), '')).toBe('trusted');
	});

	it('refuses any other parent, lookalikes included', () => {
		for (const origin of ['https://evil.example', 'https://app.safe.global.evil.example', 'http://app.safe.global', 'null']) {
			expect(framingVerdict(view(true, [origin]), 'https://app.safe.global/')).toBe('untrusted');
		}
	});

	it('refuses Safe{Wallet} when it is itself framed by another page', () => {
		expect(framingVerdict(view(true, ['https://app.safe.global', 'https://evil.example']), '')).toBe('untrusted');
	});

	it('falls back to the referrer where ancestorOrigins does not exist (Firefox)', () => {
		expect(framingVerdict(view(true), 'https://app.safe.global/apps/open?safe=sep:0x1')).toBe('trusted');
		expect(framingVerdict(view(true), 'https://evil.example/page')).toBe('untrusted');
	});

	it('does not trust a frame with no referrer', () => {
		expect(framingVerdict(view(true), '')).toBe('untrusted');
	});

	it('treats a window whose top cannot be compared as framed', () => {
		const hostile = {
			self,
			get top(): unknown {
				throw new Error('blocked');
			},
			location: {},
		};
		expect(framingVerdict(hostile, '')).toBe('untrusted');
	});
});

describe('FramedNotice', () => {
	it('offers only a way to open the dapp directly, in a new tab without an opener', () => {
		render(<FramedNotice href="https://goldstandard.finance/vault" />);
		expect(screen.getByRole('heading', { name: 'Open Gold Standard in its own tab' })).toBeTruthy();
		const link = screen.getByRole('link', { name: 'Open Gold Standard directly' });
		expect(link.getAttribute('href')).toBe('https://goldstandard.finance/vault');
		expect(link.getAttribute('target')).toBe('_blank');
		expect(link.getAttribute('rel')).toBe('noopener noreferrer');
		expect(screen.queryAllByRole('button')).toEqual([]);
	});
});
