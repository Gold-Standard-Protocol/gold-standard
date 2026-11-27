/**
 * The official marks the build serves under /brand/, at paths that never change so listing
 * sites, wallets and the token list can point at them. The repository's `brand/` folder is the
 * one source: the build copies these files out of it, and nothing under apps/dapp/public
 * repeats them.
 *
 * Node only. apps/dapp/vite.config.mts runs it after the bundle is written; the app never
 * imports it.
 */
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/** The repository's brand folder. */
export const BRAND_SOURCE_DIR = resolve(__dirname, '../../../../brand');

/** Served path under /brand/ and the file it is a copy of, relative to the brand folder. */
export const BRAND_FILES: ReadonlyArray<{ served: string; source: string }> = [
	{ served: 'gsusd.svg', source: 'gsusd/gsusd.svg' },
	{ served: 'gsusd-32.png', source: 'gsusd/gsusd-32.png' },
	{ served: 'gsusd-64.png', source: 'gsusd/gsusd-64.png' },
	{ served: 'gsusd-128.png', source: 'gsusd/gsusd-128.png' },
	{ served: 'gsusd-256.png', source: 'gsusd/gsusd-256.png' },
	{ served: 'gsusd-512.png', source: 'gsusd/gsusd-512.png' },
	{ served: 'protocol.svg', source: 'protocol/protocol.svg' },
	{ served: 'protocol-256.png', source: 'protocol/protocol-256.png' },
	{ served: 'protocol-512.png', source: 'protocol/protocol-512.png' },
];

/**
 * Copies every mark into `<outDir>/brand/` and returns the paths written. A mark missing from
 * the brand folder is an error: a build must not publish a list that points at a logo it does
 * not serve.
 */
export function copyBrandFiles(outDir: string, sourceDir: string = BRAND_SOURCE_DIR): string[] {
	return BRAND_FILES.map(({ served, source }) => {
		const from = join(sourceDir, source);
		if (!existsSync(from)) throw new Error(`The brand folder has no ${source}; the build serves it as /brand/${served}.`);
		const to = join(outDir, 'brand', served);
		mkdirSync(dirname(to), { recursive: true });
		copyFileSync(from, to);
		return to;
	});
}
