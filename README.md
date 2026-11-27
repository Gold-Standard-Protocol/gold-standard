# Gold Standard: Gold-Backed Stablecoin

[![CI](https://img.shields.io/badge/ci-9%20workflows-green)](.github/workflows)
[![Solidity](https://img.shields.io/badge/solidity-0.8.38-blue)](contracts/hardhat.config.ts)
[![OpenZeppelin](https://img.shields.io/badge/openzeppelin-5.6.1-blue)](contracts/package.json)
[![Tests](https://img.shields.io/badge/tests-hardhat%20%2B%20foundry-green)](contracts)

[Gold Standard](https://goldstandard.finance) is a gold-backed stablecoin. Gold Standard Protocol runs the smart contracts. **GSUSD** ("Gold Standard Dollar") is an
ERC-20 stablecoin minted against over-collateralised deposits of tokenised gold. Mainnet launches with
PAXG; XAUT is registered in the oracle but stays inactive until a governance batch activates it
([`docs/XAUT_ACTIVATION.md`](docs/XAUT_ACTIVATION.md)). Three mechanisms hold the peg:

1. **Over-collateralisation and liquidation**: a vault mints only at 130% collateral to debt or more; below 110% anyone may liquidate it, at a 5% penalty.
2. **The stability swap**: any holder may swap GSUSD for protocol-owned gold in the Stability Reserve at the oracle price minus a spread of 0.5% to 5%, stepped by the reserve's coverage and bounded by daily caps. It holds only to the depth of the reserve, so it is a backstop, not a hard floor.
3. **The stability fee**: per-second interest on debt, 2% a year at launch, routes revenue to the SurplusBuffer, which absorbs bad debt by burning the GSUSD it holds. The buffer starts at zero and holds only what fees have paid in.

**Target chain**: Ethereum mainnet.
**Status**: live on Ethereum mainnet since 27 November 2026 (deployment block 26,505,970), with governance handed to the timelock and the Safes the same hour. GSUSD is [`0x24C3597eF975bdB565fd146f61438Ef14e15601D`](https://etherscan.io/address/0x24C3597eF975bdB565fd146f61438Ef14e15601D); every address is in [`contracts/deployments/mainnet.json`](contracts/deployments/mainnet.json) and in the agent manifest, and all fourteen contracts are verified on Etherscan.

---

## Architecture

| Contract | Responsibility |
|---|---|
| [`GoldStablecoin`](contracts/src/core/GoldStablecoin.sol) | ERC-20 GSUSD with permit + burn. Only the vault can mint. |
| [`GoldOracle`](contracts/src/core/GoldOracle.sol) | Two Chainlink sources per token: the market feed (PAXG/USD) and gold (XAU/USD). Borrowing prices at the lower of the two and only while they sit within the 2% gold band; liquidation prices at min(max(market, gold), gold × 1.02); reserve swaps at the higher of the two within the band. A stale or unhealthy feed refuses the price-dependent action until it recovers. The guardian can freeze a single token. |
| [`StabilityModule`](contracts/src/core/StabilityModule.sol) | Per-second stability-fee accrual via MakerDAO-style `_rpow`. Tracks normalised debt so fees accrue lazily. |
| [`GoldVault`](contracts/src/core/GoldVault.sol) | CDP core: collateral custody, debt issuance, liquidation (direct + pool), emergency liquidation during pause. |
| [`StabilityPool`](contracts/src/core/StabilityPool.sol) | Liquity-v1 liquidation buffer: product-sum accounting with epoch + scale-factor tracking (`P` never reaches 0) and decimal-normalised collateral gains. |
| [`SurplusBuffer`](contracts/src/core/SurplusBuffer.sol) | Protocol revenue reservoir, empty at deployment and built from fees. Absorbs bad debt by burning the GSUSD it holds, the whole balance if need be. Governance can withdraw only what it holds above an automatic floor of 2% of outstanding GSUSD; the floor limits withdrawals and is not a guaranteed balance. |
| [`GoldStabilityReserve`](contracts/src/core/GoldStabilityReserve.sol) | Protocol-owned gold that GSUSD converts into at the oracle price minus a coverage-stepped spread, up to daily caps. Never mints, never burns, never touches a vault. |
| [`SiloFactory` / `CollateralSilo`](contracts/src/core/CollateralSilo.sol) | EIP-1167 proxies distributing collateral across many addresses (raises censorship cost from one Paxos/Tether freeze to many). |
| [`VaultRegistry`](contracts/src/core/VaultRegistry.sol) | On-chain list of open vaults plus the views an agent needs (`isLiquidatable`, `liquidatableVaults`, `vaultSummary`, `collateralTypeOf`), so liquidation and monitoring need nothing but the verified contracts. Holds no funds; anyone can `sync` it from the vault. |
| [`GoldGovernance`](contracts/src/governance/Governance.sol) | `TimelockController` wrapper: every parameter change waits out the timelock delay (48h at launch; the delay itself is governable, `THREAT_MODEL.md` G10). The guardian Safe pauses the vault, the oracle and the stability pool instantly, can extend a pause in force, can pause a reserve asset, can freeze one token's oracle reads and lift that freeze, and can re-record the oracle's last-known price (a record for views that prices nothing); it cannot lift a pause and changes no parameter. Only governance unpauses early, and a vault, oracle or stability pool pause lapses after 14 days unless extended. |

Full formulas and invariants in [`docs/SPECIFICATION.md`](docs/SPECIFICATION.md).
Per-actor threat catalogue in [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md).
Ceremony procedure in [`docs/DEPLOYMENT_RUNBOOK.md`](docs/DEPLOYMENT_RUNBOOK.md).
Revenue model and treasury policy in [`docs/BUSINESS_MODEL.md`](docs/BUSINESS_MODEL.md).
Protocol token decision and TGE triggers in [`docs/TOKEN_POLICY.md`](docs/TOKEN_POLICY.md).
Usage Ledger, the per-address record of usage that the token policy requires, in [`docs/USAGE_LEDGER.md`](docs/USAGE_LEDGER.md): weighted by the second, complete by rule (a record, once opened, is never deleted) and published by the API as one file with a recomputable hash.
Oracle feed inventory and token onboarding runbook in [`docs/ORACLES.md`](docs/ORACLES.md).
Liquidity policy and peg operations in [`docs/LIQUIDITY.md`](docs/LIQUIDITY.md).

---

## For agents and automated users

Everything the dapp does can be done with contract calls alone, and the protocol is
documented for software that reads before it trusts. An agent needs three things:

- `https://goldstandardfinance.eth.limo/agents.json`: the machine-readable manifest (schema
  `goldstandard-agents/1`) with every address, token, ratio and convention of each deployment,
  generated from `contracts/deployments/<network>.json` by
  `contracts/scripts/print-agent-manifest.ts` and committed at `apps/dapp/public/agents.json`.
  `https://goldstandardfinance.eth.limo/llms.txt` points language models at it. The mirror,
  `https://goldstandard.finance`, serves the same files at the same paths.
- [docs/AGENTS.md](docs/AGENTS.md): the guide. How to verify an address set on chain, the
  conventions (ratios in parts per million, prices with 8 decimals, collateral in the
  token's own decimals), every read and action with its exact call, the refusal strings
  and the permissionless maintenance calls.
- `VaultRegistry`: the on-chain list of open vaults with `vaultSummary`, `isLiquidatable`
  and `liquidatableVaults`, maintained by the vault itself, so a liquidator or an analyst
  needs no indexer.

`node tools/agent-quickstart.mjs` is the smallest client. A manifest from anywhere but this
tree must name exactly the addresses in `contracts/deployments/<network>.json` and describe
the chain it is filed under. The tool then runs wiring checks it builds from those addresses
and replays the manifest's verification calls against the chain with no ABI, printing their
labels as the manifest's claims. Last, it lists every open vault. The
reference keeper in `apps/keeper` is the full worked example: it discovers vaults from the
registry, prices them from the oracle and liquidates through the pool or directly.

## Repository layout

This is an Nx monorepo.

```
contracts/         Solidity 0.8.38 (Hardhat + Foundry)
  src/core/        Production contracts
  src/governance/  GoldGovernance wrapper around TimelockController
  src/interfaces/  Interface shims
  src/test/mocks/  MockAggregatorV3, MockERC20, RpowHarness
  test/            Hardhat tests (Mocha + Chai + ethers v6)
  test-foundry/    Foundry fuzz + invariant suite
    invariant/       Stateful invariants + handlers
    fuzz/            Property-based fuzz tests
  scripts/         deploy.ts, verify-deployment.ts, transfer-governance.ts
  tools/           generate_rpow_vectors.py (mpmath reference)
apps/              dapp (Vite + Wagmi), api (tRPC + vault-owner indexer), keeper (liquidation
                   watch, oracle health watch and alerts), api-e2e (boots the built api)
libs/              Shared hooks, models, tRPC router, UI
docs/              SPECIFICATION, THREAT_MODEL, DEPLOYMENT_RUNBOOK, LAUNCH, MAINNET,
                   BUSINESS_MODEL, TOKEN_POLICY, USAGE_LEDGER
.github/workflows/ CI (9 workflows: contracts ci, lint, slither, coverage, foundry, app-ci,
                   dapp-e2e, key-isolation, npm-audit)
```

---

## Delivered so far

### Smart contracts
- The nine core contracts of the table above, the governance wrapper with the timelock it creates and the `InactiveFeed` behind XAUT's dormant oracle entry, together with the `CollateralSilo` implementation that `SiloFactory` creates for its silos and the `GoldStablecoinDeployer` that creates the token at an address fixed in advance: fourteen contracts, from eleven creation transactions, deployed and verified at launch. Solidity 0.8.38 with `via-IR`, OpenZeppelin 5.6.1.
- Guardian role: the guardian Safe's calls bypass the timelock (its powers and their limits are set out in the `GoldGovernance` row above).
- Collateral decimals are guarded against underflow, and the oracle enforces the decimals of every Chainlink feed it reads.
- Fee-on-transfer collateral cannot brick any of the three liquidation paths: distribution is sized to the amount actually received from the silo.
- A seizure during a pause uses the normal liquidation price or refuses ("No price"); `lastKnownPrice` never prices a seizure. The oracle has no deviation threshold or circuit breaker, and `resyncLastKnownPrice` only records what the pricing rules give.
- `StabilityPool` uses Liquity's product-sum accounting with epoch + scale-factor tracking, so `P` can never floor to zero, and collateral gains are carried at 18 decimals inside the pool's sums, so gains in 6-decimal XAUT do not vanish there.
- `SiloFactory.withdraw` routes around an issuer-frozen silo instead of bricking all exits/liquidations.
- The governance wrapper is handed to the timelock (no deployer backdoor after handover).
- **Liveness hardening (2026-09-26):** every pause lapses after 14 days (`ExpiringPausable`, permissionless `unpauseExpired`), a debt-free vault can withdraw during any pause so repay-then-withdraw is a guaranteed exit, and `GoldStablecoin.lockMinters()` removes the minter-grant power one way from every key including the timelock (`test/Liveness.test.ts`); since 2026-11-06 it is `lockMinters(vault)` and succeeds only while the vault is the sole minter.
- Rate-limit knobs: a per-block mint cap and per-collateral debt ceilings (both off under the open launch profile), reserve daily caps and a governance minimum on top of the SurplusBuffer's automatic floor.

### Tests
- **Hardhat suite** (`test/`): unit and integration tests for every contract, plus tests of the deploy, preflight, verification and ceremony scripts.
- **Foundry suite** (`test-foundry/`):
  - **Stateful invariants** across vault / pool / silo / fees / token isolation (debt accounting, debt ceiling, MIN_DEBT floor, supply↔debt identity, state + flow conservation of collateral & GSUSD, pool product-sum identity, `P > 0`, `P` monotonic, gains bounded, silo cap respect, CREATE2 determinism, factory-holds-nothing).
  - **Fuzz tests** on stability-fee monotonicity, liquidation rounding, the market feed adapters and boundary cases.
  - **`_rpow` differential test** against a Python `mpmath` reference (1 ppm tolerance).
- **The full Hardhat and Foundry suites are run before each release and must pass.** Counts are not quoted here because they change often: run `npm test` and `forge test` in `contracts/` for the current figures. The Foundry invariant suite runs; `P > 0` and the pool/silo/vault accounting invariants hold across 25,600 calls per invariant under the default profile (128 runs of depth 200) and 51,200 under the `ci` profile (256 runs of depth 200).
- **Dapp end-to-end suite** (`apps/dapp-e2e`, Playwright, `npx nx e2e dapp-e2e`, CI `dapp-e2e.yml`): one command brings up a local Hardhat node presenting Sepolia's chain id, deploys the protocol with the real deploy scripts, deploys a real Uniswap v3 from vendored artifacts and seeds a GSUSD/PAXG pool, seeds the reserve, a deployer vault and a liquidation victim, funds a test wallet, starts the API against that chain in its own Redis namespace, and drives the dapp's flows in the installed Chrome: the PAXG vault lifecycle through to closing the position, the same with 6-decimal XAUT, pool deposit and withdrawal, a reserve swap, a Uniswap market swap, a direct liquidation after walking the oracle price down, and a liquidation absorbed by the stability pool with the seized gold then claimed from it. The wallet is the node's own account #1 behind a purpose-built connector, so no private key exists in the dapp, the tests or CI; the node signs. Needs Redis for the API.
- **Regression suites** pin specific accounting, custody, pause and wiring behavior: `test/AccountingAndGovernanceRegressions.test.ts`, `test/CustodyAndPauseRegressions.test.ts`, `test/WiringAndPauseRegressions.test.ts`, `test/ReplacementTargetsAndDecimals.test.ts` and `LiquidationAndSupplyAccounting` (Hardhat and Foundry). One example: repayment is capped at the debt owed, Maker style, so a full repayment succeeds with a non-zero stability fee.

### CI / tooling
- **Nine GitHub Actions workflows**:
  - `contracts-ci`: compile + test + gas report artifact
  - `contracts-lint`: Solhint
  - `contracts-slither`: Slither static analysis with SARIF upload (fail on medium+)
  - `contracts-coverage`: solidity-coverage with threshold gate
  - `contracts-foundry`: forge test under `ci` profile (5000 fuzz / 256×200 invariant runs)
  - `app-ci`: unit tests for the dapp, API, keeper and shared libraries, and the production builds
  - `dapp-e2e`: the Playwright suite against a local chain
  - `key-isolation`: proves the public API bundle cannot read the keeper key and the keeper bundle stays free of the price worker
  - `npm-audit`: production dependency audit, weekly and on pull requests
- Config: Solhint, Slither, solidity-coverage, hardhat-gas-reporter, Foundry.

### Deployment
- **History: the first Sepolia handover (2026-09-30), on a deployment since replaced.** The current Sepolia deployment is the one of 26 November 2026 (`contracts/deployments/sepolia.json`, open profile, governance handed over); the figures in this paragraph, the 15,000 GSUSD floor included, belong to the earlier one. `transfer-governance.ts` moved every admin role from the deployer to the 48 hour `TimelockController`, verified 84/87 with `EXPECT_GOVERNANCE_TRANSFERRED=1` (the three misses are the permanent Sepolia residuals: the deployer is also the timelock's proposer, executor and canceller, per `.env.sepolia`). Every governed parameter on Sepolia now goes through the timelock, including the testnet toolkit's ceiling ramp and mint cap; `set-min-reserve.ts` and `withdraw-surplus.ts` take the schedule-then-execute path there. The treasury rehearsal then ran end to end through the timelock, each leg 48 hours after it was scheduled: the floor to 6 GSUSD (executed 2026-10-04), then a 0.5 GSUSD withdrawal to the deployer and the floor back to 15,000 (both executed 2026-10-06). Between the legs, twelve simulated attempts to execute early, bypass the timelock or regain the deployer's roles all reverted on chain. Buffer afterwards 6.79 GSUSD, lifetime withdrawn 1.0, floor 15,000, verification 84/87.
- `scripts/deploy.ts` writes a machine-readable `deployments/<network>.json` snapshot, wires the guardian role, disables nothing by default (all caps off, pool enabled).
- `scripts/verify-deployment.ts` re-reads the snapshot and asserts, on-chain: bytecode present, every role granted, every module pointer wired, oracle feeds + staleness, feed liveness, collateral types registered with expected params, stability fees initialised, and (with `EXPECT_GOVERNANCE_TRANSFERRED=1`) admin transfer complete on all nine governed contracts. Since 2026-11-06 it also takes a role census (`scripts/lib/roleCensus.ts`, which `transfer-governance.ts` runs before and after the handover too): every privileged role's whole holder set, read with `getRoleMember` where the contract is enumerable and rebuilt from the role logs everywhere, must be exactly the intended one, so a key planted before the handover fails the ceremony; and it asserts the timelock's 7 day grace period on matured operations (`timelock:grace-period-7d`).

### Documentation
- [`docs/SPECIFICATION.md`](docs/SPECIFICATION.md): formal spec: responsibilities, unit conventions, every formula, access control, global invariants, parameter defaults, rounding rules.
- [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md): per-actor catalogue (user / liquidator / governance / guardian / oracle / issuer / deployer / contract) with 40+ enumerated attacks + mitigations, residual risks, response plan.
- [`docs/DEPLOYMENT_RUNBOOK.md`](docs/DEPLOYMENT_RUNBOOK.md): Sepolia dry-run, mainnet ceremony, emergency procedures, ceremony record format.
- [`docs/AGENTS.md`](docs/AGENTS.md): the guide for software that uses the protocol without a browser.

---

## Open items

The operational runbook is [`docs/LAUNCH.md`](docs/LAUNCH.md) and the launch-day command sheet is
[`docs/MAINNET.md`](docs/MAINNET.md) (what to supply, the preflight, deploy, verify, Etherscan, handover,
services and the first week's steps, each one command). High-level gates:

### Code-level (can ship from this repo)
- [ ] **7-day timelock split**: oracle swap / collateral whitelisting / module rewiring should route through a longer delay than routine parameter updates. Needs a second `TimelockController` and `GoldGovernance` refactor.
- [x] **Mainnet fork rehearsal** against real PAXG, XAUT and the Chainlink PAXG/USD and XAU/USD feeds (`scripts/rehearse-mainnet-fork.ts`, first run 2026-09-24; the full launch sequence passed on 2026-11-08 and again on 2026-11-11; the contract source has changed since, so the run on the release commit is the operator task below). PAXG credits are measured, not assumed: PAXG has no transfer fee today (Paxos removed the mechanism in its June 2026 upgrade), and the token is an upgradeable proxy.
- [ ] Paxos freeze behaviour on a frozen silo exercised against the real token (covered today by unit and Foundry tests with a mock). PAXG's June 2026 upgrade replaced the earlier freeze interface, so read the current implementation before writing the test.
- [x] **StabilityPool epoch/scale tracking**: landed; `P` is kept in `[1e9, 1e18]` and a near-total drain triggers an epoch reset. (Full-pool-drain absorptions are still rejected by the strict inequality in the caller.)

### External (cannot ship from this repo)
- [x] **Legal sign-off**: the project confirmed on 2026-11-15 that it is done, with the record held offline, outside this repository.
- [x] **Terms page**: beside the statements the project already publishes, it states use at the user's own risk, no warranty, no promise of yield and a limitation of liability. By a project decision of 2026-11-26 it states nothing on governing law, an offering entity or eligibility ([`docs/LAUNCH.md`](docs/LAUNCH.md), pre-launch checklist).
- [ ] **Insurance**: Nexus Mutual / Sherlock cover.

### Operator tasks
- [x] Liquidation keeper service (`apps/keeper`: liquidation watch, oracle health watch and alerts, a heartbeat line per tick and an optional dead-man ping; it runs no fee job, because the stability fee accrues inside the contracts; dry run until `KEEPER_DRY_RUN=false`).
- [x] Watcher service (`apps/watcher`: reports pauses, freezes, bad debt, governance proposals, role grants, mints and liquidations, a watched vault's collateral ratio and the reserve coverage to a Telegram chat; it holds no key and sends no transaction).
- [ ] Redundant keeper instance on a second provider. MEV-protected mempool.
- [ ] Chainlink feed health monitor (deviation, staleness; the keeper's `oracle.feed-late` covers a late heartbeat) and issuer monitoring on the silos (`paused()` and the freeze events of PAXG's current implementation, which its June 2026 upgrade changed).
- [ ] Solvency dashboard (Dune / Tenderly) with real-time ratio, per-vault risk distribution and reserve coverage.
- [ ] Alerting: PagerDuty / OpsGenie on pause, oracle price refused, feed invalid or off the gold band, vault pre-liquidation, surplus buffer depletion, governance proposal events, large mint/redeem.
- [x] Sepolia dry-run: the full ceremony and every step-2.5 scenario rehearsed on 2026-09-22, and again on 2026-09-28 against the liveness-hardened deployment through the JSON-RPC relay (`scripts/rehearse-testnet-flow.ts`, 25 of 25 checks; four earlier live runs lost scenarios to public-gateway staleness, which the relay now pins away).
- [ ] Sepolia soak: at least 14 days with the keeper live (`KEEPER_DRY_RUN=false`, dedicated key) and its alerts explained.
- [ ] Mainnet-fork launch rehearsal on the release commit, with the open profile and the preflight against the real governance Safes. It passed on 2026-11-08 and on 2026-11-11; the contract source changed on 2026-11-18 and 2026-11-23, so a run on the final contract source is owed before the ceremony, together with the operations listed as not yet rehearsed in [`docs/MAINNET.md`](docs/MAINNET.md) section 2.
- [ ] Etherscan source verification on every contract (`scripts/verify-etherscan.ts` rebuilds every constructor from the snapshot).
- [ ] Branch protection + signed commits on `main`.

The day-by-day launch checklist is in [`docs/LAUNCH.md`](docs/LAUNCH.md).

---

## Quick start

### Prerequisites
- Node ≥ 20, npm ≥ 10
- [Foundry](https://getfoundry.sh/) (stable)
- Python 3 + `mpmath` (only if regenerating `_rpow` vectors)

### Contracts
```bash
cd contracts
npm ci
npm run compile
npm test                # Hardhat: unit + integration
npm run lint            # Solhint
npm run slither         # Static analysis (needs: pip install slither-analyzer)
npm run coverage        # solidity-coverage

# Foundry
forge install foundry-rs/forge-std@1eea5bae12ae557d589f9f0f0edae2faa47cb262 --no-commit   # v1.9.4, pinned as in CI
forge build --sizes
forge test -vvv         # Fuzz + invariant suite
```

### Deploy (Sepolia dry-run)
See `docs/DEPLOYMENT_RUNBOOK.md` §1 for the full ceremony. Condensed:

```bash
cd contracts
# Populate .env.sepolia with RPC, deployer key, tokens, feeds,
# proposer/executor/guardian Safes, risk parameters
npx hardhat run scripts/deploy.ts --network sepolia
npx hardhat run scripts/verify-deployment.ts --network sepolia
# After transferring governance:
EXPECT_GOVERNANCE_TRANSFERRED=1 npx hardhat run scripts/verify-deployment.ts --network sepolia
```

The testnet toolkit (mock tokens and feeds, market-price tracking, seeding, the automated
runbook drive, the adversarial soak and the attack drill) is listed in `docs/LAUNCH.md` step 2.

### Dev server (frontend)
```bash
npx nx serve dapp
npx nx build dapp
```

#### App environment variables

The dapp reads contract addresses from Vite env vars at build time. Unset values fall back to the zero address and the UI renders its honest pre-launch state:

| Variable | Purpose |
| --- | --- |
| `VITE_GOLD_VAULT_ADDRESS` | GoldVault (deposit, mint, repay, withdraw, liquidate) |
| `VITE_STABILITY_MODULE_ADDRESS` | StabilityModule (stability fees) |
| `VITE_GUSD_ADDRESS` | GSUSD token (approvals) |
| `VITE_STABILITY_POOL_ADDRESS` | StabilityPool (deposits and liquidation collateral gains) |
| `VITE_STABILITY_RESERVE_ADDRESS` | GoldStabilityReserve (reserve swap, spread and capacity reads) |
| `VITE_DEPLOY_BLOCK` | Block the vault was deployed in; the vault page activity feed reads events from here |
| `VITE_UNISWAP_QUOTER` / `VITE_UNISWAP_ROUTER` / `VITE_DEX_POOL_FEE` | Uniswap v3 quoter, SwapRouter02 and pool fee tier for the market swap. Both addresses being set turns the market tab on; the mainnet env block leaves them out until a GSUSD/PAXG pool is seeded (`docs/MAINNET.md` section 4.1) |
| `VITE_GOLD_ORACLE_ADDRESS` | GoldOracle (validated price reads) |
| `VITE_SURPLUS_BUFFER_ADDRESS` | SurplusBuffer (revenue and first-loss reserve panels) |
| `VITE_SILO_FACTORY_ADDRESS` | SiloFactory (custody distribution panel) |
| `VITE_VAULT_REGISTRY_ADDRESS` | VaultRegistry (the contracts page shows it; the liquidations page reads open vaults from it when the API owner index is unavailable; agents and keepers read it directly) |
| `VITE_PAXG_ADDRESS` / `VITE_XAUT_ADDRESS` | Collateral tokens; decimals are read from the token, never assumed |
| `VITE_TARGET_CHAIN_ID` | `11155111` (Sepolia build) or `1` (mainnet build); the chain is fixed at build time, and a build refuses any other value, an unset one included. The dev server falls back to Sepolia |
| `VITE_SEPOLIA_RPC_URL` / `VITE_MAINNET_RPC_URL` | Read RPC for the target chain: one https URL, or several separated by commas in order of preference, and the dapp fails over to the next. Every visitor can read the key, so use a rate-capped key made for the browser |
| `VITE_WALLETCONNECT_PROJECT_ID` | Public WalletConnect project ID for QR/mobile connections; configure the allowed dapp origin in the project dashboard. Browser extensions, Coinbase and Safe work without it. |

The keeper discovers vault owners from the VaultRegistry (`VAULT_REGISTRY_ADDRESS` in its env) and from the API's indexer set, unioned, so neither service can hide a vault from it. The API's vault-owner indexer (feeds the Liquidate page) reads `SEPOLIA_RPC_URL`, `GOLD_VAULT_ADDRESS`, `GOLD_VAULT_DEPLOY_BLOCK`, `INDEXER_CHAIN_ID` and `INDEXER_CONFIRMATIONS` from `apps/api/.env.local` (Nx loads it into the task environment); it stays dormant when they are unset. Its Redis keys are scoped by vault address, so a redeploy re-indexes from the new deploy block.

---

## Security

Reporting vulnerabilities: security@goldstandard.finance, as published in [`/.well-known/security.txt`](apps/dapp/public/.well-known/security.txt).

Current defensive posture:
- Static analysis (Slither, fail on medium+) and Solhint, run before each release
- Fuzz + invariant suite under the `ci` profile (5000 fuzz / 256×200 invariant runs), run before each release
- The GitHub Actions workflows define the same checks.
- Access control: deployer → 48h timelock; the guardian Safe bypasses it only to stop things (pause, extend a pause, pause a reserve asset, freeze a token), to lift a token freeze and to re-record the last-known price
- Rate-limit knobs available (debt ceilings and the per-block cap are off under the open launch profile; the risks this accepts are set out in [`docs/MAINNET.md`](docs/MAINNET.md))

---

## License

**Business Source License 1.1**: see [`LICENSE`](LICENSE) and the
[additional use grants](licence-grants/gold-standard-additional-use-grants.md).

Non-production use, testnet deployment, security research and integration are granted
freely. Running a competing **production** deployment of this work, or a derivative of
it, requires a commercial licence until the Change Date of **2030-08-28**, after which
each version converts automatically to **GPL-2.0-or-later**.

`contracts/src/interfaces` and `contracts/src/test` remain **MIT**, deliberately, so
integrators and auditors need no permission at all.

A licence cannot make deployed contracts uncopyable: verified bytecode is public and
anyone can fork and redeploy it. This is commercial protection, not technical.
