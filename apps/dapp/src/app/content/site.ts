/**
 * Single source of marketing and product copy for Gold Standard.
 *
 * Brand: Gold Standard. Gold Standard Protocol runs the contracts. Token: GSUSD, "Gold Standard Dollar",
 * always framed as gold-backed so it is never misread as merely "high-quality
 * USD". House style: British or American spelling, never converted from one to the
 * other, confident and precise, no invented metrics.
 *
 * ACCURACY RULE, and it binds harder than the brand rule. Every claim here is a
 * property of the protocol design (docs/SPECIFICATION.md, docs/THREAT_MODEL.md,
 * docs/PEG_ARCHITECTURE.md) or a live on-chain figure. Four claims are therefore
 * never made:
 *   1. "backed one for one" - GSUSD is OVER-collateralised, 130% to mint. One
 *      for one is the one ratio the protocol never targets.
 *   2. "backed by physical gold" without qualification - the collateral is PAXG
 *      (XAUT once governance activates it), which are issuer claims on allocated gold. Paxos and Tether sit
 *      between a holder and the metal, and that counterparty risk is documented.
 *   3. "always convertible" / "the exit is always open" - the Stability Swap is
 *      a real right, but it is priced at a utilisation spread, draws only on
 *      protocol-owned reserve gold and is pausable per asset.
 *   4. a floor deeper than the reserve - the floor holds exactly to the depth of
 *      the Stability Reserve. When the reserve is empty the swap refuses and
 *      there is no floor until it is refilled. Never imply a deeper one.
 * Overstating any of these would contradict the protocol's own risk pages.
 */

import {
  GOLD_VAULT_ADDRESSES,
  TARGET_CHAIN_ID,
  explorerAddressUrl,
} from '@goldstandard/constants';
import { ChainId } from '@goldstandard/models';

export const BRAND = {
  name: 'Gold Standard',
  protocol: 'Gold Standard Protocol',
  token: 'GSUSD',
  tokenName: 'Gold Standard Dollar',
  domain: 'goldstandard.finance',
  tagline: 'The dollar, back on the gold standard.',
  description:
    'Gold Standard lets you lock tokenised gold and mint GSUSD, the Gold Standard Dollar. It is a stablecoin over-collateralised by tokenised gold and convertible to protocol-owned gold through the Stability Reserve.',
  /** One-line origin note, used in the hero and the docs introduction. */
  origin:
    'Under the gold standard a currency was backed by gold and could be exchanged for it. The United States ended the last of that link in 1971. GSUSD puts the dollar back on gold: each token is minted against more tokenised gold than it is worth, and the collateral sits on-chain for anyone to inspect.',
} as const;

export interface NavLink {
  to: string;
  label: string;
  end?: boolean;
}

export const PRIMARY_NAV: NavLink[] = [
  { to: '/', label: 'Home', end: true },
  { to: '/vault', label: 'Vault' },
  { to: '/pool', label: 'Pool' },
  { to: '/swap', label: 'Swap' },
  { to: '/transparency', label: 'Reserves' },
  { to: '/docs', label: 'Docs' },
];

const LEDGER_NAV_LINK: NavLink = { to: '/ledger', label: 'Ledger' };

/**
 * The primary navigation of a build. With the ledger page off it is PRIMARY_NAV itself,
 * unchanged; with it on, Ledger follows Swap.
 */
export function primaryNav(ledgerEnabled: boolean): readonly NavLink[] {
  if (!ledgerEnabled) return PRIMARY_NAV;
  const after = PRIMARY_NAV.findIndex((link) => link.to === '/swap') + 1;
  return [...PRIMARY_NAV.slice(0, after), LEDGER_NAV_LINK, ...PRIMARY_NAV.slice(after)];
}

export const HERO = {
  title: 'The dollar,\nback on the gold standard.',
  subtitle:
    'GSUSD is the Gold Standard Dollar, a stablecoin backed by more tokenised gold than it is worth. There is no bank and no hidden balance sheet: the collateral and the contracts sit on-chain for anyone to inspect.',
  primaryCta: { label: 'Open a vault', to: '/vault' },
  secondaryCta: { label: 'View reserves', to: '/transparency' },
} as const;

export interface TrustSignal {
  title: string;
  detail: string;
}

export const TRUST_SIGNALS: TrustSignal[] = [
  {
    title: 'Over-collateralised',
    detail:
      'Every GSUSD is backed by more than its value in tokenised gold, never merely one for one.',
  },
  {
    title: 'Non-custodial',
    detail: 'You hold the keys. Collateral sits in contracts, never with us.',
  },
  {
    title: 'Proof of reserves',
    detail: 'Backing is verifiable on-chain, block by block, by anyone.',
  },
  {
    title: 'Time-locked governance',
    detail: 'Parameter changes wait out an on-chain timelock, 48 hours at launch.',
  },
];

export interface Step {
  number: string;
  title: string;
  detail: string;
}

export const STEPS: Step[] = [
  {
    number: '01',
    title: 'Deposit gold',
    detail:
      'Supply tokenised gold into your own vault: PAXG at launch, with Tether Gold (XAUT) to follow once it meets published activation criteria. Each token is a claim on a troy ounce of allocated physical gold, held by its issuer.',
  },
  {
    number: '02',
    title: 'Mint GSUSD',
    detail:
      'Borrow GSUSD against your gold up to a safe limit. Spend it, save it or put it to work, while your gold keeps its upside.',
  },
  {
    number: '03',
    title: 'Swap for gold',
    detail:
      'Repay to release your own gold, or swap GSUSD for gold from the protocol’s Stability Reserve at the oracle price minus a small spread. No borrower’s vault is ever involved.',
  },
];

export interface Mechanism {
  title: string;
  summary: string;
  detail: string;
}

/** The three forces that hold the peg, from the protocol specification. */
export const PEG_MECHANISMS: Mechanism[] = [
  {
    title: 'Over-collateralisation and liquidation',
    summary: 'Every vault holds more gold than the GSUSD it has minted.',
    detail:
      'A vault needs a collateral ratio of at least 130% to mint or withdraw. If a vault falls below the 110% liquidation threshold, anyone can repay its debt and claim its gold at a discount, which keeps the system solvent without a central operator.',
  },
  {
    title: 'Stability swap',
    summary: 'GSUSD converts to protocol-owned gold at the Reserve’s quoted price, up to its capacity.',
    detail:
      'Anyone can swap GSUSD for gold held in the protocol’s Stability Reserve at the oracle price, minus a spread that rises as the reserve thins. That quote puts a floor under the price one spread-width below a dollar: if GSUSD trades beneath it, swapping is profitable and arbitrage pushes it back towards par. The swap draws only on protocol-owned gold, never on a borrower’s vault, and the floor holds to the depth of the reserve.',
  },
  {
    title: 'Stability fee',
    summary: 'Protocol revenue builds a buffer against shocks.',
    detail:
      'A per-second stability fee on debt routes revenue into a surplus buffer. That buffer starts empty, fills from fees and absorbs bad debt in a downturn as far as its balance allows.',
  },
];

export interface CollateralAsset {
  symbol: 'PAXG' | 'XAUT';
  name: string;
  issuer: string;
  image: string;
  blurb: string;
  priceApiId: string;
}

export const COLLATERAL_ASSETS: CollateralAsset[] = [
  {
    symbol: 'PAXG',
    name: 'Paxos Gold',
    issuer: 'Paxos Trust Company',
    image: '/images/paxg.png',
    blurb:
      'Each PAXG is one fine troy ounce of a London Good Delivery gold bar, held in professional vaults.',
    priceApiId: 'pax-gold',
  },
  {
    symbol: 'XAUT',
    name: 'Tether Gold',
    issuer: 'TG Commodities',
    image: '/images/xaut.png',
    blurb:
      'Each XAUT represents one troy ounce of physical gold on a specific London Good Delivery bar.',
    priceApiId: 'tether-gold',
  },
];

export interface AgentPoint {
  title: string;
  detail: string;
}

/**
 * The agent story on the landing page. Every sentence is a property of the contracts or of
 * the published files (docs/AGENTS.md, apps/dapp/public/agents.json); nothing here promises
 * a service, an API or an integration that does not exist.
 */
export const AGENTS = {
  title: 'A dollar that software can verify.',
  lead:
    'Everything the dapp does can be done with contract calls alone. An autonomous agent, a keeper or a treasury script starts from a manifest it can check against the chain, reads every open vault from the registry and acts under rules the contracts enforce.',
  points: [
    {
      title: 'Verify',
      detail:
        'The manifest at /agents.json lists every address and convention, with a call for each address and the exact word it must return. Fetched from this site, it lets an agent prove the set is wired together before it sends anything. The ABIs are served beside it.',
    },
    {
      title: 'Read',
      detail:
        'The VaultRegistry lists every open vault with its collateral, debt, ratio and liquidation price. No indexer, no API and no front end in the loop.',
    },
    {
      title: 'Act',
      detail:
        'Mint, repay, liquidate, provide to the pool and swap for reserve gold with the calls in the guide. Every refusal is a short, stable reason string.',
    },
  ] as AgentPoint[],
  cta: { label: 'Read the guide for agents', to: '/docs/agents' },
  manifest: { label: '/agents.json', href: '/agents.json' },
} as const;

export interface FaqItem {
  question: string;
  answer: string;
}

export const FAQ: FaqItem[] = [
  {
    question: 'What is GSUSD?',
    answer:
      'GSUSD is the Gold Standard Dollar, a dollar-denominated stablecoin minted on the Gold Standard Protocol and backed by tokenised gold. It is not a claim on a bank; it is minted against tokenised gold (PAXG at launch) held in over-collateralised vaults, so the gold behind it is normally worth more than the GSUSD in issue, and the backing is visible on-chain.',
  },
  {
    question: 'What backs GSUSD?',
    answer:
      'Physical gold, in tokenised form. Every GSUSD is minted against PAXG, where each token is a claim on a troy ounce of allocated London Good Delivery gold held in professional vaults. Tether Gold (XAUT) is registered but not yet accepted; governance can add it once it meets published criteria for liquidity, price feeds and manipulation cost.',
  },
  {
    question: 'How is the dollar peg maintained?',
    answer:
      'Three forces work together. Over-collateralisation with open liquidations keeps the system solvent. The Stability Reserve lets anyone swap GSUSD for protocol-owned gold at the oracle price minus a spread, which puts a floor under the price to the depth of the reserve. A stability fee funds a buffer that absorbs bad debt. Above a dollar, borrowers lock gold, mint GSUSD and sell into the premium, so the price may sit modestly above par during a demand spike.',
  },
  {
    question: 'Is this custodial? Who holds my gold?',
    answer:
      'It is non-custodial. Your collateral sits in open-source smart contracts that release it only to you, or to a liquidator if your vault falls below the 110% liquidation ratio. Gold Standard never takes custody of your gold or your GSUSD.',
  },
  {
    question: 'What happens if the gold price falls?',
    answer:
      'Vaults are over-collateralised, so a fall in the gold price first eats into your buffer, not the peg. If a vault drops below the 110% liquidation ratio, anyone can repay its debt, and the vault gives up gold worth that debt plus a 5% penalty; you keep the GSUSD you minted and whatever gold remains. The surplus buffer absorbs a shortfall as far as its balance allows.',
  },
  {
    question: 'Can I always get my gold back?',
    answer:
      'Your own gold, yes. Repay your GSUSD to withdraw your collateral whenever you like; there is no lock-up and nobody else can draw on a healthy vault. Swapping GSUSD for gold is a separate right: it takes protocol-owned gold from the Stability Reserve at the oracle price minus a spread, never gold from another borrower’s vault, and it is available up to the reserve’s capacity.',
  },
  {
    question: 'Can software or an AI agent use Gold Standard without the website?',
    answer:
      'Yes. The protocol is a set of contracts and the website is only a view of them. The manifest at /agents.json, taken from this site or the repository, lists every address and convention with calls that check how the set is wired, the VaultRegistry lists every open vault on chain and the guide for agents gives every action as a contract call. The reference keeper in the repository runs on exactly that.',
  },
  {
    question: 'Which networks are supported?',
    answer:
      TARGET_CHAIN_ID === ChainId.MAINNET
        ? 'Gold Standard runs on Ethereum mainnet. The contract addresses are listed on the Reserves page and in the docs.'
        : 'Gold Standard targets Ethereum mainnet. This deployment runs on the Sepolia test network ahead of the mainnet launch.',
  },
];

/**
 * Documented protocol design parameters, sourced from docs/SPECIFICATION.md.
 * These are confirmed against the live contract on the reserves page once
 * deployed; before launch they describe the intended configuration.
 */
export interface ProtocolParameter {
  label: string;
  value: string;
  detail: string;
}

export const PROTOCOL_PARAMETERS: ProtocolParameter[] = [
  {
    label: 'Minimum collateral ratio',
    value: '≥ 130%',
    detail: 'Vaults must hold at least 1.3× their debt in gold to mint.',
  },
  {
    label: 'Liquidation ratio',
    value: '110%',
    detail: 'Below this, a vault can be liquidated by anyone.',
  },
  {
    label: 'Liquidation penalty',
    value: '5%',
    detail: 'Taken in gold from a liquidated vault. The liquidator earns 3% and the protocol keeps 2% for the reserve and the surplus buffer.',
  },
  {
    label: 'Stability swap spread',
    value: '0.5% to 2%',
    detail: '0.5% while the reserve is deep, rising in steps to 2% as it thins. Governance can reset the steps only between 0.5% and 5%.',
  },
  {
    label: 'Stability Reserve',
    value: 'Live on-chain',
    detail:
      'Protocol-owned gold GSUSD can be swapped for; swaps never touch a borrower’s vault.',
  },
  {
    label: 'Stability fee',
    value: '2% APR',
    detail: 'Per-second interest on debt, routed to the surplus buffer.',
  },
  {
    label: 'Origination fee',
    value: '0.05%',
    detail: 'Taken once from the GSUSD each mint delivers; the debt is the full amount minted. Governance can set it between 0 and 1%.',
  },
  // A mainnet build names only the mainnet figure.
  TARGET_CHAIN_ID === ChainId.MAINNET
    ? {
        label: 'Minimum debt',
        value: '1,000 GSUSD at launch',
        detail: 'The smallest position a vault may hold, set by governance so the smallest liquidation still pays for its gas.',
      }
    : {
        label: 'Minimum debt',
        value: '100 GSUSD on Sepolia',
        detail: 'The smallest position a vault may hold, set by governance so the smallest liquidation still pays for its gas; mainnet opens at 1,000 GSUSD.',
      },
  {
    label: 'Governance delay',
    value: '48 hours',
    detail: 'Delay on every parameter change, 48 hours at launch; changing it waits out the delay in force.',
  },
];

export const FOOTER = {
  blurb: 'The dollar, back on a gold standard.',
  links: [
    { label: 'Docs', to: '/docs', internal: true },
    { label: 'Reserves', to: '/transparency', internal: true },
    { label: 'Liquidate', to: '/vault/liquidate', internal: true },
    { label: 'Swap', to: '/swap', internal: true },
    { label: 'For agents', to: '/docs/agents', internal: true },
    { label: 'Terms', to: '/terms', internal: true },
    {
      label: 'Contracts',
      href: explorerAddressUrl(
        TARGET_CHAIN_ID,
        GOLD_VAULT_ADDRESSES[TARGET_CHAIN_ID] ?? ''
      ),
      internal: false,
    },
  ],
} as const;
