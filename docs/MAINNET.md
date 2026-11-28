# Mainnet launch: the short version

This is the launch-day sheet. Every step is one command or one signed transaction, in the
order you run them. The reasoning behind each step, the pre-launch gates and the emergency
procedures are in [`LAUNCH.md`](LAUNCH.md); this page does not replace them.

Contract commands run from `contracts/`. Service commands run from the repository root.

## 1. What only you can supply

Have every item on this list before you book the launch window. The preflight in step 3
checks the on-chain ones; nothing here can be scripted.

| You need | Why | Where it goes |
| --- | --- | --- |
| PAXG's two sources and the open launch profile, as `.env.mainnet.example` carries them: C (Chainlink PAXG/USD), G (Chainlink XAU/USD), the gold band g and the liquidation cap m (2% each) and `LAUNCH_CAPS=open` (no debt ceiling, no per-block mint cap) | The launch is PAXG-first (`docs/ORACLE_IMPLEMENTATION_PLAN.md`); XAUT is registered and inactive; liquidation follows variant C, min(max(C, G), G × (1 + m)), whose figures and accepted residual risks are the economic model's (`docs/ORACLE_MANIPULATION_MODEL.md` section 15.8) | `PAXG_FEED`, `XAU_USD_ANCHOR_FEED`, `PAXG_GOLD_BAND_PPM`, `PAXG_LIQUIDATION_CLAMP_PPM` and `LAUNCH_CAPS` in `contracts/.env.mainnet` |
| A fresh deployer key, hardware-wallet derived, funded with ETH | Signs the ceremony, then hands everything to the timelock and is retired. It must not be an owner of any Safe below. The preflight prints the cost at the day's fee under `deployer:balance`: its live estimate of the eleven creations, plus 4,200,000 gas for at most 35 wiring transactions, plus a 25% margin, and it fails a balance below that. On the fork rehearsal of 26 November 2026, on the source as it stood that day, the preflight estimated 29.2 million gas (25.0 million for the eleven creations and the 4.2 million wiring allowance) and the deploy used 27.2 million (25.0 million for the creations and 2.2 million for 29 wiring transactions). With the 25% margin the preflight asks for about 0.036 ETH at a quoted fee of 1 gwei, 0.073 ETH at 2 gwei, 0.18 ETH at 5 gwei and 0.36 ETH at 10 gwei, so 0.1 ETH passes while the quoted fee is under about 2.7 gwei and 1 ETH under about 27 gwei. The base fee that day was 0.06 gwei. The preflight computes the requirement from the fee on the day: read it from `deployer:balance` in the rehearsal of section 2 and again on launch day | `PRIVATE_KEY` in `contracts/.env.mainnet` |
| Proposer Safe, 2-of-3, hardware-wallet signers | Schedules every parameter change through the 48 hour timelock | `TIMELOCK_PROPOSER` |
| Executor Safe, 2-of-3 (project decision, 2026-11-16). All three role Safes are 2-of-3 and the preflight enforces it | Executes matured proposals, each within 7 days of it becoming ready (the timelock's grace period). The zero address would let anyone choose that moment, so the preflight and `deploy.ts` refuse it unless `ALLOW_OPEN_EXECUTOR=1` accepts it (`LAUNCH.md`, executor policy) | `TIMELOCK_EXECUTOR` |
| Guardian Safe, 2-of-3 | Stops things and nothing else: emergency pause and pause extension on the vault, the oracle and the stability pool, the reserve asset pause, the freeze of one token's oracle reads and its release, and re-recording the oracle's last-known price. It cannot unpause and changes no parameter | `TIMELOCK_GUARDIAN` |
| Operations Safe, a fourth Safe | Holds the project's gold, opens the seed vault, seeds the reserve and receives cost-recovery withdrawals (section 5). It holds no role in any contract and must differ from the three above and from the deployer | `OPERATIONS_SAFE` in `contracts/.env.mainnet` (checked by the preflight, not part of the parameters hash); `WITHDRAW_TO`, `EXEMPT_ACCOUNT` and `SEED_FROM` in the section 5 commands |
| A keeper key, fresh, with about 1 ETH for gas (section 4.7 has the arithmetic) | Liquidates while both feeds are healthy, watches oracle health and alerts. It runs no fee job: the stability fee accrues inside the contracts | `KEEPER_PRIVATE_KEY` in the keeper's env file only |
| The keeper's GSUSD float: **1,100 GSUSD, minted from the operations Safe's seed vault** (project decision, 2026-11-26; it replaces the 2,500 GSUSD of 2026-11-15). It covers one vault owing up to about 1,089 GSUSD whole: a minimum-debt vault with its accrued fee. The keeper cannot take a vault that owes more than that and less than twice the minimum debt, liquidates a larger one in part, and has spent the float after one liquidation, so refill it after every direct liquidation | The stability pool is empty at launch, so the keeper's direct path is the only protocol-run liquidation path on day one, and it repays a vault's debt from the keeper wallet. Size it to the largest single vault debt you are prepared to see, plus 1%; each direct liquidation spends it (section 4.7, "The GSUSD float") | Sent to the keeper address after the handover, before `KEEPER_DRY_RUN=false` |
| For the second keeper: its own fresh key, about 1 ETH and its own GSUSD float | Two keepers on one key contend for one nonce, and a keeper with an empty wallet has only the pool path, which is empty at launch | The second keeper's env file only (section 4.7) |
| Two mainnet RPC endpoints from different providers | One for the ceremony and the services, one as a fallback | `RPC_URL`, `SEPOLIA_RPC_URL` (the API variable keeps its historical name), `KEEPER_RPC_URL`, `KEEPER_READ_RPC_URLS` |
| Browser RPC keys, separate from the two above: one or two https endpoints, the second at another provider | Every visitor can read these keys in the bundle. Use keys made for the browser, rate-capped, with `https://goldstandardfinance.eth.limo` and `https://goldstandard.finance` on the provider's origin allowlist where it has one, on a plan that serves `eth_getLogs` over at least 50,000 blocks (the vault history scan). **Project decision, 2026-11-20: the keyless public gateway `https://mainnet.gateway.tenderly.co` first, `https://ethereum-rpc.publicnode.com` as the fallback.** Neither needs an account or a key, so there is nothing in the bundle to leak or to tie to anyone. Checked that day: the gateway allows browser requests from any origin and served a 200,000 block `eth_getLogs`; the fallback answers current reads only and refuses history, so the vault history page depends on the first. Neither comes with a guaranteed quota: watch the dapp's history page after launch | `VITE_MAINNET_RPC_URL`, comma separated, the preferred endpoint first |
| An Etherscan API key | Source verification | `ETHERSCAN_API_KEY` |
| A WalletConnect Cloud project id | Mobile wallets in the dapp | `VITE_WALLETCONNECT_PROJECT_ID` |
| A project email address and a GitHub organisation that own every service account below | One place to recover every service account from | Section 4 |
| An ENS name: goldstandardfinance.eth (project decision, 2026-11-16; it replaces the name used in earlier drafts). Registered on 2026-11-16 and paid to 2032-11-16, in the ENS registry at `0xf60aBA43E1f7f3dab1186ff03B561401C9dF85e2`; the older registry and tools that read only it report the name as unregistered, so confirm that the eth.limo gateway resolves it with a test content hash before section 4.4 | The canonical address of the dapp; its content hash is the build users can verify | Section 4.4 |
| An IPFS pinning account (Pinata or Filebase), or a Fleek account that deploys from GitHub | Keeps the published build available | Section 4.4 |
| The domain at a registrar with DNSSEC and a registry lock, and a Cloudflare account (email only) in front of the mirror | The familiar URL, as a mirror of the same build | Section 4.5 |
| Two VPS accounts at different providers: one for the API, one for the keeper, a third later for the redundant keeper | The services; the keeper key exists on exactly one machine | Sections 4.6 and 4.7 |
| A security mailbox at the domain | `/.well-known/security.txt` names it | Section 4.9 |
| Tenderly alert rules, or the watcher service of section 4.8, and an on-call rota | Paused, TokenFrozen, BadDebt, AssetPaused, large mints, a vault below 115% for more than 5 minutes, every `CallScheduled` on the timelock, with its own rule for one whose call is `grantRole` on the stability pool, the stability module, the surplus buffer or the stability reserve (section 5, item 7), and every `RoleGranted` for `VAULT_ROLE` on those four contracts or for `MINTER_ROLE` on the stablecoin | `LAUNCH.md`, pre-launch checklist |
| A pager for the keeper: a log shipper from the keeper host, or a hosted dead-man check | The keeper's only output is JSON lines in its journal; nothing pages unless you wire it | Section 4.7, "Alerting" |
| The release commit, whose full hash is in step 3.1 | The ceremony and the services build from that commit alone | Step 3.1 |
| Every workflow green on the release commit, or a written record of the same checks run locally on that commit | `DEPLOYMENT_RUNBOOK.md` asks for every workflow green on `main`, and nothing gates a change while the workflows cannot run | `DEPLOYMENT_RUNBOOK.md`, pre-ceremony |
| Every RPC provider key used during development rotated, and every new key restricted by origin where the provider allows it | A key that was used in development is to be treated as exposed | Before section 4.2 |
| Legal sign-off | Confirmed done on 2026-11-15; the record is held offline, outside this repository. The dapp's Terms page states use at the user's own risk, no warranty, no promise of yield and a limitation of liability; by a project decision of 2026-11-26 it states nothing on governing law, an offering entity or eligibility | `LAUNCH.md`, pre-launch checklist, the legal item |

### 1.1 Creating the Safes

Create all four at `https://app.safe.global` on Ethereum mainnet before the preflight, which
reads `getThreshold()` and `getOwners()` from each address.

1. Four different addresses: proposer 2-of-3, executor 2-of-3, guardian 2-of-3 and the
   operations Safe (its threshold is yours to set). One Safe in two roles is a `FAIL`.
2. Every owner is a hardware-wallet address. Never the deployer key (`FAIL
   safe:deployer-not-owner`: the key is retired after the ceremony, so a Safe it
   sits on would be left a signer short) and never a keeper key. Keep each signer on one
   Safe; a signer shared between Safes is a `WARN`.
3. Each Safe must exist on chain. An address with no code is a `FAIL`, so if the Safe app
   deferred the deployment, send one transaction from the Safe first.
4. Back up every executor signer, seed phrase included, in two places. The timelock
   has no admin: a replacement executor can only be granted by a proposal the executor
   itself executes, so losing two of its three signers stops every governance execution for
   good. Two of them must be reachable within the 7 days in which a matured proposal can land.
5. Have a second person read each address back from the Safe app against `.env.mainnet`:
   `TIMELOCK_PROPOSER`, `TIMELOCK_EXECUTOR`, `TIMELOCK_GUARDIAN` and `OPERATIONS_SAFE`.
6. The guardian signers rehearsed the pause batch of section 6 on Sepolia on 22 November 2026: the
   guardian Safe executed it with two signers. The same confirmation on mainnet after the
   handover is still owed (section 5).

## 2. The day before: rehearse on a fork

About half an hour. Proves the exact launch configuration against the real tokens and feeds,
then the ceremony, the handover and the first governance operations, without spending
anything.

```bash
cd contracts
npx hardhat node --fork $MAINNET_RPC --fork-block-number <current block minus 3> --port 8547
# in the second shell, before anything else: the fork answers fee questions from live mainnet
# but enforces the fork block's own base fee, so a fork taken at a fee spike refuses every
# transaction as underpriced. Fees are not under test; pin the next block's base fee low.
curl -s -X POST -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"hardhat_setNextBlockBaseFeePerGas","params":["0x989680"]}' http://127.0.0.1:8547
```

In a second shell, with `.env.mainnet` filled in (step 3.1) and loaded. The fork signs with
the node's development account 0, so set `PRIVATE_KEY` to the first key `npx hardhat node`
printed: the real deployer key never touches the rehearsal, and the preflight warns that this
key is not single-use. With the real Safes of `.env.mainnet` on mainnet, as
on launch day, skip `setup-safes.ts` and leave `OPERATIONS_SAFE` set: the scripts send from the
real Safe addresses by impersonation. If the Safes do not exist yet, `setup-safes.ts` deploys
stand-ins on the fork; export the three `TIMELOCK_*` lines it prints and `unset OPERATIONS_SAFE`,
which the stand-ins do not cover (scenario 19 then uses a stand-in of its own). Delete the last rehearsal's files first: the preflight fails
`snapshot` on a leftover `localhost.json`, and a leftover record is checked by `deploy.ts`.

```bash
cd contracts
rm -f deployments/localhost.json deployments/localhost.preflight.json deployments/localhost.inprogress.json
set -a; source .env.mainnet; set +a
export PRIVATE_KEY=<the first key the fork node printed>
export LOCAL_RPC_URL=http://127.0.0.1:8547
# the token's address with the launch's own numbers: the launch deployer by impersonation, undone afterwards
TOKEN_ADDRESS_DEPLOYER=<launch deployer address> npx hardhat run --no-compile scripts/rehearsal/token-address.ts --network localhost
# only when the Safes of .env.mainnet do not exist on mainnet yet; skip it with the real Safes
npx hardhat run --no-compile scripts/rehearsal/setup-safes.ts --network localhost
npx hardhat run --no-compile scripts/rehearsal/feed-history.ts --network localhost
# the rehearsal deploys from the development account, so its token has its own salt: unset the
# pair to rehearse with no fixed address, or find one for this account as section 3.3 describes
unset GSUSD_SALT GSUSD_ADDRESS
PREFLIGHT_EXPECT_CHAIN_ID=31337 npx hardhat run scripts/preflight-mainnet.ts --network localhost
# the forced interruption: press Ctrl-C once the deploy has printed its first few contract addresses
REQUIRE_PREFLIGHT_RECORD=1 npx hardhat run --no-compile scripts/deploy.ts --network localhost
# then resume; it verifies the journal against the fork and sends only what is still owed
REQUIRE_PREFLIGHT_RECORD=1 DEPLOY_RESUME=1 npx hardhat run --no-compile scripts/deploy.ts --network localhost
npx hardhat run --no-compile scripts/verify-deployment.ts --network localhost
npx hardhat run --no-compile scripts/rehearse-mainnet-fork.ts --network localhost
# from here the real feed proxies answer from mocks, so prices can move
npx hardhat run --no-compile scripts/rehearsal/baseline.ts --network localhost
for s in s1-lifecycle s2-liquidations s3-gold-crash s4-paxg-specific s5-stale-feeds s6-pool-disabled \
  s7-manipulation s8-ceiling-guardian s9-reserve-swap s10-underwater s18-claim-seizure-silo-gap; do
  npx hardhat run --no-compile scripts/rehearsal/$s.ts --network localhost
done
DRILL_DEPLOYMENT=localhost DRILL_TARGET=<deployer> npx hardhat run --no-compile scripts/attack-drill.ts --network localhost
CONFIRM=YES REHEARSE_AS=<deployer> npx hardhat run --no-compile scripts/transfer-governance.ts --network localhost
EXPECT_GOVERNANCE_TRANSFERRED=1 npx hardhat run --no-compile scripts/verify-deployment.ts --network localhost
for s in s8-ceiling-guardian s8-xaut-activation s11-lock-minters s12-unpause-epoch s13-feed-replacement \
  s14-buffer-refill s15-launch-printers s16-withdraw-surplus s17-issuer-freeze \
  s18-claim-seizure-silo-gap s19-operations-safe; do
  npx hardhat run --no-compile scripts/rehearsal/$s.ts --network localhost
done
DRILL_DEPLOYMENT=localhost DRILL_TARGET=<deployer> npx hardhat run --no-compile scripts/attack-drill.ts --network localhost
```

The scenarios cover what `ORACLE_IMPLEMENTATION_PLAN.md` section 6, blocker 3 asks of the fork: borrowing,
repayment, full and partial liquidation, a rapid gold crash, a stale C, a stale G, C pushed
off the band in both directions, buffer absorption, governance and the guardian. Each runs
inside a snapshot, so the order after the baseline does not matter. Every vault is sized from
the prices the fork starts with (`scripts/lib/rehearsalSizing.ts`), so the lines pass whatever
gold costs that day and however far C sits from G. `rehearse-mainnet-fork.ts`, which runs
first, shows the reserve as it ships: empty, with a swap refused `Reserve insufficient` until
it is seeded. After the handover,
scenario 8a releases its pause through the timelock instead of the deployer, and scenario 11
rehearses the minter lock of `LAUNCH.md`, steady state. Scenarios 12 to 19 rehearse the
operations of sections 5 and 6 and the rules that came with the 2026-11-23 release, each
through the Safes of the deployment (the real addresses by impersonation, or the stand-ins)
and the 48 hour timelock where governance is involved:

- **12** pauses the oracle, the pool and the reserve's PAXG as the guardian, lifts each with
  `unpause(epoch)` or `unpauseAsset(token, epoch)` after the delay, and runs the race: the
  guardian re-asserts each hold during the delay, the matured unpause reverts
  `Different pause` and a second one naming the new number lifts it.
- **13** replaces PAXG's market feed with `GoldGovernance.proposeOracleFeedUpdate` and shows
  that the oracle follows the old feed until the executor Safe runs `executeProposal` and the
  new one from then on.
- **14** books bad debt the buffer cannot absorb, refills the buffer and calls
  `retryBadDebtAbsorption()`, under the breaker threshold and above it. The buffer counts
  only the fees the vault banks: a plain GSUSD transfer to it absorbs nothing.
- **15** runs `print-fee-exemption-proposal.ts` and `print-reserve-seed.ts` (for the 0.05 PAXG
  launch seed), sends the
  printed transactions unchanged from the Safes they name and checks the exemption and the
  seed on chain. A plain PAXG transfer to the reserve is shown not to count.
- **16** runs `withdraw-surplus.ts` with `FORK_OF=localhost` and `IMPERSONATE`, to a stand-in
  operations Safe, and checks that the deployer and each governance Safe are refused as
  `WITHDRAW_TO`.
- **17** freezes a silo, every funded silo and the vault's own address on the real PAXG, as
  the account that holds Paxos's asset protection role, and records what deposits,
  withdrawals, repayments and liquidations do (`THREAT_MODEL.md` C1, C2 and L7).
- **18** runs before and after the handover. A stability pool deposit, a `claimCollateral` and
  a `withdraw` from one wallet in one block: the deposit lands and the other two revert
  (`No same-block claim`, `No same-block withdrawal`). Governance cannot point the vault at a
  pool that does not declare the prefunded absorb path: the deployer's `setStabilityPool`
  reverts before the handover, and after it the scheduled `proposeStabilityPoolUpdate` reverts
  when the executor Safe runs it and the proposer Safe cancels it. An underwater vault carrying accrued
  stability fee is liquidated in full: the payment retires principal first and the bad debt
  booked is the principal it did not cover. Governance moves the PAXG deposit cursor
  (`SiloFactory.setCurrentSiloIndex`): `missingSilos` reports the gap, `verify-deployment.ts`
  fails `ops:siloFactory.PAXG.no-silo-gap`, anyone closes it with `createSilos` in batches of at
  most 16 and a deposit works again.
- **19** is section 5 as the operations Safe performs it: the seed vault, holding the launch
  gold, mints 1,551 GSUSD on launch day and pays the origination fee, the keeper's 1,100
  GSUSD float and 450 for the GSUSD/USDC position; the keeper wallet liquidates a
  minimum-debt vault directly out of the float; the 0.05 PAXG reserve seed is printed and
  sent, and one swap pays exactly `quoteGoldOut` and lowers `remainingDailyCapacity` by the
  gold paid; the fee exemption is printed, scheduled and executed 48 hours later, and a
  later mint then pays no fee.

Scenarios 15, 16, 18 and 19 start launch scripts in their own Hardhat processes, so they need the
same environment as the rest of the sequence. Expect every line to pass and the drill to
report 0 succeeded.

`REQUIRE_PREFLIGHT_RECORD=1` holds the fork to the gates mainnet applies: the journal is
resumed only with `DEPLOY_RESUME=1`, the record must be under 60 minutes old by the fork's
clock, the Safes are read again and compared with the record, and the deploy and the handover
close with the deployer key reminder of step 3.7.

On 8 November 2026 the whole sequence passed on a fork at block 26,371,093: both feeds'
largest gap in 30 days was 24.0 h (96% of the 90,000 s staleness limit), the preflight passed
69 checks with the one expected warning and estimated the ceremony at 28.1 million gas, the
verification passed 121 checks before the handover and 139 after it, the scenarios passed 67
checks before the handover and 20 after it, and the drill refused 25 attacks with none
succeeding, before and after.
On 11 November 2026 the sequence passed again at block 26,393,326 on the tree with the
ceremony changes (the record's age limit, the Safe re-read, the wait timeout, the 2-of-3,
1-of-1 and 2-of-3 stand-in Safes): the deploy was stopped twice and resumed, the handover was
stopped after its fourth step and resumed, the preflight passed 70 checks with the one
expected warning, and the verification passed 145 checks before the handover and 163 after
it.
Later on 11 November 2026 scenarios 12 to 17 were written and passed on a fork at block
26,394,396, after a plain deploy and the handover: 33 checks, with the verification still at
163 checks afterwards.
Those three runs predate the contract source of the 2026-11-23 release, which changed on 18
and 23 November.
On 24 November 2026 the whole sequence passed on the source of that release, on a fork at
block 26,483,568 with the four real Safe addresses of `.env.mainnet` (sent from by
impersonation) and at the feeds' own prices, C $3,603.05 and G $3,620.48: both feeds' largest
gap in 30 days was 24.0 h, the preflight passed 73 checks with the two warnings a rehearsal
expects (the development key, and the Etherscan key left unset) and confirmed the 2-of-3
executor Safe, the deploy was stopped twice and resumed and used 27,256,190 gas, the handover
was stopped after its fourth step and resumed, the verification passed 155 checks before the
handover and 173 after it, `rehearse-mainnet-fork.ts` and the baseline passed 9 checks each,
the scenarios passed 52 checks before the handover and 60 after it, the drill refused 25
attacks with none succeeding, before and after, and the source publication list held the
thirteen contracts.
On 26 November 2026 the sequence passed again, on the source as it stood after the changes
merged on 25 November (the compiler version pinned in every file, the stability pool's
prefunded declaration and the vault's rule for accepting a pool, the silo factory's deposit
leg, the research price adapters moved out of `contracts/src`), on a fork at block 26,496,093
with the same four Safe addresses and at the feeds' own prices, C $3,572.36 and G $3,572.90:
the preflight passed 73 checks with the same two warnings, the deploy was stopped twice and
resumed and used 27,175,600 gas, the handover was stopped after its fourth step and resumed,
the verification passed 157 checks before the handover and 175 after it,
`rehearse-mainnet-fork.ts` and the baseline passed 9 checks each, the scenarios passed 53
checks before the handover and 61 after it, the drill refused 25 attacks with none succeeding,
before and after, and the source publication list still held thirteen contracts, the research
adapters not among them. Run the sequence again the day before launch and record its block
and counts here.
On 27 November 2026, the day of the launch, the sequence passed on the released source, with
the token created through the GoldStablecoinDeployer, on a fork at block 26,505,857 with the
same four Safe addresses: the token address rehearsal passed 8 checks with the launch
deployer and salt, the preflight passed, the deploy was stopped after its fourth contract
and resumed, the verification passed 161 checks before the handover and 179 after it,
`rehearse-mainnet-fork.ts` and the baseline passed 9 checks each, every scenario passed, and
the drill refused 25 attacks with none succeeding, before and after. The ceremony ran the
same day: deployment block 26,505,970, the verification passed 164 checks before the
handover and 182 after it, and the fourteen contracts were verified on Etherscan.

The fork writes `deployments/localhost.json` and `deployments/localhost.preflight.json`.
Delete them afterwards and stop the fork before launch day:

```bash
rm -f deployments/localhost.json deployments/localhost.preflight.json deployments/localhost.inprogress.json
```

**Rehearsed with the real signers.** On Sepolia on 22 November 2026 the proposer Safe
scheduled a timelock proposal, the dapp was opened inside the Safe app and connected as a
Safe, and the guardian Safe executed the pause batch of section 6 with two signers.

**Still owed.** Run each of the operations below before it is first needed on mainnet:

- The keeper on mainnet itself. Built from the source as it stood that day, it ran on a
  fork that presents chain id 1 (26 November 2026, block 26,497,892, a separate fork started
  with `E2E_NODE_CHAIN_ID=1`, since the keeper refuses the 31337 this fork answers): seven
  ticks in dry run, then live for a direct liquidation and a stability pool liquidation, each
  confirmed on chain, with `keeper.heartbeat` `ok` true on every tick and the read cache at
  its default. The partial direct liquidation was last run on 11 November 2026, on the source
  as it stood then. Neither run could
  not show: real fees (the fork's base fee was a few wei, so the fee ceilings,
  `keeper.fee-above-ceiling` and the stuck transaction replacement never came into play), a
  wait for inclusion or a contested nonce (the fork mines each transaction at once), the real
  feeds (prices came from mock aggregators behind the real proxies), a stale head,
  `KEEPER_READ_RPC_URLS`, `KEEPER_HEARTBEAT_URL`, a private relay, a second keeper, a paused
  vault, or the real key and host. The dry run of section 4.7 is the first run against
  mainnet and is still owed.
- The executor Safe's execution of the proposal scheduled on Sepolia, after its 48 hour delay.
- The same confirmation on mainnet after the handover: the proposer Safe schedules, the
  executor Safe executes 48 hours later and two guardian signers assemble the pause batch
  (section 5).
- Scenarios 12 to 19 with the real signers. The runs of 24 and 26 November 2026 used the real Safe
  addresses, but a fork collects no signatures, so every Safe transaction in them is sent by
  impersonation; the Safe Transaction Builder path
  (pasting the printed calldata and collecting signatures) has been exercised for a proposer
  schedule and the guardian batch alone.

## 3. Launch day

Book two hours with every Safe signer present. Each step depends on the one before it.

### 3.1 Prepare

```bash
git fetch origin
git checkout 2581111e9ae37695cb8be2b690d9a84e985dd664   # the 2026-11-27 release
git status --short                    # prints nothing, or you stop here
npm ci
cd contracts
npm ci                                # contracts/ has its own lockfile; the root install does not cover it
npx hardhat test                      # every test passes, or you stop here
npm run typecheck                     # the launch scripts type-check against the compiled contracts (Hardhat only transpiles them)
cp .env.mainnet.example .env.mainnet  # fill in every placeholder in angle brackets; touch nothing else
set -a; source .env.mainnet; set +a
```

Have a second person read `.env.mainnet` back to you line by line.

### 3.1a The oracle variables

The oracle has two sources per token and nothing to deploy before the ceremony: the market feed
step (`scripts/deploy-market-feeds.ts`) has left the ceremony, and the retired variables
`PAXG_CONFIRM_FEED`, `XAUT_CONFIRM_FEED`, `PAXG_AGREEMENT_BAND_PPM` and `MARKET_FEEDS` are refused
rather than ignored. Have the second person read these lines back.

| Variable | What it is |
| --- | --- |
| `PAXG_FEED` | C: Chainlink PAXG/USD, the published `0x9944D86CEB9160aF5C5feB251FD671923323f8C3` |
| `XAU_USD_ANCHOR_FEED` | G: Chainlink XAU/USD, the gold reference only, never a token's market price |
| `XAUT_FEED` | Unset: `deploy.ts` creates an `InactiveFeed` for XAUT's dormant oracle entry and records it; nothing else about XAUT is configured |
| `PAXG_GOLD_BAND_PPM`, `PAXG_LIQUIDATION_CLAMP_PPM` | `20000` and `20000` (2% each): g gates borrowing and reserve swaps, m caps how far above gold liquidation values PAXG |
| `LAUNCH_CAPS` | `open`: no debt ceiling, no per-block mint cap, PAXG only, XAUT dormant. Leave `PAXG_DEBT_CEILING` and `PER_BLOCK_MINT_CAP` unset |
| `LAUNCH_CAPS=backstop` | Refused on mainnet by the preflight and `deploy.ts`: its maximum (`PAXG_BACKSTOP_MAX`) was derived under the retired pool design. `open` is the only mainnet profile |

### 3.2 Preflight (read-only)

```bash
npx hardhat run scripts/preflight-mainnet.ts --network mainnet
```

It parses every knob in `.env.mainnet` with the same code `deploy.ts` uses (lists trimmed,
empty values refused, every parameter bounded by the contract that receives it) and prints
the effective set, defaults included, as `param:` lines: that printout is the ceremony
record. It then checks the chain id, every address against the published inventory (C and G
included), the tokens' decimals and symbols and the PAXG-first configuration, each miss a
`FAIL`: the open profile with no PAXG ceiling and no per-block cap (`LAUNCH_CAPS=backstop` is
refused); C and G fresh, 8 decimals and describing themselves correctly; g and m inside the
oracle's bounds and m below the headroom the liquidation ratio leaves above par; C within the
gold band of G; XAUT dormant (`xaut:dormant`); no Pyth or Uniswap TWAP adapter anywhere.
`recovery:PAXG` and `xaut:dormant` state the configuration plainly. It also checks
the three Safes against the policy in the table above (each at least 2-of-3; a
Safe whose views cannot be read, or whose threshold and owners could not belong to a working
Safe, is a `FAIL`; a zero-address executor is a `FAIL` unless `ALLOW_OPEN_EXECUTOR=1` accepts
it, and then a `WARN`, under `policy:TIMELOCK_EXECUTOR`), the role split (one Safe in two roles is a `FAIL` on mainnet),
shared signers between the Safes (a `WARN`), distinctness from the deployer, the deployer's
balance against a gas estimate of the whole ceremony and that no snapshot would be
overwritten. It ends with `Preflight passed.` or a list of `FAIL` lines. A `FAIL` means
you do not deploy today.

Two checks cover the Safes' owners and the fourth Safe:

- `safe:deployer-not-owner` is a `FAIL` when the deployer is an owner of the proposer,
  executor, guardian or operations Safe, and names the Safe. The key is single-use and
  retired, so a Safe it sits on would be left a signer short.
- `OPERATIONS_SAFE` is optional. Set, the preflight checks that it has code, answers as a
  Safe (`safe:operations`) and differs from the three governance Safes and the deployer
  (`safe:operations-distinct`). Unset on mainnet it is a `WARN safe:operations`. A line left
  empty or with its placeholder is a `FAIL env:OPERATIONS_SAFE`.

On a pass it writes `deployments/mainnet.preflight.json`: the effective parameters, their
hash and every finding. Keep it with the snapshot. `deploy.ts` refuses to run on mainnet
unless that file exists, was written for this chain and this deployer and hashes to the
parameters it parses itself, so a value changed after the preflight (or never seen by it)
stops the ceremony before the first transaction. Change anything in `.env.mainnet` and you
run the preflight again. The record also carries the deployer's nonce, and `deploy.ts` starts
a ceremony only at that nonce: once the key has sent anything, a completed deploy included,
the record no longer opens the gate. Run the preflight and the deploy in one sitting.

The record is good for 60 minutes by the chain's clock, and the preflight prints until when.
It also carries each Safe's threshold and owners. `deploy.ts` refuses an older record ("the
preflight record is N minutes old by the chain's clock; the limit is 60 minutes") and reads
the three Safes again, refusing when a threshold, an owner or an address has "changed since
the preflight". The remedy for both is the preflight again, then the deploy.
`PREFLIGHT_MAX_AGE_MINUTES=<whole minutes>` on the deploy changes the limit. A resume
(`DEPLOY_RESUME=1`) is not held to the age limit but is held to the Safe comparison. A
record written before this check existed is refused on mainnet: run the preflight again.

### 3.3 Deploy

```bash
npx hardhat run scripts/deploy.ts --network mainnet
```

**The token's address is fixed before the deploy.** The first transaction creates a
GoldStablecoinDeployer, and that contract creates GSUSD with CREATE2, hands the token's admin
role to the deployer and gives up its own in the same transaction, so it holds no role
afterwards. The token's address follows from the deployer's address and nonce, a salt and the
token's creation code, all known in advance. `GSUSD_SALT` and `GSUSD_ADDRESS` in
`.env.mainnet` name the salt and the address it gives: the preflight computes the address
(`gsusd:address`) and fails a pair that does not agree, and `deploy.ts` asks the deployer
contract itself before the token is created and stops there, with nothing at a wrong address,
if it would stand anywhere else. Only the deployer can call that contract, so nobody can take
the address first. The salt is found off chain with no key and no transaction
(`contracts/scripts/lib/stablecoinAddress.ts` gives the command); a change to the deployer's
address or nonce, or to GoldStablecoin's code, means finding it again, and
`test/StablecoinAddress.test.ts` fails when the code no longer matches the mainnet salt.

It prints the same effective parameters and their hash, checks them against the preflight
record and only then starts. On mainnet it refuses before the first transaction unless the
profile is open with no PAXG ceiling and no per-block cap (backstop is refused), the anchor is
set, independent of C, no configured feed is a Pyth or Uniswap TWAP adapter and XAUT is dormant.
It then sets the anchor and, only where they differ from the oracle's 2% defaults, PAXG's gold
band with `setGoldBand` and its liquidation cap with `setLiquidationClamp`. XAUT keeps its constructor's oracle entry and nothing
else: no collateral type, stability fee, reserve asset or stability pool token. Eleven creation
transactions (fourteen contracts: the eleven, the TimelockController that GoldGovernance
constructs, the CollateralSilo implementation that SiloFactory constructs for its
clones, and the token, which the GoldStablecoinDeployer creates) and at most thirty-five
further transactions, so at most forty-six in all; allow
fifteen minutes. The address book lands in
`deployments/mainnet.json`, with the parameters hash in its `config`. Minting on PAXG is open, with
no ceiling, from the moment the deploy registers the collateral type, so run the handover
the same hour.

Before its first transaction it also refuses when `deployments/mainnet.json` already exists
(a second deploy would replace the address book of a live system; set
`PREFLIGHT_ALLOW_EXISTING_SNAPSHOT=1` only for a deliberate redeploy, and the old file is kept
as `mainnet.replaced-<time>.json`) and when the deployer cannot pay for the ceremony at the fee
quoted now, with the preflight's 25% margin: the preflight's estimate is from the fee at its
own run.

It closes by naming the one handover command of step 3.6 and by reminding you that the shell
still exports `PRIVATE_KEY`. From that shell run only the remaining ceremony steps, in this
order: `scripts/verify-deployment.ts`, `scripts/verify-etherscan.ts`,
`scripts/transfer-governance.ts` and the verification the handover names. No installs, no
builds, nothing else.

**Never speed up or cancel a ceremony transaction from a wallet.** The ceremony never
replaces a transaction itself. One that is not mined within 20 minutes stops the run with its
hash and the deployer nonce printed (`DEPLOY_WAIT_TIMEOUT_MINUTES=<1 to 1440>` changes the
wait). Wait until the explorer shows it mined, then resume as below; resuming earlier is
safe, it waits again.

**If it stops part way.** A gateway error, a fee spike or the deployer running dry can stop
the ceremony after some contracts exist. Nothing is lost: every creation and every wiring
step is journaled to `deployments/mainnet.inprogress.json` as it lands, with the hash of each
transaction before its receipt is awaited. The script prints where it stopped. Wait for any
transaction still pending to confirm, fix the cause (fund the deployer, change the endpoint),
then run the same command again with the same `.env.mainnet` and `DEPLOY_RESUME=1`:

```bash
DEPLOY_RESUME=1 npx hardhat run scripts/deploy.ts --network mainnet
```

It refuses a journal written for another chain, another deployer or other parameters, settles
the transaction it was waiting on, checks every journaled contract (its creation receipt is
the deployer's and names the address, and code is there) and every journaled step (its
receipt succeeded and, where the setting is readable, the chain shows it) and sends only what
is still owed. A step the chain already shows is recorded without a transaction. Any
disagreement between the journal and the chain stops the run before it sends anything:
investigate, do not delete the journal. Without `DEPLOY_RESUME=1` the deploy refuses to start
while the journal exists. On success the snapshot is written and the journal removed.

Every read the ceremony makes after a transaction is pinned to the block of the last receipt
it has seen and retried for about twelve seconds, so an endpoint that answers from a node
still behind that block slows the ceremony down instead of stopping it; a read that never
settles stops it with the read named, and `DEPLOY_RESUME=1` carries on from there.

The transaction the journal was waiting on is looked up for the same twelve seconds before
the resume treats it as unknown. A contract creation the endpoint still does not know is sent
again at the deployer nonce the original used, so the original and the copy can never both
land. The journal keeps the hash of the original and of every copy, and the ceremony adopts
whichever of them is mined. An endpoint that knows the original refuses the copy for its
nonce, and the next `DEPLOY_RESUME=1` adopts the original. An endpoint that never saw the
original may accept the copy; the run then watches every hash and the deployer's nonce, adopts
the original if it shows up, and stops if the nonce stays spent for about twelve seconds with
no receipt for any of them. The next `DEPLOY_RESUME=1`, once the endpoint shows the original,
adopts it; no hand edit of the journal is needed. When the chain shows that nonce as spent but
the endpoint shows none of the transactions, the resume stops and names the address the
deployer's transaction at that nonce created; wait for the endpoint to catch up and run the
resume again.

**If a contract creation was replaced by hand all the same** (same nonce, same creation data,
a higher fee), wait until the replacement is mined, then name it:

```bash
DEPLOY_RESUME=1 DEPLOY_REPLACED_CREATION=<replacement tx hash> npx hardhat run scripts/deploy.ts --network mainnet
```

It is adopted only if the chain shows it mined, sent by the deployer, at the pending
creation's nonce, as a contract creation with the same creation data. Anything else is
refused and the journal is left unchanged. A replaced wiring step needs no flag: the resume
reads the setting from the chain. Do not edit the journal by hand.

### 3.4 Verify the wiring

```bash
npx hardhat run scripts/verify-deployment.ts --network mainnet
```

**The endpoint must serve event logs over at least 500 blocks a query.** The role census of
`verify-deployment.ts` and of `transfer-governance.ts` replays every role grant since the
deployment, and narrows its window no further than 500 blocks. On an endpoint with a narrower
window the verification reports `census: the role census could not be taken` and the handover
refuses before it sends anything; nothing is wrong with the deployment. Run both with
`RPC_URL` set to an endpoint with a wide window (the keyless
`https://mainnet.gateway.tenderly.co` served it on launch day); the transactions are signed
locally whichever endpoint relays them.

Expect `All verification checks passed.` The first check, `preflight:record-matches-snapshot`,
compares the snapshot's config with the parameters the preflight recorded, so the chain is
checked against what was approved and not only against what was deployed. The PAXG-first
checks follow the oracle section: `oracle:paxg.goldBandPpm`,
`oracle:paxg.liquidationClampPpm`, `policy:open-launch.ceilings-unlimited` and
`policy:open-launch.perBlockMintCap-off`, `policy:mainnet-profile`, live `quoteTokenPrice` and `quoteBorrowPrice` for PAXG, and
XAUT inactive everywhere (`xaut:inactive.collateral-type`, `.debt-ceiling`, `.stability-fee`,
`.reserve-asset` and `.pool-token`). Every launch parameter the snapshot records is then
compared with the chain by equality, one `param:` line each: the PAXG stability fee, minDebt,
the underwater discount, the origination fee, the penalty share, the bad debt threshold, the
per-block mint cap, the reserve's daily cap, minimum, aggregate daily cap and spread curve, the
buffer's floors, the silo cap and the silo role lock. A `code:<name>.runtime-hash` line per
address compares the code on chain with the hash deploy.ts recorded. A value the snapshot does
not record fails rather than passing unchecked. Six `stranded:` lines (four while XAUT is
inactive) compare what the reserve and the buffer count with the token balance each holds,
for GSUSD and for gold. They were added after the 11 November rehearsal, so a run now has
that many checks more than the counts section 2 records. An excess is a warning, not a
failure: tokens sent by a plain transfer, which nothing can move or recover. Read it, and
size every later withdrawal from the counted figure. Anything else:
stop, do not hand over governance on a broken deployment, page whoever is on call.

### 3.5 Publish the source

```bash
npx hardhat run scripts/verify-etherscan.ts --network mainnet
```

Verifies all fourteen contracts on Etherscan (the eleven created, the token that the
GoldStablecoinDeployer created, the timelock and the CollateralSilo implementation, whose
address the script reads from the SiloFactory) with the
constructor arguments rebuilt from the snapshot. Safe to re-run until every contract reports `verified` or `already verified`.

### 3.6 Hand over governance (irreversible)

```bash
CONFIRM=YES npx hardhat run scripts/transfer-governance.ts --network mainnet
EXPECT_GOVERNANCE_TRANSFERRED=1 npx hardhat run scripts/verify-deployment.ts --network mainnet
```

This one command is the whole handover. It covers nine contracts: the stablecoin, the oracle,
the vault, the stability module, the surplus buffer, the stability pool, the reserve, the
GoldGovernance wrapper and the silo factory. Never send the `transferGovernance` calls by
hand: a deployer left as the wrapper's admin could still drive the timelock.

After this the deployer holds nothing and the timelock holds everything. Run it the same
hour as the deploy; every minute in between is a minute the deployer key could be used.
The handover takes the role census before its first transaction and stops on any role
holder the ceremony did not intend, while the deployer can still revoke it. The second
command must pass every `gov:*` and `census:*` check and `timelock:grace-period-7d`: each
privileged role held by exactly its intended set (`LAUNCH.md` step 4, the role census)
and a timelock whose matured operations expire after 7 days.

If the handover stops part way (a dropped endpoint, a fee spike, an empty wallet), wait
for any transaction still pending to confirm, then run the first command again. It reads
who administers each contract from the chain, all at one block, takes the census at that
same block, sends only the transactions still owed and records `governanceTransferred`
once every contract verifies. A run that finds nothing left to send verifies and records
the handover all the same. A run started while a transaction is still pending can lose one
reverted transaction and stop again; run it once more. It refuses to send anything when a
contract's admin role is held in a way the handover never leaves behind. Because every
read describes one block, that is not a transaction caught in mid-flight: somebody else
has moved a role, so stop and find out who before going further. Finish with the second
command as above.

### 3.7 Retire the key, then record it

Retire the deployer key first, in this order. `transfer-governance.ts` prints the same three
actions when it finishes, after it names the verification of step 3.6. That verification runs
first, because it still reads through `RPC_URL` from this shell. The script prints the three
actions only on mainnet, or with `REQUIRE_PREFLIGHT_RECORD=1`; on Sepolia or a plain fork
rehearsal it names the verification alone.

```bash
unset PRIVATE_KEY RPC_URL ETHERSCAN_API_KEY
rm .env.mainnet                       # you are in contracts/
exit                                  # close this shell; everything below runs in a new one
```

Deleting the file alone leaves the key exported to every command run from that shell. The
deployer key has no power left; move its remaining ETH from a wallet (there is no script for
it) and never reuse it.

In a new shell, from the repository root. Step 3.1 checked out a commit, not a branch, so
the record goes on a branch of its own and is merged like any other change:

```bash
git switch -c chore/mainnet-ceremony-$(date -u +%Y-%m-%d)
git add contracts/deployments/mainnet.json contracts/deployments/mainnet.preflight.json
git commit -m "chore(mainnet): deployment ceremony $(date -u +%Y-%m-%d)"
git push -u origin HEAD
```

## 4. Services, the same day

Three hosts with one job each (the watcher of section 4.8 shares the API server): the dapp on IPFS behind your ENS name with a DNS mirror,
the API on its own server, the keeper on another. The API and the keeper never share a
machine, and the keeper key exists on exactly one. Do everything in this section from
the project accounts of section 1.

### 4.1 Print the three environment blocks

In the new shell, export the RPC endpoint alone; the deployer key stays retired:

```bash
cd contracts
export RPC_URL=<mainnet RPC URL>
npx hardhat run scripts/print-service-env.ts --network mainnet
```

The addresses come from the snapshot, so nothing is retyped. Fill in the `<fill in: …>`
placeholders: the RPC URLs, the API endpoint, the public repository URL, the WalletConnect
id, the keeper key and the keeper's dead-man URL. The API block ends with the Usage Ledger's
lines (section 4.6): its start is the timestamp of the deployment block, which the printer
reads through `RPC_URL`. A placeholder that says "or delete this
line" is optional: fill it or delete the line, because the dapp build and the keeper both
refuse a value still holding a placeholder.

- **The browser RPC.** `VITE_MAINNET_RPC_URL` takes one or two https endpoints separated by a
  comma, the preferred one first: `VITE_MAINNET_RPC_URL=https://<provider-a>/<key>,https://<provider-b>/<key>`.
  The dapp fails over to the second when the first fails; WalletConnect uses the first. Use
  the browser endpoints of section 1, never the keeper's or the API's. With the
  choice made on 2026-11-20 the line is
  `VITE_MAINNET_RPC_URL=https://mainnet.gateway.tenderly.co,https://ethereum-rpc.publicnode.com`. The `<provider-a>` and
  `<key>` above stand for your own values: a mainnet build refuses any RPC, API or source
  URL (`VITE_MAINNET_RPC_URL`, `VITE_API_URL`, `VITE_SOURCE_URL`) that still contains an
  angle bracket, typed or percent-encoded (`%3C`, `%3E`).
- **The contract addresses.** A mainnet build also refuses one address used in two contract
  variables, and a contract variable that holds the mainnet PAXG or XAUT address: each
  protocol contract, the Uniswap router and the Uniswap quoter is a different contract and
  none of them is a gold token. The refusal names the variable and the first holder of the
  same address.
- **The site origins.** The API block carries
  `CORS_ORIGINS=https://goldstandardfinance.eth.limo,https://goldstandard.finance`. `SITE_URL` replaces the
  list with one origin or a comma-separated list:
  `SITE_URL=https://goldstandardfinance.eth.limo,https://goldstandard.finance npx hardhat run scripts/print-service-env.ts --network mainnet`.
- **The market tab is off.** The mainnet dapp block leaves out `VITE_UNISWAP_ROUTER`,
  `VITE_UNISWAP_QUOTER` and `VITE_DEX_POOL_FEE` and says so in three comment lines, so the
  swap page shows the reserve alone. The tab quotes GSUSD against PAXG in one hop, so the
  GSUSD/USDC position of section 5 does not serve it, and no launch step seeds a GSUSD/PAXG
  pool. Once a GSUSD/PAXG 0.30% Uniswap v3 pool is seeded at a fair price, print the block
  with the tab on and rebuild the dapp:
  ```bash
  DEX_MARKET=1 npx hardhat run scripts/print-service-env.ts --network mainnet
  ```

Then regenerate the agent surface so agents see the mainnet addresses the moment the dapp
is published, and commit the result with the snapshot. The script writes
`apps/dapp/public/agents.json`, `llms.txt` and the ABIs under `apps/dapp/public/abi/`;
none of them is edited by hand, and the drift test in `contracts/test/AgentManifest.test.ts`
fails when they are stale:

```bash
npx hardhat run scripts/print-agent-manifest.ts
```

It reads the same `SITE_URL` and builds its links from the first entry; unset, it uses
`https://goldstandardfinance.eth.limo`, the canonical origin and the first one `print-service-env.ts`
prints. `docs/AGENTS.md` is written by hand and needs no edit at
launch: it points at the manifest for which networks are deployed. Run the script again after
every later parameter change, the XAUT activation and the minter lock.

### 4.2 Publish the source

Users expect to read the frontend they are trusting. The source of the release is published
as one commit in the project's public repository, and the dapp is built from that repository
alone (section 4.3). Commit `deployments/mainnet.json` first (step 3.7) so the published
source carries the address book.

That public repository is what `VITE_SOURCE_URL` names: the footer's build stamp links
every visitor to the exact commit the page was built from.

### 4.3 Build the dapp

Build from a fresh clone of the public repository, never from a developer checkout: a
checkout carries `apps/dapp/.env.local` with Sepolia values and Vite loads that file in
every mode. The build refuses to run with the end-to-end wallet flag anywhere in its
environment, and refuses any `VITE_TARGET_CHAIN_ID` but `1` or `11155111`, an unset or empty
one included, because that would build the Sepolia frontend. The printer writes
`VITE_TARGET_CHAIN_ID=1` into the dapp block from the snapshot.

A `VITE_TARGET_CHAIN_ID=1` build also refuses, with every problem in one message:

- any `VITE_*` value still holding a `<fill in: …>` placeholder (fill it or delete the line;
  this one applies to Sepolia builds too);
- `VITE_MAINNET_RPC_URL` or `VITE_API_URL` unset or not https, and `VITE_SOURCE_URL` not
  https when set;
- `VITE_DEPLOY_BLOCK` not a positive whole number;
- any of `VITE_GOLD_VAULT_ADDRESS`, `VITE_GOLD_ORACLE_ADDRESS`, `VITE_GUSD_ADDRESS`,
  `VITE_STABILITY_MODULE_ADDRESS`, `VITE_STABILITY_POOL_ADDRESS`,
  `VITE_STABILITY_RESERVE_ADDRESS`, `VITE_SURPLUS_BUFFER_ADDRESS`,
  `VITE_SILO_FACTORY_ADDRESS` and `VITE_VAULT_REGISTRY_ADDRESS` unset, malformed, with a
  broken checksum or zero;
- `VITE_UNISWAP_ROUTER` or `VITE_UNISWAP_QUOTER` malformed when set;
- `VITE_PAXG_ADDRESS` or `VITE_XAUT_ADDRESS` other than mainnet PAXG
  `0x45804880De22913dAFE09f4980848ECE6EcbAf78` and XAUT
  `0x68749665FF8D2d112Fa859AA293F07A622782F38`;
- the presence of `apps/dapp/.env.local`, unless `VITE_ALLOW_ENV_LOCAL=1` is set.

It warns, and continues, when `VITE_WALLETCONNECT_PROJECT_ID` is absent.

The dapp block carries `VITE_LEDGER_ENABLED=true`: the Usage Ledger page, with its
disclaimer, is part of the launch build (section 4.6). Leave the line as printed.

```bash
git clone <public repository url> && cd <clone> && npm ci
# paste the dapp block into apps/dapp/.env.production.local
npx nx build dapp
```

The output is `dist/apps/dapp`: the page, the hashed bundles, the self-hosted fonts, the
`_headers` file with the content security policy, the `_redirects` file with the single
rule `/* /index.html 200` (deep links and refreshes resolve on gateways that honour it) and
`.well-known/security.txt`. Do not add a `404.html`: a static host such as Cloudflare Pages turns its own
single-page fallback off when one exists. The
footer shows the commit it was built from. The page loads no third-party origin, so a
visitor on IPFS gets a self-contained site.

The build also writes two things that listing sites and wallets read from the site:

- `brand/`: the official marks, copied from the repository's `brand/` folder (`gsusd.svg`,
  `gsusd-32.png` to `gsusd-512.png`, `protocol.svg`, `protocol-256.png`, `protocol-512.png`).
  Their paths do not change between builds, so a listing can point at them.
- `tokenlist.json`, in a mainnet build only: GSUSD in the Token Lists format, with the address
  from `VITE_GUSD_ADDRESS` and the day of the commit as its timestamp. Its version is
  `TOKEN_LIST_VERSION` in `libs/constants/src/lib/tokenList.ts`; raise it when the listed
  details change.

One optional line in the dapp block turns on the "Buy GSUSD on Uniswap" link on the swap page:
`VITE_GSUSD_MARKET_TOKEN=<the token GSUSD is paired with>`, for the GSUSD/USDC pool
`0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` (mainnet USDC). Set it only once that pool holds
liquidity; without it the page shows no link. It is a link to Uniswap's own site and has
nothing to do with the market tab (`VITE_UNISWAP_ROUTER` and `VITE_UNISWAP_QUOTER`), which
stays off.

### 4.4 Put it on IPFS behind the ENS name

Either route produces a content identifier (CID); the ENS name then points at it.

**Route A, Fleek.** Connect the public repository, build command `npx nx build dapp`,
publish directory `dist/apps/dapp`, the dapp block as environment variables. Every push
publishes a new CID, and Fleek can update the ENS content hash for you, asking the ENS
owner wallet to sign each time. Paste the values as printed. The dapp reads contract and
Uniswap addresses trimmed, so a stray space or line break around one does no harm. An address
that is not valid is never used: a mainnet build refuses it (section 4.3), and a bundle that
carries one all the same treats that contract as not configured and reports the variable
once in the browser console.

**Route B, by hand with Kubo** (`ipfs` on your machine):

```bash
ipfs add -r --cid-version 1 --hidden -Q dist/apps/dapp            # prints the CID
ipfs pin remote service add pinata https://api.pinata.cloud/psa <pinata jwt>
ipfs pin remote add --service=pinata --name="gold-standard $(git rev-parse --short=10 HEAD)" <cid>
```

Filebase speaks the same pinning API at `https://api.filebase.io/v1/ipfs`; pin on both.
Then, in the ENS app, set the name's Content Hash record to `ipfs://<cid>`: one
transaction from the ENS owner wallet, repeated for every release. The site is live at
`https://goldstandardfinance.eth.limo` and in every wallet browser that resolves ENS.

**Before the ENS record names the CID**, open `/vault` and `/docs/faq` directly, and refresh
each, on a gateway that serves the pinned test CID at an origin root. Whether the eth.limo
gateway honours `_redirects` has not been verified. If a deep link returns 404 there, do not
announce the address: the IPFS build then needs `HashRouter`, which is a code change and a
new build.

Pinata's pin-by-CID call (the `ipfs pin remote add` line above) needs a paid plan. On a free
plan upload the build instead: export it once with `ipfs dag export <cid> > build.car`, send
the CAR file to a Filebase bucket with the `x-amz-meta-import: car` header, and send the
folder to Pinata with `pinFileToIPFS` and `cidVersion` 1. Both must answer with the CID Kubo
printed; a different one means the upload was not the same build.

Record the commit and the CID together in the release notes. The builds published so far:

| Date | Public commit | Footer | CID |
| --- | --- | --- | --- |
| 2026-11-27 | `05f2e37064d27762033fa71ee377b67fdb33a83b` | `05f2e37064` | `bafybeihzxintmewtjoln5hlswyyqheiqppjaqjpp4f2mhrdwc43wk7xfhi` |
| 2026-11-27 | `726520f9f27f87e34f36f0efe11c5b8b38f01462` | `726520f9f2` | `bafybeigvdu23a3kupvhd2pnpuhbgp5bq46avrxfphlq6i7xhhr7exfq35e` |
| 2026-11-27 | `5a6f557a3296e6e9648024b3a4a9b7544b664e40` | `5a6f557a32` | `bafybeiaham7sill2op7lau6ovg23jkmervesr7igmrhowxswcj3tesph2i` |
| 2026-11-27 | `54a5f731236409bc03f80de7c4295059c8b0ab96` | `54a5f73123` | `bafybeihhjqp5ejjxd4rcnrv7cx5zgdm3qauvcorzt6wwq2gkofjmafruf4` |

The ENS record names the latest once the owner wallet has set it; read the record to see which build the name serves. The build expects to sit at
an origin root, which an ENS gateway or the mirror provides. It does not work under a path
such as `/ipfs/<cid>/` on a general gateway, where its routes and asset paths do not
resolve.

### 4.5 The DNS mirror

The mirror is the same `dist/apps/dapp` folder that was pinned, byte for byte, served as
static files by the Caddy that already runs on the API server (section 4.6), with Cloudflare
in front of it. Copy the folder to a directory named after the build commit, compare a hash
of every file with the pinned build, and point the served path at it with a symbolic link, so
a release is one switch and the previous build stays beside it. Custom domain
`goldstandard.finance`, DNSSEC on at the registrar, the registry lock on.

Caddy does not read the `_headers` and `_redirects` files, so its site block does their work:

- every response carries the headers `_headers` lists, the content security policy first,
  which allows no script that was not in the published build;
- a path that is no file answers with `index.html` (deep links and refreshes), except under
  `/assets/`, where a missing file is a 404 and never the page;
- `/tokenlist.json`, `/brand/*`, `/agents.json`, `/llms.txt`, `/manifest.json` and `/abi/*`
  carry the cross-origin and cache headers `_headers` gives each of them;
- `_headers` and `_redirects` themselves answer 404.

After each release, compare the response headers of `/` with `_headers` line by line.

The build finishes `sitemap.xml` itself: every page carries the day of the commit the
build was made from (`VITE_BUILD_DATE=YYYY-MM-DD` on a build server without git), and a
build with `VITE_LEDGER_ENABLED=true` lists the ledger page.

The mirror is a convenience. The ENS name is what users verify, so the footer on both must
show the same commit.

Search engines are pointed at `https://goldstandard.finance` (project decision, 2026-11-15).
The page's canonical link, its social card, `sitemap.xml`, `robots.txt` and `security.txt`
name that origin, while `print-service-env.ts`, the agent manifest and this sheet treat
`https://goldstandardfinance.eth.limo` as the address users verify. The split is deliberate: search engines
index the DNS mirror, users verify the ENS name.

One more step belongs to the domain. Add `https://goldstandard.finance` and
`https://goldstandardfinance.eth.limo` to the allowed origins of the WalletConnect project, or QR and mobile
connections fail.

### 4.6 The API server

The first VPS: Ubuntu, Node 22, Redis 7, Caddy. Create the service user and the env file,
readable by root alone (systemd reads it as root before it drops to `gsusd`), then paste the
API block into it:

```bash
sudo useradd --system --no-create-home --shell /usr/sbin/nologin gsusd
sudo install -d -m 755 -o root -g root /etc/gsusd
sudo install -m 600 -o root -g root /dev/null /etc/gsusd/api.env
sudoedit /etc/gsusd/api.env
```

The block carries `NODE_ENV=production`, `REDIS_URL` (the preferred form; it wins over
`REDIS_HOST` and `REDIS_PORT`) and `CORS_ORIGINS` set to the site origins, comma separated:
`https://goldstandardfinance.eth.limo,https://goldstandard.finance`; `*` is available for a fully
public API, and is the one setting that lets a user's local copy of the dapp read it.

```bash
git clone <public repository url> /srv/gsusd/src && cd /srv/gsusd/src && npm ci
npx nx build api
```

```ini
# /etc/systemd/system/gsusd-api.service
[Unit]
Description=gsUSD API
Wants=network-online.target
After=network-online.target redis-server.service
StartLimitIntervalSec=0

[Service]
EnvironmentFile=/etc/gsusd/api.env
WorkingDirectory=/srv/gsusd/src
ExecStart=/usr/bin/node dist/apps/api/main.js
Restart=always
RestartSec=10
User=gsusd
NoNewPrivileges=yes

[Install]
WantedBy=multi-user.target
```

```text
# /etc/caddy/Caddyfile
api.goldstandard.finance {
    request_body {
        max_size 1KiB
    }
    encode zstd gzip
    reverse_proxy 127.0.0.1:3333
}
```

The API refuses a tRPC request body over 1 KiB itself (an unread
body would otherwise be buffered for an unauthenticated caller); the same limit in Caddy drops an
oversized upload at the edge, before it holds a connection to the API. No procedure of the
API reads a larger body. `encode` compresses
responses, chiefly `vaults.owners`, which returns the whole owner set to every visitor of the
Liquidations page.

**Supply figures for listing sites.** The API answers `/supply/total` and
`/supply/circulating` with the GSUSD supply as a plain number and nothing else
(`curl -s https://<api host>/supply/total` prints `1551`), which is the form price trackers
poll. Both paths give the same figure: GSUSD exists only as vault debt, so none is held
back. The figure is `totalSupply()` read through the indexer's own endpoint and vault
address, kept for a minute; it needs no variable of its own. If the endpoint fails, the
last good read stands in for ten minutes and after that the answer is 503.

**Switch the Usage Ledger on, the same day.** `docs/TOKEN_POLICY.md` section 2 commits the
project to a Gold Standard Usage Ledger from the first mainnet block: a record of vault
debt, StabilityPool deposits and GSUSD liquidity held over time, per address, with no token
attached to it. The ledger is weighted by the second, never deletes a record and is
published by the API as one file with a hash (`/usage-ledger.csv` and `/usage-ledger.json`). The ledger is off unless it is configured, so the printer of section 4.1
writes its variables into the API block and `VITE_LEDGER_ENABLED=true` into the dapp block.
`docs/USAGE_LEDGER.md` is the operator sheet: what is recorded, how to check it, how to
publish it and how to recover.

1. Keep the three ledger lines of the printed API block as they are. The printer reads the
   timestamp of the deployment block from `RPC_URL` and writes it as
   `LEDGER_START_TIMESTAMP`, so the ledger records from the first block. If that read
   failed, the printer says so and prints the line as a `<fill in: …>` placeholder: fill in
   the timestamp of `GOLD_VAULT_DEPLOY_BLOCK`
   (`cast block <deploy block> -f timestamp --rpc-url "$RPC_URL"`), because the API leaves
   the ledger dormant on a value it cannot read. The first run computes the ledger from the
   deploy block.
2. Build the dapp from the printed dapp block (section 4.3), so that the page at `/ledger`,
   with its disclaimer, is part of the published site.
3. Leave the two liquidity lines commented out, as printed, until the official GSUSD pool
   against a dollar stablecoin exists on Uniswap v3. Setting them is a step of the first
   week (section 5).
4. Leave `LEDGER_MAX_ADDRESSES` unset. The default of 125,000 addresses keeps the ledger
   near 290 MB on the API host. It is a memory guard only: if the API ever logs a line
   beginning `Usage ledger reached its cap of`, raise it and restart, and the ledger
   recomputes itself complete (`docs/USAGE_LEDGER.md` section 1.4).
5. Once a month, archive the record and publish its block and hash
   (`docs/USAGE_LEDGER.md` section 7.3).

| Variable | Where | Meaning |
| --- | --- | --- |
| `LEDGER_START_TIMESTAMP` | API env, printed | Unix seconds from which usage is recorded: at or before the time of the deployment. Unset: the ledger is off and the API schedules no ledger work |
| `LEDGER_STABILITY_POOL_ADDRESS` | API env, printed | The StabilityPool address. Required once the start is set |
| `LEDGER_MAX_ADDRESSES` | API env, not printed | The most address records the ledger opens, from 1,000 to 2,000,000. Unset: 125,000. No record is ever deleted, so this is the ledger's only bound on memory; changing it recomputes the ledger |
| `LEDGER_CONFIRMATIONS` | API env, printed | Blocks behind the head the ledger index stops at; printed as 12, which is also the value when unset |
| `LEDGER_LIQUIDITY_POOL_ADDRESS` | API env, printed as a comment, set once the pool exists | The Uniswap v3 pool whose positions are recorded as the third dimension: the official pool of GSUSD against a dollar stablecoin. Unset, together with the next variable: liquidity is not recorded and nothing about it is shown. Setting, changing or removing it recomputes the whole ledger (`docs/USAGE_LEDGER.md` sections 1.3 and 2) |
| `LEDGER_LIQUIDITY_POSITION_MANAGER` | API env, printed as a comment, set once the pool exists | The Uniswap v3 NonfungiblePositionManager of the chain. Set it together with the pool address or leave both unset; one without the other leaves the whole ledger dormant with a line that says so |
| `VITE_LEDGER_ENABLED` | Dapp build, printed as `true` | The exact value `true` adds the Usage Ledger page and its navigation entry. `false`, or leaving the variable unset, leaves the page out, with no ledger code in the bundle. Any other value stops the build |

`TRUST_PROXY_HOPS=1` in the API block is correct for this shape: Caddy is the one hop. The
API binds `127.0.0.1` by default (`API_HOST`, which the printed block sets explicitly), so
only Caddy on the same machine reaches port 3333 and no client can connect directly and pass
for the proxy, choosing its own rate-limit key through `X-Forwarded-For`. Keep it that way.
If the proxy ever moves to another host, set `API_HOST` to this machine's address on the
private network between them, or to `0.0.0.0` with a firewall that admits the proxy alone;
`API_HOST` takes one IP address, never a host name, and anything else stops the process at
startup. While `API_HOST` is not a loopback address and `TRUST_PROXY_HOPS` is above 0, the API
logs a warning at every start that names the port the firewall must close to everything but
the proxy.

**The DNS record for the API host is DNS only (grey cloud).** With the Caddyfile above and
`TRUST_PROXY_HOPS=1` the API limits each client address to 120 requests a minute. If the
record is proxied through Cloudflare, Caddy sees Cloudflare's edge address as the client, so
every visitor behind one edge address shares one bucket and receives 429s. To run proxied
instead, all three are needed together: Caddy `trusted_proxies` set to Cloudflare's published
address ranges, so that it keeps the forwarded client address (Caddy's documented default is
to discard it from an untrusted peer); `TRUST_PROXY_HOPS=2`; and port 443 firewalled to
Cloudflare's ranges, so that no client reaches Caddy directly and chooses its own
`X-Forwarded-For`.

```bash
sudo systemctl enable --now gsusd-api
curl -s https://api.goldstandard.finance/trpc/tokensRouter.getAll | head -c 300   # JSON naming PAXG
```

A single-host variant exists for a staging copy: set `DAPP_DIST` to a dapp build and
leave `CORS_ORIGINS` unset, and the API serves the dapp from its own origin. The build
must contain `index.html` and the `_headers` file; the API parses that file at startup and
sends the same response headers as the Cloudflare mirror (the content security policy,
nosniff, frame denial, the referrer and permissions policies), adds HSTS only on requests
that arrived over TLS behind `TRUST_PROXY_HOPS`, refuses `/_headers` and every dotfile path
except `.well-known` and serves `/.well-known/security.txt`. The tRPC surface answers an over-limit client with
429 and the CORS headers for an allowed origin, so a browser sees the refusal rather than an
opaque failure.

**An RPC plan with a narrow log window.** The owner index and the ledger index read event
logs with `eth_getLogs`, by default 10,000 blocks at a time, and halve a window the provider
refuses down to 100 blocks. A plan that allows fewer than 100 blocks a query would refuse
every window, so name its cap in the API block: `INDEXER_MAX_BLOCK_RANGE=10` on a plan that
allows ten. Mainnet makes five blocks a minute and both indexes run every minute, so in step
with the chain a run needs one or two ten-block queries. Catching up is what costs: a ten
block window reads 30 queries for an hour of chain, the ledger index reads at most 50
windows a run, and a rebuild from the deploy block weeks after launch is tens of thousands
of queries. Point the API at an endpoint with a wide window for a rebuild, then switch back.
The dapp reads a vault's history from the visitor's browser through the browser endpoints,
which need a wide window whatever this is set to.

### 4.7 The keeper server

The second VPS, at a different provider. Create the service user and the env file, readable
by root alone, then paste the keeper block into it:

```bash
sudo useradd --system --no-create-home --shell /usr/sbin/nologin gsusd
sudo install -d -m 755 -o root -g root /etc/gsusd
sudo install -m 600 -o root -g root /dev/null /etc/gsusd/keeper.env
sudoedit /etc/gsusd/keeper.env
```

It is the only file that holds `KEEPER_PRIVATE_KEY`; the API's file must never contain it.
A file created with the default permissions is readable by every account on the host, and
this key holds ETH and the GSUSD float.
Use a Flashbots Protect endpoint (`https://rpc.flashbots.net/fast`) as `KEEPER_RPC_URL` so
liquidations are not front-run in the public mempool, and list one or two ordinary mainnet
endpoints at other providers in `KEEPER_READ_RPC_URLS` so reads survive a relay outage or rate
limit. Sends, nonces and receipts always use `KEEPER_RPC_URL`. docs/LAUNCH.md ("How the keeper
uses its endpoints and its time") covers the read fallback, `keeper.read-rpc-unavailable`, the
first tick at start, the 60 second stop grace (`keeper.shutdown-tick-abandoned`) and why the
second keeper starts half an interval after the first.

The keeper VPS needs no Redis: with `VAULT_REGISTRY_ADDRESS` set (every deployment from
2026-10-22 on has one) the keeper discovers vault owners from the registry on chain, builds
no Redis client and logs the sources it uses as `ownerSources` in `keeper.started`. Only a
keeper for an older deployment without a registry shares the API's Redis, and then it needs
the API's exact `REDIS_URL` and `REDIS_NAMESPACE`; the printer emits whichever applies. The
keeper refuses to start when neither a registry nor a Redis is configured.

The CoinGecko watchdog needs a market price from somewhere, and it must keep working on this
Redis-free host because it is the one check that does not come from Chainlink. By default the
keeper fetches the price itself when no Redis is configured (`KEEPER_OFFCHAIN_PRICES=http`,
one request a tick and never more than one every 30 seconds to `KEEPER_PRICE_API_URL`, CoinGecko's simple price endpoint
unless a mirror is given) and reads the API's cached quote when Redis is (`redis`). `none`
switches the comparison off. The quote is display grade and reaches a log line only, never a
transaction; a failed request keeps the last price for ten minutes and after that the keeper
says `oracle.offchain-price-missing` once, at warn, with the reason, then
`oracle.offchain-price-restored` when the price is back. `keeper.started` names the source in
use as `offChainPriceSource`.

Two fee ceilings bound what the keeper will ever pay: `KEEPER_MAX_FEE_GWEI` (default 150)
and `KEEPER_MAX_PRIORITY_FEE_GWEI` (default 3), decimal gwei. The tip is cut to its ceiling.
A max fee estimate above `KEEPER_MAX_FEE_GWEI` is cut to the ceiling while the current base
fee plus the tip still fits under it, and only past that is the liquidation skipped and
reported, never sent; such a send has less room for a rising base fee and may stick, which
the stuck transaction rule below handles. `KEEPER_INTERVAL_SECONDS` must sit between
5 and 86400. At start the keeper asks the RPC for `eth_chainId` and refuses to run when it
differs from `KEEPER_CHAIN_ID`, so a mainnet keeper pointed at a testnet endpoint stops
before it signs anything. The keeper has no oracle duty to keep: the oracle needs no
observation or heartbeat, and liquidation resumes by itself on the first healthy pair of
feeds. It watches oracle health and alerts, and liquidates sized from `quoteTokenPrice` only
while both feeds are healthy. Wire its oracle alerts into on-call: a refused price, an invalid
feed, PAXG off the gold band (borrowing and reserve swaps refused while liquidation values
PAXG at gold) and PAXG's premium above the liquidation cap (liquidation capped at
G × (1 + m)), plus the CoinGecko watchdog.

The keeper liquidates to protect solvency, not for profit: it has no check of gas cost
against bounty. Above `KEEPER_MAX_FEE_GWEI` it sends nothing and logs
`keeper.fee-above-ceiling` at warn, followed by `keeper.tx-failed` at error for the refused
send. Keep `keeper.fee-above-ceiling` on the pager, budget the keeper's ETH for liquidations
sent near the ceiling. The ceiling stays at 150 gwei during a crash (project decision,
2026-11-15).

**A late feed.** Both launch feeds write at least every 24 hours and the oracle refuses a
price older than 90,000 seconds, which leaves about an hour (`ORACLES.md` section 2). The
keeper warns `oracle.feed-late` when PAXG/USD or XAU/USD is older than
`KEEPER_FEED_HEARTBEAT_SECONDS` plus `KEEPER_FEED_LATE_MARGIN_SECONDS` (86,400 plus 900)
while it still prices, and repeats at most every `KEEPER_FEED_LATE_REPEAT_SECONDS` (3,600).
`secondsUntilRefused` on the line is the time left before borrowing, withdrawals from a
vault with debt, reserve swaps and liquidation stop for that token; they resume by
themselves on the next round. Nothing is raised while the oracle is paused or the token
frozen.

The warning can fire only while the feed still prices, so
`KEEPER_FEED_HEARTBEAT_SECONDS` plus `KEEPER_FEED_LATE_MARGIN_SECONDS` must stay at least two
seconds below `GoldOracle.stalenessThreshold` (90,000 at launch; 87,300 against it with the
defaults). It stops doing so when governance lowers the threshold to 87,301 or less with the
defaults, or when an operator sets a margin of 3,599 or more against 90,000. The keeper then
logs `oracle.feed-late` with no `source` field, once per token per repeat interval, naming
the two settings in `detail`, and warns at the heartbeat alone, or at half the threshold when
the heartbeat is not below it either. When that line appears, lower the margin (or the
heartbeat) in the keeper's env file and restart the keeper; the line stops once the sum is
below the threshold again.

The keeper sends one transaction at a time. On an ordinary endpoint, one that reports the
keeper's pending transactions, it signs nothing while its account has an unmined nonce.
`KEEPER_STUCK_TX_REPLACE_SECONDS` (default 300, between 60 and 86400) is how
long that nonce may stay outstanding before the keeper replaces it with a zero-value transfer
to itself at the same nonce, both fees raised 12.5% over those it was sent with and never
above the two ceilings. After a restart the keeper no longer knows those fees, so it counts
the age from when it first sees the nonce and bumps a fresh estimate instead, raising its
offer each time a node refuses one as underpriced.

**How many requests the keeper makes.** The jobs of one tick read much of the same protocol
state, so the keeper reuses an answer within a tick and fetches the reads the last tick made
in one request. On 18 November 2026, with two open vaults on Sepolia, a quiet tick fell from
46 requests to 4. `KEEPER_READ_CACHE_MS` (default 4000, between 0 and 10000) is how long a
tick may reuse an answer; 0 sends every read to the chain, as before. Whatever it says, the
first transaction the keeper sends in a tick turns the reuse off for the rest of that tick,
so a liquidation and everything after it read live. A failed read is never reused. Size the
keeper's RPC plan from the provider's own dashboard after the first day: the count grows
with the number of vaults that carry debt, since each one's owner and debt are still read
every tick.

**Behind a private relay this guard is inert.** The pending-nonce guard and the
stuck-transaction replacement work only when `KEEPER_RPC_URL` reports the keeper's pending
transactions. Behind a private relay such as Flashbots Protect the keeper's nonce queries
are unsigned, the relay answers with the confirmed nonce only, and the guard sees nothing
outstanding: `keeper.stuck-tx-replaced` and `keeper.stuck-tx-replacement-blocked` never
fire. No double liquidation follows, because every send reuses the lowest unmined nonce, so
a held private transaction is superseded by the next send and the two can never both mine.
A private transaction that never lands ends its receipt wait after 180 seconds and is logged
`keeper.tx-outcome-unknown` at error with its hash; the keeper sends nothing competing for
that vault in the same tick and tries again on the next. Expect each lost race behind a
relay to cost one receipt wait of up to 180 seconds, during which ticks are skipped
(`keeper.tick-skipped-overlap`, and `ticksSkipped` on the next `keeper.heartbeat`).

Each tick the keeper compares its ETH with the cost of the smallest pool liquidation at the
fee ceiling: 1.4 million gas, the least it sends one with, at `KEEPER_MAX_FEE_GWEI`, which is
0.21 ETH at the default 150 gwei. Below three of those (0.63 ETH) it logs
`keeper.signer-balance-low`. Below one it logs `keeper.signer-balance-insufficient` at error
level. A node refuses a transaction whose gas limit times its fee cap exceeds the sender's
balance, and the keeper offers the network's fee, never more than the ceiling. So below that
line a liquidation is refused once the network fee nears the ceiling, however healthy the
pool is, and still goes through while the fee is well under it: the page is the worst case
the keeper is allowed to pay, not the current cost. Both lines are measured in the smallest
liquidation. A vault spanning many silos is sent with more gas, up to 4 million (0.6 ETH at
the default ceiling), and near the ceiling it can be refused while the wallet still holds
more than 0.21 ETH. About 1 ETH keeps the wallet clear of both lines and covers the largest
liquidation at the default ceiling; a higher ceiling needs proportionally more. The check
only reports: it never holds a transaction back.

**Alerting.** The keeper's only output is one JSON line per event in its journal
(`journalctl -u gsusd-keeper -o cat`), each with `level` and `event`. Nothing pages until
you wire it. Do one of these before `KEEPER_DRY_RUN=false`, and both if you can:

1. **Ship the journal to the pager** with any log shipper that reads the systemd journal.
   Page on every line with `level` `error`, on the warns in the table below, and on the
   dead-man rule: no `keeper.heartbeat` line with `ok` true for 10 minutes. A second rule,
   `keeper.heartbeat` with `blockedLiquidations` or `failedLiquidations` above 0, covers
   failing liquidations in one place.
2. **Without a shipper**, set `KEEPER_HEARTBEAT_URL` to the https ping URL of a hosted
   dead-man check with a period of 1 minute and a grace of 10 minutes. The keeper sends a GET
   to it after every tick that finished with no job error and a readable chain head no older
   than 600 seconds. Treat the URL as a secret: the keeper logs its host only, and refuses
   at start anything but an https URL with no user name or password. The keeper allows the
   whole exchange 5 seconds and discards the response body. A failed ping logs
   `keeper.heartbeat-ping-failed` and never stops the keeper.
   Keep the keeper host on NTP: the heartbeat compares the chain head with the host clock.
   A host more than 600 seconds fast reports every heartbeat with `ok` false and
   `headStale`. A host more than 120 seconds slow reports `ok` false and `headAhead`: a slow
   clock would otherwise make a stalled endpoint look fresh. Either stops the hosted ping.

**Why 10 minutes.** The heartbeat line and the ping are written at the end of a tick, every
60 seconds by default, and intervals that fall inside a running tick are skipped. A tick
that liquidates waits for receipts, each for up to 180 seconds. One direct liquidation waits
on up to three in sequence: the GSUSD approval, the liquidation and, when the liquidation
reverts, the revoke of the approval. That is up to 540 seconds for one vault, during which a
working keeper writes no heartbeat. A partial direct liquidation approves an exact amount,
so it always pays the approval wait as well as the liquidation wait. A grace shorter than
10 minutes therefore pages a keeper that is busy liquidating. The price of the longer grace
is that a keeper that has stopped is noticed up to 10 minutes later; the Tenderly rule for a
vault below 115% covers that gap.

A tick that liquidates several vaults pays those waits once per vault and can pass 10
minutes, most likely during a run of liquidations or behind a private relay, where a lost
race costs a full receipt wait. So check a dead-man page against the journal before treating
it as an outage: `keeper.tx-sent` lines in the last few minutes mean the keeper is working
through liquidations, and the next `keeper.heartbeat` carries `tickSeconds` and
`ticksSkipped` for the long tick. No `keeper.tx-sent` line and no heartbeat means the keeper
is down.

The ping proves the keeper is alive, reads the chain and finished a tick. It does **not**
stop when liquidations are blocked or fail: `vault.liquidation-blocked`, `keeper.tx-failed`,
`keeper.no-liquidation-path` and `oracle.price-refused` do not suppress it. Those need the
log lines on a pager, or the external Tenderly rule for a vault below 115% that
`LAUNCH.md` requires. That Tenderly rule is also what covers the keeper host being down.

| Page on | Event | Meaning |
| --- | --- | --- |
| error | `vault.liquidation-blocked` | A liquidatable vault and nothing was sent: the oracle refuses a price, a pause or freeze blocks it, or neither the pool nor the wallet can take it, not even as a partial |
| error | `keeper.no-liquidation-path` | No path is armed for the vault the pool is measured against: the pool is below its yardstick and the direct path is off or the wallet is below `minDebt` plus 1%. Measured against the largest vault, a pool that holds something still takes the smaller vaults, and the line says so |
| error | `keeper.tx-failed` | A send failed in simulation, was refused or reverted; `functionName` says which |
| error | `keeper.tx-outcome-unknown` | Broadcast, but the receipt could not be read; the hash is on the line |
| error | `keeper.approval-reverted` | The GSUSD approval reverted, so the liquidation was not attempted |
| error | `vault.bad-debt` | A vault has debt and no collateral |
| error | `oracle.price-refused` | The oracle refuses a price, so every liquidation in that token waits |
| error | `keeper.job-error` | A job or a read failed, including "no owner list was read this tick", which means no vault is watched |
| error | `keeper.signer-balance-insufficient` | The wallet's ETH covers less than one pool liquidation at the fee ceiling |
| error | `keeper.stuck-tx-replacement-blocked` | A stuck nonce cannot be replaced within the fee ceilings (ordinary endpoint only) |
| warn | `vault.partial-direct-liquidation` | The wallet could not fund the whole debt and sent the largest valid partial; `uncoveredDebt` remains. Refill the float |
| warn | `oracle.feed-late` | Two shapes. With `source` and `feed`: that feed is past the late mark and still prices; `secondsUntilRefused` is the time left. Without `source`: the configured mark (`configuredLateAfterSeconds`, heartbeat plus margin) is not below `stalenessThreshold`, so a fallback mark is in use; lower the margin. `lateAfterSeconds` is the mark actually applied on both |
| warn | `keeper.fee-above-ceiling` | The network fee passed `KEEPER_MAX_FEE_GWEI`, so a due liquidation was not sent |
| warn | `keeper.signer-balance-low` | The wallet's ETH covers fewer than three pool liquidations; top it up |
| warn | `vault.owners-unread` | Some owners' debt could not be read, so they were not walked this tick |

Worth a ticket rather than a page: `vault.full-liquidation-required` (an underwater vault
accepts only a full liquidation and the pool cannot take it whole), `vault.pool-underfunded`,
`keeper.min-debt-unreadable` (the keeper sizes with the value it last read, and one that has
read none since it started sends no partial and reports its direct path as unarmed),
`keeper.stuck-tx-replaced`, `keeper.read-rpc-unavailable`, `keeper.heartbeat-ping-failed`,
`oracle.feed-invalid`, `oracle.off-gold-band`, `oracle.premium-capped`,
`oracle.price-divergence` and `oracle.offchain-price-missing`.

**A stuck keeper transaction** (ordinary endpoint only; behind a private relay see above). `keeper.stuck-tx-replaced` needs no action unless it repeats:
each replacement waits another full interval and bumps again, so a run of them means the
network is outpacing the bump. `keeper.stuck-tx-replacement-blocked` is a page: the keeper is
idle until the nonce mines. Read the nonce and the fee the event names, then either raise
`KEEPER_MAX_FEE_GWEI` or `KEEPER_MAX_PRIORITY_FEE_GWEI` to cover it and restart (the restarted
keeper replaces the nonce once it has seen it outstanding for the full age), or send the
replacement yourself from the keeper host: a zero-value transfer from the keeper address to
itself at that nonce, with both fees above the stuck ones. Sending at any other nonce does not
help, since the keeper waits for exactly that one.

```bash
git clone <public repository url> /srv/gsusd/src && cd /srv/gsusd/src && npm ci
npx nx build keeper
```

```ini
# /etc/systemd/system/gsusd-keeper.service
[Unit]
Description=gsUSD keeper
Wants=network-online.target
After=network-online.target
StartLimitIntervalSec=0

[Service]
EnvironmentFile=/etc/gsusd/keeper.env
WorkingDirectory=/srv/gsusd/src
ExecStart=/usr/bin/node dist/apps/keeper/main.js
Restart=always
RestartSec=10
User=gsusd
NoNewPrivileges=yes

[Install]
WantedBy=multi-user.target
```

`RestartSec=10` and `StartLimitIntervalSec=0` matter: the keeper exits at start when it
cannot read the chain id from `KEEPER_RPC_URL`, and without them systemd gives up after five
fast failures and leaves the unit failed. With them it retries every 10 seconds for as long
as the endpoint is down.

```bash
sudo systemctl enable --now gsusd-keeper
journalctl -u gsusd-keeper -f        # JSON events; keeper.heartbeat once per tick
```

Once step 3.6 is green and the keeper wallet holds its GSUSD float (section 1), set
`KEEPER_DRY_RUN=false` and restart. The float is minted from the operations Safe's seed vault
on launch day, after the handover (section 5 item 3). Keep the keeper wallet
funded with ETH (top it up whenever `keeper.signer-balance-low` appears) and with GSUSD.

**The GSUSD float.** The stability pool is empty at launch, so the direct path is the only
protocol-run liquidation path on day one, and it repays the vault's debt from the keeper
wallet. Hold at least the largest single vault debt you are prepared to see, plus 1%. Under
the open profile no debt ceiling bounds the total, so size the float from the largest vaults
on the dashboard and top it up as they grow. The size and the Safe that mints it are the
owner values of section 1.

- When the wallet holds less than a vault's debt plus 1% plus 1 wei, the keeper sends the
  largest partial the vault accepts and logs `vault.partial-direct-liquidation` at warn with
  `uncoveredDebt`. A partial needs the vault's gold still worth at least its debt, is at
  least the minimum debt (1,000 GSUSD at launch, read from the chain) and leaves at least
  the minimum debt behind.
- Nothing is sent, and `vault.liquidation-blocked` pages, for an underwater vault the wallet
  cannot cover whole (full liquidation only), a wallet holding less than the minimum debt,
  a vault smaller than twice the minimum debt that the wallet cannot cover whole, and a
  minimum debt the keeper has never read.
- **Refill after every direct liquidation.** Each one turns float into PAXG that stays in the
  keeper wallet; the keeper never sells it. The same day: (1) send GSUSD from the minting
  Safe to the keeper address until the wallet again covers the largest vault debt plus 1%;
  (2) stop the keeper (`sudo systemctl stop gsusd-keeper`), send the seized PAXG from the
  keeper address to that Safe with one transfer signed by the keeper key on the keeper host,
  and start the keeper again, so the transfer does not contend with the keeper for a nonce;
  (3) the Safe deposits that PAXG into its vault, which backs the next mint. No script does
  these steps.

**The second keeper**, at a third provider, has its own fresh key, its own 1 ETH and its own
GSUSD float; it never shares the first keeper's key. Start it half an interval after the
first. The same env block serves it with its own `KEEPER_PRIVATE_KEY` and its own
`KEEPER_HEARTBEAT_URL`.

### 4.8 The watcher

A small service that reads the chain and writes to one Telegram chat. It reports the events
and the thresholds that `LAUNCH.md` asks to be monitored, so it stands in for the
hosted alert rules where those are not available. It holds no key and sends no
transaction. Run it on the API server, never on the keeper host: the keeper host carries a
key and nothing else.

Every message starts with its severity. A `PAGE` rings the phone: a pause, a frozen token,
bad debt, every scheduled proposal, every role grant, and a watched vault below its ratio
floor. A `NOTE` arrives silently: mints, liquidations, reserve swaps, executed proposals,
routing fallbacks, oracle configuration changes and the reserve coverage. A proposal whose
call is `grantRole` carries an `ALARM` line (section 5, item 7).

**The Telegram bot.** From the project's Telegram account, open a chat with `@BotFather`,
send `/newbot` and keep the token it returns. Send the new bot any message, then open
`https://api.telegram.org/bot<token>/getUpdates` once in a private window and read
`chat.id` from the answer. The token is a secret: it goes in the env file and nowhere else.

```bash
sudo install -m 600 -o root -g root /dev/null /etc/gsusd/watcher.env
sudoedit /etc/gsusd/watcher.env
cd /srv/gsusd/src && npx nx build watcher
```

| Variable | Value |
| --- | --- |
| `WATCHER_RPC_URL` | One or more https endpoints, comma separated, the preferred first. It asks for logs over at most 2,000 blocks at a time, which the keyless gateway of section 1 served on launch day |
| `WATCHER_DEPLOYMENT_FILE` | `/srv/gsusd/src/contracts/deployments/mainnet.json`. The addresses come from the snapshot; the watcher refuses to start when one is missing or the endpoint is on another chain |
| `WATCHER_STATE_FILE` | `/var/lib/gsusd-watcher/state.json`. Where it remembers the last block it reported, so a restart neither repeats nor skips an event |
| `TELEGRAM_BOT_TOKEN` | The token from `@BotFather` |
| `TELEGRAM_CHAT_ID` | The chat id read above |
| `WATCHER_VAULT_OWNERS` | Vault owners whose collateral ratio is watched, comma separated: the operations Safe |
| `WATCHER_VAULT_RATIO_FLOOR` | Optional, default `1250000` (125%). A page below it |
| `WATCHER_RESERVE_COVERAGE_FLOOR` | Optional, default `50000` (5% of circulating GSUSD). A note below it |
| `WATCHER_REPEAT_SECONDS` | Optional, default `21600`. How often a threshold that stays crossed is repeated |
| `WATCHER_POLL_SECONDS` | Optional, default `60` |
| `WATCHER_HEARTBEAT_URL` | Optional. The https ping URL of a second hosted dead-man check, period 1 minute, grace 10 minutes. Pinged after every pass that read the chain and delivered everything it had to. Treat it as a secret |
| `WATCHER_DRY_RUN` | Optional. `true` prints the messages to the journal and sends nothing; the two Telegram values may then be absent |

```ini
# /etc/systemd/system/gsusd-watcher.service
[Unit]
Description=gsUSD watcher
Wants=network-online.target
After=network-online.target
StartLimitIntervalSec=0

[Service]
EnvironmentFile=/etc/gsusd/watcher.env
WorkingDirectory=/srv/gsusd/src
ExecStart=/usr/bin/node dist/apps/watcher/main.js
StateDirectory=gsusd-watcher
Restart=always
RestartSec=30
User=gsusd
NoNewPrivileges=yes

[Install]
WantedBy=multi-user.target
```

On start it sends `NOTE: watcher started` with the head block and the number of rules. That
message is the check that the token and the chat are right: a start that cannot deliver it
exits, and systemd tries again every 30 seconds. A first start reports from the current
block onward and replays nothing older.

A message that cannot be delivered is not lost. The watcher stays at that block, logs
`watcher.delivery-failed` and tries again on the next pass. A threshold that cannot be read
is never taken for a low reading: after five failed reads in a row it is reported as
unreadable. What the watcher cannot report is its own silence, which is what
`WATCHER_HEARTBEAT_URL` is for.

The ratio check covers the vaults named in `WATCHER_VAULT_OWNERS`. Every other vault is the
keeper's work: it liquidates below 110% and its own dead-man check pages when it stops.

A third check pages when the stability pool holds less of a gold token than it has
recorded (`balanceOf` of the pool against `collateralAccounted`), which is what an issuer
wiping the pool's balance looks like. The pool rewrites that record at its next absorption
or claim, so the page is the moment to act: read `THREAT_MODEL.md` on issuer intervention
before any liquidation goes through the pool.

### 4.9 Checks before you announce

- The footer on `https://goldstandardfinance.eth.limo` and on `goldstandard.finance` shows the same commit,
  and that commit is the head of the public repository.
- The two origins serve byte-identical pages: `curl -s <url>/index.html | sha256sum` on each.
- The header says mainnet, the vault page reads "No active vault", the token picker lists
  PAXG and the liquidations page is empty. The browser console shows no CORS errors on
  either origin, `https://goldstandardfinance.eth.limo` and `https://goldstandard.finance`: the API allows
  exact matches only.
- `/vault` and `/docs/faq` open directly and survive a refresh on both origins (section 4.4).
- The swap page shows the reserve alone, with no market tab (section 4.1).
- `/ledger` opens, shows the sentence "No token exists, no token is promised, the ledger
  confers no rights and may never confer any." in plain text, and its last card says
  how many addresses the ledger holds and to which block, with the link "Download the
  whole record (CSV)" and the SHA-256 of the file. `curl -s https://<api host>/usage-ledger.json`
  names the same block and hash, and
  `curl -s --compressed https://<api host>/usage-ledger.csv | sha256sum` prints that hash.
  `/terms` opens and carries the same sentence. An API log line beginning
  `Usage ledger dormant:` or a page that says the ledger is not running means the two
  variables of section 4.6 are missing or wrong.
- `curl -I https://goldstandard.finance` returns the content security policy, and
  `https://goldstandard.finance/.well-known/security.txt` names the security mailbox you set up
  (edit `apps/dapp/public/.well-known/security.txt` first if the address differs).
- The keeper log shows `keeper.heartbeat` with `ok` true every tick in dry run, and stopping
  the keeper for eleven minutes pages you (the dead-man grace of section 4.7 is 10 minutes).
- Certificate transparency and DNS change alerts are set up for the domain, because a DNS
  hijack is the most common way a DeFi frontend is compromised.

## 5. The first week: open the system

Every change now goes through the proposer Safe and the 48 hour timelock. The commands
below read the chain: export `RPC_URL` in the shell, never the retired deployer key. The
printers need nothing else. `scripts/withdraw-surplus.ts` and `scripts/verify-deployment.ts`
also take a signer from `PRIVATE_KEY`; give them a fresh key that holds no role and no
funds, which is enough to read and to print the Safe transactions.

Minting is open from the deploy, so do not announce until items 2 to 5 are done. None of them
waits on the timelock: the launch mint of item 3 pays the origination fee like any
borrower's (project decision, 2026-11-26), so the keeper's float, the GSUSD/USDC position
and the reserve seed can all be in place on launch day.

The same day, prove that each Safe works: the proposer Safe schedules the fee exemption of
item 3 (the executor Safe executes it 48 hours later), two guardian signers simulate the pause batch of section 6
without sending it, and the operations Safe is named as `WITHDRAW_TO` in a dry run of
`scripts/withdraw-surplus.ts` (no `CONFIRM=YES`, with the role-free key above; expect it to
report no headroom while the buffer is empty).

Under `LAUNCH_CAPS=open`, the mainnet launch, skip item 1: PAXG has no debt ceiling and no
per-block mint cap, and XAUT stays dormant until [XAUT activation](LAUNCH.md#xaut-activation).
`LAUNCH_CAPS=backstop` is refused on mainnet. Do items 2 to 5 before announcing, and make item
6 a weekly review of the float and the floor rather than a ceiling raise.

1. **Nothing to do on mainnet: there is no ceiling.** The open profile deploys PAXG with no
   debt ceiling, so no ceiling proposal belongs to the launch. On a guarded testnet the first
   raise is printed the same way as every other proposal here:
   ```bash
   cd contracts
   CEILING_GSUSD=250000 npx hardhat run scripts/print-ceiling-proposal.ts --network sepolia
   ```
   The proposer Safe submits the first transaction (`to`, `value 0`, `data`) through the Safe
   Transaction Builder: `proposeDebtCeilingUpdate`, which schedules
   `GoldVault.setDebtCeiling` and changes nothing else. Forty-eight hours later, and within
   the 7 days after that before the operation expires, the executor submits the second. After
   any governed change, on any network:
   ```bash
   npx hardhat run scripts/refresh-deployment-snapshot.ts --network <net>
   EXPECT_GOVERNANCE_TRANSFERRED=1 npx hardhat run scripts/verify-deployment.ts --network <net>
   ```
2. **Before announcing**, the keeper must be live (`KEEPER_DRY_RUN=false`) and able
   to liquidate: funded with GSUSD to the largest single vault's debt plus 1%, or the
   stability pool seeded above it.
   The keeper logs `keeper.no-liquidation-path` every tick while it cannot cover even a
   minimum-debt vault, `vault.partial-direct-liquidation` when its float covers only part of
   a vault, and `vault.liquidation-blocked` for each liquidatable vault it cannot take at
   all (section 4.7, "The GSUSD float"). The first clears once the wallet holds `minDebt` plus 1% headroom, about
   1,010 GSUSD at the 1,000 GSUSD launch minimum (101 on Sepolia), so check the wallet and the
   pool against the largest vault yourself; the absence of that event does not prove it.
3. **Seed a GSUSD market from a protocol vault, before public borrowing.** Every
   borrower owes more GSUSD than they received: the 5 bps origination fee is kept from the
   mint and the stability fee accrues from the first second, so nobody can repay a vault in
   full until GSUSD can be bought somewhere (`SPECIFICATION.md` section 8, "A borrower holding only what they minted cannot close in full"). The operations Safe therefore opens a vault,
   mints GSUSD and seeds the GSUSD/USDC position `LIQUIDITY.md` section 2 sizes.

   **The launch allocation** (project decision, 2026-11-26). The operations Safe holds
   0.70 PAXG. It keeps 0.05 for the reserve seed of item 5, deposits 0.65 and mints
   1,551 GSUSD on launch day, as soon as the handover is verified: 1,100 for the keeper's
   float (section 1) and 450 for the position, paired with 450 USDC. The mint pays the
   5 bps origination fee, 0.7755 GSUSD, which goes to the surplus buffer; the one GSUSD
   above the two uses covers it. Waiting 48 hours for a fee exemption would save that fee
   and leave the system without a keeper float and a market for two days. At $3,571 an ounce the seed vault opens near 150%, under the 250% that
   `LIQUIDITY.md` section 2 asks for, and it is liquidated like any other vault if gold
   falls about 27%: watch it, and add gold before the position is deepened. A position of
   450 a side is thin: a borrower closing a 1,000 GSUSD vault may need more GSUSD than it
   holds. Scenario 19 of section 2 rehearses these figures and fails when the day's price
   opens the seed vault under 140%.

   **The fee exemption, for later mints.** A mint that deepens the position later can be
   free of the origination fee. The exemption,
   `GoldVault.setOriginationFeeExempt(<operations Safe>, true)`, is a governed call and
   works only after the handover; scheduling it on launch day also proves the proposer
   Safe, and executing it 48 hours later proves the executor Safe. Print both Safe transactions:
   ```bash
   cd contracts
   EXEMPT_ACCOUNT=<operations Safe> npx hardhat run scripts/print-fee-exemption-proposal.ts --network mainnet
   ```
   It prints the operation id, checked against the timelock's own `hashOperation`, and which
   Safe holds each role. Both transactions go to the timelock address, not to the
   GoldGovernance wrapper, which has no helper for this call. The proposer Safe (2-of-3)
   submits transaction 1, `schedule`, through the Safe Transaction Builder. Forty-eight
   hours after it is mined, and within the 7 days after that, the executor Safe (2-of-3)
   submits transaction 2, `execute`. Run the command again after transaction 1 confirms for
   the exact earliest time; it also reports scheduled, ready, executed or expired. If the 7
   days pass, the timelock refuses the execute and still holds the operation id, so it
   cannot be scheduled again until it is cancelled. A rerun on an expired operation says so
   and prints three transactions in order: the proposer Safe's `cancel`, then a fresh
   `schedule` to send once the cancel has confirmed, then the `execute` for 48 hours after
   that. `EXEMPT=false`
   removes an exemption and `EXEMPT_MEMO=<label>` changes the salt.
   Confirm `GoldVault.originationFeeExempt(<operations Safe>)` reads true before a later
   mint that is meant to be free of the fee; the stability fee still applies to this vault
   like any other.

   **As soon as that pool exists, add it to the Usage Ledger.** The ledger's third
   dimension, GSUSD liquidity, is recorded from one configured pool. In
   `/etc/gsusd/api.env`, uncomment the two liquidity lines the printer wrote, set
   `LEDGER_LIQUIDITY_POOL_ADDRESS` to the GSUSD/USDC pool the seeding created and leave
   `LEDGER_LIQUIDITY_POSITION_MANAGER` at the printed value, the Uniswap v3
   NonfungiblePositionManager of Ethereum mainnet,
   `0xC36442b4a4522E871399CD717aBDD847Ab11FE88` (Uniswap's published v3 deployments; its
   `factory()` answers the v3 factory `0x1F98431c8aD98523631AE4a59f267346ea31F984`). Then
   restart the API. The ledger recomputes from the deploy block, which takes an RPC
   endpoint with historical state, and then records liquidity from the pool's first
   position on, so nothing is lost by the hours between the pool's creation and this step.
   The page shows the third dimension by itself. The API refuses a pool that is not a
   GSUSD pool of that position manager's factory, with a line beginning
   `Usage ledger liquidity pool refused:` (`docs/USAGE_LEDGER.md` section 2).
4. **Open the first vault yourself.** About $2,000 of PAXG: the 1,000 GSUSD minimum debt
   needs at least $1,300 of it at the 130% minimum ratio, and the rest is margin. Mint now;
   repay and withdraw once GSUSD can be bought from the item 3 position, because the mint
   delivers 5 bps less than the debt and a partial repayment may not leave less than
   1,000 GSUSD. If anything is wrong, your money tells you first.
5. **Seed the reserve, then swap once.** The reserve ships empty, and until it holds gold
   every swap reverts `Reserve insufficient`: there is no floor below the peg. The seed is
   **0.05 PAXG** (project decision, 2026-11-26; it replaces the 0.25 PAXG of 2026-11-15), so
   `SEED_AMOUNT=0.05`. The reserve pays out at most a fifth of its gold a day, so this seed
   converts about 0.01 PAXG of GSUSD a day: it makes the conversion real, and anything larger
   goes through the GSUSD/USDC position until the reserve is deepened. Print the two Safe transactions:
   ```bash
   cd contracts
   SEED_AMOUNT=0.05 SEED_FROM=<operations Safe> npx hardhat run scripts/print-reserve-seed.ts --network mainnet
   ```
   The operations Safe, which holds the PAXG, submits both through the Safe Transaction
   Builder, in this order: `PAXG.approve(reserve, amount)` to the token, then
   `GoldStabilityReserve.seedCollateral(PAXG, amount)` to the reserve. `seedCollateral` has
   no role check, so no governance Safe signs and no 48 hour wait applies. `SEED_FROM` makes
   the script check that Safe's balance and allowance; `SEED_TOKEN=paxg|xaut|<address>`
   (default `paxg`) is refused unless the reserve supports the token.
   **Never send PAXG to the reserve with a plain transfer. It is not counted as reserve, no
   swap can draw on it, governance cannot withdraw it, and it cannot be recovered.**
   After the seed, one `swapGsusdForGold` proves the spread lands in the buffer.
6. **Weekly check.** Go through every condition in `LAUNCH.md` step 5 each Monday; there is
   no ceiling to raise. The buffer's floor needs no step: the buffer starts at zero, fills
   from fees alone, and governance can withdraw only what it holds above 2% of supply. Take cost recovery from the buffer above that floor
   (`scripts/withdraw-surplus.ts`, which reports the headroom); it schedules on the first
   run and executes on the next. Expect the headroom to read 0 for about the first year: the
   stability fee reaches the buffer only when a borrower repays, and the floor rises with
   every mint. In the 11 November rehearsal (scenario 16) the buffer held 527 GSUSD against
   a 20,800 GSUSD floor, and it took two years of accrual and a 698,500 GSUSD repayment to
   open 20,538.07 GSUSD. Until then operating costs are paid from outside the protocol. `WITHDRAW_TO` is the operations Safe: the script refuses
   the deployer and the proposer, executor and guardian Safes recorded in the snapshot, with
   or without `WITHDRAW_TO_EOA=YES`. Review the keeper's float against the largest vault in
   the same sitting, and that vault's size against the single-transaction bound: an
   underwater vault of about 100,000 oz (roughly 1,000 silos) could not be liquidated in one
   transaction (`THREAT_MODEL.md` L8).
7. **Weekly, the timelock queue.** List the pending operations (every `CallScheduled` with no
   `CallExecuted` or `Cancelled`) and have the proposer Safe `cancel` each one that is
   superseded, reverted, expired or lifts a pause that has already lapsed (`LAUNCH.md`, the
   timelock queue). Do it after every incident as well. Treat one kind of entry as an alarm,
   not a review item: a `CallScheduled` whose call is `grantRole` and whose target is the
   stability pool, the stability module, the surplus buffer or the stability reserve. Their
   `VAULT_ROLE` has no lock: a holder on the pool can take depositors' GSUSD through
   `absorbLiquidationPrefunded`, and a holder on the module can record debt on any vault
   (`THREAT_MODEL.md` G12 and G14), so an unexpected grant must be cancelled by the proposer
   Safe inside the 48 hours. A proposer or executor Safe is replaced on the timelock and on
   the wrapper in one proposal (`LAUNCH.md`, Governance signer key compromised). The Tenderly rule of section 1 is what makes that a page.

## 6. If something is wrong

Two of the three guardian signers pause first, questions later. The guardian is a 2-of-3
Safe and the pause role is granted to the Safe alone, so one signer cannot pause. The four
calls go in one Safe batch, sent by the guardian Safe straight to the contracts (the
GoldGovernance wrapper has no pause function):

| # | To (from `deployments/mainnet.json`) | Function | Data |
| --- | --- | --- | --- |
| 1 | `addresses.vault` | `emergencyPause()` | `0x51858e27` |
| 2 | `addresses.oracle` | `emergencyPause()` | `0x51858e27` |
| 3 | `addresses.stabilityPool` | `emergencyPause()` | `0x51858e27` |
| 4 | `addresses.reserve` | `pauseAsset(address token)`, token PAXG | `0x3753b14a00000000000000000000000045804880de22913dafe09f4980848ece6ecbaf78` |

Value 0 on each. A Safe batch is all or nothing, and `emergencyPause()` reverts on a
contract that is already paused (the bad-debt breaker pauses the vault by itself), so
simulate before signing: if a call reverts, drop it from the batch, or replace it with
`extendPause()` on that contract to restart its 14 days, and sign the rest. `pauseAsset` may
be called again while the asset is paused. Prepare the batch once, the day of the handover: build the batch in the guardian
Safe's Transaction Builder with the four addresses, simulate it, and save the batch file
where every guardian signer can load it. In an incident a signer loads the file, creates the
batch and signs; the second signer signs and executes. The signers rehearse exactly this on
Sepolia before launch (section 1.1), and after the handover they confirm on mainnet that two
of them can assemble the signatures on a simulated batch, without sending it.

Repay stays open for borrowers. Then follow "What to do if something is wrong" in
[`LAUNCH.md`](LAUNCH.md). Every pause lapses after fourteen days on its own, the reserve's
asset pause included (call `pauseAsset` again to keep it; each call takes a new number), and a vault with no debt can
withdraw during any pause, so a lost key can delay the system but never lock it. A pause
does not open emergency liquidation for a token the guardian has frozen: lift the freeze
with `oracle.guardianUnfreezeToken(token, oracle.freezeEpoch(token))`, which works while
paused, or let it lapse.
