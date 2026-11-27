#!/usr/bin/env node
// Render apps/dapp/public/og.png (1200 by 630) from tools/og-template.html with the
// Playwright already in the repo. Run after any change to the template:
//   node tools/render-og.mjs
// The template loads the self-hosted typefaces from apps/dapp/public/fonts, so the card
// is set in the same faces as the page.
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const template = resolve(root, 'tools/og-template.html');
const output = resolve(root, 'apps/dapp/public/og.png');
const WIDTH = 1200;
const HEIGHT = 630;

/** The repo's e2e suite drives the installed Chrome; fall back to a downloaded Chromium. */
async function launch() {
	try {
		return await chromium.launch({ channel: 'chrome' });
	} catch {
		return chromium.launch();
	}
}

const browser = await launch();
try {
	const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 });
	await page.goto(pathToFileURL(template).href);
	await page.evaluate(() => document.fonts.ready);
	const loaded = await page.evaluate(() =>
		['Fraunces', 'Hanken Grotesk', 'IBM Plex Mono'].filter((family) => document.fonts.check(`16px "${family}"`))
	);
	if (loaded.length !== 3) throw new Error(`Typefaces missing from the card: loaded ${loaded.join(', ') || 'none'}`);
	await page.screenshot({ path: output, type: 'png', clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT } });
	process.stdout.write(`Wrote ${output} (${WIDTH}x${HEIGHT})\n`);
} finally {
	await browser.close();
}
