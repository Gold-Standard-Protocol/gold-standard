import { parseAbi } from 'viem';

/**
 * What the watcher reports. The table is the alert surface the launch documents require
 * (docs/LAUNCH.md, monitoring): a `page` wakes someone, a `note` is read the same day.
 * Every event definition here is checked against the published ABIs by rules.spec.ts.
 */

export type Severity = 'page' | 'note';

/** Keys of `addresses` in a deployment snapshot (contracts/deployments/<network>.json). */
export const CONTRACT_KEYS = [
  'stablecoin',
  'vault',
  'oracle',
  'stabilityModule',
  'surplusBuffer',
  'stabilityPool',
  'reserve',
  'siloFactory',
  'timelock',
] as const;

export type ContractKey = (typeof CONTRACT_KEYS)[number];

export const CONTRACT_NAMES: Readonly<Record<ContractKey, string>> = {
  stablecoin: 'GSUSD',
  vault: 'Vault',
  oracle: 'Oracle',
  stabilityModule: 'Stability module',
  surplusBuffer: 'Surplus buffer',
  stabilityPool: 'Stability pool',
  reserve: 'Stability reserve',
  siloFactory: 'Silo factory',
  timelock: 'Timelock',
};

export const WATCHED_EVENTS = parseAbi([
  'event Paused(address account)',
  'event PauseExtended(address indexed by, uint256 pausedAt)',
  'event TokenFrozen(address indexed token, address indexed by, uint256 until)',
  'event TokenUnfrozen(address indexed token, address indexed by, uint256 price)',
  'event FeedUpdated(address indexed token, address newFeed)',
  'event AnchorFeedUpdated(address newAnchorFeed)',
  'event AssetPaused(address indexed token, address indexed by)',
  'event Swapped(address indexed redeemer, address indexed token, uint256 gsusdIn, uint256 goldOut, uint256 spreadPpm, uint256 fee)',
  'event BadDebt(address indexed vaultOwner, uint256 amount)',
  'event BadDebtAbsorptionFailed(uint256 amount)',
  'event Liquidated(address indexed vaultOwner, address indexed liquidator, uint256 debtRepaid, uint256 collateralSeized)',
  'event LiquidatedViaPool(address indexed vaultOwner, address indexed liquidator, uint256 debtRepaid, uint256 collateralSeized)',
  'event DebtMinted(address indexed user, uint256 amount)',
  'event FeeRoutingFailed(uint256 amount)',
  'event ReserveRoutingFailed(address indexed token, uint256 amount)',
  'event SurplusRoutingFailed(address indexed token, uint256 amount)',
  'event VaultRegistrySyncFailed(address indexed owner)',
  'event RoleGranted(bytes32 indexed role, address indexed account, address indexed sender)',
  'event CallScheduled(bytes32 indexed id, uint256 indexed index, address target, uint256 value, bytes data, bytes32 predecessor, uint256 delay)',
  'event CallExecuted(bytes32 indexed id, uint256 indexed index, address target, uint256 value, bytes data)',
  'event Cancelled(bytes32 indexed id)',
]);

export type WatchedEventName = (typeof WATCHED_EVENTS)[number]['name'];

export interface EventRule {
  id: number;
  severity: Severity;
  contracts: readonly ContractKey[];
  events: readonly WatchedEventName[];
  meaning: string;
}

const PAUSABLE: readonly ContractKey[] = ['vault', 'oracle', 'stabilityPool'];

export const EVENT_RULES: readonly EventRule[] = [
  { id: 1, severity: 'page', contracts: PAUSABLE, events: ['Paused'], meaning: 'A guardian pause. Nobody pauses without an incident.' },
  { id: 2, severity: 'page', contracts: PAUSABLE, events: ['PauseExtended'], meaning: 'A pause was renewed.' },
  { id: 3, severity: 'page', contracts: ['oracle'], events: ['TokenFrozen'], meaning: 'The price of one token was frozen.' },
  { id: 4, severity: 'page', contracts: ['reserve'], events: ['AssetPaused'], meaning: 'Reserve swaps stopped for one token.' },
  { id: 5, severity: 'page', contracts: ['vault'], events: ['BadDebt'], meaning: 'A liquidation left GSUSD unbacked.' },
  { id: 6, severity: 'page', contracts: ['vault'], events: ['BadDebtAbsorptionFailed'], meaning: 'The surplus buffer could not absorb bad debt.' },
  { id: 7, severity: 'page', contracts: ['timelock'], events: ['CallScheduled'], meaning: 'A governance proposal was scheduled.' },
  {
    id: 8,
    severity: 'page',
    contracts: ['stablecoin', 'stabilityModule', 'surplusBuffer', 'reserve', 'stabilityPool', 'siloFactory', 'vault', 'oracle', 'timelock'],
    events: ['RoleGranted'],
    meaning: 'A role was granted. None is expected after the handover.',
  },
  { id: 9, severity: 'note', contracts: ['timelock'], events: ['CallExecuted', 'Cancelled'], meaning: 'Governance executed or cancelled a proposal.' },
  { id: 10, severity: 'note', contracts: ['vault'], events: ['Liquidated', 'LiquidatedViaPool'], meaning: 'A vault was liquidated.' },
  { id: 11, severity: 'note', contracts: ['vault'], events: ['DebtMinted'], meaning: 'GSUSD was minted.' },
  { id: 12, severity: 'note', contracts: ['reserve'], events: ['Swapped'], meaning: 'A reserve swap.' },
  {
    id: 13,
    severity: 'note',
    contracts: ['vault'],
    events: ['FeeRoutingFailed', 'ReserveRoutingFailed', 'SurplusRoutingFailed', 'VaultRegistrySyncFailed'],
    meaning: 'A routing step fell back. Funds are safe; the cause needs a look.',
  },
  { id: 14, severity: 'note', contracts: ['oracle'], events: ['TokenUnfrozen', 'FeedUpdated', 'AnchorFeedUpdated'], meaning: 'Oracle configuration changed.' },
];

/** Ids of the three threshold rules, numbered after the event rules. */
export const VAULT_RATIO_RULE_ID = 15;
export const RESERVE_COVERAGE_RULE_ID = 16;
export const POOL_HOLDINGS_RULE_ID = 17;
export const RULE_COUNT = EVENT_RULES.length + 3;

export const findEventRule = (contract: ContractKey, event: string): EventRule | undefined =>
  EVENT_RULES.find((rule) => rule.contracts.includes(contract) && (rule.events as readonly string[]).includes(event));

/** keccak256 of the role names, and the zero hash OpenZeppelin uses for the admin role. */
export const ROLE_NAMES: Readonly<Record<string, string>> = {
  '0x0000000000000000000000000000000000000000000000000000000000000000': 'DEFAULT_ADMIN_ROLE',
  '0x9f2df0fed2c77648de5860a4cc508cd0818c85b8b8a1ab4ceeef8d981c8956a6': 'MINTER_ROLE',
  '0x31e0210044b4f6757ce6aa31f9c6e8d4896d24a755014887391a926c5224d959': 'VAULT_ROLE',
};

/** grantRole(bytes32,address): the call that makes a scheduled proposal an alarm. */
export const GRANT_ROLE_SELECTOR = '0x2f2ff15d';

export const READ_ABI = parseAbi([
  'function getCollateralisationRatio(address user) view returns (uint256)',
  'function coveragePpm() view returns (uint256)',
  'function getSupportedTokens() view returns (address[])',
  'function collateralAccounted(address token) view returns (uint256)',
  'function balanceOf(address account) view returns (uint256)',
]);
