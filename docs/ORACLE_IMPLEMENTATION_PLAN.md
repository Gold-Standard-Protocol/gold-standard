# Oracle plan: PAXG-first mainnet

**Status**: approved direction, 28 October 2026 (PAXG-first; XAUT registered but inactive; Pyth out of the
production path). Final rule set 29 October 2026, on the project's decisions: two Chainlink sources per token
(PAXG/USD and XAU/USD) and nothing else, liquidation by variant C of
[`ORACLE_MANIPULATION_MODEL.md`](ORACLE_MANIPULATION_MODEL.md) section 15.8 and no debt ceiling or
per-block mint cap at launch (`LAUNCH_CAPS=open`, the only mainnet profile). Sections 3 and 4 are the
specification the contract follows. No mainnet deployment until every launch blocker in section 6 is closed.

## 1. Sources (per token; PAXG at launch)

| Symbol | Source | Notes |
|---|---|---|
| C | Chainlink PAXG/USD `0x9944D86CEB9160aF5C5feB251FD671923323f8C3` (`feeds[token].feed`) | the token's market price |
| G | Chainlink XAU/USD `0x214eD9Da11D2fbe465a6fc601a91E62EbEc1a0D6` (`anchorFeed`) | the gold reference, shared by every token and never a token's own feed |

Each is **healthy** when its read passes the validated read: a positive answer from a complete round, stamped
no later than the block and younger than 90,000 s. There is no third source and no time based override.

## 2. Why the rules changed

The 28 October direction added a second market source for PAXG: a TWAP over the Uniswap v3 PAXG/WETH pool
(P), confirming any move of C outside the gold band, with an agreement band between them. The model then
showed the pool could be emptied, forged or outlasted cheaply, so each fix added state: a breach record that
had to persist for an hour (`observeBand`), a liquidation floor descending below the band and then a depth
record bounding that floor, all fed by permissionless observations a keeper had to make every few minutes.
That design was built and then replaced on 29 October 2026, for three reasons:

- **Gold already corroborates a gold-wide move.** XAU/USD (0.3% deviation trigger) moves with PAXG in a gold
  crash and is out of an attacker's practical reach. The pool only ever mattered for a move specific to
  PAXG.
- **Every pool fix created a new route or a new duty.** A missed observation restarted the depth record, a
  forged reading could still pass the agreement band, and liquidation correctness came to depend on a
  keeper's cadence.
- **Variant C closes the manipulation routes without a third source** (model section 15.8, point 1). Valuing
  collateral at min(max(C, G), G × (1 + m)) means a push of C down can value collateral at gold at worst
  and a push up holds off a liquidation by at most m. The price paid is that a depeg specific to PAXG is
  never liquidated; the project accepts it and GSUSD holders carry it.

`UniswapV3TwapFeed` stays in the repository for research only, under `contracts/research/` and outside `contracts/src`, outside every deployment and preflight path.

## 3. Pricing rules

Revised 29 October 2026 on the project's decisions: two Chainlink sources per token and nothing else in the
production path, and liquidation by variant C of [`ORACLE_MANIPULATION_MODEL.md`](ORACLE_MANIPULATION_MODEL.md)
section 15.8. C is the token's market feed (`feeds[token].feed`, Chainlink PAXG/USD) and G is Chainlink
XAU/USD (`anchorFeed`). The pool source P, the agreement band, `observeBand`, the breach record, the
descending floor, the depth record and `quoteLiquidationFloor` are gone, with their governance proposals.
There is no time based override of any kind, no call the keeper must make and no debt ceiling.

A source is **healthy** when its read passes the validated read: a positive answer from a complete round,
stamped no later than the block and younger than `stalenessThreshold` (90,000 s). Two per-token widths are
measured against G, never against the larger price:

| Parameter | Default | Bounds | Role |
|---|---|---|---|
| gold band g (`goldBandPpm`) | 2% | 0.5% to 10%, `setGoldBand`, `GoldGovernance.proposeGoldBandUpdate` | gates borrowing and reserve swaps |
| liquidation cap m (`liquidationClampPpm`) | 2% | 0.5% to 5%, `setLiquidationClamp`, `GoldGovernance.proposeLiquidationClampUpdate` | how far above gold liquidation may value collateral |

A price x is inside the band when G × (1 − g) ≤ x ≤ G × (1 + g), both edges rounded down. Both widths change
only through the 48 hour timelock; nothing adjusts them in response to monitoring or on a routine. The
preflight also requires m below the headroom the liquidation ratio leaves above par (10% at 110%), so a vault
under water at gold is always liquidatable however far C is pushed up.

**Borrowing** (`getBorrowPrice`, `quoteBorrowPrice`: mint and indebted withdrawal).

| State | Price | Refusal |
|---|---|---|
| C and G healthy, C inside g | min(C, G) | |
| C and G healthy, C outside g | refused | `Off gold band` |
| C or G unhealthy | refused | `No reliable price` |

**Liquidation** (`getTokenPrice` and `quoteTokenPrice`; the vault reads one price for both the trigger and
the settlement, and the emergency path uses the same rule while paused).

| State | Price | Why |
|---|---|---|
| C and G healthy | min(max(C, G), G × (1 + m)) | a push of C down values collateral at gold at worst, never below; a push up gains at most m; a gold-wide fall is followed at once |
| C or G unhealthy | refused, `No reliable price` | nothing stands in for either feed, so no liquidation is ever priced on a stale or gold only valuation |

Liquidation resumes by itself on the first healthy pair: no call, role or keeper step is needed. Repayment
and collateral deposits never read a price and stay open throughout. The G stale clamp of the earlier draft
was dropped with the C stale fallback: no concrete need for it was found (a gold outage stops borrowing and
the reserve already, and pricing seizures on a stale gold answer is exactly what the rule avoids), and
refusing on either feed keeps the rule symmetric.

**Reserve swaps** (`getReservePrice`, `quoteReservePrice`, used by `GoldStabilityReserve.swapGsusdForGold`
and `quoteGoldOut`, never the liquidation price).

| State | Price | Refusal |
|---|---|---|
| C and G healthy, C inside g | max(C, G) | |
| C and G healthy, C outside g | refused | `Off gold band` |
| C or G unhealthy | refused | `No reliable price` |

Reserve gold is never sold below gold or below the market, and a depeg specific to the token stops its
swaps. `quoteGoldOut` answers (0, 0) wherever the swap would revert.

**Reserve coverage** (`quoteValuationPrice`, read by `GoldStabilityReserve.reserveValueUsd`): min(C, G)
while both are healthy, inside the band or not, so gold is never valued above either and a depegged token is
valued at its market price, never at the liquidation price (which may sit at gold or above it). A token whose
C or G is unhealthy is left out (valued at zero), never valued at `lastKnownPrice`: nothing current bounds
that price, and leaving it out can only raise the swap spread, never lower it. The view works while paused
and while frozen; a frozen token is skipped by the reserve.

**Emergency price** (`getEmergencyPrice`, only while the vault or the oracle is paused). The liquidation rule
and nothing else: whenever the rule refuses (C or G unhealthy) it reverts `No price`. The earlier fallback to
the higher of `lastKnownPrice` and a valid C is gone, so a pause never liquidates on a stale record, a stale C
or gold alone. A frozen token is refused (`Token frozen`) in every case, a pause included, so a pause never
lifts the guardian's freeze.

**Records.** Every successful state-changing read writes `lastKnownPrice`, the liquidation price the same
reading gives (a borrow or reserve read included). It feeds the vault's views and the registry's hints and
never prices a seizure. Nothing else is stored.

**Trigger and settlement.** The liquidation price is one internal rule (`_settlement`). A separate trigger
rule can be added later as a sibling over the same reading without touching it. A vault that read both
prices in one call would grow by 5 bytes, measured.

**Kept.** Per-token isolation, the guardian's per-token freeze as a manual emergency stop (guardian or
governance only, no permissionless trip; it stops emergency liquidation too, during a pause as
well, and lapses after 14 days unless extended), `guardianUnfreezeToken(token, epoch)` (naming the freeze by `freezeEpoch(token)`) and the resyncs (each needs a
liquidation read to succeed), the global pause with `unpauseExpired`, the emergency liquidation path, the
anchor independence checks (`setAnchorFeed` refuses any token's feed and, once set, cannot be cleared) and
dormant XAUT on an `InactiveFeed` that answers no price. `UniswapV3TwapFeed` and `PythMarketFeed` stay in the
repository for research, outside every deployment and preflight path.

**The trade-offs.**

- **A depeg specific to the token is not liquidated** while gold holds: liquidation values the token at gold.
  The project accepts this; borrowing and the reserve stop while the token is off the band, and a gold-wide
  fall still liquidates at once.
- **A push of C up** can hold off a liquidation by at most m.
- **A Chainlink outage**, of either feed, stops every priced path for the token until both answer again.

## 4. Launch caps and parameters

**No ceiling at launch.** The mainnet profile is `LAUNCH_CAPS=open`: no PAXG debt ceiling, no per-block mint
cap, PAXG only, XAUT dormant on an `InactiveFeed`. It is the only mainnet profile: the preflight and
`deploy.ts` refuse `LAUNCH_CAPS=backstop` on mainnet, because its maximum (`PAXG_BACKSTOP_MAX`, 5,000,000
GSUSD) was derived under the retired pool design.

**Parameters.** g = 2% (`PAXG_GOLD_BAND_PPM`), m = 2% (`PAXG_LIQUIDATION_CLAMP_PPM`), staleness 90,000 s. The
preflight parses both with the oracle's own bounds and the headroom check, `deploy.ts` sets each only when it
differs from the oracle's default and `verify-deployment.ts` reads both back against the snapshot. The
retired variables `PAXG_CONFIRM_FEED`, `XAUT_CONFIRM_FEED`, `PAXG_AGREEMENT_BAND_PPM` and `MARKET_FEEDS` are
refused rather than ignored, and the market feed step (`scripts/deploy-market-feeds.ts`) has left the
ceremony. The preflight and `deploy.ts` fail any configured feed that is a Pyth or Uniswap TWAP adapter.

## 5. XAUT: registered, inactive

The oracle's constructor keeps an XAUT entry (its address is an immutable) on a dormant `InactiveFeed` that
answers no price. XAUT is not a vault collateral type, not a reserve asset and not a stability pool token;
the preflight and the fork rehearsal prove nothing can use it. Activation needs only a market push feed for
XAUT (a Chainlink-style XAUT/USD AggregatorV3 feed, which does not exist on Ethereum today) priced by the same
rule against the same XAU/USD reference; no pool, TWAP or observation store is involved. It is one governance
batch through the timelock against the deployed contracts (`setXautFeed`, `initCollateral`,
`addCollateralType`, `addCollateralToken`, `setAssetConfig`), once the criteria in
[`XAUT_ACTIVATION.md`](XAUT_ACTIVATION.md) are met. No GSUSD redeployment and no migration of PAXG positions.
Pyth stays in the repository, outside the deployment path.

## 6. Launch blockers

The list is as it was written on 29 October 2026. Under each item is where it stood on
23 November 2026, from the code and the launch documents. An item marked open is tracked in
[`MAINNET.md`](MAINNET.md).

1. The economic model's open points for variant C (model section 15.8) are closed: the G outage case is re-run with
   liquidation refused (15.8 modelled the earlier clamp on a stale gold price, which the contract dropped),
   the stability pool seeding and liquidator capacity at the intended debt are decided against point 3, the
   timelocked feed replacement that ends a permanent outage is confirmed in the final contracts and the
   residual risks of point 5 are stated to users before launch.

   Status, part by part. **Open**: the G outage case has not been re-run with liquidation
   refused; the model's figures for it still describe the clamp that was dropped
   ([`ORACLE_MANIPULATION_MODEL.md`](ORACLE_MANIPULATION_MODEL.md), the note at the head of
   section 15). **Closed**: liquidator capacity is decided as the keeper's 1,100 GSUSD float,
   one minimum-debt vault whole and partial liquidation from twice the minimum debt
   (project decision, 2026-11-26, replacing the 2,500 GSUSD of 2026-11-15; `MAINNET.md` section 1 and
   section 4.7); the feed replacement exists in the contracts as `GoldOracle.setFeed` and
   `setAnchorFeed`, scheduled through `GoldGovernance.proposeOracleFeedUpdate`
   (`SPECIFICATION.md` section 3.9); the risks are stated on the dapp's Security page
   (a depeg specific to PAXG, an oracle outage, a tail-event depeg) and in
   `THREAT_MODEL.md`.
2. The oracle rework and the dormant-XAUT launch configuration, with full regression suites.

   Status: **closed**. The contracts implement section 3 (`SPECIFICATION.md` section 3.9), the
   open profile deploys XAUT on an `InactiveFeed` with no collateral type, and the Hardhat and
   Foundry suites cover both (`test/OracleClamp.test.ts`, `test-foundry/OracleClamp.t.sol`).
3. Mainnet-fork rehearsal with the real feeds: borrowing, repayment, full and partial liquidation, a rapid
   gold crash, a stale C, a stale G, C pushed off the band in both directions, buffer solvency, governance and
   guardian.

   Status: **open**. The rehearsal passed on 8 and 11 November 2026, but the contract source
   changed afterwards, so a run on the release commit is owed before the ceremony
   (`MAINNET.md` section 2).
4. Carried over: RPC key rotation, the dependency advisory check, Sepolia
   redeployment, Etherscan verification, stability pool and reserve seeding. (The reserve floor
   decision is resolved: the floor is automatic.)

   Status, part by part. **Closed**: the dependency advisory check runs as
   `tools/audit-gate.mjs` and the `npm-audit` workflow; Sepolia was redeployed on
   26 November 2026 (`contracts/deployments/sepolia.json`). **Open until done on mainnet**: the
   RPC key rotation (`MAINNET.md` section 1), Etherscan verification (a launch-day step,
   `MAINNET.md` step 3.5) and the seeding of the reserve and of the liquidation float
   (`MAINNET.md` section 5; the reserve seed is decided at 0.05 PAXG).
