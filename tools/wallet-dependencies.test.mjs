import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { rootReachability } from './audit-gate.mjs';

const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
const production = rootReachability(lock);

test('production validation uses patched Zod 4 with no legacy copies', () => {
  const copies = [...production.keys()].filter((path) => path.endsWith('/zod'));
  assert.ok(copies.length > 0, 'the first-party validator must remain installed');
  for (const path of copies) {
    const [major, minor, patch] = lock.packages[path].version.split('.').map(Number);
    assert.ok(major === 4 && (minor > 6 || (minor === 6 && patch >= 6)), path + ' is not patched Zod 4');
  }
});

test('retired wallet/auth/decoder dependencies cannot silently return to production', () => {
  for (const path of production.keys()) {
    assert.doesNotMatch(path, /node_modules\/(?:@reown\/appkit(?:-[^/]+)?|@base-org\/account|@coinbase\/cdp-sdk|@rainbow-me\/rainbowkit|decode-uri-component|query-string)(?:\/|$)/);
  }
});

test('production audit has no advisory exceptions', () => {
  const allowance = JSON.parse(readFileSync(new URL('./audit-allowlist.json', import.meta.url), 'utf8'));
  assert.deepEqual(allowance.advisories, []);
});
