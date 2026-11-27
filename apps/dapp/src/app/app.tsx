import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReactQueryDevtools } from '@tanstack/react-query-devtools';
import { hashFn } from 'wagmi/query';

import { Suspense, useEffect, useState } from 'react';

import { NavLink, Route, Routes, useLocation } from 'react-router-dom';
import { trpc } from '../trpc';
import { httpBatchLink, httpLink, splitLink } from '@trpc/client';
import { mainnet, sepolia } from 'viem/chains';
import { WagmiProvider, type Config } from 'wagmi';
import { createE2EWalletConfig, E2EAutoConnect, E2E_WALLET } from './e2eWallet';
import { RefreshScope } from '@goldstandard/hooks';
import { parseRpcUrls, TARGET_CHAIN_ID } from '@goldstandard/constants';
import { ConnectButton } from './components/ConnectButton';
import { Wordmark } from './components/Wordmark';
import { FOOTER, PRIMARY_NAV, primaryNav } from './content/site';
import { apiUrl, buildInfo } from './lib/deployment';
import { applyCanonical, applyDescription, ROUTE_DESCRIPTIONS, ROUTE_TITLES, routeDescription, routeTitle } from './lib/routes';
import { appRoutes } from './appRoutes';
import { LEDGER_ENABLED } from './ledger/ledgerFlag';
import { createWalletConfig, walletChains } from './wallet/config';
import { WalletUiProvider } from './wallet/WalletUi';

// The route table (appRoutes.tsx) code-splits every page but the landing page.
const ROUTES = appRoutes();

// Top-level navigation (the wordmark covers Home). The ledger joins it only in a build with
// VITE_LEDGER_ENABLED=true; the conditional is on the build time constant itself, so a build
// without the flag carries neither the entry nor the code that adds it.
const navLinks = (LEDGER_ENABLED ? primaryNav(true) : PRIMARY_NAV).filter((link) => link.to !== '/');

const ENV = import.meta.env as Record<string, string | undefined>;
// The commit this bundle was built from, so a visitor can match the page against the
// published source; linked when the build names the public repository.
const BUILD = buildInfo(ENV);

function BuildStamp() {
  const label = `Build ${BUILD.commit}`;
  return BUILD.sourceUrl ? (
    <a
      className="inline-flex min-h-11 items-center px-1.5 tabular-nums transition-colors hover:text-foreground"
      href={BUILD.sourceUrl}
      target="_blank"
      rel="noreferrer"
    >
      {label}
    </a>
  ) : (
    <span className="inline-flex min-h-11 items-center px-1.5 tabular-nums">{label}</span>
  );
}

function linkClasses(isActive: boolean, centered = false): string {
  return [
    'rounded-md py-1.5 text-sm font-medium tracking-tight transition-colors',
    // The phone nav is a five-column grid: at 400px each cell is about 70px, so the
    // label must be allowed to shrink and clip rather than run into its neighbour.
    // Each cell is a 44px tap target.
    // Desktop links match the 44px header controls beside them (DESIGN.md touch targets).
    centered ? 'inline-flex min-h-11 min-w-0 items-center justify-center truncate px-1 text-center sm:px-3' : 'inline-flex min-h-11 items-center px-3',
    isActive
      ? 'bg-accent text-primary'
      : 'text-muted-foreground hover:bg-accent hover:text-foreground',
  ]
    .filter(Boolean)
    .join(' ');
}

function HeaderNav() {
  return (
    // Desktop nav appears only at lg. Between sm and lg there is not enough
    // room for the wordmark, five links, the chain button and the account
    // button, and the header overflowed and clipped the account control.
    <nav aria-label="Primary" className="hidden items-center gap-1 lg:flex">
      {navLinks.map(({ to, label, end }) => (
        <NavLink
          key={to}
          to={to}
          end={end}
          className={({ isActive }) => linkClasses(isActive)}
        >
          {label}
        </NavLink>
      ))}
    </nav>
  );
}

function MobileNav() {
  return (
    <nav
      aria-label="Primary"
      // Six equal columns would leave 48px for "Reserves" at 390px and clip it, so with the
      // ledger page each column takes the width of its own label and shares what is left.
      className={`container grid ${navLinks.length > 5 ? 'grid-cols-[repeat(6,auto)]' : 'grid-cols-5'} gap-1 border-t border-border py-1 lg:hidden`}
    >
      {navLinks.map(({ to, label, end }) => (
        <NavLink
          key={to}
          to={to}
          end={end}
          className={({ isActive }) => linkClasses(isActive, true)}
        >
          {label}
        </NavLink>
      ))}
    </nav>
  );
}

/** Lightweight fallback while a lazily loaded route chunk is fetched. */
function RouteFallback() {
  return (
    <div
      className="flex min-h-[60vh] items-center justify-center"
      role="status"
      aria-label="Loading"
    >
      <div className="h-6 w-6 animate-spin rounded-full border-2 border-border border-t-primary" />
    </div>
  );
}

function Shell() {
  const location = useLocation();
  const fullBleed =
    location.pathname === '/' || location.pathname.startsWith('/docs');

  useEffect(() => {
    const title = LEDGER_ENABLED ? routeTitle(location.pathname, true) : ROUTE_TITLES[location.pathname];
    if (title) document.title = title;
    // Docs routes included: the link names the page itself, not the home page.
    applyCanonical(document, location.pathname);
    applyDescription(document, LEDGER_ENABLED ? routeDescription(location.pathname, true) : ROUTE_DESCRIPTIONS[location.pathname]);
  }, [location.pathname]);

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-card focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:shadow-lift focus:ring-2 focus:ring-ring"
      >
        Skip to content
      </a>

      <header className="sticky top-0 z-40 border-b border-border bg-background">
        <div className="container flex h-16 items-center justify-between gap-4">
          <Wordmark />
          <div className="flex items-center gap-2 sm:gap-4">
            <HeaderNav />
            <div className="hidden h-6 w-px bg-border lg:block" />
            <ConnectButton />
          </div>
        </div>
        <MobileNav />
      </header>


      <main
        id="main"
        className={fullBleed ? 'flex-1' : 'container flex-1 py-8 sm:py-12'}
      >
        <Suspense fallback={<RouteFallback />}>
          <Routes>
            {ROUTES.map(({ path, element }) => (
              <Route key={path} path={path} element={element} />
            ))}
          </Routes>
        </Suspense>
      </main>

      <footer className="border-t border-border">
        <div className="container flex flex-col items-center justify-between gap-3 py-6 text-xs text-muted-foreground sm:flex-row">
          <p className="flex items-center gap-2">
            <span className="font-serif text-sm text-foreground">
              Gold Standard
            </span>
            <span aria-hidden>·</span>
            <span>{FOOTER.blurb}</span>
          </p>
          {/* Wraps on narrow screens; each link is a 44px tap target. */}
          <nav aria-label="Footer" className="flex flex-wrap items-center gap-x-1 gap-y-0">
            {FOOTER.links.map((link) =>
              link.internal ? (
                <NavLink
                  key={link.label}
                  to={link.to as string}
                  className="inline-flex min-h-11 min-w-11 items-center justify-center px-1.5 transition-colors hover:text-foreground"
                >
                  {link.label}
                </NavLink>
              ) : (
                <a
                  key={link.label}
                  className="inline-flex min-h-11 min-w-11 items-center justify-center px-1.5 transition-colors hover:text-foreground"
                  href={link.href as string}
                  target="_blank"
                  rel="noreferrer"
                >
                  {link.label}
                </a>
              )
            )}
            <span className="inline-flex min-h-11 items-center px-1.5 tabular-nums">© 2026</span>
            <BuildStamp />
          </nav>
        </div>
      </footer>
    </div>
  );
}

export function App() {
  // The target chain only: a wallet on any other network is unsupported and every
  // guarded action asks it to switch.
  const chains = walletChains(TARGET_CHAIN_ID);

  // Without explicit transports wagmi falls back to public endpoints that are
  // aggressively rate limited (observed: HTTP 429 from eth.merkle.io), and
  // because failed reads used to be rendered as a zero balance, a rate limit
  // looked exactly like "you own nothing". Point these at your own RPC. Each variable takes
  // one URL or several separated by commas; a later one is used when an earlier one fails.
  const sepoliaRpcs = parseRpcUrls(import.meta.env['VITE_SEPOLIA_RPC_URL']);
  const mainnetRpcs = parseRpcUrls(import.meta.env['VITE_MAINNET_RPC_URL']);

  // The end-to-end suite replaces the wallet list with a connector the local node
  // signs for (see e2eWallet.ts); production builds refuse the flag.
  const [config] = useState<Config>(() => E2E_WALLET
    ? createE2EWalletConfig(sepoliaRpcs[0])
    : createWalletConfig({
      projectId: import.meta.env['VITE_WALLETCONNECT_PROJECT_ID']?.trim(),
      chains,
      rpcUrls: { [sepolia.id]: sepoliaRpcs, [mainnet.id]: mainnetRpcs },
      origin: typeof window === 'undefined' ? 'https://goldstandard.finance' : window.location.origin,
    }));

  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            queryKeyHashFn: hashFn,
            staleTime: 10_000,
          },
        },
      })
  );
  const [trpcClient] = useState(() =>
    trpc.createClient({
      // Absolute in production: the dapp is served from its own origin (IPFS, an ENS
      // gateway, a mirror) and the API opens CORS to it. Same-origin /trpc in development.
      // The API refuses a batch of more than 20 calls (MAX_BATCH_SIZE in
      // apps/api/src/rateLimiter.ts) with a 400 for every call in it. The dapp's tRPC calls
      // today are prices.prices under two fixed inputs (useGoldPrice, useGoldPrices),
      // vaults.owners and, on the ledger page of a build that has it, ledgerRouter.status
      // and ledgerRouter.account, and React Query dedupes equal keys, so a batch holds five
      // calls at most. The installed
      // @trpc/client (11.0.0-rc.566) has no maxItems on httpBatchLink; it arrives in 11.0.0,
      // and an upgrade should set maxItems: 20 here. Until then, a new query family or a
      // per-token input must keep the count of distinct keys in one render under 20.
      // A mutation would go alone, outside any batch. The dapp sends none today: every
      // procedure it calls is a query.
      links: [
        splitLink({
          condition: (op) => op.type === 'mutation',
          true: httpLink({ url: apiUrl(ENV) }),
          false: httpBatchLink({ url: apiUrl(ENV) }),
        }),
      ],
    })
  );

  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        {/* Dev only: this rendered unconditionally, shipping the devtools bundle and a
            floating debug button to every production visitor. */}
        {import.meta.env.DEV && <ReactQueryDevtools initialIsOpen={false} />}
        <WagmiProvider config={config}>
          {E2E_WALLET && <E2EAutoConnect />}
          <RefreshScope />
          <WalletUiProvider>
            <Shell />
          </WalletUiProvider>
        </WagmiProvider>
      </QueryClientProvider>
    </trpc.Provider>
  );
}

export default App;
