import { type ComponentType } from 'react';
import IntroductionPage from './pages/IntroductionPage';
import WhyGoldStandardPage from './pages/WhyGoldStandardPage';
import GettingStartedPage from './pages/GettingStartedPage';
import VaultsPage from './pages/VaultsPage';
import MintingRedeemingPage from './pages/MintingRedeemingPage';
import LiquidationsPage from './pages/LiquidationsPage';
import PegStabilityPage from './pages/PegStabilityPage';
import StabilityFeePage from './pages/StabilityFeePage';
import OraclePage from './pages/OraclePage';
import CollateralPage from './pages/CollateralPage';
import ParametersPage from './pages/ParametersPage';
import SecurityPage from './pages/SecurityPage';
import GovernancePage from './pages/GovernancePage';
import ContractsPage from './pages/ContractsPage';
import AgentsPage from './pages/AgentsPage';
import FaqPage from './pages/FaqPage';
import GlossaryPage from './pages/GlossaryPage';

export interface DocItem {
  slug: string;
  title: string;
  /** One-line description used for the page intro and prev/next cards. */
  description: string;
  component: ComponentType;
}

export interface DocGroup {
  title: string;
  items: DocItem[];
}

export const DOC_GROUPS: DocGroup[] = [
  {
    title: 'Get started',
    items: [
      {
        slug: 'introduction',
        title: 'Introduction',
        description: 'What Gold Standard and GSUSD are, and the idea behind them.',
        component: IntroductionPage,
      },
      {
        slug: 'why-gold-standard',
        title: 'Why Gold Standard',
        description: 'The case for a dollar backed by tokenised gold.',
        component: WhyGoldStandardPage,
      },
      {
        slug: 'getting-started',
        title: 'Getting started',
        description: 'Connect a wallet, get collateral and open your first vault.',
        component: GettingStartedPage,
      },
    ],
  },
  {
    title: 'Using Gold Standard',
    items: [
      {
        slug: 'vaults',
        title: 'Vaults',
        description: 'How vaults hold your gold and track your debt.',
        component: VaultsPage,
      },
      {
        slug: 'minting-redeeming',
        title: 'Minting and swapping',
        description: 'Mint GSUSD against gold, repay to release it or swap GSUSD for reserve gold.',
        component: MintingRedeemingPage,
      },
      {
        slug: 'liquidations',
        title: 'Liquidations',
        description: 'How unhealthy vaults are cleared, and how to avoid it.',
        component: LiquidationsPage,
      },
    ],
  },
  {
    title: 'How it works',
    items: [
      {
        slug: 'peg-stability',
        title: 'How the peg holds',
        description: 'The three forces that keep GSUSD at a dollar.',
        component: PegStabilityPage,
      },
      {
        slug: 'stability-fee',
        title: 'Stability fee & surplus buffer',
        description: 'Protocol revenue and the buffer that absorbs bad debt.',
        component: StabilityFeePage,
      },
      {
        slug: 'oracle',
        title: 'Oracle & price feeds',
        description: 'How Gold Standard prices gold: a Chainlink market feed checked against the Chainlink gold price.',
        component: OraclePage,
      },
      {
        slug: 'collateral',
        title: 'Collateral assets',
        description: 'PAXG at launch and XAUT once activated: the tokenised gold behind GSUSD.',
        component: CollateralPage,
      },
    ],
  },
  {
    title: 'Protocol & security',
    items: [
      {
        slug: 'parameters',
        title: 'Risk parameters',
        description: 'Every protocol parameter and its current value.',
        component: ParametersPage,
      },
      {
        slug: 'security',
        title: 'Security & architecture',
        description: 'Contracts, silos, defended bug classes and residual risks.',
        component: SecurityPage,
      },
      {
        slug: 'governance',
        title: 'Governance',
        description: 'The timelock, the guardian and who can change what.',
        component: GovernancePage,
      },
    ],
  },
  {
    title: 'Resources',
    items: [
      {
        slug: 'contracts',
        title: 'Contracts & addresses',
        description: 'Deployed contract addresses and how to verify them.',
        component: ContractsPage,
      },
      {
        slug: 'agents',
        title: 'For agents',
        description: 'Use Gold Standard with contract calls alone: the manifest, the conventions and every action.',
        component: AgentsPage,
      },
      {
        slug: 'faq',
        title: 'FAQ',
        description: 'Answers to the questions we hear most.',
        component: FaqPage,
      },
      {
        slug: 'glossary',
        title: 'Glossary',
        description: 'Plain-language definitions of the key terms.',
        component: GlossaryPage,
      },
    ],
  },
];

export const DOC_ITEMS: DocItem[] = DOC_GROUPS.flatMap((g) => g.items);

export interface DocLocation {
  item: DocItem;
  group: DocGroup;
  prev: DocItem | undefined;
  next: DocItem | undefined;
}

export function findDoc(slug: string): DocLocation | undefined {
  const index = DOC_ITEMS.findIndex((i) => i.slug === slug);
  if (index === -1) return undefined;
  const item = DOC_ITEMS[index];
  const group = DOC_GROUPS.find((g) => g.items.includes(item)) as DocGroup;
  return {
    item,
    group,
    prev: index > 0 ? DOC_ITEMS[index - 1] : undefined,
    next: index < DOC_ITEMS.length - 1 ? DOC_ITEMS[index + 1] : undefined,
  };
}
