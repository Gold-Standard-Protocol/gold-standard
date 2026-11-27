# Gold Standard Oracle Policy and Token Onboarding Runbook

**Status**: adopted 10 June 2026. Pre-launch. Feed addresses and depth figures were first verified against Ethereum mainnet in June 2026; later reads carry their own dates. This document is the canonical feed inventory: at deploy time, verify every `.env` feed value against section 1 character by character, regardless of what any other document says.

This document records which price feeds exist, which the protocol uses, why the staleness bound is what it is and the runbook for onboarding any future gold token. The companion documents are [`BUSINESS_MODEL.md`](BUSINESS_MODEL.md) (the retired depth rule and the reserve floor), [`LIQUIDITY.md`](LIQUIDITY.md) (liquidity policy) and [`LAUNCH.md`](LAUNCH.md) (launch gates).

---

## 1. Verified mainnet feed inventory

| Feed | Address | Decimals | Heartbeat | Deviation trigger | Verified |
|---|---|---|---|---|---|
| Chainlink PAXG/USD (push) | `0x9944D86CEB9160aF5C5feB251FD671923323f8C3` | 8 | 24h | 0.5% | RPC-confirmed live, June 2026 |
| Chainlink XAU/USD spot (push) | `0x214eD9Da11D2fbe465a6fc601a91E62EbEc1a0D6` | 8 | 24h | 0.3% | June 2026 |
| Chainlink XAUT/USD (push) | **Does not exist** | n/a | n/a | n/a | June 2026; still absent 28 October 2026 |
| Chainlink ETH/USD (push), research only | `0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419` | 8 | 1h | 0.5% | description read on chain, 29 October 2026; not used by the deployed oracle |
| Uniswap v3 PAXG/WETH 0.30%, research only | `0x8a7e585048bda875e64024118c506b14f78166dd` | n/a | n/a | n/a | read on chain, 28 October 2026; no longer an oracle source since variant C (29 October 2026) |

State of XAUT pricing, plainly: **there is no XAUT/USD AggregatorV3 push feed on Ethereum mainnet.** XAUT/USD exists only as a Chainlink Data Stream (pull-based) and as a Pyth price feed (Pyth ships a `PythAggregatorV3` Chainlink-compatible adapter). Any configuration that registers the XAU/USD spot feed as an "XAUT feed" is wiring a proxy, with the basis risk described in section 3. [`GoldOracle`](../contracts/src/core/GoldOracle.sol) enforces 8 feed decimals on every registration, so all three routes in section 3 are interface-compatible once adapted; none of them changes the maths.

## 2. The staleness bound: why 90000 seconds

`stalenessThreshold` is capped at 90000 seconds in the [`GoldOracle`](../contracts/src/core/GoldOracle.sol) constructor and bounded to the range 300 to 90000 seconds in `setStalenessThreshold`. The 90000 second (25 hour) ceiling is deliberate:

- Both mainnet feeds carry a **24 hour heartbeat**. A healthy feed in a quiet gold market may legitimately go almost 24 hours between updates. A threshold below the heartbeat would brick the oracle on quiet days, which is the worse failure: an oracle that refuses a price blocks mints, withdrawals from a vault with debt, reserve swaps and liquidations.
- The extra hour is grace for block timing and feed transmission latency, nothing more.
- **The measured margin is about 58 minutes.** A read of both feeds' round history on 11 November 2026 (PAXG/USD back to 24 June 2026, XAU/USD back to 5 September 2026) found the largest gap between two updates at 86,448 seconds for PAXG/USD and 86,484 seconds for XAU/USD, with none above 88,200 seconds. That leaves 3,516 seconds before the 90,000 second limit. The 8 November fork rehearsal read the same thing over 30 days: a largest gap of 24.0 hours, 96% of the limit. These figures were not measured again for this document.
- **What a late heartbeat does.** If a heartbeat write lands more than about 58 minutes late, the oracle refuses a price for that token until it lands: minting and withdrawals from a vault with debt revert, reserve swaps revert and no liquidation can run. Repaying, depositing and withdrawals from a debt-free vault continue. It heals by itself on the next round, and the limit cannot be raised: 90,000 is the contract's cap.
- **The early warning.** The keeper logs `oracle.feed-late` at warn when PAXG/USD or XAU/USD is older than 86,400 seconds plus 900 seconds while it still prices, and repeats at most hourly; `secondsUntilRefused` on the line is the time left before the limit. `oracle.price-refused` (error) and `oracle.feed-invalid` (warn) follow once the limit is passed. The warning is not raised while the oracle is paused or the token frozen. Put it on the pager ([`MAINNET.md`](MAINNET.md) section 4.7), so the on-call knows the cause before users report reverts. The 86,400 plus 900 mark holds only while it is at least two seconds below `stalenessThreshold`. A governance proposal that lowers `stalenessThreshold` to 87,301 or less must lower the keeper's `KEEPER_FEED_LATE_MARGIN_SECONDS` in the same change. Otherwise the keeper logs the conflict (`oracle.feed-late` with no `source` field) and warns at a fallback mark: the heartbeat alone, or half the threshold when the heartbeat is not below it either.
- The bound does not weaken price quality where it matters. Both feeds are deviation-triggered (0.5% and 0.3%), so they update fastest exactly when price moves. Within the 25 hour window, a wedged market feed is caught by the gold band against XAU/USD (section 4), not by the staleness clock: a PAXG price that drifts more than 2% from gold stops borrowing and reserve swaps outright, and liquidation never values PAXG below gold or more than 2% above it.

Operational rule: the deployed threshold is 90000 seconds. Lowering it below any configured feed's heartbeat is a self-inflicted outage and must be rejected at proposal stage.

## 3. XAUT pricing routes, compared honestly

Three candidate routes exist. None is free. The comparison:

| Route | Mechanism | Integration cost | Honest weakness |
|---|---|---|---|
| XAU/USD spot proxy | Register the spot feed as XAUT's entry in the oracle registry | Refused on chain while XAU/USD is the gold reference: `addFeed` and `setFeed` reject the anchor feed (`Feed not independent`) | **Basis risk.** XAUT is a Tether liability, not gold. It can trade away from spot under redemption friction, a freeze event or issuer stress. The proxy keeps pricing XAUT at spot precisely when the market is repricing the token, so vaults are over-valued in exactly the failure case. |
| Pyth `PythAggregatorV3` adapter | Chainlink-compatible adapter over the Pyth XAUT/USD feed | Keeper cost: Pyth is pull-based, so the protocol must run and fund a keeper to push updates on-chain, and the effective staleness profile is the keeper's cadence | Different trust model (Pyth publisher set) layered onto a protocol designed around Chainlink assumptions. The keeper is new launch-critical infrastructure. |
| Chainlink Data Streams | Official XAUT/USD stream with on-chain verifier | Verifier integration: a new adapter or oracle code path, per-read verification gas and commercial terms with Chainlink | New code in the trust perimeter. Not a configuration decision. |

**Recommendation, adopted as policy: launch PAXG-only.** XAUT is not a vault collateral type, reserve asset or stability pool token at launch, and stays inactive until governance ratifies a route by a documented decision and the activation batch in [`XAUT_ACTIVATION.md`](XAUT_ACTIVATION.md) has run. Running the spot proxy as live collateral pricing is not acceptable. The oracle constructor must register XAUT, so `deploy.ts` registers it on an `InactiveFeed` that answers no price (`No reliable price`); the XAU/USD spot feed is not wired against XAUT anywhere.

**Revision of 29 October 2026, variant C (documented decision, the current rule; supersedes the two
revisions below).** PAXG is priced from two Chainlink sources only: PAXG/USD (C) and XAU/USD (G). Borrowing
at min(C, G) while C sits inside the 2% gold band, liquidation at min(max(C, G), G × 1.02), reserve swaps at
max(C, G) inside the band and every priced path refused while either feed is unhealthy. The Uniswap pool,
the liquidation floor and every keeper observation duty are retired; the evidence is section 15.8 of
[`ORACLE_MANIPULATION_MODEL.md`](ORACLE_MANIPULATION_MODEL.md). Mainnet launches under `LAUNCH_CAPS=open`,
the only mainnet profile: the preflight and `deploy.ts` refuse `LAUNCH_CAPS=backstop` on mainnet, because its
maximum was derived under the pool design.

**Revision of 29 October 2026, launch profile and liquidation floor (superseded by variant C the same
day; kept as the record).** Mainnet launches under `LAUNCH_CAPS=open`:
no debt ceiling and no per-block mint cap, PAXG only, XAUT registered and dormant on an
`InactiveFeed`. The $5M backstop rested on a lowest D* of $6.6M that section 14.7 of
[`ORACLE_MANIPULATION_MODEL.md`](ORACLE_MANIPULATION_MODEL.md) no longer supports ($2.8M on path
(b2), $5.05M on path (e2)). The project chose to close those paths in the oracle rather than lower
the ceiling: below the gold band no liquidation prices under the liquidation floor, the band's
lower edge until a breach on that side has persisted for 60 minutes and then descending at 10%
of gold per hour (section 4). `LAUNCH_CAPS=backstop` remains an accepted alternative only with a
ceiling re-sized from the model's re-run with the floor (section 14.8, in progress).

**Revision of 29 October 2026, PAXG-first (documented decision, replaces the 23 October revision
below; its pool source and $5M backstop are superseded by variant C above).**
Mainnet launches **PAXG-first**. PAXG is priced by Chainlink PAXG/USD with the Uniswap v3 PAXG/WETH
pool as the confirming source and Chainlink XAU/USD as the gold reference, under the rules in
[`ORACLE_IMPLEMENTATION_PLAN.md`](ORACLE_IMPLEMENTATION_PLAN.md), with a $5M backstop debt ceiling from
[`ORACLE_MANIPULATION_MODEL.md`](ORACLE_MANIPULATION_MODEL.md) section 14. XAUT is registered in the
oracle and otherwise inactive; the spot proxy no longer prices it. XAUT is activated on objective
criteria ([`XAUT_ACTIVATION.md`](XAUT_ACTIVATION.md)), not on a date. The anchor band of section 4 is
now the per-token gold band (2%), and the confirming pool replaces the step deviation gate; the
evaluation behind the choice is [`ORACLE_FEED_EVALUATION.md`](ORACLE_FEED_EVALUATION.md).

**Revision of 23 October 2026 (superseded on 29 October).** The launch ships with
`LAUNCH_CAPS=open`: no debt ceiling and no per-block mint cap on either collateral from
block one, XAUT included, with XAUT registered on the XAU/USD spot proxy. The basis risk in
the table above is therefore live from launch rather than deferred, the preflight prints it
as a warning on every run and `verify-deployment.ts` asserts the open state. The Pyth
adapter or the Data Streams route remains the way to retire that risk and is the first
oracle change to propose after launch.

## 4. The anchor cross-check

The concept: every gold token feed is checked against an independent anchor for the same underlying, and XAU/USD spot is the natural anchor for every gold token. A token that tracks gold should never drift far from spot; when the basis widens, it is the token repricing, not gold. Token-versus-spot divergence is therefore the earliest public signal of issuer trouble.

- **On-chain** (revised 29 October 2026, variant C): [`GoldOracle`](../contracts/src/core/GoldOracle.sol) holds the gold reference G in `anchorFeed`, and each token's market feed C in `feeds[token].feed`. Each token has a gold band g (`goldBandPpm`, 2% at launch, governable between 0.5% and 10%) and a liquidation cap m (`liquidationClampPpm`, 2% at launch, 0.5% to 5%; GoldVault refuses a liquidation ratio below 105%), both measured against G and changed only through the 48 hour timelock. Borrowing needs C inside the band and prices at min(C, G), otherwise `Off gold band`. Liquidation, trigger and settlement alike, prices at min(max(C, G), G × (1 + m)): a push of C down values collateral at gold at worst, a push up holds off a liquidation by at most m and a depeg specific to the token is not liquidated while gold holds (the project's accepted trade-off). Reserve swaps need C inside the band and price at max(C, G). With either feed unhealthy every priced path is refused (`No reliable price`) and resumes by itself on the first healthy pair; nothing stands in for a stale feed. The full rule set is [`ORACLE_IMPLEMENTATION_PLAN.md`](ORACLE_IMPLEMENTATION_PLAN.md) section 3. The anchor read passes the same validation as any feed: positive answer, completed round, stamped no later than the block and the staleness clock in section 2. The retired `crossFeedThreshold` (10%), the step deviation circuit breaker, the confirming pool and the liquidation floor no longer exist.

  **No observation duty.** The oracle keeps no record that anyone must refresh. The keeper watches feed health and alerts on a refused price, an invalid feed, C off the gold band and a premium above the cap, and liquidates sized from `quoteTokenPrice` only while both feeds are healthy.
- **Deployment rule**: the anchor is set to Chainlink XAU/USD in the deployment session, before the handover opens minting. Once set it cannot be cleared (`setAnchorFeed` refuses zero, "Anchor required"), and it can never be a feed a token uses as its own market source ("Feed not independent").
- **Off-chain**: monitoring alerts at a far tighter band (1% is the working alert level) so operators see a widening basis days before the on-chain threshold would act. Expect that alert to fire occasionally in a healthy market: read round by round over the 67 days both feeds shared up to 11 November 2026, the gap of C to G had a mean of -0.10% and a median of -0.04%, reached +1.071% once (2 October 2026, 12:30 UTC, PAXG 4,221.32 against XAU 4,176.59) and -0.93% once (9 November 2026), stayed above 0.84% for seconds only and never passed 2%; the weekend maximum was 0.836%. The 0.84% maximum quoted in [`ORACLE_MANIPULATION_MODEL.md`](ORACLE_MANIPULATION_MODEL.md) and in `contracts/.env.mainnet.example` is a 60 day sample at 30 minute steps, so the two do not conflict. These figures were not measured again for this document.
- The XAU/USD feed is the gold reference G in every priced read and is monitored as such. It is the protocol's reference for what gold is worth independent of any issuer.

## 5. Eligible collateral: gold only

Only tokenised gold is eligible as Gold Standard collateral, ever. GSUSD's entire brand promise is that it is backed by gold. Non-gold collateral of any kind, whether ETH, staked ETH, fiat stablecoins or other commodities, would break that promise, change the regulatory analysis in [`TOKEN_POLICY.md`](TOKEN_POLICY.md) and invalidate the anchor cross-check design, which assumes a single underlying. Such proposals are out of scope of this runbook and of the protocol, and are rejected at proposal stage without further analysis.

## 6. Future token onboarding runbook

Every step is a hard go/no-go through the 48 hour timelock. If any step fails, stop; do not proceed to the next.

1. **Eligibility gate.** The token is a tokenised gold product with attested reserves. Token contract read and recorded: decimals from 2 to 18 (enforced by `addCollateralType`), fee-on-transfer behaviour measured, issuer freeze and wipe powers documented in [`THREAT_MODEL.md`](THREAT_MODEL.md). Non-gold tokens stop here (section 5).
2. **Oracle route ratified.** A push AggregatorV3 feed is the preferred route; adapter or stream routes carry the costs in section 3 and need their own evaluation. The oracle itself needs no redeployment: `GoldOracle` is a feed registry and `addFeed` onboards any token. The registry is append-only by design, with no `removeFeed`; delisting happens at the vault layer by setting the debt ceiling to zero, never at the oracle, because removing a feed with live vault debt would brick its liquidations. Honesty note on scope: an adapter contract (a `PythAggregatorV3` instance or a Data Streams wrapper) is new code in the trust perimeter even though the oracle does not change.
3. **Register the feed through the timelock.** Propose `addFeed(token, feed)`, wait the 48 hours, execute. Registration enforces 8 feed decimals on-chain. Then verify before going further: the feed's heartbeat is covered by `stalenessThreshold`, `getValidatedPrice` returns a live price and the token-versus-anchor basis sits well under the alert band in section 4.
4. **`addCollateralType` with conservative parameters.** Minimum ratio no lower than PAXG's launch value and liquidation penalty no higher than PAXG's, proposed only after at least one week of clean feed monitoring.
5. **Ceiling sized by the economic model.** The guarded ramp ($250,000 doubling weekly) and the depth rule of [`BUSINESS_MODEL.md`](BUSINESS_MODEL.md) section 4 are retired. The token's debt ceiling, and PAXG's alongside it, is decided before the batch from a re-run of [`ORACLE_MANIPULATION_MODEL.md`](ORACLE_MANIPULATION_MODEL.md) on the token's own feed data, as [`XAUT_ACTIVATION.md`](XAUT_ACTIVATION.md) section 5 requires for XAUT.
6. **Monitoring live before the activation batch is scheduled.** All of:
   - [ ] Feed staleness alert at heartbeat plus 15 minutes (the keeper's `oracle.feed-late` does this for every token it watches, while the keeper's heartbeat plus margin stays below `stalenessThreshold`; section 2, "The early warning")
   - [ ] Token-versus-XAU/USD basis alert at 1%
   - [ ] Keeper oracle alerts (price refused, feed invalid, off the gold band) wired to on-call
   - [ ] Issuer freeze monitoring on every silo holding the token, against the token's current implementation (PAXG's June 2026 upgrade replaced the earlier interface; read the freeze functions and events from the implementation behind the proxy before building the monitor)
   - [ ] Weekly DEX depth measurement job covering the new token's pools
   - [ ] Reserves dashboard line for the new token, live before any user can mint against it

If the route is never ratified or the monitoring never goes green, the token never onboards. That outcome is acceptable; an unpriced or thinly traded gold token is not collateral, it is risk.
