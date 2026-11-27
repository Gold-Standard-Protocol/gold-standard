# Gold Standard Oracle Feed Evaluation: On-Chain Sources for PAXG and XAUT

**Status**: evaluation for a project decision, 28 October 2026. Pre-launch. Nothing in this document changes code or configuration. Every on-chain figure was read from Ethereum mainnet at or near block 26,292,992 (28 October 2026, about 18:20 UTC) through a public RPC and can be reproduced on Etherscan with the calls listed in section 13. Facts that could not be verified are marked **unverified**.

**Scope.** The brief, as revised on 28 October 2026: both XAUT (Tether Gold, 6 decimals) and PAXG (Pax Gold, 18 decimals) live from day one, each priced by validated token market prices; Chainlink XAU/USD kept only as the gold reference; two genuinely independent market sources per token; purely on-chain data verifiable on Etherscan; minimal third-party reliance; the simplest secure design; the strongest viable configuration rather than the cheapest. Pyth and Chainlink Data Streams are kept only as a short comparison (section 10).

Companion documents: [`ORACLES.md`](ORACLES.md) (the feed inventory and runbook), [`LAUNCH.md`](LAUNCH.md) (the launch guide), [`BUSINESS_MODEL.md`](BUSINESS_MODEL.md) (the depth rule) and [`THREAT_MODEL.md`](THREAT_MODEL.md).

---

## 1. Verdict in one page

| | PAXG | XAUT |
|---|---|---|
| Source A | Chainlink PAXG/USD push feed `0x9944D86CEB9160aF5C5feB251FD671923323f8C3` | Uniswap v3 XAUt/USDT 0.05% `0x6546055f46e866a4b9a4a13e81273e3152bae5da`, 30 minute TWAP, times Chainlink USDT/USD, **with protocol-owned liquidity** |
| Source B | Uniswap v3 PAXG/WETH 0.30% `0x8a7e585048bda875e64024118c506b14f78166dd`, 30 minute TWAP, times Chainlink ETH/USD | Uniswap v3 XAUt/WETH 0.30% `0xc5c7c21f4e60770ca5991a8832127a40f5236f73`, 30 minute TWAP, times Chainlink ETH/USD |
| Gold reference | Chainlink XAU/USD `0x214eD9Da11D2fbe465a6fc601a91E62EbEc1a0D6` | same |
| Who can update | Nobody needs to. Chainlink feeds are pushed by the Chainlink network; a TWAP is computed from pool state on every read. Every price is available to any caller, so liquidations never wait on the protocol keeper. | same |
| Independence | **Genuine** for the purpose required. A false liquidation needs Chainlink PAXG/USD to fall, which no on-chain trade can cause. | **Not genuine today.** Both sources are Ethereum pools exposed to the same block producers, the same issuer (Tether freezes XAUT and USDT) and the same arbitrage network. Only one XAUT pool comes near the liquidity floor and none meets it (section 6). |
| Secure at launch? | **Yes**, once the pool's observation cardinality is raised and the new pricing code is in place. | **No, not with unlimited debt.** Secure only with protocol-owned liquidity of at least $10M (recommended $20M) in the XAUt/USDT 0.05% pool and a debt ceiling bound to the measured cost of manipulation. `LAUNCH_CAPS=open` and on-chain XAUT pricing cannot both stand. |

The single most important finding: **concentrated liquidity hides how cheap a TWAP can be to move.** The largest XAUT/PAXG pool on Ethereum (Uniswap v3 0.01%, `0xc756bba710d45647715079ce50aa16aab36ded42`, $6.5M of liquidity, $72.7M of 30 day volume) holds all of it in a sliver around parity. The Uniswap Quoter confirms that 913 PAXG sold into it drives the price to the protocol minimum (`sqrtPriceX96` 4,295,128,740) while returning 912.92 XAUT. Pushed there for a single 12 second block, its 30 minute TWAP moves by about 33% (PAXG down) or 54% (XAUT down), at a cost in fees and arbitrage loss of about $16,000 (PAXG down) or under $2,000 (XAUT down), with no control over block production at all. Pools that look deep can be empty a few percent from the price, and a TWAP over them is only as strong as their thinnest tail.

---

## 2. What the contracts do today, and what the proposed design needs

Read from [`GoldOracle.sol`](../contracts/src/core/GoldOracle.sol):

- **One feed prices each token on the normal path.** `getTokenPrice` reads `feeds[token].feed` through `latestRoundData`, applies the 10% deviation breaker against `lastKnownPrice` and the anchor band against XAU/USD (`crossFeedThreshold`, default 10%, governable 5% to 30%).
- **The confirmation feed is used only in recovery.** `confirmationFeed[token]` is read by `_confirmedPrice` after a token has frozen and the guardian has called `activateRecovery`. It does not cross-check ordinary mints, withdrawals or liquidations.
- **The staleness clock is global.** `stalenessThreshold` (300 to 90,000 seconds) applies to every token feed and to the anchor. Because XAU/USD has a 24 hour heartbeat, it cannot be tightened to give a fast source its own maximum age; any source-specific freshness rule must live in an adapter.
- **`getValidatedPrice` must never revert.** It feeds `emergencyLiquidate`. A TWAP adapter whose `latestRoundData` reverts (for example Uniswap's `OLD` error when the window outruns the stored observations) would break that guarantee. An adapter must catch its own failures and return an invalid answer instead.
- **Every feed must report 8 decimals** (`_addFeed`, `_setFeed`, `setConfirmationFeed`, `setAnchorFeed`).

**Scope note on the working tree.** The points above describe `GoldOracle.sol` as committed at `79e22ab`. While this evaluation was being written, uncommitted work appeared in the working tree: `contracts/src/oracle/UniswapV3TwapFeed.sol` (a TWAP feed with a 10 to 120 minute window, a harmonic-mean liquidity floor and a non-reverting `observe`), changes to `GoldOracle.sol` and two-source tests. That code is outside this evaluation. Two points from this evaluation bear on it directly: its header says moving a TWAP means "holding the pool price away from the market for a large share of the window", whereas section 5 shows a single extreme 12 second push moves a geometric TWAP wherever a pool keeps wide-range liquidity (the harmonic-mean floor catches only pushes that empty the pool); and it has no observation freshness rule of its own, relying on the deviation breaker and the XAU/USD anchor to catch a pool frozen by its issuer.

The design under assessment (section 7) prices each token from two sources at once, takes the minimum for borrowing and the higher agreeing source for liquidation and stops only risk-increasing actions for one token when a source is stale, thin or disagreeing. **None of that exists in the deployed code.** It needs at least a TWAP adapter contract and a composite pricing path in `GoldOracle` or `GoldVault`, which is new code inside the trust perimeter.

---

## 3. Chainlink push feeds (on-chain, readable on Etherscan)

Read on 28 October 2026. "Observed cadence" comes from walking the last 40 rounds of each proxy on-chain (`getRoundData`); it is evidence, not the published configuration. The published heartbeat and deviation for PAXG/USD and XAU/USD are the June 2026 values in [`ORACLES.md`](ORACLES.md). For ETH/USD, USDC/USD and USDT/USD the published values could not be fetched this session (data.chain.link returned HTTP 429) and are **unverified**; the observed cadence is given instead.

| Feed | Proxy | Role | Description, decimals | Answer | Age at read | Published heartbeat, deviation | Observed cadence (last 40 rounds) |
|---|---|---|---|---|---|---|---|
| PAXG/USD | [`0x9944D86CEB9160aF5C5feB251FD671923323f8C3`](https://etherscan.io/address/0x9944D86CEB9160aF5C5feB251FD671923323f8C3) | PAXG source A | "PAXG / USD", 8 | $4,041.09 | 14.2 h | 24 h, 0.5% | longest gap 86,424 s, median move 0.50%, 40 rounds over 330 h |
| XAU/USD | [`0x214eD9Da11D2fbe465a6fc601a91E62EbEc1a0D6`](https://etherscan.io/address/0x214eD9Da11D2fbe465a6fc601a91E62EbEc1a0D6) | gold reference | "XAU / USD", 8 | $4,039.77 | 3.8 h | 24 h, 0.3% | longest gap 86,448 s, median move 0.31% |
| ETH/USD | [`0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419`](https://etherscan.io/address/0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419) | converts WETH TWAPs | "ETH / USD", 8 | $2,342.30 | 34 min | **unverified** (commonly 1 h, 0.5%) | heartbeat-like gaps of 3,612 to 3,636 s |
| USDT/USD | [`0x3E7d1eAB13ad0104d2750B8863b489D65364e32D`](https://etherscan.io/address/0x3E7d1eAB13ad0104d2750B8863b489D65364e32D) | converts USDT TWAPs | "USDT / USD", 8 | $0.998601 | 3.6 h | **unverified** (commonly 24 h, 0.25%) | every one of 40 rounds was a heartbeat, 86,400 to 86,448 s |
| USDC/USD | [`0x8fFfFfd4AfB6115b954Bd326cbe7B4BA576818f6`](https://etherscan.io/address/0x8fFfFfd4AfB6115b954Bd326cbe7B4BA576818f6) | converts USDC TWAPs (not recommended) | "USDC / USD", 8 | $0.999709 | 22.6 h | **unverified** (commonly 24 h, 0.25%) | gaps of 82,800 to 82,836 s (23 h) |

Notes:

- Chainlink does not publish the data providers behind PAXG/USD; whether its inputs include DEX prices is **unverified**. Its manipulation surface is off-chain aggregation across many providers, which no on-chain trade can move.
- There is no Chainlink XAUT/USD push feed on Ethereum mainnet ([`ORACLES.md`](ORACLES.md) section 1, June 2026). Nothing found this session contradicts that.
- Every converting feed adds lag: an ETH move inside the 0.5% deviation band is invisible to a WETH-quoted TWAP converted through ETH/USD. That error is well inside the 2% agreement band.

---

## 4. DEX pool inventory

Sources: pool lists, 24 hour volume and 30 day daily volume from the GeckoTerminal public API (Ethereum network, 28 October 2026); all other columns read directly from each pool. "Max TWAP today" is the age of the oldest stored observation, the longest window `observe` can serve right now. Depth columns give the dollar value that must be sold into the pool to push the **gold token's** spot price down by 2%, 10% and 30%, computed by walking every initialised tick (cross-checked against the Uniswap QuoterV2: selling 16.68 XAUT into `0x6546…` moves the price by 1.97%, against 2.0% in the model). TVL is the token balances held by the pool at Chainlink prices.

### 4.1 PAXG pools

| Pool | Venue, fee | TVL | 24 h vol | 30 d vol | `liquidity()` | Cardinality (next) | Max TWAP today | Depth, PAXG down 2% / 10% / 30% |
|---|---|---|---|---|---|---|---|---|
| `0x8a7e585048bda875e64024118c506b14f78166dd` | Uniswap v3 PAXG/WETH 0.30% | $6.45M | $0.83M | $10.66M | 9.33e21 | 10 (10) | 42 min | $452k / $2.63M / $6.49M |
| `0x5ae13baaef0620fdae1d355495dc51a17adb4082` | Uniswap v3 PAXG/USDC 0.05% | $2.17M | $0.94M | $17.47M | 1.80e17 | 2,500 (2,500) | 182 h | $99k / $256k / $340k |
| `0xb431c70f800100d87554ac1142c4a94c5fe4c0c4` | Uniswap v3 PAXG/USDC 0.30% | $0.76M | $0.03M | $1.08M | 6.36e16 | 51 (51) | 28 h | $36k / $125k / $145k |
| `0x7cb85f75e61226060453a997a7733f76707df337` | Uniswap v3 PAXG/USDT 0.05% | $0.19M | $0.10M | $8.42M | 1.26e16 | 50 (50) | 11 h | $8k / $28k / $30k, then empty |
| `0xc756bba710d45647715079ce50aa16aab36ded42` | Uniswap v3 PAXG/XAUt 0.01% | $6.54M | $3.24M | $72.73M | 6.79e17 | 50 (50) | 60 h | $3.68M / $3.68M / $3.69M, then **empty** |
| `0xed7ef9a9a05a48858a507c080def0405ad1eaa3e` | Uniswap v3 PAXG/XAUt 0.05% | $3.09M | $0.07M | $3.03M | 7.23e16 | **1** (1) | one observation: no history | $533k / $533k / $533k |
| `0x9c4fe5ffd9a9fc5678cfbd93aa2d4fd684b67c4c` | Uniswap v2 PAXG/WETH 0.30% | $14.8M (1,834.76 PAXG, 3,162.83 WETH) | $0.21M | $8.17M | full range | no built-in observations | needs a checkpoint contract | about $75k / $400k / $1.5M (constant product) |

### 4.2 XAUT pools

| Pool | Venue, fee | TVL | 24 h vol | 30 d vol | `liquidity()` | Cardinality (next) | Max TWAP today | Depth, XAUT down 2% / 10% / 30% |
|---|---|---|---|---|---|---|---|---|
| `0xc5c7c21f4e60770ca5991a8832127a40f5236f73` | Uniswap v3 XAUt/WETH 0.30% | $7.24M | $1.47M | $16.50M | 1.54e16 | 360 (360) | 50 h | $490k / $2.84M / $5.87M |
| `0x6546055f46e866a4b9a4a13e81273e3152bae5da` | Uniswap v3 XAUt/USDT 0.05% | $3.77M | $0.72M | $52.31M | 1.28e11 | 300 (300) | 23 h | $67k / $157k / $188k |
| `0xa91f80380d9cc9c86eb98d2965a0ded9e2000791` | Uniswap v3 XAUt/USDT 0.30% | $0.63M | $0.07M | $1.14M | 7.77e10 | 5 (5) | 4 h | $40k / $72k / $82k |
| `0x841ea2475a989eeccd27fe39967c19cb097357a3` | Uniswap v3 XAUt/USDC 0.30% | $0.31M | $0.02M | $0.25M | 1.81e10 | 10 (10) | 12.5 h | $10k / $13k / $16k |
| `0xe8a1f39c16eea2844e98f951d711bb4bb31557ad` | Uniswap v3 WBTC/XAUt 0.30% | $1.13M | $0.08M | $1.31M | 1.57e9 | 256 (256) | 91 h | $32k / $132k / $403k |
| `0xc756bba710d45647715079ce50aa16aab36ded42` | Uniswap v3 PAXG/XAUt 0.01% | $6.54M | $3.24M | $72.73M | 6.79e17 | 50 (50) | 60 h | $2.84M / $2.85M / $2.85M, then **empty** |
| `0xed7ef9a9a05a48858a507c080def0405ad1eaa3e` | Uniswap v3 PAXG/XAUt 0.05% | $3.09M | $0.07M | $3.03M | 7.23e16 | **1** (1) | one observation: no history | $2.55M / $2.55M / $2.55M |

### 4.3 Pools excluded, and why

- **Uniswap v4** (for example XAUt/USDT 0.05% `0xd52eb928…`, $1.67M; XAUt/ETH 0.3% `0x69c36d29…`, $1.11M; PAXG/WBTC 0.3% `0x6ce7046b…`, $1.35M; PAXG/XAUt 0.05% `0x4bb2f106…`, $2.55M). The v4 core has no built-in price oracle; an oracle exists only if the pool's hook implements one. No hook was inspected, so whether any of these pools carries a usable oracle is **unverified**; none is recommended.
- **Curve XAUt/PAXG** `0xc48a38499a90e3b883c509ca08ec1b540cdf15ee`: stableswap with an EMA `price_oracle` (A = 1000, `ma_exp_time` 866 s), but only 54.1 XAUT and 16.8 PAXG ($0.29M). Fails any floor.
- **Fluid PAXG/XAUt** `0x218c659b6bbb73d47c7926fc90d9893342534b84` ($2.26M, $4.2M per 30 days): Fluid DEX oracle behaviour **unverified**; not assessed.
- **Balancer**: the only gold pool found is a three-token Balancer v3 pool of $12k. Fails any floor.
- **Aerodrome Slipstream and Supernova** pools on Ethereum: all under $0.4M, two of them created in the last week. Fail any floor.
- **Listings that are not real liquidity.** GeckoTerminal lists a Uniswap v4 "PAXG / USD" pool `0xca1cf693…` at $100.9M reserve with $20 of daily volume, created on 27 October 2026, and a PancakeSwap "GOLDGR / XAUt" pool at $15.4M with $431 of volume. Reserve figures for pools quoted against an unpriced token are meaningless; neither was considered.
- **Uniswap v2 PAXG/WETH** `0x9c4fe5ff…` is the deepest PAXG pool in absolute terms and its full-range curve makes a short extreme push very expensive. It has no ring buffer of observations, so a TWAP needs a checkpoint contract that someone pokes; that is an extra moving part and is not recommended at launch. It is the natural fallback if the v3 PAXG/WETH pool thins.

### 4.4 Where XAUT and PAXG actually trade

CoinGecko's ticker lists (28 October 2026, 24 hour figures, venue volumes as self-reported and **unverified**): XAUT reports about $189M across its top 100 markets, led by Binance ($29.8M), LBank ($14.7M), BitDelta ($12.8M), OKX ($9.1M), XT.COM, Deepcoin, OrangeX, Gate, Hotcoin and Bybit, almost all against USDT. PAXG reports about $78M, led by LBank ($17.2M), GroveX ($12.9M), Hotcoin ($10.4M) and Binance ($4.7M), with the Uniswap v3 PAXG/XAUt 0.01% pool fifth ($3.2M) and Coinbase PAXG/USD at $1.0M.

Ethereum DEX volume is therefore a small share of XAUT trading (roughly 1 to 3% on these figures). On-chain prices are derivative: they follow the centralised venues through arbitrage. That is acceptable for a TWAP source as long as arbitrage is active, which is why 30 day volume is part of the floor, but it means an on-chain XAUT price can lag or detach when gas spikes, when arbitrage capital is withdrawn or when an issuer freezes tokens.

---

## 5. What it costs to move a TWAP

### 5.1 The model

A Uniswap v3 TWAP is the time-weighted mean of the pool's tick, which is a geometric mean of price. A price held for `t` seconds inside a window of `W` seconds moves the TWAP by `t / W` of its log displacement. Since the Merge, block producers know in advance when they will propose, so three attack shapes matter:

- **Two blocks, attacker controls both** (the Uniswap research calls this a two-block attack): push the price at the end of block `n`, reverse it at the start of block `n+1`. The displaced price is held for one 12 second interval. The attacker pays only swap fees both ways, but must own the capital for one block: **flash loans cannot span blocks.**
- **Two blocks, attacker controls neither**: the same push, but an arbitrageur reverses it. The attacker's cost is the loss to that arbitrage, roughly what it paid above fair value.
- **Sustained push**: no block control at all; the attacker re-pushes in every block of the window and is arbitraged every time. Cost is the per-block arbitrage loss times the number of blocks (150 in 30 minutes).

With control of `k+1` consecutive blocks the displacement is held for `k` intervals and needs `k` times less depth. The Uniswap Labs analysis of TWAP oracles under proof of stake ([blog.uniswap.org/uniswap-v3-oracles](https://blog.uniswap.org/uniswap-v3-oracles)) estimates that a validator with 10% of stake would hold three consecutive blocks about 181 times a month, calls two-block attacks on the deepest pairs "prohibitively expensive" because of the far-tick capital needed and names wide-range liquidity as "currently the best possible mitigation". Current stake shares of individual operators are **unverified**.

Three cheap defences belong in any adapter and are assumed below:

- **Harmonic-mean liquidity floor.** `observe` also returns `secondsPerLiquidityCumulativeX128`. Any second spent with zero in-range liquidity counts as liquidity 1, which collapses the window's harmonic-mean liquidity. Requiring it to stay above a per-pool floor rejects every "band emptied" attack in the tables below.
- **Cardinality.** If a pool stores fewer observations than there are blocks in the window, an attacker can swap in consecutive blocks to overwrite them and make `observe` revert with `OLD`, a cheap denial of service. Cardinality must be at least 1.2 times `W / 12`: 180 for 30 minutes, 360 for 60 minutes.
- **Observation freshness.** A pool whose tokens are frozen by the issuer stops trading, and its TWAP then repeats the last price indefinitely while looking healthy. The adapter must treat a pool with no observation for longer than a calibrated period (provisionally 6 hours) as stale.

### 5.2 Results

Gold token pushed down (the direction that causes false liquidations). "Band emptied" means the swap crosses all in-range liquidity and the price then runs to the end of the range for nothing; the harmonic-mean floor rejects these. "Impractical" means the price would have to fall below a billionth of fair value. All figures in US dollars at block 26,292,992.

**30 minute TWAP**

| Pool | TWAP move | Two blocks: capital | Two blocks: fees (attacker controls both) | Two blocks: loss to arbitrage (attacker controls neither) | Three blocks: capital | Three blocks: fees |
|---|---|---|---|---|---|---|
| PAXG/WETH 0.30% | 2% | $6.49M | $39k | $794k | $6.49M | $39k |
| PAXG/WETH 0.30% | 10% | $6.63M | $40k | $932k | $6.50M | $39k |
| PAXG/WETH 0.30% | 30% | impractical | n/a | n/a | impractical | n/a |
| PAXG/USDC 0.05% | 2% | $447k | $447 | $106k | $376k | $376 |
| PAXG/USDC 0.05% | 10% | $79.87M | $80k | $79.52M | $1.84M | $2k |
| PAXG/XAUt 0.01%, PAXG down | 2%, 10% or 30% | $3.69M (band emptied) | $738 | $15k | $3.69M (band emptied) | $738 |
| PAXG/XAUt 0.01%, XAUT down | 2%, 10% or 30% | $2.85M (band emptied) | $570 | $635 | $2.85M (band emptied) | $570 |
| PAXG/XAUt 0.05%, XAUT down | 2% | $2.56M | $3k | $15k | $2.55M | $3k |
| PAXG/XAUt 0.05%, XAUT down | 10% | $5.14M | $5k | $2.60M | $2.60M | $3k |
| XAUt/WETH 0.30% | 2% | $5.91M | $35k | $634k | $5.89M | $35k |
| XAUt/WETH 0.30% | 10% | $34.52M | $207k | $29.24M | $6.41M | $38k |
| XAUt/WETH 0.30% | 30% | impractical | n/a | n/a | impractical | n/a |
| XAUt/USDT 0.05% | 2% | $303k | $303 | $102k | $223k | $223 |
| XAUt/USDT 0.05% | 10% | $89.92M | $90k | $89.71M | $1.88M | $2k |
| XAUt/USDT 0.05% | 30% | impractical | n/a | n/a | impractical | n/a |

**60 minute TWAP**

| Pool | TWAP move | Two blocks: capital | Two blocks: fees | Two blocks: loss to arbitrage | Three blocks: capital | Three blocks: fees |
|---|---|---|---|---|---|---|
| PAXG/WETH 0.30% | 2% | $6.49M | $39k | $795k | $6.49M | $39k |
| PAXG/WETH 0.30% | 10% | impractical | n/a | n/a | $6.63M | $40k |
| PAXG/USDC 0.05% | 2% | $923k | $923 | $576k | $447k | $447 |
| PAXG/USDC 0.05% | 10% | impractical | n/a | n/a | $79.87M | $80k |
| PAXG/XAUt 0.01%, PAXG down | 2% or 10% | $3.69M (band emptied) | $738 | $15k | $3.69M (band emptied) | $738 |
| PAXG/XAUt 0.01%, PAXG down | 30% | impossible (beyond the pool's price range) | n/a | n/a | $3.69M (band emptied) | $738 |
| PAXG/XAUt 0.01%, XAUT down | 2%, 10% or 30% | $2.85M (band emptied) | $570 | $635 | $2.85M (band emptied) | $570 |
| PAXG/XAUt 0.05%, XAUT down | 2% | $2.57M | $3k | $31k | $2.56M | $3k |
| PAXG/XAUt 0.05%, XAUT down | 10% | impractical | n/a | n/a | $5.14M | $5k |
| XAUt/WETH 0.30% | 2% | $6.08M | $36k | $803k | $5.91M | $35k |
| XAUt/WETH 0.30% | 10% | impractical | n/a | n/a | $34.52M | $207k |
| XAUt/USDT 0.05% | 2% | $840k | $840 | $633k | $303k | $303 |
| XAUt/USDT 0.05% | 10% | impractical | n/a | n/a | $89.92M | $90k |

**Sustained push against arbitrage** (no block control; 150 blocks in 30 minutes, 300 in 60):

| Pool | 30 min, 2% | 30 min, 5% | 30 min, 10% | 60 min, 5% | 60 min, 10% |
|---|---|---|---|---|---|
| PAXG/WETH 0.30% | $992k | $5.56M | $22.09M | $11.12M | $44.18M |
| PAXG/USDC 0.05% | $164k | $771k | $1.28M | $1.54M | $2.57M |
| XAUt/WETH 0.30% | $848k | $5.50M | $22.62M | $11.01M | $45.25M |
| XAUt/USDT 0.05% | $90k | $374k | $734k | $747k | $1.47M |
| PAXG/XAUt 0.05%, XAUT down | $384k | $385k | $386k | $770k | $771k |

### 5.3 Reading the results

- **Cost is set by the tails, not by TVL.** XAUt/USDT 0.05% is deep within 2% of the price but holds only $188k between the price and 30% below it. Most pools have a cliff a few percent away; beyond it a full-range position is all that stands between the attacker and an extreme price.
- **Fees are trivial when the attacker controls the blocks.** For every pool, the two-block attack costs only swap fees plus the capital for one block. On a 0.05% pool that is hundreds of dollars. The defence there is the capital requirement and the rarity of consecutive slots, not cost.
- **A longer window helps against attackers who do not control blocks and hardly at all against those who do.** At 60 minutes a two-block attack becomes impractical for 10% moves in most pools, but a three-block attack (two intervals) is back to the 30 minute two-block figure.
- **The 0.01% PAXG/XAUt pool is unusable as a source** without the harmonic-mean floor, and with it would simply be rejected in an attack. The 0.05% PAXG/XAUt pool holds one observation, so it serves no TWAP until its cardinality is raised.

---

## 6. Liquidity floors and which pools pass

Two floors, because the job differs.

**Floor A: a TWAP that confirms a Chainlink token feed** (PAXG). Pushing it can only make the two sources disagree, which pauses risk-increasing PAXG actions; it cannot cause a false liquidation (section 7). The floor exists to make griefing expensive.

1. Cardinality at least 180 for a 30 minute window (360 recommended).
2. Harmonic-mean liquidity floor enforced on every read.
3. Two-block attack moving the 30 minute TWAP 2% without block control costs at least $500k.
4. 30 day volume at least $5M.

**Floor B: a TWAP that is one of two DEX sources for the same token** (XAUT). Pushing both together causes false liquidations, so the floor must bound a profitable attack.

1. Cardinality at least 180 (360 recommended).
2. Harmonic-mean liquidity floor enforced on every read.
3. Spot depth to move the gold token down 10% of at least $2.5M.
4. Two-block attack with block control moving the 30 minute TWAP 5% needs at least $25M of capital (that is, real wide-range liquidity in the tail).
5. Two-block attack without block control moving the 30 minute TWAP 5% costs at least $1M.
6. 30 day volume at least $10M.

| Pool | Floor A | Floor B | Why |
|---|---|---|---|
| PAXG/WETH 0.30% `0x8a7e…` | **Pass after cardinality is raised** | not needed | $794k arbitrage loss for a 2% two-block push; $10.7M per 30 days; cardinality 10 today |
| PAXG/USDC 0.05% `0x5ae1…` | Fail | Fail | $106k arbitrage loss for a 2% push |
| PAXG/XAUt 0.01% `0xc756…` | Fail | Fail | liquidity ends a fraction of a percent from parity |
| PAXG/XAUt 0.05% `0xed7e…` | Fail | Fail | cardinality 1; $15k arbitrage loss for a 2% push |
| XAUt/WETH 0.30% `0xc5c7…` | Pass | **Fail on item 4 only** | 5% two-block push needs $6.4M, not $25M; passes items 1, 3, 5 and 6 ($2.84M, $1.08M, $16.5M) |
| XAUt/USDT 0.05% `0x6546…` | Fail | Fail on items 3 and 4 | $157k to move 10%; $1.7M capital for a 5% two-block push |
| XAUt/USDT 0.05% `0x6546…` with $20M protocol-owned liquidity | Pass | **Pass** (simulated, section 8) | $3.00M to move 10%; $236M capital for a 5% two-block push |
| All other pools in section 4 | Fail | Fail | depth or volume far below the floors |

**PAXG has a passing pair today** (Chainlink plus PAXG/WETH 0.30%). **XAUT does not**: no pool meets Floor B, and the second on-chain path the brief suggested (XAUT/PAXG TWAP times PAXG/USD) fails in both of its pools.

---

## 7. The proposed design, assessed

The design: per token, two market sources that must agree within 2%; borrowing uses the lowest of both sources and gold; liquidation uses the higher of the two agreeing sources and only inside the gold band; a stale, thin or disagreeing source stops risk-increasing actions for that token only.

**What it gets right.**

- *Borrowing at the minimum of three* means over-borrowing needs both token sources **and** Chainlink XAU/USD pushed up. No on-chain trade moves XAU/USD, so inflation attacks are closed for both tokens.
- *Liquidating at the higher of two agreeing sources* means a false liquidation needs **both** sources pushed down together. For PAXG one of them is Chainlink, so the attack is closed. For XAUT both are pools, so the attack is open and its price is the cheaper pair in section 5.
- *A per-token stop on risk-increasing actions* turns most manipulation into griefing (paused mints and withdrawals) rather than loss.

**Gaps to close before it is safe.**

1. **Disagreement must not halt liquidations.** If a disagreeing pair stops liquidation, a borrower can push one source a little more than 2% away and keep an underwater vault alive while gold falls. If it falls back to the lower source, one manipulated source is enough for a false liquidation. Recommended rule for both tokens: keep the owner's "higher of the two" while the sources agree; when they disagree or one fails its floors, liquidate at the **median of source A, source B and XAU/USD**, still inside the gold band. One manipulated source can never move the median outside the range spanned by the honest source and gold, so neither a push down (false liquidation) nor a push up (shielding an underwater vault) works with a single source. For PAXG a simpler equivalent is acceptable: fall back to Chainlink PAXG/USD alone inside the band.
2. **The gold band limits both attack profit and legitimate liquidation.** A false liquidation at a price depressed by `d` pays the liquidator collateral worth about `1.03 / (1 - d)` of the debt it repays: 5.1% profit at d = 2%, 8.4% at 5%, 14.4% at 10%. A 5% band (`crossFeedThreshold` 50,000, the lowest the contract allows) caps that at 8.4% of the debt of vaults between 110% and 115.8% collateralisation. The cost: a genuine depeg beyond 5% cannot be liquidated on the normal path and must go through freeze and recovery. Recommended: 5% for XAUT, the current 10% for PAXG.
3. **The 2% agreement band will trip in fast markets.** Chainlink PAXG/USD moves in steps of at least 0.5% and a 30 minute TWAP trails a falling market. PAXG traded between about $3,997 and $4,195 over the last 30 days (GeckoTerminal daily closes for PAXG/USDC 0.05%). Expect occasional short pauses of PAXG mints during sharp moves; this is the intended failure mode.
4. **TWAP lag delays liquidation in a crash.** A 30 minute TWAP reports roughly the average of the last half hour. In a 5% drop over 30 minutes it lags by about 2.5%. With a 110% liquidation ratio this is covered, but it is a reason not to lengthen the window to 60 minutes for XAUT.
5. **The adapter must not revert** (section 2), must enforce cardinality, the harmonic-mean floor and observation freshness itself and must report `updatedAt` honestly: the current block time when every check passes, and an invalid answer when any check fails.
6. **The confirmation and recovery path needs rewiring.** Today recovery relies on `confirmationFeed`; with two live sources it should instead accept a recovery price only when both sources agree and pass their floors.

---

## 8. XAUT: what would make on-chain pricing secure

### 8.1 Protocol-owned liquidity

The weak point is the tail of XAUt/USDT 0.05%. Adding protocol-owned liquidity there was simulated by inserting positions into the measured tick map (half full range, half in a band from 20% below to 25% above the price):

| Protocol-owned liquidity in XAUt/USDT 0.05% | Spot depth, XAUT down 10% | 30 min TWAP down 5%, two blocks: capital | Same, loss to arbitrage without block control | Three blocks: capital | Six blocks: capital | Sustained 30 min, 5% |
|---|---|---|---|---|---|---|
| none (today) | $0.17M | $1.7M | $1.50M | $0.4M | $0.2M | $0.33M |
| $5M, all full range | $0.31M | $116M | $113M | $15.0M | $3.1M | $0.54M |
| $5M, half full range | $0.88M | $60M | $58M | $9.1M | $3.1M | $1.44M |
| $10M, half full range | $1.58M | $119M | $114M | $17.8M | $5.9M | $2.54M |
| $20M, half full range | **$3.00M** | **$236M** | **$226M** | **$35.1M** | **$11.6M** | **$4.75M** |
| $20M, all in the band | $5.28M | $12.9M | $2.64M | $11.5M | $11.4M | $8.33M |

**Recommendation: $20M, half full range and half in the band, in XAUt/USDT 0.05%.** It is the smallest simulated size that meets every item of Floor B. $10M split the same way removes the cheap tail but leaves near-price depth at $1.58M, below the $2.5M floor. Concentrating everything in a band deepens the near price but restores a cliff, which is exactly what the two-block attack exploits; full range is what the Uniswap research identifies as the best mitigation.

With that position, a false XAUT liquidation needs both pools moved. XAUt/WETH alone can still be pushed 5% by a two-block attacker for about $38k in fees with $6.4M of capital, but that only causes a disagreement, which pauses XAUT mints and sends liquidation to the median rule. Moving the protected pool too needs $35M for three consecutive blocks, $11.6M for six or $4.75M of losses without block control. For a validator with 10% of stake, six blocks in a row is about a one in a million event per slot, roughly once every four to five months by simple arithmetic (216,000 slots a month); the probability rises steeply with stake share.

### 8.2 What it costs to hold

All **estimates**, to validate with a market maker:

- **Capital**: $20M, half XAUT (about 2,480 XAUT) and half USDT, at the protocol's risk. Both legs are Tether liabilities that Tether can freeze; the position's NFT must be held by governance, not by an operator key.
- **Loss versus rebalancing**: at 20% annual gold volatility, a full-range position loses about σ²/8, roughly 0.5% a year ($50k on $10M); the banded half is about 9.5 times as capital efficient and loses correspondingly more, about 4.7% a year ($470k on $10M). Together roughly $43k a month.
- **Fee income**: the pool earned about $26k in fees over the last 30 days ($52.3M at 0.05%). If the protocol's position held most of the in-range liquidity it would earn most of that, perhaps $20k a month.
- **Net**: roughly $20k a month plus the opportunity cost of $20M of capital, before any change in pool volume. This is the real price of pricing XAUT on-chain.

### 8.3 Debt ceiling

Whatever the liquidity, the profit from a false liquidation scales with XAUT debt and the cost of the attack does not. The ceiling should satisfy: maximum profit at the gold band (8.4% of debt for a 5% band) is less than half the cheapest attack on both sources. Taking the worst case that all XAUT debt sits within reach of the band:

| Configuration | Cheapest attack on both XAUT sources (5%, 30 min) | Implied XAUT ceiling |
|---|---|---|
| No protocol-owned liquidity, attacker controls two blocks | about $40k in fees (XAUt/WETH $38k plus XAUt/USDT $1.7k) and $8M of capital | about $240k, which is not a usable ceiling |
| No protocol-owned liquidity, attacker controls no blocks | about $1.45M (XAUt/WETH $1.08M plus XAUt/USDT sustained $0.37M) | about $8.6M, but only against attackers without block control |
| $20M protocol-owned liquidity | about $4.75M without block control; $11.6M of capital and six consecutive blocks with it | about $28M |

**`LAUNCH_CAPS=open` is incompatible with on-chain XAUT pricing.** With no ceiling the profit from a manipulated liquidation is unbounded and no affordable pool depth covers it. The owner must choose between a bounded XAUT ceiling (ratified in a revision of `ORACLES.md` section 3) and an off-chain XAUT source (section 10).

---

## 9. Costs

ETH priced at **$2,342.30** (Chainlink ETH/USD, read 28 October 2026 about 18:20 UTC). Base fee at the time of reading: **0.144 gwei**. Gas figures are `eth_estimateGas` results against mainnet state, which include the 21,000 transaction base.

### 9.1 One-off: raising observation cardinality

`increaseObservationCardinalityNext` is permissionless; anyone may call it and pay. Measured at about **22,440 gas per new observation slot**.

| Pool | Change | Gas | At 0.144 gwei | 5 gwei | 20 gwei | 50 gwei |
|---|---|---|---|---|---|---|
| PAXG/WETH 0.30% `0x8a7e…` (required) | 10 to 360 | 7,875,385 | $2.66 | $92.23 | $368.93 | $922.33 |
| XAUt/USDT 0.05% `0x6546…` (required) | 300 to 360 | 1,375,182 | $0.46 | $16.11 | $64.42 | $161.05 |
| XAUt/WETH 0.30% `0xc5c7…` | already 360 | 0 | $0 | $0 | $0 | $0 |
| PAXG/XAUt 0.05% `0xed7e…` (only if ever used) | 1 to 360 | 8,077,115 | $2.72 | $94.60 | $378.38 | $945.95 |
| PAXG/XAUt 0.01% `0xc756…` (not recommended) | 50 to 360 | 6,978,805 | $2.35 | $81.73 | $326.93 | $817.32 |

A cardinality increase takes effect only as new observations are written, so it must be done at least one full window (better a day) before the pool is registered as a source.

### 9.2 Per transaction: extra reads on every mint and liquidation

Measured read costs: `observe([1800, 0])` between 33,339 and 89,230 gas depending on the pool and on where the observations sit (about 12,000 to 68,000 above the base), and a Chainlink `latestRoundData` 37,070 (about 16,000 above the base). Today `getTokenPrice` reads one feed and the anchor. Estimated extra gas per priced action, including adapter logic:

| Token | Extra reads | Extra gas (estimate) | 0.144 gwei | 5 gwei | 20 gwei | 50 gwei |
|---|---|---|---|---|---|---|
| PAXG | one TWAP, ETH/USD | about 80,000 | $0.03 | $0.94 | $3.75 | $9.37 |
| XAUT | two TWAPs, ETH/USD, USDT/USD | about 130,000 | $0.04 | $1.52 | $6.09 | $15.22 |

These costs fall on the borrower or liquidator sending the transaction, not on the protocol. At 1,000 priced XAUT actions a month and 20 gwei they total about $6,090 across all users.

### 9.3 Ongoing

- **Price updates: nil.** No source in the recommended configuration needs the protocol to push anything. Chainlink feeds are maintained and paid for by Chainlink and its sponsors; TWAPs are computed on read.
- **Protocol-owned liquidity for XAUT: about $20k a month net plus capital** (section 8.2), the dominant cost of the whole design.
- **Monitoring**: the weekly depth job in `ORACLES.md` section 6 extends to the four source pools; RPC cost negligible.

---

## 10. What was traded away: Pyth and Chainlink Data Streams

Both are off-chain price networks whose signed reports are verified on-chain at the moment of use. Neither leaves a price on Ethereum that Etherscan can show without someone first submitting a report.

**Pyth** (verified this session unless marked):

- Pyth Core on Ethereum mainnet: [`0x4305FB66699C3B2702D4d05CF36551390A4c69C6`](https://etherscan.io/address/0x4305FB66699C3B2702D4d05CF36551390A4c69C6), upgraded in place on 26 August 2026 to take prices from the Pyth Pro backend; a "Pyth Core Compatible" contract sits at `0x14b9932cc9AC8Ee03301665a8644A753f46D8552` and Pyth Pro at `0xACeA761c27A909d4D3895128EBe6370FDE2dF481` ([contract addresses](https://docs.pyth.network/pro/contract-addresses), [Core upgrade](https://docs.pyth.network/pro/pyth-core-upgrade)).
- Update fee: `singleUpdateFeeInWei()` returns **0** on mainnet; governance zeroed Core fees on EVM ([on-chain fees](https://docs.pyth.network/pro/on-chain-fees)).
- **Hermes now requires a paid API key.** Since 26 August 2026 a key is mandatory ("a free trial is included, paid plans cover ongoing use"); an unauthenticated request for the XAUT update on 28 October 2026 returned HTTP 401. Anyone can still submit a signed update to the contract, but only a key holder can fetch one, so "permissionless" now depends on Pyth credentials.
- Feeds exist: `Crypto.XAUT/USD` (`0x44465e17…`) and `Crypto.PAXG/USD` (`0x273717b4…`), both with `min_channel` `fixed_rate@200ms` on Hermes metadata. Exponent -8, so a `PythAggregatorV3` adapter would report 8 decimals.
- **No one pushes them on Ethereum.** The stored XAUT price is $4,494.17 (confidence $4.41) and PAXG $4,527.36 (confidence $4.81), both published about 150 days before this reading, around the start of June 2026. A protocol keeper would have to push every update.
- Publisher counts and names for both feeds: **unverified** (insights.pyth.network not read; the August upgrade changed the backend).

**Chainlink Data Streams**: an XAUT/USD "cexprice" stream exists (data.chain.link, per `ORACLES.md`); its feed ID, schema, bid and ask fields, the Ethereum VerifierProxy and FeeManager addresses, the fee model and whether a PAXG stream exists are all **unverified** this session (data.chain.link returned HTTP 429 and the documentation pages fetched did not inline addresses). Access needs API credentials under a commercial agreement; the price is a quote the owner must obtain.

**What the on-chain design gives up**: a direct XAUT market price aggregated from the centralised venues where XAUT actually trades (section 4.4), with no need for $20M of protocol-owned liquidity. **What it gains**: no API keys, no commercial agreements, no keeper on the critical path, no third-party signer and every input readable on Etherscan. RedStone, Chronicle and API3 were not re-assessed in this evaluation.

---

## 11. Residual risks of the recommended configuration

1. **Multi-block MEV.** A producer with enough consecutive blocks can move any TWAP. For XAUt/WETH it is cheap in fees (about $38k for 5%) though capital-heavy. It causes disagreement and pauses, not loss, while the protected XAUt/USDT pool holds.
2. **Issuer freeze.** Tether can freeze XAUT and USDT held by a pool or by the protocol's position. A frozen pool stops updating and its TWAP repeats the last price; only the freshness rule and the gold band catch it. Both XAUT sources and the protocol-owned liquidity share this risk; it is the main reason the XAUT pair is not genuinely independent.
3. **Shared chain.** Both XAUT sources live on Ethereum and share congestion, gas spikes and block producers. Arbitrage that keeps DEX prices honest slows when gas is expensive.
4. **Chainlink dependence remains.** PAXG source A, the gold reference and the ETH/USD and USDT/USD conversions are Chainlink. A Chainlink outage pauses risk-increasing actions for both tokens.
5. **Liquidity can leave.** Third-party LPs can withdraw at any time; only the protocol's own position is guaranteed. The harmonic-mean floor and the weekly depth job must keep running.
6. **Depeg beyond the gold band.** Liquidation stops on the normal path and the token goes to freeze and recovery, which needs both sources agreeing.
7. **New code.** The adapter and the composite pricing logic are new code inside the trust perimeter.
8. **Model error.** Manipulation costs come from a static model of today's tick map and assume competitive arbitrage; liquidity and volatility change daily. The figures are orders of magnitude, re-measured weekly, not guarantees.

---

## 12. Actions and blockers

**Blockers (XAUT cannot go live on on-chain pricing until each is resolved):**

1. **Resolve the conflict with `LAUNCH_CAPS=open`.** Either set an XAUT debt ceiling bound to section 8.3 (about $28M with $20M of protocol-owned liquidity, far less without) or price XAUT from an off-chain source under a commercial agreement. Record the decision in `ORACLES.md` section 3.
2. **Fund and deploy protocol-owned liquidity**: $20M in Uniswap v3 XAUt/USDT 0.05% `0x6546…`, half full range and half from 20% below to 25% above the price, the position held by governance. Obtain a market maker's view of the costs in section 8.2.
3. **Commission the new code**: a non-reverting TWAP adapter (cardinality, harmonic-mean floor, freshness), the composite pricing path (minimum for borrowing, higher agreeing source for liquidation, median fallback on disagreement, per-token stop on risk-increasing actions) and the recovery rewiring.

**Required for PAXG and XAUT alike:**

4. Call `increaseObservationCardinalityNext(360)` on PAXG/WETH 0.30% `0x8a7e…` and XAUt/USDT 0.05% `0x6546…` at least a day before registering them (section 9.1, under $1,000 at 50 gwei for both).
5. Calibrate, from 30 days of history, each pool's harmonic-mean liquidity floor and observation freshness limit and the TWAP window (30 minutes recommended).
6. Set `crossFeedThreshold` for the liquidation band: 5% for XAUT; keep 10% for PAXG. Note that the contract applies one band to all tokens today, so per-token bands are part of item 3.
7. Extend monitoring: source disagreement, harmonic-mean liquidity, observation age, protocol-owned position health and Tether freeze events on every source pool.

**Unverified facts to close before ratification:**

8. Chainlink's published heartbeat and deviation for ETH/USD, USDT/USD and USDC/USD (observed on-chain only) and the data providers behind PAXG/USD.
9. Whether any Uniswap v4 XAUT or PAXG pool carries an oracle hook, and how the Fluid PAXG/XAUt pool's oracle behaves.
10. Current stake share of the largest Ethereum validator operators and builders, which sets the real probability of consecutive-block attacks.
11. For the comparison only: Data Streams feed IDs, schema, addresses and price; Pyth publisher sets after the August upgrade and the price of a Pyth API key.

---

## 13. Sources and how to reproduce

**On-chain (Etherscan "Read Contract" or any RPC), block 26,292,992:**

- Each pool: `token0()`, `token1()`, `fee()`, `tickSpacing()`, `liquidity()`, `slot0()` (fields 4 and 5 are `observationCardinality` and `observationCardinalityNext`), `observations(i)` for the oldest stored observation, `tickBitmap(int16)` and `ticks(int24)` for the depth walk and each token's `balanceOf(pool)` for TVL.
- Each Chainlink proxy: `description()`, `decimals()`, `latestRoundData()`, `aggregator()` and `getRoundData(roundId)` for the 40 most recent rounds.
- Uniswap QuoterV2 `0x61fFE014bA17989E743c5F6cB21bF9697530B21e`, `quoteExactInputSingle`: 16,682,500 raw XAUT into `0x6546…` at fee 500 gives a price ratio of 0.9803; 913 PAXG into `0xc756…` at fee 100 returns 912.920398 XAUT and leaves `sqrtPriceX96` at 4,295,128,740, the protocol minimum.
- Gas: `eth_estimateGas` from `0x…dEaD` for `increaseObservationCardinalityNext(360)` and `(200)`, `observe` with 2, 11 and 31 points and `latestRoundData`.
- Pyth Core `0x4305FB66…`: `singleUpdateFeeInWei()`, `getPriceUnsafe(id)` for both feed ids.

**Off-chain:**

- GeckoTerminal API, `networks/eth/tokens/{token}/pools` and `networks/eth/pools/{pool}/ohlcv/day?limit=30`, 28 October 2026.
- CoinGecko API, `coins/tether-gold/tickers` and `coins/pax-gold/tickers`, 28 October 2026.
- Uniswap Labs, [TWAP oracles in proof of stake](https://blog.uniswap.org/uniswap-v3-oracles).
- Pyth documentation: [Core upgrade](https://docs.pyth.network/pro/pyth-core-upgrade), [contract addresses](https://docs.pyth.network/pro/contract-addresses), [on-chain fees](https://docs.pyth.network/pro/on-chain-fees), [getting started](https://docs.pyth.network/price-feeds/core/getting-started); Hermes `v2/price_feeds` and `v2/updates/price/latest` queried directly.
- Repository: [`GoldOracle.sol`](../contracts/src/core/GoldOracle.sol), [`ORACLES.md`](ORACLES.md), [`AGENTS.md`](AGENTS.md) for liquidation ratios and the penalty split.

**Method notes.** Depth figures integrate `L · Δ√P` across every initialised tick within 200,000 ticks of the price and gross up for the pool fee; values in dollars use the Chainlink prices above, with XAUT at $4,025 (the XAUt/USDT pool's implied price). The arbitrage loss is the dollar value paid in minus the value received at fair prices. Protocol-owned liquidity was simulated by adding positions to the measured tick map; it does not account for how other LPs would react.
