# Launch Guide

This is a copy-paste runbook. Follow it top to bottom. Do not skip steps. This
document is the operational playbook. The deeper references are:

- `docs/DEPLOYMENT_RUNBOOK.md`: the detailed deployment reference
- `docs/BUSINESS_MODEL.md`: revenue and reserve policy
- `docs/TOKEN_POLICY.md`: protocol token policy and the fee split constraint
- `docs/ORACLES.md`: feed inventory, the XAUT pricing decision and the
  collateral onboarding runbook
- `docs/LIQUIDITY.md`: the peg liquidity plan
- `docs/SPECIFICATION.md` and `docs/THREAT_MODEL.md`: the spec and the threat
  model

**Total time:** about 3 to 5 weeks before the mainnet deploy (step 1 takes at least a day;
step 2 takes 2 to 4 weeks and includes a soak of at least 14 days), then 4 to 8 weeks of
weekly checks after launch (step 5). Most of it is waiting on the soak and on 48h timelock
cycles.

The launch-day sheet, one command per step for steps 3 to 5 plus the server setup, is
[`MAINNET.md`](MAINNET.md). Read this document first; run from that one.

Contract commands in this guide are run from the `contracts/` directory:

```bash
cd contracts
```

Service commands (`npx nx ...`, `node dist/...`) are run from the repository
root.

---

## Pre-launch checklist (do not skip)

Each item is a hard go/no-go. If any are missing, stop and finish them first.

- [ ] Three multisigs deployed on the target chain:
      - **Proposer**: 2-of-3 Gnosis Safe, hardware-wallet signers, geographically
        distributed
      - **Executor**: 2-of-3 Safe. All three are 2-of-3 and the preflight enforces it. `address(0)` (anyone may execute) is refused on
        mainnet unless `ALLOW_OPEN_EXECUTOR=1` accepts it; see
        [Executor policy](#executor-policy)
      - **Guardian**: 2-of-3 Safe that only stops things: it pauses the vault, the oracle and
        the stability pool and extends a pause, pauses a reserve asset, freezes a token's
        oracle reads and lifts that freeze, and re-records the oracle's last-known price. It
        cannot unpause and changes no parameter
- [ ] Operations Safe deployed: the recipient of cost-recovery withdrawals
      (`scripts/withdraw-surplus.ts`), distinct from the three governance Safes
- [ ] Keeper service running on Sepolia with `KEEPER_DRY_RUN=false` (service
      exists in repo: `apps/keeper`; a single process covers the liquidation
      watch and the oracle health watch and alerts; it runs no fee job, because
      the stability fee accrues inside the contracts), plus
      a redundant secondary on a different cloud or region or on Chainlink
      Automation / Gelato. The oracle needs no observation, heartbeat or record
      from either: liquidation resumes by itself on the first healthy pair of
      feeds, so the keepers' oracle work is to alert and to liquidate sized
      from `quoteTokenPrice` while both feeds are healthy.
- [ ] dApp built with the correct `VITE_TARGET_CHAIN_ID` and address set, and
      a production WalletConnect project ID provisioned for
      `VITE_WALLETCONNECT_PROJECT_ID`. The target chain is fixed at build
      time, so the Sepolia and mainnet frontends are separate builds (see
      steps 2.4 and 3.6).
- [ ] Indexer configured: `SEPOLIA_RPC_URL`, `GOLD_VAULT_ADDRESS`,
      `GOLD_VAULT_DEPLOY_BLOCK` and, for a mainnet deployment,
      `INDEXER_CHAIN_ID=1` (see steps 2.4 and 3.6).
- [ ] `KEEPER_PRIVATE_KEY` provisioned in the keeper deployment ONLY and never
      present in the API environment. The key separation is procedural as well
      as structural; check both deploy environments explicitly before going
      live.
- [ ] Monitoring and alerting wired:
      - Tenderly alert rules for `Paused`, `TokenFrozen`, `BadDebt`,
        `AssetPaused`, large mints/stability swaps, reserve coverage vs
        circulating supply, vault CR below 115% for >5 min
      - A rule for every `RoleGranted` whose role is `VAULT_ROLE` on the stability
        module, the surplus buffer, the stability reserve or the stability pool, or
        `MINTER_ROLE` on the stablecoin, and for a `CallScheduled` that would make such
        a grant. After the ceremony none is expected, so each one is an alarm: the
        holder of the module's role can record debt on any vault (`THREAT_MODEL.md`
        G12 and G14)
      - A rule, or a line in the weekly review, for fee forgiven without a
        `BadDebt` event. When a vault's gold is worth less than its debt but
        covers the principal, the liquidation repays the principal, banks the
        part of the fee the gold covered, writes off the rest of the fee and
        closes the vault with no `BadDebt` event, because no GSUSD is left
        unbacked. To see it, compare the amount repaid in `Liquidated` or
        `LiquidatedViaPool` with `getVaultCurrentDebt(owner)` read one block
        earlier, for a liquidation that leaves the vault with no collateral:
        a repayment below that debt with no `BadDebt` in the transaction is
        accrued fee that was not collected. It is lost revenue, not a loss of
        backing
      - A Tenderly rule on every `CallScheduled` of the timelock, and its own
        rule for one whose target is the stability pool and whose call is
        `grantRole`: the pool's `VAULT_ROLE` has no lock
        ([The timelock queue](#the-timelock-queue))
      - The keeper's log on a pager, or its dead-man ping
        (`KEEPER_HEARTBEAT_URL`), per `MAINNET.md` section 4.7, "Alerting"
      - PagerDuty or equivalent on-call rotation
- [x] Legal: terms of service, risk disclosures, jurisdiction memo on GSUSD
      classification, counterparty disclosures for PAXG and XAUT. The project confirmed on
      2026-11-15 that legal sign-off is done, with the record held offline, outside this
      repository (`MAINNET.md` section 1). The dapp's page at `/terms` gathers the
      statements the project already publishes (what the software is, its risks, its
      license and the Usage Ledger sentence) and, by a project decision of 2026-11-26,
      states four conditions written for it: use at the user's own risk, no warranty, no
      promise of yield and a limitation of liability. The same decision leaves out
      governing law and venue, an offering entity and eligibility; the page states nothing
      on them. The wording lives in `apps/dapp/src/app/content/terms.ts`, and
      `terms.spec.ts` holds both the four conditions and the omissions.
- [x] The terms carry the Usage Ledger disclaimer in the words of `docs/TOKEN_POLICY.md`
      section 2 (`/terms`, held to the policy's wording by `terms.spec.ts`)
- [ ] Runway: RPC endpoints, monitoring, on-call cover and the keeper gas
      float funded through the full soak and the first weeks after launch

---

## Step 1: Local rehearsal (≥ 1 day)

Run the full E2E rehearsal on the local hardhat network. **If any test fails,
do not proceed to Sepolia.**

```bash
npm ci                    # at the repository root
cd contracts && npm ci    # contracts/ has its own lockfile
npx hardhat compile
npx hardhat test
```

Every test must pass, with none failing and none pending without a stated reason. No count
is quoted here because it changes often.

Also run the Foundry fuzz + invariant suite (requires `forge-std` installed under `lib/`):

```bash
forge test
```

Every test must pass. The suite includes the StabilityPool
product-sum invariants (`P` stays above zero, no over-withdrawal, no phantom
gains) at 25,600 fuzz calls each, plus the frozen-silo and oracle-recovery
regression tests.

Then drive the dapp itself against a throwaway chain (Redis must be running for
the API the suite starts):

```bash
npx nx e2e dapp-e2e       # node + deploy + Uniswap + seeds + funded wallet + API + dapp + Playwright
```

The wallet in that suite is the local node's own account #1 behind a connector the
node signs for, so no key exists anywhere. Its tests cover the PAXG vault
lifecycle through to closing the position, the same with 6-decimal XAUT, pool
deposit and withdrawal, a reserve swap, a Uniswap v3 market swap against a pool the
bootstrap seeds, a direct liquidation after the oracle price is walked down, and a
liquidation absorbed by the stability pool with its collateral gain then claimed, all through
the real approval, review and confirmation dialogs and all checked against balances
read from the chain. The `dapp-e2e.yml` workflow defines the same job for pull requests.

Note on scope: FeeSplitter (`contracts/src/core/FeeSplitter.sol`) is
implemented and tested but is NOT deployed by `scripts/deploy.ts`. Stability
fee revenue flows entirely to the SurplusBuffer at launch and any future fee
split is a separate governance action (see `docs/TOKEN_POLICY.md` section 4).

If it is ever activated, the order matters, because whoever administers the splitter can
reach the buffer's `absorbBadDebt` through it once the buffer trusts it:

1. Deploy `FeeSplitter(gsusd, surplusBuffer)` and call `transferGovernance(timelock)` on it
   in the next transaction, before it has been granted anything. From then on only the
   timelock administers it.
2. Every later step is a timelock operation, best as one `scheduleBatch`:
   `surplusBuffer.grantRole(VAULT_ROLE, splitter)`, `splitter.grantRole(VAULT_ROLE, vault)`,
   `splitter.grantRole(VAULT_ROLE, reserve)`, `vault.setSurplusBuffer(splitter)` and
   `reserve.setSurplusBuffer(splitter)`.
3. The beneficiary share stays at zero until a separate proposal raises it.

Then rehearse the mainnet configuration itself on a fork of mainnet, with the real
PAXG and XAUT tokens and the real Chainlink feeds (see the header of
`scripts/rehearse-mainnet-fork.ts` for the exact env block):

```bash
npx hardhat node --fork $MAINNET_RPC --fork-block-number <head minus 3> --port 8547
LOCAL_RPC_URL=http://127.0.0.1:8547 ... npx hardhat run scripts/deploy.ts --network localhost
LOCAL_RPC_URL=http://127.0.0.1:8547 npx hardhat run scripts/verify-deployment.ts --network localhost
LOCAL_RPC_URL=http://127.0.0.1:8547 npx hardhat run scripts/rehearse-mainnet-fork.ts --network localhost
```

Expect every verification check and all nine rehearsal checks to pass. PAXG has no transfer
fee today: Paxos removed the mechanism in its June 2026 upgrade. The token is an upgradeable
proxy, so the checks still measure what arrives, and a fee that returned would be reported
rather than assumed.

Then specifically run the production rehearsal:

```bash
npx hardhat test test/EndToEnd.test.ts
```

You should see:

```
  16 passing
```

This rehearsal exercises every scenario your operations team needs to be
confident about, including:

- the governance handover, the stablecoin included, with the governance wrapper handed to
  the timelock (no deployer backdoor after handover)
- the oracle never pausing itself: a per-token borrowing refusal ("Off gold band"), a stale
  feed refusing liquidation ("No reliable price") and its recovery on the next healthy answer
- `emergencyLiquidate` firing when only the oracle is paused, priced at the normal
  liquidation price and refusing ("No price") whenever C or G is unhealthy;
  `lastKnownPrice` never prices a seizure, and `resyncLastKnownPrice` only records what the
  pricing rules give
- fee-on-transfer collateral recording the actual post-fee amount, and all three
  liquidation paths distributing from the collateral actually received
- a bad-debt breaker trip while the vault is already paused, which does not revert: it
  extends the pause in force, restarting the window under a new `pauseEpoch()`
- the StabilityPool's epoch and scale-factor accounting, under which `P` can never reach zero
- `SiloFactory.withdraw` routing around an issuer-frozen silo

---

## Step 2: Sepolia rehearsal (2-4 weeks)

This is your real dress rehearsal. Use the production multisigs as signers,
mock PAXG/XAUT tokens and mock Chainlink feeds you control.

### 2.1 Set up the environment

```bash
cp .env.example .env
```

Edit `.env`:

| Variable | Sepolia value |
| --- | --- |
| `RPC_URL` | Your Sepolia RPC (Alchemy / Infura) |
| `PRIVATE_KEY` | Sepolia deployer EOA (fresh, single-use, hardware-wallet derived) |
| `PAXG_TOKEN` | Mock PAXG ERC20 you deployed on Sepolia |
| `XAUT_TOKEN` | Mock XAUT ERC20 you deployed on Sepolia |
| `PAXG_FEED` | Mock Chainlink aggregator (8 decimals) you control |
| `XAUT_FEED` | Mock Chainlink aggregator (8 decimals) you control |
| `XAU_USD_ANCHOR_FEED` | Mock XAU/USD aggregator (8 decimals) you control, a different contract from both token feeds: `GoldOracle.setAnchorFeed` refuses an anchor a token uses as its feed, and the shared parser refuses it before any transaction. Set it so the gold band is exercised in rehearsal, even though the deploy script only hard-aborts without it on mainnet |
| `STALENESS_THRESHOLD` | `90000` (the `deploy.ts` default; must cover the 24h feed heartbeat plus grace, see `docs/ORACLES.md` section 2) |
| `MIN_GSUSD_RESERVE` | `0`: the 2% reserve floor is automatic in `SurplusBuffer`; this is only an optional higher governed minimum (see note 5) |
| `MIN_DEBT_GSUSD` | `100` on Sepolia so the rehearsal harness keeps its small vaults; `1000` on mainnet (see the mainnet table) |
| `UNDERWATER_DISCOUNT_PPM` | `20000` (the `deploy.ts` default: 2% off gold worth less than its debt, so underwater vaults are still liquidated). The discount is split like the penalty, 60% to the liquidator and 40% to the protocol, so a direct liquidator's margin is at most 1.2%; a pool liquidation pays its caller half of the liquidator share |
| `TIMELOCK_PROPOSER` | Sepolia proposer Safe address |
| `TIMELOCK_EXECUTOR` | Sepolia executor Safe address |
| `TIMELOCK_GUARDIAN` | Sepolia guardian Safe address |

### 2.2 Deploy to Sepolia

```bash
npx hardhat run scripts/deploy.ts --network sepolia
```

This writes `deployments/sepolia.json`.

### 2.3 Verify wiring

```bash
npx hardhat run scripts/verify-deployment.ts --network sepolia
```

Every check must pass. If not, fix the issue and redeploy.

One deliberate exception: while a single wallet stands in for the three Safes
(`TIMELOCK_PROPOSER`, `TIMELOCK_EXECUTOR` and `TIMELOCK_GUARDIAN` all equal to
the deployer) the three `timelock:*.deployer-absent` checks fail by design. With
real Safes they pass. The role census accepts that wallet in the roles the
configuration names it for and in nothing else (`census:deployer`). A deployment
made before 2026-11-06 fails `timelock:grace-period-7d` until it is redeployed:
its timelock keeps a matured operation executable for ever.

### 2.3a Testnet toolkit

All under `contracts/`, all refuse mainnet. `market` means the live PAXG price from
CoinGecko, the same source the api uses.

| Script | Purpose |
| --- | --- |
| `scripts/deploy-testnet-mocks.ts` | Mock PAXG (18 dec), XAUT (6 dec) and three 8-decimal feeds; prints the env block for 2.1 |
| `scripts/refresh-testnet-feeds.ts` | Re-stamp the feeds (`PRICE_USD=market` optional). Run within 25 hours of every session or every priced read reverts `No reliable price` |
| `scripts/walk-testnet-price.ts` | Move the price in oracle-safe 9% steps with pokes (`TARGET_PRICE_USD=market` or a figure); how liquidations are rehearsed |
| `scripts/mint-testnet-collateral.ts` | Mint mock gold to a wallet (`MINT_TO`, `MINT_PAXG`, `MINT_XAUT`) |
| `scripts/ramp-testnet-ceiling.ts` | Raise the debt ceilings (`CEILING_GSUSD`), then run `refresh-deployment-snapshot.ts` |
| `scripts/set-testnet-mint-cap.ts` | Per-block mint cap (`MINT_CAP_GSUSD`, 0 disarms) |
| `scripts/seed-testnet-reserve.ts` | Put gold in the Stability Reserve (`SEED_PAXG`) |
| `scripts/seed-testnet-position.ts` | Open a vault for the signer (`SEED_COLLATERAL`, `SEED_DEBT`) |
| `scripts/wire-vault-registry.ts` | Add the `VaultRegistry` to a deployment that predates it: deploys it when the snapshot has none, backfills every open vault from the deposit events, then points the vault at it, directly before the handover or one timelock step per run after it. A fresh `deploy.ts` wires it in the ceremony |
| `scripts/open-throwaway-vault.ts` | Open a fresh borrower's vault (`COLLATERAL_PAXG`, at `RATIO_PCT`, 140% unless set; the minimum ratio is 130%) and print the price it is liquidated below, next to the deployer's own line: the target for a live keeper exercise |
| `scripts/seed-testnet-dex.ts` | Create and seed the GSUSD/PAXG Uniswap v3 pool from a dedicated liquidity wallet (`LP_PRIVATE_KEY`, `PAXG_LP`) |
| `scripts/rehearse-testnet-flow.ts` | Drives items 1 to 8 of 2.5 below with exact-number assertions (about 20 minutes on Sepolia; fork first with `DRIVE_DEPLOYMENT=sepolia`). After the governance handover it impersonates the timelock on a fork, so all 25 scenarios still run there, and on live Sepolia it reports the seven governance scenarios as SKIP rather than leaving a pause only the timelock can lift, and the XAUT scenarios as well where XAUT is dormant, as it is on the current open deployment. Re-runnable: it tops the deployer up from its own vault, reopens the LP vault, empties a leftover borrower vault and, on a guarded deployment, checks the PAXG ceiling headroom up front (each run leaves about 12 PAXG worth of GSUSD in circulation, so ramp the ceiling when it says so) |
| `scripts/soak-adversarial.ts` | Borrower lifecycle plus attacks against a live deployment (needs three funded signers: local node or fork) |
| `scripts/attack-drill.ts` | Every path that could move a borrower's collateral, on a pinned fork, with impersonated keys |
| `scripts/rehearse-mainnet-fork.ts` | Deploy, verify and exercise the launch configuration on a Hardhat fork of MAINNET with the real PAXG, XAUT and Chainlink feeds (header has the env block) |
| `tools/rpc-relay.mjs` | Local JSON-RPC relay with timeouts, retries and fail-over across public gateways, which also pins reads (the `latest` and `pending` forms alike) to the newest block it has seen in a receipt and sends every gas estimate in one batch with `eth_blockNumber`, discarding answers from a node still behind that block, so estimates see the newest state in the next block's context (public gateways balance across nodes with no read-after-write consistency, which produced phantom reverts mid-run); point `RPC_URL` at `http://127.0.0.1:8555` for every long live run |


### 2.4 Point the services at Sepolia

The dApp, the indexer and the keeper are configured per chain. Stand all
three up against the Sepolia deployment before exercising the flow.

**dApp** (build-time; the values are baked into the bundle by Vite, so this
is a Sepolia-specific build). Print the complete block from the snapshot rather
than assembling it from this table, which names the variables most worth
checking but not all of them (the silo factory, the vault registry and the
Uniswap variables are left out):

```bash
npx hardhat run scripts/print-service-env.ts --network sepolia
```

| Variable | Sepolia value |
| --- | --- |
| `VITE_TARGET_CHAIN_ID` | `11155111` |
| `VITE_PAXG_ADDRESS` | `config.paxgToken` from `deployments/sepolia.json`. Required: Sepolia PAXG is a mock that changes with every deployment, so the build has no fallback and lists no PAXG without it. A value that is not an address, or whose mixed case breaks the checksum, is refused the same way and the browser console names the variable |
| `VITE_XAUT_ADDRESS` | `config.xautToken` from `deployments/sepolia.json`; without it XAUT is not listed |
| `VITE_GOLD_VAULT_ADDRESS` | From `deployments/sepolia.json` |
| `VITE_STABILITY_MODULE_ADDRESS` | From `deployments/sepolia.json` |
| `VITE_GUSD_ADDRESS` | From `deployments/sepolia.json` |
| `VITE_STABILITY_POOL_ADDRESS` | From `deployments/sepolia.json` |
| `VITE_STABILITY_RESERVE_ADDRESS` | From `deployments/sepolia.json` (the `reserve` key) |
| `VITE_DEPLOY_BLOCK` | `deployBlock` from the deployment snapshot; the vault page activity feed reads events from this block |
| `VITE_GOLD_ORACLE_ADDRESS` | From `deployments/sepolia.json` |
| `VITE_SURPLUS_BUFFER_ADDRESS` | From `deployments/sepolia.json` |
| `VITE_WALLETCONNECT_PROJECT_ID` | Your WalletConnect project ID |

**Indexer** (the `apps/api` process):

| Variable | Sepolia value |
| --- | --- |
| `SEPOLIA_RPC_URL` | Sepolia RPC endpoint |
| `GOLD_VAULT_ADDRESS` | GoldVault from `deployments/sepolia.json` |
| `GOLD_VAULT_DEPLOY_BLOCK` | Block number of the GoldVault deploy transaction |
| `INDEXER_CHAIN_ID` | Optional; defaults to `11155111` |
| `INDEXER_CONFIRMATIONS` | Optional; defaults to `6`. Blocks behind the head the owner scan stops at, and re-reads behind its cursor each run |
| `INDEXER_MAX_BLOCK_RANGE` | Optional. The widest `eth_getLogs` window the owner scan and the usage ledger index ask for, from 1 to 10000. Unset, they start at 10,000 blocks and halve a window the provider refuses. Set it to the provider's cap where the cap is low (10 on a plan that allows ten blocks a query) |
| `TRUST_PROXY_HOPS` | Optional; defaults to `0`. An integer from 0 to 16: the exact number of proxies in front of the API, so the rate limiter keys on the real client (`1` behind a single TLS terminator) |
| `PORT` | Optional; defaults to `3333`, and a blank value means the default. An integer from 1 to 65535; anything else stops the process at startup, naming the variable |
| `API_HOST` | Optional; defaults to `127.0.0.1`, so only a reverse proxy on the same machine reaches the API. One IP address, never a host name; anything else stops the process at startup. Set `0.0.0.0` or `::` only when the proxy runs on another host, and then firewall the port so the proxy alone can reach it, because `TRUST_PROXY_HOPS` trusts whoever connects as the first hop |
| `RATE_MAX_REQUESTS` | Optional; defaults to `120` requests per client per minute on the tRPC surface. An integer from 1 to 100000; blank means the default and anything else stops the process at startup. A client is an IPv4 address or an IPv6 /64, and every IPv6 /48 shares a second bucket at sixteen times the limit; every call in a tRPC batch counts (read the way the tRPC adapter reads the request, so a fragment or a Host header cannot hide calls), a batch above 20 calls is refused with 400 and a request target the adapter cannot parse is refused with 400 as well |

**Keeper** (the `apps/keeper` process):

| Variable | Sepolia value |
| --- | --- |
| `KEEPER_PRIVATE_KEY` | Dedicated keeper EOA key. Provisioned in the keeper deployment ONLY, never in the API environment |
| `KEEPER_RPC_URL` | Sepolia RPC endpoint |
| `KEEPER_READ_RPC_URLS` | Optional. Comma-separated Sepolia endpoints for the keeper's reads, tried in order before `KEEPER_RPC_URL` |
| `KEEPER_CHAIN_ID` | `11155111` |
| `KEEPER_DRY_RUN` | Defaults to `"true"`; no transaction is ever sent unless this is explicitly set to `"false"` |
| `KEEPER_INTERVAL_SECONDS` | Defaults to `60` |
| `GOLD_VAULT_ADDRESS` | From `deployments/sepolia.json` |
| `GOLD_ORACLE_ADDRESS` | From `deployments/sepolia.json` |
| `STABILITY_MODULE_ADDRESS` | From `deployments/sepolia.json` |
| `GSUSD_ADDRESS` | From `deployments/sepolia.json` (operator-pinned: the keeper never learns transaction targets from the RPC) |
| `STABILITY_POOL_ADDRESS` | From `deployments/sepolia.json` (operator-pinned, same rule) |
| `PAXG_TOKEN` | Mock PAXG address (same value as the ceremony env) |
| `XAUT_TOKEN` | Mock XAUT address (same value as the ceremony env) |
| `VAULT_REGISTRY_ADDRESS` | From `deployments/sepolia.json`. The keeper reads the open-vault list from the registry and unions it with the API's indexer set, so the keeper liquidates even while the API is down or pointed at another deployment |

Sequencing: start the keeper in dry run, watch the JSON alert events for at
least one day, then set `KEEPER_DRY_RUN=false`.

Prove the armed keeper once before relying on it: `scripts/open-throwaway-vault.ts`
opens a borrower at 140% (its default) and prints its liquidation line and the
deployer's; walk the mock price under the borrower's line only
(`walk-testnet-price.ts`), and within one tick the keeper logs `keeper.tx-sent`
for `liquidateViaPool` or `liquidate` and the vault reads debt 0. Walk the price
back afterwards. Done twice on an earlier Sepolia deployment on 2026-10-21 (the second run
about four hours after the first, both within one tick: the pool absorbed the
debt, the keeper took 30% of the penalty); repeat it on the current one.

### 2.5 Exercise the full flow with the production multisigs

Run the automated drive first, so any regression surfaces before signers are
involved:

```bash
npx hardhat run scripts/rehearse-testnet-flow.ts --network sepolia
```

It covers items 1 to 8 below with exact-number assertions (seizure sizes, penalty
splits, spread and inventory, bad-debt absorption) and restores the price and pause
state when it finishes. Then have the proposer Safe signers actually sign these
transactions:

1. **Open and close a vault**: deposit, mint, repay, withdraw, with PAXG. On a guarded
   deployment do the same with XAUT; on an open one, the current Sepolia deployment
   included, XAUT is dormant and its deposit reverts.
2. **Force a liquidation**: drop the mock feed price, call `liquidate`. Verify
   the exact collateral seizure.
3. **Stability pool**: deposit some GSUSD, trigger `liquidateViaPool`, claim the
   collateral gain.
4. **Stability swap**: seed the reserve with
   `SEED_PAXG=20 npx hardhat run scripts/seed-testnet-reserve.ts --network sepolia`
   (`seedCollateral` is permissionless; the script refuses to run on mainnet),
   then call `swapGsusdForGold` to swap GSUSD for reserve gold. Confirm that
   every vault is unchanged (collateral, debt and ratio identical before and
   after) and that the surplus buffer's GSUSD balance grew by exactly the
   spread. Then empty the reserve through governance (`withdrawCollateral` to
   zero, or `setAssetConfig` with a `minReserve` above the balance) and
   observe the next swap revert `Reserve insufficient`. Swaps alone stop
   earlier at `Daily cap reached`, 20% of the day-start balance, which is
   worth observing too. Re-seed before continuing.
5. **Oracle gold band and freeze**: move the mock PAXG/USD feed more than the gold band
   (2%) away from the mock XAU/USD feed. `quoteBorrowPrice` and `quoteReservePrice` must
   revert `Off gold band`, so borrowing and reserve swaps stop, while `quoteTokenPrice` still
   answers: gold when PAXG sits below the band, G × 1.02 when above it. Let one mock feed go
   stale: every priced read reverts `No reliable price` and answers again on the next fresh
   round with no call. As the guardian, call
   `freezeToken(token)`: that token freezes for 14 days (`tokenFrozen(token)` is true,
   `frozenUntil(token)` is the block time plus `FREEZE_DURATION`, its reads revert
   `Token frozen`) while the other token keeps pricing and the oracle is not paused. Call it
   again and the freeze extends. Pause the oracle while it is frozen: `getEmergencyPrice(token,
   true)` still reverts `Token frozen`, because a pause does not lift the freeze. Lift it with `guardianUnfreezeToken(token, epoch)`, `epoch` read from
   `freezeEpoch(token)` just before the call, once a normal read succeeds again, which works
   while paused; left alone it lapses on its own. Confirm that an unfreeze naming the freeze
   before the extension reverts `Different freeze`.
6. **Emergency liquidation**: with the oracle paused by the guardian but the vault not, call
   `emergencyLiquidate`. It prices at the normal liquidation price, min(max(C, G), G × 1.02),
   and reverts `No price` while either mock feed is stale: `lastKnownPrice` never prices a
   seizure. Verify a single-feed glitch (move ONE feed far down, leave the other) does NOT
   allow seizing a vault that is healthy at gold.
7. **Bad-debt cascade**: set `badDebtPauseThreshold`, crash the price, run
   liquidations until the threshold trips. Vault should pause without reverting. Trip it
   again while paused (one more underwater liquidation through `emergencyLiquidate` or
   `liquidateViaPool`): the vault stays paused, `pausedAt` moves to that block,
   `pauseEpoch()` rises by one and an unpause scheduled before it reverts `Different pause`.
8. **Guardian pause**: a guardian-Safe signer calls `emergencyPause` on the
   vault. Verify mints and withdrawals revert. Deposits and repayments stay open
   by design (`deposit` and `repay` carry no pause guard) so a borrower can
   still protect a position during an incident.
9. **Governance unpause**: the proposer Safe reads `vault.pauseEpoch()` and
   schedules `unpause(epoch)` with that number, waits 48h, the executor calls
   `executeProposal` within the 7 day grace period. Vault unpauses. Then
   rehearse the other end of the window: schedule a second operation, let it
   pass 7 days after it became ready and confirm `execute` reverts
   `TimelockOperationExpired`, then cancel it from the proposer Safe as
   [The timelock queue](#the-timelock-queue) prescribes. Confirm too that an
   unpause naming an earlier pause reverts `Different pause`.
10. **Governance handover**: run `transfer-governance.ts` (see Step 4 below).
11. **Cost recovery withdrawal**: with the timelock now holding `GOVERNANCE_ROLE`,
    run `scripts/withdraw-surplus.ts` as a dry run, have the proposer Safe submit
    the printed `schedule` call, wait 48h, then run it again to execute (or have
    the executor Safe submit `execute`). The operations Safe receives the GSUSD
    and the buffer's `totalGsusdWithdrawn` grows by exactly that amount. The
    automatic 2% floor may leave no headroom, which is the policy working and
    cannot be lowered; rehearse with an amount inside the headroom the script
    reports. If a governed minimum above the automatic 2% floor is set, clear it for the rehearsal
    with `scripts/set-min-reserve.ts` (through the same timelock cycle) and
    restore it afterwards.

### 2.6 Soak

Let the Sepolia deployment sit for at least 14 days with the keeper service
and its redundant secondary running and monitoring live. Over the soak you
must observe, and be able to explain, each of the keeper's JSON alert events
at least once:

- `vault.liquidatable`: the keeper has spotted a vault below its liquidation
  ratio. Force one with the mock feeds and confirm the keeper acts on it.
- `oracle.feed-invalid` and `oracle.price-refused`: a source read failed validation (stale
  round or bad answer), so every priced path for the token refuses until it answers again.
  Freeze a mock feed past the staleness threshold to produce them, then refresh it and confirm
  pricing resumes with no call and the keeper liquidates again.
- `oracle.off-gold-band`: the market feed left the gold band. Move the PAXG mock feed more than
  2% from the XAU/USD mock; confirm borrowing and reserve swaps are refused at once while
  liquidation still prices, at gold below the band and capped at G × 1.02 above it (the
  `oracle.premium-capped` alert). There is no circuit breaker to trip and no record to keep: the
  keeper only alerts.
- `vault.pool-underfunded`: a pool liquidation was skipped because pool
  deposits did not strictly exceed the debt to absorb. Drain the pool, force
  a liquidation and confirm the alert fires instead of a wasted transaction.
- `keeper.tx-failed`: a keeper transaction reverted or failed to land.
  Produce one deliberately (for example by underfunding the keeper EOA on a
  throwaway run) and confirm the alert fires.

**Any unexplained event aborts the timeline.** Investigate, fix and redo the
rehearsal.

---

## Step 3: Mainnet deploy day (about 2 hours)

Book two hours with every Safe signer present, as `MAINNET.md` section 3 does. Run a final
local rehearsal in the morning before deploying.

### 3.1 Final pre-flight

```bash
npx hardhat test
```

Confirm every test passes, in Hardhat and in `forge test`.

The mainnet launch is PAXG-first (`docs/ORACLE_IMPLEMENTATION_PLAN.md`): PAXG priced from
Chainlink PAXG/USD (C) and Chainlink XAU/USD (G) under variant C, with no debt ceiling and no
per-block mint cap (`LAUNCH_CAPS=open`) and with XAUT registered in the oracle and otherwise
inactive. No mainnet deployment happens until every launch blocker in the plan's section 6 is
closed. The oracle has nothing to deploy ahead of the ceremony: the market feed step
(`scripts/deploy-market-feeds.ts`) has left it. Load `.env.mainnet` first
(`set -a; source .env.mainnet; set +a`; start from `.env.mainnet.example`).

**The preflight**, read-only:

```bash
npx hardhat run scripts/preflight-mainnet.ts --network mainnet
```

It reads every knob with the same parser `deploy.ts` uses (`scripts/lib/launchEnv.ts`):
lists are trimmed and an empty value is refused rather than read as zero. A zero guardian is
refused by name and every ratio, penalty, fee, floor, band and cap is bounded by the limit the
receiving contract enforces, so nothing the preflight accepts can revert mid-ceremony. It
prints the effective value of every parameter, defaults included, as `param:` lines. It then
checks the chain id, every address against the inventory in `docs/ORACLES.md`, the tokens'
decimals and symbols, the oracle configuration below, the three Safes against the
written policy (proposer, executor and guardian each at least 2-of-3, the executor being
the zero address only where `ALLOW_OPEN_EXECUTOR=1` accepts it; a threshold above the owner count, a zero threshold, no owners, a repeated
owner or a zero-address owner is a `FAIL`, and a contract that does not answer `getThreshold()`
and `getOwners()` is a `FAIL` on mainnet and a `WARN` on a fork or testnet), the role
split (a Safe holding two of proposer, executor and guardian is a `FAIL` on mainnet and a
`WARN` on a fork or testnet), signers shared between the Safes (a `WARN`), distinctness from
the deployer, the deployer's balance against a gas estimate of the whole ceremony and that no
snapshot would be overwritten. `policy:TIMELOCK_EXECUTOR` states the executor policy: it
passes a restricted executor, fails the zero address and warns when `ALLOW_OPEN_EXECUTOR=1`
accepts it, saying what the acceptance costs.

Two further checks cover the Safes' owners and the fourth Safe. `safe:deployer-not-owner` is a
`FAIL` when the deployer is an owner of the proposer, executor, guardian or operations Safe:
the key is single-use and retired, so a Safe it sits on would be left a signer short. `OPERATIONS_SAFE` is optional and not part of the parameters hash; when set, the
preflight checks that it has code, answers as a Safe (`safe:operations`) and differs from the
three governance Safes and the deployer (`safe:operations-distinct`); unset on mainnet it is
a `WARN`, and a line left empty or with its placeholder is a `FAIL env:OPERATIONS_SAFE`.

The oracle configuration fails the launch, never warns, when:

- `LAUNCH_CAPS` is not `open`, the only mainnet profile (`backstop` is refused on mainnet: its
  maximum was derived under the retired pool design); `PAXG_DEBT_CEILING` is anything but unset
  or unlimited, or `PER_BLOCK_MINT_CAP` anything but unset or 0;
- `PAXG_FEED` is not the published Chainlink PAXG/USD, or the anchor is missing or not the
  published XAU/USD; either one stale, not 8 decimals or describing itself as another pair;
- `PAXG_GOLD_BAND_PPM` or `PAXG_LIQUIDATION_CLAMP_PPM` lies outside the oracle's bounds, or the
  liquidation cap is not below the headroom PAXG's liquidation ratio leaves above par;
- C sits more than the gold band from G (`gold-band:PAXG`);
- a retired variable is set (`PAXG_CONFIRM_FEED`, `XAUT_CONFIRM_FEED`, `PAXG_AGREEMENT_BAND_PPM`,
  `MARKET_FEEDS`): they are refused rather than ignored;
- XAUT is configured beyond its dormant oracle entry, or `XAUT_FEED` is set to anything but an
  `InactiveFeed` (leave it unset and `deploy.ts` creates one; the XAU/USD address is refused)
  (`xaut:dormant`);
- any configured feed is a `PythMarketFeed` or a `UniswapV3TwapFeed`. Both adapters are research
  code kept under `contracts/research/`, outside `contracts/src`; nothing deployed imports them.

Two findings state the configuration plainly when they pass: `recovery:PAXG` (the guardian may
freeze PAXG and unfreeze it once a normal read succeeds, and the emergency liquidation path
stays open while paused) and `xaut:dormant` (XAUT's oracle entry and nothing else). Any
`FAIL` line ends the day; `PREFLIGHT_EXPECT_CHAIN_ID=31337` runs the same checks on a
mainnet fork.

On a pass it writes `deployments/<network>.preflight.json`, the ceremony record: the
effective parameters, their keccak256 hash and every finding. `deploy.ts` parses the same
environment and prints the same record and hash. It refuses to run on mainnet (or anywhere
with `REQUIRE_PREFLIGHT_RECORD=1`, or wherever the record file exists) unless the record
is for this chain and this deployer and its hash matches. `verify-deployment.ts` then
compares the snapshot's config with the record (`preflight:record-matches-snapshot`), so
the chain is checked against what was approved, not only against what was deployed. Any
change to `.env.mainnet` means running the preflight again; commit the record next to the
snapshot.

The record is good for 60 minutes by the chain's clock (`PREFLIGHT_MAX_AGE_MINUTES` on the
deploy changes the limit) and carries each Safe's threshold and owners. `deploy.ts` refuses
an older record, reads the three Safes again before its first transaction and refuses when a
threshold, an owner or an address differs from the record. In both cases run the preflight
again, then deploy. A resume (`DEPLOY_RESUME=1`) is held to the Safe comparison but not to
the age limit. A record written before these fields existed is refused on mainnet.

### 3.2 Set up mainnet env

PAXG goes live on validated pricing from two Chainlink sources with no debt ceiling
(`LAUNCH_CAPS=open`) and a working recovery route; XAUT is registered and inactive. Edit
`.env.mainnet` and verify every address character by character before deploying: the tokens,
C and G against the inventory in `docs/ORACLES.md` section 1:

| Variable | Mainnet value |
| --- | --- |
| `RPC_URL` | Mainnet RPC |
| `PRIVATE_KEY` | Mainnet deployer (single-use, hardware-wallet derived) |
| `PAXG_TOKEN` | `0x45804880De22913dAFE09f4980848ECE6EcbAf78` |
| `XAUT_TOKEN` | `0x68749665FF8D2d112Fa859AA293F07A622782F38` |
| `PAXG_FEED` | C: Chainlink PAXG/USD `0x9944D86CEB9160aF5C5feB251FD671923323f8C3` (see note 1) |
| `XAU_USD_ANCHOR_FEED` | G: Chainlink XAU/USD `0x214eD9Da11D2fbe465a6fc601a91E62EbEc1a0D6` (MANDATORY; the gold reference only; see note 3) |
| `XAUT_FEED` | Unset: `deploy.ts` creates an `InactiveFeed` for XAUT's dormant oracle entry (see note 6) |
| `PAXG_GOLD_BAND_PPM` | `20000` (2%), g: borrowing and reserve swaps need C within this of G (see note 2); 5000 to 100000 |
| `PAXG_LIQUIDATION_CLAMP_PPM` | `20000` (2%), m: liquidation never values PAXG above G × (1 + m); 5000 to 50000 and below the liquidation ratio's headroom |
| `LAUNCH_CAPS` | `open`: no debt ceiling, no per-block mint cap, PAXG only, XAUT dormant (see the cap profile below) |
| `PAXG_DEBT_CEILING` | Unset (or `unlimited`) |
| `PER_BLOCK_MINT_CAP` | Unset (or `0`); any other value is refused |
| `STALENESS_THRESHOLD` | `90000` (see note 4) |
| `MIN_GSUSD_RESERVE` | `0` (see note 5) |
| `MIN_DEBT_GSUSD` | `1000`: the liquidator keeps 60% of the 5% penalty, 3% of the debt repaid, and at mainnet gas that share on a 1,000 GSUSD vault is what makes the smallest liquidation worth sending; governance can move it between 100 and 10,000. The preflight (`policy:MIN_DEBT_GSUSD`), the mainnet gate in deploy.ts and verify-deployment (`policy:minDebt-at-launch`, acknowledged later with `ALLOW_MIN_DEBT_CHANGE=1`) all assert this figure, so the 100 default cannot reach mainnet unnoticed |
| `UNDERWATER_DISCOUNT_PPM` | `20000` (default; at most 50000) |
| `TIMELOCK_PROPOSER` | Mainnet proposer Safe |
| `TIMELOCK_EXECUTOR` | Mainnet executor Safe. The zero address is refused unless `ALLOW_OPEN_EXECUTOR=1` accepts it (see [Executor policy](#executor-policy)) |
| `TIMELOCK_GUARDIAN` | Mainnet guardian Safe |
| `OPERATIONS_SAFE` | Mainnet operations Safe: a fourth Safe that holds no role. Optional for the preflight and not part of the parameters hash; when set it must have code, answer as a Safe and differ from the three above and from the deployer |

Notes on these values:

1. **`PAXG_FEED`**: an earlier revision of this guide listed
   `0x9B97304EA12EFed0FAd976FBeCAad46016bf269e`, which is not an
   AggregatorV3 contract (both `description()` and `decimals()` revert on
   mainnet). The value above returns `PAXG / USD` with 8 decimals, matches
   the RPC-confirmed inventory in `docs/ORACLES.md` section 1 and the
   preflight's inventory. Verify it again at deploy time.
2. **The pricing rules** (variant C, plan section 3): borrowing needs C and G healthy and C
   within the gold band and prices at min(C, G); reserve swaps need the same and price at
   max(C, G); liquidation, trigger and settlement alike, prices at min(max(C, G), G × (1 + m)).
   With either feed unhealthy every priced path refuses (`No reliable price`) and resumes by
   itself on the first healthy pair, with no call, role or keeper step. A push of C down values
   PAXG at gold at worst, a push up holds off a liquidation by at most m and a PAXG-specific
   depeg is never liquidated (the project's accepted trade-off, borne by GSUSD holders).
   `deploy.ts` sets the anchor and, only where they differ from the oracle's 2% defaults,
   `setGoldBand` and `setLiquidationClamp` for PAXG while the deployer still holds governance,
   and on mainnet refuses before any transaction when the anchor is missing or equals C, or any
   configured feed is a Pyth or Uniswap TWAP adapter.
3. **`XAU_USD_ANCHOR_FEED`**: MANDATORY. `scripts/deploy.ts` hard-aborts a
   mainnet deploy without it, before the first transaction. It is the gold reference that
   bounds C and corroborates every gold-wide move; it is never a token's market price.
4. **`STALENESS_THRESHOLD`**: 90000 seconds covers the 24 hour feed
   heartbeat plus grace. A tighter value bricks the protocol on quiet days
   (`docs/ORACLES.md` section 2).
5. **`MIN_GSUSD_RESERVE`**: stays 0, and the preflight refuses anything else. The 2 percent
   of supply policy floor in `docs/BUSINESS_MODEL.md` section 5 is automatic: `SurplusBuffer`
   keeps 2% of the larger of the live and one day smoothed supply by itself, so no governance
   step raises it. This variable only sets an optional higher governed minimum.
6. **`XAUT_FEED`**: the oracle's constructor registers XAUT (its address is an immutable), so
   it needs a feed. Leave `XAUT_FEED` unset: `deploy.ts` first deploys an `InactiveFeed`
   (`contracts/src/oracle/InactiveFeed.sol`: 8 decimals, the description `Inactive` and an
   all-zero round that every validated read treats as stopped), registers XAUT on it and
   records its address in the snapshot as `config.xautFeed` with `xautFeedDeployed: true`; the
   Etherscan verifier then verifies it with the rest. XAUT prices nothing (`No reliable price`).
   The XAU/USD address cannot serve: `GoldOracle.setAnchorFeed` refuses an anchor a token uses
   as its feed. Nothing else about XAUT is configured: no collateral type, stability fee,
   reserve asset or stability pool token. Under `open` the
   preflight and `deploy.ts` refuse `XAUT_DEBT_CEILING`, `XAUT_MIN_RATIO`, `XAUT_LIQ_RATIO`,
   `XAUT_LIQ_PENALTY`, `XAUT_STABILITY_FEE_BPS`, `XAUT_CONFIRM_FEED` and
   `RESERVE_MIN_RESERVE_XAUT`. See [XAUT activation](#xaut-activation).

**The cap profile** is `LAUNCH_CAPS=open`, the project decision of 29 October 2026 and the only
mainnet profile: no debt ceiling and no per-block mint cap from block one, PAXG the only active
collateral and XAUT registered in the oracle and otherwise dormant. The minimum debt, the
bad-debt auto-pause, the silo cap and the reserve's daily caps stay armed.
`verify-deployment.ts` asserts the open state as `policy:open-launch.*` and
`policy:mainnet-profile`.

`LAUNCH_CAPS=backstop` is refused on mainnet by the preflight and `deploy.ts`. Its maximum
(`PAXG_BACKSTOP_MAX`, 5,000,000 GSUSD) was derived under the retired pool design, from a D*
the model no longer supports, and has not been re-derived for variant C.

`LAUNCH_CAPS=guarded`, the default when the variable is unset, remains for testnets, rehearsals
and the end-to-end harness with both tokens active: it deploys both ceilings at zero and arms
the per-block cap. The preflight and a mainnet deploy refuse it. The current Sepolia
deployment runs `open`, the mainnet shape.

#### Executor policy

The executor is a Safe. `GoldGovernance` deploys an `ExpiringTimelockController`: an operation
can be executed from the moment it becomes ready until `GRACE_PERIOD` (7 days) later, and after
that `execute` and `executeBatch` revert `TimelockOperationExpired` for good, so a decision that
missed its window is scheduled again and waits out the delay again. Within the window the
executor chooses the moment. With the zero address among the executors that choice belongs to
anyone, and a superseded parameter proposal could reverse the decision that replaced it. An
unpause can no longer lift a hold re-asserted after it was approved. It names the pause it was
approved for (`pauseEpoch()`, or `assetPauseEpoch(token)` on the reserve), and every pause,
extension, renewal and breaker trip takes a new number, so against any later one it reverts
`Different pause`. A governance unfreeze names its freeze the same way (`freezeEpoch(token)`)
and reverts `Different freeze`. The preflight (`policy:TIMELOCK_EXECUTOR`) and the mainnet gate in
`deploy.ts` therefore refuse the zero address unless `ALLOW_OPEN_EXECUTOR=1` is set, and the
acceptance belongs in the ceremony record with its reason. Under either executor the proposer
Safe keeps the queue clean ([The timelock queue](#the-timelock-queue)); under an open one that
step is the only control left.

### 3.3 Deploy

```bash
npx hardhat run scripts/deploy.ts --network mainnet
```

The script writes `deployments/mainnet.json`, with PAXG's gold band and liquidation cap,
`launchCaps: "open"` and `xautActive: false` in its `config`.

Never speed up or cancel a ceremony transaction from a wallet; the ceremony never replaces
one itself. A transaction not mined within 20 minutes (`DEPLOY_WAIT_TIMEOUT_MINUTES`) stops
the run with its hash and the deployer nonce printed, and `DEPLOY_RESUME=1` carries on once
it is mined. A creation replaced by hand all the same is adopted with
`DEPLOY_RESUME=1 DEPLOY_REPLACED_CREATION=<hash>` after the chain confirms it is the same
creation. `MAINNET.md` section 3.3 is the operator's account. The deploy ends by naming the
one handover command and by reminding you that the shell still exports the deployer key.

### 3.4 Verify

```bash
npx hardhat run scripts/verify-deployment.ts --network mainnet
```

Every check must pass. If anything fails, stop. Do not transfer governance
on a broken deployment. Among them: `oracle:paxg.goldBandPpm` and
`oracle:paxg.liquidationClampPpm`, `oracle:anchorFeed`, `policy:open-launch.ceilings-unlimited`
and `policy:open-launch.perBlockMintCap-off`, `policy:mainnet-profile` (open, XAUT dormant), live
`quoteTokenPrice` and `quoteBorrowPrice` views for PAXG and XAUT inactive everywhere:
`xaut:inactive.collateral-type`, `xaut:inactive.debt-ceiling`, `xaut:inactive.stability-fee`,
`xaut:inactive.reserve-asset` and `xaut:inactive.pool-token`.

### 3.5 Etherscan source verification

Verify every contract on Etherscan so users can read the source:

```bash
npx hardhat run scripts/verify-etherscan.ts --network mainnet
```

The script reads `deployments/mainnet.json`, rebuilds each constructor (including the
TimelockController that `GoldGovernance` creates: 48 hours, the configured proposers and
executors each with the wrapper appended, no admin), reads the address of the CollateralSilo
implementation from the SiloFactory and submits all fourteen contracts. It is
safe to re-run until each reports `verified` or `already verified`; `ONLY=<label>` retries
one.

### 3.6 Cut the services over to mainnet

The dApp, the indexer and the keeper are per-chain deployments. Stand up the
mainnet set alongside the Sepolia set; do not repoint the Sepolia instances.

Print the three environment blocks from the snapshot rather than retyping addresses:

```bash
npx hardhat run scripts/print-service-env.ts --network mainnet
```

Secrets and endpoints come back as placeholders. The dapp is served from its own origin
(IPFS behind the ENS name, plus a DNS mirror), so its block carries `VITE_API_URL` and the
API block sets `CORS_ORIGINS` to both launch origins,
`https://goldstandardfinance.eth.limo,https://goldstandard.finance` (`SITE_URL` replaces the list with one
origin or a comma-separated list; `*` serves a fully public API), `NODE_ENV=production`
and `REDIS_URL`. On mainnet the dapp block leaves the Uniswap variables out, so the swap page
shows the reserve alone until a GSUSD/PAXG 0.30% pool is seeded and the block is printed
again with `DEX_MARKET=1` (`MAINNET.md` section 4.1); the API can instead serve a dapp build itself from one origin when
`DAPP_DIST` points at it (server layout in `MAINNET.md` section 4). The keeper block names
`VAULT_REGISTRY_ADDRESS` and no Redis for any deployment with a registry, plus the two fee
ceilings `KEEPER_MAX_FEE_GWEI` and `KEEPER_MAX_PRIORITY_FEE_GWEI`. For an older
deployment without a registry it names the API's exact `REDIS_URL` and `REDIS_NAMESPACE`.

**dApp** (a separate mainnet build; the printer's block above is the complete
list, this table names the variables most worth checking):

| Variable | Mainnet value |
| --- | --- |
| `VITE_TARGET_CHAIN_ID` | `1` |
| `VITE_PAXG_ADDRESS` / `VITE_XAUT_ADDRESS` | `config.paxgToken` and `config.xautToken` from `deployments/mainnet.json`; unset falls back to the real PAXG and XAUT |
| `VITE_GOLD_VAULT_ADDRESS` | From `deployments/mainnet.json` |
| `VITE_STABILITY_MODULE_ADDRESS` | From `deployments/mainnet.json` |
| `VITE_GUSD_ADDRESS` | From `deployments/mainnet.json` |
| `VITE_STABILITY_POOL_ADDRESS` | From `deployments/mainnet.json` |
| `VITE_STABILITY_RESERVE_ADDRESS` | From `deployments/mainnet.json` (the `reserve` key) |
| `VITE_DEPLOY_BLOCK` | `deployBlock` from the deployment snapshot; the vault page activity feed reads events from this block |
| `VITE_GOLD_ORACLE_ADDRESS` | From `deployments/mainnet.json` |
| `VITE_SURPLUS_BUFFER_ADDRESS` | From `deployments/mainnet.json` |
| `VITE_WALLETCONNECT_PROJECT_ID` | Your WalletConnect project ID |
| `VITE_MAINNET_RPC_URL` | One or two https endpoints separated by a comma, the preferred one first; the dapp fails over to the second. Browser keys only: separate from the keeper's and the API's, rate-capped, with both site origins allowlisted where the provider supports it and `eth_getLogs` served over at least 50,000 blocks |
| `VITE_API_URL` | The API's public tRPC endpoint, for example `https://api.goldstandard.finance/trpc`; unset means same-origin `/trpc` |
| `VITE_SOURCE_URL` | The public repository; the footer links its build commit there |

Plainly: the target chain is baked into the bundle at build time via
`import.meta.env`. One dApp build serves exactly one chain and there is no
runtime chain switcher. The Sepolia and mainnet frontends are separate
builds and separate deployments.

**Indexer** (the `apps/api` process):

| Variable | Mainnet value |
| --- | --- |
| `SEPOLIA_RPC_URL` | A mainnet RPC endpoint. Historical name: this is the RPC for whichever chain `INDEXER_CHAIN_ID` selects, NOT necessarily Sepolia (see below) |
| `GOLD_VAULT_ADDRESS` | GoldVault from `deployments/mainnet.json` |
| `GOLD_VAULT_DEPLOY_BLOCK` | Block number of the mainnet GoldVault deploy transaction |
| `INDEXER_CHAIN_ID` | `1` |
| `INDEXER_CONFIRMATIONS` | `6` |
| `TRUST_PROXY_HOPS` | The exact hop count of the production ingress (`1` behind one load balancer); an integer from 0 to 16 |
| `PORT` | `3333` unless the ingress expects another port (blank means `3333`); an integer from 1 to 65535 or the process stops at startup |
| `API_HOST` | `127.0.0.1` when the proxy runs on the same machine (the default). Behind an ingress on another host, this machine's address on the private network the ingress uses, or `0.0.0.0` with a firewall that admits the ingress alone; one IP address or the process stops at startup |
| `RATE_MAX_REQUESTS` | `120` per client per minute unless measured traffic says otherwise; an integer from 1 to 100000 or the process stops at startup. Clients are keyed by IPv4 address or IPv6 /64, with each IPv6 /48 capped at sixteen times the limit, every batched call counts, batches above 20 calls are refused and a request the tRPC adapter cannot parse gets a 400 |
| `CORS_ORIGINS` | The site origins, as a comma-separated list of exact origins; the printer writes `https://goldstandardfinance.eth.limo,https://goldstandard.finance`. Unset means same origin only. Use `*` only when the API is meant to be readable from any origin |
| `DAPP_DIST` | Optional: a dapp build directory the API serves from its own origin. The build must hold `index.html` and the `_headers` file (the Vite build copies it from `apps/dapp/public`); the API sends those headers itself, adds HSTS only on requests that arrived over TLS behind `TRUST_PROXY_HOPS` and refuses `/_headers` and every dotfile path except `.well-known` |

Plainly: the `SEPOLIA_RPC_URL` variable name is retained for compatibility.
It is the RPC endpoint for whichever chain `INDEXER_CHAIN_ID` selects, so on
mainnet it must point at a mainnet RPC. The indexer asks the endpoint for its
chain id before its first run and refuses every run while the two differ, with
an error naming both ids; a failed check skips one run and is asked again on
the next. Start the mainnet indexer before the mainnet dApp build goes live.

The API answers `vaults.owners` with status `ok` only while the index is
current: a numeric cursor, a readable owner set that is not truncated, and a
run that reached its target block within the last five minutes (the
`vault-owners:<chain>:<vault>:syncedAt` key). A stalled indexer, a first sync
or a rebuild that has not finished, or a missing set all answer `unavailable`,
and the Liquidations page then walks the on-chain VaultRegistry instead. The
answer is shared for five seconds per chain. A provider rate limit, by HTTP
status 429 or by wording such as "request rate exceeded", ends that run and the
next run resumes from the cursor a minute later; only a refusal of the block
range narrows the `eth_getLogs` window.

**Keeper** (the `apps/keeper` process):

| Variable | Mainnet value |
| --- | --- |
| `KEEPER_PRIVATE_KEY` | Dedicated mainnet keeper EOA key. Keeper deployment ONLY, never the API environment |
| `KEEPER_RPC_URL` | A mainnet RPC endpoint: the one the keeper signs and sends through (a private relay such as Flashbots Protect, per `MAINNET.md` section 4.7) |
| `KEEPER_READ_RPC_URLS` | Optional but recommended with a relay: comma-separated mainnet endpoints at other providers, for every read except the ones tied to sending |
| `KEEPER_READ_CACHE_MS` | Optional. How long one tick may reuse a read it has already made, in milliseconds. Default 4000; 0 turns the reuse off. A send turns it off for the rest of the tick in any case |
| `KEEPER_CHAIN_ID` | `1` |
| `KEEPER_DRY_RUN` | `"true"` until the governance handover verification in step 4 is green, then `"false"` |
| `KEEPER_INTERVAL_SECONDS` | `60` |
| `KEEPER_ENABLE_DIRECT` | **`"true"` from the moment the keeper is armed** (the open profile has no ceiling to wait for). Defaults to `false`. With the StabilityPool empty at launch, `liquidateViaPool` can never fire, so this is the ONLY armed liquidation path on day one |
| `GOLD_VAULT_ADDRESS` | From `deployments/mainnet.json` |
| `GOLD_ORACLE_ADDRESS` | From `deployments/mainnet.json` |
| `STABILITY_MODULE_ADDRESS` | From `deployments/mainnet.json` |
| `GSUSD_ADDRESS` | From `deployments/mainnet.json` (operator-pinned: the keeper never learns transaction targets from the RPC) |
| `STABILITY_POOL_ADDRESS` | From `deployments/mainnet.json` (operator-pinned, same rule) |
| `PAXG_TOKEN` | `0x45804880De22913dAFE09f4980848ECE6EcbAf78` |
| `XAUT_TOKEN` | `0x68749665FF8D2d112Fa859AA293F07A622782F38` |
| `VAULT_REGISTRY_ADDRESS` | From `deployments/mainnet.json` (same rule as Sepolia: on-chain owner discovery, independent of the API) |
| `KEEPER_FEED_HEARTBEAT_SECONDS` | `86400`: the longest a launch feed normally goes between writes (60 to 604800). Heartbeat plus the margin below must stay at least two seconds below the oracle's `stalenessThreshold` (90,000 at launch) |
| `KEEPER_FEED_LATE_MARGIN_SECONDS` | `900`: `oracle.feed-late` fires at warn when a feed that still prices is older than the heartbeat plus this margin (0 to 86400). The range is wider than what works: against 90,000 a margin of 3,599 or more leaves the warning no room before the refusal. The keeper then logs `oracle.feed-late` with no `source` field, naming both settings, and warns at the heartbeat alone, or at half the threshold when the heartbeat is not below it either. Lower the margin when that line appears, and whenever governance lowers `stalenessThreshold` |
| `KEEPER_FEED_LATE_REPEAT_SECONDS` | `3600`: while a feed stays late the warning repeats at most this often (60 to 86400) |
| `KEEPER_HEARTBEAT_URL` | Optional, no default. The https URL of a hosted dead-man check; the keeper sends a GET after every tick that finished with no job error and a recent chain head, allows the whole exchange 5 seconds and discards the response body. Https with a host and no user name or password, or the keeper stops at start. A secret: only its host is ever logged. Set the check's grace to 10 minutes |

Keep `KEEPER_DRY_RUN=true` until every `gov:*` check in step 4 passes. Only
then set it to `"false"` and restart the keeper and its secondary. The secondary has its own
key, its own ETH and its own GSUSD float; two keepers never share a key.

The keeper logs `keeper.heartbeat` at info once per completed tick, with `ok` false when a
job logged `keeper.job-error`, the head read failed or the head is older than 600 seconds,
and with the counts since the previous heartbeat (`vaultsWalked`, `vaultsWithDebt`,
`blockedLiquidations`, `failedLiquidations`, `unknownOutcomes`, `jobErrors`, `ticksSkipped`).
The absence of an `ok` true heartbeat for 10 minutes is the dead-man signal. The line is
written at the end of a tick, and one direct liquidation can hold a tick for up to 540
seconds (three receipt waits of 180 seconds), so a shorter grace pages a keeper that is
liquidating. `MAINNET.md` section 4.7, "Alerting", has the paging rules, what to check when
the dead-man rule fires during a run of liquidations and the full list of events to page on.

How the keeper uses its endpoints and its time, so the logs read as expected:

- **Reads and sends.** Nonces, fee and gas estimates, simulations, sends and receipts
  always go to `KEEPER_RPC_URL`, so the pending transaction guard sees the mempool its
  own sends went to. Every other read (owner lists, vault and oracle state, the wallet
  balance) goes to the `KEEPER_READ_RPC_URLS` entries in order, moving to the next on an
  HTTP error, a rate limit or a timeout, and to `KEEPER_RPC_URL` last; a contract revert
  never moves on. At start each entry is asked for its chain: one that answers another
  chain stops the keeper, one that does not answer logs `keeper.read-rpc-unavailable`
  and is left out until the next restart. Both name the entry by its position in the
  variable as written, blank and repeated entries included. `keeper.started` reports
  how many answered as `readRpcEndpoints`. No URL is logged beyond its scheme and host.
- **First tick.** The keeper runs its first tick as it starts, then one per
  `KEEPER_INTERVAL_SECONDS`, so a deploy or a crash restart is not blind for an interval.
- **Stopping.** A stop waits up to 60 seconds for the tick in flight, inside systemd's
  default 90 second stop timeout, then exits cleanly and logs
  `keeper.shutdown-tick-abandoned`. A transaction that tick broadcast is not lost: the
  restarted keeper finds its nonce outstanding and waits for it.
- **A transaction that never mines** holds the tick in its receipt wait for three minutes
  (viem's default), then is reported as `keeper.tx-outcome-unknown`. Where the endpoint
  reports it in the pending nonce, every later send is refused until it mines or,
  after `KEEPER_STUCK_TX_REPLACE_SECONDS` (300 by default) from its send, is replaced. These
  timings are deliberate: the replacement age stays above the receipt wait so a slow
  transaction is never cancelled while the keeper still waits for it, and a shorter
  receipt wait would free nothing, since the guard refuses the next send either way. A
  restart counts the age again from when the keeper first sees the nonce, because the
  restarted process cannot tell a stuck transaction from one sent seconds before.
  Flashbots Protect holds a transaction that would revert for up to six minutes and
  counts it in the pending nonce only for requests signed by the sender, which the
  keeper does not sign; so behind Protect the guard sees the confirmed nonce, the losing
  side of a race with the second keeper costs one receipt wait, and the next send reuses
  that nonce. Start the second keeper half an interval after the first, so the two do not
  walk the same vaults in the same seconds.

---

## Step 4: Governance handover (irreversible, ~5 minutes)

This is the single most important step. After this, the deployer EOA has zero
control over the system. **Run it the same day as deployment**: every minute
between deploy and handover is a minute where the deployer EOA can be compromised
and used to backdoor the system.

```bash
CONFIRM=YES npx hardhat run scripts/transfer-governance.ts --network mainnet
```

The script:

1. Refuses to run without `CONFIRM=YES`.
2. Refuses if the snapshot says governance is already transferred.
3. Refuses if the connected signer is not the recorded deployer.
4. Reads who administers each contract, all at one block, and plans only the
   transactions still owed. On a first run that is all ten. On a run that
   follows one which stopped part way (a dropped endpoint, a fee spike, an empty
   wallet) it is the remainder: run the same command again once any pending
   transaction has confirmed, and never finish the sequence by hand. It refuses
   an admin state the handover never leaves behind, naming the contract.
5. Takes the role census at that same block, with the deployer as the authority
   on each contract it still administers and the timelock on each contract
   already handed over, and refuses, before the first transaction it sends, on
   any holder the ceremony did not intend or a timelock without the 7 day grace
   period. `transferGovernance` revokes the caller alone, so a key granted a
   role beforehand would survive the handover; on a contract the deployer still
   administers it can still revoke that key.
6. Transfers governance on every contract still owed, in this order:
   1. `GoldStablecoin.transferGovernance`
   2. `GoldOracle.transferGovernance`
   3. `GoldVault.transferGovernance`
   4. `StabilityModule.transferGovernance`
   5. `SurplusBuffer.transferGovernance`
   6. `StabilityPool.transferGovernance`
   7. `GoldStabilityReserve.transferGovernance`
   8. `GoldGovernance.transferGovernance` (the wrapper itself)
   9. `SiloFactory.grantRole(DEFAULT_ADMIN_ROLE, timelock) + renounceRole`
7. Verifies on-chain that the deployer holds no admin role anywhere, then takes
   the role census again with the timelock as the authority, both at one block
   that is not behind the last transaction it sent.
8. Marks the snapshot with `governanceTransferred: true`. A run that found
   nothing left to send verifies and marks it all the same.

### Confirm

```bash
EXPECT_GOVERNANCE_TRANSFERRED=1 npx hardhat run scripts/verify-deployment.ts --network mainnet
```

Every `gov:*.deployer-revoked`, `gov:*.timelock-admin` and `census:*` check, and
`timelock:grace-period-7d`, must pass. If any fail, that contract is in an
inconsistent state: **page the on-call team immediately**. The system should not
accept TVL until every check is green.

**The role census.** A check that asks whether a named key holds a named role
cannot see a second holder of that role, so the census (`scripts/lib/roleCensus.ts`)
rebuilds each role's whole holder set and requires exactly the set below. It reads
`GoldStablecoin` and `SiloFactory` with `getRoleMember` (both are
`AccessControlEnumerable`) and replays the `RoleGranted` and `RoleRevoked` logs of
every contract from the first creation block `deploy.ts` records in the snapshot
(`creationBlocks`; for an older snapshot it locates that block on chain), then
confirms each holder with `hasRole`:

| Contract | Role | Exact holders after the handover |
| --- | --- | --- |
| Every governed contract, the wrapper included | `DEFAULT_ADMIN_ROLE` | The timelock |
| `GoldOracle`, `GoldVault`, `StabilityModule`, `SurplusBuffer`, `StabilityPool`, `GoldStabilityReserve` | `GOVERNANCE_ROLE` | The timelock |
| `GoldStablecoin` | `MINTER_ROLE` | The vault |
| `StabilityModule`, `StabilityPool`, `GoldStabilityReserve`, `SiloFactory` | `VAULT_ROLE` | The vault |
| `SurplusBuffer` | `VAULT_ROLE` | The vault and the reserve |
| `GoldOracle`, `GoldVault`, `StabilityPool`, `GoldStabilityReserve` | `GUARDIAN_ROLE` | The guardian Safe |
| `SiloFactory` | `LOCKED_ROLE` | Nobody |
| `GoldGovernance` | `PROPOSER_ROLE`, `EXECUTOR_ROLE` | The configured proposer and executor Safes |
| The timelock | `PROPOSER_ROLE`, `CANCELLER_ROLE` | The proposer Safes and the wrapper |
| The timelock | `EXECUTOR_ROLE` | The executor Safes and the wrapper |
| The timelock | `DEFAULT_ADMIN_ROLE` | The timelock itself |

Before the handover the deployer stands where the timelock stands in the first two
rows. A role no contract defines fails as soon as anyone holds it
(`census:<contract>.unknown-roles`), and `census:deployer` fails while the deployer
holds any role the configuration does not name it for.

---

## Step 5: The first weeks after launch (4-8 weeks)

Every parameter change goes through the timelock now. Every step below is a
48-hour proposal cycle. Pace accordingly.

Under `LAUNCH_CAPS=open`, the mainnet launch, there is no ramp: PAXG's ceiling is already
unlimited and the per-block cap is off, and XAUT stays dormant until
[XAUT activation](#xaut-activation). Skip the ceiling proposals below and keep every other
condition of this step as a weekly review, in particular the liquidation float, the
buffer against its automatic reserve floor and the `verify-deployment.ts` run, which asserts the open state as
`policy:open-launch.*`.

`LAUNCH_CAPS=backstop` is refused on mainnet. The ceiling proposals below describe a guarded
deployment on a testnet; keep every other condition of this step as a weekly review on mainnet.

### Week 1: open the system

On a guarded testnet only, propose through the timelock:

```text
vault.setDebtCeiling(PAXG, 250_000e18)
vault.setPerBlockMintCap(50_000e18)
```

For the ceiling, `scripts/print-ceiling-proposal.ts` prints both Safe transactions: the
proposer Safe's `proposeDebtCeilingUpdate` now and the executor's `executeProposal` for 48
hours later (`CEILING_GSUSD=250000`, `--network <net>`). Paste each into the Safe Transaction
Builder. The operation carries the ceiling alone; ratios and the penalty change only through
`proposeCollateralRatioUpdate` (`GoldVault.updateCollateralRatios`), so neither kind of pending
proposal can restore what the other changed while it waited. Execute within 7 days of the
operation becoming ready, or it expires and must be proposed again.

On mainnet XAUT is not a collateral type until [XAUT activation](#xaut-activation); on a
guarded testnet `scripts/ramp-testnet-ceiling.ts` raises both tokens' ceilings together.

System is live: on mainnet with no ceiling, on a guarded testnet with the first $250k of
ceiling. Before announcing, seed the GSUSD/USDC market from a protocol vault
(`MAINNET.md` section 5 item 3; its launch mint pays the origination fee): every borrower owes more GSUSD than they received, so until GSUSD can
be bought nobody can repay in full. You should open the first vault
yourself, run a stability swap against the reserve once the operations Safe has seeded
it with 0.05 PAXG (`MAINNET.md` section 5 item 5; the reserve ships empty and there is no conversion floor until it holds
gold) and let it sit for a week.

### Weeks 2-8: weekly checks, and the ramp on a guarded testnet

If, and only if, **every** condition below is true at the end of a week:

- Zero unexplained events
- No oracle refusal or gold band breach without a known cause
- No bad-debt events
- No vault sitting below 115% CR for more than 5 minutes
- Surplus buffer balance growing
- Reserve coverage (`coveragePpm`, redeemable reserve value against circulating
  supply) not falling week on week without a known cause, and no asset paused
- The keeper service and its secondary acting on every `vault.liquidatable`
  alert within SLA, with no unexplained `keeper.tx-failed` events
- **No `keeper.no-liquidation-path` and no `vault.liquidation-blocked` event in
  the last 24h.** The keeper emits `keeper.no-liquidation-path` every tick while
  the StabilityPool falls short of its yardstick AND the direct path is disabled
  or cannot cover even a minimum-debt vault (a wallet below `minDebt` plus 1% plus
  1 wei: 1,010 GSUSD at the 1,000 GSUSD mainnet `minDebt`, 101 GSUSD at the
  testnet harness's 100), that is, while it can alert but cannot actually
  liquidate. The pool's yardstick is the debt ceiling on a capped deployment.
  Under `LAUNCH_CAPS=open` the ceiling is unlimited (MaxUint256) and no pool can
  reach it, so the yardstick is the largest vault debt the keeper read that tick,
  or `minDebt` when no vault owes more, and the pool must exceed it, because the
  pool absorbs only a debt below its deposits. The event names the yardstick in
  `poolYardstick` (`debt-ceiling`, `largest-vault-debt` or `min-debt`) and
  `poolYardstickAmount`. It also emits it while it has not read `GoldVault.minDebt` since it
  started: the wallet cannot be measured against a figure that was never read, so
  the direct path is not counted as armed, although a liquidation sized by the
  vault's own debt still goes through. An occurrence whose detail names
  `GoldVault.minDebt`, beside `keeper.min-debt-unreadable`, is that read failure:
  it has a known cause, clears at the first successful read and does not by itself
  fail this gate. It emits `vault.liquidation-blocked` at error for each liquidatable
  vault that neither the pool nor its wallet can take. A wallet that covers only part of a
  vault's debt sends the largest partial the vault accepts and logs
  `vault.partial-direct-liquidation` at warn with `uncoveredDebt`: the vault's gold must still
  be worth at least its debt, and the partial must be at least `minDebt` and leave at least
  `minDebt` behind. An underwater vault is never sent a partial. Treat that warn as a float
  that is too small and refill it (`MAINNET.md` section 4.7, "The GSUSD float"). The first event clears at
  that small float, so its absence alone
  does not prove the wallet covers the exposure: the second event and the funding
  below do. Before borrowing is announced (on a guarded deployment, before the FIRST
  non-zero ceiling) this gate must be satisfied concretely, by either:
    a. seeding the StabilityPool with protocol-owned GSUSD above the week's
       ceiling (under `LAUNCH_CAPS=open`, above the largest vault's debt,
       checked weekly), or
    b. setting `KEEPER_ENABLE_DIRECT=true` AND funding the keeper wallet with
       GSUSD to at least the week's ceiling (under `LAUNCH_CAPS=open`, which has
       no ceiling, above the largest vault's debt plus 1%, checked weekly).
  Then prove it end to end: execute one deliberate test liquidation on mainnet
  and confirm the `vault.liquidated-via-pool` or `vault.liquidated-direct` event. An
  untested liquidation path is not a backstop.
- **Snapshot refreshed after any parameter change.** `verify-deployment.ts` compares
  chain state against `deployments/<net>.json`, so a legitimate parameter change makes it
  fail forever and the gate stops being read. Run
  `npx hardhat run scripts/refresh-deployment-snapshot.ts --network <net>` after the
  change lands, then re-run verification: any remaining failure is a real one.
- **The reserve floor enforces 2% of outstanding GSUSD supply.** This is the
  on-chain guarantee that governance cannot drain the first-loss reserve
  (`docs/BUSINESS_MODEL.md` section 5), and it is automatic: `SurplusBuffer`
  refuses any withdrawal below `effectiveMinGsusdReserve()`, 2% of the larger of
  the live and one day smoothed supply, or the governed `minGsusdReserve` if that
  is higher. Nothing needs raising as supply grows. `verify-deployment.ts` check
  `treasury:reserve-floor-enforces-2pct-policy` asserts on every run that the
  rate is 2% and that the floor the contract reports matches the policy computed
  from the same block; a buffer without the automatic floor fails. Treat a
  failure as a hard stop. `scripts/set-min-reserve.ts` remains for an optional
  higher minimum only.
- **No timelock operation pending that governance no longer intends.** Run the
  weekly review in [The timelock queue](#the-timelock-queue) and cancel what it
  finds before ramping.
- **No sustained `oracle.price-stale` or `vault.liquidatability-degraded`
  events.** The first means `lastKnownPrice` has drifted beyond the poke band
  (every stale-price consumer, including the dapp's health display, is wrong by
  that much); the second means the keeper lost the live feed and is judging
  liquidatability on stale data.

Then, on a guarded deployment, double the debt ceilings the following Monday.
Otherwise pause and investigate before ramping further.

### Steady state

Once you have settled into a comfortable TVL band (typically 4-8 weeks in), let the
system run; on a guarded deployment, fix the ceilings at that level. Any later parameter
change goes through the same 48h timelock cycle. So does cost recovery: `scripts/withdraw-surplus.ts`
moves revenue above the reserve floor to the operations Safe (policy in
[`BUSINESS_MODEL.md`](BUSINESS_MODEL.md) section 5), scheduling on the first run
and executing on the next once the delay has passed. It refuses a `WITHDRAW_TO` that is the
deployer or the proposer, executor or guardian Safe recorded in the snapshot, with or
without `WITHDRAW_TO_EOA=YES`.

Then close the last governance power that could ever mint: schedule
`GoldStablecoin.lockMinters(vault)` through the timelock, with the vault's address. Do it as
early as the plan allows: the first clean weekly check of step 5 is the earliest sensible
moment, and the only reason to wait is an open question about replacing the vault, which
the lock rules out. Until it executes, a `RoleGranted` for `MINTER_ROLE` is an alarm
(pre-launch checklist). The other lock, the silo factory's `VAULT_ROLE`, needs no step: the
ceremony takes it at deploy (`SILO_LOCK_VAULT_ROLE`, true unless set otherwise) and
`verify-deployment.ts` asserts it. It
succeeds only while the vault is the sole `MINTER_ROLE` holder and the timelock the sole
`DEFAULT_ADMIN_ROLE` holder (both sets are enumerable, so anyone can read them), so a key
planted before the handover can never be frozen inside the lock: revoke it through the
timelock first, best as one `scheduleBatch` with the lock, so the lock never runs without its
precondition. It is one-way; after it no key, the timelock included, can grant
`MINTER_ROLE` again (revocation stays possible), so a replacement vault would need a new
GSUSD. Execute it within 7 days of it becoming ready (the timelock's grace period). An
operation whose execution reverted stays pending until it expires, so have the proposer Safe
cancel it. The fork rehearsal runs this sequence (`scripts/rehearsal/s11-lock-minters.ts`).
Confirm with:

```bash
EXPECT_GOVERNANCE_TRANSFERRED=1 EXPECT_MINTERS_LOCKED=1 npx hardhat run scripts/verify-deployment.ts --network mainnet
```

Then record it where agents read it: set `"mintersLocked": true` in
`deployments/mainnet.json`, run `npx hardhat run scripts/print-agent-manifest.ts` and publish
the result, so `agents.json` stops describing the minter set as changeable.

From this point a lost key can delay the system but never lock it: every pause
lapses after 14 days, the reserve's asset pause and the oracle's token freeze
included, and a vault with no debt can withdraw during any pause.

### The timelock queue

A scheduled operation stays pending until it is executed, cancelled or expired. A
call that reverts on execution unwinds without marking the operation done, so it
stays executable until its grace period ends, and the setters it calls apply their
value whatever has happened since it was scheduled, so a superseded proposal would
reverse the decision that replaced it. An `unpause(epoch)`, `unpauseAsset(token, epoch)` or
`guardianUnfreezeToken(token, epoch)` names the hold it was approved for and reverts
`Different pause` or `Different freeze` once that hold has been re-asserted, but cancel a
stale one all the same. The timelock's
7 day grace period bounds that window; the proposer Safe closes it. Every week, and
after every incident, every execution that reverted and every new proposal on a
record that already has one pending:

1. List the pending operations: every `CallScheduled` id on the timelock with no
   `CallExecuted` or `Cancelled` for it. `getOperationState(id)` returns `1`
   (Waiting) or `2` (Ready); `isOperationExpired(id)` is true once a Ready operation
   has passed its grace period.
2. Decide each one. Cancel it when it has been superseded by a later decision on
   the same record, when its execution reverted, when it lifts a pause that has
   already lapsed or been lifted, when it has expired or when governance no
   longer wants it.
3. Cancel from the proposer Safe (it holds `CANCELLER_ROLE`):
   `timelock.cancel(id)`. The `Cancelled(id)` event is the record.
4. Execute what remains inside its window. A decision that expired is proposed
   again and waits out the delay again.

The queue is also where a change of the vault's wiring shows. `setOracle`,
`setLiquidatorIncentiveShare`, `setSurplusBuffer`, `setStabilityPool`, `setSiloFactory` and
`setBadDebtPauseThreshold` emit no event of their own; after the handover each is called by
the timelock, so the `CallScheduled` and `CallExecuted` events, which carry the target and
the call data, are the record of it. Decode the data of every entry whose target is the vault.

One entry is an alarm, not a review item: a `CallScheduled` whose target is the stability
pool and whose call is `grantRole`. `StabilityPool.VAULT_ROLE` has no lock, unlike the silo
factory's vault role and the minter set, and a holder can call `absorbLiquidationPrefunded` with no
collateral sent and receive depositors' GSUSD. Reaching it needs a timelock operation, so the
defence is the 48 hours: alert on it (pre-launch checklist) and have the proposer Safe cancel
any grant governance did not intend.

---

## XAUT activation

XAUT is registered in the oracle at deployment and is otherwise inactive: not a vault collateral type,
not a reserve asset, not a stability pool token. It is activated by one governance batch through the
timelock once objective criteria are met, not on a date. Activation needs only a Chainlink-style
XAUT/USD push feed that passes them, priced by the same rule against XAU/USD; no pool is involved. The
criteria, the batch and its governance implications are in [`XAUT_ACTIVATION.md`](XAUT_ACTIVATION.md).

After the batch has executed, record it (`XAUT_ACTIVATION.md` section 4, "After the batch"):

```bash
XAUT_ACTIVATED=1 npx hardhat run scripts/refresh-deployment-snapshot.ts --network mainnet
EXPECT_GOVERNANCE_TRANSFERRED=1 npx hardhat run scripts/verify-deployment.ts --network mainnet
npx hardhat run scripts/print-agent-manifest.ts
```

Without `XAUT_ACTIVATED=1` the refresh refuses an activated XAUT and writes nothing.

## What to do if something is wrong

### A vault is undercollateralised and not being liquidated

1. Check the keeper logs for `vault.liquidatable` and `keeper.tx-failed`
   events.
2. Manually call `vault.liquidate(victim, 0)` from any address holding enough
   GSUSD. The caller must hold and approve GSUSD covering the debt being
   repaid; the vault pulls and burns it and pays the caller in collateral.
3. If no one holds enough GSUSD, call `vault.liquidateViaPool(victim, 0)`.
   This requires pool deposits strictly greater than the debt to absorb
   (equality is not enough) and pays the caller a bounty in collateral.
4. If neither works, the guardian pauses the vault to stop further damage.

### Oracle prints a wildly wrong price, or one token leaves the gold price

1. The oracle acts on its own before anyone does. A Chainlink PAXG/USD print more than the
   gold band from XAU/USD stops borrowing and reserve swaps at once (`Off gold band`), while
   liquidation keeps pricing at min(max(C, G), G × (1 + m)): a print below gold values PAXG at
   gold, a print above it values PAXG at no more than G × (1 + m). A PAXG-specific depeg is
   therefore never liquidated; GSUSD holders carry it, as the project accepted
   (`docs/ORACLE_MANIPULATION_MODEL.md` section 15.8). With C or G stale or invalid, every
   priced path refuses (`No reliable price`) and resumes by itself on the first healthy pair;
   nothing has to be called. Page on the keeper's `oracle.price-refused`, `oracle.feed-invalid`,
   `oracle.off-gold-band` and `oracle.premium-capped` alerts. Repaying, depositing collateral and debt-free
   withdrawals never read a price and continue.
2. The guardian can stop one token by hand: `oracle.freezeToken(token)` (guardian or
   governance; there is no permissionless trip that could be used to stall). It freezes
   **that token only**, for `FREEZE_DURATION` (14 days): its minting, indebted withdrawals,
   reserve swaps and every liquidation stop, emergency ones included and during a pause as
   well, while the other token, if active, runs normally.
   The freeze lapses on its own unless the guardian calls `freezeToken` again, which extends it
   to 14 days from that call (`TokenFrozen(token, by, until)` records each). Every call takes a
   new freeze number (`freezeEpoch(token)`), so an unfreeze governance scheduled before the
   freeze was last re-asserted reverts `Different freeze`.
3. Before lifting a freeze, the guardian checks off chain that the sources reflect a liquid
   market and are not being manipulated; the contract checks freshness, round integrity and
   the band, not market depth. `oracle.guardianUnfreezeToken(token, oracle.freezeEpoch(token))`
   then succeeds only when
   a normal liquidation read does, and records that price. A token that stays off the gold price stays
   frozen while the guardian keeps extending the freeze; governance owns the broader responses (a new feed, a different band, a zero debt
   ceiling), each through the timelock.
4. For a market-wide problem the guardian can still pause the whole oracle with
   `emergencyPause`. While it holds, `emergencyLiquidate` prices each token that is not
   frozen at the normal liquidation price and reverts `No price` when the rules give none
   (`Token frozen` for a frozen one: the pause does not lift a freeze): `lastKnownPrice` never
   prices a seizure, so neither a stale record nor a single anomalous print can make a
   healthy vault liquidatable, and there is nothing to resync before liquidations proceed.
   If a feed never returns, governance replaces it through the timelock (`setFeed` or
   `setAnchorFeed`); until then liquidation in that token stays refused.
5. Once the feed is healthy, governance proposes `unpause(epoch)` through the timelock (48h
   cycle), with `epoch` read from the oracle's `pauseEpoch()` when it is scheduled, and executes
   it within the 7 day grace period. If the pause lapses before then, the proposer Safe cancels
   the `unpause` ([The timelock queue](#the-timelock-queue)) rather than leaving it in the
   queue; it cannot lift the next pause, which carries a new number.

See `docs/ORACLE_IMPLEMENTATION_PLAN.md` section 3 for the pricing rules that back this runbook.

### Possible exploit in flight

1. **Pause everything immediately**. Two of the three guardian signers sign: the
   guardian is a 2-of-3 Safe and the role is granted to the Safe alone, so one
   signer cannot pause. The Safe calls `emergencyPause` on vault, oracle and
   stability pool, and `pauseAsset` on the stability reserve for each reserve
   asset (PAXG alone at launch), as one prepared batch (`MAINNET.md` section 6 has the targets, the
   calldata and what to do when one of the contracts is already paused):

   ```js
   vault.emergencyPause()
   oracle.emergencyPause()
   reserve.pauseAsset(token)   // once per reserve asset: PAXG at launch, XAUT only after its activation
   stabilityPool.emergencyPause()
   ```

   Each lapses after 14 days: `extendPause()` on the vault, oracle and pool, and
   `pauseAsset(token)` again on the reserve, keep a pause that is still needed. Every
   extension or renewal takes a new pause number, as does every bad-debt breaker trip, so an
   unpause scheduled before the hold was last re-asserted reverts `Different pause`: once the
   incident is over, governance schedules its unpause after the last extension.

2. Repay remains available for honest users (intentionally not paused).
3. War-room: investigate.
4. Resolution is a governance proposal: it waits out the delay in force (48h at launch), no shortcuts.
   Never batch the unpause with the change that makes it safe, because one re-assertion during
   the delay voids the whole batch:
   - **Bad-debt breaker.** While `totalBadDebt` exceeds `badDebtPauseThreshold`, every bad-debt
     liquidation re-asserts the vault pause, and anyone holding an underwater vault can run
     one. First bring `totalBadDebt` under the threshold (wait for the buffer to refill and
     call `retryBadDebtAbsorption`) or raise the threshold, as an operation of its own. Once
     that has executed, read `pauseEpoch()` and schedule `unpause(epoch)`. The buffer refills
     only with the fees the vault banks; during a pause that is the stability fee part of
     repayments, because minting is stopped. GSUSD sent to the buffer with a plain transfer
     is not counted, absorbs nothing and cannot be withdrawn, so never top it up that way
     (fork scenario 14, `MAINNET.md` section 2).
   - **Compromised guardian.** Schedule `revokeRole(GUARDIAN_ROLE, guardian)` on its own. A
     guardian can void an unpause scheduled before its revocation executes by extending the
     pause, so schedule the unpause, or the unfreeze, only after the revocation has executed.
     This bounds its hold at one more timelock delay.

   A `PauseExtended` event whose `by` holds neither `GUARDIAN_ROLE` nor `GOVERNANCE_ROLE`,
   emitted in the same transaction as a `BadDebt`, is the breaker re-asserting the pause, not
   a guardian action.

### Governance signer key compromised

1. Other proposer signers immediately initiate a `cancel` on any in-flight
   proposals via the TimelockController, listed as in
   [The timelock queue](#the-timelock-queue).
2. The remaining signers replace the compromised owner in the Safe itself. The roles
   belong to the Safe, so nothing changes on the timelock.
3. Where a whole proposer or executor Safe must be replaced or removed, change BOTH role
   lists in the same proposal. The timelock has its own `PROPOSER_ROLE`, `CANCELLER_ROLE`
   and `EXECUTOR_ROLE`; the `GoldGovernance` wrapper has a second `PROPOSER_ROLE` and
   `EXECUTOR_ROLE` and is itself a permanent proposer and executor on the timelock. A Safe
   revoked on the timelock alone still schedules through the wrapper's `propose*` helpers
   and still executes through `executeProposal`. The wrapper has no helper for this, so a
   remaining proposer schedules one `scheduleBatch` on the timelock. For a proposer Safe:

   ```text
   timelock.revokeRole(PROPOSER_ROLE,  oldSafe)     // target: the timelock
   timelock.revokeRole(CANCELLER_ROLE, oldSafe)     // target: the timelock
   governance.revokeRole(PROPOSER_ROLE, oldSafe)    // target: GoldGovernance
   timelock.grantRole(PROPOSER_ROLE,  newSafe)      // only when replacing
   timelock.grantRole(CANCELLER_ROLE, newSafe)
   governance.grantRole(PROPOSER_ROLE, newSafe)
   ```

   For an executor Safe the same six calls with `EXECUTOR_ROLE` in place of
   `PROPOSER_ROLE` and no `CANCELLER_ROLE` line. The timelock administers its own roles and
   the wrapper's, so every call waits out the delay in force; cancel anything the old Safe
   schedules meanwhile (step 1). Afterwards run `verify-deployment.ts`: its check
   `gov:wrapper-roles-match-timelock` fails while a stale holder remains on either side,
   and names it.
4. If the compromise is on the guardian, governance schedules a new guardian: `grantRole`
   and `revokeRole` of `GUARDIAN_ROLE` on the vault, the oracle, the stability pool and the
   stability reserve, in one batch.

### Issuer freezes a silo address

1. Withdrawals automatically route around frozen silos (LIFO from the latest
   first; if the latest is frozen, the next unfrozen silo is used).
2. If a run of consecutive silos is frozen, governance moves new deposits past it
   with `SiloFactory.setCurrentSiloIndex` (at most 64 silos per call). The index it sets
   is a floor: a later withdrawal never rewinds the deposit cursor below it.
   Fill the gap straight after every move, and before telling users deposits are open
   again: a deposit creates every silo missing up to the cursor (about 110,000 gas each
   on a local chain, and new state has cost about five times that on a repriced
   network), so a long move, or several moves in a row, can leave the next deposit
   needing more than the 16,777,216 gas one transaction may carry. The cursor cannot be
   moved back. `SiloFactory.createSilos(token, 16)` creates the missing silos sixteen at a
   time (about 1.8 million gas a call locally) and is open to any address; repeat it
   until `SiloFactory.missingSilos(token)` reads 0. A move of 64 takes four calls, a
   200-silo run thirteen. Send each `createSilos` call as its own transaction from any
   wallet, after the move has executed, and read `missingSilos(token)` immediately
   before every call: the call reverts `Nothing to create` when a deposit or another
   caller filled the gap first. For that reason never place `createSilos` inside a
   timelock batch or a Safe batch with other calls: batches are atomic, and anyone who
   fills the gap first would revert the whole batch, the cursor move included. The
   call also reverts `Unknown token` for an address that has no silo and whose cursor
   was never moved, a listed token before its first deposit included; that token needs
   nothing, its first deposit creates its first silo. `verify-deployment.ts` fails
   (`ops:siloFactory.<token>.no-silo-gap`) while any silo is missing.
3. Do not propose a `setSiloFactory` rotation while any silo holds frozen gold: the
   vault refuses to replace a factory that is not empty, so the timelocked proposal
   would revert on execution. Rotation waits for the issuer to release the gold.
   When a rotation is possible, do it as ONE operation, `setSiloFactory(newFactory)`,
   straight from the old factory to the new one. Never set the factory to zero and wire
   the new one as a second operation: while no factory is wired, any deposit, one wei
   included, is held by the vault itself and marks it for good (`heldUnwired`), after
   which `setSiloFactory` refuses every factory (`Current factory holds collateral`) and
   all gold deposited from then on sits at the vault's single address.
4. If all silos are frozen, the censorship-resistance design has failed and the
   token issuer has effectively seized assets. Pause and consult legal.

---

## Useful commands cheat sheet

From `contracts/`:

```bash
# Run all tests (every test passes)
npx hardhat test

# Foundry fuzz + invariant suite (every test passes)
forge test

# Run only the production rehearsal
npx hardhat test test/EndToEnd.test.ts

# Deploy
npx hardhat run scripts/deploy.ts --network <sepolia|mainnet>

# Verify wiring
npx hardhat run scripts/verify-deployment.ts --network <net>

# Verify after governance handover
EXPECT_GOVERNANCE_TRANSFERRED=1 npx hardhat run scripts/verify-deployment.ts --network <net>

# Mainnet preflight (read-only on chain; .env.mainnet loaded; PREFLIGHT_EXPECT_CHAIN_ID=31337 on a fork;
# writes deployments/<network>.preflight.json, which deploy.ts requires on mainnet)
npx hardhat run scripts/preflight-mainnet.ts --network mainnet

# Etherscan source verification for the whole deployment (ONLY=<label> for one contract)
npx hardhat run scripts/verify-etherscan.ts --network <net>

# The dapp, API and keeper environment blocks from the snapshot
npx hardhat run scripts/print-service-env.ts --network <net>

# The agent surface the dapp serves: /agents.json, /llms.txt and /abi/<Contract>.json, from every
# snapshot in deployments/ and the Hardhat artifacts (commit the result; never edit the files by hand)
npx hardhat run scripts/print-agent-manifest.ts

# Both Safe transactions for a ceiling change through the timelock (guarded deployments; mainnet has no ceiling)
CEILING_GSUSD=<amount> npx hardhat run scripts/print-ceiling-proposal.ts --network <net>

# Both Safe transactions for an origination fee exemption through the timelock (after the handover)
EXEMPT_ACCOUNT=<vault owner> npx hardhat run scripts/print-fee-exemption-proposal.ts --network <net>

# Both Safe transactions that seed the reserve: approve, then seedCollateral, from the Safe that
# holds the gold. Never send gold to the reserve with a plain transfer: it cannot be recovered
SEED_AMOUNT=<tokens, a decimal point allowed: 0.25 for the launch seed> npx hardhat run scripts/print-reserve-seed.ts --network <net>

# Transfer governance (irreversible)
CONFIRM=YES npx hardhat run scripts/transfer-governance.ts --network <net>

# Withdraw surplus above the floor to the operations Safe (dry run without CONFIRM=YES;
# after the handover, run once to schedule and again after 48h to execute; the recipient
# must be a contract unless WITHDRAW_TO_EOA=YES and is never the deployer or a governance Safe;
# rehearse on a fork with FORK_OF and IMPERSONATE)
WITHDRAW_TO=<ops safe> WITHDRAW_GSUSD=<amount> WITHDRAW_MEMO="<quarter or invoice>" CONFIRM=YES npx hardhat run scripts/withdraw-surplus.ts --network <net>

# Set the optional governed reserve minimum (the 2% floor is automatic and needs no run; this only
# adds a higher fixed minimum; dry run without CONFIRM=YES; same schedule-then-execute cycle after
# the handover; refresh the snapshot afterwards)
MIN_RESERVE_GSUSD=<amount> MEMO="<reason>" CONFIRM=YES npx hardhat run scripts/set-min-reserve.ts --network <net>

# Coverage
npm run coverage:check

# Static analysis
npm run slither

# Etherscan source verification of a single address by hand
npx hardhat verify --network <net> <ADDRESS> [<ARGS>]
```

From the repository root:

```bash
# Build the keeper service
npx nx build keeper

# Run the keeper (set the KEEPER_* env first; dry run unless KEEPER_DRY_RUN="false")
node dist/apps/keeper/main.js

# Build the API (serves the indexer)
npx nx build api
```

---

## One last thing

**When you do go live, the first user with capital at risk is you.** Open the
first vault yourself, with about $2,000 of PAXG: the 1,000 GSUSD minimum debt needs at
least $1,300 of it at the 130% minimum ratio, and the rest is margin. Run a stability swap against the reserve. Let it sit a week. If
anything is wrong, your money tells you first.
