import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { abiModule, syncAbis, targets } from './sync-abis.mjs';

const ABI = [{ inputs: [], name: 'vaultOwnerCount', outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }], stateMutability: 'view', type: 'function' }];

test('VaultRegistry is among the synced ABIs', () => {
  assert.ok(targets.some(([name, , exportName]) => name === 'VaultRegistry' && exportName === 'vaultRegistryAbi'));
});

test('a new ABI file is created under its default export name, in the hand-written style', () => {
  const text = abiModule(ABI, 'vaultRegistryAbi', undefined);
  assert.match(text, /^export const vaultRegistryAbi = \[\n\t\{\n\t\tinputs: \[\],\n\t\tname: 'vaultOwnerCount',/);
  assert.match(text, / as const;\n$/);
});

test('an existing file keeps its export name', () => {
  assert.match(abiModule(ABI, 'vaultRegistryAbi', 'export const registryAbi = [] as const;\n'), /^export const registryAbi = /);
});

test('syncAbis creates a missing target file instead of failing on it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sync-abis-'));
  const abisDir = join(dir, 'abis');
  const artifactsDir = join(dir, 'artifacts');
  mkdirSync(abisDir);
  for (const [, artifactPath] of targets) {
    const file = join(artifactsDir, artifactPath);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ abi: ABI }));
  }
  const lines = [];
  syncAbis({ abisDir, artifactsDir, log: (line) => lines.push(line) });
  assert.ok(lines.includes('created VaultRegistry.ts (1 entries)'));
  assert.match(readFileSync(join(abisDir, 'VaultRegistry.ts'), 'utf8'), /^export const vaultRegistryAbi = /);
  lines.length = 0;
  syncAbis({ abisDir, artifactsDir, log: (line) => lines.push(line) });
  assert.ok(lines.includes('unchanged VaultRegistry.ts'));
});
