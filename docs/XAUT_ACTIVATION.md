# XAUT activation: criteria and procedure

**Status**: adopted with the PAXG-first launch, 28 October 2026; revised 29 October 2026 for variant C
(two Chainlink sources per token, no pool). XAUT is registered in the oracle at
deployment and is otherwise completely inactive. It is activated when the criteria below are met, not on a
date. Evidence base: [`ORACLE_FEED_EVALUATION.md`](ORACLE_FEED_EVALUATION.md) and
[`ORACLE_MANIPULATION_MODEL.md`](ORACLE_MANIPULATION_MODEL.md).

## 1. Why XAUT waits

On 28 October 2026 no route priced XAUT securely without an operator: there is no XAUT/USD push feed on
Ethereum (Chainlink offers XAUT only as a Data Streams product; RedStone's Ethereum feeds have none), Pyth
now needs a paid key and a relay the protocol would have to run, and XAUT's deepest pools can be stalled for
about $900 (XAUt/USDT) or are thin a quarter of the time (XAUt/WETH).

## 2. Activation route

XAUT is priced exactly as PAXG is (`ORACLE_IMPLEMENTATION_PLAN.md` section 3, variant C of
[`ORACLE_MANIPULATION_MODEL.md`](ORACLE_MANIPULATION_MODEL.md) section 15.8): a market push feed C for
XAUT and the gold reference G (Chainlink XAU/USD), and nothing else. Borrowing at min(C, G) inside the gold
band, liquidation at min(max(C, G), G × (1 + m)), reserve swaps at max(C, G) inside the band and every path
refused while either feed is unhealthy.

The one thing activation needs is therefore **an independently operated Chainlink-style XAUT/USD push feed
on Ethereum** (Chainlink or RedStone, AggregatorV3 compatible, 8 decimals) that passes the criteria below.
No pool, no TWAP and no observation store is part of the route: pool sources were retired from the oracle
with variant C on 29 October 2026.

## 3. Criteria (all must hold; measured, not snapshotted)

**The push feed, over at least 90 consecutive days**
- Independent node operators, a published heartbeat of 24 hours or less and a deviation trigger of 0.5% or
  less.
- At least 99.9% of time within heartbeat plus grace, so `stalenessThreshold` (90,000 s) covers it, and
  the near-limit heartbeats counted as section 15.8 point 2 counts them for PAXG.
- Tracking the exchange median within 1% at the 99.9th percentile, and C within the gold band of XAU/USD
  through at least one gold move of 5% or more.
- XAUT's premium over gold measured over the same period: variant C lets a push of C liquidate vaults
  inside that premium, so the model needs the measured range.

**Manipulation cost, re-run on that 90 day data with the same model as PAXG**
- Moving C by the gold band (2%) and holding it costs at least three times the maximum extractable profit at
  the intended initial XAUT debt ceiling.
- A push of C up to G × (1 + m), held, stalls liquidation by no more than the model accepts for PAXG.

**Stressed liquidation execution, on a mainnet fork at the intended initial debt ceiling**
- A 30% gold crash clears through the stability pool and DEX depth for seized XAUT, with bad debt below what
  the SurplusBuffer holds, and PAXG positions unaffected.
- A 30% XAUT depeg with gold steady is not liquidated (variant C values XAUT at gold), so the activation record states
  the loss GSUSD holders would carry at the intended debt, as section 15.8 does for PAXG.
- A Tether freeze of a silo is rehearsed, and an XAUT feed outage refuses every priced path for XAUT instead
  of repeating a stale price.

**Token behaviour, on a mainnet fork**
- XAUT accepts a zero-value `transfer` to the GoldVault address. The vault probes with one before it pulls
  the protocol's liquidation share, and treats a refusal as a frozen vault: a token that refused every
  zero-value transfer would cede that share on every liquidation (THREAT_MODEL.md L7).

**Token behaviour, read on chain from the deployed XAUT and its current implementation before the batch is scheduled**
- **Return values.** What `transfer`, `transferFrom` and `approve` return on success. The contracts accept
  `true` or no return value at all, in the vault's checked transfers and in the silo factory's deposit leg
  alike (OpenZeppelin's safe transfer rule). A token that returns `false` on success is not accepted: the
  vault's pull reverts, and in the silo factory every silo is skipped until the deposit reverts
  `Too many unusable silos`. Deposits fail closed and no funds are lost, but such a token would be unusable.
- **Approve semantics.** Whether a change from one non-zero allowance to another is accepted; the vault resets
  and sets allowances for the factory, the reserve and the buffer.
- **The blocklist, both directions.** Whether a blocked address is stopped from sending only, or from receiving
  as well, and whether the block also covers the address that calls `transferFrom`. If a blocked address still
  receives, then for each holder: a blocked silo keeps taking new deposits that later withdrawals cannot
  reach (THREAT_MODEL.md C1, C2); a blocked stability pool keeps absorbing liquidations whose gold its
  depositors cannot claim; a blocked reserve or buffer keeps receiving the protocol's penalty share, which the
  reserve then counts as coverage and cannot pay out (THREAT_MODEL.md U7). Record which of these apply and add
  the guardian's `pauseAsset` and `freezeToken` to the XAUT issuer-freeze runbook accordingly.
- **Destruction of blocked funds.** Whether the issuer can destroy the balance of a blocked address. No ledger
  in the protocol is written down when that happens, so the consequences are those of THREAT_MODEL.md C1 and
  C2 for silos, an absorption after it credits its depositors nothing in the pool, and the reserve and the
  buffer report gold they no longer hold.
- **Zero-value transfers.** Whether a transfer of zero succeeds, to the sender itself as well as to another
  address (the probe above depends on it).
- **Pausability.** Whether the issuer can pause all transfers, and who can; THREAT_MODEL.md C4 then applies to
  XAUT as it does to PAXG.
- **Decimals and upgrades.** `decimals()` returns 6, and whether the token is an upgradeable proxy whose
  `Upgraded` event operations must watch. The stability pool and the reserve store the decimals when the token
  is listed and the vault reads them live, so a change of decimals after listing would split them.

**Reserve coverage with two assets**
- Before XAUT is listed on the Stability Reserve (the last step of the batch, after 30 days of clean pricing),
  decide how the reserve is to treat gold it cannot pay out. Coverage counts every listed asset that is neither
  paused nor frozen, including one that is off its gold band, whose daily cap is used up or whose balance an
  issuer has frozen, and with two assets that narrows the spread on swaps of the other one (THREAT_MODEL.md
  U7). Either accept it with the guardian's `pauseAsset` as the control and say so in the activation record,
  or change the reserve first.

## 4. Procedure (no redeployment, no migration)

The contracts are not upgradeable proxies; XAUT is added to the deployed contracts through the 48 hour
timelock in one batch, which the executor must run within 7 days of it becoming ready (after that the
timelock refuses it with `TimelockOperationExpired`, and the batch is cancelled and scheduled again):

1. Oracle: point XAUT's entry at the push feed (`setXautFeed`; it is registered at launch on an
   `InactiveFeed` that answers no price, so XAUT cannot be priced before this step) and, where the model
   calls for values other than the 2% defaults seeded at registration, `setGoldBand` and
   `setLiquidationClamp` for XAUT.
2. `StabilityModule.initCollateral(xautId, rate)`.
3. `GoldVault.addCollateralType(XAUT, minRatio, liquidationRatio, penalty, debtCeiling)`.
4. `StabilityPool.addCollateralToken(XAUT)` (at most 10 collateral tokens).
5. `GoldStabilityReserve.setAssetConfig(XAUT, ...)` only once XAUT pricing has run for 30 days without a refusal.

**After the batch.** Once the batch has executed, record it, from `contracts/`:

1. `XAUT_ACTIVATED=1 npx hardhat run scripts/refresh-deployment-snapshot.ts --network mainnet`.
   It records `xautActive: true`, `xautActivatedAt` and `xautMarketFeed` (the feed the oracle
   now reads for XAUT) in the snapshot's `config`, together with XAUT's ratios, ceiling,
   stability fee and reserve minimum. Without `XAUT_ACTIVATED=1` the refresh refuses an
   activated XAUT and writes nothing, and with it but no activation on chain it is refused too.
2. `EXPECT_GOVERNANCE_TRANSFERRED=1 npx hardhat run scripts/verify-deployment.ts --network mainnet`.
   It now reports `ok xaut:activated` in place of `fail xaut:dormant`, and compares the
   oracle's XAUT feed with `xautMarketFeed`.
3. `npx hardhat run scripts/print-agent-manifest.ts`, then commit and publish
   `apps/dapp/public/agents.json` and `llms.txt`, so agents see XAUT with its ratios.

`config.xautFeed` in the snapshot stays the constructor's `InactiveFeed` on purpose:
Etherscan verification rebuilds the oracle's constructor from it. The live feed is
`config.xautMarketFeed`.

The GSUSD token is not redeployed, its minter set is unchanged (XAUT goes into the existing vault, which
matters once minters are locked), and PAXG positions are untouched: each token's price, freeze and
liquidation state are isolated.

## 5. Governance and upgradeability implications

- **Vault-wide couplings once XAUT is active** (29 October 2026): the bad-debt pause
  threshold, the per-block mint cap (off under `LAUNCH_CAPS=open`), the stability pool, the SurplusBuffer, `minDebt`, the liquidation
  incentive and the underwater discount are shared by every collateral. XAUT bad debt counts towards the
  pause that also stops PAXG minting, and XAUT absorptions draw on the same pool PAXG relies on. PAXG
  launches with no debt ceiling (`LAUNCH_CAPS=open`, the only mainnet profile), so the activation
  must re-run the model for both tokens together under variant C and decide both tokens' ceilings and the
  pool seeding before the batch is scheduled.

- **Activation is a governance act**, taken once against published criteria, not a routine adjustment.
- **The launch oracle must already support XAUT's source shape** (one AggregatorV3 market feed priced
  against the shared XAU/USD reference). If a future source needs different pricing logic, activation means
  replacing the oracle for every token (`GoldVault.setOracle`, `GoldStabilityReserve.setOracle`), which
  migrates no positions but changes PAXG's pricing contract and needs its own evaluation.
- **Adding a collateral type is irreversible**: it can be frozen (`GoldOracle.freezeToken`, 14 days at a time, renewable) and its ceiling lowered, not removed; `GoldVault` has no per-collateral pause. Hence
  activation only after the criteria pass.
- **The dormant oracle entry** must be proven unusable at launch: the preflight and the fork rehearsal check
  that XAUT is not a vault collateral type, not a reserve asset and not a pool token.
- **Encoding the criteria on chain** for permissionless activation is possible but adds code and its own
  manipulation surface; not proposed now.
