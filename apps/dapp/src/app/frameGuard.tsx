import { buttonVariants, cn } from '@goldstandard/ui';

/**
 * The Safe{Wallet} web app is the only parent that may frame the dapp, and the only one
 * the Safe connector trusts. Without that list the Safe Apps SDK accepts messages from any
 * origin, and Wagmi's reconnect would then let any page framing the dapp present an
 * account of its choosing.
 */
export const SAFE_ALLOWED_ORIGINS: readonly RegExp[] = [/^https:\/\/app\.safe\.global$/];

export const isTrustedFrameParent = (origin: string): boolean =>
	SAFE_ALLOWED_ORIGINS.some((pattern) => pattern.test(origin));

/** Whether the page is the top window, framed by Safe{Wallet}, or framed by anything else. */
export type FramingVerdict = 'top' | 'trusted' | 'untrusted';

interface FramedView {
	self: unknown;
	top: unknown;
	location: { ancestorOrigins?: { readonly length: number; readonly [index: number]: string } };
}

function originOf(url: string): string | undefined {
	try {
		return new URL(url).origin;
	} catch {
		return undefined;
	}
}

/**
 * Who is framing the page. On IPFS gateways, ENS gateways and
 * the DNS mirror no response header can set frame-ancestors, and a meta tag cannot express
 * it, so any page could frame the dapp and dress its controls up as something else.
 *
 * Chrome and Safari list every ancestor in location.ancestorOrigins; each one must be the
 * Safe web app. Firefox has no such list, so the referrer, which is the page that loaded
 * this frame, stands in for it; a frame with no referrer is not trusted. Pure and exported
 * for tests.
 */
export function framingVerdict(view: FramedView, referrer: string): FramingVerdict {
	let framed: boolean;
	try {
		framed = view.self !== view.top;
	} catch {
		framed = true;
	}
	if (!framed) return 'top';

	const ancestors = view.location.ancestorOrigins;
	if (ancestors && ancestors.length > 0) {
		for (let i = 0; i < ancestors.length; i++) {
			if (!isTrustedFrameParent(ancestors[i])) return 'untrusted';
		}
		return 'trusted';
	}
	const parent = originOf(referrer);
	return parent !== undefined && isTrustedFrameParent(parent) ? 'trusted' : 'untrusted';
}

/**
 * What a page framed by anything but Safe{Wallet} shows instead of the app: no wallet
 * connection, no forms, only a way out to the dapp in its own tab.
 */
export function FramedNotice({ href }: { href: string }) {
	return (
		<main className="flex min-h-screen items-center justify-center bg-background px-4 py-12 text-foreground">
			<div className="w-full max-w-md rounded-xl border border-border bg-card p-6 sm:p-8">
				<h1 className="text-balance font-serif text-2xl font-semibold tracking-tight text-foreground">
					Open Gold Standard in its own tab
				</h1>
				<p className="mt-3 text-pretty text-sm leading-relaxed text-muted-foreground">
					This page is being shown inside another website, which could disguise what you
					click. Gold Standard runs only on its own page or inside Safe{'{'}Wallet{'}'}.
				</p>
				<a
					className={cn(buttonVariants({ size: 'lg' }), 'mt-6 w-full')}
					href={href}
					target="_blank"
					rel="noopener noreferrer"
				>
					Open Gold Standard directly
				</a>
				<p className="mt-3 break-all text-xs text-muted-foreground">{href}</p>
			</div>
		</main>
	);
}
