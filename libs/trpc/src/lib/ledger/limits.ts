/** Operating limits of the usage ledger's indexer and store. */

/** How often the indexing job runs. */
export const LEDGER_INDEX_EVERY_MS = 60_000;
/** How old the sync stamp may be before the API answers `unavailable`: five runs. */
export const LEDGER_STALE_AFTER_MS = 5 * 60_000;
/** Clock skew between API hosts that share one Redis, tolerated on a stamp from the future. */
export const LEDGER_SYNC_STAMP_SKEW_MS = 60_000;
/** TTL of the state, all of which is recomputable; every commit refreshes it. */
export const LEDGER_STATE_TTL_MS = 7 * 24 * 60 * 60_000;
/**
 * LEDGER_MAX_ADDRESSES when unset: the most address records the ledger opens. It is a
 * memory guard and nothing else, because the ledger never deletes a record. Measured on a
 * synthetic store of 125,000 busy records (docs/USAGE_LEDGER.md section 1.4): 50 MB in
 * Redis, about 56 MB for the indexer's copy and about 186 MB more resident memory in the API
 * process once the download has been built a few times, so about 290 MB in all. At the cap
 * no new record is opened and the ledger is marked incomplete until the cap is raised.
 */
export const DEFAULT_MAX_ADDRESSES = 125_000;
/** The bounds of LEDGER_MAX_ADDRESSES: the upper one needs several gigabytes for the ledger alone. */
export const MIN_MAX_ADDRESSES = 1_000;
export const MAX_MAX_ADDRESSES = 2_000_000;
/** A first pool deposit below this creates no account: 1 GSUSD. */
export const MIN_TRACKED_POOL_DEPOSIT = 10n ** 18n;
/** A liquidity position worth less than this at the peg is not tracked: 1 dollar, 18 decimals. */
export const MIN_TRACKED_LIQUIDITY_VALUE = 10n ** 18n;
/** Most liquidity positions tracked. Past it no position is added and the ledger is marked incomplete. */
export const MAX_TRACKED_LIQUIDITY_POSITIONS = 20_000;
/** Tracked liquidity positions compared with the position manager in one run, in rotation. */
export const LIQUIDITY_AUDIT_POSITIONS_PER_RUN = 20;
/** Most token ids in one Transfer filter; a longer list of tracked positions is asked for in several. */
export const LIQUIDITY_IDS_PER_FILTER = 500;
/** Most getLogs windows one run reads; the next run resumes from the cursor. */
export const MAX_WINDOWS_PER_RUN = 50;
/** A run stops opening windows after this long, inside the one minute schedule. */
export const MAX_RUN_MS = 45_000;
/** Automatic rebuilds after an integrity failure, per 24 hours. */
export const MAX_REBUILDS_PER_DAY = 1;
export const REBUILD_WINDOW_MS = 24 * 60 * 60_000;
/** Accounts with debt whose tracked principal is compared with the vault in one run, in rotation. */
export const DEBT_AUDIT_ACCOUNTS_PER_RUN = 50;
/** How long one status answer is shared between callers. */
export const LEDGER_MEMO_MS = 5_000;
