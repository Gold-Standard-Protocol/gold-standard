import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { headersFor, isForbiddenPath, parseHeaderRules } from './securityHeaders';

const DAPP_HEADERS = readFileSync(join(__dirname, '../../dapp/public/_headers'), 'utf8');

describe('parseHeaderRules', () => {
  it('parses the dapp _headers file: one rule per path pattern, comments and blanks ignored', () => {
    const rules = parseHeaderRules(DAPP_HEADERS);
    // Only the rules the API relies on: a new route in the dapp's _headers must not fail this spec.
    expect(rules.map((rule) => rule.pattern)).toEqual(expect.arrayContaining(['/*', '/assets/*', '/index.html']));
    expect(rules[0].pattern).toBe('/*');
    const everywhere = rules[0].headers;
    expect(everywhere.get('x-content-type-options')).toBe('nosniff');
    expect(everywhere.has('x-frame-options')).toBe(false);
    expect(everywhere.get('content-security-policy')).toContain('frame-ancestors https://app.safe.global;');
    expect(everywhere.get('content-security-policy')).toContain("script-src 'self' 'wasm-unsafe-eval'");
    expect(everywhere.get('strict-transport-security')).toBe('max-age=31536000; includeSubDomains');
  });

  it('keeps a value that itself contains a colon and ignores a header line before any rule', () => {
    const rules = parseHeaderRules('  Stray: value\n/x\n  Link: <https://a.example>; rel=preconnect\n');
    expect(rules).toHaveLength(1);
    expect(rules[0].headers.get('link')).toBe('<https://a.example>; rel=preconnect');
  });
});

describe('headersFor', () => {
  const rules = parseHeaderRules(DAPP_HEADERS);

  it('merges /* with the more specific rule for a path, the specific one winning', () => {
    expect(headersFor(rules, '/assets/app-abc.js').get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(headersFor(rules, '/assets/app-abc.js').get('content-security-policy')).toContain('frame-ancestors https://app.safe.global;');
    expect(headersFor(rules, '/agents.json').get('access-control-allow-origin')).toBe('*');
    expect(headersFor(rules, '/vault').has('cache-control')).toBe(false);
    expect(headersFor(rules, '/').get('cache-control')).toBe('no-cache');
    expect(headersFor(rules, '/').get('content-security-policy')).toContain('frame-ancestors https://app.safe.global;');
    expect(headersFor(rules, '/vault').get('x-content-type-options')).toBe('nosniff');
  });

  it('lets the Safe web app read the Safe App manifest cross-origin, as Safe documents', () => {
    const manifest = headersFor(rules, '/manifest.json');
    expect(manifest.get('access-control-allow-origin')).toBe('*');
    expect(manifest.get('access-control-allow-methods')).toBe('GET');
    expect(manifest.get('access-control-allow-headers')).toBe('X-Requested-With, content-type, Authorization');
    // The site-wide policy still applies to it.
    expect(manifest.get('x-content-type-options')).toBe('nosniff');
  });

  it('allows framing by the Safe web app only', () => {
    const policy = headersFor(rules, '/').get('content-security-policy') ?? '';
    const ancestors = policy.split(';').map((part) => part.trim()).find((part) => part.startsWith('frame-ancestors'));
    expect(ancestors).toBe('frame-ancestors https://app.safe.global');
  });
});

describe('isForbiddenPath', () => {
  it('denies the _headers file, dotfiles and traversal, encoded or not', () => {
    expect(isForbiddenPath('/_headers')).toBe(true);
    expect(isForbiddenPath('/_HEADERS')).toBe(true);
    expect(isForbiddenPath('/assets/_Headers')).toBe(true);
    expect(isForbiddenPath('/.env')).toBe(true);
    expect(isForbiddenPath('/.git/config')).toBe(true);
    expect(isForbiddenPath('/%2eenv')).toBe(true);
    expect(isForbiddenPath('/%5c.env')).toBe(true);
    expect(isForbiddenPath('/assets%5c..%5c_headers')).toBe(true);
    expect(isForbiddenPath('/assets\\..\\.env')).toBe(true);
    expect(isForbiddenPath('/assets/../_headers')).toBe(true);
    expect(isForbiddenPath('/%ZZ')).toBe(true);
  });

  it('allows ordinary files and .well-known', () => {
    expect(isForbiddenPath('/.well-known/security.txt')).toBe(false);
    expect(isForbiddenPath('/assets/app-abc.js')).toBe(false);
    expect(isForbiddenPath('/')).toBe(false);
  });
});
