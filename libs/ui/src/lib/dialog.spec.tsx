import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './dialog';

function renderOpenDialog() {
	return render(
		<Dialog open>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Title</DialogTitle>
					<DialogDescription>Body</DialogDescription>
				</DialogHeader>
			</DialogContent>
		</Dialog>
	);
}

const MOTION_UTILITY = /(^|:)(animate-(in|out)|fade-(in|out)|zoom-(in|out)|slide-(in|out))/;

function unguardedMotionClasses(element: Element): string[] {
	return element.className
		.split(/\s+/)
		.filter((token) => MOTION_UTILITY.test(token) && !token.split(':').includes('motion-safe'));
}

describe('Dialog motion', () => {
	it('gates every overlay animation utility behind motion-safe', () => {
		renderOpenDialog();
		const overlay = document.querySelector('[data-state="open"].fixed.inset-0');
		expect(overlay).not.toBeNull();
		expect(overlay?.className).toContain('motion-safe:data-[state=open]:animate-in');
		expect(unguardedMotionClasses(overlay as Element)).toEqual([]);
	});

	it('gates every content animation utility behind motion-safe', () => {
		renderOpenDialog();
		const content = screen.getByRole('dialog');
		expect(content.className).toContain('motion-safe:data-[state=closed]:animate-out');
		expect(unguardedMotionClasses(content)).toEqual([]);
	});

	it('keeps the closed state classes so a motion-safe exit still plays and an unanimated one unmounts', () => {
		renderOpenDialog();
		const content = screen.getByRole('dialog').className;
		for (const state of ['open', 'closed']) {
			expect(content).toContain(`data-[state=${state}]`);
		}
	});
});

describe('Dialog close control', () => {
	it('is a 44px target with a 16px icon, a focus ring and a screen reader label', () => {
		renderOpenDialog();
		const close = screen.getByRole('button', { name: 'Close' });
		const tokens = close.className.split(/\s+/);
		expect(tokens).toEqual(expect.arrayContaining(['inline-flex', 'h-11', 'w-11', 'items-center', 'justify-center']));
		expect(tokens).toEqual(expect.arrayContaining(['focus:ring-2', 'focus:ring-ring']));
		expect(tokens).not.toContain('right-4');
		const icon = close.querySelector('svg');
		expect(icon?.getAttribute('class')).toContain('h-4');
		expect(icon?.getAttribute('class')).toContain('w-4');
		expect(close.querySelector('.sr-only')?.textContent).toBe('Close');
	});
});

/** Model the opening frame before Radix's document Escape listener is registered. */
function renderBeforeEscapeListener(children: ReactNode) {
	const add = document.addEventListener.bind(document);
	const registration = vi.spyOn(document, 'addEventListener').mockImplementation((type, listener, options) => {
		if (type === 'keydown' && typeof options === 'object' && options.capture) return;
		add(type, listener, options);
	});
	try { return render(children); } finally { registration.mockRestore(); }
}

describe('Dialog Escape during opening', () => {
	it('closes from the focused dialog even before document listener registration', () => {
		const changed = vi.fn();
		renderBeforeEscapeListener(<Dialog defaultOpen onOpenChange={changed}>
			<DialogContent><DialogTitle>Review</DialogTitle><DialogDescription>Check it</DialogDescription><button>Action</button></DialogContent>
		</Dialog>);
		fireEvent.keyDown(screen.getByRole('button', { name: 'Action' }), { key: 'Escape' });
		expect(changed).toHaveBeenCalledExactlyOnceWith(false);
	});

	it('respects a caller that prevents dismissal', () => {
		const changed = vi.fn();
		renderBeforeEscapeListener(<Dialog defaultOpen onOpenChange={changed}>
			<DialogContent onEscapeKeyDown={event => event.preventDefault()}>
				<DialogTitle>Review</DialogTitle><DialogDescription>Check it</DialogDescription><button>Action</button>
			</DialogContent>
		</Dialog>);
		fireEvent.keyDown(screen.getByRole('button', { name: 'Action' }), { key: 'Escape' });
		expect(changed).not.toHaveBeenCalled();
		expect(screen.getByRole('dialog')).toBeTruthy();
	});

	it('closes only the nested dialog that contains focus', () => {
		const outer = vi.fn();
		const inner = vi.fn();
		renderBeforeEscapeListener(<Dialog defaultOpen onOpenChange={outer}>
			<DialogContent><DialogTitle>Outer</DialogTitle><DialogDescription>Outer body</DialogDescription>
				<Dialog defaultOpen onOpenChange={inner}><DialogContent>
					<DialogTitle>Inner</DialogTitle><DialogDescription>Inner body</DialogDescription><button>Inner action</button>
				</DialogContent></Dialog>
			</DialogContent>
		</Dialog>);
		fireEvent.keyDown(screen.getByRole('button', { name: 'Inner action' }), { key: 'Escape' });
		expect(inner).toHaveBeenCalledExactlyOnceWith(false);
		expect(outer).not.toHaveBeenCalled();
	});
});
