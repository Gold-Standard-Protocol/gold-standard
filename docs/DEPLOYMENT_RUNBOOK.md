# Gold Standard Protocol: Deployment Runbook

Step-by-step ceremony for deploying the system to Sepolia (dry-run) and Ethereum mainnet. Read in full before executing any step.

- **Spec**: `docs/SPECIFICATION.md`
- **Threat model**: `docs/THREAT_MODEL.md`
- **Launch guide (the authoritative operational playbook)**: `docs/LAUNCH.md`
- **Oracle policy and feed inventory**: `docs/ORACLES.md`

---

## 0. Prerequisites

### Team
Minimum 2 engineers present in the same call throughout. One drives, one verifies. Neither acts alone.

### Hardware
- Deployer: fresh hardware wallet (Ledger / Trezor), single-use ETH account with no earlier transactions. Funded with at least what the preflight computes under `deployer:balance`: the ceremony's gas at the day's fee plus a 25% margin (`docs/MAINNET.md` section 1).
- Proposer signers: 2-of-3 Gnosis Safe, each signer on a hardware wallet, physically distributed (minimum 3 jurisdictions).
- Executor: a separate 2-of-3 Gnosis Safe (project decision, 2026-11-16). All three role Safes are 2-of-3 and the preflight enforces it (`SAFE_POLICY` in `contracts/scripts/lib/preflight.ts`). `address(0)` (anyone may execute a matured operation within the timelock's 7 day grace period) is refused on mainnet unless `ALLOW_OPEN_EXECUTOR=1` accepts it (`LAUNCH.md`, executor policy). Separation from proposer is mandatory; on mainnet the preflight fails one Safe in two roles.
- Guardian signers: separate 2-of-3 Gnosis Safe. Different signers from proposer / executor where possible. A pause needs two of the three. The guardian only stops things: it pauses the vault, the oracle and the stability pool and extends a pause, pauses a reserve asset, freezes a token's oracle reads and lifts that freeze, and re-records the oracle's last-known price. It cannot unpause and changes no parameter.
- Operations Safe: a fourth Safe that holds the project's gold and receives cost-recovery withdrawals; it holds no role in any contract (`OPERATIONS_SAFE`, checked by the preflight).
- The deployer key is an owner of none of these Safes (the preflight fails it), and every executor signer is backed up: the timelock has no admin, so losing two of the three stops every governance execution (`docs/MAINNET.md` section 1.1).

### Software
```
node            >= 20.x
npm             >= 10.x
foundry         stable (for invariant verification)
hardhat         2.29.1 (pinned in contracts/package.json)
solc            0.8.38 (pinned in contracts/hardhat.config.ts and foundry.toml; every source file declares `pragma solidity 0.8.38;`)
slither         pip install slither-analyzer (optional; for pre-flight)
```

### Pre-ceremony
- [ ] All CI green on `main` (contracts-ci, contracts-lint, contracts-slither, contracts-coverage, contracts-foundry).
- [ ] StabilityPool posture decided: deploying with the pool enabled is the default; deferring pool-based liquidations remains a governance choice (Section 2.6).
- [ ] Sepolia dry-run completed and verified within the last 7 days.
- [ ] Guardian, proposer, executor and operations Safes deployed on target chain, four different addresses, and tested with a dummy tx (`docs/MAINNET.md` section 1.1). The deployer key is an owner of none of them.
- [ ] Etherscan API key provisioned for source verification.
- [ ] Deployment runbook reviewed and signed by all team members present.
- [ ] Communication channels (Discord/Slack) muted or off; only the ceremony channel active.

---

## 1. Sepolia dry-run

**Goal**: execute the entire mainnet ceremony on Sepolia first. If anything surprises you on Sepolia, FIX IT BEFORE MAINNET.

### 1.1 Prepare env

Create `contracts/.env.sepolia` (NEVER commit):

```
# hardhat.config.ts reads RPC_URL and PRIVATE_KEY for every network
RPC_URL=<your Sepolia RPC>
PRIVATE_KEY=<single-use deployer key>

# Sepolia mock token + feed addresses: deploy your own for dry-run
PAXG_TOKEN=<sepolia paxg-mock>
XAUT_TOKEN=<sepolia xaut-mock>
PAXG_FEED=<sepolia paxg-feed-mock>
XAUT_FEED=<sepolia xaut-feed-mock>
# Set the anchor in rehearsal too, so the gold band is exercised before
# mainnet (deploy.ts hard-aborts without it on mainnet only)
XAU_USD_ANCHOR_FEED=<sepolia xau-usd-anchor-mock>

TIMELOCK_PROPOSER=<sepolia proposer safe>
TIMELOCK_EXECUTOR=<sepolia executor safe>
TIMELOCK_GUARDIAN=<sepolia guardian safe>

# 25 hours: covers the 24h feed heartbeat plus grace (docs/ORACLES.md section 2)
STALENESS_THRESHOLD=90000
SILO_CAP=100000000000000000000
# Stays 0: the 2 percent of supply reserve floor is automatic in SurplusBuffer
MIN_GSUSD_RESERVE=0
# Smallest vault debt in GSUSD: 100 keeps the testnet harness small, mainnet opens at 1000
MIN_DEBT_GSUSD=100

# LAUNCH_CAPS unset is the guarded testnet profile: both tokens active, both
# ceilings zero at deploy (raise them with scripts/ramp-testnet-ceiling.ts)
# and the per-block mint cap armed. Mainnet launches under LAUNCH_CAPS=open
# (docs/LAUNCH.md step 3.2). To rehearse that shape exactly, set
# LAUNCH_CAPS=open and remove XAUT_FEED, both ceilings, every XAUT_* line
# below and RESERVE_MIN_RESERVE_XAUT: open refuses each of them
# (scripts/lib/launchEnv.ts). The current Sepolia deployment runs open.
PAXG_DEBT_CEILING=0
XAUT_DEBT_CEILING=0

PAXG_MIN_RATIO=1300000
PAXG_LIQ_RATIO=1100000
PAXG_LIQ_PENALTY=50000
PAXG_STABILITY_FEE_BPS=200

XAUT_MIN_RATIO=1300000
XAUT_LIQ_RATIO=1100000
XAUT_LIQ_PENALTY=50000
XAUT_STABILITY_FEE_BPS=200
# Origination fee, taken from what each mint delivers (0 to 100; launch policy 5)
ORIGINATION_FEE_BPS=5

# Gold Stability Reserve (deploy.ts defaults shown; the reserve is EMPTY at
# deploy and is seeded separately, see scripts/seed-testnet-reserve.ts)
RESERVE_PENALTY_SHARE_BPS=4000
RESERVE_DAILY_CAP_PPM=200000
RESERVE_MIN_RESERVE_PAXG=0
RESERVE_MIN_RESERVE_XAUT=0
RESERVE_AGGREGATE_DAILY_CAP_USD=0

ETHERSCAN_API_KEY=<key>
```

### 1.2 Execute and verify

```
cd contracts
npm ci
npm run compile
npm run typecheck   # Hardhat only transpiles scripts; this catches a script out of step with the contracts

# 1. Deploy (journals to deployments/sepolia.inprogress.json as it goes; if it
#    stops part way, run it again with DEPLOY_RESUME=1 to carry on, or without
#    it to start over: off mainnet a leftover journal is replaced)
npx hardhat run scripts/deploy.ts --network sepolia

# 2. Verify deployment matches snapshot
npx hardhat run scripts/verify-deployment.ts --network sepolia
# Expect: "All verification checks passed." (with real Safes; a single-wallet
# rehearsal fails only the three timelock:*.deployer-absent checks, by design)
# Every recorded launch parameter is compared with the chain by equality and the
# code at every address with build.runtimeCodeHashes. A snapshot written before
# 2026-11-11 lacks the reserve minimums, spread curve, breakers, buffer floor and
# silo lock, so their param: checks fail with "the snapshot records no config.X";
# run refresh-deployment-snapshot.ts once to record the chain's values, then verify again
```

### 1.3 StabilityPool

The StabilityPool product-sum accounting uses the full Liquity epoch + scale-factor
mechanism: `P` is kept in `[1e9, 1e18]` and can never floor to zero, and collateral gains are
carried at 18 decimals for 6-decimal XAUT (a depositor's gain is rounded down to the token's
decimals at each refresh, dropping up to one base unit each time), so the pool does not need to be disabled at deploy. Enabling pool-based
liquidations after launch remains a governance decision; if you choose to defer it, disable with:

```
# In hardhat console
const vault = await ethers.getContractAt("GoldVault", "<vault addr>");
await vault.setStabilityPool(ethers.ZeroAddress);   // await vault.stabilityPool() -> 0x0
```

### 1.4 Etherscan verification

```
npx hardhat run scripts/verify-etherscan.ts --network sepolia
```

It reads `deployments/sepolia.json`, rebuilds every constructor's arguments from the
snapshot and submits each contract in turn; contracts already verified are skipped, so
re-run it until every one reports `verified` or `already verified`. `ONLY=<label>`
verifies a single contract.

### 1.5 Functional smoke test

```
# In hardhat console on Sepolia, as a test user:
await paxg.mint(user.address, ethers.parseEther("10"));
await paxg.approve(await vault.getAddress(), ethers.parseEther("10"));
await vault.deposit(await paxg.getAddress(), ethers.parseEther("10"));
await vault.mint(ethers.parseEther("5000"));       // 5k GSUSD against 10 PAXG
await gsusd.approve(await vault.getAddress(), ethers.parseEther("4000"));
await vault.repay(ethers.parseEther("4000"));      // the mint delivered 4,997.5 GSUSD (5 bps fee), so a full repayment needs GSUSD from elsewhere
await vault.withdraw(ethers.parseEther("2"));      // a partial withdrawal: the debt still owed keeps collateral in the vault
```

Every call must succeed cleanly. Check events via Etherscan. Under the guarded profile the
ceilings are zero at deploy, so the mint is refused (`Debt ceiling reached`) until
`scripts/ramp-testnet-ceiling.ts` has raised them; under open it succeeds at once.

The automated version of this and the rest of the launch flow is
`scripts/rehearse-testnet-flow.ts` (docs/LAUNCH.md step 2.5); run it before the
manual smoke test so the numbers are already known good.

### 1.6 Governance transfer on Sepolia

Run the handover script. This mirrors the mainnet sequence exactly; do not
transfer contracts by hand, because a manual sequence is how a contract gets
missed.

```
CONFIRM=YES npx hardhat run scripts/transfer-governance.ts --network sepolia
```

The script transfers governance on every contract in order, starting with the
stablecoin and ending with the SiloFactory role
handover, verifies on-chain that the deployer holds no admin role anywhere
and marks the snapshot with `governanceTransferred: true` itself.

Re-verify:
```
EXPECT_GOVERNANCE_TRANSFERRED=1 npx hardhat run scripts/verify-deployment.ts --network sepolia
```

### 1.7 Test the guardian pause

As the guardian multisig, call `oracle.emergencyPause()`. Confirm `oracle.paused()` returns true. Then read `oracle.pauseEpoch()` and submit a governance proposal to `unpause(epoch)` with that number. Confirm 48h timelock → execution flow works.

### 1.8 Dry-run exit criteria

Proceed to mainnet **only if**:

- [ ] `verify-deployment.ts` passes pre- and post-governance-transfer
- [ ] Etherscan sources verified on every contract
- [ ] Smoke test succeeded (deposit → mint → repay → withdraw)
- [ ] Guardian pause + governance unpause flow exercised end-to-end
- [ ] Ceremony duration measured (for mainnet time budgeting)
- [ ] No surprises — if anything went unexpectedly, write it down and address before mainnet

---

## 2. Mainnet deployment

### 2.1 Final pre-flight (same day)

- [ ] Check Chainlink [PAXG/USD](https://data.chain.link/feeds/ethereum/mainnet/paxg-usd) and [XAU/USD](https://data.chain.link/feeds/ethereum/mainnet/xau-usd) are live and updating. These are the oracle's only two sources (C and G). There is no XAUT/USD push feed on mainnet; XAUT's dormant registry entry is an `InactiveFeed` that answers no price (`docs/ORACLES.md` section 1).
- [ ] Check PAXG and XAUT token contracts are not currently paused and not subject to ongoing freeze actions.
- [ ] Gas price < 50 gwei OR team is prepared to wait.
- [ ] All signers online and reachable.
- [ ] No hot patch in flight: the commit being deployed is the release commit.

### 2.2 Prepare mainnet env

`contracts/.env.mainnet`:

```
# hardhat.config.ts reads RPC_URL and PRIVATE_KEY for every network
RPC_URL=<your mainnet RPC>
PRIVATE_KEY=<NEW single-use key, NOT the Sepolia one>

PAXG_TOKEN=0x45804880De22913dAFE09f4980848ECE6EcbAf78
XAUT_TOKEN=0x68749665FF8D2d112Fa859AA293F07A622782F38
# Chainlink PAXG/USD push feed, RPC-confirmed (docs/ORACLES.md section 1).
# Earlier revisions of this runbook listed an address that is not an
# AggregatorV3 contract; verify character by character before saving.
PAXG_FEED=0x9944D86CEB9160aF5C5feB251FD671923323f8C3
# XAUT_FEED stays unset: deploy.ts registers XAUT on an InactiveFeed that
# answers no price (docs/XAUT_ACTIVATION.md)
# G, the gold reference. MANDATORY: scripts/deploy.ts hard-aborts a mainnet
# deploy without it
XAU_USD_ANCHOR_FEED=0x214eD9Da11D2fbe465a6fc601a91E62EbEc1a0D6
# Gold band g and liquidation cap m, 2% each (docs/ORACLE_IMPLEMENTATION_PLAN.md
# section 4). PAXG_CONFIRM_FEED, PAXG_AGREEMENT_BAND_PPM and MARKET_FEEDS are
# retired and refused.
PAXG_GOLD_BAND_PPM=20000
PAXG_LIQUIDATION_CLAMP_PPM=20000

TIMELOCK_PROPOSER=<mainnet proposer safe>
TIMELOCK_EXECUTOR=<mainnet executor safe>
TIMELOCK_GUARDIAN=<mainnet guardian safe>

# The only mainnet profile: no PAXG debt ceiling, no per-block mint cap,
# XAUT dormant. Leave PAXG_DEBT_CEILING and PER_BLOCK_MINT_CAP unset.
# LAUNCH_CAPS=backstop is refused on mainnet by the preflight and deploy.ts.
LAUNCH_CAPS=open

# 25 hours: covers the 24h feed heartbeat plus grace (docs/ORACLES.md section 2)
STALENESS_THRESHOLD=90000
SILO_CAP=100000000000000000000
# Stays 0: SurplusBuffer keeps the 2 percent of supply floor by itself
# (docs/BUSINESS_MODEL.md section 5); this is only an optional higher
# governed minimum and the preflight refuses any other value at deploy
MIN_GSUSD_RESERVE=0
# Smallest vault debt in GSUSD at the mainnet launch
MIN_DEBT_GSUSD=1000
PAXG_MIN_RATIO=1300000
PAXG_LIQ_RATIO=1100000
PAXG_LIQ_PENALTY=50000
PAXG_STABILITY_FEE_BPS=200
# Origination fee, taken from what each mint delivers; verify-deployment.ts
# fails mainnet on any value but 5 unless ALLOW_ORIGINATION_FEE=1. Later changes
# go through the timelock with scripts/set-origination-fee.ts
ORIGINATION_FEE_BPS=5
# No XAUT_* lines: XAUT is dormant under open, which refuses XAUT_DEBT_CEILING,
# XAUT_MIN_RATIO, XAUT_LIQ_RATIO, XAUT_LIQ_PENALTY, XAUT_STABILITY_FEE_BPS and
# RESERVE_MIN_RESERVE_XAUT

# Gold Stability Reserve (deploy.ts defaults shown). 40 percent of the
# protocol's penalty gold funds the reserve; 20 percent of an asset's
# day-start balance may leave per UTC day; minimum reserve and the
# aggregate USD cap are sized from libs/peg-sim before launch. The reserve
# is EMPTY at deploy; the mainnet seed is 0.05 PAXG from the operations Safe.
RESERVE_PENALTY_SHARE_BPS=4000
RESERVE_DAILY_CAP_PPM=200000
RESERVE_MIN_RESERVE_PAXG=0
RESERVE_AGGREGATE_DAILY_CAP_USD=0

ETHERSCAN_API_KEY=<key>
```

`contracts/.env.mainnet.example` carries the same set with the reasoning for each value;
`docs/MAINNET.md` section 3 is the launch sheet.

**Two-engineer review of every value** before saving. Read the file out loud, signer-by-signer. This is the step where typos become $millions.

### 2.3 Preflight and deploy

```
git fetch origin && git checkout <release commit>
npm ci
cd contracts
npm ci
npx hardhat run scripts/preflight-mainnet.ts --network mainnet
npx hardhat run scripts/deploy.ts --network mainnet
```

The preflight is read-only. It parses `.env.mainnet` with the same code `deploy.ts` uses,
checks the addresses, the open profile, XAUT dormant and the three Safes against
`SAFE_POLICY` (proposer, executor and guardian each at least 2-of-3, a zero-address executor
being refused unless `ALLOW_OPEN_EXECUTOR=1` accepts it; a Safe it cannot read fails on mainnet) and writes
`deployments/mainnet.preflight.json` on a pass. `deploy.ts` refuses to run on mainnet unless
that record exists and hashes to the parameters it parses itself, so any change to the env
file means running the preflight again. A `FAIL` means you do not deploy today.

`deploy.ts` also starts only at the deployer nonce the preflight recorded, refuses to replace
an existing `deployments/mainnet.json` (unless `PREFLIGHT_ALLOW_EXISTING_SNAPSHOT=1`, which
keeps the old file as a dated copy) and re-checks the deployer's balance at the fee quoted
when it starts. It journals every creation and wiring step to
`deployments/mainnet.inprogress.json`; a ceremony that stops part way is carried on with
`DEPLOY_RESUME=1`, which verifies the journal against the chain and sends only what is still
owed (`docs/MAINNET.md` section 3.3). Never delete the journal of a stopped mainnet run.

The preflight also fails a deployer that is an owner of any Safe (`safe:deployer-not-owner`)
and checks the operations Safe when `OPERATIONS_SAFE` is set. Its record is good for 60
minutes by the chain's clock (`PREFLIGHT_MAX_AGE_MINUTES`), and `deploy.ts` reads the three
Safes again and refuses when a threshold or an owner differs from the record. Never speed up
or cancel a ceremony transaction from a wallet: one not mined within 20 minutes
(`DEPLOY_WAIT_TIMEOUT_MINUTES`) stops the run with its hash and nonce, and `DEPLOY_RESUME=1`
carries on once it is mined. The ceremony is eleven creation transactions (fourteen contracts:
the eleven, the timelock that GoldGovernance constructs, the CollateralSilo implementation
that SiloFactory constructs and the token, which the GoldStablecoinDeployer creates at the
address `GSUSD_SALT` gives) and at most thirty-five further transactions.

Capture the output. Addresses land in `contracts/deployments/mainnet.json` — commit this to git after ceremony.

### 2.4 Immediate verification

```
npx hardhat run scripts/verify-deployment.ts --network mainnet
```

**Expect "All verification checks passed."** If ANY check fails, STOP and investigate before proceeding to governance transfer.

### 2.5 Etherscan source verification

```
npx hardhat run scripts/verify-etherscan.ts --network mainnet
```

Confirm every address has "Contract Source Code Verified" (green checkmark) on Etherscan.

### 2.6 StabilityPool posture (optional)

The pool uses the epoch and scale-factor accounting described in Section 1.3,
so deploying with the pool enabled is the default. If governance chooses to defer pool-based liquidations
in the first weeks after launch, disable with:

```
# hardhat console --network mainnet
await vault.setStabilityPool(ethers.ZeroAddress);
```

Verify: `await vault.stabilityPool()` returns `0x0`.

### 2.7 Governance transfer (IRREVERSIBLE)

Two-engineer verbal confirmation required before running the script. Do NOT
transfer contracts by hand; the script enforces the complete sequence,
starting with the stablecoin and ending with the
SiloFactory role handover.

```
CONFIRM=YES npx hardhat run scripts/transfer-governance.ts --network mainnet
```

The script refuses to run without `CONFIRM=YES`, refuses once the snapshot
records the handover, refuses a signer that is not the recorded deployer,
verifies on-chain that the deployer holds no admin role anywhere and marks the
snapshot with `governanceTransferred: true` itself. A run that stopped part way
is finished by running the same command again, never by hand: the script reads
each contract's admin from the chain and sends only what is still owed
(`docs/MAINNET.md` section 3.6). See `docs/LAUNCH.md` step 4 for the full
transfer order.

When it finishes, retire the deployer key before anything else, as the script prints:
`unset PRIVATE_KEY RPC_URL ETHERSCAN_API_KEY`, delete `.env.mainnet`, close the shell.
Deleting the file alone leaves the key exported.

### 2.8 Post-transfer verification

Commit and push the updated `contracts/deployments/mainnet.json` snapshot.

Re-run verification with the post-transfer flag:
```
EXPECT_GOVERNANCE_TRANSFERRED=1 npx hardhat run scripts/verify-deployment.ts --network mainnet
```

**Expect ALL checks pass**, including the 18 `gov:*` checks asserting the deployer is revoked and the timelock is admin on all nine governed contracts (stablecoin, oracle, vault, stability module, surplus buffer, stability pool, stability reserve, silo factory and the governance wrapper). The `reserve` key in `deployments/mainnet.json` is the `GoldStabilityReserve`; verification also asserts that it holds no `MINTER_ROLE`, that its per-asset daily cap is armed and prints a warning if it is empty against non-zero supply.

### 2.9 Publish

- [ ] Commit `contracts/deployments/mainnet.json` to `main`.
- [ ] Announce deployment with addresses in official channels (Discord, X, docs site, DefiLlama submission).
- [ ] Update status page: deployed under `LAUNCH_CAPS=open`, PAXG minting open since the deploy with no debt ceiling and no per-block mint cap, XAUT registered in the oracle and inactive until its activation batch (`docs/XAUT_ACTIVATION.md`).

---

## 3. The first weeks after launch

Mainnet launches under `LAUNCH_CAPS=open`: PAXG has no debt ceiling and no per-block mint cap
from the deploy, so there is no ceiling ramp and no scheduled ceiling raise. XAUT stays
inactive until its governance batch (`docs/XAUT_ACTIVATION.md`). The bad-debt auto-pause, the
silo cap and the reserve's daily caps stay armed. The guarded ramp this section used to
describe ($250k doubling weekly to $10M) is retired; ceilings are raised only on testnets
under the guarded profile, which mainnet refuses.

Before announcing, and then as a weekly review, follow `docs/MAINNET.md` section 5 and
`docs/LAUNCH.md` step 5:

- The keeper is live (`KEEPER_DRY_RUN=false`) with a funded liquidation path: no
  `keeper.no-liquidation-path` or `vault.liquidation-blocked` event, a wallet and pool float
  checked against the largest vault, and one deliberate test liquidation observed end to end.
- The keeper's log is on a pager or its dead-man ping is set (`docs/MAINNET.md` section 4.7,
  "Alerting"), and the second keeper has its own key, ETH and GSUSD float.
- Open the first vault yourself, then seed the reserve (it ships empty, so there is no
  conversion floor until it holds gold) with the two Safe transactions
  `scripts/print-reserve-seed.ts` prints, never with a plain transfer, which cannot be
  recovered, and swap once.
- After any parameter change, refresh the snapshot and re-run verification, which asserts
  the open state (`policy:open-launch.*`):
  ```
  npx hardhat run scripts/refresh-deployment-snapshot.ts --network mainnet
  EXPECT_GOVERNANCE_TRANSFERRED=1 npx hardhat run scripts/verify-deployment.ts --network mainnet
  ```

Every parameter change is a governance proposal through the 48h timelock. Community
transparency: announce the proposal when scheduled.

---

## 4. Emergency procedures

### 4.1 Oracle feed stalls or returns bad data

**Automatic**: there is no circuit breaker. The oracle refuses a price for the affected token
alone while its market feed C or the gold reference G is unhealthy (`No reliable price`), and
refuses borrowing and reserve swaps while C sits off the gold band (`Off gold band`); every path
resumes by itself when the feeds answer again (`docs/ORACLE_IMPLEMENTATION_PLAN.md` section 3).
Off the band liquidation still prices, at min(max(C, G), G × (1 + m)), so collateral is valued at
gold at worst; nobody needs to record or observe anything.

**Response**:
1. Guardian calls `oracle.freezeToken(token)` (one token, lapses after 14 days unless renewed; it
   stops that token's seizures during a pause as well) or `oracle.emergencyPause()` (every token)
   if bad data is suspected and the rules still price it.
2. On-call engineer investigates Chainlink feed status.
3. If feed recovers: nothing to reset; if the oracle was paused, governance proposal to
   `unpause(epoch)`, with `epoch` read from `oracle.pauseEpoch()` when it is scheduled (48h delay).
4. If feed is broken long-term: governance proposal to `setPaxgFeed(new feed)`, `setXautFeed(new feed)`
   or, for the gold reference, `setAnchorFeed(new feed)` (48h delay). Until it executes,
   liquidation in the affected token stays refused; repayment and deposits work.
5. During a pause, `vault.emergencyLiquidate()` (and, while the vault itself is paused,
   `vault.liquidateViaPool()`) prices each seizure at the rules' liquidation price and reverts
   `No price` when the rules give none, or `Token frozen` for a token the guardian has frozen
   (`guardianUnfreezeToken(token, oracle.freezeEpoch(token))` lifts it while paused): `lastKnownPrice` never prices a seizure, so a stale
   record or a single-feed glitch cannot seize a healthy vault. `resyncLastKnownPrice(token)`
   only records the price the rules give now for the vault's views. The gold band and the
   liquidation cap are per token (`setGoldBand`, `setLiquidationClamp`) and change only through
   the timelock.

### 4.2 Guardian detects exploit

1. The guardian Safe, which needs two of its three signers, calls `oracle.emergencyPause()`, `vault.emergencyPause()` and `stabilityPool.emergencyPause()`, and `reserve.pauseAsset(token)` for each reserve asset (PAXG alone at launch), as the prepared batch of `docs/MAINNET.md` section 6 (`docs/LAUNCH.md`, Possible exploit in flight). Every one lapses after 14 days unless the guardian renews it (`extendPause()`, or `pauseAsset` again on the reserve). Each renewal takes a new pause number, so an unpause scheduled before it reverts `Different pause`.
2. Incident commander named within 15 minutes.
3. Public status update within 1 hour.
4. Patch developed, tested on Sepolia fork of mainnet state.
5. Migration proposal: new contracts deployed and governance transferred. Once the minter set is locked (`lockMinters`), no replacement vault can mint the existing GSUSD, so a replacement vault needs a new GSUSD token and holders and borrowers move to it (`docs/LAUNCH.md`, steady state).
6. Post-mortem published within 48h.

### 4.3 Issuer (Paxos / Tether) freezes silo addresses

1. Identify frozen silos via monitoring and quantify the affected collateral: `sum(balance of frozen silos)`.
2. Withdrawals route around frozen silos automatically. If a run of consecutive silos is frozen, governance moves new deposits past it with `SiloFactory.setCurrentSiloIndex` (at most 64 silos per call). Straight after every move, call `SiloFactory.createSilos(token, 16)` (anyone can) until `missingSilos(token)` reads 0, before telling users deposits are open again: a deposit creates every silo missing up to the cursor, and after a long move that can be more than one transaction's gas. Read `missingSilos(token)` immediately before each call and send each call as its own transaction; it reverts `Nothing to create` when the gap was filled first, so it must not be placed inside an atomic governance batch with the cursor move or anything else.
3. There is no governance call that books a freeze as bad debt: `SurplusBuffer.absorbBadDebt` is callable only by the vault (`VAULT_ROLE`), which absorbs bad debt itself when a vault's debt outlives its collateral.
4. Do not propose a `setSiloFactory` rotation while any silo holds frozen gold: the vault refuses to replace a factory that still holds collateral, so the proposal would revert on execution.
5. If every silo is frozen, the issuer has effectively seized the collateral. Pause and consult legal.
6. User comms. The full procedure is `docs/LAUNCH.md`, Issuer freezes a silo address.

### 4.4 Governance signer compromised

1. The remaining two signers of the 2-of-3 Safe immediately replace the compromised owner in the Safe itself. The roles belong to the Safe, so nothing changes on the timelock.
2. If a whole proposer or executor Safe must be replaced or removed, change BOTH role lists in the same proposal: the timelock's (`PROPOSER_ROLE` with `CANCELLER_ROLE`, or `EXECUTOR_ROLE`) and the `GoldGovernance` wrapper's own `PROPOSER_ROLE` or `EXECUTOR_ROLE`. A Safe revoked on the timelock alone still schedules or executes through the wrapper. The exact calls are in `docs/LAUNCH.md`, Governance signer key compromised; `verify-deployment.ts` fails `gov:wrapper-roles-match-timelock` while the two lists differ.
3. If the compromise was during a pending proposal: cancel via `TimelockController.cancel()`.
4. If a malicious proposal has already been scheduled and is within the 48h window: cancel before execution. Consider emergency guardian pause to buy time.

---

## 5. Ceremony record

After completion, archive the following to `docs/ceremonies/<date>-mainnet.md`:

- [ ] All signer identities (internal; redacted public version for transparency).
- [ ] Full command log with timestamps.
- [ ] Every tx hash with Etherscan link.
- [ ] `deployments/mainnet.json` hash and commit SHA.
- [ ] `verify-deployment.ts` output (both pre- and post-transfer).
- [ ] Any deviations from this runbook (if a step was skipped or modified, explain why).
- [ ] Signed-off by all participants.

This becomes part of the permanent public record for regulators and users.
