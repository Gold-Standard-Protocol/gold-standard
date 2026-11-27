// Unit tests for the production audit gate. Run: node --test tools/audit-gate.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  collectBlockingFindings,
  evaluateAudit,
  findUntracedBlockingEntries,
  ghsaIdFromUrl,
  resolveLockDependency,
  rootReachability,
  validateAllowlist,
} from './audit-gate.mjs';

const TODAY = '2026-10-29';
const ZOD_ID = 'GHSA-mrhx-c7xc-m3w5';
const NESTED_ZOD = 'node_modules/@reown/appkit-wallet/node_modules/zod';

const zodAdvisory = {
  source: 1,
  name: 'zod',
  severity: 'high',
  title: 'Zod can exhaust memory',
  url: `https://github.com/advisories/${ZOD_ID}`,
  range: '<4.6.6',
};

/** An npm audit v2 report with Zod 3 at the given paths, propagated to appkit-wallet. */
function report(zodPaths = [NESTED_ZOD], extra = {}) {
  return {
    auditReportVersion: 2,
    vulnerabilities: {
      zod: { name: 'zod', severity: 'high', via: [zodAdvisory], nodes: zodPaths },
      '@reown/appkit-wallet': {
        name: '@reown/appkit-wallet',
        severity: 'high',
        via: ['zod'],
        nodes: ['node_modules/@reown/appkit-wallet'],
      },
      uuid: {
        name: 'uuid',
        severity: 'moderate',
        via: [{ ...zodAdvisory, name: 'uuid', severity: 'moderate', url: 'https://github.com/advisories/GHSA-w5hq-g745-h8pq' }],
        nodes: ['node_modules/uuid'],
      },
      ...extra,
    },
    metadata: { vulnerabilities: { critical: 0, high: 2, moderate: 1, low: 0 } },
  };
}

/** A lockfile where wagmi reaches appkit-wallet, whose own Zod 3 is nested beneath it. */
function lockfile(rootDeps = { wagmi: '2.19.5', zod: '4.6.7' }) {
  return {
    lockfileVersion: 3,
    packages: {
      '': { dependencies: rootDeps },
      'node_modules/wagmi': { dependencies: { '@reown/appkit-wallet': '1.7.8' } },
      'node_modules/@reown/appkit-wallet': { dependencies: { zod: '3.22.4' } },
      [NESTED_ZOD]: { version: '3.22.4' },
      'node_modules/zod': { version: '4.6.7' },
      'node_modules/uuid': { version: '8.3.2' },
    },
  };
}

function allowlist(overrides = {}) {
  return {
    advisories: [
      {
        id: ZOD_ID,
        paths: [NESTED_ZOD],
        via: ['wagmi'],
        justification: 'Not bundled in any production build.',
        expires: '2026-12-28',
        ...overrides,
      },
    ],
  };
}

const evaluate = (args) => evaluateAudit({ report: report(), allowlist: allowlist(), lockfile: lockfile(), today: TODAY, ...args });

test('passes when every blocking finding is allowlisted at a listed path', () => {
  const result = evaluate({});
  assert.deepEqual(result.failures, []);
  assert.equal(result.allowed.length, 1);
  assert.equal(result.allowed[0].path, NESTED_ZOD);
});

test('fails when the advisory has no allowlist entry', () => {
  const result = evaluate({ allowlist: { advisories: [] } });
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0], /is not allowlisted/);
});

test('fails when an allowlisted advisory appears under an unlisted path', () => {
  const result = evaluate({ report: report([NESTED_ZOD, 'node_modules/zod']) });
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0], /node_modules\/zod, a path its allowlist entry does not list/);
});

test('fails when a listed path becomes reachable through an unnamed root dependency', () => {
  const result = evaluate({ lockfile: lockfile({ wagmi: '2.19.5', '@reown/appkit-wallet': '1.7.8' }) });
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0], /reachable through @reown\/appkit-wallet/);
});

test('fails once the entry has expired and passes on its expiry date', () => {
  assert.match(evaluate({ today: '2026-12-29' }).failures[0], /expired on 2026-12-28/);
  assert.deepEqual(evaluate({ today: '2026-12-28' }).failures, []);
});

test('ignores moderate and low advisories', () => {
  const result = evaluate({});
  assert.ok(result.allowed.every((f) => f.id === ZOD_ID));
  assert.ok(!result.failures.some((f) => f.includes('uuid')));
});

test('treats a critical advisory as blocking', () => {
  const critical = { name: 'x', severity: 'critical', via: [{ ...zodAdvisory, name: 'x', severity: 'critical', url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc' }], nodes: ['node_modules/x'] };
  const result = evaluate({ report: report([NESTED_ZOD], { x: critical }) });
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0], /GHSA-aaaa-bbbb-cccc \(critical\)/);
});

test('rejects malformed allowlists before judging anything', () => {
  const cases = [
    [{ id: 'CVE-2026-1' }, /id must be a GHSA id/],
    [{ paths: [] }, /paths must be a non-empty list/],
    [{ paths: ['apps/api'] }, /starting with node_modules\//],
    [{ via: undefined }, /via must be a non-empty list/],
    [{ justification: 'ok' }, /justification must explain/],
    [{ expires: '28/12/2026' }, /expires must be a YYYY-MM-DD date/],
    [{ expires: '2027-02-01' }, /more than 90 days ahead/],
  ];
  for (const [override, pattern] of cases) {
    const result = evaluate({ allowlist: allowlist(override) });
    assert.equal(result.allowed.length, 0);
    assert.match(result.failures.join('\n'), pattern);
  }
  assert.match(validateAllowlist({}, TODAY).problems[0], /advisories list/);
  const twice = { advisories: [...allowlist().advisories, ...allowlist().advisories] };
  assert.match(validateAllowlist(twice, TODAY).problems.join('\n'), /more than once/);
});

test('fails when npm audit returns an error or an unknown report version', () => {
  assert.match(evaluate({ report: { error: { code: 'ENOLOCK' } } }).failures[0], /did not produce a report/);
  assert.match(evaluate({ report: { auditReportVersion: 1 } }).failures[0], /not version 2/);
});

test('fails on a blocking entry that traces to no blocking advisory', () => {
  const orphan = { name: 'y', severity: 'high', via: ['missing'], nodes: ['node_modules/y'] };
  const result = evaluate({ report: report([NESTED_ZOD], { y: orphan }) });
  assert.deepEqual(findUntracedBlockingEntries(report([NESTED_ZOD], { y: orphan })), ['y']);
  assert.match(result.failures.join('\n'), /y is high but traces to no blocking advisory/);
});

test('reports allowlist entries that matched nothing', () => {
  const clean = { auditReportVersion: 2, vulnerabilities: {}, metadata: {} };
  const result = evaluate({ report: clean });
  assert.deepEqual(result.failures, []);
  assert.deepEqual(result.unused, [ZOD_ID]);
});

test('collects findings only from advisory objects, one per installed copy', () => {
  const findings = collectBlockingFindings(report([NESTED_ZOD, 'node_modules/a/node_modules/zod']));
  assert.deepEqual(findings.map((f) => f.path), [NESTED_ZOD, 'node_modules/a/node_modules/zod']);
  assert.ok(findings.every((f) => f.package === 'zod' && f.id === ZOD_ID));
});

test('resolves lockfile dependencies the way Node does', () => {
  const { packages } = lockfile();
  assert.equal(resolveLockDependency(packages, 'node_modules/@reown/appkit-wallet', 'zod'), NESTED_ZOD);
  assert.equal(resolveLockDependency(packages, 'node_modules/wagmi', 'zod'), 'node_modules/zod');
  assert.equal(resolveLockDependency(packages, '', 'missing'), null);
  const reach = rootReachability(lockfile());
  assert.deepEqual([...reach.get(NESTED_ZOD)], ['wagmi']);
  assert.deepEqual([...reach.get('node_modules/zod')], ['zod']);
});

test('extracts GHSA ids from advisory URLs', () => {
  assert.equal(ghsaIdFromUrl(`https://github.com/advisories/${ZOD_ID}`), ZOD_ID);
  assert.equal(ghsaIdFromUrl('https://example.com/nothing'), null);
  assert.equal(ghsaIdFromUrl(undefined), null);
});
