# Gold Standard Protocol: System Specification

> Gold Standard Protocol: gold-backed stablecoin protocol. Token: **GSUSD** ("Gold Standard Dollar"). Site: [goldstandard.finance](https://goldstandard.finance).

This is the formal specification of on-chain behaviour for Gold Standard Protocol. It is the source of truth for:

- Anyone reading or verifying the code
- Operators reading the deployment runbook
- Developers writing tests and new modules
- Integrators building on top of GSUSD

Contracts: `contracts/src/core/*.sol`, with the governance wrapper and timelock in `contracts/src/governance/` and the placeholder feed for a dormant token in `contracts/src/oracle/InactiveFeed.sol`. `contracts/src` holds the production contracts (the `FeeSplitter` among them, built but not deployed at launch) and the test mocks under `src/test/`; the Pyth and Uniswap v3 price adapters are research code under `contracts/research/` (with the mocks that import them in `contracts/research/mocks/`), never deployed and never imported by anything in `src` (compiled with Solidity 0.8.38, which every source file declares exactly, and OpenZeppelin 5.6.1).

---

## 1. Overview

GSUSD is an ERC-20 stablecoin minted against over-collateralised deposits of tokenised gold (PAXG, XAUT). At launch PAXG is the only active collateral: XAUT is registered in the oracle and is not a vault collateral, reserve asset or pool token until a governance batch activates it ([XAUT_ACTIVATION](./XAUT_ACTIVATION.md)). Each GSUSD represents protocol-verified gold reserves; the peg is maintained by three forces:

1. **Over-collateralisation + liquidation**: a vault may mint, or withdraw collateral while it owes, only at a collateral-to-debt ratio of 130% or more; a vault that falls below 110% may be liquidated by anyone, at a 5% penalty.
2. **Stability swap**: anyone can swap GSUSD for protocol-owned gold at the Stability Reserve's quoted price, up to available reserve capacity, creating a floor at $1 minus the spread that is as deep as the reserve. No borrower's vault is involved on any peg operation.
3. **Stability fee**: continuous per-second interest on outstanding debt, routing protocol revenue to a surplus buffer that absorbs bad debt.

---

## 2. Contract responsibilities

| Contract | Responsibility |
|---|---|
| `GoldStablecoin` | ERC-20 GSUSD with permit + burn. Only `MINTER_ROLE` (the vault) can mint. Keeps a one-day smoothed supply (`smoothedSupplyNow`), advanced on every mint and burn with the supply that held until then, which the reserve prices its spread against. |
| `GoldOracle` | Registry of Chainlink-compatible feeds (one per collateral token, governance-extendable via `addFeed`), staleness + full-round validation, per-token pricing against the XAU/USD gold reference: borrowing and reserve swaps gated by the gold band, liquidation at min(max(C, G), G × (1 + m)) (section 3.9). Three older reads remain and price nothing in the protocol: `getPaxgPrice`, `getXautPrice` and `getValidatedPrice` return the market feed alone, with no gold band and no reference to XAU/USD, so an integrator must not price with them. |
| `StabilityModule` | Per-second stability fee accrual via MakerDAO-style `_rpow`. Tracks normalised debt so fees accrue lazily without per-user writes. |
| `GoldVault` | CDP core: collateral custody, debt issuance, liquidation (direct + via pool), emergency liquidation during oracle pause. On a direct or an emergency liquidation it routes a governed share of the protocol's liquidation-penalty gold to the stability reserve; a pool liquidation pays the keeper and the pool and nothing to the protocol (§3.5). The only function that reduces a vault's collateral without the owner's signature is liquidation. `minDebt` and `underwaterDiscountPpm` are governed: the smallest vault is sized so its penalty share covers gas, and gold worth less than its debt sells at a small discount so the bad debt is booked. Liquidators are paid straight from the silos. The stability module is fixed at construction and a silo factory holding collateral cannot be repointed. |
| `StabilityPool` | Liquity V1 liquidation buffer — GSUSD depositors absorb debt and earn discounted collateral. Product-sum accounting (P and S) with epoch + scale-factor tracking (P never reaches 0) and collateral gains carried at 18 decimals (the gain per unit staked is rounded down at each absorption and a depositor's gain is rounded down to the token's decimals at each refresh; §8 item 1 gives the bounds). Full-pool-drain absorptions are rejected; near-total drains trigger an epoch reset. No withdrawal and no collateral claim in the block of the caller's latest deposit (a top-up included; the claim rule holds during a pause as well), which rules out the atomic just-in-time capture of a liquidation's gain with borrowed GSUSD. A deposit held across a block boundary is ordinary participation. |
| `SurplusBuffer` | Protocol revenue reservoir: holds stability fees and liquidation penalties; absorbs bad debt by burning GSUSD; keeps at least 2% of outstanding GSUSD supply against governance withdrawals (automatic reserve floor). |
| `GoldStabilityReserve` | Protocol-owned PAXG/XAUT and GSUSD inventory for peg swaps. Pays gold for GSUSD at the oracle's reserve price minus a spread stepped by the coverage the swap leaves behind; holds the GSUSD it receives, never mints and never burns. The floor is limited by reserve capacity. The above-peg recycling leg (Phase 2) is not built. |
| `SiloFactory` / `CollateralSilo` | EIP-1167 proxy shard of collateral across many addresses, raising the cost of issuer-side censorship (Paxos/Tether freeze). The per-silo cap is in 18-decimal ounces and scaled to each token's decimals; a withdrawal rewinds the deposit cursor over the silos it emptied so they are refilled rather than left behind. |
| `VaultRegistry` | On-chain list of open vaults (listed exactly while a vault holds collateral or debt, fed by the vault after every change through a best-effort hook that carries its own gas floor, repairable by anyone with `sync`) and the agent-facing views: `vaultOwners(offset, limit)`, `isLiquidatable`, `liquidatableVaults`, `vaultSummary`, `collateralTypeOf`. `isLiquidatable`, `liquidatableVaults` and the `ratio` and `liquidatable` fields of `vaultSummary` value collateral at the oracle's last recorded price (`lastKnownPrice`), which only a state-changing price read refreshes, so they are hints that can be stale in either direction; a liquidation itself tests the vault at `getTokenPrice`. Holds no funds and no roles. |
| `GoldGovernance` | Wrapper around an `ExpiringTimelockController` (OpenZeppelin's `TimelockController` with a grace period): a 48h delay on parameter changes, and a matured operation can be executed only within 7 days of becoming ready. The guardian Safe can pause instantly, extend a pause, pause a reserve asset, freeze or unfreeze a token's oracle reads and re-record the last-known price (section 4); it cannot unpause. |

---

## 3. Formulas and constants

### 3.1 Unit conventions

- **GSUSD**: 18 decimals. All debt amounts are in 18-dec GSUSD.
- **PAXG**: 18 decimals. **XAUT**: 6 decimals. Vault normalises to 18 dec via `amount * 10**(18 - decimals)`.
- **Chainlink feeds**: 8 decimals, USD-denominated. Enforced whenever a feed is registered or replaced.
- **Ratios** (`minRatio`, `liquidationRatio`, `liquidationPenalty`, `liquidatorIncentiveShare`): 6 decimals. `1_000_000 = 100%`.
- **Stability fee rates**: 18 decimals, stored as per-second multipliers (1e18 = 0% fee).

### 3.2 Collateral valuation

For a vault holding `amount` of collateral token `T` with decimals `d` and oracle price `p` (USD, 8 decimals):

```
collateralValue (18-dec USD) = amount * 10^(18 - d) * p / 10^8
```

### 3.3 Collateralisation ratio

```
ratio = collateralValue * 1_000_000 / currentDebt
```

`currentDebt` includes accrued stability fees: `currentDebt = stabilityModule.getCurrentDebt(user, collateralId)`.

### 3.4 Mint constraints

A `mint(amount)` call requires all of the following and reverts otherwise:

- `ratio(vault.collateral, vault.debt + amount) >= collateralType.minRatio`, with the collateral valued at the borrowing price (§3.9)
- `collateralType.totalDebt + amount <= collateralType.debtCeiling` (the ceiling is `type(uint256).max` under `LAUNCH_CAPS=open`, so it never binds at launch)
- `vault.debt + amount >= minDebt` (governed; see §6)
- when `perBlockMintCap > 0`, the GSUSD minted in the block stays within it (0 under `LAUNCH_CAPS=open`, so the check is off at launch). The count is net: principal an account repays in the block in which it minted is given back to the block's allowance, up to what that account minted in the block, so a mint repaid in its own block uses none of it
- the vault is not paused (`EnforcedPause`), the vault holds collateral (`No collateral`), the oracle gives a borrowing price for the token (§3.9: `Off gold band`, `No reliable price`, `Token frozen`, or the oracle's own pause), the collateral type is initialised in the `StabilityModule`, and the transaction carries the gas the registry hook needs (`Registry gas`)

### 3.5 Liquidation

Trigger: `ratio < liquidationRatio` (default 110%).

```
collateralToSeize (native dec) = debtToRepay * (1 + penalty) * 10^d / (p * 10^10)
debtEquivalentCollateral       = repay * 10^d / (p * 10^10)
totalPenalty                   = collateralToSeize - debtEquivalentCollateral
liquidatorBonus                = totalPenalty * liquidatorIncentiveShare / 1_000_000
protocolShare                  = totalPenalty - liquidatorBonus
liquidatorReceives             = debtEquivalentCollateral + liquidatorBonus
```

`debtToRepay` and `repay` are GSUSD with 18 decimals, `p` is USD with 8 decimals and `d` is the token's decimals, so the divisor carries the same `10^10` as the swap formula of §3.8 (`_sizeSeizure` writes it as `debt * (1e6 + penalty) * 1e8 / (p * 10^(18 - d) * 1e6)`). `repay` equals `debtToRepay` except for an underwater vault, below. Worked example: 4,000 GSUSD repaid at $4,000 with a 5% penalty seizes `4000e18 * 1.05 * 1e18 / (4000e8 * 1e10)` = 1.05e18, 1.05 PAXG.

If the full debt plus penalty no longer fits in the collateral but the collateral still covers the debt, a partial liquidation seizes collateral pro rata to the debt repaid. A full liquidation takes all collateral against all debt; the penalty gives way first. Below 100% collateralisation, only a full liquidation is accepted: repayment is the collateral's value less `underwaterDiscountPpm` (2% at launch), with the discount capped at the actual shortfall. On a direct or an emergency liquidation the discount is split like the penalty, 60% to the liquidator and 40% to the protocol, so a direct liquidator's margin on an underwater vault is at most 1.2% at launch. The remaining principal triggers `_handleBadDebt`.

Principal accounting. A payment that leaves the vault holding collateral retires principal and accrued fee pro rata. A payment short of the debt that takes all the collateral retires principal first:
```
debtToRepay >= currentDebt:                       principalRepaid = vault.debtAmount
all collateral seized, debtToRepay < currentDebt: principalRepaid = min(vault.debtAmount, debtToRepay)
otherwise:                                        principalRepaid = vault.debtAmount * debtToRepay / currentDebt
```
The fee recognised is `debtToRepay - principalRepaid`, banked in the `SurplusBuffer` (§3.7). On the second line it is zero unless the payment exceeds the whole principal, so a liquidation that could not recover a vault's principal recognises no stability fee: nothing reaches the buffer's revenue counter or a fee beneficiary from it, the bad debt booked (§3.6) is exactly the principal the payment did not cover, and the unpaid fee is written off with the vault. When the payment covers the principal but not the whole fee, the fee actually recovered is banked, the rest is forgone and no bad debt is booked. The same rule applies on `liquidate`, `emergencyLiquidate` and `liquidateViaPool`.

Where the penalty goes depends on the path:

- **Direct and emergency liquidation** (`liquidate`, `emergencyLiquidate`): the liquidator receives the debt's worth of collateral plus `liquidatorIncentiveShare` of the penalty (60%), and the protocol receives the rest (40%), routed by `_routeSurplus` (§3.8, Funding).
- **Pool liquidation** (`liquidateViaPool`): the caller receives a keeper bounty of half the liquidator share, `totalPenalty * (liquidatorIncentiveShare / 2) / 1_000_000` (30% of the penalty at launch), and everything else that is seized goes to the stability pool. `_routeSurplus` does not run: the reserve and the surplus buffer receive no penalty gold from this path, and on an underwater vault the whole discount less the bounty goes to the pool's depositors. The vault sends the seized gold from the silos to the pool and then calls `StabilityPool.absorbLiquidationPrefunded`, which credits whatever arrived. `GoldVault.setStabilityPool` therefore accepts only a pool that has granted the vault `VAULT_ROLE`, declares that path (`absorbsPrefunded()` returns true) and answers `getTotalDeposits()`, the figure `liquidateViaPool` reads before it sizes anything; a pool without the declaration is refused when it is wired (`PoolLacksPrefundedAbsorb` when it answers false, a revert without data when it has no such function), and so is a pool that cannot report its deposits (a revert without data), not when the first liquidation reverts. `verify-deployment.ts` reads the same declaration from the wired pool (`wire:stabilityPool.absorbsPrefunded`).
- **A vault address the issuer has frozen**: the protocol's share is pulled from the silos to the vault for routing, after a zero-value transfer of the token from the vault to itself that an issuer freeze refuses. When that probe or the pull fails, the share is paid to the liquidator with the rest and `ProtocolShareCeded` is emitted, so the liquidation settles.

### 3.6 Bad debt socialisation

When `vault.collateralAmount == 0 && vault.debtAmount > 0` post-liquidation:

1. `vault.debtAmount` zeroed; `collateralType.totalDebt -= badDebt`.
2. Normalised debt in `StabilityModule` zeroed exactly with `clearDebt()`.
3. `totalBadDebt += badDebt`.
4. If `surplusBuffer != address(0)`: `surplusBuffer.absorbBadDebt(badDebt)` inside a try/catch. The buffer burns up to `badDebt` of its own GSUSD (capped at `gsusdBalance`) and pays the caller nothing. The vault reads `totalSupply` before and after the call and books the fall, capped at the outstanding `totalBadDebt`: `totalBadDebt -= absorbed`. A buffer that reverts emits `BadDebtAbsorptionFailed` and never reverts the liquidation; `retryBadDebtAbsorption()` (permissionless) re-attempts the same way and reverts `Nothing absorbed` when supply did not fall. A FeeSplitter in front of the buffer passes the call through and forwards nothing.
5. **The bad-debt pause.** If `badDebtPauseThreshold > 0` and, after the buffer's absorption, `totalBadDebt > badDebtPauseThreshold`, the vault pauses itself under a new pause number. The threshold is 25,000 GSUSD at launch (`BAD_DEBT_PAUSE_THRESHOLD`; governance sets it with `setBadDebtPauseThreshold`, and 0 switches the rule off). While the vault is paused `mint`, direct `liquidate` and a withdrawal from a vault with debt stop; `deposit`, `repay`, a withdrawal from a debt-free vault, `emergencyLiquidate` and `liquidateViaPool` continue. The pause lapses after 14 days like any other (§3.9), governance can lift it early with `unpause(epoch)`, and every later bad-debt event that leaves the total over the threshold starts the 14 days again under a new number, whether or not a pause is in force. The buffer starts empty, so early in the protocol's life one underwater vault that leaves more than the threshold unabsorbed stops borrowing for every vault until the pause lapses or is lifted.

### 3.7 Stability fee

Per-second rate for an annual BPS `a`:
```
ratePerSecond = 1e18 + a * 1e18 / (10000 * 31_536_000)
```
(The annual rate is divided evenly over the seconds of a year and then compounded every second, so the realised yearly rate is `(1 + a / (10000 * Y))^Y - 1`, close to `e^r - 1`: 2.0201% for a 2% setting, 0.02 percentage points above nominal and in the protocol's favour, and about 64.9% at the 50% cap (§8 item 2). MakerDAO stores a true per-second root of the annual rate instead, so its realised rate equals the nominal one; only the `_rpow` exponentiation routine is shared with it.)

Accumulator update on any touch:
```
elapsed = block.timestamp - lastAccrualTimestamp
accumulator = accumulator * _rpow(ratePerSecond, elapsed) / 1e18
```

Normalised debt at mint:
```
normDebt += ceil(mintAmount * 1e18 / accumulator)   // round up, favours protocol
```

Normalised debt at repay:
```
normDebt -= floor(repayAmount * 1e18 / accumulator) // round down, favours protocol
```

Current actual debt:
```
currentDebt = normDebt * accumulator / 1e18
```

Bounds: `annualRateBps <= 5000` (50% max).

Settlement. Every payment against a vault (a repayment and all three liquidation paths) burns the principal it retires and banks the rest, the fee, with `SurplusBuffer.depositFee`. With no buffer set the fee is burned, and a buffer whose deposit reverts has the fee burned as well (`FeeRoutingFailed`): a fee that cannot be banked must not stop a repayment or a liquidation. A burned fee leaves supply below aggregate principal debt by that amount (§5).

A `FeeSplitter` installed in front of the buffer (built, not deployed at launch) accrues its beneficiary's share for a later `claimBeneficiary()`, which anyone may call. `setBeneficiary` pays the outgoing beneficiary whatever it has accrued before it switches, with the same counters and event as a claim, so a change of beneficiary can be scheduled while fees are live and never redirects fees already earned.

### 3.8 Stability swap

`GoldStabilityReserve.swapGsusdForGold(token, gsusdIn, minGoldOut)` pays protocol-owned gold for GSUSD at the validated oracle price minus the current spread. The GSUSD received is held by the reserve as inventory. It is never burned: the borrower who created it still owes it, and burning it would break `totalSupply == Σ borrowerPrincipal` (§5). No borrower's vault is read or written on any path through the reserve.

For token `T` with decimals `d`, oracle price `p` (USD, 8 decimals) and spread `s` (ppm):
```
fee     = gsusdIn * s / 1_000_000
net     = gsusdIn - fee
goldOut = net * 10^d / (p * 10^10)
```
Equivalently `goldOut = gsusdIn × (1 − spread) × 10^d / (p × 10^10)`. The call reverts `Swap too small` when `goldOut` rounds to zero and `Slippage` when `goldOut < minGoldOut`. The price is `getReservePrice`, never the liquidation price: max(C, G) while both feeds are healthy and C sits inside the gold band, so a stale feed (`No reliable price`) or a depeg specific to the token (`Off gold band`) reverts the swap rather than pricing it.

**Utilisation spread.** The spread is a step function of reserve coverage, and a swap pays the step of the coverage it leaves behind (`_swapSpreadPpm`):
```
circulatingSupply       = totalSupply - gsusdInventory
dampedCirculatingSupply = max(circulatingSupply, smoothedSupplyNow - gsusdInventory)
coverage (ppm)          = reserveValueUsd * 1_000_000 / circulatingSupply           // coveragePpm, a view
swapCoverage (ppm)      = (reserveValueUsd - gsusdIn) * 1_000_000 / dampedCirculatingSupply
```
`reserveValueUsd` is the USD value of redeemable gold (balance above `minReserve`) across every supported asset that is neither paused nor frozen in the oracle, priced at `quoteValuationPrice`: min(C, G) while both feeds are healthy, and zero (the token left out of coverage) when either is not, never `lastKnownPrice`. `reserveValueUsd - gsusdIn` floors at zero, and coverage is treated as maximal when the supply it divides by is zero. The damped supply forgets a burn over a day or more (the stablecoin's one-day smoothed supply), so repaying debt cannot buy a cheaper step for a swap in the same transaction. The smoothed supply moves toward the live supply linearly and reaches it one day (`SUPPLY_TAU`) after the last mint or burn; every mint or burn in between banks the average where it stands and starts the day again from there, so under steady activity it approaches the live supply geometrically, often slower than the linear path. A burn banks one thing more: at least the supply that stood at the start of the block, `max(smoothedSupplyNow, min(liveSupply, supplyAtStartOfBlock))`. After growth, when the average lags below the live supply, a burn therefore lifts the average at once to the supply the block began with, which is the one move faster than the linear path and only ever upward. It is what stops a repayment being credited against an average that had not caught up (repay, swap at the cheaper step, mint back), and the supply at the start of the block is used, not the live supply, so a mint and repayment inside one block cannot bank the inflated figure. A mint in one block and a repayment in the next does bank it (THREAT_MODEL, the two-block spread grief). Any burn does this, of any size and by any address, a zero-value burn included, so anyone can slow the decay for the price of a transaction. That can only keep the spread at the wider step and the surplus buffer's floor higher for longer after a contraction; it can never narrow the spread or lower the floor sooner; `currentSpreadPpm` is the step for a vanishingly small swap at `dampedCoveragePpm`. Governance sets up to `MAX_SPREAD_STEPS` (8) steps of `(coverageAtLeastPpm, spreadPpm)`, sorted by coverage descending with spreads ascending; the first step whose threshold the coverage meets applies, and `restrictedSpreadPpm` applies below every step. `setSpreadCurve` replaces the whole curve and refuses one whose coverage thresholds do not strictly descend, whose spreads do not ascend or in which any step's spread exceeds the restricted spread. Every spread, including the restricted one, is bounded by the constants `MIN_SPREAD_PPM` (0.5%, never below the feeds' 0.5% deviation triggers) and `MAX_SPREAD_PPM` (5%). Gold therefore becomes progressively more expensive to remove as the defensive inventory thins.

**Spread routing.** `fee` is revenue: the reserve calls `SurplusBuffer.depositFee(fee)`, which counts in `totalFeesReceived`. `totalSpreadPaid` counts it once the buffer has taken it. If no buffer is set or the deposit reverts, the fee is retained as inventory, is not counted in `totalSpreadPaid`, and `FeeRoutingFailed` is emitted; it is never burned. `net` is swap proceeds, not revenue, and never touches the fee counter.

**Capacity, checked before any transfer** (`_enforceCapacity`):

- Per-asset minimum reserve: `collateralBalance[T] - minReserve >= goldOut`, else `Reserve insufficient`. An empty reserve refuses every swap.
- Per-asset daily cap: outflow in the current UTC day (`block.timestamp / 1 days`) may not exceed `dailyCapPpm` of the current balance plus the day's outflow so far, else `Daily cap reached`. That sum is the balance at the start of the day only when nothing else moved: gold that arrives during the day (a seed, penalty gold) raises the day's cap and a governance withdrawal lowers it. The window is a fixed UTC day, so the cap can be used once just before midnight and again just after.
- Aggregate daily cap: when `aggregateDailyCapUsd > 0`, USD outflow across all assets in the current UTC day may not exceed it, else `Aggregate daily cap reached`. `remainingDailyCapacity(token)` honours it too, converted to gold at `quoteReservePrice` and rounded down, so a swap sized from that view never trips the aggregate cap. The view answers 0 whenever a swap in the same block would be refused, with the aggregate cap on or off: an unsupported or paused asset, or no reserve price (token frozen, oracle paused, a feed stale or off its gold band). `quoteGoldOut(token, gsusdIn)` answers `(0, 0)` in the same cases; it applies neither the floor nor the caps.
- Asset gating: `Unsupported token` when the asset is not configured; `Asset paused` while it is paused (`assetPaused(token)`). `GUARDIAN_ROLE` or `GOVERNANCE_ROLE` may pause an asset independently of the other, for `ASSET_PAUSE_DURATION` (14 days): `assets(token).pausedUntil` records when it lapses, calling `pauseAsset` again while paused extends it to 14 days from that call, and nobody needs to act for it to lapse. Only `GOVERNANCE_ROLE` may unpause early, through `unpauseAsset(token, epoch)` with the number read from `assetPauseEpoch(token)` when it is scheduled: every `pauseAsset` call, a renewal included, takes a new number, and an older number reverts `Different pause`.

**Funding.** `seedCollateral(token, amount)` is permissionless and credits the measured delta (fee-on-transfer safe); it rejects unsupported tokens, and GSUSD can never be configured as an asset. `depositCollateral` is `VAULT_ROLE` only and receives the vault's share of liquidation penalties: `GoldVault._routeSurplus` sends `reservePenaltyShareBps` of the protocol's penalty gold (40% at launch; the protocol's own share is 40% of the penalty, a separate figure) to the reserve and the remainder to the `SurplusBuffer` as gold; if the reserve cannot accept the deposit the slice goes to the buffer with the rest rather than blocking the liquidation, and gold the buffer cannot accept stays in the vault's surplus ledger (`surplusCollateral[token]`), which governance can pay out with `GoldVault.withdrawSurplus(token, to, amount)`, with no floor. Only direct and emergency liquidations route a share here; a pool liquidation gives the protocol nothing (§3.5), so the reserve's refill from penalties depends on which path liquidators use. Governance may withdraw gold below the swap floor (`withdrawCollateral`) and GSUSD inventory (`withdrawGsusd`); both are counted in lifetime counters. The reserve never holds `MINTER_ROLE`.

**Not built.** The above-peg recycling leg (gold in, GSUSD out from held inventory only, Phase 2) and global settlement (Phase 3) are not implemented. The reserve issuing GSUSD is not a phase: it would require junior capital, and a governance architecture change. See [PEG_ARCHITECTURE](./PEG_ARCHITECTURE.md).

### 3.9 Oracle pricing rules

The oracle keeps a registry of token feeds (`feeds[token]`), each holding a Chainlink-compatible aggregator plus a per-token `lastKnownPrice` record. Governance registers new tokens through `addFeed(token, feed)` and replaces feeds through `setFeed(token, feed)`; the registry is append-only because removing a token with live vault debt would brick its liquidations, so delisting happens at the vault layer (debt ceiling set to zero), never at the oracle.

Each token has two sources, read without reverting: **C**, its market feed (`feeds[token].feed`; Chainlink PAXG/USD at launch), and **G**, the gold reference (`anchorFeed`, Chainlink XAU/USD), shared by every token and never a token's own feed. A source is healthy when its read passes the validated read: `answer > 0`, a complete round (`updatedAt > 0`, `answeredInRound >= roundId`), stamped no later than the block and younger than `stalenessThreshold` (90,000 s at launch; `setStalenessThreshold` accepts 300 to 90,000 s, and the constructor accepts any value from 1 to 90,000 s, so only the setter enforces the 5 minute minimum; the mainnet preflight refuses a value below the feeds' 24 hour heartbeat); feeds have 8 decimals, enforced at registration. Two per-token widths, both measured against G and changed only through the 48 hour timelock, govern the rules: the gold band g (`goldBandPpm`, default 2%, range 0.5% to 10%) and the liquidation cap m (`liquidationClampPpm`, default 2%, range 0.5% to 5%; GoldVault refuses a liquidation ratio below 105%). The full specification is [ORACLE_IMPLEMENTATION_PLAN](./ORACLE_IMPLEMENTATION_PLAN.md) sections 3 and 4.

1. **Liquidation** (`getTokenPrice`, view `quoteTokenPrice`; the trigger and the settlement are the same read): with C and G healthy, min(max(C, G), G × (1 + m)); with either unhealthy, refused (`No reliable price`) for that token only. A push of C down values collateral at gold at worst, a push of C up holds off a liquidation by at most m and a gold-wide crash is followed at once. A depeg specific to the token is not liquidated while gold holds; the project accepts this and GSUSD holders carry the loss. Liquidation resumes by itself on the first healthy pair, with no call, role or keeper step.
2. **Borrowing** (`getBorrowPrice`, view `quoteBorrowPrice`: mint and indebted withdrawal): C and G healthy and C within the gold band, at min(C, G); outside the band `Off gold band`, with a feed unhealthy `No reliable price`. Over-borrowing would need gold itself pushed up.
3. **Reserve** (`getReservePrice`, view `quoteReservePrice`): the borrowing gate, at max(C, G), so reserve gold is never sold below gold or below the market. Coverage is valued by `quoteValuationPrice`: min(C, G) while both are healthy, inside the band or not, and 0 (the token left out of coverage) when either is unhealthy.
4. **Isolation and stops**: each token's state is its own. The guardian (or governance) may freeze one token (`freezeToken`) as a manual emergency stop, which also stops its emergency liquidation, during a pause as well, and lapses after 14 days unless extended, and lift it (`guardianUnfreezeToken(token, epoch)`, which works while paused) only when a normal liquidation read would succeed; neither sets a price. `epoch` names the freeze being lifted: `freezeEpoch(token)` advances on every `freezeToken` call, an extension included, and an unfreeze naming an earlier freeze reverts `Different freeze`. There is no permissionless breaker and no step deviation gate: corroboration by gold replaces both. `emergencyPause` remains a global pause; while it or the vault's pause holds, `getEmergencyPrice` serves the liquidation price of a token that is not frozen and otherwise reverts `No price` (`Token frozen` for a frozen token, checked first). `lastKnownPrice` is a record for views and hints and never prices a seizure.
5. **Repayment and collateral deposits never read a price**, so they work in every oracle state.

Anchor incident runbook: a stale or invalid anchor stops every priced path of every token, and each resumes by itself once the anchor answers again. The borrowing, liquidation and reserve reads revert `No reliable price`; `getEmergencyPrice` reverts `No price`; `quoteValuationPrice` does not revert and answers 0, which leaves the token out of reserve coverage. A deprecated anchor is replaced through `setAnchorFeed(newFeed)` behind the 48 hour timelock; it can never be cleared on a live deployment (`Anchor required`).

Emergency path: `GUARDIAN_ROLE` (multisig) calls `emergencyPause()` with no timelock. Only `GOVERNANCE_ROLE` (timelock) can unpause early, with `unpause(epoch)` naming the pause it lifts: `pauseEpoch()` as read when the unpause is scheduled. Every pause, every `extendPause` and every bad-debt breaker trip adds one, so an unpause scheduled before the hold was last re-asserted reverts `Different pause`. Every pause on the vault, oracle and stability pool lapses after `MAX_PAUSE_DURATION` (14 days, `ExpiringPausable`): `unpauseExpired()` is permissionless once the window has passed, and a fresh pause restarts it. A reserve asset pause and a token freeze lapse after 14 days as well, with no call at all. While the vault is paused `deposit` and `repay` stay open and `withdraw` succeeds for a vault whose debt is zero (no price is read), so repay-in-full-then-withdraw is always available; a vault with debt reverts `Paused: repay in full to withdraw`.

### 3.10 Silo routing

`SiloFactory.deposit(token, amount)`:

1. Loop while any of `amount` remains: take the current silo (created with CREATE2, salt = `keccak(token, index)`, if it does not exist yet), transfer up to its free capacity under `siloCap` from the vault to it, credit what the silo's balance actually rose by, and advance `currentSiloIndex` when more remains.
2. A silo that is full, that refuses the transfer or that is credited nothing is skipped and the cursor moves on. The transfer is OpenZeppelin's `trySafeTransferFrom`: it counts as refused when the token reverts or returns `false`, and as made when the token returns `true` or returns no value at all (as some older tokens do); either way the leg is credited only with the rise in the silo's balance, and no rise is a refusal. A deposit skips at most 8 silos (`MAX_SKIPS_PER_DEPOSIT`) and reverts `Too many unusable silos` on the ninth; a silo that an earlier deposit filled exactly counts as one skip for the next deposit.
3. After the loop, `totalCollateral[token] += credited`, the measured sum and not `amount`, so a token that takes a fee on transfer is recorded at what arrived. The ledger is therefore written after the external transfers; the function is `nonReentrant` and restricted to `VAULT_ROLE`.

A deposit creates every silo it needs: any silo missing up to the cursor when it starts, and one more each time it fills a silo and moves on (a deposit larger than `siloCap` creates several). In ordinary running none is missing when a deposit starts, so `missingSilos` reads 0 between transactions. After governance moves the cursor forward (`setCurrentSiloIndex(token, index)`, at most 64 a call, forward only, and a floor for the rewind below) it is one per skipped index. `SiloFactory.createSilos(token, count)` creates those silos ahead of the deposit, lowest index first, at most `MAX_CREATE_BATCH` (16) a call and never past the cursor; `missingSilos(token)` reports how many are left. It is permissionless: it creates only what the next deposit would create, at the same deterministic addresses, moves no funds and changes no cursor. It serves only a token the factory already knows, one with at least one silo or a cursor governance has moved: for any other address it reverts `Unknown token` and `missingSilos` reads 0, so a token's first silo is always created by its first deposit. It reverts `Invalid count` outside 1 to 16 and `Nothing to create` when no silo is missing, which includes the case where a deposit or another caller filled the gap first.

`SiloFactory.withdraw(token, to, amount)`:

1. `totalCollateral[token] -= amount` (CEI).
2. LIFO drain most-recent silo first until `remaining == 0`; revert if insufficient.
3. Move the deposit cursor back over silos the withdrawal emptied, never below `minSiloIndex[token]`, the index governance last set with `setCurrentSiloIndex`.

Invariant: `totalCollateral[token] <= Σ silo.balance()`, with equality unless tokens were sent to a silo address directly or an issuer has destroyed a silo's balance (§5). `0.01 oz <= siloCap <= 1000 oz` (`MIN_SILO_CAP`, so the cap never floors to zero for a 6-decimal token).

---

## 4. Access control

| Role | Held by | Powers |
|---|---|---|
| `DEFAULT_ADMIN_ROLE` | Deployer pre-transfer, then timelock | Grant/revoke all roles |
| `GOVERNANCE_ROLE` | Deployer pre-transfer, then timelock | Parameter updates, `unpause(epoch)` and `unpauseAsset(token, epoch)` (the number from `pauseEpoch()` or `assetPauseEpoch(token)`), module rewiring |
| `GUARDIAN_ROLE` (oracle + vault + stability pool + stability reserve) | Guardian multisig | `emergencyPause()` and `extendPause()` on the oracle, vault and stability pool (bypass the timelock, lapse after 14 days unless extended), `pauseAsset(token)` on the reserve (lapses after 14 days unless renewed), `freezeToken`, `guardianUnfreezeToken(token, freezeEpoch(token))` and `guardianResyncLastKnownPrice(token)` (records the price a liquidation read gives now; the record prices nothing) on the oracle; cannot unpause. Every pause, extension, renewal and freeze it makes takes a new number |
| `MINTER_ROLE` (stablecoin) | Vault only; after `lockMinters(vault)` (one-way, admin-only and only while `vault` is the sole minter and the caller the sole admin; the stablecoin is `AccessControlEnumerable`, so both sets can be read) it can never be granted again by any key, the timelock included, though it can still be revoked | Mint GSUSD |
| `VAULT_ROLE` (stability module / surplus buffer / stability pool / stability reserve) | Vault only, plus the stability reserve on the surplus buffer so it can bank the spread. None of these four is locked: the admin of each contract, the timelock, can grant the role to another address after the delay | On the stability module: `recordDebt`, `reduceDebt` and `clearDebt` for any user, which is the debt every vault is liquidated against. On the surplus buffer: `depositFee`, `depositCollateral` and `absorbBadDebt`, which burns the buffer's GSUSD with no floor. On the stability pool: `absorbLiquidationPrefunded`, the pool's only absorb function, which pays the caller the stated debt in GSUSD and credits depositors with whatever collateral arrived since the last absorption, nothing included (the older pull-style `absorbLiquidation` has been removed). On the stability reserve: `depositCollateral` |
| `VAULT_ROLE` (silo factory) | Vault only, **permanent**: `lockVaultRole(vault)` at deployment sets its admin to `LOCKED_ROLE`, so `DEFAULT_ADMIN_ROLE` cannot grant or revoke it afterwards. `LOCKED_ROLE` administers itself from the constructor, so nobody can be granted it, and the lock requires it to have no member | Deposit to and withdraw from silos. The custody guarantee: collateral leaves a silo only through the vault |
| `DEFAULT_ADMIN_ROLE` (silo factory) | Deployer, then the timelock. The factory has no `GOVERNANCE_ROLE`: its admin holds the powers directly | `setSiloCap`, `setCurrentSiloIndex` (forward only, at most 64 a call) and, once at deployment, `lockVaultRole` |
| `GOVERNANCE_ROLE`, `VAULT_ROLE`, `DEFAULT_ADMIN_ROLE` (FeeSplitter; built, not deployed at launch) | Its deployer until `transferGovernance(timelock)`, then the timelock; `VAULT_ROLE` is for the vault and the reserve once it is installed | Governance: `setBufferFloor`, `setBeneficiaryShare`, `setBeneficiary`. Vault role: `depositFee`, `depositCollateral`, `absorbBadDebt` (passed through to the buffer, on which the splitter then holds `VAULT_ROLE`). Whoever administers the splitter can therefore grant itself a path to the buffer's `absorbBadDebt`, so the splitter is handed to the timelock before it is granted anything (`LAUNCH.md`) |
| `PROPOSER_ROLE`, `EXECUTOR_ROLE` (the `GoldGovernance` wrapper and the timelock) | The configured proposer and executor Safes, and on the timelock the wrapper as well; the proposers also hold the timelock's `CANCELLER_ROLE`. The executor is a Safe: the zero address, which lets anyone execute, is refused on mainnet unless `ALLOW_OPEN_EXECUTOR=1` accepts it | Schedule, cancel and execute timelock operations; an operation executes only within 7 days of becoming ready. There are two role lists for one authority. The timelock holds its own `PROPOSER_ROLE` and `EXECUTOR_ROLE`, on which the wrapper is a permanent member. The wrapper holds a second `PROPOSER_ROLE` and `EXECUTOR_ROLE` of its own, granted to the same Safes in its constructor, which gate its `propose*` helpers and `executeProposal`. A Safe removed from the timelock's list alone can still schedule or execute through the wrapper, so a rotation changes both lists in one proposal (`LAUNCH.md`), and `verify-deployment.ts` fails when the two differ |

The handover is irreversible. Eight contracts (stablecoin, oracle, stability module, vault, surplus buffer, stability pool, stability reserve and the governance wrapper) are handed over by `transferGovernance(timelock)`, which grants the timelock and revokes the deployer's `DEFAULT_ADMIN_ROLE` in the same transaction. `SiloFactory` has no such function: its handover is two transactions, `grantRole(DEFAULT_ADMIN_ROLE, timelock)` and then `renounceRole(DEFAULT_ADMIN_ROLE, deployer)`, and both keys are admin between them. `transferGovernance` accepts any address with code and can be called again by the new admin, so a later call through the timelock that named a contract unable to make calls would lose governance of that contract for good.

`transferGovernance` revokes the caller alone, so a role granted to another key before the handover would survive it. `transfer-governance.ts` (before its first transaction and after the handover) and `verify-deployment.ts` therefore take a role census (`scripts/lib/roleCensus.ts`): every role's whole holder set, read with `getRoleMember` on the enumerable stablecoin and silo factory and rebuilt from the `RoleGranted` and `RoleRevoked` logs everywhere, must be exactly the one in the table above, and the deployer must hold nothing else.

---

## 5. Global invariants

These hold at every block boundary (not necessarily mid-transaction) and are exercised by the Foundry invariant suite. Each is written as it really holds: an inequality where a direct token transfer, a holder's own burn or an issuer's action can break the equality, and with its condition where a governance change can step outside it. A monitor should assert the form given here.

**CDP accounting**
- `Σ vault.debtAmount(user) == collateralType.totalDebt` per collateral
- No mint takes `collateralType.totalDebt` above `collateralType.debtCeiling`. The ceiling bounds new mints only: `setDebtCeiling` accepts any value, one below the debt outstanding included (that is how a collateral type is delisted, §3.9), and accrued fees are not part of `totalDebt`. So `totalDebt <= debtCeiling` holds until governance lowers the ceiling below the debt, and from then until the debt is repaid down to it
- No mint, repayment or partial liquidation leaves a vault with `0 < vault.debtAmount < minDebt`. `setMinDebt` does not revisit existing vaults, so after governance raises the minimum a vault may sit below it; such a vault can repay in full, mint up to the minimum or be liquidated in full, but cannot repay in part

**Collateral conservation** (per collateral token)
- `token.balanceOf(vault) + siloFactory.totalCollateral(token) >= Σ vault.collateralAmount + surplusCollateral[token]` (state), with equality unless tokens were sent to the vault directly; such tokens belong to no ledger. With a factory wired the users' gold sits in the silos, not in the vault; `GoldVault.invariant.t.sol` runs with none, so its silo term is zero, and the silo suite below covers the factory side.
- `token.balanceOf(vault) == ghost_deposited − ghost_withdrawn − ghost_liquidatorPayout` (flow)

**GSUSD conservation**
- `stablecoin.totalSupply() == ghost_minted − ghost_burned`
- `stablecoin.totalSupply() <= Σ collateralType.totalDebt + vault.totalBadDebt()` (aggregate PRINCIPAL debt, plus bad debt booked and not yet absorbed), with equality while no holder has burned GSUSD of their own accord and every fee was banked. GSUSD is burnable by its holder (`burn`, `burnFrom`), and a burn outside the vault lowers supply without lowering any debt, as does a fee burned because it could not be banked (§3.7). A liquidation that empties a vault with debt left moves that debt out of `totalDebt` into `totalBadDebt`; the `SurplusBuffer` then burns GSUSD to absorb it, and anything it cannot burn yet stays in `totalBadDebt` until `retryBadDebtAbsorption`. With no bad debt outstanding, no holder burn and every fee banked, the identity is `totalSupply == Σ totalDebt`.

  The second holds **with fees live**, proven by `FeeConservation.invariant.t.sol`, which
  drives a 3% stability fee with a time-advancing handler, fuzzes `originationFeeBps`
  across its whole range, and crashes the gold price to liquidate vaults, including
  vaults whose gold is worth less than their principal, so bad debt is booked and
  absorbed inside the run. Fee GSUSD is banked in the `SurplusBuffer` rather than burned,
  and banked GSUSD is already inside `totalSupply`, so routing it there does not change
  supply; only the burn does, and the burn is exactly the principal retired. Asserting
  `supply == debt + banked` instead is WRONG and fails by exactly the fee, because the
  banked wei is counted twice.

  The suite runs in three states of the fee destination: a working buffer, no buffer, and
  a buffer that refuses every deposit. With no working buffer the vault burns a fee it
  cannot bank (§3.7), so supply sits below `Σ totalDebt + totalBadDebt` by the fees
  forfeited and never above it; the suite asserts that direction there, and in all three
  states that a liquidation which lost principal banks no fee and moves supply against
  `Σ totalDebt + totalBadDebt` by nothing.

**Stability reserve** (`FeeConservation.invariant.t.sol` fuzzes `swapGsusdForGold` alongside mints, repays and fee accrual)
- `stablecoin.totalSupply() == Σ borrowerPrincipal` is unchanged by swaps: the reserve holds the GSUSD it receives inside supply and never burns it, so the identity above holds strictly with the swap in the handler
- `stablecoin.hasRole(MINTER_ROLE, reserve) == false` (`invariant_reserveHoldsNoMinterRole`)
- `token.balanceOf(reserve) >= reserve.collateralBalance(token)` and `gsusd.balanceOf(reserve) >= reserve.gsusdInventory` (`invariant_reserveLedgerBacked`)
- `reserve.totalGsusdReceived == gsusdInventory + totalSpreadPaid + totalGsusdWithdrawn` (`invariant_swapsNeverBurn`), with a working buffer, with none and with one that refuses the deposit. `totalSpreadPaid` counts only the spread the buffer took; a spread it could not take stays in `gsusdInventory` (`FeeRoutingFailed`) and is counted there alone
- No swap changes any vault: the handler hashes every actor's `(token, collateral, debt)` before and after each swap and the suite asserts the touched count is zero
- Anti-vacuity: the run must contain at least one swap, or the floor is untested and the result is not reported green

**Silo accounting**
- `siloFactory.totalCollateral(token) <= Σ silo.balance(token)`, with equality unless tokens were sent to a silo address directly (the addresses are predictable). The inequality fails only if an issuer destroys a silo's balance, which no ledger records (THREAT_MODEL C1)
- Non-current silos each hold `≤ siloCap` from deposits; a direct transfer can put a silo over the cap, and lowering `siloCap` leaves silos filled earlier over the new cap (§8 item 3)
- `predictSiloAddress(token, i) == getSilo(token, i)` for all deployed silos

**Stability pool**
- `pool.totalDeposits >= Σ pool.getEffectiveDeposit(user)`. The difference is rounding dust (every division in the product-sum rounds against the depositor, §7) plus, after an epoch reset, the remainder the reset left: up to one billionth of the pool at that moment stays in `totalDeposits` while every deposit from before the reset reads 0. That GSUSD belongs to nobody, can never be withdrawn, shares in later absorptions and is burned by them over time
- `gsusd.balanceOf(pool) >= pool.totalDeposits`, with equality unless GSUSD was sent to the pool directly
- `1e9 <= pool.P <= 1e18` always (full drain rejected). `P` starts at 1e18
- `P` does not rise within one epoch and scale: an absorption lowers it and a deposit or withdrawal leaves it alone. The stored value does rise at the two boundaries: a scale change multiplies it by 1e9 and adds one to `currentScale`, and an epoch reset sets it back to 1e18, sets `currentScale` to 0 and adds one to `currentEpoch`
- `currentEpoch` never decreases, and within one epoch `currentScale` never decreases
- Σ user collateral gains `<=` total collateral delivered via absorptions, within the rounding of §8 item 1
- No withdrawal and no collateral claim succeeds in the block of the caller's latest deposit (`lastDepositBlock`)

**Oracle invariants** (assumed from Chainlink, enforced by the validated read)
- Price is positive, from a completed round, within staleness threshold, 8 decimals
- With the gold reference set, as the mainnet preflight requires, a liquidation price is never below XAU/USD nor above XAU/USD × (1 + m), and exists only while C and G are both healthy. With no anchor set (the constructor's state, used only in tests) the bands are skipped and the liquidation price is C
- A borrow price never exceeds the liquidation price the same sources give, nor gold
- A frozen token never prices normally, and one token's state never changes another's
- Reads of one token never mutate another token's `lastKnownPrice`

---

## 6. Parameter defaults

| Parameter | Default | Range / bound |
|---|---|---|
| Oracle staleness threshold | 90000 s (25h, matches 24h feed heartbeat + grace) | 300 to 90000 s in `setStalenessThreshold`; the constructor accepts 1 to 90000 s |
| Oracle gold reference (`anchorFeed`) | Unset (bands skipped) | Mainnet XAU/USD `0x214eD9Da11D2fbe465a6fc601a91E62EbEc1a0D6`; required by the mainnet preflight |
| Gold band (`goldBandPpm`, per token) | 2% | 0.5% to 10%, governance-set |
| Liquidation cap (`liquidationClampPpm`, per token) | 2% | 0.5% to 5%, governance-set; GoldVault refuses a liquidation ratio below 105%, so the cap never exceeds the headroom |
| PAXG debt ceiling at launch | Unlimited (`LAUNCH_CAPS=open`, no per-block mint cap) | `LAUNCH_CAPS=open` is the only mainnet profile: the preflight and `deploy.ts` refuse `LAUNCH_CAPS=backstop` on mainnet, because its 5,000,000 GSUSD maximum was derived under the retired pool design |
| PAXG/XAUT min ratio | 130% | `> liquidationRatio` and `<= 1,000%` (`MAX_MIN_RATIO`) |
| PAXG/XAUT liquidation ratio | 110% | `>= 105%` (100% plus the oracle's largest liquidation cap) |
| PAXG/XAUT liquidation penalty | 5% | `<= 20%` |
| Liquidator incentive share | 60% | `<= 100%` |
| XAUT debt ceiling | None: XAUT is not a collateral type at launch | Set by the governance batch that activates it (`XAUT_ACTIVATION.md`) |
| PAXG/XAUT stability fee | 2% APR | `<= 50%` |
| Bad-debt pause threshold (`badDebtPauseThreshold`) | 25,000 GSUSD at launch (`BAD_DEBT_PAUSE_THRESHOLD`); the contract's own default is 0, which is off | `uint256`, governance-set (`setBadDebtPauseThreshold`). Over it, the vault pauses itself (§3.6) |
| `minDebt` | 100 GSUSD contract default; `MIN_DEBT_GSUSD` sets it at deploy (`LAUNCH.md` gives 1,000 for mainnet) | 100 to 10,000 GSUSD, governance-set (`setMinDebt`) |
| Reserve spread curve | ≥15% coverage 0.50%, ≥10% 0.50%, ≥5% 0.75%, ≥2% 1.25%, below 2% 2.00% | Governance-set, at most 8 steps, every step within the constants 0.5% to 5% |
| Reserve per-asset daily cap | 20% of day-start balance | `<= 100%`, governance-set per asset |
| Reserve aggregate daily cap (USD) | 0 (off) at deploy | `uint256`, governance-set |
| Reserve per-asset minimum reserve | 0 at deploy | `uint256`, governance-set per asset |
| Reserve penalty share | 40% of the protocol's penalty gold | `<= 100%`, governance-set |
| Reserve gold at deploy | Empty (no conversion floor until seeded; `verify-deployment` warns when empty against non-zero supply) | `seedCollateral` is permissionless |
| Silo cap | 100 oz | `0.01 oz` to `1000 oz` |
| Origination fee | 5 bps at launch (`ORIGINATION_FEE_BPS`), taken from what a mint delivers while the debt rises by the full amount | `0` to `100` bps (`MAX_ORIGINATION_FEE_BPS`), governance-set; an account marked `originationFeeExempt` pays none. A non-zero fee needs a surplus buffer wired (`Buffer required`), and the buffer cannot be unwired while the fee is non-zero (`Disable origination fee first`), because a fee that could not be banked would be burned and leave supply short of debt |
| Timelock grace period | 7 days (`ExpiringTimelockController.GRACE_PERIOD`) | Constant. A matured operation executes within it or reverts `TimelockOperationExpired` for good and must be scheduled again |
| Governance timelock delay | 48 hours, set at `GoldGovernance` deploy | Any value, zero included, through a timelock call to `updateDelay` that first waits out the delay in force; proposers and executors hold this power over time. The `GoldGovernance` propose helpers schedule at `max(MIN_DELAY, getMinDelay())`, so they keep working if the delay is raised |
| Per-block mint cap | 0 (disabled) under `LAUNCH_CAPS=open`, which refuses any other value | `uint256`, governance-set. The testnet `guarded` profile defaults to 50,000 GSUSD. |
| GSUSD surplus reserve floor | 2% of max(live supply, one day smoothed supply), rounded up (`AUTO_FLOOR_BPS = 200`) | Constant, automatic. `withdrawGsusd` reverts below `effectiveMinGsusdReserve()`; a burn lowers it only as it ages over a day. `absorbBadDebt` is not bound by it. The FeeSplitter splits nothing below it. |
| Governed min GSUSD surplus reserve | 0 | Optional, governance-set (`minGsusdReserve`). Binds only above the automatic floor; can never lower it. |
| Min per-token surplus collateral reserve | 0 (disabled) | Same, per token. |

**Launch profiles** (`contracts/scripts/lib/launchEnv.ts`, see `docs/LAUNCH.md`): `open` is the only profile a mainnet deploy accepts: no PAXG debt ceiling, no per-block mint cap and XAUT registered in the oracle only. `backstop` (PAXG under one ceiling of at most 5,000,000 GSUSD, per-block cap armed) is for forks and local rehearsals and is refused on mainnet. `guarded` is the testnet default: both tokens active, ceilings zero until raised through the timelock. The StabilityPool's epoch/scale accounting keeps `P` above zero, so the stability pool does not need to be disabled for that reason.

---

## 7. Rounding rules

Every division in the contracts rounds down unless the table says otherwise. Most roundings favour the protocol; several favour the user, each by less than one base unit of the quantity rounded. `Math.mulDiv` is used wherever a product is divided, except the collateralisation ratio and the accumulator update, which use plain multiplication and division.

| Where | What is rounded | Direction | Who it favours |
|---|---|---|---|
| `StabilityModule.recordDebt` | normalised debt added on a mint | up | the protocol: the borrower owes at most one unit more |
| `StabilityModule.reduceDebt` | normalised debt removed on a repayment | down | the protocol: at most one unit of debt remains |
| `StabilityModule` accumulator update | `accumulator * rpow / 1e18` | down | the borrower |
| `StabilityModule._rpow` | each squaring and multiplication | to nearest (half up) | neither |
| `StabilityModule.getCurrentDebt` | `normDebt * accumulator / 1e18` | down | the borrower |
| `GoldVault` collateral value and ratio | `amount * 10^(18 - d) * p / 1e8`, then `value * 1e6 / debt` | down | the protocol on a mint or withdrawal (the ratio reads lower); the liquidator on the trigger |
| `GoldVault.mint` | origination fee `amount * bps / 10000` | down | the borrower |
| `GoldVault.repay`, `_applySeizure` | principal retired pro rata, `debtAmount * paid / currentDebt` | down | the protocol: more of the payment counts as fee and more principal remains |
| `GoldVault._sizeSeizure` | collateral seized (full, partial and pro rata) | down | the borrower |
| `GoldVault._sizeSeizure` | underwater repayment, `coverable * (1 - discount)` | down | the liquidator; the difference is booked as bad debt |
| `GoldVault._sizeSeizure` | debt's worth of collateral | down | the protocol: the penalty, the remainder, is larger |
| `GoldVault._liquidateDirect` | liquidator's share of the penalty | down | the protocol, which takes the remainder |
| `GoldVault.liquidateViaPool` | keeper bounty | down | the pool, which takes the remainder |
| `GoldStabilityReserve.swapGsusdForGold` | spread `gsusdIn * spread / 1e6` | down | the swapper |
| `GoldStabilityReserve.swapGsusdForGold` | gold paid out | down | the reserve |
| `GoldStabilityReserve` coverage and caps | coverage ppm, daily cap, remaining capacity | down | the reserve (a wider step, a smaller allowance) |
| `SurplusBuffer.autoMinGsusdReserve` | the 2% floor | up | the protocol |
| `StabilityPool` absorption | gain per unit staked, `received18 * 1e18 / totalDeposits` | down | nobody: the remainder stays in the pool unassigned |
| `StabilityPool` absorption | product factor and new `P` | down | nobody: depositors' compounded deposits read lower and the difference stays in `totalDeposits` |
| `StabilityPool` deposit and gain reads | compounded deposit; gain in 18 decimals, then in the token's decimals | down | nobody: against the depositor |
| `SiloFactory` | silo cap scaled to the token's decimals | down | none (a cap that would round to zero is refused) |

---

---

## 8. Known deviations and limitations

**The conversion floor is exactly as deep as the Stability Reserve.** `swapGsusdForGold`
pays only from gold the protocol already owns, above the per-asset minimum reserve and
within the daily caps. An empty reserve refuses every swap (`Reserve insufficient`), and
GSUSD then has no guaranteed conversion until the reserve refills from the penalties of
direct and emergency liquidations (a pool liquidation pays it nothing, §3.5) or from seeding. The reserve ships empty; `verify-deployment` prints a warning
whenever it is empty against non-zero supply. The state is visible on-chain
(`redeemableCollateral`, `coveragePpm`, `remainingDailyCapacity`) and is stated as a
limitation everywhere the floor is claimed. The matching trade on the upside is accepted
deliberately: new supply requires a borrower to lock collateral, so GSUSD may sit modestly
above peg during a demand spike rather than the protocol taking a leveraged gold position
to tighten the ceiling. See [PEG_ARCHITECTURE](./PEG_ARCHITECTURE.md) §3.

**Six vault setters emit no event of their own.** `setOracle`, `setLiquidatorIncentiveShare`,
`setSurplusBuffer`, `setStabilityPool`, `setSiloFactory` and `setBadDebtPauseThreshold` change
the vault's wiring or a parameter without an event; the vault is close to the code size limit
and the other setters each emit one. All six are `GOVERNANCE_ROLE` only, so after the handover
each call goes through the timelock, which emits `CallScheduled` when the call is queued and
`CallExecuted` when it runs, both with the target and the call data. Watch the timelock's
events for these changes and read the result from the vault's public getters (`oracle`,
`liquidatorIncentiveShare`, `surplusBuffer`, `stabilityPool`, `siloFactory`,
`badDebtPauseThreshold`).

**A borrower holding only what they minted cannot close in full.** The stability fee
grows debt without minting GSUSD for it, so a vault owing `P + F` has only ever put `P`
into circulation and the borrower must source `F` elsewhere. This is inherent to every
interest-bearing CDP and is not scheduled for change; a design that would remove it for
borrowers still holding the principal is written up in
[PROPOSED-close-with-collateral-fee](./PROPOSED-close-with-collateral-fee.md) and is
explicitly **not implemented**.

The origination fee makes the same gap from the first block. A mint of `A` at
`originationFeeBps` raises the debt by `A` but delivers `A x (1 - bps / 10,000)`; the
difference sits in the `SurplusBuffer`, below its automatic 2% floor while supply is small,
so it cannot be withdrawn to close the gap. At launch (5 bps, `minDebt` 1,000 GSUSD) the
first borrower of 10,000 GSUSD holds 9,995 against 10,000 owed. A partial repayment that
leaves less than `minDebt` is refused, so with no other GSUSD in existence they can repay
down to 1,000 GSUSD and no further. The stability fee would open the same gap seconds later. The launch runbook
therefore opens a GSUSD market from a protocol-owned vault before public borrowing, so the
first borrowers can buy what they owe beyond what they minted ([MAINNET](./MAINNET.md)).
That vault's launch mint pays the origination fee like any other, so it is itself short by
its fee and is the last to close; `setOriginationFeeExempt` frees its later mints of the fee.
Across a full wind-down the floor keeps up to 2% of supply in the buffer, and the last
borrowers depend on that market in the same way.

1. **StabilityPool**: implements Liquity V1's product-sum (P, S) **including** epoch + scale-factor tracking, so the product factor `P` is kept in `[1e9, 1e18]` and can never floor to zero, and collateral gains are carried at 18 decimals inside the sums, so the gain per unit staked of a 6-decimal token such as XAUT does not vanish there. Two roundings go against the depositor, and what they drop stays in the pool, assigned to nobody (`test-foundry/PoolSubUnitGainRounding.t.sol`):
   - **At each absorption** the gain per unit staked, `received18 * 1e18 / totalDeposits`, is rounded down and the remainder is not carried to the next absorption. A depositor whose deposit is `D` wei of GSUSD loses less than `D / 1e18` units of the collateral, measured at 18 decimals, per absorption: for a 1,000,000 GSUSD deposit that is under 1,000,000 wei of PAXG (1e-12 PAXG), or under one millionth of a base unit of XAUT. The losses add up over every absorption between two refreshes, so for PAXG the total is not bounded by one base unit; in value it is negligible.
   - **At each refresh** (a deposit, a withdrawal or a successful claim) the depositor's own gain is rounded down to the token's decimals and the part below one base unit is not carried forward: under 1 wei of PAXG or under 0.000001 XAUT per refresh.

   The two together decide an even split. Two depositors of 3 GSUSD each who share 1 XAUT are each credited 0.499999, because the per-unit gain does not divide evenly; two depositors of 1,000 GSUSD each are credited 0.500000 exactly. Full-pool-drain absorptions (`debtToAbsorb >= totalDeposits`) are still rejected outright; a near-total drain (one that would leave less than one billionth of the pool) triggers an epoch reset, after which that remainder stays in `totalDeposits` with no owner (§5). Callers route residual debt through direct `liquidate()` when the pool can't fully cover a liquidation.
2. **Linear per-second fee approximation** (StabilityModule §3.7): the per-second rate `1 + r/Y` compounds to ~`e^(r·t)` (an effective rate above the nominal `r` — e.g. ~64.9% effective at the 50% cap). This is faster-than-linear and protocol-favouring; documented, not a bug. Size the advertised APR accordingly.
3. **Non-current silo overflow**: if governance lowers `siloCap`, previously-filled silos exceed the new cap. The `capRespectedExceptCurrent` invariant accounts for the current silo being partial but not for retroactive cap changes — operator must drain before lowering cap.
4. **Counterparty dependency**: GSUSD's backing is *wrapped* gold (PAXG at launch, XAUT once activated). Paxos or Tether can freeze silo addresses. Silo factory raises the cost (N addresses instead of 1) but does not eliminate it.
5. **MEV exposure**: liquidations and stability swaps are subject to standard front-running. Operator-run keepers should use private mempools (Flashbots Protect, MEV-Share) in production.
