import { Card, CardContent, Skeleton } from '@goldstandard/ui';
import { useActiveCollateralTokens, useGoldPrices } from '@goldstandard/hooks';
import { TARGET_CHAIN_ID } from '@goldstandard/constants';
import { Reveal } from '../components/Reveal';
import { Section, SectionHeader } from '../components/marketing/Section';
import { COLLATERAL_ASSETS, type CollateralAsset } from '../content/site';
import { formatUsd } from '../lib/format';

interface CollateralCardProps {
  asset: CollateralAsset;
  price: number | undefined;
  isLoading: boolean;
  isError: boolean;
}

function CollateralCard({ asset, price, isLoading, isError }: CollateralCardProps) {
  return (
    <Card className="h-full">
      <CardContent className="flex h-full flex-col gap-5 p-6 sm:p-7">
        <div className="flex items-center gap-4">
          <img
            src={asset.image}
            alt={`${asset.name} logo`}
            className="h-10 w-10 rounded-full border border-border bg-card object-cover"
            loading="lazy"
            width={40}
            height={40}
          />
          <div className="min-w-0">
            <div className="flex items-baseline gap-2">
              <h3 className="font-serif text-lg font-semibold tracking-tight text-foreground">{asset.name}</h3>
              <span className="font-mono text-xs font-medium text-muted-foreground">{asset.symbol}</span>
            </div>
            <p className="text-xs text-muted-foreground">{asset.issuer}</p>
          </div>
        </div>

        <p className="text-sm leading-relaxed text-muted-foreground">{asset.blurb}</p>

        <div className="mt-auto flex flex-col gap-1 border-t border-border pt-4">
          <span className="label-mono text-xs text-muted-foreground">Live price</span>
          {isLoading ? (
            <Skeleton className="h-6 w-28" />
          ) : isError || price === undefined ? (
            <span role="status" className="text-sm text-muted-foreground">
              Price feed unavailable, retrying
            </span>
          ) : (
            <span className="nums font-serif text-lg font-semibold leading-none text-foreground">
              {formatUsd(price)}
              <span className="ml-1 text-sm font-normal text-muted-foreground">/ oz</span>
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * The tokenised gold the vault accepts as collateral, with live prices. On a PAXG-first
 * deployment XAUT is registered in the oracle only, so its card stays hidden until
 * governance activates it, with no dapp release. Until the vault has answered, where no
 * vault is configured or when its reads fail, every asset is shown.
 */
export function CollateralStrip() {
  const { paxg, xaut, isLoading, isError } = useGoldPrices();
  const priceFor = (symbol: CollateralAsset['symbol']): number | undefined => (symbol === 'PAXG' ? paxg : xaut);
  const active = useActiveCollateralTokens(TARGET_CHAIN_ID);
  const activeSymbols = active ? new Set(Object.values(active).map((token) => token.symbol)) : undefined;
  // An empty answer means the reads failed, not that no gold is accepted: show every asset.
  const assets =
    activeSymbols && activeSymbols.size > 0
      ? COLLATERAL_ASSETS.filter((asset) => activeSymbols.has(asset.symbol))
      : COLLATERAL_ASSETS;

  return (
    <Section surface>
      <div className="container">
        <SectionHeader
          variant="broadsheet"
          title="Collateral you can verify"
          lead="Only fully reserved, tokenised gold is accepted. Each token is a claim on an allocated troy ounce, priced live by the oracle."
        />
        <Reveal className={`mx-auto mt-12 grid gap-6 ${assets.length > 1 ? 'max-w-4xl sm:grid-cols-2' : 'max-w-md'}`}>
          {assets.map((asset) => (
            <CollateralCard key={asset.symbol} asset={asset} price={priceFor(asset.symbol)} isLoading={isLoading} isError={isError} />
          ))}
        </Reveal>
      </div>
    </Section>
  );
}
