# Gold Standard Usage Ledger: operator sheet

The Usage Ledger is the record that `docs/TOKEN_POLICY.md` section 2 requires: a published,
on-chain-verifiable record of protocol usage per address over time. That section is the
authority for everything here. Where this sheet and the policy differ, the policy stands and
this sheet is wrong.

**No token exists, no token is promised, the ledger confers no rights and may never confer
any.** That sentence is permanent. It is shown, in plain text and at all times, on every
page that displays the ledger and on the dapp's Terms page at `/terms`. That page gathers
statements the project already publishes and adds the conditions on which the software is
offered (`docs/LAUNCH.md`, the legal item).

The ledger is published: the API serves the whole record as one file with a hash anyone can
recompute (section 7). It is complete by rule, in this exact sense: an address that has
opened a record keeps it for good, with everything recorded on it, and no record is ever
deleted (section 1.4). Two things can leave usage out, and neither removes anything. A first
pool deposit below 1 GSUSD and a liquidity position worth less than 1 dollar open no record
(sections 1.2 and 1.3). At the address cap or the position cap the ledger marks itself
incomplete, on the page, in the API and in the file, until the operator raises the cap; the
rebuild that follows gives every refused address its record with its full history.

The ledger is a record of the past and nothing else. It has no points, no weight that
favors one kind of usage or one period over another, no campaign, no ranking of addresses
and no figure that adds the dimensions together. Section 9 lists what must never
be added to it.

The ledger is off unless it is configured. A deployment that sets none of the variables in
section 2 has no ledger page, no ledger queue, no worker, no Redis connection and no RPC
call for it. The policy says the ledger runs from the first mainnet block, so on mainnet
switching it on is a launch step, not an option (`docs/MAINNET.md` section 4.6).

## 1. What is recorded

Three dimensions, each kept as its own figure:

| Dimension | What is held | Unit of the figure |
| --- | --- | --- |
| Vault debt | GSUSD a vault owes, as principal | GSUSD-days |
| Stability pool deposit | GSUSD an address keeps in the StabilityPool | GSUSD-days |
| Liquidity (once a pool is configured, section 1.3) | In-range liquidity in the official GSUSD pool on Uniswap v3, valued at the peg | dollar-days |

A figure is an amount held over time: every second adds the balance held during that
second. One GSUSD owed for one day is one GSUSD-day. One thousand GSUSD in the pool for half
a day is 500 GSUSD-days. Internally a figure is the balance in base units (18 decimals)
times seconds, so nothing is lost to rounding until a figure is shown.

Every second counts once and counts the same. No dimension is multiplied by a rate, and no
period counts for more than another. The three figures are different quantities in
different units. They are stored, served, exported and shown separately, and nothing in the
code adds them into one number for publication.

Recording starts at `LEDGER_START_TIMESTAMP`. Events before it are replayed so that the
balances are right at the start, and the time before it adds nothing. On mainnet the start
is set at or before the time of the deployment, so that the record covers the protocol from
its first block.

The API computes every figure from on-chain events. Redis holds the result as a cache with
a cursor. If the cache is lost, the next run recomputes the whole ledger from
`GOLD_VAULT_DEPLOY_BLOCK` and arrives at the same figures. Nothing in the ledger exists
only in Redis.

### 1.1 Vault debt

Debt is tracked from five vault events: `DebtMinted`, `DebtRepaid`, `Liquidated`,
`LiquidatedViaPool` and `BadDebt`. The events say when a vault's debt changed. The amount
comes from the vault itself: for every block that holds one of these events the index reads
`vaults(owner).debtAmount`, the principal, at that block and takes it as the tracked debt.

The event amounts are not used for this, because a repayment and a liquidation emit the
amount paid, which includes the accrued stability fee, while the contract retires less
principal than that. A vault with 1,000 GSUSD of principal and 50 of accrued fee that
repays 525 keeps 500 of principal; the index tracks 500.

Two consequences for the operator:

- A rebuild from the deploy block reads the vault at old blocks, so the RPC endpoint must
  keep historical state back to `GOLD_VAULT_DEPLOY_BLOCK` (an archive endpoint). Day to day
  the index reads recent blocks only. An endpoint that cannot answer makes the run stop at
  that window with an error line and try again a minute later; nothing is guessed.
- Every run also compares the tracked debt of up to 50 addresses that owe, in rotation,
  with the vault at the index block (section 5).

### 1.2 Stability pool deposits

The index mirrors the pool's own arithmetic (the product `P`, the scale and the epoch)
from `Deposited`, `Withdrawn`, `LiquidationAbsorbed` and `CollateralClaimed`. Every
division rounds down exactly as the contract does, so a depositor's recorded balance equals
`getEffectiveDeposit` at every event, including after an absorption, a scale change and an
epoch reset. The mirror is tested against vectors recorded from the contract
(`libs/trpc/src/lib/ledger/fixtures/generate-pool-vectors.cjs` regenerates them) and is
compared with the chain at the end of every run (section 5).

One rule can only leave usage out of the record, never add any: a first pool deposit below
1 GSUSD opens no record. Such a depositor is missing less than 1 GSUSD of balance. Once an
address has a record, the record counts whatever the address holds, down to the last wei.

### 1.3 Liquidity in the official pool

This dimension is recorded once both `LEDGER_LIQUIDITY_POOL_ADDRESS` and
`LEDGER_LIQUIDITY_POSITION_MANAGER` are set (section 2). It covers positions in one Uniswap
v3 pool, the official pool of GSUSD against a dollar token, held through the Uniswap v3
NonfungiblePositionManager. It needs no contract of the protocol and changes none. Until
the pool exists the two variables stay unset and the ledger records the other two
dimensions; `docs/MAINNET.md` section 5 lists setting them as a step to take as soon as the
official pool exists.

**What a position counts for: its value at the peg.** The index computes the two token
amounts the position would hold if the pool traded at exactly one GSUSD for one dollar of
the other token, and adds them as dollars. The arithmetic is Uniswap's own (the square root
price of each tick, in whole numbers), it takes the decimals of both tokens into account and
it rounds down as the pool does. A range that lies entirely on one side of parity holds one
token only at the peg, and counts as that amount. For a given liquidity and tick range the
value is a constant: it does not follow the live price, and it is what the position is worth
while GSUSD holds its peg, so a very wide range cannot make a position count for more than
the tokens it takes to fund it. `libs/trpc/src/lib/ledger/liquidityMath.ts` holds the
arithmetic and its spec checks it against known values of the pool.

**When a position is recorded: only while it is in range.** A position adds to the figure
while the pool's tick is at or above its lower tick and below its upper tick, exactly as the
pool decides which positions are active. The index follows the tick from the pool's
`Initialize` and `Swap` events. A position adds nothing while the price is outside its
range, however much it holds.

**Whose record it is.** The usage is recorded for the owner of the position NFT. A transfer
moves the position to the new owner's record from the block of the transfer; what was
recorded for the earlier owner stays there. A position owned by a contract is recorded for
that contract's address, as for any other owner; nothing looks through a contract to the
wallets behind it.

**Where the figures come from.** The position manager serves every Uniswap v3 pool on the
chain, so the index never asks it for a range of blocks. It asks three narrower questions:

- The pool itself is asked for its `Mint` and `Burn` events with the rest of each window.
  The position manager can change a position's liquidity only by calling the pool, so every
  increase, every decrease and every new position leaves one of these two events with the
  position manager as `owner`. This is the only trigger for looking at liquidity.
- For each such event the index reads the receipt of that one transaction and takes the
  token id from the position manager's `IncreaseLiquidity` or `DecreaseLiquidity` log that
  follows the pool's own log in it. A transaction that also touches a position of another
  pool cannot be mistaken for ours, and no event of another pool is asked for.
- A change of owner leaves no event on the pool, so the position manager is asked for its
  `Transfer` events with the token id topic set to the positions the index tracks, 500 ids
  to a filter. A position found in a window is asked for from the block after it was found.

The figures then come from the position manager itself: for every block in which a position
of the pool changed, the index reads `positions(tokenId)` and `ownerOf(tokenId)` at that
block and takes the liquidity, the range and the owner from the answer, as it takes the debt
principal from the vault (section 1.1). Liquidity added and removed inside one block is
therefore never seen and adds nothing.

Rules that can only leave usage out of the record, never add any:

- A position worth less than 1 dollar at the peg is not tracked, and a tracked position
  that falls below 1 dollar is dropped. It is picked up again the next time liquidity is
  added to it and it is then worth at least 1 dollar.
- The index tracks at most 20,000 positions. Past that a new position is refused and the
  ledger is marked incomplete (section 1.4). A slot cannot be held without at least 1 dollar
  in the position, and a position that is burned or emptied gives its slot back. A position
  is not a record: dropping one deletes nothing that was recorded for its owner.
- A pool that was initialized before `GOLD_VAULT_DEPLOY_BLOCK` cannot be followed, because
  its first tick lies outside the blocks the index reads. The check in section 5 reports
  it in a line that says so and names the two ways out: a pool created after the
  deployment, or both liquidity variables removed. The official pool is created after the
  deployment, so this does not arise in practice.

Consequences for the operator:

- The log volume is that of the pool alone: its swaps and its liquidity changes. Per window
  the dimension adds no `eth_getLogs` beyond the one the index already makes, plus one for
  every 500 tracked positions (none while no position is tracked) and one
  `eth_getTransactionReceipt` for every transaction that changed the pool's liquidity
  through the position manager. An endpoint that refuses any of these queries as too wide
  makes the index narrow the window by itself, and `INDEXER_MAX_BLOCK_RANGE` sets a smaller
  window from the start.
- A rebuild reads the position manager at old blocks, so it needs historical state, as the
  vault debt does (section 1.1).
- The dollar token is the operator's statement: the index takes the token paired with
  GSUSD to be worth one dollar. Name a pool against a dollar stablecoin only.
- Turning the dimension on recomputes the whole ledger, and liquidity is then recorded from
  `LEDGER_START_TIMESTAMP` on, including the time before the variables were set: the
  figures come from the chain, not from the day the API learned of the pool.

### 1.4 Completeness, and the address cap

**The ledger never deletes a record.** Once an address has a record it keeps it for good,
with everything recorded on it, whether or not it holds anything now. There is no eviction
and no expiry of a record, and the store has no operation that removes one.

Everything in the ledger can be recomputed from the chain, so the only bound on it is
memory. `LEDGER_MAX_ADDRESSES` is that bound: the most address records the ledger opens.
At the cap:

- no new record is opened;
- every existing record keeps counting exactly as before;
- the ledger is marked incomplete, and the status answer, the page, the download's
  companion JSON and its `X-Ledger-Complete` header all say so; an address with no record
  is then answered as unavailable instead of as zero;
- the API logs one line beginning `Usage ledger reached its cap of`, and one beginning
  `Usage ledger is incomplete:` on every run after it.

To make the ledger complete again, raise `LEDGER_MAX_ADDRESSES` and restart the API. The
cap is part of what the ledger is computed under, so the API recomputes the whole ledger
from the deploy block and every address that was refused gets its record, with its full
history from the chain. Nothing is lost by having been at the cap.

**The default is 125,000 addresses, chosen from measurement.** On a synthetic store of
125,000 busy records (every figure and balance set, as after a year of use):

| Where | Measured |
| --- | --- |
| Redis, the `:accounts` hash | 50 MB (about 400 bytes a record) |
| The indexer's own copy in the API process | about 56 MB (about 450 bytes a record) |
| Resident memory the API process gains from building the download, after several builds | about 186 MB |
| Tracked liquidity positions, at their cap of 20,000 | about 4 MB in Redis (213 bytes a position) |

That is about 290 MB for the ledger, on top of the API's own 130 MB, which fits a 2 GB host
with no swap with room to spare. The cost grows roughly in proportion: 250,000 addresses
measured 100 MB in Redis and about 300 MB of gained resident memory in the API process,
with the indexer's copy near 112 MB. `LEDGER_MAX_ADDRESSES` accepts 1,000 to 2,000,000; give
the host about 2.3 KB of memory per address before raising it.

**What it costs to reach the cap on purpose.** A record opens only through real usage, and
each way of opening one has a floor:

- vault debt: the protocol's minimum debt (1,000 GSUSD at the mainnet launch, never below
  100) and the collateral behind it, in four transactions;
- a stability pool deposit: at least 1 GSUSD, deposited by the address itself;
- liquidity: holding a position worth at least 1 dollar at the peg.

The capital can be passed from address to address, so what an attacker pays is gas. The
cheapest route is to hand one small position from one fresh address to the next: funding
the address and one NFT transfer, an estimated 85,000 gas for each record (an estimate from
typical mainnet figures, not a measurement). Filling the default cap that way takes about
10.6 billion gas: about 5 ETH at 0.5 gwei, 11 ETH at 1 gwei and 53 ETH at 5 gwei, and about
300 full blocks of the whole chain. What it buys is the incomplete mark until the operator
raises the cap, after which the ledger is complete again and holds every one of those
addresses. No record of anyone else is affected at any point.

## 2. Environment variables

API (`/etc/gsusd/api.env`).

| Variable | Meaning |
| --- | --- |
| `LEDGER_START_TIMESTAMP` | Unix seconds from which usage is recorded. Unset or blank: the ledger is off. Must be between 1600000000 and 4102444800. On mainnet set it at or before the time of the deployment. |
| `LEDGER_STABILITY_POOL_ADDRESS` | The StabilityPool of the deployment. Required once the start is set. |
| `LEDGER_CONFIRMATIONS` | Blocks behind the head the index stops at. Default 12, allowed 0 to 1000. |
| `LEDGER_MAX_ADDRESSES` | The most address records the ledger opens: a memory guard, since no record is ever deleted (section 1.4). Default 125,000, allowed 1,000 to 2,000,000. Changing it recomputes the whole ledger. |
| `LEDGER_LIQUIDITY_POOL_ADDRESS` | The Uniswap v3 pool whose positions are recorded (section 1.3): the official pool of GSUSD against a dollar token. Unset or blank, together with the next variable: the liquidity dimension is off. |
| `LEDGER_LIQUIDITY_POSITION_MANAGER` | The Uniswap v3 NonfungiblePositionManager of the chain, which holds the positions of that pool. Set both variables or neither. |

The ledger reuses `SEPOLIA_RPC_URL`, `GOLD_VAULT_ADDRESS`, `GOLD_VAULT_DEPLOY_BLOCK`,
`INDEXER_CHAIN_ID` and `INDEXER_MAX_BLOCK_RANGE` from the vault owner index.

If `LEDGER_START_TIMESTAMP` is set and anything else is missing or malformed, the API
still starts, the ledger stays dormant and one line beginning `Usage ledger dormant:` names
the reason.

The two liquidity variables go together. If exactly one of them is set, or either is not a
20 byte hex address, the ledger stays dormant with a line that names the variable: half a
configuration would otherwise run the ledger without the dimension the operator meant to
turn on. With both set, the index reads the pool from the chain when it first runs: its two
tokens, its fee, the decimals of both tokens, the GSUSD token of the deployment (the vault's
`stablecoin()`) and the pool that the position manager's factory holds for that pair and
fee. It refuses to index anything, with one line beginning `Usage ledger liquidity pool
refused:` every minute, when the configured address is not that factory's pool, when
neither token is the deployment's GSUSD or when a token has more than 18 decimals. The API
answers `unavailable` until the two variables are corrected or both are removed.

Setting the two variables, removing them or naming another pool or position manager
recomputes the whole ledger from `GOLD_VAULT_DEPLOY_BLOCK`. So does changing
`LEDGER_START_TIMESTAMP` or `LEDGER_MAX_ADDRESSES`.

There is no variable that ends the recording. The ledger records for as long as it is
configured. To stop it, turn it off (section 4) after archiving it (section 7.3).

Dapp build:

| Variable | Meaning |
| --- | --- |
| `VITE_LEDGER_ENABLED` | The exact value `true` adds the Usage Ledger page at `/ledger` and its navigation entry. `false` or unset leaves the page out: it is compiled out, and the build stops if any ledger code reaches the bundle. Any other value stops the build. |

## 3. Turning the ledger on

For a deployment, `contracts/scripts/print-service-env.ts` prints these variables with the
rest of the API and dapp blocks: the start from the timestamp of the deployment block, the
StabilityPool from the snapshot, the confirmation depth, `VITE_LEDGER_ENABLED=true`, and the
two liquidity variables as comments to uncomment once the pool exists. The steps below are
what those lines do, and how to do the same by hand on a deployment that was set up without
the printer.

1. Take the time of the deployment in unix seconds (the timestamp of
   `GOLD_VAULT_DEPLOY_BLOCK`, or any earlier time). A later start is possible on a testnet;
   on mainnet the policy asks for the first block.
2. Add `LEDGER_START_TIMESTAMP` and `LEDGER_STABILITY_POOL_ADDRESS` to the API environment
   and restart the API. The first run computes the whole ledger from the deploy block; the
   API answers `unavailable` until that run has finished and passed its check.
3. Build the dapp with `VITE_LEDGER_ENABLED=true` and publish it.
4. Once the official GSUSD pool exists, add the two liquidity variables and restart the
   API (section 1.3). The page then shows the third dimension by itself; it needs no
   rebuild.

Use an RPC endpoint that keeps historical state (section 1.1). Do the API first. A dapp
built with the flag against an API without the variables shows no figures and no errors
beyond a plain notice, because the API answers `disabled`.

## 4. Turning the ledger off

Remove `LEDGER_START_TIMESTAMP` from the API environment and restart: the API stops
indexing and answers `disabled`. Rebuild the dapp without `VITE_LEDGER_ENABLED` to remove
the page. The cached state expires from Redis after seven days.

Turning the ledger off loses nothing that cannot be recomputed: setting the same variables
again recomputes the same ledger from the chain, provided the RPC endpoint still serves the
history. Archive it first all the same (section 7.3), so that a published copy exists.

## 5. How the index keeps itself right, and how to force a rebuild

The index job runs every minute. It reads only blocks at least `LEDGER_CONFIRMATIONS`
behind the head, applies each window of events in one atomic Redis transaction, and at the
end of every run compares what it tracks with the chain at the same block:

- its mirror of the stability pool with the pool contract, and the pool the vault
  liquidates through with the configured one;
- the tracked debt of up to 50 addresses that owe, in rotation, with the vault. A tracked
  debt above the vault's figure fails the check: that is what a repayment or liquidation
  log the RPC provider failed to return looks like, and it would otherwise record debt that
  no longer exists. A tracked debt below the vault's figure is left alone, because it can
  only record too little and the address's next vault event corrects it;
- with the liquidity dimension on, the tick it tracks with the pool's own (`slot0`) and up
  to 20 tracked positions, in rotation, with the position manager. A tick that differs, a
  position tracked for another owner or one tracked with more liquidity than the position
  manager holds fails the check, for the same reason.

Only a run that passes writes a fresh time stamp. The API answers `unavailable` whenever
the stamp is older than five minutes, a rebuild is in progress or any stored value cannot
be read. It never shows partial numbers.

If the comparison fails, or a log cannot be decoded, the job logs one line beginning
`Usage ledger index integrity failure:` and rebuilds from the deploy block, at most once in
24 hours. If the failure is still there after that rebuild, the job leaves the state alone,
repeats the error line every minute and the API stays `unavailable` until someone acts.
A governance change of the vault's pool has this effect by design: the ledger then needs
the new `LEDGER_STABILITY_POOL_ADDRESS`.

Not detected automatically: a chain reorganization deeper than the confirmation depth that
left every balance as it was, and a missing vault log whose address is not yet due in the
rotation (50 addresses per minute: every borrower within about 17 hours at 50,000
borrowers, within minutes at a few hundred). A missing pool log is caught by the pool
comparison in the same run. If either is suspected, force a rebuild.

To force a rebuild, delete the meta key. The next run recomputes everything from the
deploy block.

```bash
# <namespace> is REDIS_NAMESPACE, or goldstandard when that is unset.
redis-cli -u "$REDIS_URL" DEL "<namespace>:ledger:v1:<chain id>:<vault address, lowercase>:meta"
```

Keys, all under `<namespace>:ledger:v1:<chain id>:<vault address, lowercase>`, all
recomputable from the chain, all with a seven day expiry that every run renews:

| Key | Content |
| --- | --- |
| `:meta` | Cursor, pool mirror, the liquidity pool's tick, time stamp |
| `:accounts` | One record per address: its balances and its three figures. Records are only ever added and updated |
| `:positions` | One record per tracked liquidity position (absent while that dimension is off) |

A lost Redis costs nothing but the time of a rebuild.

## 6. Limits

| Limit | Value | Constant (`libs/trpc/src/lib/ledger/limits.ts`) |
| --- | --- | --- |
| Index interval | 1 minute | `LEDGER_INDEX_EVERY_MS` |
| Stamp age before the API answers `unavailable` | 5 minutes | `LEDGER_STALE_AFTER_MS` |
| Expiry of the state | 7 days | `LEDGER_STATE_TTL_MS` |
| Address records | 125,000 unless `LEDGER_MAX_ADDRESSES` says otherwise | `DEFAULT_MAX_ADDRESSES` |
| Addresses whose debt is compared with the vault per run | 50 | `DEBT_AUDIT_ACCOUNTS_PER_RUN` |
| Smallest first pool deposit that is tracked | 1 GSUSD | `MIN_TRACKED_POOL_DEPOSIT` |
| Smallest liquidity position that is tracked | 1 dollar at the peg | `MIN_TRACKED_LIQUIDITY_VALUE` |
| Tracked liquidity positions | 20,000 | `MAX_TRACKED_LIQUIDITY_POSITIONS` |
| Liquidity positions compared with the position manager per run | 20 | `LIQUIDITY_AUDIT_POSITIONS_PER_RUN` |
| Token ids in one `Transfer` filter | 500 | `LIQUIDITY_IDS_PER_FILTER` |
| Log windows per run | 50 of at most 10,000 blocks | `MAX_WINDOWS_PER_RUN` |
| Time per run | 45 seconds | `MAX_RUN_MS` |
| Automatic rebuilds | 1 per 24 hours | `MAX_REBUILDS_PER_DAY` |
| tRPC request body | 1 KiB | `MAX_REQUEST_BODY_BYTES` in `libs/trpc/src/lib/trpc.ts` |

Changing `LEDGER_MAX_ADDRESSES`, `MIN_TRACKED_POOL_DEPOSIT`, `MIN_TRACKED_LIQUIDITY_VALUE`
or `MAX_TRACKED_LIQUIDITY_POSITIONS` recomputes the whole ledger.

Cost while idle, per minute: one `eth_blockNumber`, one `eth_getLogs`, one block read, five
`eth_call` for the pool comparison and up to 50 `eth_call` for the debt comparison. A
backlog costs one `eth_getLogs` per 10,000 blocks, one block read per block that holds an
event and one `eth_call` per vault owner per block that holds a vault event. The liquidity
dimension adds, per minute while idle, one `eth_getLogs` for every 500 tracked positions,
one `eth_call` for the pool's tick and up to 40 for the position comparison. In a backlog it
adds one receipt per transaction that changed the pool's liquidity, two `eth_call` per
position per block in which it changed, and one block read per block in which the tick
crosses the end of a tracked range. A swap that crosses no range end costs nothing beyond
its log. Section 1.4 gives the measured memory at the address cap.

## 7. Publishing the ledger, and checking it

### 7.1 The download

The API publishes the whole record itself, at two public, read only paths beside its tRPC
endpoint:

| Path | Content |
| --- | --- |
| `/usage-ledger.csv` | The whole record: one line per address, in address order |
| `/usage-ledger.json` | What describes that file: `chainId`, `vault`, `startTimestamp`, `liquidity`, `asOfBlock`, `asOfTimestamp`, `records`, `complete`, `sha256` (of the CSV body), `bytes` |

The CSV has the columns:

```
address,debtGsusdDays,poolGsusdDays,liquidityDollarDays,debtGsusd,poolGsusd,liquidityDollars,asOfBlock,asOfTimestamp
```

- `debtGsusdDays`, `poolGsusdDays`, `liquidityDollarDays`: the three figures, with six
  fraction digits, rounded down. `liquidityDollarDays` is zero for every address while the
  liquidity dimension is off.
- `debtGsusd`, `poolGsusd`, `liquidityDollars`: the balances the figures were growing by at
  that block, with six fraction digits.
- `asOfBlock`, `asOfTimestamp`: the same on every line, so a line taken alone still says
  what it describes.

Rows are in address order. The file has no rank, no column that adds the figures and no
ordering by size, and none may be added (section 9). The hash is not inside the file: it
covers exactly the bytes of the CSV, and travels in the JSON, in the `ETag` and
`X-Ledger-Sha256` headers of the download and in the `ledgerRouter.status` answer, which is
where the page takes it from.

How it is served:

- **Fresh by the block.** The index writes a new state once a minute. The file is rebuilt
  when someone asks for it after that, so at most once a minute however many ask, and not
  at all while nobody does. Concurrent requests share one build, and a request for a file
  that is current costs one Redis read. The download therefore always describes the same
  block as the index, which is what lets the export tool reproduce its bytes (section 7.2).
  A longer interval was considered and rejected: it would save at most one build a minute
  and would leave the published hash describing a block the store no longer holds.
- **Built in steps.** The addresses are sorted, then read 500 at a time, settled, written
  as lines, hashed and gzip compressed as they are written, yielding to other requests
  between steps. The file is kept compressed, in the pieces the compressor produced, and
  sent piece by piece; a client that does not accept gzip has it expanded as it is sent.
  No request holds the whole file.
- **Cacheable.** `Cache-Control: public, max-age=60`, an `ETag` that is the hash, and `304`
  for a client that already holds the file.
- **Guarded.** GET and HEAD only, behind the same rate limiter and with the same HSTS and
  CORS as the tRPC surface. `404` while the ledger is off, `503` with `Retry-After: 60`
  while it is being recomputed, never a partial file.

Measured at the default cap, on a synthetic store of 125,000 records: a build takes about
2.3 seconds, during which other requests were answered in under 10 milliseconds; the file
is 18.0 MB, 8.5 MB compressed (random test figures; real ones compress better); a download
of the current file is answered in under 10 milliseconds compressed and about 90 expanded.
Section 1.4 gives the memory.

Behind Caddy the two paths need no extra rule when Caddy proxies the whole API host. A
proxy that forwards `/trpc` alone must forward `/usage-ledger.csv` and `/usage-ledger.json`
too.

### 7.2 The export tool

The export script that ships with the API writes the same file from the same store, and
serves as the independent way to produce it. It reads the API environment, only reads
Redis, starts no server, queue or worker and makes no RPC call.

```bash
npx nx run api:build-ledger-export   # writes dist/apps/api-ledger-export/exportLedger.js
set -a; . /etc/gsusd/api.env; set +a
node dist/apps/api-ledger-export/exportLedger.js --csv > ledger.csv
node dist/apps/api-ledger-export/exportLedger.js > ledger.json   # the same rows as JSON
```

For the same index state the CSV is byte for byte the download: both are written by the
same two functions, and a spec holds them equal (`libs/trpc/src/lib/ledger/record.spec.ts`
and `http.spec.ts`). To compare by hand, take both inside one minute, before the index
writes its next state, and check that they name the same block:

```bash
curl -s https://<api host>/usage-ledger.json          # asOfBlock and sha256
curl -s --compressed https://<api host>/usage-ledger.csv | sha256sum
node dist/apps/api-ledger-export/exportLedger.js --csv | sha256sum
head -2 ledger.csv | tail -1 | cut -d, -f8            # the block a file is as of
```

Exit code 1 from the script means nothing was written: the ledger is not configured, the
index holds no finished state for this configuration, or the state moved during the read
(run it again). When the ledger is incomplete the script says so on standard error.

### 7.3 A monthly archive (recommended, not automated)

The download is live and always describes the latest block. For a fixed record, once a
month:

1. run the export tool and keep the CSV, named with its as-of block;
2. record the block and the SHA-256 of the file in the monthly public report, beside the
   disclaimer at the top of this sheet;
3. keep the file where the project keeps its other published records.

Every file contains the whole history up to its block, so a later file supersedes an
earlier one; the archive exists so that a hash published in one month can still be checked
against bytes in the next. Nothing in the software does this step or depends on it.

### 7.4 Recomputing the file from any RPC endpoint

Nobody has to trust the API for the file. Every figure in it can be recomputed from an
Ethereum archive node and the addresses in `agents.json`, and the result compared with the
published hash.

To reproduce a whole file: run the API (or only its indexer) against your own RPC endpoint
with the same `GOLD_VAULT_ADDRESS`, `GOLD_VAULT_DEPLOY_BLOCK`, `LEDGER_START_TIMESTAMP`,
`LEDGER_STABILITY_POOL_ADDRESS`, `LEDGER_MAX_ADDRESSES` and liquidity variables as the
published `usage-ledger.json` implies, let it index, and run the export tool. A file of
yours and a published file that name the same `asOfBlock` have the same SHA-256. The index
moves on every minute, so compare against a file of the block yours stopped at: the monthly
archive of section 7.3 exists for this, and `LEDGER_CONFIRMATIONS` with a paused endpoint
holds an index at a block.

To check one address by hand, up to a block `B` with timestamp `T`:

1. **Vault debt.** Collect the vault's `DebtMinted`, `DebtRepaid`, `Liquidated`,
   `LiquidatedViaPool` and `BadDebt` logs for the address from the deploy block to `B`. At
   each block that holds one, read `vaults(address).debtAmount` at that block: that is the
   debt held from that block's timestamp until the next such block. Sum debt times seconds
   over the periods, counting only time at or after `LEDGER_START_TIMESTAMP` and up to `T`,
   and divide by 86,400 for GSUSD-days.
2. **Stability pool deposit.** Between two pool events of the address the deposit changes
   only at a `LiquidationAbsorbed` event, which scales every deposit. Read
   `getEffectiveDeposit(address)` at the block of each of the address's own `Deposited`,
   `Withdrawn` and `CollateralClaimed` events and at the block of each
   `LiquidationAbsorbed`: that is the deposit held from that block until the next. Sum
   deposit times seconds as above.
3. **Liquidity.** For each position NFT of the configured pool, take its liquidity and tick
   range from `positions(tokenId)` and its owner from `ownerOf(tokenId)` at each block in
   which it changed (the pool's `Mint` and `Burn` logs for the position manager, and the
   NFT's `Transfer` logs). Compute its value at the peg with the formulas of section 1.3.
   Take the pool's tick from its `Initialize` and `Swap` logs. Sum value times the seconds
   during which the tick was inside the range and the address was the owner, and divide by
   86,400 for dollar-days.

The result agrees with the file's figure to within the rounding of its last digit, apart
from the tracking minimums of sections 1.2 and 1.3 and, on an incomplete ledger, the caps,
all of which can only make the file's figure smaller. `libs/trpc/src/lib/ledger/` is the
reference implementation: `replay.ts` and `liquidityReplay.ts` apply the events,
`account.ts` holds the one accrual function, and the specs beside them state the rules as
cases.

## 8. API surface

Two tRPC queries and no mutation. They are always present so that the dapp's types are
stable, and each answers `disabled` while the ledger is off.

| Procedure | Answers |
| --- | --- |
| `ledgerRouter.status` | `disabled`, `unavailable` (with what the ledger records) or `ok` with the start, whether liquidity is recorded, the block and time the ledger is as of, the number of addresses it holds, `incomplete` and `record`: what describes the download (its block, record count, `complete`, `sha256` and size), or `null` while the file is being prepared |
| `ledgerRouter.account` | `disabled`, `unavailable` or `ok` with one address's three figures (`usage.debt`, `usage.pool`, `usage.liquidity`, each with two fraction digits, rounded down) and its three balances |

Neither answer lists other addresses, orders an address among others or carries a sum of
the figures. `usage.liquidity` and `balances.liquidity` are zero while the liquidity
dimension is off, and the page shows that dimension only when the status says it is
recorded.

Beside the two queries the API serves the whole record at `/usage-ledger.csv` and
`/usage-ledger.json` (section 7.1).

The page at `/ledger` shows the connected wallet its own record, what the ledger records,
the link to download the whole record with its block and hash, and where this sheet is. It
shows the disclaimer in plain text at all times, with a link to the terms at `/terms`,
which carry the same sentence.

## 9. What must never be added

`docs/TOKEN_POLICY.md` section 2 rules out points marketing, multiplier campaigns and
implied conversion. For the code and the copy that means, permanently:

- no weight or rate on any dimension or period: every second of every dimension counts once;
- no figure that combines the dimensions, in storage, in the API, in the export or on a
  page;
- no ranking, no list of addresses ordered by size and no position of an address among
  others;
- no invitation scheme and no bonus of any kind;
- no period with a start and an end that is presented as a campaign;
- no wording that calls a figure points, a score, a reward or something earned, and no
  wording about what a figure may lead to;
- no page that shows the ledger without the disclaimer in plain text;
- no deletion, eviction or expiry of a record.

The specs enforce the part of this that code can check: the copy spec of the page
(`apps/dapp/src/app/content/ledger.spec.ts`), the reader and export specs in
`libs/trpc/src/lib/ledger/` and the end-to-end spec `apps/dapp-e2e/src/15-ledger.spec.ts`.
A change that needs one of those assertions weakened is a change of policy and goes to the
owner first.

One sentence elsewhere does connect the ledger to a possible future: section 4 of the policy
makes "retroactive allocation against the Usage Ledger" a constraint on a token design, if
the triggers of its section 3 are ever met. That sentence belongs to the policy alone. The
rule above stands for everything the ledger itself shows or serves: its page, its API
answers and its files say what was recorded and nothing about what a figure may lead to.
