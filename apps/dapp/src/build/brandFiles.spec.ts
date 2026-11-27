import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GSUSD_LOGO_URL, PROTOCOL_LOGO_URL } from '@goldstandard/constants';
import { BRAND_FILES, BRAND_SOURCE_DIR, copyBrandFiles } from './brandFiles';

describe('the marks served under /brand/', () => {
	let outDir: string;
	beforeEach(() => {
		outDir = mkdtempSync(join(tmpdir(), 'brand-files-'));
	});
	afterEach(() => {
		rmSync(outDir, { recursive: true, force: true });
	});

	it('are byte for byte the files in the brand folder, and nothing else', () => {
		copyBrandFiles(outDir);
		expect(readdirSync(join(outDir, 'brand')).sort()).toEqual(BRAND_FILES.map((file) => file.served).sort());
		for (const { served, source } of BRAND_FILES) {
			expect(readFileSync(join(outDir, 'brand', served)).equals(readFileSync(join(BRAND_SOURCE_DIR, source)))).toBe(true);
		}
	});

	it('are PNG and SVG files as their names say', () => {
		for (const { served, source } of BRAND_FILES) {
			const bytes = readFileSync(join(BRAND_SOURCE_DIR, source));
			if (served.endsWith('.png')) expect(bytes.subarray(1, 4).toString('latin1')).toBe('PNG');
			else expect(bytes.toString('utf8')).toContain('<svg');
		}
	});

	it('include the two logos the token list points at', () => {
		const served = BRAND_FILES.map((file) => `https://goldstandard.finance/brand/${file.served}`);
		expect(served).toContain(GSUSD_LOGO_URL);
		expect(served).toContain(PROTOCOL_LOGO_URL);
	});

	it('refuses a mark the brand folder does not hold', () => {
		expect(() => copyBrandFiles(outDir, join(outDir, 'nowhere'))).toThrow(/brand folder has no gsusd\/gsusd\.svg/);
	});
});
