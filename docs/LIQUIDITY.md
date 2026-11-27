# Gold Standard Liquidity Policy

**Status**: adopted 10 June 2026. Pre-launch. The protocol has zero users, zero TVL and no live pools. Every sizing figure in this document is illustrative arithmetic from stated assumptions, not a forecast and not a yield offer. Depth figures were verified June 2026; section 1 adds single-pool quotes taken on 11 November 2026.

This document records why liquidity is the binding constraint, the playbook for seeding it, how the peg actually holds and the listing sequence. The companion documents are [`BUSINESS_MODEL.md`](BUSINESS_MODEL.md) (revenue and the retired depth rule), [`ORACLES.md`](ORACLES.md) (feeds and token onboarding) and [`LAUNCH.md`](LAUNCH.md) (the launch and its first weeks).

---

## 1. Liquidity, not demand, caps safe TVL

Verified June 2026: the largest PAXG pool on Ethereum mainnet held roughly **$1.6M** (PAXG/USDT, Uniswap v4) and the PAXG/XAUT pool roughly **$3.6M**. Combined on-chain depth for both gold tokens is single-digit millions against a tokenised gold market capitalisation of roughly $6B. Nearly all tokenised gold sits still; almost none of it trades on-chain.

This caps safe TVL through the liquidation path. When a vault is liquidated directly, the liquidator's exit is the DEX. If seized collateral must be sold into thin depth, the sale moves the gold token's on-chain price, which marks down every remaining vault, which triggers further liquidations. Thin depth converts one liquidation into a cascade. Demand for minting GSUSD does not change that arithmetic at all, which is why the retired ceiling rule in section 6 keyed off measured depth and nothing else.

**Quotes of 11 November 2026.** Uniswap v3 `QuoterV2.quoteExactInputSingle`, one pool at a time, near block 26,392,850, with PAXG at $3,996.71 on CoinGecko in the same minute. The figure is the output against that price.

| Pool | 1 oz | 10 oz | 100 oz |
|---|---|---|---|
| PAXG to USDC, 0.05% (held 450 PAXG and 416k USDC) | -0.08% | -0.38% | -6.5% ($373,659) |
| PAXG to USDC, 0.30% | -0.32% | -1.1% | -64.6% |
| PAXG to WETH, 0.30% | -0.6% | -2.8% | -4.0% |
| PAXG to USDT, 0.05% | not quoted | -46.7% (pool exhausted) | not quoted |
| PAXG to XAUT, 0.01% (held 1,127 PAXG and 500 XAUT) | not quoted | not quoted | 100.0485 XAUT out |

A second quote of the PAXG to USDC 0.05% pool later the same day returned $39,742 for 10 oz and $323,286 for 100 oz, about 19% under that price, so the depth moves within hours. Buying PAXG in the same pool: $40,000 bought 9.971 oz (0.37% over the price) and $400,000 bought 96.96 oz (3.2% over).

What follows from these: a direct liquidator keeps 60% of the 5% penalty, 3% of the debt repaid. Selling 10 oz in one pool fits inside that share; selling 100 oz in one pool does not. Third-party direct liquidators therefore break even only on small vaults, and a large liquidation rests on the keeper's GSUSD float and the stability pool ([`MAINNET.md`](MAINNET.md) section 4.7). Only single-pool Uniswap v3 routes were quoted; an aggregator that splits across pools, Uniswap v4, Curve and exchange order books will do better than these figures. Take the quotes again on launch day.

The second face of the same constraint: GSUSD itself needs a venue. A stablecoin nobody can swap has no users, no aggregator routing and no listings. Nobody else will provide that venue for a zero-volume token, so the protocol must.

## 2. Protocol-owned liquidity playbook

The project seeds the first venue itself, through the operations Safe, as a borrower like any other:

1. **Open an over-collateralised PAXG vault** from the operations Safe, at a deliberately high ratio (250% or above) so the position is never near liquidation.
2. **Mint GSUSD** against it. The operations Safe pays the same stability fee as every user; it is not exempted from that. Its launch mint pays the origination fee too (project decision, 2026-11-26); later mints can be exempt from that fee alone (`GoldVault.setOriginationFeeExempt`; `MAINNET.md` section 5). Every borrower owes more GSUSD than they received, and this position is where the first of them buy the difference. The fee routes to the protocol's own [`SurplusBuffer`](../contracts/src/core/SurplusBuffer.sol), so the consolidated cost is small, but the discipline matters: protocol-owned debt appears in every public number like anyone else's.
3. **Seed a tight-range GSUSD/USDC Uniswap v3 position**, pairing the minted GSUSD with USDC the operations Safe holds. The range sits inside the peg band from section 4, roughly $0.99 to $1.01, with the bid side never placed below the Stability Reserve's quoted floor ($1 minus the current spread); bids below that floor are free money for arbitrageurs at the project's expense.

Three operational facts for launch ([`MAINNET.md`](MAINNET.md) section 5):

- **The operations Safe opens the seed vault on launch day**, paying the origination fee, so the position does not wait on the timelock. Its exemption from that fee is a governed call that takes 48 hours, printed by `scripts/print-fee-exemption-proposal.ts`, and serves the mints that deepen the position later.
- **The dapp's market tab does not use this position.** The tab quotes GSUSD against PAXG in one hop, so a GSUSD/USDC pool does not serve it, and no launch step seeds a GSUSD/PAXG pool. On mainnet the tab is off and the swap page shows the reserve alone. Once a GSUSD/PAXG 0.30% Uniswap v3 pool is seeded at a fair price, `DEX_MARKET=1 npx hardhat run scripts/print-service-env.ts --network mainnet` prints the dapp block with the tab on, and the dapp is rebuilt.
- **The reserve seed is separate from this position**, and is described in section 4.
- **This pool is the one the Usage Ledger records liquidity from.** As soon as it exists, its address and the position manager's go into the API environment ([`MAINNET.md`](MAINNET.md) section 5, [`USAGE_LEDGER.md`](USAGE_LEDGER.md) section 1.3). The ledger records every position in the pool the same way, the operations Safe's included, valued at the peg and only while in range. It is a record only: no token exists, no token is promised, the ledger confers no rights and may never confer any.

**Sizing, as illustrative arithmetic only.** Mainnet launches under `LAUNCH_CAPS=open`, with no PAXG debt ceiling, so no ceiling bounds outstanding GSUSD and the position is sized against measured supply. At $250,000 of outstanding GSUSD, a position of $100,000 GSUSD plus $100,000 USDC would represent depth equal to most of the supply, which is ample. Scaling rule of thumb: keep protocol-owned GSUSD/USDC depth at roughly 20 to 40% of outstanding GSUSD supply in the first weeks after launch, reviewed as organic LPs arrive. These percentages are starting assumptions to be revised against observed swap volume, not commitments.

**Rebalancing cadence.** Review weekly. Recentre the range when price sits outside it or the position inventory passes roughly 80/20 one-sided. Two hard rules: the position is a service, not a trading book, so impermanent loss within the band is simply the cost of the service; and the project never defends a broken peg with the LP position. If GSUSD trades persistently below the reserve floor, the reserve is empty, capped or paused, or the oracle is wrong, and the answer is the incident process in [`LAUNCH.md`](LAUNCH.md), not bigger bids.

**Risk, stated plainly.** The operations Safe's vault is liquidatable like any other vault. Keep its ratio high, monitor it with the same alerts as user vaults and top up collateral before ratio decay ever becomes interesting.

## 3. The StabilityPool as the demand sink

Pools make GSUSD swappable; the [`StabilityPool`](../contracts/src/core/StabilityPool.sol) makes it worth holding. Depositors fund pool-path liquidations and receive seized collateral at a discount when liquidations occur. That is the protocol's only native return and it is the honest kind: it already exists in code, it requires no emissions and no token, and it is episodic by design. **Liquidation gains arrive only when liquidations happen and may be zero for long stretches. No yield figure is quoted anywhere, because none can honestly be quoted.**

The pool also softens the depth constraint directly: `liquidateViaPool()` absorbs seized collateral into depositors' claims instead of forcing a market sale, so pool-path liquidations never touch the thin DEX depth in section 1. This is why [`BUSINESS_MODEL.md`](BUSINESS_MODEL.md) treats a funded StabilityPool and its deposit interface as launch-critical infrastructure rather than an optional feature. Operationally: the operations Safe makes the first deposit, for the same reason it opens the first vault.

## 4. Peg mechanics: the arbitrage cap and the reserve floor

The peg is a band held by two one-sided forces, and it is more honest to describe the band than to claim a hard $1.00:

- **Upside cap, organic.** Minting costs one charge at the door, the 5 bps origination fee ([`BUSINESS_MODEL.md`](BUSINESS_MODEL.md) section 1). If GSUSD trades above about $1.0005, the price at which that fee is covered, anyone can deposit gold, mint, sell into the premium and keep the difference less gas; supply expands until the premium closes. The cap is organic rather than hard because the arbitrageur must hold an over-collateralised vault, so a premium can persist when gold capital is scarce or gas is high.
- **Floor, the Stability Reserve.** If GSUSD trades below $1 minus the spread, anyone can buy it and swap with the GSR for protocol-owned gold at the oracle's reserve price, the higher of the token's Chainlink market feed and Chainlink XAU/USD, while the two sit within the gold band (2% at launch) ([`ORACLES.md`](ORACLES.md) section 4). The floor holds to the depth of the reserve and no borrower's vault is involved. The spread steps up as reserve coverage falls (0.50% above 15% coverage at launch, rising toward 2% below 2%; the floor constant is 0.5%, never below the gold feeds' own deviation triggers), so the floor deliberately softens as defensive inventory thins; the depth is bounded further by per-asset daily caps. Plainly: the reserve ships empty and there is no floor at all until it holds gold, and once its redeemable gold is exhausted the guaranteed swap stops until it refills from liquidation penalties or seeding.

  **Seeding the reserve.** The seed is **0.05 PAXG** (project decision, 2026-11-26, replacing the 0.25 PAXG of 2026-11-15). The Safe that holds the gold, the operations Safe at launch, sends two transactions printed by `SEED_AMOUNT=0.05 npx hardhat run scripts/print-reserve-seed.ts --network mainnet` (the amount is in PAXG and takes a decimal point): `PAXG.approve(reserve, amount)`, then `GoldStabilityReserve.seedCollateral(PAXG, amount)`. `seedCollateral` has no role check, so no governance Safe and no timelock wait is involved. **Never send PAXG to the reserve with a plain transfer: it is not counted as reserve, no swap can draw on it, governance cannot withdraw it, and it cannot be recovered.**

Net honest claim: GSUSD should trade in roughly a $0.99 to $1.01 band while reserve coverage is healthy, floor enforced by arbitrage against the Stability Reserve, limited by reserve depth, ceiling leaned on by minting at the 5 bps origination fee and the protocol-owned position quoting inside the band. Nothing in this document promises a tighter peg than that arithmetic supports.

## 5. Aggregator and listing sequence

Visibility follows depth; applications do not substitute for it. The sequence, started only after mainnet TVL exists:

1. **DefiLlama**: submit a TVL adapter as soon as minting is live. Free, fast and the de facto registry an integrator checks first.
2. **CoinGecko** (then CoinMarketCap): list GSUSD once the GSUSD/USDC pool exists with measurable depth and a price history. Listings with no liquidity behind them are noise and are not pursued.
3. **Aggregator routing**: 0x, 1inch and Paraswap index pools automatically once depth and volume justify routing. The dapp integrates no aggregator: its 0x quote procedure was removed on 2026-09-14 ([`BUSINESS_MODEL.md`](BUSINESS_MODEL.md) section 1) and its market tab quotes one Uniswap v3 pool directly (section 2), so external routing reaches GSUSD through other interfaces. There is no application to file here; depth is the application.

Pre-launch, none of these exist and none is claimed. The reserves page says pre-launch until the day that stops being true.

## 6. The depth-linked ceiling rule (superseded)

Superseded on 29 October 2026: the variant C decision launches PAXG under `LAUNCH_CAPS=open`, with no debt ceiling, so no ceiling is sized from depth and there are no scheduled raises ([`BUSINESS_MODEL.md`](BUSINESS_MODEL.md) section 4). The rule and its measurement discipline are kept below as the record. The rule was:

> **Debt ceilings must never exceed 10 to 20% of measured PAXG/XAUT DEX depth.** Measure depth weekly during the guarded ramp. Raising a ceiling requires the measurement, not the calendar.

Measurement discipline: count on-chain pools for the specific collateral token, measure executable depth within roughly 2% price impact and keep the methodology identical week to week so the series is comparable. Protocol-owned GSUSD/USDC depth does **not** count toward this measurement; the rule exists for the collateral exit path, and GSUSD pool depth is a different asset. A weekly measurement that falls is a reason to consider lowering ceilings, not merely to pause raising them.

## 7. The stability reserve: the PSM decision, reversed for gold

The earlier version of this section declined to adopt a peg stability module and left the decision open. That decision was made on 2026-08-29 and is recorded in [`PEG_ARCHITECTURE.md`](PEG_ARCHITECTURE.md): the protocol operates a [`GoldStabilityReserve`](../contracts/src/core/GoldStabilityReserve.sol), and the "no PSM" default is reversed for that mechanism and that mechanism only.

What was objected to, and what was built, are different things:

- **The objection was to a fiat PSM at a fixed fee.** A USDC module would back part of GSUSD with a Circle liability, import USDC freeze and depeg risk into a system designed to shard issuer risk, plausibly move GSUSD toward the fiat-reserve payment-stablecoin perimeter discussed in [`TOKEN_POLICY.md`](TOKEN_POLICY.md) section 6, and collapse the section 4 band to the fixed fee. Every one of those objections stands. No fiat PSM is built or deployed, and adopting one would still require a project decision, counsel review and a public restatement of what backs GSUSD.
- **What was built is a gold reserve at oracle minus a dynamic spread.** The reserve holds protocol-owned PAXG (and XAUT once its activation batch lists it, [`XAUT_ACTIVATION.md`](XAUT_ACTIVATION.md)) and pays gold for GSUSD at the oracle price minus a spread that rises as reserve coverage falls. The section 4 band is unchanged: the floor is $1 minus the current spread, not a fixed fee, and the ceiling is still leaned on by minting at the 5 bps origination fee. Backing stays gold, because the reserve only ever pays out gold and only ever holds GSUSD that a borrower created against gold.
- **The reserve never mints.** It holds no `MINTER_ROLE`, `verify-deployment` asserts that it does not, and the Foundry suite proves `totalSupply == Σ borrowerPrincipal` with swaps in the handler. GSUSD it receives is held as inventory, never burned. It has no liabilities and can only be empty, never insolvent. Letting it issue GSUSD is not a phase and would need junior capital, and a governance architecture change.

The honest limitation carries over from section 4: the floor is exactly as deep as the reserve, and the reserve ships empty. "Fully gold backed" remains a claim that survives contract-level scrutiny, because nothing in the reserve changes who bears gold/USD risk on any GSUSD.

## 8. Review cadence

This policy is reviewed monthly in the first weeks after launch and quarterly thereafter. Each review publishes the measured depth series, the protocol-owned position size against outstanding supply and any proposed amendment with its rationale.
