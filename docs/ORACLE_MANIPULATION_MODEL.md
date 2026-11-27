# Gold Standard Oracle Manipulation Model: the Minimum Secure Architecture for PAXG and XAUT

**Status**: model for a project decision, 28 October 2026. Pre-launch. Nothing here changes code or configuration. On-chain figures were read from Ethereum mainnet at or before block 26,292,992 (28 October 2026, 18:19 UTC); centralised exchange order books were read about an hour later (19:24 UTC). Every figure is either measured (with its source in section 12) or marked **assumption** or **unverified**. Raw data and scripts: `scratchpad/model` (section 12).

**Two designs are modelled.** Sections 1 to 12 answer the single-feed architecture with governed ceilings (the project's direction of 28 October, afternoon). Section 13 answers the later direction of the same evening: no borrowing ceiling of any kind, pool TWAPs as the price, with a liquidation price floor, deferred buffer absorption and a liquidation throughput limit. Section 13 leads with its own verdict table.

Companion documents: [`ORACLE_FEED_EVALUATION.md`](ORACLE_FEED_EVALUATION.md) (the source inventory and the TWAP cost tables reused here), [`ORACLES.md`](ORACLES.md), [`LAUNCH.md`](LAUNCH.md) and [`THREAT_MODEL.md`](THREAT_MODEL.md).

---

## 1. Conclusions

**The architecture modelled** (the project's minimum, 28 October 2026): one market feed per token (PAXG: Chainlink PAXG/USD; XAUT: one feed, either (a) a sponsored Chainlink or RedStone XAUT/USD push feed or (b) Pyth XAUT/USD pushed by our own keeper with a paid Hermes key); Chainlink XAU/USD as the gold reference only; per-token freshness, a step deviation gate against the last known price and a gold band breaker; borrowing at the lower of the market feed and gold, blocked while the token is off the gold band; liquidation at the market feed. No second source and no TWAP unless the analysis requires one.

**1. Is it safe to keep liquidating at the single market feed in a genuine depeg?**

- **Not as the rule stands.** If liquidation simply continues at the feed once it leaves the gold band, the attacker's price distortion is no longer capped by the band, and the profit per dollar of debt rises to 60% at a 50% push (section 4). Against that, the cheapest corruption is small:
  - **XAUT on Pyth**: one momentary print on the exchanges Pyth's publishers watch, captured as a signed update and submitted by the attacker (anyone holding a signed update may submit it). Pushing every readable XAUT order book down 50% for one print costs about **$410k** in losses (section 5.2). The bound on the ceiling (safety factor 3) is **$0.23M**. That matches the earlier "about $240k" figure, and it is not a usable ceiling.
  - **XAUT on a sponsored push feed, or PAXG on Chainlink**: the same push must be held for the provider's aggregation period. Assuming 10 minutes, the bound is **$2.3M** (XAUT) and **$2.7M** (PAXG).
- **It becomes safe with one simple rule and no second source: a persistence requirement for off-band liquidation.** Below the band, liquidation runs at the feed as normal. Once the feed leaves the gold band, liquidation continues at the feed only after the breach has been observed on chain continuously for **60 minutes**. The step deviation gate still applies to every read. With the rule in place an attacker must hold every venue off band for an hour, and the binding attack moves back *inside* the band, where the distortion is capped at about 5%. The safe ceilings are in point 3.
- **A second source is not recommended.** No XAUT or PAXG TWAP on Ethereum is reliable enough to confirm a depeg (section 7). XAUt/WETH 0.30%, the best of them, had in-range liquidity at or below **2% of its median** for a quarter of its swaps over the last 45 days. A validator holding three consecutive slots can move its 30 minute TWAP 10% for about $38k in fees. A TWAP confirmation would only be consulted off band, where the persistence rule already costs an attacker far more. Inside the band, where the binding attack sits, a confirmation is never consulted.
- **The price of the persistence rule** is that a genuine fast depeg is liquidated about an hour late, so some bad debt is accepted. The small XAUT ceiling bounds it (section 8).

**2. Deviation gate, gold band and freshness, from measured data** (sections 6 and 9):

| | PAXG | XAUT |
|---|---|---|
| Gold band (borrowing blocked, off-band liquidation clock starts) | **5%** (measured largest gap to gold over 60 days: 0.84%) | **5%** (measured largest gap: 1.14%). Yes, tighter than today's 10%: it doubles XAUT's safe ceiling |
| Step deviation gate against the last known price | **10%**, with the keeper refreshing the last known price at least hourly (largest measured 1 h move: gold 6.28% over 400 days) | **10%**, same refresh rule |
| Freshness | 90,000 s (24 h heartbeat plus 1 h) | Pyth: **60 s** at the moment of use and confidence no wider than 0.5% of price; sponsored push feed: heartbeat plus 10% |
| Gold reference freshness | XAU/USD 90,000 s (24 h heartbeat plus 1 h) | same |

**3. Initial ceilings** (safety factor 3, persistence rule in force):

| | Bound from the cheapest attack | Liquidation capacity bound | **Recommended initial ceiling** |
|---|---|---|---|
| PAXG, Chainlink PAXG/USD | $16.0M (off band, 60 min hold); $23.2M (inside the band) | about $9M | **$5M** (holds if Chainlink needs at least a 3 minute hold and books refill at least every 2 minutes) |
| XAUT, Pyth | $1.62M (one print, every venue); $0.87M if Pyth's publishers follow Binance only | about $9M | **$0.75M** |
| XAUT, sponsored push feed | $13.6M (off band, 60 min hold) | about $9M | **$5M**, once the feed exists |

**Expansion rule**: governance may raise a ceiling at most to the lower of twice the current ceiling and the bound recomputed from the latest weekly depth report, once per 7 days, through the 48 hour timelock. An on-chain guard of at most 2x per 7 days is worth having (section 10). On Pyth, XAUT cannot grow far past about $1.6M unless exchange depth grows. Above that it needs a sponsored push feed.

**4. Cost of each XAUT option** (section 11):

| | One-off | Monthly |
|---|---|---|
| (a) Sponsored Chainlink or RedStone push feed | sponsorship agreement; **neither provider offers XAUT/USD on Ethereum today**; price and lead time not published (**unverified**) | sponsorship fee (**unverified**); gas, if passed through, about $8 at today's 0.144 gwei and $1.1k at 20 gwei (**assumption**: 117 updates of 200k gas) |
| (b) Pyth XAUT/USD with our own pusher | pusher service, a Pyth adapter (8 decimals, 60 s age, confidence filter) and the persistence rule, all new code | Hermes API key (paid plan; price **unverified**); keeper gas for an hourly heartbeat, about $35 at 0.144 gwei and $4.8k at 20 gwei (measured 142,000 gas per update); hosting (**assumption**: $50 to $200) |

**Launch verdict.** PAXG meets the project's requirements with Chainlink PAXG/USD alone, a 5% band, the 60 minute persistence rule and a $5M initial ceiling. That **contradicts `LAUNCH_CAPS=open`**: the open profile is not safe under this model. XAUT meets the requirements on Pyth only at a small ceiling ($0.75M, growing to about $1.6M at most) and only with an always-on pusher holding a paid key; without the persistence rule it does not meet them at any useful ceiling. A sponsored push feed is the only route to a large XAUT ceiling, and it does not exist yet.

---

## 2. Summary table

| | PAXG | XAUT option (a): sponsored push feed | XAUT option (b): Pyth |
|---|---|---|---|
| Provider | Chainlink PAXG/USD `0x9944D86CEB9160aF5C5feB251FD671923323f8C3`, 24 h heartbeat, 0.5% deviation, Chainlink risk category "low" | Chainlink or RedStone XAUT/USD on Ethereum, **not available today** | Pyth `Crypto.XAUT/USD` (`0x44465e17…`), signed updates fetched from Hermes with a paid key and pushed to Pyth Core `0x4305FB66…` |
| Underlying liquidity | Centralised exchanges; readable books hold $4.0M of bids within 0.5% and $12.3M within 10% (Binance, Coinbase, Kraken, OKX, Gate, KuCoin) | XAUT exchange books: $5.4M within 0.5%, $11.3M within 10% (Binance, OKX, Bybit, Gate, Bitget, KuCoin, Kraken) | same books; publishers and their venues **unverified** |
| Who can corrupt it, and how | No on-chain trade can; needs the exchange aggregate held off market through Chainlink's aggregation | same as PAXG | one momentary print on the publishers' venues, captured and submitted by the attacker within the 60 s age limit |
| Gold band, deviation gate | 5%, 10% (hourly refresh) | 5%, 10% | 5%, 10% |
| Freshness | 90,000 s | heartbeat plus 10% (negotiated; **assumption** 1 h heartbeat, 0.5% deviation) | 60 s; confidence no wider than 0.5% |
| Second source | none | none | none |
| Off-band liquidation | after 60 min of continuous breach | after 60 min | after 60 min, with our keeper pushing every 2 min while a clock runs |
| Cheapest attack (persistence rule in force) | inside the band: hold a 5% push for 10 min, about $1.7M (**assumption** on refills) | the same shape: about $1.2M | inside the band: one 5% print on every venue, about $118k (or $64k on Binance alone) |
| Cheapest attack without the rule | 50% push held 10 min, about $4.8M | about $4.1M | one 50% print, about $410k |
| Griefing, cost to stall liquidation for an hour | about $10M (5% push held for 60 min) | about $7M | about $7M if restricted mode clears itself on the next good update; **$118k once** if a breach latches until the guardian acts (today's code latches) |
| Recurring cost | nil to the protocol | sponsorship (**unverified**) | Hermes key (**unverified**) plus about $35 to $4.8k of gas a month |
| Recommended initial ceiling | **$5M** | **$5M** | **$0.75M** |
| Verdict | **Meets the requirements** with the persistence rule and a ceiling; not with `LAUNCH_CAPS=open` | **Would meet them**; not obtainable today, cost and lead time unknown | **Meets them only at a small ceiling**, with a paid key, an always-on pusher and non-latching restricted mode |

---

## 3. What is modelled, and how

### 3.1 The rules

- **Normal pricing.** Each token has one market feed `M`. A read is valid when it is fresh, positive, within the step deviation gate of the last known price and, for borrowing, within the gold band of XAU/USD `G`.
- **Borrowing** (mint, indebted withdrawal) prices collateral at `min(M, G)` and is refused while `M` is off the gold band.
- **Liquidation** prices at `M`. Inside the band it runs as today. Off the band it runs only after the persistence rule (recommended in section 1) is satisfied.
- **Liquidation economics** from [`GoldVault.sol`](../contracts/src/core/GoldVault.sol): liquidation below 110%, penalty 5%, 60% of it to the direct liquidator (so the liquidator receives collateral worth 103% of the debt at the oracle price) and 40% to the protocol; a thin vault (below 105%) gives up all its collateral; an underwater vault is sold at a discount of at most 2%, never more than the shortfall (`_sizeSeizure`).

### 3.2 The attacker

A false liquidation needs `M` reported at `P(1 - d)` while the true price is `P`. The attacker repays a vault's debt `D` in GSUSD and receives collateral sized at the false price. Three ways to obtain the false price matter: corrupting the aggregate the provider reads (exchange order books), choosing which signed update to submit (Pyth only) and, where a TWAP is involved, pushing a pool. Section 5 prices each.

### 3.3 Safety factor

**S = 3.** The order book costs come from one snapshot; the measured on-chain depth of the busiest XAUT pool fell to 63% of its median at the 5th percentile over 45 days (XAUt/USDT 0.05% in-range liquidity, 18,007 swaps), a factor of 1.6. Venue books, the refill rate and the publishers' sources are all **assumptions** with at least a factor of 2 of uncertainty. And an attacker can spread one corruption over every protocol that reads the same feed. 1.6 x 2 rounds up to 3. Several costs below are lower bounds (books truncated at 100 to 400 levels on OKX, Bybit, Bitget and KuCoin), which leans conservative.

---

## 4. Maximum extractable profit as a function of debt

For a vault at true collateral ratio `r` and a liquidation priced at `P(1 - d)`, the vault is eligible when `r(1 - d) < 1.10`, and the attacker's profit per dollar of the vault's debt is:

- seizure fits (`r(1 - d) >= 1.05`): `1.03 / (1 - d) - 1`;
- thin (`1 <= r(1 - d) < 1.05`): `0.4 / (1 - d) + 0.6 r - 1`;
- underwater at the false price: the repayment is the discounted value `R = max(0.98 r(1 - d), 2 r(1 - d) - 1)`, the profit is `0.4 R / (1 - d) + 0.6 r - R` and `1 - R` per dollar of debt is booked as bad debt to the buffer.

The protocol's 40% of the penalty is deducted in each case. **Maximum extractable profit = (asset debt) x k(d)**, with `k(d)` set by how the debt is spread across ratios. Two profiles, computed by `analyse.py`:

- **uniform**: debt spread evenly between 110% and 130% (the minimum mint ratio), a stressed book after a gold fall. Used for the ceilings.
- **edge**: all debt at exactly 110%, the theoretical worst case.

| Push `d` | k(d), uniform | bad debt, uniform | k(d), edge | bad debt, edge |
|---|---|---|---|---|
| 0.5% | 0.10% | 0 | 3.52% | 0 |
| 1% | 0.22% | 0 | 4.04% | 0 |
| 2% | 0.57% | 0 | 5.10% | 0 |
| 3% | 1.05% | 0 | 6.19% | 0 |
| 5% | 2.44% | 0 | 8.11% | 0 |
| 10% | 8.18% | 0.06% | 11.56% | 2.00% |
| 20% | 24.89% | 5.79% | 22.88% | 13.76% |
| 30% | 36.72% | 17.68% | 33.66% | 24.54% |
| 50% | 60.24% | 41.20% | 55.22% | 46.10% |

Up to about 9% the profit comes out of borrowers' equity and the protocol is repaid in full. Beyond it the buffer pays too. **Why the edge profile is not used for the ceilings**: it is a vault sitting exactly at 110%, which an ordinary move liquidates within the hour anyway (the measured 99.9th percentile one hour move is 1.26% for PAXG and 1.46% for XAUT). The attacker's gain there is mostly timing that an honest liquidator would collect soon after. The edge ceilings are shown in section 8 as a sensitivity.

**Over-borrowing is neutralised.** Borrowing values collateral at `min(M, G)` and stops off the band. A borrower profits from over-borrowing only by walking away from a vault whose debt exceeds the collateral's true value. With a 130% minimum and a price capped at gold, that needs a true price below `G / 1.30`, a 23% depeg, which the 5% band blocks. To mask it, an attacker would have to push `M` up by at least 18% and keep it inside the band through the mint, against a 10% step gate. Choosing among signed Pyth updates gains at most 0.15% at the 99.9th percentile (section 5.3), and `G` caps it anyway. A single source pushed up cannot raise a borrowing price above gold.

---

## 5. Cost of corrupting each feed

### 5.1 Chainlink PAXG/USD: out of on-chain reach

No trade on Ethereum moves it. Its node operators report prices from off-chain data providers (which providers is **unverified**; Chainlink does not publish them per feed) and the feed writes a new round on a 0.5% deviation or a 24 hour heartbeat (Chainlink feed directory, read 28 October 2026). The only route is to move the exchange-wide PAXG price and hold it long enough for providers' time-weighted prices and the network's round to follow. **Assumption**: a 10 minute hold, with arbitrage refilling every venue's book once a minute, so the cost is ten times the one-shot loss below. The implication: a PAXG false liquidation is an off-chain market manipulation, detectable and expensive, and its cost scales with exchange depth, not pool depth.

### 5.2 Exchange depth for XAUT and PAXG

One-shot loss to sell each book down by `d` from its mid (value given away against the mid, plus an **assumed** 0.1% taker fee both ways), from public order book snapshots. `*` marks a book whose snapshot ended before `d`, so the figure is a lower bound.

| XAUT venue | Bids within 0.5% | Loss to push 0.5% | 2% | 5% | 10% |
|---|---|---|---|---|---|
| Binance XAUTUSDT | $757k | $3.3k | $20.0k | $63.9k | $109.0k |
| OKX XAUT-USDT | $1,018k | $3.9k | $10.5k* | $10.5k* | $10.5k* |
| Bybit XAUTUSDT | $595k | $2.3k | $3.6k* | $3.6k* | $3.6k* |
| Gate XAUT_USDT | $487k | $2.1k | $4.4k | $6.5k | $9.7k |
| Bitget XAUTUSDT | $1,844k | $8.2k | $18.8k* | $18.8k* | $18.8k* |
| KuCoin XAUT-USDT | $358k* | $1.6k* | $1.6k* | $1.6k* | $1.6k* |
| Kraken XAUTUSD | $386k | $1.7k | $2.0k | $13.3k | $26.2k |
| **All readable venues** | **$5.44M** | **$23.2k** | **$60.9k** | **$118.2k** | **$179.4k** (20%: $399k; 50%: $410k) |

| PAXG venue | Bids within 0.5% | Loss to push 0.5% | 2% | 5% | 10% |
|---|---|---|---|---|---|
| Binance PAXGUSDT | $1,441k | $6.5k | $35.0k | $102.6k | $172.7k |
| Coinbase PAXG-USD | $1,096k | $4.7k | $17.9k | $35.4k | $62.5k |
| Kraken PAXGUSD | $873k | $3.9k | $9.0k | $23.1k | $48.8k |
| OKX, Gate, KuCoin | $602k | $2.3k | $4.9k | $8.7k | $13.1k* |
| **All readable venues** | **$4.01M** | **$17.4k** | **$66.8k** | **$169.7k** | **$297.0k** (20%: $460k) |

Self-reported 24 hour volumes are far larger (XAUT about $189M across 100 markets; [`ORACLE_FEED_EVALUATION.md`](ORACLE_FEED_EVALUATION.md) section 4.4), but the books that can absorb a sell are thin: about $11M of XAUT bids within 10% of the price across seven venues. Venues whose books could not be read (LBank, BitDelta, GroveX, Hotcoin, HTX, MEXC) are **unverified**; if a provider weights a thin venue heavily, corruption is cheaper than shown. Exchange price bands (for example Binance's percent-price filters) may stop a single order from printing 20% to 50% away, which would raise deep-push costs; **unverified**.

### 5.3 Pyth: selective submission

Pyth publishes signed prices continuously off chain (the XAUT feed's channel is `fixed_rate@200ms`); a price reaches Ethereum only when someone submits a signed update. Since 26 August 2026 fetching updates needs a paid Hermes key, but **any holder of a signed update may submit it**. The contract keeps the newest update and ignores older ones (Pyth behaviour per its documentation; not re-tested this session). An attacker can therefore choose, among the updates published since the last stored one and younger than the consumer's maximum age, the one that suits it.

**Ordinary selection** (no manipulation): the gain is the gap between the latest price and the lowest price in the age window. Measured on 44,000 one minute Binance XAUTUSDT candles (30 days):

| Age window | median | 99th percentile | 99.9th percentile | max |
|---|---|---|---|---|
| 1 min | 0.00% | 0.08% | 0.15% | 0.55% |
| 2 min | 0.00% | 0.12% | 0.22% | 0.66% |
| 5 min | 0.01% | 0.19% | 0.35% | 0.82% |
| 10 min | 0.02% | 0.26% | 0.47% | 0.97% |

At 60 s this only lets a liquidator reach vaults within 0.15% of 110% slightly early. **Combined with manipulation** it is the decisive weakness: the attacker needs the publishers' venues off market for **one print**, not for an aggregation period. Under the persistence rule the momentary print still works inside the band (up to 5%), but an off-band liquidation needs an hour of continuous breach, which our keeper's fresh updates expose unless the venues are really held off market. A confidence limit (reject `conf / price` above 0.5%; the one stored XAUT reading had 0.10%, $4.41 on $4,494) adds friction when publishers disagree but does not stop a push that moves every venue together. Pyth's XAUT publisher count and their venues are **unverified**.

### 5.4 TWAP sources, for comparison

From [`ORACLE_FEED_EVALUATION.md`](ORACLE_FEED_EVALUATION.md) section 5 (30 minute window, block 26,292,992): moving XAUt/WETH 0.30% by 10% costs $22.6M sustained against arbitrage, but with three consecutive blocks only $38k in fees ($6.41M of capital); XAUt/USDT 0.05% by 10% costs $734k sustained, $2k in fees with three blocks. PAXG/WETH 0.30% by 10% costs $22.1M sustained, $39k in fees with three blocks. Section 7 explains why none is recommended.

---

## 6. Historical gaps: gold band and deviation gate

Thirty minute samples over 60 days (2,881 samples, 29 August to 28 October 2026). PAXG uses the Chainlink PAXG/USD round history; XAUT uses Binance XAUTUSDT closes times Chainlink USDT/USD as a **proxy for Pyth's aggregate** (Pyth's price history could not be read without a key: the benchmarks endpoint returned no data). Gold is the Chainlink XAU/USD round history.

| Gap to gold, `M / G - 1` | median | 99th pct | 99.9th pct | most negative | most positive |
|---|---|---|---|---|---|
| PAXG (Chainlink) | 0.17% | 0.68% | 0.84% | -0.84% | +0.71% |
| PAXG (Binance) | 0.16% | 0.71% | 0.94% | -1.00% | +0.62% |
| XAUT (Binance x USDT/USD) | 0.13% | 0.90% | 1.07% | -1.14% | +0.39% |

**Gold band 5% for both.** It sits 4.4 to 6 times above the largest measured gap and leaves room for weekend reopens: gold reference steps of up to 1.67% landed at the Sunday evening reopen (1 March 2026; 1 February 2026) in the 400 day XAU/USD history, while the tokens trade through the weekend. A tighter band (3%) would block borrowing more often for little gain; 10% doubles the in-band distortion and halves XAUT's safe ceiling (section 8). PAXG/USD sits within 0.63% of Binance at all times (99.9th percentile 0.61%), consistent with its 0.5% deviation trigger.

| Largest move of a feed against itself | 1 h | 6 h | 24 h | 72 h |
|---|---|---|---|---|
| PAXG/USD (Chainlink, 58 days) | 1.63% | 2.14% | 3.52% | 3.78% |
| XAUT (Binance, 58 days) | 2.05% | 2.08% | 3.69% | 4.01% |
| Gold XAU/USD (Chainlink, 395 days) | **6.28%** | 7.79% | **11.38%** | 13.26% |

**Step deviation gate 10% for both**, provided the keeper refreshes the last known price at least hourly. The gate compares each read with the previous accepted read, so its horizon is the gap between reads: hourly, the worst gold hour in 400 days (6.28%) passes; a daily gap could see 11.38% and trip on a genuine move. The gate is a glitch filter, not a security bound: a sustained manipulation steps through it read by read. A tighter gate for XAUT would not raise any attack cost in section 5.

---

## 7. Is a second source necessary?

No, provided the persistence rule is adopted. The argument:

1. **Inside the band**, where the binding attack sits for every option, a second source would not be consulted under the project's rules (liquidation prices at `M`). Requiring agreement there would be a two-source design, which the project rejected, and it would stall liquidation whenever the sources drift apart.
2. **Off the band**, the persistence rule makes an attacker hold every venue off market for an hour. Under the refill **assumption** that costs $24.6M (XAUT, 50% push) or $29.0M (PAXG), and the ceilings it supports ($13.6M and $16.0M) stay above the recommended ceilings even if books refill only every 5 minutes (XAUT Pyth) or every 2 minutes (PAXG).
3. **No TWAP is reliable enough to add.** Measured over the last 45 days from every swap (section 12): XAUt/WETH 0.30%, the best XAUT pool, had in-range liquidity at or below 2% of its median at the 25th percentile and 0.9% at its minimum; PAXG/WETH 0.30% had zero in-range liquidity for at least 5% of its swaps. A pool whose liquidity near the price comes and goes cannot be trusted to confirm a depeg. And for a validator with three consecutive slots, a 10% push of XAUt/WETH costs about $38k in fees (section 5.4), cheaper than an hour-long exchange manipulation. A TWAP confirmation would lower the cost of the off-band attack for that attacker class, not raise it.
4. **What would justify a second source**: only an independent push feed (Chainlink or RedStone XAUT/USD) alongside Pyth, which would lift the in-band XAUT bound from $1.6M to that of a push feed. If one is sponsored, it should replace Pyth as the single feed rather than sit beside it (section 11).

---

## 8. Ceilings

Ceiling rule: **ceiling = min over d of attack cost(d) / (3 x k(d))**, with the persistence rule in force (inside the band, the base attack; off the band, a 60 minute hold), then capped by liquidation capacity.

| Option | 5% band, uniform | 10% band, uniform | off band, 60 min hold, uniform | Edge profile (sensitivity) | Without the persistence rule, uniform |
|---|---|---|---|---|---|
| PAXG, Chainlink (10 min hold inside the band) | $23.2M | $12.1M | $16.0M | $1.65M | $2.67M |
| XAUT, sponsored push (10 min hold) | $16.2M | $7.3M | $13.6M | $2.19M | $2.27M |
| XAUT, Pyth (one print) | **$1.62M** (Binance only: $0.87M) | $0.73M | $13.6M | $0.22M | **$0.23M** |

**Liquidation capacity.** A stall, or a genuine crash, is bounded by how much seized collateral the market can absorb, not by the oracle: liquidators earn 3%, so seized gold must sell within about 3%. Readable exchange bids within 3% hold $9.5M of XAUT and $9.5M of PAXG; on chain, XAUt/WETH 0.30% and XAUt/USDT 0.05% add $0.56M within 2% and PAXG/WETH 0.30% adds $0.45M (evaluation section 4). A full liquidation seizes 105% of the debt, so about **$9M of debt per token** can clear at once; the stability pool absorbs debt without an immediate sale and relaxes this over hours. Bad debt during a stall is modest at these ceilings: vaults at 110% go under water only after a 9.1% fall, and the largest 24 hour gold move in 400 days was 11.38%; a fall of that size leaves bad debt of 2.5% of the debt then near the threshold.

**Recommended initial ceilings.** PAXG **$5M**: below the capacity bound and the off-band bound, and it holds if Chainlink needs at least a 3 minute hold inside the band ($7.0M) and books refill at least every 2 minutes off the band ($8.0M). XAUT on Pyth **$0.75M**: below the Binance-only bound ($0.87M), for the case in which Pyth's publishers follow one venue. XAUT on a sponsored push feed **$5M**. The edge profile gives lower bounds ($0.22M to $2.19M): if the weekly report (section 10) shows more than a fifth of an asset's debt within 1% of liquidation, governance should hold the ceiling rather than raise it.

**Griefing.** Pushing a feed out of the band blocks borrowing and pauses off-band liquidation until the persistence clock runs out. Holding PAXG or a push feed 5% out costs about $170k or $118k a minute under the refill assumption, roughly **$10M and $7M an hour**. For Pyth, one off-band print costs $118k; if restricted mode clears on the next valid update (our keeper pushes within 2 minutes), holding it for an hour costs about **$7M**. If a breach **latches** until the guardian unfreezes it, as `tripCircuitBreaker` does today, one print buys an indefinite stall for **$118k**. Restricted mode for Pyth must therefore be evaluated on every read, not latched. The other cheap stall is non-adversarial: if our pusher or its Hermes key fails, XAUT goes stale and liquidation stops. Liquidators can push their own updates only if they hold keys.

---

## 9. Freshness limits

- **Chainlink PAXG/USD and XAU/USD**: published heartbeat 24 h (Chainlink feed directory). Maximum age **90,000 s**, the contract's current cap. Measured: 239 PAXG/USD rounds in 61 days, about 3.9 a day.
- **Pyth XAUT/USD**: **60 s** at the moment of use, set by the selective-update window (section 5.3). Users and liquidators bundle a fresh update with their transaction; the keeper refreshes the last known price hourly and every 2 minutes while an off-band clock runs. Confidence no wider than 0.5% of price (**assumption**, five times the one reading observed).
- **Sponsored push feed**: heartbeat plus 10%, with the heartbeat and deviation negotiated (**assumption**: 1 h and 0.5%).
- **Per-token limits need code.** `GoldOracle.stalenessThreshold` is global today ([`ORACLE_FEED_EVALUATION.md`](ORACLE_FEED_EVALUATION.md) section 2); a Pyth adapter must enforce its own 60 s and confidence checks and must never revert inside `getValidatedPrice`.

---

## 10. Controlled expansion of the ceilings

1. **Evidence, weekly**: the depth job ([`ORACLES.md`](ORACLES.md) section 6) extended to read the order books of section 5.2 once a day and recompute the bound of section 8 from the **25th percentile** of seven daily snapshots; the debt profile (share of each asset's debt within 1% and 5% of liquidation); restricted-mode episodes and their causes; for Pyth, pusher uptime and the XAUT publisher count.
2. **Step**: a raise may not exceed the lower of **twice the current ceiling** and the recomputed bound, nor the liquidation capacity of section 8.
3. **Cadence**: at most one raise per asset per 7 days, through the 48 hour timelock. Lowering is free and immediate.
4. **Hold conditions**: no raise while an unexplained restricted episode is open, while the edge share exceeds a fifth of the debt or, for Pyth, while pusher uptime over the week is below 99.9%.
5. **On-chain guard: yes.** A check in the ceiling setter (new ceiling at most 2x the current one and at least 7 days since the last raise) costs a few lines and one storage slot, and it caps the damage of a mistaken or hostile proposal to one doubling per week on top of the timelock's 48 hours. It does not replace the evidence; it bounds the error when the evidence is wrong.

On Pyth today the path is $0.75M, then about $1.5M, after which the measured bound (about $1.6M) stops it. Beyond that XAUT needs deeper exchange books or a sponsored push feed.

---

## 11. Costs of the XAUT options

**(a) Sponsored push feed.**

- **Availability, checked 28 October 2026**: the Chainlink feed directory for Ethereum lists XAU/USD, PAXG/USD and "PAXGy / Gold Exchange Rate", and no XAUT feed. Chainlink offers an XAUT/USD reference price as a Data Streams product (listed in the Arbitrum directory as `XAUT/USD-RefPrice`, with no heartbeat), not as a push feed. RedStone's Ethereum push manifest (`ethereumMultiFeed.json`, 93 feeds) contains no XAUT or PAXG feed; RedStone states it adds assets on request.
- **Cost and lead time**: neither provider publishes sponsorship prices or lead times; both must be quoted (**unverified**). Gas, if passed through: at PAXG/USD's measured cadence (about 117 rounds a month) and an **assumed** 200,000 gas a round, about $8 a month at 0.144 gwei and $1.1k at 20 gwei.
- **Independence**: Chainlink feeds are reported by a network of separate node operators; the operator set for a new feed and RedStone's operator set on Ethereum are **unverified**.
- **What it buys**: corruption needs a sustained exchange push, not a single print, so the XAUT bound rises from $1.6M to about $13.6M and no keeper or API key sits on the critical path.

**(b) Pyth with our own pusher.**

- **One-off**: the pusher service; a Pyth adapter reporting 8 decimals with the 60 s age and confidence checks; the persistence rule and non-latching restricted mode in `GoldOracle`.
- **Monthly**: the Hermes key (paid plan; "a free trial is included, paid plans cover ongoing use"; price **unverified**). Gas at a measured **142,000 gas per single-feed update** (ten recent Pyth Core update transactions, 141,993 to 164,748 gas) and an on-chain update fee of zero: an hourly heartbeat is 720 updates, about **$35 a month at 0.144 gwei** (ETH $2,342.30) and **$4.8k at 20 gwei**; each off-band episode adds about 30 updates. User and liquidator bundles are paid by them. Hosting and RPC: **assumption** $50 to $200.
- **Liveness**: XAUT is priced only while someone holding a key pushes. A lapsed key or a stopped pusher stops XAUT liquidation.

**PAXG**: no recurring cost; Chainlink's feeds are paid for by Chainlink and its sponsors. A `latestRoundData` read costs about 37,000 gas, paid by the caller.

---

## 12. Assumptions, unverified facts and reproduction

**Assumptions** (each moves the numbers; the recommendations were checked against the stated sensitivity):

1. Exchange books refill once a minute after a push; Chainlink needs a 10 minute hold (section 5.1). Sensitivity in sections 7 and 8.
2. Pyth's aggregate follows the readable venues; Binance-only shown as the pessimistic case.
3. Taker fee 0.1% each way; the attacker buys back at the mid.
4. Debt spread uniformly between 110% and 130% (uniform profile); edge profile as sensitivity.
5. Binance XAUTUSDT times USDT/USD stands in for Pyth's XAUT history.
6. 200,000 gas per sponsored push round; hosting $50 to $200 a month.

**Unverified**: Chainlink's data providers for PAXG/USD; Pyth's XAUT publishers, their venues and its confidence distribution; Pyth's handling of older updates (documented, not re-tested); sponsorship price, lead time and operator sets for Chainlink and RedStone; Hermes plan prices; books of LBank, BitDelta, GroveX, Hotcoin, HTX and MEXC; exchange price-band filters.

**Data and scripts** (kept in a local working directory, not in this repository):

- `swaps.py`: every Uniswap v3 `Swap` log (tick, in-range liquidity, block timestamp) for `0x8a7e585048bda875e64024118c506b14f78166dd`, `0xc5c7c21f4e60770ca5991a8832127a40f5236f73` and `0x6546055f46e866a4b9a4a13e81273e3152bae5da`, blocks 25,968,992 to 26,292,992, via `rpc.mevblocker.io` and `mainnet.gateway.tenderly.co`.
- `chainlink_hist.py`: `getRoundData` walks on PAXG/USD (61 days), XAU/USD (400 days), ETH/USD (60 days) and USDT/USD (43 days) proxies.
- `raw/`: order books (Binance via `data-api.binance.vision`, OKX, Bybit, Gate, Bitget, KuCoin, Kraken, Coinbase public APIs, 28 October 2026 about 19:24 UTC); Binance 30 minute and 1 minute klines; Chainlink feed directories (`reference-data-directory.vercel.app`); RedStone manifest (GitHub `redstone-finance/redstone-oracles-monorepo`); Pyth Core logs and receipts (`ethereum-rpc.publicnode.com`); Pyth benchmarks feed metadata.
- `analyse.py` (gaps, moves, selective-update windows, book costs, profit coefficients; output `analyse_out.txt` and `model_out.json`) and `ceil.py` (ceilings and gold steps).
- Contract logic: [`GoldVault.sol`](../contracts/src/core/GoldVault.sol) (`_sizeSeizure`, `liquidatorIncentiveShare`, `underwaterDiscountPpm`) and [`GoldOracle.sol`](../contracts/src/core/GoldOracle.sol) (`deviationThreshold`, `crossFeedThreshold`, `tripCircuitBreaker`, global `stalenessThreshold`).

---

## 13. The no-ceiling design

**Design assessed** (project direction, 28 October 2026, evening). Per token, the price is the median of six 5 minute sub-window TWAPs over 30 minutes from one registered Uniswap v3 pool (PAXG/WETH 0.30%; for XAUT either XAUt/USDT 0.05% or XAUt/WETH 0.30%), the quote converted with Chainlink ETH/USD or taken as $1 for USDT; gold band 5% against Chainlink XAU/USD; borrowing at min(price, gold); no debt ceiling. Three rules: (1) for the first 60 minutes outside the band, liquidation prices at max(TWAP, 0.95 x gold), after 60 minutes of continuous breach at the TWAP; (2) bad debt booked in breach is absorbed from the SurplusBuffer only once the price is back in band or the breach has lasted 24 hours; (3) at most T% of a token's collateral may be liquidated per rolling hour. Variant 2 adds an exchange-aggregated source B (PAXG: Chainlink PAXG/USD; XAUT: Pyth XAUT/USD or a sponsored push feed), borrowing at min(A, B, gold) and liquidation at the higher of A and B only while they agree within a tolerance. All pool figures are at block 26,292,992; exchange books as in section 5.2; the debt profile is the uniform one of section 4. Scripts: `median_model.py`, `noceiling.py`, outputs `median_out.txt`, `noceiling_out_fixed.txt`.

**Correction, 29 October 2026.** The first version of this section computed D* as three times cost divided by profit share instead of cost divided by three times profit share, so every D* was nine times too high. The figures below are corrected; the cost and profit figures were not affected. Section 14.3 also finds that PAXG/WETH's depth is twelve days old, which qualifies every PAXG pool figure here.

### 13.1 Verdict

Two different losses must be kept apart. **Equity extraction**: a push inside the band (at most 5%) liquidates vaults that were within 5% of the threshold; borrowers lose the penalty, the protocol earns its 2% and books no bad debt. **Drain**: a push past about 9% that liquidates healthy vaults under water, which books bad debt; it needs the token off the band for 60 continuous minutes under rule (1). "D*" is the outstanding debt in the token at which the attacker's profit reaches one third of the cost (safety factor 3). "Floor" is the harmonic-mean liquidity floor already in `UniswapV3TwapFeed`, set at about half the pool's trailing in-range liquidity.

| Token, pool | Variant | Equity extraction becomes worthwhile at D* (T = 10%) | Drain (off band 60 min) | Validator with 4 two-slot runs in 30 min (every 0.55 days at 10% stake) | Cheap stall | Plain verdict |
|---|---|---|---|---|---|---|
| PAXG, PAXG/WETH 0.30% | pools only | $21M (0.5% push, $0.10M for 20 min) | not feasible: $46M an hour at 10%, $238M at 30% | 5% median move for $155k of fees and $6.5M of capital; D* $5.4M; with the floor it is a 30 minute stall | one block in the tail trips the floor: fees only for a validator, millions in losses for anyone else (a single 30% block loses $0.8M) | **Not drainable.** Borrower equity is exposed above about $21M of PAXG debt, or $5.4M against a 10% staker without the floor. Acceptable with the floor, T at or below 20% and a debt bound near $20M. |
| PAXG | plus Chainlink PAXG/USD | $76M (2% push, Chainlink held 10 minutes) | not feasible | moving the pool alone only breaks agreement, so liquidation stalls | pool pushed 3% for an hour: $4.8M | **Not drainable, not practically extractable.** The stall costs more than any PAXG griefer gains. |
| XAUT, XAUt/USDT 0.05% | pools only | **$2.1M** (0.5% push, $7k for 20 min) | $34M without the floor (30% push, $3.2M an hour, $0.2M of capital); with the floor the push trips it and nothing is liquidated | 5% to 10% median move for **$900 of fees** and $0.2M of capital; D* **$31k**; the floor turns it into a stall | one block into the thin tail: a few hundred dollars for a validator, up to about $0.2M in losses otherwise; 30 minutes stalled each time | **Drainable above about $34M of XAUT debt without the floor, and broken at any debt by a 10% staker without it.** With the floor it is not drainable but is cheaply stallable, and borrower equity is exposed above about $2.1M of XAUT debt. |
| XAUT, XAUt/USDT | plus Pyth | about $7M (2% pool push for 20 minutes plus one 2% print, about $0.13M) | as pools only; the exchange side adds $0.4M an hour at 30% (one print at each liquidation) | stall only | pool pushed 1.5% for an hour: about $0.13M | **Not drainable with the floor; equity exposed above about $7M.** Pyth adds little because one print is enough. |
| XAUT, XAUt/USDT | plus a sponsored push feed | $39M (2% push, feed held 10 minutes) | as pools only | stall only | about $0.13M an hour | **Not drainable with the floor; equity exposed above about $39M.** The feed does not exist today. |
| XAUT, XAUt/WETH 0.30% | pools only | $23M | not feasible: $48M an hour at 10%, $181M at 30% | 5% to 10% move for $139k of fees and $5.8M of capital; D* $4.8M; floor turns it into a stall | the pool's own in-range liquidity sits at or below 2% of its median for a quarter of its swaps, so with the floor the price would stop about a quarter of the time with no attacker at all | **Not drainable, but not usable with the floor,** and without the floor exposed to a 10% staker above $4.8M. |

**Can this design be drained?** PAXG: no, in either variant, at any debt the gold market could plausibly carry. XAUT on XAUt/USDT: yes, without the harmonic-mean floor, at about $34M of debt by a sustained attacker and at any debt by a 10% staker; with the floor, no, but the price can be stopped for 30 minutes at a time for a few hundred dollars by a validator or about $0.2M by anyone, which is the exposure the three rules do not address. The three rules do their work only on the drain path; none of them touches the in-band equity attack, which is bounded only by pool depth.

### 13.2 Cost per hour of a sustained push (today; multiply by 5 for five times the liquidity, assuming the same shape)

| Pool | 5% | 10% | 30% | 20 minutes at 5% (the minimum to move the sub-window median) |
|---|---|---|---|---|
| PAXG/WETH 0.30% | $12.2M | $46.3M | $237.7M | $4.1M |
| XAUt/WETH 0.30% | $12.3M | $47.8M | $181.2M | $4.1M |
| XAUt/USDT 0.05% | $0.78M | $1.54M | $3.15M (the liquidity band is exhausted; the window's harmonic liquidity falls to 12% at 10%) | $0.26M |
| Exchange books, XAUT (one push a minute) | $7.1M | $10.8M | $24.2M | one Pyth print: $118k, $179k, $403k |
| Exchange books, PAXG | $10.2M | $17.8M | $27.6M | Chainlink, 10 minute hold: $1.7M, $3.0M, $4.6M |

Small pushes are far cheaper and are what binds: 0.5% for 20 minutes costs $0.10M on PAXG/WETH, $0.08M on XAUt/WETH and **$7k** on XAUt/USDT.

### 13.3 Extractable profit per hour as a share of D, with the three rules

In band (or in the first off-band hour, where rule (1) pins the price at 0.95 x gold), the profit is one shot: `D x min(k(d), u(d) x 1.14 T)`, with `u(d) = 1.03 / (1 - d) - 1` and 1.14 T the share of debt whose 105% seizure fits in T% of collateral.

| Push d | eligible debt | profit, T = 5% | T = 10% | T = 20% | no limit |
|---|---|---|---|---|---|
| 0.5% | 2.8% | 0.10% | 0.10% | 0.10% | 0.10% |
| 2% | 11.2% | 0.29% | 0.57% | 0.57% | 0.57% |
| 5% | 28.9% | 0.48% | 0.96% | 1.92% | 2.44% |
| 30%, after 60 minutes off band, per hour | 100% | 2.09% | 4.18% | 8.37% | 36.7% once |

Rule (2) changes when the buffer pays, not what the attacker keeps: the liquidator already holds the gold. It helps only if unabsorbed bad debt can be reversed, which the contracts do not do. Rule (3) binds only from 2% (T = 5%) or 3% (T = 10%) upwards; it never touches the 0.5% to 1% attacks that set D*.

### 13.4 Honest cost of rule (3) in a genuine 30% gold crash

Bad debt as a share of D (uniform profile, 30 minute TWAP lag, liquidators act only when the seizure is worth more than they pay at the true price, taking the best vaults first). The TWAP lag alone already stops liquidation in a one hour crash.

| Fall over | T = 5% | T = 10% | T = 20% | no limit |
|---|---|---|---|---|
| 1 hour | 17.5% | 17.2% | 16.5% | 11.5% |
| 6 hours | 15.2% | 11.5% | 7.2% | 0.0% |
| 24 hours | 9.7% | 4.5% | 2.0% | 0.0% |

In dollars at T = 10%, a 6 hour crash: $5.8M on D = $50M, $58M on $500M, $0.6M on $5M; a 24 hour crash: $2.3M, $23M, $0.2M. The percentages are scale free in the model; at $500M the exchange books ($9.5M of bids within 3%) would make every figure worse. **Proposed T: 20%.** It costs 2.0% of D in a 24 hour crash and 7.2% in a 6 hour one, and caps the hourly drain at 8.4% of D, which matters only where the floor is absent. T = 5% costs up to 15% of D in a slow crash for no change to D*, because the binding attacks are below its reach.

### 13.5 Rule (1) in a genuine depeg

With the price pinned at 0.95 x gold while the token really trades lower, a liquidator receives collateral sized at 0.95 x gold and pays the full debt, so nobody liquidates once the token is below about 90.5% of gold; the first hour is a stall. Measured cost against the same path without the rule: a 30% depeg in one hour books 12.7% of D against 11.5% (no T) and the same 16.5% to 17.5% with any T; over 6 or 24 hours the difference is 0.2 to 0.4 points. The rule adds up to an hour of delay on top of the TWAP's own 15 to 30 minutes; in a fast depeg both are already too slow, so its cost is small, and it is what stops the off-band drain.

### 13.6 Variant 2: tolerance and the one-source stall

Measured gap between the pool's last trade (times the quote feed) and the exchange feed, 30 minute samples over 45 days: PAXG/WETH against Chainlink PAXG/USD 99.9th percentile 1.51%, maximum 1.57%; XAUt/USDT against Binance XAUT (the Pyth proxy) 0.11% and 0.16%; XAUt/WETH 0.62% and 0.64%. **Tolerance: 3% for PAXG, 1.5% for XAUT** (twice the 99.9th percentile, rounded up; the XAUT figure allows for Pyth's own dispersion, an assumption). A griefer who pushes one source past the tolerance stops liquidation for as long as the push holds: the pool is the cheap side, about $4.8M an hour for PAXG (3% on PAXG/WETH) and about $0.13M an hour for XAUT (1.5% on XAUt/USDT), or fees only for a validator who trips the floor. Pushing the Pyth side does not work for long, because the keeper's next honest update overrides a stale low print.

### 13.7 Freshness for a frozen or idle pool

A pool writes an observation only when a swap changes the tick or an in-range position changes, so an issuer freeze leaves `observe` repeating the last tick for ever. The rule: refuse the price when `block.timestamp` minus the timestamp of `observations[slot0.observationIndex]` exceeds a limit. Measured gaps between writes over 45 days: PAXG/WETH 99.9th percentile 10.0 hours, maximum 18.7 hours; XAUt/WETH 6.2 and 8.6 hours; XAUt/USDT 2.1 and 6.0 hours. **Limits: 24 hours for PAXG/WETH, 12 hours for the XAUT pool.** A quiet pool is not a stale pool: no trade means no arbitrage was worth the fee, so the price is at most a fee band away from the market, which is why the limit can be loose; it exists for the freeze case alone.

### 13.8 Why this design is worse than the single-feed design, stated plainly

1. **For XAUT it reprices the asset from a $16M pool.** XAUt/USDT 0.05% can be moved 0.5% for $7k and stalled for a few hundred dollars by a validator; its tails hold $190k. Pyth or a sponsored feed aggregates exchanges holding $11M of bids within 10%.
2. **Validators.** The sub-window median does not stop a 10% staker, who gets the four two-slot runs it needs about every 13 hours; only the harmonic floor does, by stopping the price. The single-feed design has no validator surface.
3. **No ceiling means borrower equity is the safety margin.** Every D* above is where an attack on borrowers pays; nothing in the design caps D, so the protocol relies on the attack staying unattractive as it grows.
4. **The floor and the throughput limit both cost in honest markets**: the floor stops XAUt/WETH a quarter of the time, and T costs 2% to 17% of D in a 30% crash. The single-feed design pays neither.
5. **For PAXG the designs are close**: Chainlink PAXG/USD cannot be moved on chain at all, while PAXG/WETH costs $12M an hour to hold 5% away; the pool design merely adds the validator and stall surfaces.

---

## 14. PAXG-first rules

**Rules assessed**: [`ORACLE_IMPLEMENTATION_PLAN.md`](ORACLE_IMPLEMENTATION_PLAN.md) sections 1 to 4. C = Chainlink PAXG/USD; P = `UniswapV3TwapFeed` on PAXG/WETH 0.30% (median of six 5 minute sub-window mean ticks, a floor on the whole window's harmonic-mean in-range liquidity, 24 hour observation freshness) times Chainlink ETH/USD; G = Chainlink XAU/USD. The rules: liquidation at C while |C − G| ≤ g; at max(C, P) when C is off the band and |C − P| ≤ a; at P when C is stale and |P − G| ≤ g; otherwise refused. Borrowing at min(C, P, G) only with all three valid and in agreement. Pool state at block 26,292,992; history over the 45 days to that block; uniform debt profile 110% to 130%; D* = cost / (3 x profit share), the debt at which the attacker's profit reaches one third of the cost. Scripts: `lplogs.py`, `p_avail.py`, `sec14.py`; output `sec14_out.txt`.

### 14.1 Conclusions

1. **The liquidation rules hold in a gold crash.** Row 1 prices every gold-wide move at C within about a minute. No rule set booked bad debt in the worst real gold hour in 400 days (a 6.66% fall from 14:37 UTC on 29 January 2026), the worst real day (11.87% from 18:42 UTC the same day), a synthetic 10% in one hour or 30% over 24 hours. In a synthetic 30% fall in one hour, these rules book nothing, while the old higher-of-two with agree-or-stop books 16.1% of D.
2. **P's depth is twelve days old and held by three addresses.** Until 16 October the pool held about 4 PAXG and in-range liquidity of 2.6e18 to 3.2e19, which is 0.03% to 0.3% of today's 9.33e21 (archive reads, section 14.3). The current depth was minted between 16 and 28 October. `0x8eca8b48…` supplies about 56% of in-range liquidity, `0xcb1ae609…` 33% and `0xac9e35b1…` 11%.
3. **Requiring P for borrowing is not acceptable as planned.**
   - With any floor that gives security, P was invalid **72.7% of the last 45 days** (all of 13 September to 16 October). It has been invalid 0% of the time since 17 October.
   - Borrowing stops whenever the two largest LPs withdraw, which costs them nothing.
   - Anyone else can stop it by pushing the pool for one block: $39k per 30 minutes, or $4.9k for a builder holding two consecutive blocks.
   - P adds at most g (2%) of protection to borrowing, because min(C, G) is already capped by gold.
   - **Recommendation: borrowing at min(C, G) with |C − G| ≤ g, lowered further by P when P is valid. P never gates borrowing.** This departs from the plan's "no fallback" rule, for the reasons above.
4. **Disabling P cannot cause a false liquidation.** Row 1 never reads P. What it buys an attacker is a stall in a genuine PAXG-specific depeg: with C off the band from G, rows 2 and 3 need P, and liquidation stops. That costs about $9.7k an hour through a builder, $77k an hour otherwise and nothing for the dominant LPs. **C cannot be disabled by any on-chain action**, and neither can G.
5. **D* per path:**
   - (a) C pushed inside the band: **$37.3M**. This falls to $11.2M if Chainlink can be moved with a 3 minute hold, and to $7.5M with a 2 minute hold.
   - (b) C pushed beyond the band with P pushed too: $67.4M, or $25.9M with the pool at the floor. **Superseded for the final rules** (section 14.7): a block builder can set P with four one-block spikes instead of trading it (F1, section 14.7), which gives **$2.8M**, or $2.7M with the pool at the floor.
   - (c) A Chainlink outage with P pushed inside the band: **$20.6M** today, **$6.6M** with the pool at the floor. Under the final rule 3 (max(P, G)) these figures apply only while C's premium over gold is at least 0.5% (1.3% of samples), and the gain is capped at that premium (section 14.7).
   - (d) Disable P, then (a): the same as (a).
   - The final rules add rule 4 (section 14.7): holding C just off the band for an hour and deepening the push only at the end gives $5.05M, or $4.45M to $4.55M with the variants modelled there.
6. **Recommended parameters:**
   - **g = 2%** and **a = 3%**.
   - **Floor `minHarmonicLiquidity` = 3e21**, about $18.4M of virtual reserves.
   - ETH/USD maximum age **5,400 s** and observation freshness 24 hours.
   - **Backstop ceiling $5M**: the lowest D* with the pool at the floor ($6.6M, path c) divided by a margin of 1.3. **Superseded for the final rules** (section 14.7): their lowest D* is $2.8M ($2.7M at the floor, path b with a forged P), so this basis no longer holds and the same rule would give about $2.1M. **Superseded by 14.8**: the project launches with no ceiling and a liquidation floor instead.
7. **Residual risks:**
   - **G's margin is under an hour.** The longest XAU/USD gap in 400 days was 86,496 s against a 90,000 s limit, and a stale G refuses every row.
   - **Fast PAXG-specific crashes.** A 30% fall in one hour with gold steady books 13.7% of D under these rules, against 11.8% under the old 60 minute delay. Here the only confirmation available is the lagging pool.

### 14.2 Disabling a source

The floor applies to the whole 30 minute window, so one 12 second interval in which in-range liquidity sits below `12 / (1800 / floor − 1788 / L)` invalidates P for 30 minutes. With a 3e21 floor the threshold is 2.9e19. The nearest such region is above the largest in-range position: **PAXG pushed up 14.6%** at the end of one block.

| Who | Cost per attempt (30 minutes) | Per hour | Per day |
|---|---|---|---|
| Anyone: push at the end of block n; the next block's arbitrageur reverses it | $38.6k loss, $0.81M capital for one block | $77k | $1.85M |
| Builder or proposer holding blocks n and n+1 | $4.9k in fees | $9.7k | $233k |
| Titan, attempting without knowing whether it wins n+1 (about 48% of slots) | about $22.5k expected | $45k | $1.1M |
| The dominant LPs | nothing: burning `0x8eca8b48…` leaves 4.1e21 (still above the floor); burning the two largest leaves about 1.0e21 and P stops | nil | nil |

**Builder shares** (relayscan.io, 7 days to slot 15,532,920): Titan 53.0% of MEV-Boost blocks, Quasar 20.3%, BuilderNet 12.2% and Eureka 8.3%. MEV-Boost delivered about 90% of slots, so Titan built about 48% of all blocks and holds two consecutive blocks about 23% of the time. Proposer stake shares remain **unverified**.

**C and G cannot be disabled on chain.** Forcing C off the band takes a sustained exchange push, about $67k a minute for 2% under the refill assumption of section 5.2.

| Stale or invalid | Liquidation | Borrowing (plan) | Borrowing (recommended) |
|---|---|---|---|
| C | row 3: P, if P is valid and within g of G | refused | refused |
| P (thin, idle, unobservable) | row 1 continues; rows 2 and 3 refused | refused | min(C, G) |
| G | every row refused | refused | refused |
| ETH/USD | as P invalid | refused | min(C, G) |

Measured maximum ages over 45 days:

- C: 86,425 s.
- G: 86,413 s; the longest in 400 days was 86,496 s.
- ETH/USD: 3,733 s. It was older than 3,600 s in 0.42% of samples, so a 3,600 s quote limit would invalidate P that often.
- Pool observation: 67,261 s.

### 14.3 P availability and the floor

The pool's tick and in-range liquidity were rebuilt from every Swap, Mint and Burn over the 45 days (3,282 swaps, 20 mints, 16 burns). The reconstruction matches archive `liquidity()` reads exactly:

| Date | In-range liquidity | PAXG in the pool |
|---|---|---|
| 17 September | 5.84e18 | 4.3 |
| 1 October | 2.56e18 | 4.2 |
| 8 October | 3.14e19 | 3.6 |
| 15 October | 3.2e19 | 3.5 |
| 22 October | 1.28e22 | 223.5 |
| 28 October | 9.33e21 | 184.5 |

P was evaluated on a 5 minute grid exactly as the adapter computes it.

| Floor (liquidity) | Share of today's L | P invalid, 45 days | P invalid, since 17 October | Survives the largest LP leaving |
|---|---|---|---|---|
| 1e20 | 1% | 72.7% | 0% | yes |
| 1e21 | 11% | 72.7% | 0% | yes |
| 3e21 (recommended) | 32% | 72.7% | 0% | yes (4.1e21 left) |
| 5e21 | 54% | 80.9% | 26.8% | no |

A floor low enough to accept the September state (below about 2.5e18) buys availability with no security. At 0.3% of today's depth, a 0.5% push for 20 minutes would have cost about $200, and path (c)'s D* would fall to about $0.07M.

**Recommended floor: 3e21.** It is 57% of the lowest 30 minute harmonic mean since 17 October (5.25e21), keeps P valid through today's normal variation and puts path (c) at $6.6M.

**What P availability means for the rules:** with P required, PAXG borrowing would have been closed for 33 of the last 45 days.

### 14.4 Rapid crashes and lag

Booked bad debt, with liquidator overpayment after the slash, both as a share of D.

**Model:**

- Liquidators act whenever a vault is liquidatable at the oracle price.
- Chainlink reports one minute after a deviation trigger (**assumption**): C triggers at 0.5% and G at 0.3%.
- P is the median of six 5 minute sub-window means of the true path.
- Rule set (ii) is max(C, P) when C and P agree within 2% and sit inside a 10% gold band.
- Rule set (iii) is C inside a 5% band, and off the band only after 60 minutes of continuous breach.
- "Gold frozen" covers a weekend, or a PAXG-specific crash with gold steady.

| Path | (i) these rules | (ii) higher-of-two, agree or stop | (iii) 60 minute off-band delay |
|---|---|---|---|
| Worst gold hour, 6.66% from 14:37 UTC 29 January 2026 | 0 | 0 | 0 |
| Worst gold day, 11.87% from 18:42 UTC 29 January 2026 | 0 | 0 | 0 |
| 10% in one hour | 0 | 0 | 0 |
| 30% over 24 hours | 0 | 0 | 0 |
| 30% in one hour | **0** | **16.05% / 0.63%** | 0 |
| Gold frozen: worst gold hour path | 0 / 0.02% | 0 | 0 |
| Gold frozen: 30% over 24 hours | 0 | 5.26% | 0 |
| Gold frozen: 30% in one hour | **13.71% / 1.01%** | 17.68% | 11.76% |

Falls under about 15% book nothing under any rule set, because vaults at 110% to 130% are liquidated before they go under water. Rule set (i) matches (iii) except in a fast PAXG-specific crash. There the lagging P keeps C and P more than 3% apart until about 30 minutes after the fall ends.

### 14.5 Manipulation per path

| Path | Cheapest attack | Cost | D* (uniform) | D* (edge profile) | Notes |
|---|---|---|---|---|---|
| (a) C pushed inside the 2% band | exchange aggregate down 2.7% (the band plus C's measured 0.71% maximum premium over gold), held 10 minutes (**assumption**) | $1.0M | **$37.3M** | $1.65M (0.5% push) | $11.2M with a 3 minute hold, $7.5M with 2 minutes, $3.7M with 1 minute |
| (b) C beyond the band, P within a | max(C, P) means both must fall: exchange held 10 minutes plus the pool held 20 minutes, 20% push | $50.3M | $67.4M | $13.5M | $25.9M with the pool at the floor. Validator runs of two or three blocks empty the pool and trip the floor, so they only disable P |
| (c) C stale (cannot be forced), P pushed inside the band | pool down 0.5% for 20 minutes | $60k | **$20.6M** | $0.57M | **$6.6M with the pool at the 3e21 floor** (costs scaled with liquidity, **assumption**). Conditional on a Chainlink outage, none seen in 61 days |
| (d) Disable P, then (a) | row 1 does not read P | as (a) | as (a) | as (a) | disabling P adds nothing to a false liquidation |

Given max(C, P), the agreement test in row 2 adds no protection against a false liquidation. It only refuses a P that is far from C, such as a broken or lagging pool.

Over-borrowing is closed by min(C, G) and the band. The most a pushed C can gain is the token's real discount to gold, at most g, and the 130% minimum absorbs that.

### 14.6 g, a and the backstop

- **g = 2%.** Over 45 days at 5 minutes, |C / G − 1| had a 99.9th percentile of 0.63% and a maximum of 0.71% (0.84% over 60 days at 30 minutes, section 6). G stepped by up to 1.67% at Sunday reopens in the 400 day history, and 2% keeps that case on row 1. D*(a) barely depends on g, because the binding push is small.
- **a = 3%.** |P / C − 1| had a 99.9th percentile of 1.86% and a maximum of 2.85% (2.23% since 17 October). At 3% no sample disagreed; at 2%, 0.07% did. Because of max(C, P), a wider a would cost little security.
- **Backstop ceiling: $5M.** (Superseded by 14.7 and then 14.8: the launch has no ceiling.)
  - The lowest D* across paths, with the pool at the floor the rules accept, is $6.6M (path c). That path uses only measured pool data, but its liquidity scaling and its block-by-block arbitrage are assumptions, so a margin of 1.3 gives $5M.
  - The assumption-heavy path (a) stays above $5M for any Chainlink hold of 2 minutes or more ($7.5M).
  - The effective factor against the attacker's cost is about 4 at the floor and about 12 at today's depth ($20.6M x 3 / $5M).
  - It sits below the liquidation capacity of about $9M (section 8).
  - If debt bunches at 110% (the edge profile), paths (a) and (c) can still take borrowers' penalties from $0.57M to $1.65M of debt. That is front-running of vaults about to be liquidated anyway, and it books no bad debt.
  - **Revisit when** the floor state changes (a new deep pool, or the pool's depth persisting for 90 days), or when an exchange depth snapshot halves.

### 14.7 Final rules (29 October 2026)

**Superseded design.** This section models a design the project replaced on 29 October 2026 with the two-source clamp of section 15. Its figures stand as a record; they do not describe the launch design.

**Rules assessed**: those [`GoldOracle.sol`](../contracts/src/core/GoldOracle.sol) implements (`_liquidation`, `_borrow`, `observeBand`, `_breachPersisted`), as [`ORACLE_IMPLEMENTATION_PLAN.md`](ORACLE_IMPLEMENTATION_PLAN.md) section 3 states them.

- **Liquidation.** Row 1: C within g of G, at C. Row 2: C off the band and a valid P within a of C, at max(C, P). Row 3: C stale or invalid and a valid P within g of G, at **max(P, G)** (was P). **Rule 4** (new): C off the band, P invalid or disagreeing and a breach recorded by the permissionless `observeBand(token)` at least 60 minutes earlier, at C. With G stale: max(C, P) when C and P agree within a. Otherwise refused. Any in-band read clears the record.
- **Borrowing.** C and G valid with C in the band, at min(C, G), lowered by a valid P only when P is below C, and refused only when P is more than a below C. A P above C is ignored.
- There is no step deviation gate. Every distance is measured against the larger price.

**Method**: the model of 14.1 to 14.6, unchanged. Uniform debt profile from 110% to 130%; D* = cost / (3 x profit share); Chainlink reports a push held for H = 10 minutes (**assumption**, section 5.1); exchange books refill once a minute (**assumption**, section 5.2); pool costs at the floor are scaled by liquidity (**assumption**). Script `sec14_final.py`, a copy of `sec14.py`, which is left unchanged so that 14.1 to 14.6 stay reproducible; output `sec14_final_out.txt`. The script reproduces the figures of 14.2, 14.4 and 14.5 for the rules they share. Where this section differs from 14.1 to 14.6, including items 4 and 7 of 14.1, this section applies.

**Conclusions**

1. **The lowest D* is now $2.8M, or $2.7M with the pool at the floor. That is below the $6.6M basis and below the $5M backstop.**
   - The path is (b2). The attacker pushes PAXG down 50% across the exchanges for the 10 minutes Chainlink needs. A block builder makes P agree, using four one-block spikes carried by just-in-time liquidity (F1, below). Row 2 then prices at C with no persistence at all.
   - The attack costs about $5.0M and breaks even at $8.3M of debt. At $5M its cost is 1.7 times what it takes, not the 3.9 (3 x 1.3) the backstop was set to keep.
2. **Rule 4 adds a second path near the backstop.** An attacker holds C just off the band for the hour and deepens the push only for its last 10 minutes: D* $5.05M, or about $4.5M if it uses Chainlink's 0.5% deviation threshold or starts while PAXG trades 0.5% under gold. One push held for all 70 minutes gives $18.7M. With no step gate, nothing prevents the late deepening.
3. **Row 3 at max(P, G) does what was intended.**
   - A pushed-down P gains at most C's premium over gold. Over 45 days that premium was zero or negative 52% of the time and never above 0.71%.
   - F1 against row 3 is worth no more than an ordinary pool push.
   - Where the premium reaches 0.5% (1.3% of the time), D* is unchanged at $20.6M, or $6.6M at the floor, but the most an attacker can take is 0.15% of D.
4. **Rule 4 does not reduce the fast PAXG-specific crash figure.**
   - A 30% fall in one hour with gold steady books 15.64% of D with no overpayment. Under the rules of 14.4 it booked 13.71%, plus 1.01% of liquidator overpayment.
   - Rule 4 fires at minute 66, after the fall has ended. It prices at the market. The old figure relied on liquidators paying the lagging pool price at a loss.
   - Every other replay books nothing.
5. **$5M is not supported by this model under the final rules.** (Superseded by 14.8: the launch has no ceiling, and a liquidation floor closes path (b2).)
   - On the rule of 14.6 (lowest D* divided by 1.3), the backstop would be about $2.1M.
   - If a forged P could not confirm row 2, rule 4's late deepening would bind at $4.45M to $5.05M, about $3.4M to $3.9M after the margin.
   - The $6.6M basis returns only if neither path exists. P must not be settable with a few blocks, and rule 4 must not price below the level an attacker held through the hour. Any such change needs the model re-run.

**D\* per path** (H = 10 minutes; profit share k from section 4)

| Path | Cheapest attack under the final rules | Cost | D* (uniform), today's pool | D* (uniform), pool at the 3e21 floor | D* (edge profile), today / floor | Against 14.5 |
|---|---|---|---|---|---|---|
| (a) C pushed inside the band (row 1) | exchange aggregate down 2.7%, held 10 minutes | $1.0M | $37.3M | $37.3M | $1.65M / $1.65M | unchanged |
| (b1) C beyond the band, P moved by trading (row 2) | exchange down 20% for 10 minutes, pool held 20% down for 20 minutes | $50.3M | $67.4M | $25.9M | $13.5M / $8.5M | unchanged |
| **(b2) C beyond the band, P set by F1 spikes (row 2)** | exchange down 50% for 10 minutes; a builder spikes four of the six sub-windows | $5.0M ($4.8M exchange, $161k spikes) | **$2.8M** | **$2.7M** | $3.0M / $2.95M | new |
| (c) C stale, P pushed (row 3 at max(P, G)) | pool down by C's premium over gold for 20 minutes; nothing to gain when the premium is zero or negative | $60k at a 0.5% premium | $20.6M | $6.6M | $0.57M / $0.18M | same, but only while the premium is at least 0.5% (1.3% of samples); gain capped at 0.15% of D |
| (d) Disable P, then (a) | row 1 does not read P | as (a) | as (a) | as (a) | as (a) | unchanged |
| (e1) Rule 4, one push held for 60 minutes plus H | exchange down 50% for 70 minutes | $33.8M | $18.7M | $18.7M | $20.4M / $20.4M | new |
| **(e2) Rule 4, hold just off the band, deepen late** | exchange down 2.1% for 60 minutes, then 50% for the last 10 | $9.1M | **$5.05M** | $5.05M | $5.5M / $5.5M | new; $4.55M with the deviation slack, $4.45M starting with PAXG 0.5% under gold |

**How the exchange cost scales.** Under the refill assumption the cost is the one-shot loss of section 5.2 paid once a minute, so it is linear in the time held. Across the readable PAXG books the loss per minute is:

| Push d | 0.5% | 2% | 3% | 5% | 10% | 20% | 30% | 50% |
|---|---|---|---|---|---|---|---|---|
| Loss per minute | $17k | $67k | $114k | $170k | $297k | $460k | $472k | $483k |

That is about $34k per point up to 5%, then nearly flat, because the readable books run out. The Kraken, OKX and KuCoin snapshots ended before 20%, so the deep figures are lower bounds. Whether exchanges let a sell print 30% to 50% below the market is **unverified** (section 5.2). The flat deep cost is what makes a 50% push the cheapest per dollar of profit on paths (b2) and (e). At 20% the D* of (b2) is $6.4M; at 30% it is $4.4M. The model counts losses, not inventory. Holding a 50% push for 10 minutes means selling at least the readable bids within 10% ($12.3M of PAXG) every minute, so over $120M of PAXG across the push. Whether an attacker can source that is **unverified**; sections 5 and 14 leave it out in the same way.

**Path (e): rule 4.** `observeBand` records the breach once Chainlink first reports C off the band, which takes H. While the hour runs, only C's side of the band matters, not its depth.

- **Late deepening (e2).** An attacker holds the cheapest push that keeps C off the band: 2.1% with C level with gold (the median premium is 0.00%), 1.6% with PAXG 0.5% under gold. At minute 60 it deepens the push, so that Chainlink reports the deep price as the hour completes. Cost: 60 minutes of the 2.1% loss plus H minutes of the deep loss, $4.3M plus $4.8M.
- **Deviation slack.** Chainlink writes a new round only on a 0.5% move. After the first report the aggregate can therefore sit 0.5% shallower without C changing (**assumption** on how the providers aggregate). That gives $8.2M and a D* of $4.55M.
- **The honest P.** At the end the push must exceed a (3%) so that the honest P disagrees. A shallower final push needs P disabled for that window ($4.9k for a builder); otherwise row 2 prices at max(C, P), the market price.
- **One sustained push (e1).** Holding the push for all 70 minutes gives D* $84.8M at 10%, $43.1M at 20% and $18.7M at 50%, where it costs $33.8M.
- **The stall of item 4 of 14.1.** In a genuine PAXG-specific depeg, disabling P now stops liquidation for no longer than the hour rule 4 needs, provided a keeper records the breach.

**F1: one-block spikes**

- **The mechanism.** A builder holding the end of block n and the start of block n+1 moves the pool tick by s ticks for 12 seconds. It adds liquidity at the spiked tick for that block, then removes it and swaps back at the start of n+1.
- **The size of the move.** The sub-window's mean moves by s x 12 / 300; a spike of 4,875 ticks gives 195 ticks, 1.93%. Four spiked sub-windows of six move the median by the same amount. The move is linear in s and the adapter does not bound it, so 1.93% is one example, not a limit.
- **The floor.** The just-in-time liquidity keeps the harmonic mean at the floor. Four spikes need 1.16e20 of it at the spiked tick today and 3e21 with the pool at the floor, with at most $26k of capital placed at the edge of a one-spacing range.
- **The cost.** The builder pays the pool fee both ways. Anyone else loses the spike to the next block's arbitrageur.

| Median move | Spike, ticks for 12 s | Capital for one block | Builder fee per spike | Four spikes, builder | Loss per spike, others |
|---|---|---|---|---|---|
| 0.5% down | 1,253 | $3.2M | $19k | $76k | $204k |
| 0.71% down | 1,781 | $4.6M | $28k | $110k | $406k |
| 1.93% down | 4,872 | $6.4M | $39k | $154k | $771k |
| 3% to 20% down | 7,615 to 55,789 | $6.4M | $39k | $154k | $771k |
| 50% down | 173,295 | $6.7M | $40k | $161k | $1.1M |
| 2.1% up | 5,196 | $0.8M | $5k | $20k | $40k |

**Beyond the ticks read.** Past 1.93% a spike crosses all the liquidity read on 28 October (ticks −1,560 to 13,920), so the cost stops growing. Beyond that span only a residual 1.65e16 of liquidity was seen, consistent with a full-range position. Positions lying wholly outside the span were not read (**unverified**).

- Hidden liquidity there would add 0.6% of its value per spike to a builder's cost. It would take about $170M of it to lift (b2) to $5M, so the conclusion does not depend on it. Confirming the capital figure needs a read of the pool's tick bitmap beyond the span.
- If spikes had to stay inside the span, a 20% move would need eight spike blocks in each of four sub-windows, and (b2) would be $7.8M. A 30% move would need 13 spike blocks per sub-window, and (b2) would be $6.1M.

**What F1 buys under the final rules:**

- **Row 2.** A forged P agrees with any C the attacker pushes off the band, so row 2 prices at C with no persistence. This is path (b2), the binding path. The bad-debt pause does not stop it, because the emergency path prices by the same rules.
- **Row 3.** Nothing beyond an ordinary push. max(P, G) caps the gain at C's premium over gold, and at that size four spikes cost about what holding the pool for 20 minutes costs ($76k against $60k at 0.5%). An upward push during an outage only stalls liquidation, because above G / (1 − g) row 3 refuses. Disabling P stalls it more cheaply ($4.9k per 30 minutes for a builder).
- **Borrowing.** No over-borrowing, because P can only lower the price. Refusing borrowing needs P more than 3% below C: $154k per 30 minute window for a builder, about $460k an hour to sustain (twelve spikes). An invalid P no longer stops borrowing.
- **Gold stale** (cannot be forced). That row accepts any C and P that agree, so the same route works with C pushed any distance; cost and D* are those of (b2).
- **Rule 4.** A forged P can make P disagree, which disabling P already does more cheaply.

**Path (c) under max(P, G).** The old rule 3 let P be pushed anywhere inside the band, up to 2.7% below the market at C's highest premium. The new rule stops at gold.

| C's premium over G | Share of 5 minute samples (45 days) | Profit share k | D*, today | D*, pool at the floor | D* (edge profile), floor |
|---|---|---|---|---|---|
| 0 or below | 51.8% | 0 | no gain | no gain | no gain |
| 0.3% or more | 9.1% | 0.058% at 0.3% | $14.9M | $4.8M | $84k |
| 0.5% or more | 1.3% | 0.097% at 0.5% | $20.6M | $6.6M | $0.18M |
| 0.63% or more (99.9th percentile) | 0.1% | 0.128% at 0.63% | $24.4M | $7.9M | $0.28M |
| 0.71% (the maximum) | under 0.1% | 0.149% | $25.5M | $8.2M | $0.33M |

- **Small pushes.** Pushes smaller than 0.5% give lower D* readings with the pool at the floor: $4.8M at 0.3% and $3.6M at 0.1%. The same was true of the old rule 3; the grid of 14.5 began at 0.5%. These pushes are smaller than P's ordinary distance from C (99.9th percentile 1.86%) and sit inside the pool's 0.3% fee, where arbitrage may not reverse them. They only bring forward the liquidation of vaults within 0.1% to 0.3% of the threshold, which an ordinary hour liquidates anyway. At $5M of debt they are worth $0.8k to $2.9k. Section 4 sets the same front-running aside for the edge profile, and so does this section.
- **Conditional on an outage.** All of path (c) needs a Chainlink PAXG/USD outage. No on-chain action can force one, and none occurred in 61 days.

**Sensitivity to the Chainlink hold H** (uniform profile, today's pool)

| H | (a) | (b2) | (e1) | (e2) |
|---|---|---|---|---|
| 10 minutes (base) | $37.3M | $2.8M | $18.7M | $5.05M |
| 3 minutes | $11.2M | $0.89M | $16.8M | $3.2M |
| 2 minutes | $7.5M | $0.62M | $16.6M | $2.9M |
| 1 minute | $3.7M | $0.36M | $16.3M | $2.6M |

With a 3 minute hold, (b2) would profit at $5M of debt: it would cost $1.6M and take $3.0M.

**Crash replays** (model of 14.4; a keeper calls `observeBand` within one minute of C leaving the band). Each cell is booked bad debt / liquidator overpayment, as a share of D; 0 means both are nil.

| Path | (i) rules of 14.4 | Final rules | Final rules, P invalid throughout | (iii) 60 minute delay, 5% band |
|---|---|---|---|---|
| Worst gold hour, 6.66% from 14:37 UTC 29 January 2026 | 0 | 0 | 0 | 0 |
| Worst gold day, 11.87% from 18:42 UTC 29 January 2026 | 0 | 0 | 0 | 0 |
| 10% in one hour | 0 | 0 | 0 | 0 |
| 30% over 24 hours | 0 | 0 | 0 | 0 |
| 30% in one hour | 0 | 0 | 0 | 0 |
| Gold frozen: worst gold hour path | 0 / 0.02% | 0 / 0.02% | 0 | 0 |
| Gold frozen: worst gold day path | 0 | 0 | 0 | 0 |
| Gold frozen: 10% in one hour | 0 | 0 | 0 | 0 |
| Gold frozen: 30% over 24 hours | 0 | 0 | 0 | 0 |
| Gold frozen: 30% in one hour | 13.71% / 1.01% | **15.64% / 0** | 15.64% / 0 | 11.76% / 0 |

**What happens in the fast PAXG-specific crash.** Rule 4 changes nothing on the gold-wide paths, which row 1 prices. In the 30% fall in one hour with gold steady, row 1 liquidates 8.5% of vaults in the first four minutes, before C leaves the 2% band. The rest wait.

- **Under the rules of 14.4**, the rest were liquidated at minute 71 at the lagging pool price, 0.718 against a market of 0.700. That booked 13.71% and made liquidators overpay 1.01%. Real liquidators do not act at a loss, so that figure was low.
- **Under the final rules**, rule 4 liquidates them at minute 66 at C, the market price. That books 15.64% with no overpayment. The total loss is 0.9 points higher, because the protocol now pays the 2% underwater discount.
- **Why rule 4 cannot help.** The fall is over before the hour runs out, so the persistence period sets the outcome, not the pool. P's validity makes no difference. The 5% band of (iii) books less because more vaults are liquidated before C leaves that band.
- So rule 4 does not improve on 13.71%; it replaces it with an honest 15.64%.

**C stale through a gold-wide move** (a Chainlink PAXG/USD outage):

| Path | Row 3 of 14.4 (P) | Final row 3 (max(P, G)) | P disabled for the whole path |
|---|---|---|---|
| Worst gold hour | 0 | 0 | 0 |
| Worst gold day | 0 | 0 | 0 (0.60% if the stall ended at the day's low) |
| 10% in one hour | 0 / 0.06% | 0 / 0.06% | 0.06% / 0 |
| 30% over 24 hours | 0 | 0 | 17.68% / 0 |
| 30% in one hour | 16.05% / 0.63% | 16.05% / 0.63% | 17.68% / 0 |

- In a falling market P lags above G, so max(P, G) is P and the change does nothing to a crash. In a fast fall P leaves the band of G, and row 3 waits for it, as before.
- A stall during an outage costs a builder $4.9k per 30 minutes. It books bad debt only if PAXG falls more than 9.1% while it lasts.

**The backstop**

- **The new lowest D*** is $2.8M with today's pool and $2.7M at the floor, path (b2). It is lower than $6.6M and lower than $5M.
- **Its inputs:**
  - H = 10 minutes (**assumption**, as for path (a));
  - books refilling once a minute (**assumption**);
  - deep book losses that are lower bounds;
  - exchanges printing 50% below the market, and an attacker able to sell over $120M of PAXG into them (**unverified**);
  - a builder holding four pairs of consecutive blocks within 20 minutes (Titan holds about 23% of pairs, from the builder shares in 14.2), with about $6.4M of PAXG for one block at a time (measured pool state; liquidity beyond the span read is **unverified**).
  - The F1 mechanics were reproduced in a Foundry test.
- **The margin.** (b2) breaks even at $8.3M of debt. At $5M its cost is 1.7 times what it takes, against the 3.9 (3 x 1.3) the backstop was meant to keep. With a 3 minute Chainlink hold it would profit at $5M.
- **Without the forged P.** If row 2 could not be confirmed by a forged P, rule 4's late deepening would still give $4.45M to $5.05M: a factor of 2.7 to 3.0 at $5M and no margin.
- **$5M is not justified by this model under the final rules.** The rule of 14.6 gives about $2.1M. The direction set is a conservative backstop with no routine increases. Nothing here supports raising it, and the evidence points the other way: either the backstop is lowered, or row 2 and rule 4 change and the model is re-run before launch.
- **Superseded by 14.8.** The owner has since chosen to launch with no debt ceiling and no per-block mint cap, and the oracle gained a liquidation floor. Section 14.8 assesses that design; the backstop conclusions above no longer apply to it.

### 14.8 No ceiling, with a liquidation floor (29 October 2026)

**Superseded design.** This section models a design the project replaced on 29 October 2026 with the two-source clamp of section 15. Its figures stand as a record; they do not describe the launch design.

**Design assessed**: mainnet launches with **no debt ceiling and no per-block mint cap**, so D is unbounded. The oracle ([`GoldOracle.sol`](../contracts/src/core/GoldOracle.sol): `_liquidation`, `_floor`, `_persistence`, `observeBand`; [`ORACLE_IMPLEMENTATION_PLAN.md`](ORACLE_IMPLEMENTATION_PLAN.md) section 3) keeps the rules of 14.7 and adds a floor below the band.

- **E** is the band's lower edge, G x (1 − g).
- **Before persistence.** Below the band, until a breach on the same side has persisted for 60 minutes, row 2 prices at max(C, P, E). `observeBand` now records the side and restarts the record when C crosses to the other side.
- **After persistence.** The floor descends: F = G x (1 − g − r x hours since persistence), with r = 10% of G per hour by default (1% to 25% through the timelock). Row 2 prices at max(C, P, F) and rule 4 at max(C, F). F reaches zero after about 9.8 hours at the default.
- **G stale.** max(C, P, F<sub>G</sub>), where F<sub>G</sub> is the same descent on gold's last sound answer, timed from when that answer went stale.
- **Unchanged.** Rule 3 stays max(P, G). Above the band there is no floor.

**Method**: the model of 14.7 with the floor added. Script `sec14_floor.py`, which loads `sec14_final.py` unchanged; output `sec14_floor_out.txt`. Profit per dollar of debt is k(d) of section 4, and bad debt is the part of a false underwater liquidation the SurplusBuffer pays. Crash replays now offer a second liquidator model as well. **Rational** liquidators act only when the collateral they receive is worth, at the market, what they repay. The **act whenever** model of 14.4 takes every liquidatable vault, so the floor's overpayment falls on liquidators or, through `liquidateViaPool` (priced by the same rules), on the stability pool's depositors. Paths are extended by 12 hours at their final price so the floor can finish descending.

**Conclusions**

1. **The floor closes the quick paths of 14.7.** Below the band, before persistence, no rule prices under E. A forged P (path b2) and late deepening (e2) therefore gain no more than path (a): at most 2.7% below the market, 0.89% of D, with no bad debt. Path (b2)'s $2.8M D* no longer exists.
2. **Profit still grows without bound in D, and through bad debt, on one forcible path: walking the floor down.** (Superseded by 14.9: the depth bound closes the walk.)
   - An attacker holds C just off the band (2.1% down) for the hour and then for t more hours while F descends, and finally pushes C to F for the 10 minutes Chainlink needs. The false price is g + r x t below the market.
   - At r = 10%, false underwater liquidations, and so bad debt, start after 0.71 hours of descent (1.71 hours held).
   - Holding for 10.8 hours takes the floor to 2% of G and the attacker takes 117% of D, of which 98% is bad debt. It costs $51.2M under the refill assumption and breaks even at $43.9M of debt (lowest D* $14.6M).
   - With no ceiling, any debt above about $44M is exposed to it. The deviation slack of 14.7 lowers both figures by about a quarter.
3. **A gold outage is a second, unforcible path.** While G is stale, F<sub>G</sub> descends without anyone holding C off the band. A 3 hour outage at r = 10% lets a 10 minute exchange push with a forged P book 20% of D as bad debt, at D* $4.2M. G has not gone stale in 400 days (longest gap 86,496 s against 90,000 s), but nothing bounds the damage in D if it does. (Superseded by 14.9: an outage alone no longer lowers the floor.)
4. **Inside the band, profit also grows with D, but only from borrowers' penalties.** Path (a) takes 0.89% of D (5.86% on the edge profile), books no bad debt and breaks even at $112M of debt with a 10 minute Chainlink hold ($34M with 3 minutes).
5. **The descent rate trades attack cost against crash bad debt.** (Superseded by 14.9 for the crash figures, which assumed the descent alone.) A PAXG-specific fall faster than r per hour is liquidated only at the floor's pace, and the protocol books the gap.
   - A 30% fall over three hours books nothing without the floor, 14.1% of D at r = 5% or 10% and 12.4% at 20%.
   - A 30% fall over six hours books 14.1% at 5%, 0.6% at 10% and nothing at 20%.
   - A 50% fall over six hours books 35.5% at 5% or 10% and 12.7% at 20%.
   - Raising r to 20% cuts the attack's break-even from $43.9M to $25.8M; lowering it to 5% raises it to $79.9M.
6. **Verdict** (superseded by 14.9). The no-ceiling launch has a path whose profit grows without bound in D, through bad debt: a sustained push of PAXG 2% below gold on every exchange for about 2 to 11 hours, depending on how much it wants to take. The floor turns the 10 minute attack of 14.7 into a visible attack of many hours, and only the guardian's per-token freeze stops it once it starts; the model gives that freeze no credit. **Recommended r: 10%.** It follows any PAXG-specific fall of 5% an hour or slower with under 1% of D in bad debt, and it keeps the floor walk's break-even above $40M. A slower rate books 14% in a six hour 30% fall. A faster one books less in falls of 5% to 20% an hour, which have no precedent (the largest gap between PAXG and gold in 60 days was 0.84%), at the price of a forcible attack about 40% cheaper. That is the project's trade; this model leans to the attack that can be forced.

**Maximum profit per path, D unbounded** (profit share k(d) of section 4, uniform profile; edge profile in brackets)

| Path | Largest distortion below the market | Profit, share of D | Bad debt, share of D | Paid by |
|---|---|---|---|---|
| (a) C pushed inside the band | 2.7% | 0.89% (5.86%) | 0 | borrowers' penalties |
| (b1), (b2), (e2) before persistence | held at E: 2.7% at C's highest premium | 0.89% (5.86%) | 0 | borrowers' penalties |
| (c) C stale, max(P, G) | C's premium over gold, at most 0.71% | 0.15% (3.73%) | 0 | borrowers' penalties |
| (d) Disable P, then (a) | as (a) | as (a) | 0 | borrowers' penalties |
| (b2), (e1), (e2) after persistence: the floor walk | g + r x t; 98% after 9.8 hours at r = 10% | up to 117% | up to 98% | the SurplusBuffer, then GSUSD holders |
| G stale for s hours (cannot be forced) | g + r x s | up to 117% | up to 98% | the SurplusBuffer, then GSUSD holders |

**Walking the floor at r = 10%** (C held 2.1% below gold; cost = minutes held x the 2.1% loss, $4.3M an hour, plus 10 minutes of the final push; C level with gold)

| Hours after persistence t | Hours held | False price below market | Cost | Profit, share of D | Bad debt, share of D | Break-even D | D* |
|---|---|---|---|---|---|---|---|
| 0 | 1.0 | 2% | $5.0M | 0.57% | 0 | $865M | $288M |
| 0.5 | 1.5 | 7% | $8.6M | 4.34% | 0 | $199M | $66.5M |
| 1 | 2.0 | 12% | $11.9M | 11.77% | 0.54% | $101M | $33.6M |
| 2 | 3.0 | 22% | $17.5M | 27.19% | 8.03% | $64.4M | $21.5M |
| 3 | 4.0 | 32% | $21.9M | 39.07% | 20.03% | $56.1M | $18.7M |
| 4 | 5.0 | 42% | $26.2M | 50.83% | 31.79% | $51.6M | $17.2M |
| 6 | 7.0 | 62% | $34.9M | 74.35% | 55.31% | $46.9M | $15.6M |
| 9.8 | 10.8 | 98% | $51.2M | 116.69% | 97.65% | $43.9M | $14.6M |

The attacker's profit is linear in D at every hold time; the cost is linear in the time held. The longer the hold, the larger the share of the profit that is bad debt rather than borrowers' penalties.

| r | Bad debt starts after | Hours held to take everything | Cost | Break-even D | Lowest D* | With the deviation slack: break-even, D* |
|---|---|---|---|---|---|---|
| 5% | 1.42 hours of descent | 20.6 | $93.2M | $79.9M | $26.6M | $60.8M, $20.3M |
| 10% | 0.71 hours | 10.8 | $51.2M | $43.9M | $14.6M | $33.9M, $11.3M |
| 20% | 0.35 hours | 5.9 | $30.2M | $25.8M | $8.6M | $20.5M, $6.8M |

**Assumptions and limits of the walk:**

- The refill assumption is stretched over hours. Holding 2.1% means selling at least the bids within 0.5% ($4.0M of PAXG) into refilled books every minute, over $240M of PAXG an hour; whether an attacker can source that, or whether books refill at all for hours, is **unverified**.
- Deep pushes beyond 50% use the 50% loss, a lower bound.
- C is assumed level with gold. A PAXG premium shortens the walk slightly; a discount lengthens it.
- The guardian's freeze, a public alert from the keeper's heartbeat and arbitrage against Paxos redemption are all left out. Each works against the attacker over hours, not minutes.

**G stale for s hours** (C pushed to F<sub>G</sub> for 10 minutes, P forged by four builder spikes):

| r | 1 hour | 2 hours | 3 hours | 6 hours |
|---|---|---|---|---|
| 5% | D* $18.2M, bad debt 0 | $9.8M, 0.5% | $6.6M, 3.2% | $4.2M, 20.0% |
| 10% | $9.8M, 0.5% | $5.9M, 8.0% | $4.2M, 20.0% | $2.2M, 55.3% |
| 20% | $5.9M, 8.0% | $3.2M, 31.8% | $2.2M, 55.3% | $1.4M, 97.6% |

A long gold outage is the one case in which a quick attack still books bad debt that grows with D. The guardian's pause is the only stop.

**Crash replays with the floor** (keeper records the breach within one minute; gold frozen, so the fall is specific to PAXG or falls on a weekend; booked bad debt as a share of D, with rational liquidators; in brackets, the time of the last liquidation)

| Gold-frozen path | 14.7, no floor | r = 5% | r = 10% | r = 20% |
|---|---|---|---|---|
| 30% in one hour | 15.64% (1.1 h) | 14.74% (6.5 h) | 14.74% (3.8 h) | 14.92% (2.5 h) |
| 50% in one hour | not run | 36.35% (10.6 h) | 36.44% (5.8 h) | 36.62% (3.5 h) |
| 30% over 3 hours | 0 | 14.13% (6.7 h) | 14.13% (4.0 h) | 12.37% (2.8 h) |
| 30% over 6 hours | 0 | 14.13% (6.9 h) | 0.60% (6.1 h) | 0 |
| 50% over 6 hours | 0 | 35.46% (10.8 h) | 35.55% (6.2 h) | 12.68% (4.8 h) |
| 30% over 12 hours | 0 | 0 | 0 | 0 |
| 30% over 24 hours | 0 | 0 | 0 | 0 |

- Every gold-wide path (worst gold hour and day, 10% and 30% in one hour, 30% over 24 hours) books nothing at any rate, as does every other gold-frozen path of 14.4, because row 1 or a slow fall is unaffected by the floor.
- **A fall that ends quickly** (30% or 50% in one hour) books about the same at every rate: every vault is under water before the floor can matter, so the floor only delays settlement, by up to 6.5 hours at r = 5%. Rational liquidators settle once F comes within the 2% discount of the market, which pays them almost nothing; a later settlement books up to the 15.64% of 14.7. P's validity makes no difference.
- **A fall still under way** is where r matters. The floor holds the price above the market for as long as the fall outpaces r, and the vaults go under water meanwhile.
- **Act whenever, r = 10%, 30% in one hour.** The buffer books nothing, but liquidators overpay 18.95% of D. Because `liquidateViaPool` prices at the floor, a caller can push that loss onto the stability pool's depositors while the floor sits above the market.

**Verdict** (superseded by 14.9). The no-ceiling launch is not bounded in D by the oracle alone. The floor removes every attack that takes minutes, but a sustained, visible push held for hours walks it down, and the profit, most of it bad debt, then grows in proportion to D: break-even at about $44M of debt at r = 10%. The bound in practice is how fast the guardian freezes the token, which this model does not credit. **Recommended r: 10%**, the default.

### 14.9 No ceiling, with the floor bounded by the depth held (29 October 2026)

**Superseded design.** This section models a design the project replaced on 29 October 2026 with the two-source clamp of section 15. Its figures stand as a record; they do not describe the launch design.

**Design assessed**: no debt ceiling and no per-block mint cap, as in 14.8, with the floor now bounded by the depth C has held ([`GoldOracle.sol`](../contracts/src/core/GoldOracle.sol): `_floor`, `_advance`, `observeBand`, `quoteDepth`; [`ORACLE_IMPLEMENTATION_PLAN.md`](ORACLE_IMPLEMENTATION_PLAN.md) section 3).

- **The two bounds.** F = max(F<sub>t</sub>, F<sub>d</sub>).
  - F<sub>t</sub> is the descent of 14.8: E until the breach has persisted for 60 minutes, then G x (1 − g − r x hours since persistence), with r = 10%.
  - F<sub>d</sub> = G x (1 − held). Held is the shallowest depth below G that every observation found, from one at least 60 minutes ago until now; F<sub>d</sub> is E while nothing deeper is held.
- **Observations.** `observeBand` must run at least every 15 minutes (`MAX_OBSERVATION_GAP`) or the record restarts. Pricing acts as though it had just run.
- **Lag.** A fixed depth is followed after 60 minutes; a steady fall after 60 to 90 minutes.
- **Price.** max(C, P if it agrees, F) below the band. With G stale, the same pair is computed on gold's last sound answer, counting only depth held against that answer since it went stale.

**Method**: the model of 14.8, with the depth record ported from `_advance` and a keeper observing every 5 minutes. Script `sec14_depth.py`, a copy of `sec14_floor.py`, which stays unchanged; output `sec14_depth_out.txt`. Rational liquidators act only when the collateral is worth, at the market, what they repay. The second figure in the last crash column takes every liquidatable vault, which is what a caller of `liquidateViaPool` does at the floor price, so that loss lands on the stability pool's depositors.

**Conclusions**

1. **The floor walk of 14.8 is closed.** Holding C 2.1% below gold for hours now holds only 2.1%, so the price stays at G x 0.979 however far F<sub>t</sub> descends. The attacker takes 0.61% of D, with no bad debt. Every path that holds nothing below the band edge is back to the in-band figure: 0.89% of D at most, paid from borrowers' penalties.
2. **Profit still grows without bound in D through bad debt on one forcible path, but now only at a high price.**
   - The attacker must hold C at the target depth d on every exchange for 60 minutes plus the 10 minutes Chainlink needs. Before that it holds 2.1% for 60 x (d − g) / r minutes, so that F<sub>t</sub> has descended to d.
   - The cheapest version that books any bad debt (d = 9.15%) costs $22.3M and breaks even at $321M of debt.
   - The lowest break-even is at d = 50%: six hours in all, $54.4M, break-even **$90.4M** of debt, with 41.2% of D booked to the buffer.
   - It falls to $84.7M with a 3 minute Chainlink hold and to $69.8M at r = 25%, the governed maximum.
   - A 70 minute deep hold means selling at least the readable bids within 10% ($12.3M of PAXG) every minute, over $860M in all (**unverified** that it can be sourced).
3. **A gold outage no longer lowers the floor by itself.** The attacker must still hold the depth for the hour against the stale answer. A 50% push during an outage of at least 4.8 hours breaks even at $56.4M (D* $18.8M). G has not gone stale in 400 days.
4. **The cost moves to steady PAXG-specific falls.** The 60 to 90 minute lag means a fall faster than about 2.5% an hour, with gold steady, is not followed. Rational liquidators wait while every vault goes under water:
   - 30% over 6 hours: 14.48% of D (0.39% under 14.8, nothing under 14.7);
   - 30% over 12 hours: 4.07%;
   - 30% over 16 hours or slower: nothing.
   Gold-wide falls book nothing at any speed.
5. **The stability pool changes who pays.** If callers liquidate through the pool at the floor, the buffer books nothing in every replay. Depositors or liquidators then carry 0.11% to 18.38% of D, mostly less than the rational case books, because vaults are taken before they go under water.
6. **Verdict.**
   - Under the model's assumptions (Chainlink hold, book refills, deep book losses as lower bounds, uniform debt profile), no manipulation that books bad debt pays below about $90M of debt.
   - On the safety factor of 3 used throughout, the figure to watch is D* $30.1M (G valid) or $18.8M during a gold outage.
   - Above that, profit grows in proportion to D, and only the guardian's freeze and the attacker's PAXG inventory bound it; the model credits neither.
   - Skimming borrowers' penalties inside the band pays from $112M of debt and books no bad debt.
   - The honest-market price of this protection is up to about 15% of D in bad debt in a PAXG-specific fall faster than 2.5% an hour, unless the stability pool is deep enough to absorb it.

**Attack table** (r = 10%, H = 10 minutes, uniform profile, C level with gold)

| Target depth d | Hours held in all (shallow) | Cost | Profit, share of D | Bad debt, share of D | Break-even D | D* | Buffer loss at break-even |
|---|---|---|---|---|---|---|---|
| 5% | 1.5 (0.3) | $13.2M | 2.44% | 0 | $540M | $180M | 0 |
| 9.15% | 1.9 (0.7) | $22.3M | 6.96% | under 0.01% | $321M | $107M | $1k |
| 10% | 2.0 (0.8) | $24.2M | 8.18% | 0.06% | $296M | $98.8M | $0.17M |
| 12% | 2.2 (1.0) | $27.4M | 11.77% | 0.54% | $232M | $77.5M | $1.2M |
| 20% | 3.0 (1.8) | $39.9M | 24.89% | 5.79% | $160M | $53.4M | $9.3M |
| 30% | 4.0 (2.8) | $45.1M | 36.72% | 17.68% | $123M | $40.9M | $21.7M |
| 50% | 6.0 (4.8) | $54.4M | 60.24% | 41.20% | **$90.4M** | $30.1M | $37.2M |

Cost = 60 x (d − g) / r minutes of the 2.1% loss ($71.5k a minute) plus 70 minutes of the loss at d (section 5.2; flat beyond 20% because the readable books run out, so a lower bound). Holding the deep level 0.5% shallower once Chainlink has reported (the deviation slack of 14.7) cuts each cost by 5% to 10%.

**Crash replays** (r = 10%, keeper every 5 minutes, rational liquidators; booked bad debt as a share of D, with the time of the last liquidation in brackets; last column: bad debt / loss carried by liquidators or pool depositors when callers act at the floor)

| Gold-frozen path | 14.7, no floor | 14.8, descent only | 14.9, depth bound | 14.9, callers act at the floor |
|---|---|---|---|---|
| 30% in 1 hour | 15.64% (1.1 h) | 14.74% (3.8 h) | 14.74% (3.8 h) | 0 / 18.38% |
| 30% over 3 hours | 0 | 14.13% (4.0 h) | 15.01% (4.2 h) | 0 / 8.27% |
| 30% over 6 hours | 0 | 0.39% (6.1 h) | 14.48% (6.9 h) | 0 / 2.53% |
| 30% over 8 hours | 0 | not run | 14.68% (9.1 h) | 0 / 1.33% |
| 30% over 12 hours | 0 | not run | 4.07% (12.8 h) | 0 / 0.11% |
| 30% over 24 hours | 0 | 0 | 0 | 0 / 0 |
| 50% over 6 hours | 0 | 35.55% (6.2 h) | 35.93% (7.3 h) | 0 / 6.31% |
| Worst gold hour and worst gold day paths | 0 | 0 | 0 | 0 / 0.03% at most |

- **Gold-wide paths.** Every gold-wide version (30% in 1, 3, 6 and 24 hours, 50% over 6 hours, worst gold hour and day) books nothing in every column: row 1 prices them at C and the floor never applies.
- **A slower keeper.** With a keeper every 15 minutes, the gold-frozen results move by under half a point (30% over 6 hours: 14.92%).
- **A missed window.** A gap over 15 minutes restarts the record and delays a genuine fall by another hour.

---

## 15. The two-source clamp design (project decision, 29 October 2026)

**Design assessed** (from the project's direction; the contracts are being changed separately and were not read for this section). C = Chainlink PAXG/USD, G = Chainlink XAU/USD. There is no pool source, no `observeBand`, no delay, no keeper duty and no debt ceiling.

**Superseded in part: what the contracts implement.** Two rules below were modelled and then not built. With both feeds healthy the contracts price a liquidation at min(max(C, G), G x (1 + m)): the lower bound is gold itself, as section 15.8 adopts, not G x (1 − m). With either feed stale or invalid they refuse the liquidation (`No reliable price`): there is no C stale fallback (dropped in section 15.8) and no clamp on gold's last answer when G is stale (dropped afterwards; [`ORACLE_IMPLEMENTATION_PLAN.md`](ORACLE_IMPLEMENTATION_PLAN.md) section 3 and [`SPECIFICATION.md`](SPECIFICATION.md) section 3.9). Every passage below that prices a seizure while G is stale (the liquidation rules that follow, section 15.5 "G stale", and the G outage point and risk row of section 15.8) describes the earlier design and is kept as the record. Its loss figures were not recomputed for a refusal; that re-run is item 1 of the plan's section 6.

- **Borrowing.** min(C, G), only with both feeds healthy and C within 2% of G.
- **Liquidation.**
  - Both healthy: clamp(C, G x (1 − m), G x (1 + m)).
  - C stale, G healthy: min(C<sub>last</sub>, C<sub>last</sub> x G<sub>now</sub> / G<sub>at C last</sub>), which tracks gold down only.
  - G stale, C healthy: the same clamp around G's last sound answer.
  - Both stale: refused.
- **Reserve swaps** (GSUSD for gold only). max(C, G), only with both healthy and C inside the 2% band; otherwise refused. Coverage never values gold above min(C, G).

The liquidation margin m is compared at 2%, 2.5% and 3%. The borrowing and reserve gate stays at 2% in every case.

**Method.** Vault rules from `GoldVault._sizeSeizure`:

- liquidation below 110% and a 5% penalty, 60% of it to a direct liquidator and 40% to the protocol;
- the pool path pays its caller 30% of the penalty in PAXG and the pool keeps the rest;
- a thin vault gives up all its gold;
- an underwater vault repays max(0.98 x value, 2 x value − debt), and the rest is bad debt for the SurplusBuffer.

Uniform book from 110% to 130% unless stated; the edge book has every vault at 110%. Exchange costs and k(d) are those of section 4 and 5.2. Script `sec15_clamp.py` (loads `sec14_final.py` unchanged); output `sec15_clamp_out.txt`.

**The 9.09% headroom is not a safety proof.** A vault at 110% goes under water only after a 9.09% fall, but this section does not rely on that alone. It models each way the clamp could still produce a loss: a premium larger than measured, a liquidation backlog, an edge-concentrated book, the executable value of seized gold, liquidation capacity, the pool absorbing at the clamp, stale feeds and an issuer freeze.

### 15.1 The three margins side by side

| | m = 2% | m = 2.5% | m = 3% |
|---|---|---|---|
| **Manipulation of C** (premium 0.71%, the 45 day maximum) | | | |
| Largest false discount to the market (at a 0.84% premium) | 2.69% (2.82%) | 3.19% (3.31%) | 3.68% (3.81%) |
| Share of a uniform book exposed to a false liquidation | 15.2% | 18.1% | 21.0% |
| Profit share k at that discount, uniform (edge) | 0.89% (5.85%) | 1.15% (6.39%) | 1.46% (6.94%) |
| Break-even D, uniform, 1 / 3 / 10 minute Chainlink hold | $11.2M / $33.5M / $111.5M | $10.4M / $31.1M / $103.7M | $9.1M / $27.4M / $91.3M |
| Break-even D, edge book, 1 / 3 / 10 minutes | $0.5M / $1.5M / $5.0M | same | same |
| Protocol bad debt at measured premiums | 0 | 0 | 0 |
| Premium at which seizures turn thin / bad debt appears | 2.67% / 7.80% | 2.14% / 7.25% | 1.62% / 6.70% |
| Backlog: a vault already under this true ratio books bad debt if pushed | 102.8% | 103.3% | 103.8% |
| **Genuine PAXG depegs** (pool 10% of D) | | | |
| External liquidation profitable at the clamp up to a depeg of | 4.47% | 4.96% | 5.45% |
| 20% depeg, gradual: GSUSD holders' under-backing | 3.25% | 2.98% | 2.69% |
| 30% depeg, sudden: pool depositors / GSUSD holders | 2.61% / 13.77% | 2.57% / 13.77% | 2.53% / 13.77% |
| 30% depeg, gradual: GSUSD holders | 13.50% | 12.92% | 12.29% |
| **Gold-wide crashes** (section 14.4 paths) | 0 | 0 | 0 |
| **G stale, gold rises 10%**: borrowers' loss to false liquidations | 5.46% | 4.92% | 4.44% |

All shares are of D. **Recommendation: m = 3%**, on these conditions. (Superseded by the project's decision in 15.8: a fixed 2% clamp, with no monitoring-triggered change.)

- **The premium stays below 1.6%.** The premium of PAXG over gold is monitored and stays below 1.6%, the level at which a pushed C turns seizures thin at m = 3% (the measured maximum is 0.84%). Above about 1%, governance moves m back to 2%.
- **The book is watched near the threshold.** No more than a small share of debt should sit within 4% of 110%. The edge-book figures are the same at every m and are the main borrower exposure.
- **Liquidations keep up.** Liquidations stay current (no backlog below 104%) and the stability pool is funded.
- **The gate stays at 2%.**

On solvency, 3% is slightly better than 2%. It keeps external liquidators active through a depeg of up to 5.45% rather than 4.47%, and it leaves 1.2 points less of D under-backed in a gradual 30% depeg. On manipulation it is slightly worse. It widens the false discount by one point and lowers the uniform break-even by about 18%, but it creates no protocol bad debt at any premium measured. The differences between the margins are small beside the uncertainty in the Chainlink hold (**assumption**). The measured evidence supports 3% only with the conditions above.

### 15.2 Manipulation

A push of C below G x (1 − m) prices at G x (1 − m), so the discount to the market is at most 1 − (1 − m) / (1 + premium).

- **When modelled protocol bad debt is zero.** All of these must hold:
  1. Every vault is at or above 110% at the market when the push starts (liquidations current).
  2. The premium of PAXG over gold is below 7.80%, 7.25% or 6.70% (m = 2%, 2.5%, 3%).
  3. The seizure is sized by `_sizeSeizure` as above.
  Under these, the ratio at the clamped price stays at 105.9% or more. Every false seizure is then sized at the full penalty, nothing is thin and nothing reaches `_handleBadDebt`. The borrower pays the 5% penalty plus the discount: up to 7.7%, 8.2% or 8.7% of that vault's debt.
- **Where it fails:**
  - **A premium above 1.62% to 2.67%** turns some false seizures thin. The borrower then loses all of its gold above the debt; there is still no protocol bad debt.
  - **A premium above 6.70% to 7.80%** puts vaults at 110% under water at the clamped price. The buffer then pays bad debt that is false, because the gold is worth more than the debt.
  - **A backlog.** A vault already below 102.8% to 103.8% at the market, because liquidations fell behind, books bad debt on any push.
  - **An edge book.** No protocol loss, but a push of 0.5% for one minute ($17k) already pays from about $0.5M of debt sitting at 110%. This is front-running borrowers whom ordinary moves would liquidate soon after.
- **Executable value.** The model values seized gold at mid. Selling it at once costs, with a 0.1% taker fee (**assumption**): 0.12% for $0.25M, 0.16% for $1M, 0.35% for $4M, 1.22% for $9.5M and 2.44% for $12.3M, the readable depth.
  - Gas is $0.13 to $19 per liquidation (**assumption**: 400,000 gas at 0.144 or 20 gwei). The 3% share covers it on a 1,000 GSUSD vault.
  - At m = 3%, a false liquidation at $25M of debt seizes $5.4M of gold and nets $337k after selling, against a $1.3M cost.
  - At $100M of debt the $21.7M seized exceeds the readable books. The attacker must hold or redeem the gold (**unverified** that Paxos redemption is available to it), so the break-even figures are lower bounds.
- **Upward push.** The price can be lifted at most to G x (1 + m). That delays the liquidation of vaults down to 107.6% to 108.6% of the market while the push is held; it books nothing unless the market falls meanwhile.

### 15.3 Genuine PAXG depegs (gold steady)

**Who liquidates** (**assumptions**):

- External liquidators act only when the gold they receive, sold at mid less 0.4% (0.1% fee and 0.3% slippage), is worth what they repay.
- The pool path is called whenever a vault is liquidatable and the pool holds enough, because its caller is paid in PAXG.
- The pool holds 10% of D.
- A vault that is never liquidated is abandoned by its borrower once the gold is worth less than the debt. The gap is GSUSD holders' under-backing, which lasts until PAXG recovers.

| Depeg | m | Sudden: total / borrowers / pool / buffer / GSUSD holders | Gradual: total / borrowers / pool / buffer / GSUSD holders |
|---|---|---|---|
| 5% | 2% | 6.00 / 6.18 / −0.03 / 0 / 0 | 5.63 / 6.09 / 0 / −0.22 / 0 |
| 5% | 3% | 6.14 / 6.48 / 0 / −0.33 / 0 | 5.52 / 6.22 / 0 / −0.33 / 0 |
| 10% | 2% | 12.00 / 11.64 / 0.49 / 0 / 0 | 11.04 / 11.49 / 0 / −0.20 / 0 |
| 10% | 3% | 12.00 / 11.74 / 0.40 / 0 / 0 | 10.63 / 11.31 / 0 / −0.31 / 0 |
| 20% | 2% | 24.00 / 19.19 / 1.55 / 0 / 3.38 | 21.87 / 19.05 / 0 / −0.18 / 3.25 |
| 20% | 3% | 24.00 / 19.28 / 1.46 / 0 / 3.38 | 20.85 / 18.81 / 0 / −0.28 / 2.69 |
| 30% | 2% | 36.00 / 19.73 / 2.61 / 0 / 13.77 | 32.70 / 19.60 / 0 / −0.16 / 13.50 |
| 30% | 3% | 36.00 / 19.81 / 2.53 / 0 / 13.77 | 31.08 / 19.40 / 0 / −0.24 / 12.29 |

Shares of D. Total is the loss inside the system: what borrowers, the pool, the buffer and GSUSD holders lose, less what liquidators and keepers gain. A negative buffer figure is penalty income. The m = 2.5% rows lie between these (`sec15_clamp_out.txt`).

- **Borrowers' loss is lost equity, not a protocol loss.** It is the depeg's effect on gold they own.
- **The buffer books no bad debt in any depeg.** The clamped price never makes a seizure under water. The cost of that is that vaults above 110% / (1 − m) are never liquidated while PAXG stays below the clamp, so their shortfall falls on GSUSD holders.
- **Gradual speeds.** The model gives the same result for a fall over 1, 6 or 24 hours, because the vaults that can be liquidated go during the first m of the fall, at the market. That holds only if they clear in time. In a 30% fall over one hour the first 3% takes six minutes, and 21% of D must clear in it; at large D that exceeds the readable books, and the result moves towards the sudden column.
- **Pool size** (sudden 30%, m = 3%):
  - uniform book: with no pool, GSUSD holders carry 16.00% of D; a pool of 25% of D lowers that to 12.29% and loses 4.30% itself;
  - edge book: GSUSD holders carry 22.99% of D with no pool and nothing with a pool of 100% of D, which then loses 25.31%.
- **Issuer freeze.** PAXG transfers or redemption fail, so nothing can be seized or sold. The collateral is worth nothing to the protocol until the freeze lifts. GSUSD holders are under-backed by up to 100% of D and borrowers lose their equity (20% of D on the uniform book); the pool and buffer are untouched. If only the seized gold cannot be sold, external liquidators stop and pool depositors hold unsellable PAXG.

### 15.4 Gold-wide crashes and liquidation capacity

- **The section 14.4 paths.** Worst gold hour and day, 10% and 30% in one hour, 30% over 24 hours: nothing booked at any m. C stays within m of G and the clamp never binds.
- **The gold-frozen variants** (a PAXG-specific fall) match 15.3: 30% in one hour or over 24 hours leaves 13.50%, 12.92% or 12.29% of D with GSUSD holders.
- **Capacity scales with D because there is no ceiling.** The table limits external liquidators to the readable bids within 3% ($9.5M) per book refill (**assumption** on the refill interval). Each cell is buffer bad debt / GSUSD holders' under-backing, as a share of D, at m = 3%.

| Path | D | Refill every minute | Every 10 minutes | Every 60 minutes |
|---|---|---|---|---|
| Worst gold hour | $25M to $500M | 0 / 0 | 0 / 0 | 0 / 0 |
| 30% in one hour | $25M | 0 / 0 | 0 / 0 | 7.49% / 0 |
| 30% in one hour | $100M | 0 / 0 | 6.19% / 0 | 5.37% / 6.90% |
| 30% in one hour | $500M | 0.75% / 0 | 6.70% / 5.93% | 1.18% / 12.29% |

- In a gold-wide fall liquidators can hedge with gold futures instead of selling PAXG at once (**assumption**), which would raise capacity.
- No real gold hour in 400 days exceeded 6.66%.

### 15.5 Stale feeds

**History.** Neither feed was stale in the measured history. Each sat close to the limit often.

| Feed | Window | Longest gap | Gaps over 86,000 s |
|---|---|---|---|
| XAU/USD | 400 days | 86,496 s | 112 |
| PAXG/USD | 61 days | 86,436 s | 19 |

A heartbeat missed by more than one hour makes the feed stale. The largest 24 hour gold moves in 400 days were a 9.61% rise and an 11.87% fall.

**C stale.**

| Move during the outage | Effect |
|---|---|
| Gold falls | the price follows gold down |
| Gold rises 5% | price 4.76% under the market; borrowers lose 2.82% of D; no bad debt |
| Gold rises 10% | price 9.09% under the market; borrowers lose 7.77% of D; no bad debt |
| Gold rises 15% | borrowers lose 15.15% of D; 0.92% of D booked as false bad debt |
| PAXG-specific fall | not followed at all: GSUSD holders carry 0.03%, 4.50% or 16.00% of D for a 10%, 20% or 30% fall |

**G stale.** Superseded: the contracts refuse liquidation while G is stale (see the note at the head of section 15). In the design modelled here the clamp sits on gold's last answer.

| Move during the outage | m = 2% | m = 2.5% | m = 3% |
|---|---|---|---|
| Gold rises 10%: borrowers' loss to false liquidations | 5.46% | 4.92% | 4.44% |
| Gold rises 15%: false bad debt | 0.33% | 0.21% | 0.12% |

A gold fall during the outage behaves like a PAXG depeg of the same size (15.3).

### 15.6 Reserve swaps

The valuation is max(C, G), only with both feeds healthy and C inside the 2% band.

- **Pushing C** down inside the band leaves the valuation at G; pushing it up gives the swapper less gold.
- **A slow depeg** reaches the band edge with the swapper paying a G-valued price for cheaper gold, a gain to the reserve. Past the edge, swaps are refused.
- **A stale feed** refuses swaps.
- **Worst transfer per swap.** The swapper gains only when the market is above both feeds: a PAXG premium over G plus G's 0.3% deviation lag, less the 0.5% minimum spread (`GoldStabilityReserve.MIN_SPREAD_PPM`). That is 0.43% of the swap at the 99.9th percentile premium, 0.64% at the measured maximum and 1.85% if the premium reached the band edge. The daily caps bound the volume. **Corrected in 15.8**: this overstated the exposure, because max(C, G) already carries a premium that C reports. A swapper gains only from C lagging the market by more than the spread, or from C pushed down to G.

### 15.7 Remaining solvency risks before deployment

| Risk | Bears it | Origin |
|---|---|---|
| A PAXG-specific depeg beyond m: vaults above 110% / (1 − m) are never liquidated; 3% to 14% of D in a 20% to 30% depeg | GSUSD holders; pool depositors up to 2.6% of D; borrowers' equity | inherited from PAXG; the choice not to follow it is introduced by the clamp |
| An issuer freeze or a failure of PAXG's backing: up to 100% of D | GSUSD holders | inherited from PAXG |
| A fast gold-wide crash at large D with slow book refills: 6% to 7% of D at $100M or more and a 30% hourly fall | SurplusBuffer, then GSUSD holders | inherited from market depth; scaled by having no ceiling |
| A feed outage with a large gold move: false liquidations; false bad debt above a 10% gold rise with C stale, or above a 12% to 13% rise with G stale | borrowers; the buffer | inherited from Chainlink; the fallbacks are introduced |
| Manipulation of C: false liquidation of vaults near 110%; protocol bad debt only above a 6.7% premium (m = 3%) or with a liquidation backlog | borrowers; the buffer in a backlog | inherited from Chainlink and exchange depth; exposure scales with D |
| The stability pool absorbing at the clamp in a depeg: depositors buy gold above the market | pool depositors | introduced by the pool path's PAXG bounty |
| A reserve swap while C lags a fast rise or is pushed down to G: see 15.8 (the 0.64% first given here was an overstatement) | the reserve | inherited from Chainlink's update latency and exchange depth |

**Verdict.**

- **Manipulation.** The clamp removes protocol bad debt from manipulation under the stated conditions at every m. It leaves borrowers near 110% exposed.
- **What the clamp does not remove.** The losses from a genuine PAXG depeg, an issuer freeze and limited liquidation capacity remain. With no ceiling, all three scale with D, and GSUSD holders carry the largest of them.
- **Ownership.** None of these is removed by a choice of m. They are the price of the project's decision, and they should be stated to users before launch.

### 15.8 Trigger and settlement, outages, capacity and the reserve under the project's constraints

**Provisional baseline** (29 October 2026): a fixed 2% clamp with no monitoring-triggered governance change. The C-stale fallback is removed: while Chainlink PAXG/USD is unhealthy, liquidation is refused (repay and deposit only) and resumes automatically on its first healthy answer. No mandatory keeper, debt ceiling or routine governance may serve as a workaround.

**Method.** Script `sec15_8.py` (loads `sec14_final.py` and `sec15_clamp.py` unchanged); output `sec15_8_out.txt`.

- **Premium and costs.** The premium of PAXG over gold is 0.71% (the 45 day maximum). Liquidators pay 0.4% to execute (0.1% taker fee and 0.3% slippage, **assumption**).
- **Pool.** The pool holds 10% of D unless stated.
- **Books.** Uniform book from 110% to 130%; the edge book has every vault at exactly 110% at the market.
- **The trigger** is the price that decides whether a vault is liquidatable. **The settlement** is the price `_sizeSeizure` sizes the seizure at.

**Conclusions**

1. **Recommended: variant C, trigger and settlement at min(max(C, G), G x 1.02).**
   - A push of C can then value collateral at gold, never below it. The only position it can manufacture is one inside PAXG's premium over gold: 4.0% of a uniform book at a 0.71% premium, for 0.15% of D, against 15.2% and 0.89% under the clamp.
   - A push at the moment of a legitimate liquidation raises the liquidator's take by at most the premium (0.73% of the debt), against 2.47% under the clamp.
   - Bad debt at settlement requires a vault genuinely under water (below 100.7%), not one at 102.8% as under the clamp.
   - Gold-wide crashes resolve as before, with liquidators keeping at least 1.72% after costs.
   - The cost: a PAXG-specific depeg is never liquidated, so GSUSD holders carry 0.03%, 4.50% or 16.00% of D at 10%, 20% or 30%. That is no worse than the clamp's sudden case (16.00% against 16.38% for pool and holders together at 30%) and up to 2.5 points worse than its gradual case (13.50%).
   - Conditions: the premium stays in its measured range (**assumption**; no governance response is allowed); an upward push of C up to G x 1.02 can stall liquidations while it is held; and the pool or liquidators can absorb a gold-wide crash (point 3).
2. **Pausing liquidation during a C outage costs nothing in a 10% gold fall** (0.06% of D at most). In a 30% gold fall within an hour of the outage starting it costs 17.1% to 17.7% of D. C has never been stale, but its heartbeat came within about an hour of the limit 9.3 times a month.
3. **Liquidation capacity, not the oracle, sets the loss in a fast gold crash at large D.**
   - At $10M of debt nothing is booked unless liquidators hold only $2M of GSUSD (0.07% with 10 minute refills, 12.9% with hourly ones).
   - At $50M and $100M, a 30% one-hour fall books nothing if books refill every minute, and up to 16.7% of D otherwise. A pool of 5% to 100% of D is needed to keep it at zero.
4. **The reserve cannot be drained at the boundaries,** but it can lose up to 1.16% of a swap when C lags a 1.67% one-minute rise, or 0.34% when C is pushed down to G at the largest measured premium. That is at most 0.23% of the reserve a day under the 20% daily cap.

**1. Trigger and settlement variants** (both feeds healthy, m = 2%):

- **A**: trigger and settlement at clamp(C);
- **B**: trigger at max(C, G) while C is inside the band and at G below it, settlement at clamp(C);
- **C**: trigger and settlement at min(max(C, G), G x 1.02);
- **D**: trigger and settlement at G, with C required healthy but not used in the price. D is the simplest variant found.

| | A | B | C | D |
|---|---|---|---|---|
| Uniform book exposed to a false liquidation | 15.2% | 4.0% | 4.0% | 4.0%, without any push |
| Largest profit share, uniform / edge | 0.89% / 5.85% | 0.23% / 5.85% | 0.15% / 3.73% | 0.149% / 3.73%, to any liquidator, no push needed |
| Break-even D, uniform, 1 / 3 / 10 minute hold | $11.2M / $33.5M / $111.5M | $16.1M / $48.3M / $161M | $16.1M / $48.4M / $161M | no manipulation route |
| Break-even D, edge book, 1 / 3 / 10 minutes | $0.27M / $0.80M / $2.7M | same | same | liquidated by the premium alone |
| A push at a legitimate liquidation: extra take per $ of debt | 2.47% | 2.47% | 0.73% | 0 |
| A push at a legitimate liquidation pays from (1 / 10 minute hold) | $4.0M / $40.3M liquidated in the window | same | $13.6M / $136M | never |
| Settlement books bad debt for a vault below (true ratio) | 102.8% | 102.8% | 100.7% | 100.7% |
| Upward push (stall): highest trigger against the market | +1.28% | +1.28% | +1.28% | none (G sits 0.70% under the market) |
| Gold-wide crashes (14.4 paths): bad debt; smallest liquidator margin | 0; 1.72% | 0; 1.72% | 0; 1.72% | 0; 1.72% |
| Liquidators still act | yes | yes | yes | yes |

- **The edge book.** Every variant lets a push of 0.25% or a natural premium liquidate a book sitting exactly at 110%. This front-runs borrowers whom an ordinary move would liquidate soon after. It costs borrowers their penalty, not the protocol. The finer push grid here lowers the clamp's edge break-even from the $0.5M of 15.1 to $0.27M.
- **D compared with C.** D cannot be moved through C at all, so it is immune to stalls. It values collateral at gold, below the market whenever PAXG trades at a premium, so it liquidates the premium slice without any push. C fits the project's aim more closely: an oracle deviation cannot manufacture a liquidation below gold.

**Genuine PAXG depegs, gold steady** (total / borrowers / pool / buffer / GSUSD holders, % of D):

| Depeg | A sudden | A gradual | B, C and D (no trigger, either speed) |
|---|---|---|---|
| 5% | 6.00 / 6.18 / −0.03 / 0 / 0 | 5.63 / 6.09 / 0 / −0.22 / 0 | 6.00 / 6.00 / 0 / 0 / 0 |
| 10% | 12.00 / 11.64 / 0.49 / 0 / 0 | 11.04 / 11.49 / 0 / −0.20 / 0 | 12.00 / 11.97 / 0 / 0 / 0.03 |
| 20% | 24.00 / 19.19 / 1.55 / 0 / 3.38 | 21.87 / 19.05 / 0 / −0.18 / 3.25 | 24.00 / 19.50 / 0 / 0 / 4.50 |
| 30% | 36.00 / 19.73 / 2.61 / 0 / 13.77 | 32.70 / 19.60 / 0 / −0.16 / 13.50 | 36.00 / 20.00 / 0 / 0 / 16.00 |

- **Why B, C and D never liquidate a PAXG-specific fall.** Their trigger never goes below gold, so no vault becomes liquidatable. Pool depositors lose nothing, borrowers pay no penalty and GSUSD holders carry every vault left under water.
- **A combined depeg and gold fall.** Under C and D, vaults triggered by gold's fall settle at gold, above the PAXG market. Liquidators stop once the depeg exceeds about 2.6%, and the pool would then absorb at gold.

**2. Liquidation refused while C is unhealthy**

**Effect of the pause.** A gold-wide crash that starts with the outage; buffer bad debt plus GSUSD holders' under-backing, % of D (variant C; the clamp gives the same within 0.2 points):

| Crash | Outage 1 hour | 6 hours | 24 hours |
|---|---|---|---|
| Gold 10% in one hour | 0.02% | 0.06% | 0.06% |
| Gold 10% over 24 hours | 0 | 0 | 0.04% |
| Gold 30% in one hour | 17.09% | 17.68% | 17.68% |
| Gold 30% over 24 hours | 0 | 0 | 17.46% |

- **How often C nears its limit.** C was never stale in 61 days, but 19 heartbeats (9.3 a month) took over 86,400 s, and the longest came 3,564 s from the 90,000 s limit. XAU/USD did the same 111 times in 400 days, coming 3,504 s from it. How likely an outage is during a crash is **unverified**.
- **Recovery.** Liquidation resumes by itself on the first healthy answer; nothing needs to be called. If the feed never returns (a deprecated or broken feed), liquidation stays refused and only repayment and deposits work. The one remedy is a non-routine, timelocked governance action replacing the feed, which leaves at least the delay in force (48 hours at launch) of exposure on top of the outage. The function and its checks should be confirmed in the contracts being rewritten.
- **G stale.** Superseded: the contracts refuse liquidation while G is stale, as they do for C (see the note at the head of section 15). As modelled, with the clamp around G's last answer, a gold-wide fall is followed only to 2% below that answer, so it behaves like a PAXG depeg until G returns. A 10% fall books nothing. A 30% fall books 14.48% to 15.01% of D with a 1 to 24 hour outage in one hour, and 14.87% if it is spread over a 24 hour outage. If G never returns, the same timelocked replacement applies.

**3. Liquidation capacity, gold-wide crashes** (variant C)

- **Executable liquidity.** The readable CEX bids within 3% ($9.5M) plus PAXG/WETH within 2% ($0.45M), per book refill. A liquidator's GSUSD inventory caps what it can repay in each refill window. Refill interval and inventory are **assumptions**.
- **Reading the table.** Each cell is bad debt (buffer plus holders, % of D) with no pool, and in brackets the pool, as a share of D, needed to bring it to zero. Falls of 10% book nothing at any level in any setting, except 0.01% at $100M with an hourly refill (a 5% pool removes it).

| D | Path | Refill 1 min, inventory $10M | 10 min, $10M | 10 min, $2M | 60 min, $2M |
|---|---|---|---|---|---|
| $10M | 30% in 1 h | 0 | 0 | 0.07% (2%) | 12.93% (100%) |
| $50M | 30% in 1 h | 0 | 0.30% (5%) | 13.43% (100%) | 16.69% (100%) |
| $50M | 30% over 24 h | 0 | 0 | 0 | 2.56% (30%) |
| $100M | 30% in 1 h | 0 | 7.75% (75%) | 15.55% (100%) | 16.41% (100%) |
| $100M | 30% over 24 h | 0 | 0 | 0 | 9.83% (75%) |

- **What the outcome rests on.** No real gold hour in 400 days exceeded 6.66%. At $50M or more, a 30% fall within an hour is absorbed only if books refill within minutes and liquidators hold several million GSUSD, or if the pool holds a large share of D.
- **What helps.** Hedging on gold futures instead of selling PAXG at once would raise capacity (**assumption**). The pool absorbs without selling, which is why its size decides the outcome.

**4. Reserve swaps at the boundaries** (valuation max(C, G); both feeds healthy and C inside the 2% band; 0.5% minimum spread; daily cap 20% of the reserve's balance; no aggregate cap at launch):

| Situation | Swapper's gain per swap | Most the reserve can lose in a day |
|---|---|---|
| C lagging a rise by its 0.5% trigger | 0 | 0 |
| C lagging a 1.67% one-minute rise (gold's largest; it was a Sunday reopen step) | +1.16% | 0.23% of the reserve |
| C pushed down to G at a 0.63% premium (99.9th percentile) | +0.13% | 0.03% |
| C pushed down to G at a 0.84% premium (the 60 day maximum) | +0.34% | 0.07% |
| C at the band's lower edge, PAXG 2% under gold | −2.45% (the swapper loses) | 0 |
| C above or below the band, or either feed stale (including the transitions) | refused | 0 |

- **Repetition.** Repeated swaps cannot compound the gain: each is valued afresh, and the daily cap bounds the volume.
- **The push-down route.** A one-minute push to G at the 0.84% premium costs $28k and pays only when the reserve exceeds $41.9M ($419M for a 10 minute hold).
- **Who loses.** The reserve, which is to say GSUSD holders' backing.

**5. Risks that cannot be eliminated under the project's constraints**

| Risk | Bears it | Inherited or introduced |
|---|---|---|
| A PAXG-specific depeg is never liquidated (variant C): 4.5% of D at 20%, 16% at 30% | GSUSD holders; borrowers' equity | inherited from PAXG; not following it is introduced |
| An issuer freeze or failure of PAXG's backing: up to 100% of D | GSUSD holders | inherited from PAXG |
| A fast gold-wide crash beyond liquidation capacity at large D: up to about 17% of D | the buffer, then GSUSD holders; the pool if large | inherited from market depth; scaled by having no ceiling, which is introduced |
| A C outage during a crash: liquidation refused; 17.7% of D in a 30% fall | the buffer, then GSUSD holders | inherited from Chainlink; the pause is introduced |
| A G outage during a crash, as modelled (superseded: the contracts refuse liquidation, as in the row above): clamp on a stale gold price; about 15% of D in a 30% fall | GSUSD holders | inherited from Chainlink; the fallback is introduced |
| A feed that never returns: liquidation refused until a timelocked replacement, at least the delay in force (48 hours at launch) | as the two rows above | inherited from Chainlink; the timelock is introduced |
| A push of C liquidating vaults inside PAXG's premium, or front-running a book at 110% | borrowers (their penalty) | inherited from Chainlink and exchange depth |
| An upward push of C stalling liquidations by up to 1.28% while held | the buffer, if the market falls meanwhile | introduced by using max(C, G) |
| A reserve swap while C lags a fast rise: up to 1.16% of a swap, 0.23% of the reserve a day | GSUSD holders | inherited from Chainlink's update latency |
