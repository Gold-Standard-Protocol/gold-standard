# Gold Standard Business Model

**Status**: adopted 9 June 2026. Pre-launch. Every figure in this document is illustrative arithmetic from stated assumptions, not a forecast. The protocol has zero users and zero revenue today.

This document records how the protocol earns, what it costs to run and the policies that govern the money. The companion document [`TOKEN_POLICY.md`](TOKEN_POLICY.md) records the protocol token decision.

---

## 1. Revenue levers

All four levers are live in code and route to [`SurplusBuffer`](../contracts/src/core/SurplusBuffer.sol). There are deliberately no fees on burn, deposit or withdraw. Minting carries the 5 bps origination fee described below: small enough to keep minting close to free, and the only charge banked the moment a loan opens.

| Lever | Mechanism | Default | Bounds | Code |
|---|---|---|---|---|
| Stability fee | Per-second compounding interest on vault debt, collected pro rata on repay | 2% APR (PAXG and XAUT) | Cap 50% | [`StabilityModule.sol`](../contracts/src/core/StabilityModule.sol), collection in [`GoldVault.sol`](../contracts/src/core/GoldVault.sol) `repay()` |
| Stability Reserve spread | Spread on GSUSD swapped for protocol-owned gold at the oracle price, stepping up as reserve coverage falls; revenue on both legs once the Phase 2 recycling leg exists ([`PEG_ARCHITECTURE.md`](PEG_ARCHITECTURE.md) section 12; not built). Swap proceeds (the GSUSD the reserve takes in) are NOT revenue and are excluded from the TGE run-rate. Reserve gold is protocol TVL. | 0.5% at 10% coverage and above, 0.75% at 5%, 1.25% at 2% and 2% below that (`deploy.ts`) | 0.5% to 5% constants (`MIN_SPREAD_PPM`, `MAX_SPREAD_PPM`); the curve within them is governance-set | [`GoldStabilityReserve.sol`](../contracts/src/core/GoldStabilityReserve.sol) `swapGsusdForGold()`, routed to `SurplusBuffer.depositFee()` |
| Liquidation penalty | Protocol share of the penalty on direct liquidations, paid in gold. Of that share, 40% goes on to the Stability Reserve (`reservePenaltyShareBps`) and the rest goes to the SurplusBuffer, also as gold | 5% penalty; 60% of it to the liquidator and 40% to the protocol | Penalty cap 20% | [`GoldVault.sol`](../contracts/src/core/GoldVault.sol) `_routeSurplus()` |
| Origination fee | One-off charge on the amount drawn, taken from what the borrower receives while they owe the full amount | **5 bps at launch** | Hard cap 100 bps | [`GoldVault.sol`](../contracts/src/core/GoldVault.sol) `mint()`, `setOriginationFeeBps()` |

Material honesty notes:

- Revenue accrues on **GSUSD debt, not TVL**. Borrowers against gold are conservative; the planning assumption is a 200% average collateral ratio, so debt is roughly half of TVL.
- The stability fee is the workhorse and should be modelled as roughly 90% of revenue at maturity.
- Pool-path liquidations (`liquidateViaPool()`) pay a keeper bounty and route the remaining seized collateral to StabilityPool depositors, not the protocol. Gold realises roughly 15% annualised volatility. Treat liquidation revenue as noise, not a planning line.
- The reserve spread fires when GSUSD trades below peg. It is peg-defence revenue, episodic by design, and it is only the spread: the GSUSD the reserve receives is held as inventory, never counted in `totalFeesReceived`, so it cannot inflate the run-rate that gates the [`TOKEN_POLICY.md`](TOKEN_POLICY.md) triggers.
- Stability fees are collected on repay, so cash receipts lag accrual. Year-one cashflow will be lumpier than accrual arithmetic suggests.

A fourth lever now exists on-chain: an **origination fee** of up to 100 bps charged at mint, in [`GoldVault.sol`](../contracts/src/core/GoldVault.sol) `setOriginationFeeBps()`. It ships at **5 bps** (project decision, 2 November 2026): small enough that a borrower barely notices it, and it banks revenue on every mint, including from borrowers who never come back to repay. Governance may move it anywhere from 0 to 100 bps through the timelock, so it can be waived if adoption needs it. It is the only charge realised in full at t=0 rather than on the borrower's return, which is what makes it worth having; the 100 bps ceiling is a peg constraint, not a fairness one, because a mint fee `f` raises the arbitrage-free ceiling on GSUSD to `1/(1-f)`, and 100 bps already puts that at $1.0101. At 5 bps the ceiling is about $1.0005.

A fifth lever is often cited and should be **discounted to zero for planning**: a 10 to 25 bps interface fee on 0x swaps. The 0x integration was a single tRPC `quote` procedure that **no part of the dApp called**, had no API key configured, hardcoded mainnet, and carried a dependency chain with open, unfixable advisories. It was removed on 2026-09-14. Turning aggregator swaps into revenue means building a swap surface, threading the aggregator's fee parameters through a validator, and agreeing affiliate terms. It is a product to build, not a switch to flip.

A sixth lever is **designed but deliberately not built**: a convenience fee for closing a
vault by paying the accrued stability fee in gold rather than GSUSD, written up in
[PROPOSED-close-with-collateral-fee](./PROPOSED-close-with-collateral-fee.md). It applies
to accrued fees rather than principal, so at a 2% stability rate a 100 bps convenience fee
earns roughly 2 bps of principal, once, from a subset of borrowers. It is a UX wall being
removed, **not a revenue line**, and it is excluded from every figure below.

## 2. Illustrative arithmetic

Assumptions: 200% average collateral ratio, 2% stability fee, 30% of supply swapped through the reserve annually at a 0.6% average spread (reserve depth permitting), liquidation revenue treated as negligible.

| TVL | Debt | Stability fee | Reserve spread | Total per year | Take rate |
|---|---|---|---|---|---|
| $10M | $5M | $100,000 | $9,000 | ~$109,000 | ~1.1% of TVL |
| $50M | $25M | $500,000 | $45,000 | ~$545,000 | ~1.1% of TVL |
| $250M | $125M | $2,500,000 | $225,000 | ~$2,725,000 | ~1.1% of TVL |

The total is the two columns added: 2% of debt plus 0.18% of debt (30% of supply at 0.6%), 2.18% of debt or 1.09% of TVL. The origination fee is left out: it is charged once per mint, 5 bps of the amount drawn ($2,500 on $5M), not a yearly rate. Sensitivity at $50M TVL: an aggressive case (180% average ratio, 3% fee) yields roughly $883,000; a defensive case (250% ratio, 1.5% fee) roughly $336,000.

The $250M tier is an upside scenario, not a plan input. It would represent a meaningful share of the entire tokenised gold market and far exceeds current on-chain gold liquidity (section 4).

Pricing power exists: 2% is below MakerDAO's historical 5 to 8% on volatile collateral and the gold CDP niche has no competing lender. Once demand is proven, governance can evaluate 3 to 4% against observed elasticity. The reserve floor disciplines how high the fee can go before swaps against the reserve punish the peg.

## 3. Cost side and the self-funding threshold

Realistic year-one costs: legal across the US, EU and UK plus a foundation jurisdiction, keeper and monitoring infrastructure (Tenderly, PagerDuty, RPC), security work and a minimal team. Plausible total: **$400,000 to $700,000**.

At a take rate of roughly 1.1% of TVL, the protocol covers the low end of that cost base at roughly $37M TVL, its middle at roughly **$50M TVL** and its high end at roughly $64M. Gold Standard is therefore a runway business for 18 to 24 months regardless of execution quality. The runway must come from the project's own capital or a conventional raise. It must not come from selling a pre-revenue fee-sharing token; see [`TOKEN_POLICY.md`](TOKEN_POLICY.md) for why that is the one funding route this project rules out.

## 4. Binding constraint: on-chain gold liquidity

Verified June 2026: the largest PAXG pool on Ethereum mainnet held roughly $1.6M (PAXG/USDT, Uniswap v4) and the PAXG/XAUT pool roughly $3.6M. Combined on-chain depth for both gold tokens is single-digit millions against a tokenised gold market capitalisation of roughly $6B.

Liquidity constrains how much collateral liquidators can sell. The previous guarded-ramp policy was:

> **Debt ceilings must never exceed 10 to 20% of measured PAXG/XAUT DEX depth.** Measure depth weekly during the guarded ramp. Raising a ceiling requires the measurement, not the calendar.

That ceiling policy was replaced by the variant C decision of 29 October 2026. The current mainnet profile is PAXG-first with `LAUNCH_CAPS=open`: no PAXG debt ceiling and no per-block mint cap, while XAUT is inactive. There are no scheduled ceiling raises. The accepted liquidity and solvency risks are recorded in [`ORACLE_IMPLEMENTATION_PLAN.md`](ORACLE_IMPLEMENTATION_PLAN.md) section 4 and [`ORACLE_MANIPULATION_MODEL.md`](ORACLE_MANIPULATION_MODEL.md) section 15.8; the old depth rule above is historical, not an enforced launch limit.

The StabilityPool path softens the constraint because pool liquidations absorb collateral without market selling. This makes a funded StabilityPool, and the deposit interface for it, launch-critical infrastructure rather than an optional feature.

## 5. Treasury policy: buffer before everything

The SurplusBuffer is the only first-loss reserve against the protocol's most severe disclosed risk: issuer freeze of silo collateral (Paxos and Tether hold contract-level freeze and wipe powers) converting directly to bad debt. The buffer starts at zero.

Policy:

1. **100% of protocol revenue is retained in the SurplusBuffer** until it holds at least **2% of outstanding GSUSD supply**.
2. The floor is enforced on-chain and follows supply by itself, with no routine governance. [`SurplusBuffer.sol`](../contracts/src/core/SurplusBuffer.sol) refuses any `withdrawGsusd` that would leave less than `effectiveMinGsusdReserve()`: 2% (the constant `AUTO_FLOOR_BPS = 200`) of the larger of the live GSUSD supply and the token's one day smoothed supply (`GoldStablecoin.smoothedSupplyNow`), rounded up. A mint raises the floor at once; a burn lowers it only as it ages over a day, so nobody, governance included, can repay debt for a moment to shrink the floor and withdraw more. The rate is a constant, so no proposal through the 48 hour timelock can lower it. `minGsusdReserve` remains as an optional higher governed minimum (0 at deploy), set with [`scripts/set-min-reserve.ts`](../contracts/scripts/set-min-reserve.ts) only if a fixed sum above 2% is ever wanted; it can never take the floor below 2%. Bad debt absorption is not bound by the floor: the whole balance is first-loss capital. `verify-deployment.ts` asserts on every run that the contract enforces the floor.

   Project decision, 2 November 2026: the floor is 2%, down from 3%. At a 2% stability fee the floor equals about a year of fee income rather than about eighteen months, so cost recovery can begin sooner. The trade is a thinner first loss reserve: an issuer freeze of a single vault holding more than 2% of all GSUSD debt would exceed the floor. Concentration matters more than the rate, so watch the largest vaults' share of debt and use `minGsusdReserve` to hold a higher fixed sum while a few borrowers dominate.
3. Only revenue above the floor is ever paid out to anyone, for any purpose. The FeeSplitter, if it is ever activated, applies the same floor: it splits nothing until the buffer holds the higher of its own `bufferFloor` and the buffer's effective floor. Penalty collateral held in the buffer has its own per-token `minCollateralReserve`; the automatic floor is GSUSD only, because gold may need to leave the buffer to be sold into GSUSD for the reserve. Distribution to token holders, if it ever happens, is governed by [`TOKEN_POLICY.md`](TOKEN_POLICY.md).
4. Operating costs (RPC endpoints, hosting, monitoring, keeper gas) may be recovered from that revenue by a governance withdrawal through the 48 hour timelock to the operations Safe. This is cost recovery, not the fee switch, which stays off. The path is [`scripts/withdraw-surplus.ts`](../contracts/scripts/withdraw-surplus.ts) and it refuses any amount that would breach the floor. It also refuses a recipient that is the deployer or the proposer, executor or guardian Safe recorded in the deployment snapshot, with or without `WITHDRAW_TO_EOA=YES`: protocol revenue does not sit in a governance Safe or with the deployer key.

   Plan for no withdrawal in the first year. The floor is 2% of supply, about a year of stability fee at the launch rate, and that fee reaches the buffer only when a borrower repays. The 5 bps origination fee banks one fortieth of the floor on the supply it mints, so it can never open headroom by itself. In the 11 November 2026 fork rehearsal (scenario 16) the buffer held 527 GSUSD against a 20,800 GSUSD floor with nothing withdrawable; two years of accrual and a 698,500 GSUSD repayment opened 20,538.07 GSUSD. Until banked fees pass the floor, operating costs are paid from outside the protocol.

## 6. Growth model

- **PAXG-first launch** per [`LAUNCH.md`](LAUNCH.md): the open profile has no PAXG ceiling or routine ceiling votes; XAUT stays inactive until its onboarding requirements are met. Section 4 records the change from the previous guarded-ramp policy.
- **Protocol-owned liquidity**: seed a modest GSUSD/USDC pool from the project's own capital early. A stablecoin nobody can swap has no users. This is the single most important growth expenditure.
- **Transparency as marketing**: the live on-chain reserves page is the credibility centrepiece. Publish real numbers weekly (TVL, debt, buffer balance, parameter changes) and nothing else. Pre-launch, the dashboard says pre-launch.
- **The one step-change lever**: a Paxos relationship. Gold Standard is organic demand for PAXG ounces; a co-marketing or integration arrangement is the only identified realistic route past $100M TVL. Tether Gold is the equivalent conversation on the XAUT side once the oracle question is resolved.
- **Honest year-one base case**: $5M to $30M TVL, roughly $55,000 to $330,000 annualised revenue. A sustainable small protocol if costs stay lean. Anything better requires the distribution step-change.

## 7. What must be true

Four conditions, tracked and reported against honestly:

1. PAXG and XAUT holders demonstrably want USD liquidity against their gold at roughly 2% APR. Testable within six months of mainnet at near-zero marketing cost. The empty niche is evidence in both directions until tested.
2. On-chain gold liquidity supports liquidation demand. The open launch profile does not automatically cap borrowing when liquidity is thin; this remains an accepted solvency risk.
3. The project secures roughly $500,000 to $1,000,000 of runway from capital that is not a token sale.
4. The launch gates in [`LAUNCH.md`](LAUNCH.md) complete in full: the legal item (counsel's terms included), the Safes and the Sepolia soak.
