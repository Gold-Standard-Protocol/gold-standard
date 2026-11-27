/**
 * The usage ledger page is part of a build only when VITE_LEDGER_ENABLED is exactly "true".
 * Any other value, unset included, leaves the page out: no nav entry, no route, no ledger
 * query and no ledger code in the bundle.
 */
export const ledgerEnabled = (env: Readonly<Record<string, unknown>>): boolean => env['VITE_LEDGER_ENABLED'] === 'true';

/**
 * Written as the literal member expression so that the bundler replaces it with the value
 * at build time. A build with the flag off then sees `false` here, and everything behind
 * `LEDGER_ENABLED ? ... : ...` (the page's dynamic import, its nav entry, its title) is
 * removed as dead code. Passing the whole `import.meta.env` object to a function keeps the
 * check for run time and ships the page chunk in every build.
 */
export const LEDGER_ENABLED: boolean = import.meta.env.VITE_LEDGER_ENABLED === 'true';
