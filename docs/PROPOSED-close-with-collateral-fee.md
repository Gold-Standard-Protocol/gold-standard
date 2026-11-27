# Proposed: closing a vault by paying the stability fee in gold

**Status: design only. Not implemented, not scheduled.** No contract in
`contracts/src` implements this. It is written up so it is on record as a planned
change rather than arriving as a surprise diff.

---

## 1. The problem

A borrower who mints GSUSD and holds it can never repay their own position in full.

`totalSupply == aggregate principal debt` is a core invariant (section 5 of the
[specification](./SPECIFICATION.md)). The stability fee makes a vault's debt grow, but
**no GSUSD is minted for that growth**. So a vault owing `D = P + F` has only ever put
`P` into circulation, and `F` must be sourced from some other borrower's GSUSD.

System-wide this is unavoidable: aggregate fee-inclusive debt always exceeds aggregate
supply by the accrued fees, so it is arithmetically impossible for every borrower to
close at once. This is a property of every interest-bearing CDP, MakerDAO included, and
is not a defect.

For an individual borrower it is nonetheless a hard wall. Observed on Sepolia
2026-08-29: a position of 40,003 principal owed 40,005.08 while the borrower held
exactly 40,003. The shortfall was **2.08 GSUSD, 0.0052% of the debt**, and there was no
action available in the protocol to clear it.

Note that **minting more does not help**, a point worth stating because it is the first
thing people try: minting `M` raises the balance to `B + M` and the debt to `D + M`,
leaving the gap `D − B` exactly unchanged.

## 2. The proposal

Let the borrower pay the *fee* portion in collateral, keeping the *principal* payable
only in GSUSD.

The asymmetry is the whole idea. Principal **must** be destroyed in GSUSD, or
`totalSupply == debt` breaks. The fee carries no such requirement: it is revenue, and
`SurplusBuffer` already accepts collateral through `depositCollateral()` for liquidation
penalties. Nothing new is needed to hold it.

```
closeWithCollateralFee():
  D = stabilityModule.getCurrentDebt(msg.sender, colId)   // P + F
  P = vault.debtAmount                                    // principal
  F = D - P                                               // accrued fee

  require(gsusd.balanceOf(msg.sender) >= P)

  1. pull P GSUSD from the borrower and burn it
     -> principal retired, vault.debtAmount = 0
  2. value F at the oracle price, add closeFeeBps, seize that much collateral
     -> surplusBuffer.depositCollateral(token, seized)
  3. return the remaining collateral, clear the vault
```

## 3. Why the invariants survive

**`totalSupply == aggregate principal debt`.** Supply falls by exactly `P` (burned in
step 1) and aggregate principal debt falls by exactly `P` (step 1). No other step touches
either quantity. The identity is preserved by construction, and more simply than in
`repay()`, which has to split a payment pro rata.

**No buffer liquidity is required.** An earlier sketch had the `SurplusBuffer` *lend* the
shortfall in GSUSD, secured by collateral. That version is strictly worse: it needs the
buffer to already hold GSUSD, which fails at genesis (the buffer starts empty and only
fills on the first repayment — a chicken-and-egg the first closer cannot escape), and it
routes buffer funds through a user-triggered path. Paying the fee in gold avoids both.

**No new minting.** The protocol never creates GSUSD it is not owed.

**Collateral conservation.** Seized collateral moves vault → buffer through the existing
`depositCollateral` path, which is already covered by the collateral-conservation
invariant.

## 4. Risks, in the order they should be considered

**4.1 It puts the oracle on the close path.** Today closing a vault requires no price at
all: `repay()` never reads the oracle. Valuing seized collateral makes the exit
price-dependent, which is a genuine widening of the attack surface. A stale or
manipulated price lets a borrower discharge a fee with too little gold. Mitigation:
`getValidatedPrice` only, reverting on staleness rather than falling back to
`lastKnownPrice`, and refuse while the oracle circuit breaker is tripped. The fallback
that is acceptable for a *preview* is not acceptable for a *settlement*.

**4.2 A gold-denominated buffer is worth least when it is needed most.** The surplus
buffer is the first-loss reserve against bad debt, and its liabilities are
GSUSD-denominated. Filling it with PAXG means it shrinks in dollar terms in precisely the
scenario that creates bad debt — a sharp fall in the gold price. This is the most
important objection and it is not about this function's correctness but about the
buffer's composition. Mitigation: a governance cap on the share of the buffer that may be
held as collateral rather than GSUSD, plus a policy of periodically selling seized gold
for GSUSD. See section 5 of [BUSINESS_MODEL](./BUSINESS_MODEL.md).

**4.3 It only helps a borrower who still holds the principal.** If the GSUSD has been
spent, they must still buy `P` back. This is not a limitation to engineer around — the
principal has to be destroyed — but it does bound how much of the problem this solves.

**4.4 Griefing and cheap-swap risk.** If `closeFeeBps` is below the spread available
elsewhere, the function becomes a discounted way to convert gold into debt relief.
Mitigation: `F` is naturally tiny relative to `P`, but the implementation should bound
the collateral seizable in one call as a fraction of the position, so this can never be
used as a general-purpose swap against the protocol.

**4.5 New external function.** It touches collateral, the buffer
and debt in one call. It needs the same treatment every other exit path got: adversarial
tests, and a Foundry invariant that closes positions this way under live fees.

## 5. Revenue

Honest sizing: `closeFeeBps` applies to `F`, which is accrued fees, not principal. At a
2% stability rate a year-old position carries roughly 2% of principal in fees, so a
100 bps convenience fee earns about **2 bps of principal**, once, and only from borrowers
who choose this path over buying GSUSD.

This is a **UX wall being removed, not a revenue line**, and it should not be presented
as one in any forecast. Its value is that "I cannot close my position" stops being a
reachable state for a borrower who still holds what they minted.

## 6. If this is built

- `closeFeeBps` ships at zero and is governance-settable, hard-capped, matching the
  pattern already used for `originationFeeBps`.
- Hardhat tests: the happy path; refusal when the borrower holds less than `P`; refusal
  on a stale oracle; refusal when the buffer's collateral share cap would be exceeded;
  access control.
- A Foundry invariant closing positions through this path under live fees, asserting
  `totalSupply == aggregate principal debt` throughout — extending
  `FeeConservation.invariant.t.sol` rather than starting a new suite.
- `verify-deployment` gates `closeFeeBps == 0` on mainnet, as it does for the
  origination fee.

## 7. The alternative that needs no code

At mainnet launch, a GSUSD market makes a 2 GSUSD shortfall trivially buyable, and the
wall largely disappears on its own. The constraint identified in
[LIQUIDITY](./LIQUIDITY.md) is the same constraint here: this problem is most acute
exactly when the protocol is smallest and least liquid, which is also when adding an
oracle-dependent path to the close flow is least advisable.

That argues for shipping without it, watching whether borrowers actually hit the wall,
and building it only if they do.
