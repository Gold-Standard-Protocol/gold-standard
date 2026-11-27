# peg-sim

Agent-based stress model for the GSUSD peg under the Gold Stability Reserve
architecture (`docs/PEG_ARCHITECTURE.md`). Its purpose is to produce the parameter
table the project approves before any Phase 1 Solidity is written.

## Run

```
npx nx test peg-sim        # mechanics vs contract values; identity on every scenario; incident replay
npx nx grid peg-sim        # full grid → libs/peg-sim/out/{summary.md, results.json, <scenario>.csv}
```

Deterministic: the same seeds produce the same files. Cite results as
`scenario, seed`.

## What it reproduces exactly

`src/lib/mechanics.ts` mirrors the contracts in bigint: collateral ratio and
`type(uint256).max` sentinel, `_annualToPerSecond` and `_rpow` compounding (checked
against on-chain measurements), liquidation seizure and the 60/40 penalty split, and
the GSR quotes. `mechanics.spec.ts` pins each to a measured figure.

Seizures are `GoldVault._sizeSeizure` itself (`sizeSeizure`),
with parity vectors from the Foundry liquidation sizing tests: the full penalty while it
fits; below 100% plus the penalty a pro rata partial, or all the gold for all the debt;
underwater only a full liquidation, repaying the gold's value less
`underwaterDiscountPpm` (2%) but never less than twice the gold's value minus the debt.
The model used to scale the debt down whenever the penalty did not fit, which booked
thin but solvent vaults as bad debt.

`src/lib/identity.ts` asserts, after every simulated day,

```
totalSupply == Σ borrowerPrincipal
supply == holders + borrowersHeld + pool + gsrInventory + insurance
```

The first is the conservation identity the Foundry suite already proves — the reserve
never mints, so it needs no term; the second catches any flow that moved GSUSD
without a balance update.

## What it approximates

- One GSUSD/USDC constant-product pool for price discovery; LPs withdraw a slice per
  day below a comfort price.
- Borrowers mint in proportion to demand while the price is worth it, sell a share,
  and repay when the discount beats their carry — with a propensity, never an
  obligation.
- Holders sell with a base propensity that rises as the price falls.
- Arbitrageurs close the gap to the GSR quote when it beats their round-trip cost.
- Liquidators buy GSUSD to liquidate, which is why a gold crash lifts the price.
- Gold follows a seeded random walk with scenario shocks; the oracle can lag it.

Every behavioural parameter is in `DEFAULT_PARAMS` (`run.ts`) and is a modelling
assumption, not a protocol parameter. The protocol parameters under test are the
`RunOptions`: spread curve, daily cap, minimum reserve, issuance cap, haircut.

## Reading `out/summary.md`

The coverage table is the first decision: at what reserve depth does a 12% sell-off
recover, and how fast. The `NO-RESERVE-*` rows are the control: what the peg does with
no floor at all.

## Leverage loopers

```
npx nx grid peg-sim --loopers   # looper scenarios and paired baselines → out/loopers.{md,json}; RESULTS.md is not touched
```

`src/lib/loopers.ts` adds borrowers who loop: mint GSUSD to a target ratio, sell it
for PAXG through the reserve's below-peg leg or the pool (then PAXG off-model at a
0.30% cost), deposit and repeat. They route to whichever venue pays more PAXG at the
margin, never mint what they cannot swap within a 1.5% cost limit (GSUSD a venue
refuses after the mint is repaid at once), never sell into a pool that pays more than
par for GSUSD, top up when gold lifts their ratio 5% above target and do nothing when
it falls. The par cap matters: without it, loopers in the buildup runs sold into the
repay buy-back highs described below, bought up to a third more PAXG per GSUSD than par
allows and fed a cycle that printed six figure highs and emptied the reserve, none of
which a market with open minting would allow. The scenarios are in `LOOPER_SCENARIOS`,
outside the committed grid. Each is compared with
`pairedBaseline(s)`: the same scenario, the same gold path (`independentGoldPath`)
and no loopers. They also set `proRataLiquidationFill`, which seizes collateral for
the debt a liquidator actually repaid and, as GoldVault does, refuses a partial of an
underwater vault, so a liquidator who cannot buy the whole discounted repayment leaves
that vault alone; the committed grid keeps its original fill.

Read the looper tables with three limits of the base model in mind. Liquidators buy
GSUSD only from the constant-product pool and stop above $1.03, and there is no
stability pool, so liquidation throughput is low and debt below 110% piles up. The
intraday low is not sampled after the base borrowers' daily mint, and repay buy-backs
print highs near $2 even in `calm-at-peg` and far higher in the buildup runs (the High
column shows them). Once the reserve is empty, the holder model collapses the price as
the `NO-RESERVE-*` rows do, harsher than history in magnitude.
