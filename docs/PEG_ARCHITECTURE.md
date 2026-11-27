# GSUSD Peg Architecture: the Gold Stability Reserve

**Status: Phase 1 implemented (2026-08-29).** `GoldStabilityReserve` is built, tested
(Hardhat, Foundry invariants, Slither) and wired through deploy, verify, hooks and the
dapp; the vault-targeting redemption path is deleted. The parameters shipped are the
`libs/peg-sim` recommendations in §13. `LIQUIDITY.md`, `SPECIFICATION.md` and
`BUSINESS_MODEL.md` now describe the reserve directly. Phase 2 (above-peg leg) and
Phase 3 (global settlement) remain design-only; see §12. Where this document and the
contract differ, `contracts/src/core/GoldStabilityReserve.sol` and
[SPECIFICATION](./SPECIFICATION.md) §3.8 describe what is deployed.

---

## 1. What GSUSD is

> **GSUSD is an overcollateralised dollar backed by tokenised gold. It is created only
> when a borrower locks more gold than the dollars they issue. Gold/USD risk stays with
> those borrowers, enforced by their collateral ratio and by liquidation. The protocol
> maintains the peg; it does not itself take a position against gold.**
>
> GSUSD holders can convert GSUSD into protocol-owned PAXG/XAUT through the Gold
> Stability Reserve, up to available reserve capacity, without affecting any
> borrower's vault.

That is the whole product in two sentences, and every design choice below follows
from the first one: **who bears the gold/USD risk on each GSUSD is the borrower who
issued it.** The protocol must never quietly become the junior equity holder for
GSUSD. This rules out the reserve acting as an issuer (§4), and it is why the
reserve holds assets but owes nothing.

## 1a. The incident

On 2026-08-29, during Sepolia testing, a second account redeemed 10,000 GSUSD for PAXG.
The protocol drew the gold from the vault with the lowest collateral ratio, a borrower's
vault: 15.0 → 12.5125 PAXG, 40,003 → 30,053 GSUSD of debt, ratio 150% →
166.5%. Accounting was exact and the owner lost no value. The owner's reaction is
nonetheless the reaction any borrower would have, and it became the product rule:

> A borrower who deposits 15 PAXG owns a vault containing 15 PAXG until they change it
> themselves or the position becomes liquidatable. **No peg operation by a third party
> may alter any borrower's collateral, debt, ratio or vault state.**

Three findings from the analysis that followed bind the design:

1. **Redemption cannot simply be removed.** It is the only mechanism that lets a
   *non-borrower* convert GSUSD into gold. Without one, "GSUSD at $0.90 is cheap gold"
   is true only for a borrower closing their own vault; a holder is *selling* gold cheap
   to a borrower. Every overcollateralised stablecoin that launched without a
   third-party conversion channel traded 1–5% below peg for months (SAI H1 2019, GHO
   Jul 2023–Feb 2024, sUSD 2019–20 and 2025, MIM 2022) until one was added. No
   counterexample at scale was found.
2. **A DEX pool is a venue, not a floor.** Third-party LPs withdraw first in every
   depeg (UST Curve 4pool, May 2022; USDC 3pool, March 2023). Protocol-owned
   GSUSD/PAXG liquidity *is* a protocol gold reserve, with AMM pricing instead of an
   oracle, no cap, no fee floor and continuous MEV bleed. It is the reserve below with
   every protection removed.
3. **The existing vault-targeting mechanism was also unsafe as built.** Target
   selection was client-side and unvalidated on-chain; `redeem()` could be aimed at
   any vault with enough debt.

## 2. Five layers, five jobs

Each layer does one thing. What it is *not* responsible for matters as much.

| Layer | Job | Not its job |
|---|---|---|
| **DEX liquidity** | Everyday price discovery; routing GSUSD ↔ USDC/ETH/gold | Defending the peg. It has no price at which it must buy. |
| **Gold Stability Reserve (GSR)** | The below-peg floor: GSUSD → protocol-owned gold at a quoted price, to the depth of the reserve. The protocol is the counterparty. Recycling GSUSD it already holds for incoming gold is Phase 2 and not built; it **never mints**. | Absorbing bad debt (its gold is never insurance). Issuing GSUSD (it is not an issuer and owes nothing). |
| **Borrowers** | Create GSUSD, and bear gold/USD risk on every unit they create. Above peg they are the supply response: lock gold, mint, sell into the premium. Below peg they contract supply by buying their own debt back at a discount. | Being a guaranteed floor. A borrower is never obliged to repay today. |
| **Liquidation + insurance** | Solvency. Vaults below 110% are liquidated; the `SurplusBuffer` absorbs any shortfall. | Exit liquidity. **Borrower vaults provide solvency, never a redemption source.** |
| **Global settlement** | Catastrophic wind-down: pro-rata claims on pooled system collateral after an emergency shutdown. Phase 3. | Normal redemption. It should almost never execute. |

The retired architecture asked one mechanism (vault redemption) to do the second and
fourth jobs at once. Separating them was the whole change. The two functions never
blur: **borrowers create GSUSD; the GSR protects GSUSD.**

## 3. The Gold Stability Reserve

The GSR is a protocol-owned pool of PAXG, XAUT and GSUSD held **solely for peg
operations**, in its own contract, strictly separate from the insurance buffer. Users
swap with it at an oracle-derived price minus a spread. No vault is involved on any
path. At launch PAXG is its only asset: XAUT becomes one only through the governance
batch in [XAUT_ACTIVATION](./XAUT_ACTIVATION.md).

### 3.1 Below peg: GSUSD → gold

`swapGsusdForGold(token, gsusdIn, minGoldOut)` pays out
`gsusdIn × (1 − spread) / oraclePrice` of `token`. The oracle price is
`GoldOracle.getReservePrice`: the higher of the token's market feed and XAU/USD, served
only while both feeds are healthy and the market feed sits within the gold band (2%);
otherwise the swap is refused and resumes by itself when the feeds pass again.

Worked example. GSUSD trades at $0.97; the spread is 0.5%.

```
Buy 100,000 GSUSD on a DEX          −$97,000
Swap with the GSR                   +$99,500 of PAXG at the oracle price
Profit                               $2,500
```

Arbitrageurs buy GSUSD until the market price reaches the GSR quote. The floor is
`$1 × (1 − spread)`. **No borrower's position moves.** This is the force a DEX alone
cannot create: a quote from a counterparty that must honour it while it holds gold
above its minimum reserve and within its daily caps (§3.3).

### 3.2 Above peg: borrowers first, then inventory recycling

Above peg the primary supply response is **borrowers**, not the reserve. At $1.03 a
gold holder locks $130 of PAXG, mints 100 GSUSD, sells it for $103, and keeps the gold
exposure they wanted anyway. That is about 2.3% on the $130 locked, before the origination fee, on capital they were
holding regardless, so it is arbitraged. It costs more capital than a 1:1 swap would,
and the honest consequence is that GSUSD may sit at $1.005–$1.015 for longer during a
demand spike. That trade is taken deliberately: a stablecoin modestly above peg because
new supply requires collateral is far less dangerous than a protocol taking a hidden
leveraged gold position to tighten the ceiling.

This leg is Phase 2 and is not built: `GoldStabilityReserve` has no `swapGoldForGsusd`,
so today the reserve sells gold for GSUSD only. The design follows.

The reserve adds a second, bounded response. `swapGoldForGsusd(token, goldIn,
minGsusdOut)` releases **GSUSD the GSR already holds** — accumulated on the below-peg
leg — for incoming gold at `goldIn × oraclePrice × (1 − spread)`. When inventory is
exhausted the function refuses. **It never mints.** Over a full cycle (buy GSUSD cheap
with gold, sell it dear for gold) the reserve ends with more gold than it started,
which is how it grows organically without ever creating a liability.

Worked example. GSUSD trades at $1.02; the GSR holds 10m GSUSD from earlier dips.

```
Bring $10,000,000 of PAXG to the GSR
Receive 9,980,000 GSUSD (existing inventory, no mint)
Sell on a DEX                       +$10,179,600
Profit                                  $179,600
```

This leg is a design sketch and is not built. The 0.2% haircut in the example predates the
reserve's spread bounds (0.5% to 5%, `MIN_SPREAD_PPM` and `MAX_SPREAD_PPM`), and no haircut
has been set for it. At the 0.5% minimum the same trade would receive 9,950,000 GSUSD, sell
for $10,149,000 and earn $149,000.

**Reserve issuance is not a phase.** Letting the GSR mint would make the protocol the
party bearing gold/USD risk on that GSUSD (§4). It is not built, not scheduled, and
would require its own junior capital and a governance architecture change before it
could be enabled.

### 3.3 Depth

The GSR does not create an infinitely deep floor. With $1bn of GSUSD and $100m of
redeemable reserve gold, there is $100m of immediate conversion capacity; once it is
exhausted the guaranteed swap stops until the reserve refills. The correct claim,
everywhere it is made:

> GSUSD converts to protocol-owned gold at the Stability Reserve's quoted price, up to
> available reserve capacity.

Never: "every GSUSD is instantly redeemable for gold."

## 4. Accounting identities

The invariant does not change. With the reserve holding assets but issuing nothing:

```
totalSupply == Σ borrowerPrincipal
```

This is exactly the identity the Foundry suite proves today under live fees. GSUSD the
GSR holds is inside `totalSupply` like any other balance and needs no term. Nothing is
generalised, nothing migrates, and every existing proof carries over untouched.

Every flow, stated as the assertion a test checks:

| Flow | Supply | `Σ borrowerPrincipal` | GSR gold | GSR GSUSD inventory |
|---|---|---|---|---|
| Borrower mints `X` | `+X` | `+X` | — | — |
| Borrower repays `X` principal | `−X` (burn) | `−X` | — | — |
| GSUSD → gold, `G` in at spread `s`, price `p` | — | — | `−G(1−s)/p` | `+G(1−s)` (spread `Gs` → insurance) |
| Gold → GSUSD, inventory `H`, quote `O` (Phase 2, not built) | — | — | `+goldIn` | `−min(O, H)`; refuses if `O > H` |
| Liquidation penalty share to GSR | — | — | `+share` | — |
| Seed | — | — | `+amount` | — |

**The GSR has no liabilities.** It cannot be insolvent, only empty. A gold drawdown
shrinks the reserve's dollar value and therefore the floor's depth; it creates no
deficit that anyone must absorb.

### Why the reserve must not issue

The tempting generalisation is `totalSupply == Σ borrowerPrincipal + gsrIssued`, with
GSR-issued GSUSD "covered" by aggregate overcollateralisation. It is not covered.
Consider $900m borrower-issued against $1,300m of borrower gold, plus $100m GSR-issued
against $100m of reserve gold. Gold falls 15%: the reserve holds $85m against $100m of
GSUSD it created. The $400m of excess collateral in borrower vaults **cannot** fill that
$15m — normal operations cannot appropriate healthy borrower collateral, which is the
defining guarantee of this design. Aggregate solvency is a statement; loss absorption
is a mechanism, and there is none. Any `gsrIssued > 0` therefore needs an explicitly
identified junior capital, a loss waterfall, and its own governance. Until
that exists, the reserve issues nothing.

Revenue versus proceeds, which the counters must keep apart:

- The **spread** is revenue. It routes to `SurplusBuffer.depositFee` and counts in
  `totalFeesReceived`.
- **Swap proceeds** (the GSUSD or gold the GSR takes in) are **not** revenue: assets of
  equal value left. They stay in the GSR and never touch `totalFeesReceived`.
  `TOKEN_POLICY.md §3` keys the TGE trigger on annualised fee run-rate; routing proceeds
  through the fee counter would overstate it by roughly 200× per swap.
- The insurance ledger is unchanged:
  `gsusdBalance + totalGsusdWithdrawn + totalBadDebtAbsorbed == totalFeesReceived`.

## 5. State machine

Per asset, the GSR stored state is one of:

```
Active ──guardian or governance──▶ Paused ──governance──▶ Active
```

Transitions and who may cause them:

| From | To | Trigger | Who |
|---|---|---|---|
| Active | Paused | Asset-specific concern (`pauseAsset`, for 14 days; calling it again extends it and takes a new `assetPauseEpoch(token)`) | `GUARDIAN_ROLE` or `GOVERNANCE_ROLE` |
| Paused | Active | Concern resolved (`unpauseAsset(token, epoch)`, with `epoch` from `assetPauseEpoch(token)`) | `GOVERNANCE_ROLE` (timelock) |
| Paused | Active | 14 days after the last `pauseAsset` (`ASSET_PAUSE_DURATION`) | Nobody: it lapses |

There is no separate halted state: stopping the whole GSR means pausing every asset.
An oracle refusal is not a stored state either. Each swap reads
`GoldOracle.getReservePrice`, which reverts while the token's market feed or XAU/USD is
unhealthy (`No reliable price`), while the market feed sits outside the gold band (`Off
gold band`), while the guardian has frozen the token (`Token frozen`) or while the
oracle is paused. Swaps in that token are refused for as long as the condition holds and
resume by themselves when it clears.

The pause matrix, deliberately reason-dependent:

| Event | GSR behaviour |
|---|---|
| `GoldVault` paused (borrowing bug, bad-debt auto-pause) | **Continues.** The GSR never touches the vault. Converting reserve gold to GSUSD during a gold crash *improves* the insurance buffer's ability to absorb GSUSD-denominated bad debt. |
| `GoldOracle` paused | Every swap is refused until the pause is lifted or lapses. |
| Frontend or indexer outage | Continues. The GSR depends on neither. |
| PAXG feed unhealthy, off the gold band or frozen | **PAXG swaps refuse. Any other active asset stays live.** |
| XAU/USD unhealthy | Every swap refuses, because every token is priced against it. |
| GSR accounting fault | Guardian pauses every asset. |

This reuses `GoldOracle`'s per-token pricing rules and per-token freeze; the vault side
already has per-asset gating via `CollateralType.active`.

## 6. Protections

All of these ship in Phase 1. None is optional.

- **Per-asset daily outflow cap** (`dailyCapPpm` of the day-start balance, 20% at
  deploy) and an **aggregate daily outflow cap** in USD (`aggregateDailyCapUsd`, off at
  deploy), both bucketed by UTC day (`block.timestamp / 1 days`).
- **Per-asset minimum reserve** below which the below-peg leg refuses.
- **Utilisation-based spread.** The GSUSD → gold spread is a step function of reserve
  coverage (redeemable value ÷ circulating supply), so gold becomes progressively more
  expensive to remove as defensive inventory becomes scarce. A swap pays the step of the
  coverage it leaves behind, measured against the higher of the live and the one-day
  smoothed circulating supply. Every step lies within the constants `MIN_SPREAD_PPM`
  (0.5%) and `MAX_SPREAD_PPM` (5%); the curve shipped is in SPECIFICATION §6. The
  `RedemptionModule` volume-decay fee was not carried over.
- **Oracle.** Swaps price at `getReservePrice`: the higher of the token's Chainlink
  market feed and XAU/USD, only while both pass the validated read (staleness bound,
  complete round, positive answer) and the market feed sits within the gold band (2%).
  Otherwise the swap in that token is refused and resumes by itself (§5). The guardian's
  per-token freeze stops it too. The **haircut** on the gold → GSUSD recycling leg
  belongs to Phase 2 and is not built.
- **Guardian pause**, per asset, for 14 days and renewable; only governance unpauses early.

**Prerequisite, resolved 2026-09-03.** `GoldOracle.getTokenPrice` reverts whenever the
feed moves more than `deviationThreshold` (10%) from `lastKnownPrice`; previously only
`resyncLastKnownPrice` (`GOVERNANCE_ROLE`, behind the 48h timelock) cleared it, so a
genuine 10% gold move wedged every price-dependent path for two days.
`guardianResyncLastKnownPrice` now lets the guardian clear the wedge without the
timelock, with no discretion over the value: the new anchor must be the current
validated live feed price and must also pass the cross-feed anchor band, so a single
compromised feed cannot be anchored in. `verify-deployment.ts` asserts the function is
present (`ops:oracle.guardianResyncLastKnownPrice-present`). Superseded: `GoldOracle`
no longer has a deviation gate or a cross-feed band, so the wedge cannot occur; see the
Oracle item above and SPECIFICATION §3.9.

## 7. Funding the reserve

In order of expected size at scale:

1. **Above-peg recycling inflows** (Phase 2, not built). Arbitrageurs bring gold whenever GSUSD trades
   above the GSR quote, and the reserve releases GSUSD it accumulated on earlier dips.
   Bounded by that inventory, so this is not unlimited organic growth — but over each
   dip-and-recovery cycle the reserve ends with more gold than it started, from the
   spread on both legs and from having bought GSUSD cheap and sold it dear. The
   protocol buys nothing and issues nothing.
2. **A governed share of liquidation penalties.** `GoldVault._routeSurplus` is the
   single point at which the protocol's share of a penalty is routed;
   `reservePenaltyShareBps` (40% at deploy, governance-set up to 100%) sends that share
   of the protocol's penalty gold to the GSR and the remainder to insurance. If the GSR
   cannot accept the deposit the slice falls through to insurance.
3. **A seed at launch from the operations Safe.** The model was to size it; the project set
   it at 0.05 PAXG on 2026-11-26, replacing the 0.25 PAXG of 2026-11-15 (`MAINNET.md` section 5). 20 PAXG on Sepolia is for testing
   only.

Explicitly excluded by project decision: **an allocation of protocol revenue.** The GSR
does not buy gold with fees.

Any transfer between the GSR and the insurance buffer is a governance action with its
own event. The two balances are never fungible.

## 8. Contract boundaries

| Contract | Change |
|---|---|
| **`GoldStabilityReserve`** (new) | Holds gold + GSUSD inventory. `swapGsusdForGold`; `swapGoldForGsusd` (Phase 2, inventory-only, refuses when empty; not built); `seedCollateral` (permissionless, measured delta, rejects any token that is not a configured asset, which GSUSD can never be); per-asset config, caps, minimum reserve, pause; the views in §10. **Never holds `MINTER_ROLE`.** `verify-deployment` asserts it does not. |
| **`SurplusBuffer`** | Unchanged role: insurance and fee revenue. Gains nothing peg-related. Receives the GSR's spread via the existing `depositFee`. |
| **`RedemptionModule`** | **Retired.** Its base-rate/decay fee logic was not carried over; the GSR's spread is a step function of coverage. |
| **`GoldVault`** | Deleted `redemptionModule`, `setRedemptionModule`, `redeemCollateral`, `RedemptionExecuted`. Added `reservePenaltyShareBps` and the split in `_routeSurplus`. |
| **`GoldGovernance`** | Deleted `proposeRedemptionModuleUpdate`. Added `proposeStabilityReserveUpdate` and `proposeReservePenaltyShare`; other GSR parameters are set through the timelock on the reserve's own `GOVERNANCE_ROLE` setters. |
| **Global settlement** | Phase 3, its own design document. |

After the `GoldVault` deletion, this sentence is true and verifiable:

> The only function on `GoldVault` that reduces a vault's collateral without the
> owner's signature is liquidation, and it is callable only when the vault is below
> `liquidationRatio`.

It is not a governance setting. There is no code path.

## 9. What each surface may claim

Every sentence that asserted a vault-backed redemption floor, with the replacement
that now stands in each document (applied 2026-08-29). This table is a record of that
change; several replacements have been revised since (the reserve sells gold only, so
there is no ceiling leg), and the documents themselves are current.

| Where | Now | Becomes |
|---|---|---|
| `docs/SPECIFICATION.md:21` | "anyone can burn 1 GSUSD for $1 of gold collateral (minus 0.5–5% dynamic fee), enforcing a hard floor near peg" | "anyone can swap GSUSD for protocol-owned gold at the Stability Reserve's quoted price, up to available reserve capacity, creating a floor at $1 minus the spread that is as deep as the reserve" |
| `docs/SPECIFICATION.md:36` | "`RedemptionModule` … Creates hard price floor." | "`GoldStabilityReserve` … Protocol-owned gold and GSUSD inventory for peg swaps in both directions. Floor and ceiling limited by reserve capacity." |
| `docs/LIQUIDITY.md:42` | "**Hard floor, redemption.** If GSUSD trades below $1 minus the redemption fee, anyone can buy it and redeem through the `RedemptionModule`…" | "**Floor, the Stability Reserve.** If GSUSD trades below $1 minus the spread, anyone can buy it and swap with the GSR for protocol-owned gold at the oracle price. The floor holds to the depth of the reserve and no borrower's vault is involved." |
| `docs/LIQUIDITY.md:44` | "floor enforced by redemption arbitrage" | "floor enforced by arbitrage against the Stability Reserve, limited by reserve depth" |
| `docs/LIQUIDITY.md §7` | "PSM: a project decision, deliberately not made here" | Reversed 2026-08-29. The objection was to a **fiat** PSM at a **fixed** fee that would collapse the band to that fee. The GSR is gold, priced at oracle minus a **dynamic** spread, so the §4 band is unchanged and backing stays gold. |
| `docs/THREAT_MODEL.md:28` | "Redeem GSUSD for gold via `RedemptionModule`." | "Swap GSUSD for protocol-owned gold via `GoldStabilityReserve`." Plus: U3 (under-debted vault) deleted; new U6 "drain the reserve at a stale-low oracle"; new residual "floor-absent state when the reserve is empty"; new residual "pressure to let the reserve issue, which would move gold/USD risk onto the protocol with no loss absorber". |
| `docs/BUSINESS_MODEL.md:16` | "Redemption fee … Liquity-style dynamic fee" | "Stability Reserve spread … on both legs, revenue on protocol gold. Swap proceeds are NOT revenue and are excluded from the TGE run-rate. Reserve gold is protocol TVL." |
| `apps/dapp/…/RedeemPage.tsx:22,48` | "This right is what holds the price floor." | "Swaps draw only from the protocol's own gold reserve. No borrower's vault is ever touched. The floor holds to the depth of the reserve, shown live below." |
| `apps/dapp/…/site.ts:133-134` | "Redemption floor / GSUSD is redeemable for gold at the oracle price." | "Stability Reserve / GSUSD converts to protocol-owned gold at the Reserve's quoted price, up to its capacity." |
| `apps/dapp/…/PegPanel.tsx:37-38,64` | "redeemable for one dollar of gold at the oracle price, which sets a hard floor" | "convertible to protocol-owned gold at the Stability Reserve's price. The floor is exactly as deep as the reserve, and the reserve is shown here." |
| `apps/dapp/…/GoldTicker.tsx:42` | "Redeemable for tokenised gold" | "Convertible via the Stability Reserve" |
| Navigation | "Redeem" | "Swap" (or "Stability Swap") |

## 10. Exposed on-chain views

Per asset and in aggregate, so the reserves page and any integrator can verify the
claim in §3.3 block by block:

- gold held (`collateralBalance`); redeemable above the minimum reserve
  (`redeemableCollateral`); USD value of redeemable gold (`reserveValueUsd`)
- GSR value ÷ circulating GSUSD (`coveragePpm`, and `dampedCoveragePpm`, which the
  spread reads)
- outflow per asset and in USD for each UTC day (`dayOutflow`, `dayOutflowUsd`);
  remaining daily capacity per asset (`remainingDailyCapacity`)
- current spread (`currentSpreadPpm`) and the spread a given swap pays (`quoteGoldOut`)
- GSUSD inventory held (`gsusdInventory`, the ceiling on what a Phase 2 recycling leg
  could release)
- pause state per asset (`assetPaused(token)`, lapsing at `assets(token).pausedUntil`)

## 11. Risks, ranked

1. **Stale-low oracle drains the reserve.** The GSR sells gold at the oracle price; if
   the oracle lags a rising market, an arbitrageur buys gold below market for
   `(P_market / P_oracle − 1) − spread`. The reserve is now the *only* thing on the
   other side of that trade. Mitigations: daily caps, minimum reserve, the 0.5% spread
   floor kept at or above the feed's deviation threshold, per-token refusal whenever the
   reserve price is refused (§5). The model
   quantifies the residual under realistic oracle lag.
2. **Floor-absent state.** Reserve empty ⇒ swap refuses ⇒ no floor until refilled. It
   is visible (§10), bounded, and the funding loop in §7 is the answer. It is stated
   in every doc as a limitation, not hidden.
3. **Pressure to let the reserve issue.** A persistent premium makes 1:1 issuance
   look like a cheap fix. It is not a parameter change; it changes who bears gold/USD
   risk on that GSUSD (§4). Mitigation: it is structurally absent (no `MINTER_ROLE`),
   asserted by `verify-deployment`, and enabling it requires its own junior capital
   and governance change.
4. **Revenue-counter contamination.** Proceeds through `depositFee` would overstate
   revenue ~200× and mis-trigger the TGE gate. Separate counters; a Hardhat assertion
   and a Foundry ledger invariant.
5. **Insurance/peg double-counting.** The reason the GSR is a separate contract.
   Governance transfers between them are explicit and evented.
6. **Junk seeds.** `seedCollateral` rejects any token that is not a configured asset, and
   GSUSD can never be configured as one. A token sent by plain transfer is stranded but
   harmless (only configured assets are ever paid out).
7. **The oracle wedge (§6).** Retired: the deviation gate that caused it no longer
   exists.

## 12. Phases

| Phase | Scope | Gate |
|---|---|---|
| **0** | This document; `libs/peg-sim`; parameter table | The project approves the parameters |
| **1** | `GoldStabilityReserve` below-peg leg; caps, minimum reserve, utilisation spread, per-asset pause; `GoldVault` deletions and penalty split; `RedemptionModule` retired; `totalSupply == Σ borrowerPrincipal` proven with the swap in the handler; no swap touches a vault (`vaultTouchedBySwap == 0`); `invariant_reserveHoldsNoMinterRole`; hooks/UI/docs | Full regression suites |
| **2** | Above-peg **recycling** leg: `swapGoldForGsusd` releases inventory only, with haircut; refuses when empty | Model re-run on Phase 1 telemetry |
| — | **Reserve issuance is not a phase.** Would need junior capital, a loss waterfall, and a governance architecture change. | Project decision, if ever |
| **3** | Global settlement | Own design document |

## 13. First model run (2026-08-29)

`libs/peg-sim/RESULTS.md` holds the full grid (5 seeds per scenario, reproducible).
The figures below are from the 2026-11-10 rerun, after the simulator was corrected to run
only the spread tiers the contract accepts (no 0.30% tier; the top tier sits at the 0.5%
floor) and to price each swap at the tier of the coverage it leaves behind, as
`GoldStabilityReserve` does. The conclusions
of the first run stand. The headline, from the coverage sweeps under three run severities:

| Run | Sellers push to | Duration | Smallest coverage that holds |
|---|---|---|---|
| Mild | $0.98 | 10 days | **10%** of supply |
| Base | $0.96 | 20 days | **25%** |
| Severe | $0.93 | 30 days | **25%** |

Three things the sweep says that were not obvious beforehand:

1. **The no-reserve control does what history says.** With no floor, every run ends with
   the peg gone and never recovering within 120 days. The model has no OTC or
   secondary venue, so its collapse is harsher than reality in magnitude; the
   qualitative result — persistent discount, no recovery — is the robust part and
   matches SAI, GHO and sUSD.
2. **The binding constraint is the spread curve × remaining coverage, not raw depth.**
   At 10% coverage the mild run never exhausts and the base run exhausts for 3 days (gold
   out $6.5–10.3m of $10m), yet both still end below peg: after absorbing the run, coverage sits under 5%, the
   utilisation spread steps up to 0.75–1.25%, and arbitrage only restores the price to
   $1 minus that spread, never back to $0.995. At 25%, gold out is similar in dollars
   ($6–13m) but leaves ≥13% coverage, the spread stays at the 0.5% floor, and the close is
   held. **Target coverage and the spread-curve steps must be designed together.**
3. **Beyond the holding level, depth buys nothing.** 50% and 25% produce identical
   gold-out and identical price paths in every sweep; the daily cap, not the reserve,
   becomes the limit. Capital above ~25% is idle for peg purposes.

The Phase 2 rows in the first run modelled reserve *issuance*; the model has since
been changed to inventory-only recycling (the reserve never mints) and re-run, see
`RESULTS.md`. Everything here is conditional on the behavioural assumptions in `DEFAULT_PARAMS`
(dip-buying, panic, borrower idle cash), which are calibrated to the historical record
by direction and order of magnitude, not fitted. The threshold is a starting point for
a project decision, not a parameter to ship.

## 14. Open decisions

Only the model or the project can settle these. Each is a row in the parameter table.
Phase 1 shipped values for the spread curve (utilisation steps, not volume-decay), the
daily caps, the minimum reserve and the penalty split (SPECIFICATION §6); those rows stay
open only for retuning through governance.

| Decision | Settled by |
|---|---|
| Spread curve shape and floor (utilisation, volume-decay, or blend) | Model |
| Daily cap as a percentage of reserve, per asset and aggregate | Model |
| Minimum reserve per asset | Model |
| Haircut on the recycling leg | Model |
| **Whether the reserve may ever issue GSUSD.** Not a parameter. At zero, borrowers bear all gold/USD collateral risk. Above zero, the protocol becomes a direct issuer against a volatile asset and some other party must be the explicit loss absorber. Requires a capital plan, and a governance architecture change, not a proposal. | The project |
| Liquidation-penalty split between insurance and the GSR | Model |
| Launch seed size on mainnet | Model, then the project |
| Whether the 2% stability fee should respond automatically to a GSUSD market price | The project. Needs an on-chain GSUSD price: a crvUSD-style aggregate EMA with a deviation clamp, not a naive v3 TWAP griefable at $100k depth. Threat-model the manipulation cost before any contract reads it. |
| MiCA: an EU-attributed ART issuer must offer a statutory redemption right | Counsel |
| Name of the user-facing feature ("Swap", "Stability Swap", "Convert") | The project |
