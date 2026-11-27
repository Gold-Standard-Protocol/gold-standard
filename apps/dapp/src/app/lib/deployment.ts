/**
 * Where this bundle reaches its API and which source it was built from. Both come from the
 * build environment: the dapp is served from its own origin (IPFS, an ENS gateway or a
 * mirror), so the API endpoint must be absolute in production, and the footer shows the
 * commit so a visitor can match the page against the published source.
 */
type Env = Record<string, string | undefined>;

const TRPC_PATH = '/trpc';

/** The tRPC endpoint: VITE_API_URL with or without a trailing /trpc, or the same-origin path when unset. */
export function apiUrl(env: Env): string {
	const raw = env['VITE_API_URL']?.trim();
	if (!raw) return TRPC_PATH;
	if (!/^https?:\/\//.test(raw)) {
		throw new Error(`VITE_API_URL must be an absolute http(s) URL, got "${raw}"`);
	}
	const base = raw.replace(/\/+$/, '');
	return base.endsWith(TRPC_PATH) ? base : `${base}${TRPC_PATH}`;
}

/** The path of the Usage Ledger's whole record on the API, beside its tRPC endpoint. */
const LEDGER_RECORD_PATH = '/usage-ledger.csv';

/**
 * Where the Usage Ledger's whole record is downloaded: on the API's origin, which is this
 * page's own when VITE_API_URL is unset.
 */
export function ledgerRecordUrl(env: Env): string {
	const trpc = apiUrl(env);
	return `${trpc.slice(0, -TRPC_PATH.length)}${LEDGER_RECORD_PATH}`;
}

export interface BuildInfo {
	/** The short commit hash, or "unknown" when the build had no git and no VITE_BUILD_COMMIT. */
	commit: string;
	/** The commit page on the public repository, when VITE_SOURCE_URL names one. */
	sourceUrl?: string;
}

export function buildInfo(env: Env): BuildInfo {
	const commit = env['VITE_BUILD_COMMIT']?.trim() || 'unknown';
	const source = env['VITE_SOURCE_URL']?.trim().replace(/\/+$/, '');
	if (!source || commit === 'unknown') return { commit };
	return { commit, sourceUrl: `${source}/commit/${commit}` };
}
