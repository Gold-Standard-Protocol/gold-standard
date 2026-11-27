# Gold Standard Brand Assets

Final exported marks for **Gold Standard Protocol** (octagonal assay seal with alchemical `G`) and **GSUSD** (matching octagonal assay seal with struck `$`).

## Protocol (`brand/protocol/`)

Use for Gold Standard Protocol profiles, Safe App, docs, and social accounts.

| File | Size | Use |
| --- | --- | --- |
| `protocol.svg` | Vector | Master source (synced with `apps/dapp/public/favicon.svg` and `Wordmark.tsx`) |
| `protocol-32.png` | 32×32 | Explorers and small icons |
| `protocol-64.png` | 64×64 | Compact UI badges |
| `protocol-128.png` | 128×128 | Directories and app listings |
| `protocol-256.png` | 256×256 | CoinGecko / DeFiLlama / token lists / Safe |
| `protocol-512.png` | 512×512 | Transparent mark for GitHub, Discord, docs, press |
| `protocol-1024.png` | 1024×1024 | High-resolution master raster |
| `protocol-social-avatar-512.png` | 512×512 | Padded on warm paper (`#FCFAF8`) for circular avatars (X, LinkedIn, GitHub, Discord) |

## GSUSD Token (`brand/gsusd/`)

Use for GSUSD token listings across explorers, aggregators, and wallets.

| File | Size | Use |
| --- | --- | --- |
| `gsusd.svg` | Vector | Master source (synced with `apps/dapp/public/images/gsusd.svg`) |
| `gsusd-32.png` | 32×32 | Etherscan token info submission (32×32 PNG required) |
| `gsusd-64.png` | 64×64 | DEX / explorer compact token lists |
| `gsusd-128.png` | 128×128 | Wallet token metadata |
| `gsusd-256.png` | 256×256 | CoinGecko, CoinMarketCap, Uniswap / 1inch token lists |
| `gsusd-512.png` | 512×512 | High-DPI wallets, press, integrations |
| `gsusd-1024.png` | 1024×1024 | High-resolution master raster |

## Dapp locations

- Header wordmark: `apps/dapp/src/app/components/Wordmark.tsx`
- Browser favicons: `apps/dapp/public/favicon.svg` and `apps/dapp/public/favicon.ico` (16 / 32 / 48px)
- Safe App manifest icon: `apps/dapp/public/manifest.json` (`favicon.svg`)
- GSUSD token icon: `apps/dapp/public/images/gsusd.svg`
- Social card (`1200×630`): `apps/dapp/public/og.png` (rebuilt via `node tools/render-og.mjs`)
