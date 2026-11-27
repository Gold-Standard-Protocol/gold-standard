#!/usr/bin/env node
// Production dependency audit gate.
//
// Runs `npm audit --omit=dev --json` and fails on any high or critical advisory unless
// tools/audit-allowlist.json accepts it. An allowlist entry names one GHSA id, the exact
// lockfile paths it may appear under, the root dependencies those paths may be reached
// through, a justification and an expiry date. The gate fails when:
//   - a blocking advisory is not allowlisted;
//   - an allowlisted advisory appears under a path the entry does not list (for example
//     Zod 3 hoisted to node_modules/zod, where the API and keeper would load it);
//   - an allowed path becomes reachable through a root dependency the entry does not name;
//   - the entry has expired, or its expiry lies more than MAX_ALLOWLIST_DAYS ahead;
//   - a blocking package entry cannot be traced to a blocking advisory;
//   - npm audit fails to produce a version 2 report.
// Low and moderate advisories never fail the gate, matching `--audit-level=high`.
//
// Usage (from the repository root):
//   node tools/audit-gate.mjs [--allowlist <file>] [--report <file>] [--lockfile <file>]
// --report reads a saved `npm audit --omit=dev --json` output instead of running npm.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const BLOCKING_SEVERITIES = new Set(['high', 'critical']);
export const MAX_ALLOWLIST_DAYS = 90;
const GHSA_ID = /^GHSA(-[0-9a-z]{4}){3}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

/** The GHSA id at the end of an advisory URL, or null when the URL carries none. */
export function ghsaIdFromUrl(url) {
  const last = String(url ?? '').split('/').pop() ?? '';
  return GHSA_ID.test(last) ? last : null;
}

/** Today's date as YYYY-MM-DD in UTC. */
export function isoToday(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

function entryProblems(entry, index, today) {
  const where = `allowlist entry ${index}${entry && entry.id ? ` (${entry.id})` : ''}`;
  if (!entry || typeof entry !== 'object') return [`${where} is not an object`];
  const problems = [];
  if (!GHSA_ID.test(String(entry.id))) problems.push(`${where}: id must be a GHSA id`);
  for (const field of ['paths', 'via']) {
    const list = entry[field];
    if (!Array.isArray(list) || list.length === 0 || !list.every((p) => typeof p === 'string' && p.length > 0)) {
      problems.push(`${where}: ${field} must be a non-empty list of strings`);
    }
  }
  if (Array.isArray(entry.paths) && !entry.paths.every((p) => typeof p === 'string' && p.startsWith('node_modules/'))) {
    problems.push(`${where}: every path must be a lockfile path starting with node_modules/`);
  }
  if (typeof entry.justification !== 'string' || entry.justification.trim().length < 20) {
    problems.push(`${where}: justification must explain the decision and point at the triage`);
  }
  if (!ISO_DATE.test(String(entry.expires)) || Number.isNaN(Date.parse(`${entry.expires}T00:00:00Z`))) {
    problems.push(`${where}: expires must be a YYYY-MM-DD date`);
  } else {
    const days = (Date.parse(`${entry.expires}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY_MS;
    if (days > MAX_ALLOWLIST_DAYS) {
      problems.push(`${where}: expires ${entry.expires} is more than ${MAX_ALLOWLIST_DAYS} days ahead`);
    }
  }
  return problems;
}

/** Validates the allowlist document; returns { entries, problems }. */
export function validateAllowlist(doc, today) {
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.advisories)) {
    return { entries: [], problems: ['allowlist must be an object with an advisories list'] };
  }
  const problems = doc.advisories.flatMap((entry, i) => entryProblems(entry, i, today));
  const ids = doc.advisories.map((e) => e && e.id);
  const duplicates = ids.filter((id, i) => id && ids.indexOf(id) !== i);
  for (const id of new Set(duplicates)) problems.push(`allowlist names ${id} more than once`);
  return { entries: problems.length === 0 ? doc.advisories : [], problems };
}

/**
 * Every (blocking advisory, lockfile path) pair in an npm audit v2 report. An advisory
 * object sits in the `via` list of the package entry it affects, and that entry's
 * `nodes` are the installed copies.
 */
export function collectBlockingFindings(report) {
  const findings = [];
  for (const [name, vuln] of Object.entries(report.vulnerabilities ?? {})) {
    for (const via of vuln.via ?? []) {
      if (typeof via !== 'object' || !BLOCKING_SEVERITIES.has(via.severity)) continue;
      const id = ghsaIdFromUrl(via.url) ?? `advisory ${via.source ?? via.url ?? 'without an id'}`;
      for (const path of vuln.nodes ?? []) {
        findings.push({ id, package: name, path, severity: via.severity, title: via.title ?? '' });
      }
    }
  }
  return findings;
}

/**
 * Blocking package entries whose severity does not trace back to a blocking advisory.
 * npm propagates severity from advisories along `via`, so this should never happen; if a
 * report ever breaks that rule the gate refuses to guess.
 */
export function findUntracedBlockingEntries(report) {
  const vulns = report.vulnerabilities ?? {};
  const memo = new Map();
  const reaches = (name, seen) => {
    if (memo.has(name)) return memo.get(name);
    if (seen.has(name) || !vulns[name]) return false;
    seen.add(name);
    const found = (vulns[name].via ?? []).some((via) =>
      typeof via === 'object' ? BLOCKING_SEVERITIES.has(via.severity) : reaches(via, seen),
    );
    memo.set(name, found);
    return found;
  };
  return Object.entries(vulns)
    .filter(([name, v]) => BLOCKING_SEVERITIES.has(v.severity) && !reaches(name, new Set()))
    .map(([name]) => name);
}

/** The lockfile path a package at `fromPath` loads for `name`, following Node resolution. */
export function resolveLockDependency(packages, fromPath, name) {
  let base = fromPath;
  for (;;) {
    const candidate = base ? `${base}/node_modules/${name}` : `node_modules/${name}`;
    if (packages[candidate]) return candidate;
    if (!base) return null;
    const cut = base.lastIndexOf('/node_modules/');
    base = cut === -1 ? '' : base.slice(0, cut);
  }
}

/**
 * Map of lockfile path to the set of root production dependencies it is reachable
 * through. Dependencies, optional dependencies and peer dependencies are all followed:
 * npm installs peers, and a nested copy such as Zod 3 under @reown/appkit is only
 * present because abitype declares it as an optional peer.
 */
export function rootReachability(lockfile) {
  const packages = lockfile.packages ?? {};
  const roots = Object.keys(packages['']?.dependencies ?? {});
  const reached = new Map();
  for (const root of roots) {
    const start = resolveLockDependency(packages, '', root);
    const queue = start ? [start] : [];
    const seen = new Set(queue);
    while (queue.length > 0) {
      const path = queue.shift();
      reached.set(path, new Set([...(reached.get(path) ?? []), root]));
      const pkg = packages[path] ?? {};
      for (const dep of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies, ...pkg.peerDependencies })) {
        const next = resolveLockDependency(packages, path, dep);
        if (next && !seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
  }
  return reached;
}

function judgeFinding(finding, entry, reachability, today) {
  if (!entry) return `${finding.id} (${finding.severity}) at ${finding.path} is not allowlisted: ${finding.title}`;
  if (today > entry.expires) return `${finding.id} allowlist entry expired on ${entry.expires}; recheck the triage`;
  if (!entry.paths.includes(finding.path)) {
    return `${finding.id} appears at ${finding.path}, a path its allowlist entry does not list`;
  }
  const roots = [...(reachability.get(finding.path) ?? [])];
  const unexpected = roots.filter((root) => !entry.via.includes(root));
  if (unexpected.length > 0) {
    return `${finding.id} at ${finding.path} is reachable through ${unexpected.join(', ')}, which its allowlist entry does not name`;
  }
  return null;
}

/**
 * Applies the allowlist to an audit report. Returns { failures, allowed, unused } where
 * failures are messages that fail the gate, allowed are the accepted findings and unused
 * lists allowlist ids that matched nothing (candidates for removal).
 */
export function evaluateAudit({ report, allowlist, lockfile, today }) {
  if (!report || typeof report !== 'object' || report.error) {
    const detail = report && report.error ? `: ${JSON.stringify(report.error)}` : '';
    return { failures: [`npm audit did not produce a report${detail}`], allowed: [], unused: [] };
  }
  if (report.auditReportVersion !== 2) {
    return { failures: ['npm audit report is not version 2; the gate cannot read it'], allowed: [], unused: [] };
  }
  const { entries, problems } = validateAllowlist(allowlist, today);
  if (problems.length > 0) return { failures: problems, allowed: [], unused: [] };

  const byId = new Map(entries.map((e) => [e.id, e]));
  const reachability = rootReachability(lockfile);
  const findings = collectBlockingFindings(report);
  const failures = [];
  const allowed = [];
  for (const finding of findings) {
    const verdict = judgeFinding(finding, byId.get(finding.id), reachability, today);
    if (verdict) failures.push(verdict);
    else allowed.push(finding);
  }
  for (const name of findUntracedBlockingEntries(report)) {
    failures.push(`${name} is ${report.vulnerabilities[name].severity} but traces to no blocking advisory`);
  }
  const used = new Set(findings.map((f) => f.id));
  const unused = entries.filter((e) => !used.has(e.id)).map((e) => e.id);
  return { failures, allowed, unused };
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`cannot read ${label} at ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function runNpmAudit(cwd) {
  // Windows cannot execute a .cmd file directly through spawnSync (EINVAL).
  // Only this fixed command goes through cmd.exe; no option, path or report
  // content supplied by the caller is interpolated into shell text.
  const command = process.platform === 'win32' ? 'cmd.exe' : 'npm';
  const args = process.platform === 'win32'
    ? ['/d', '/s', '/c', 'npm audit --omit=dev --json']
    : ['audit', '--omit=dev', '--json'];
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw new Error(`npm audit could not run: ${result.error.message}`);
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`npm audit printed no JSON (exit ${result.status}): ${result.stderr.slice(0, 500)}`);
  }
}

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (!['--allowlist', '--report', '--lockfile'].includes(flag) || !value) {
      throw new Error(`unknown or incomplete argument: ${flag ?? ''}`);
    }
    options[flag.slice(2)] = value;
  }
  return options;
}

function main() {
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const options = parseArgs(process.argv.slice(2));
  const allowlist = readJson(options.allowlist ?? resolve(root, 'tools/audit-allowlist.json'), 'allowlist');
  const lockfile = readJson(options.lockfile ?? resolve(root, 'package-lock.json'), 'lockfile');
  const report = options.report ? readJson(options.report, 'audit report') : runNpmAudit(root);
  const { failures, allowed, unused } = evaluateAudit({ report, allowlist, lockfile, today: isoToday() });

  const counts = report.metadata?.vulnerabilities;
  if (counts) {
    console.log(`npm audit (production): ${counts.critical} critical, ${counts.high} high, ${counts.moderate} moderate, ${counts.low} low`);
  }
  for (const id of new Set(allowed.map((f) => f.id))) {
    const paths = allowed.filter((f) => f.id === id).length;
    console.log(`allowed: ${id} at ${paths} listed path(s), until ${allowlist.advisories.find((e) => e.id === id).expires}`);
  }
  for (const id of unused) console.log(`note: allowlist entry ${id} matched nothing; remove it`);
  if (failures.length > 0) {
    for (const failure of failures) console.error(`FAIL: ${failure}`);
    process.exitCode = 1;
    return;
  }
  console.log('audit gate passed: no unaccepted high or critical advisory');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`FAIL: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
