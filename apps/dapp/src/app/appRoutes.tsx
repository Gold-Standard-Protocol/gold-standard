import { lazy, type ReactElement } from 'react';
import { Navigate } from 'react-router-dom';
import LandingPage from './landing/LandingPage';
import { LEDGER_ENABLED } from './ledger/ledgerFlag';

// Code-split the wallet-heavy and content routes so the landing page ships a
// small initial bundle. Each becomes its own lazily fetched chunk.
const VaultDashboard = lazy(() => import('./VaultDashboard'));
const LiquidationPage = lazy(() => import('./LiquidationPage'));
const StabilityPoolPage = lazy(() => import('./StabilityPoolPage'));
const SwapPage = lazy(() => import('./SwapPage'));
const TransparencyPage = lazy(() => import('./transparency/TransparencyPage'));
const DocsPage = lazy(() => import('./docs/DocsPage'));
const TermsPage = lazy(() => import('./terms/TermsPage'));
// Only a build with VITE_LEDGER_ENABLED=true has the ledger page. LEDGER_ENABLED is a build
// time constant, so without the flag this import is removed and no chunk is emitted (the
// build itself refuses to finish if one is, see refuseLedgerCodeInOffBuilds in
// vite.config.mts), and the path falls to the redirect at the end of the table.
const LedgerPage = LEDGER_ENABLED ? lazy(() => import('./ledger/LedgerPage')) : null;

export interface AppRoute {
	path: string;
	element: ReactElement;
}

/** The route table of a build, in matching order. The last entry sends every unknown path home. */
export function appRoutes(): readonly AppRoute[] {
	return [
		{ path: '/', element: <LandingPage /> },
		{ path: '/vault', element: <VaultDashboard /> },
		{ path: '/vault/liquidate', element: <LiquidationPage /> },
		{ path: '/pool', element: <StabilityPoolPage /> },
		{ path: '/swap', element: <SwapPage /> },
		...(LedgerPage ? [{ path: '/ledger', element: <LedgerPage /> }] : []),
		{ path: '/redeem', element: <Navigate to="/swap" replace /> },
		{ path: '/transparency', element: <TransparencyPage /> },
		{ path: '/docs', element: <Navigate to="/docs/introduction" replace /> },
		{ path: '/docs/:slug', element: <DocsPage /> },
		{ path: '/terms', element: <TermsPage /> },
		{ path: '*', element: <Navigate to="/" replace /> },
	];
}
