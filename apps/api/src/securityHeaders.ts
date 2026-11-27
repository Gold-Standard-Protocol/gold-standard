import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The dapp's response headers live in apps/dapp/public/_headers (the Cloudflare Pages and
 * Netlify format), which the build copies into the dist root. When the API serves that
 * build itself it parses the same file at startup, so the CSP and its companions are
 * written once and the two hosting routes cannot drift.
 */
export interface HeaderRule {
  pattern: string;
  headers: ReadonlyMap<string, string>;
}

const HSTS = 'strict-transport-security';
const WELL_KNOWN = '.well-known';
const HEADERS_FILE = '_headers';
const COMMENT = '#';

const splitHeaderLine = (line: string): readonly [string, string] | undefined => {
  const colon = line.indexOf(':');
  if (colon <= 0) return undefined;
  return [line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim()];
};

/** Rules in file order: a line starting with / opens a rule, indented Name: value lines belong to it. */
export const parseHeaderRules = (text: string): readonly HeaderRule[] =>
  text.split(/\r?\n/).reduce<readonly HeaderRule[]>((rules, rawLine) => {
    const line = rawLine.trim();
    if (line === '' || line.startsWith(COMMENT)) return rules;
    if (!rawLine.startsWith(' ') && !rawLine.startsWith('\t') && line.startsWith('/')) {
      return [...rules, { pattern: line, headers: new Map() }];
    }
    const current = rules.at(-1);
    const header = splitHeaderLine(line);
    if (current === undefined || header === undefined) return rules;
    const headers = new Map([...current.headers, header]);
    return [...rules.slice(0, -1), { ...current, headers }];
  }, []);

export const loadHeaderRules = (dist: string): readonly HeaderRule[] =>
  parseHeaderRules(readFileSync(join(dist, HEADERS_FILE), 'utf8'));

/** Cloudflare Pages matching: a trailing /* matches the prefix, anything else matches exactly. */
const matches = (pattern: string, path: string): boolean =>
  pattern.endsWith('/*') ? path.startsWith(pattern.slice(0, -1)) : pattern === path;

/** Every header for a path, later rules overriding earlier ones. */
export const headersFor = (rules: readonly HeaderRule[], path: string): ReadonlyMap<string, string> =>
  rules.filter((rule) => matches(rule.pattern, path)).reduce((merged, rule) => new Map([...merged, ...rule.headers]), new Map<string, string>());

const decodedPath = (path: string): string | undefined => {
  try {
    return decodeURIComponent(path);
  } catch {
    return undefined;
  }
};

/**
 * Paths the static server must never answer: the _headers file itself (in any letter case,
 * because a case-insensitive disk would still serve /_HEADERS), any dotfile or
 * dot-directory apart from .well-known (security.txt lives there) and any traversal
 * segment. Checked on the decoded path so %2e cannot slip a dotfile past the rule.
 */
export const isForbiddenPath = (path: string): boolean => {
  const decoded = decodedPath(path);
  if (decoded === undefined) return true;
  // Windows static-file resolution accepts backslashes as directory separators.
  // Apply the same policy before express.static can normalise either spelling.
  const segments = decoded.replace(/\\/g, '/').split('/');
  if (segments.at(-1)?.toLowerCase() === HEADERS_FILE) return true;
  return segments.some((segment) => segment === '..' || (segment.startsWith('.') && segment !== WELL_KNOWN));
};

export const isWellKnownPath = (path: string): boolean => path.startsWith(`/${WELL_KNOWN}/`);

/** Applies the parsed rules to every response, HSTS only once the request arrived over TLS. */
export function createSecurityHeaders(rules: readonly HeaderRule[]): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    for (const [name, value] of headersFor(rules, req.path)) {
      if (name === HSTS && !req.secure) continue;
      res.setHeader(name, value);
    }
    next();
  };
}

export function denyForbiddenPaths(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (isForbiddenPath(req.path)) {
      // Runs after createSecurityHeaders: a refusal under assets/ must not keep its immutable rule.
      res.setHeader('Cache-Control', 'no-cache');
      res.status(404).end();
      return;
    }
    next();
  };
}
