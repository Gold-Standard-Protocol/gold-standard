# Protocol Token Policy

**Status**: adopted 9 June 2026. Binding unless explicitly revised by a documented decision.

**Decision: Gold Standard launches without a token.** A protocol token may exist later. It is something the protocol must earn the right to issue, behind published triggers, not a funding mechanism it leans on at launch.

---

## 1. Why no token at launch

The decision follows from arithmetic, solvency, governance reality and regulation together:

- **Arithmetic.** The honest year-one base case is $5M to $30M TVL producing roughly $55,000 to $330,000 of annual revenue ([`BUSINESS_MODEL.md`](BUSINESS_MODEL.md)). A token capitalising that cashflow at even a generous multiple is a sub-$10M asset. Any emissions programme would dwarf organic fee value. Liquity v1 demonstrated the failure mode: front-loaded LQTY emissions outran thin fee revenue, farmer sell pressure exceeded fee-seeking buy pressure and the token fell more than 95% from peak.
- **Solvency.** Every early unit of revenue is spoken for. The SurplusBuffer is the only first-loss reserve against issuer freeze of collateral and it starts at zero. A token that distributes fees early would pay dividends out of an uncapitalised insurance fund.
- **Governance.** Parameters are controlled by a 2-of-3 multisig behind a 48 hour timelock. A governance token today would be governance theatre, and credible-neutrality claims would not survive contract-level scrutiny.
- **Regulation.** A fee-sharing token is the single largest Howey exposure available to this project, at exactly the moment the project is weakest. Launching without one is simultaneously the cleanest posture under the GENIUS Act, MiCA and the UK financial promotions regime.
- **Cost of deferral: zero.** The contracts contain no token hooks. The swappable `surplusBuffer` address on both fee sources, changeable through the existing 48 hour timelock, is a ready-made slot for a future fee splitter. Nothing needs redeploying to add token economics later.

## 2. The Usage Ledger

From mainnet block one, the protocol operates a **Gold Standard Usage Ledger**: a published, on-chain-verifiable record of time-weighted protocol usage per address.

- Recorded dimensions: GSUSD debt held over time, StabilityPool deposits over time and GSUSD liquidity provision over time.
- Usage is weighted by time alone, by the second: every second a balance is held counts once, and no period or kind of usage counts for more than another.
- The ledger is published by the API as one downloadable file of every address, with a SHA-256 hash that anyone can recompute from on-chain events.
- The ledger is complete by rule: no record is ever deleted.
- The ledger ships with an explicit, permanent disclaimer: **no token exists, no token is promised, the ledger confers no rights and may never confer any**. The disclaimer is part of the terms of service and every page that displays the ledger.
- There is no points marketing, no multiplier campaigns and no implied conversion. This is the only usage-tracking design compatible with the project's honesty rule, and it preserves full retroactive optionality if a token is ever issued.
- Real user incentives come from real yield that already exists in the protocol: StabilityPool depositors earn discounted liquidation collateral by design.

**Revision, 22 November 2026 (documented decision).** This section said "epoch-weighted"; an epoch was never defined, and the ledger has always been weighted by the second, so the opening sentence now says "time-weighted" and three points were added: how usage is weighted, how the ledger is published and that it is complete by rule. Nothing else in this policy changed. The operator sheet is [`USAGE_LEDGER.md`](USAGE_LEDGER.md).

**Clarification, 23 November 2026.** No substance of this policy changed. Three wordings in this section are read as follows. "Complete by rule" means that a record, once opened, is never deleted; the operator sheet states the two tracking minimums below which no record is opened and the caps at which the ledger marks itself incomplete until they are raised. "Terms of service" is, today, the dapp's Terms page, which carries the disclaimer among statements the project already publishes and the conditions on which the software is offered ([`LAUNCH.md`](LAUNCH.md)). "Retroactive optionality" here and "retroactive allocation against the Usage Ledger" in section 4 are constraints on a token design if the section 3 gate ever fires. They are stated in this policy and nowhere else: the ledger records the past and confers no rights, and none of its pages, files or figures says what a figure may lead to.

## 3. Published TGE triggers

A protocol token generation event may be considered only when **all** of the following hold, and the protocol reports against these publicly at every month-12-and-after review whether met or not:

1. TVL at or above **$25M sustained for two consecutive quarters**, with annualised run-rate revenue at or above **$250,000**.
2. SurplusBuffer capitalised at or above **2% of outstanding GSUSD supply**. The contract already refuses any withdrawal below that floor (`SurplusBuffer.effectiveMinGsusdReserve`, enforced automatically); this trigger asks that the buffer actually hold it.
3. **Two independent audits signed off in writing** and the public bug bounty live for at least six months with no critical incidents.
4. A **genuine decentralisation need**: named powers (oracle swaps, collateral onboarding, fee parameters) that must move from the multisig to token voting, documented case by case.
5. **Written counsel sign-off** covering the enacted GENIUS Act text as applied to GSUSD, MiCA ART attribution, the UK financial promotions regime and the retroactive risk of a later fee-switch activation.

If the triggers are never met, no token launches. That outcome is the market answering the demand question, and it is an acceptable outcome of this policy.

## 4. Design constraints if the gate fires

These constraints bind any future protocol token design:

- **Supply**: 100,000,000 tokens, fixed. No inflation. No mint-to-recapitalise mechanism (the MKR dilution overhang lesson). The funded SurplusBuffer is the backstop; the token is not.
- **Distribution**: team plus investors strictly under 30% combined. Team on a four year vest with a one year cliff. Majority of supply to the community: retroactive allocation against the Usage Ledger plus ongoing ecosystem and treasury tranches on multi-year schedules. No front-loaded emissions.
- **Utility at TGE**: governance only, exercised as token-voted proposer through the existing 48 hour `TimelockController`. The guardian pause role is retained.
- **Fee switch OFF at TGE.** Value accrual, if ever activated, is a governance-and-counsel-gated fee split routed through the `surplusBuffer` slot, paying only revenue above the reserve floor; the FeeSplitter reads the buffer's automatic 2% floor itself, so no setting can route revenue out below it. Activation is a permanent re-trigger risk under securities analysis and is treated as such. Recovering infrastructure costs from revenue above the floor ([`BUSINESS_MODEL.md`](BUSINESS_MODEL.md) section 5, item 4) is a governance withdrawal to the operations Safe, not a fee split, and sits outside this gate.
- **Issuer**: an offshore foundation, with the UK development company as a contracted service provider and never the issuer. US and UK persons excluded from the initial distribution and from any staking interface.
- **Pre-built, not pre-deployed**: the FeeSplitter and any staking contracts are built and independently audited before the gate fires, and deployed only after it.

## 5. Ossification roadmap

Credible neutrality is earned, not declared. Full day-one immutability would be dishonest for this protocol because Paxos or Tether freeze events genuinely require a response capability. The roadmap:

- **Year 1**: publish a complete parameter change log. The stability reserve spread bounds (0.5% to 5%) are constants; the curve within them is governance-set.
- **Year 2**: narrow the multisig's writable surface to oracle and emergency lanes. (The reserve floor that stops governance draining the backstop is no longer a roadmap item: SurplusBuffer enforces 2% of supply on chain from deploy.)
- **Year 3**: renounce module-swap rights on core fee routing once any fee splitter is battle-tested, leaving pause and guardian powers only.

## 6. Regulatory posture summary

- **United States**: the GENIUS Act (enacted 18 July 2025) regulates fiat-reserve payment stablecoins with licensed issuers. GSUSD is exogenously collateralised by third-party gold tokens and is not in the Act's prohibited endogenous class, but whether a non-custodial CDP falls inside the payment-stablecoin perimeter is an open counsel question. The jurisdiction memo required by [`LAUNCH.md`](LAUNCH.md) must answer it against the enacted text before mainnet. No US-targeted marketing before that memo concludes.
- **European Union**: GSUSD is almost certainly an Asset-Referenced Token under MiCA because the stabilisation mechanism references a commodity. The fully-decentralised exemption is read narrowly and a front-end operator or foundation can be deemed the issuer. No EU-targeted marketing pre-authorisation; assess front-end attribution with counsel.
- **United Kingdom**: the FCA financial promotions regime applies to the UK-operated front end from day one. Either obtain section 21 approval from an authorised firm or geo-restrict UK retail and run zero UK-targeted promotion. Take specific advice on whether operating the front end from the UK triggers the regime regardless of geofencing.
- **Counterparty disclosure**: PAXG and XAUT carry contract-confirmed freeze and wipe powers. Silo sharding raises the cost of a freeze; it does not defeat legal process. Risk disclosures state plainly that frozen collateral becomes bad debt absorbed by the buffer or socialised as a haircut.

## 7. Review cadence

This policy is reviewed at month 12 after mainnet and every six months thereafter. Each review publishes: trigger status (met or not, with numbers), any counsel developments and any proposed amendment with its rationale. Amendments require the same documentation standard as the launch gates.
