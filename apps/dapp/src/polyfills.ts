/**
 * Browser shims for the two Node globals that WalletConnect and the Uniswap SDK still
 * reach for. Imported first from main.tsx so they exist before any dependency module
 * evaluates. This replaces vite-plugin-node-polyfills, whose crypto-browserify chain
 * carried advisories with no fix and polyfilled modules nothing in the bundle imports.
 */
import { Buffer } from 'buffer';
import process from 'process';

const scope = globalThis as typeof globalThis & {
	Buffer?: typeof Buffer;
	process?: typeof process;
};
scope.Buffer ??= Buffer;
scope.process ??= process;
