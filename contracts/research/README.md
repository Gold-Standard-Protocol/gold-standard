# Research contracts

Nothing in this folder is deployed by the production scripts, and no contract under
`src/` imports anything from it.

| File | What it is |
| --- | --- |
| `oracle/PythMarketFeed.sol` | An adapter that presents a Pyth price in the Chainlink aggregator shape (with the `IPyth` interface and `PythStructs` it reads) |
| `oracle/UniswapV3TwapFeed.sol` | An adapter that presents a Uniswap v3 time-weighted pool price in the same shape |
| `oracle/TickPower.sol` | The tick-to-price library the pool adapter uses |
| `mocks/MockPyth.sol`, `mocks/MockPythRelayer.sol`, `mocks/TickPowerHarness.sol` | The test doubles that import the files above: a Pyth contract, a relayer that calls the adapter, and a wrapper that exposes the library |

The oracle the protocol launches with prices each gold token from two Chainlink feeds
and nothing else (`docs/ORACLES.md`). These adapters were built to study other price
sources and are kept, compiled and tested so that study stays reproducible:

- Hardhat builds this folder alongside `src/` (see the source-path hook at the top of
  `hardhat.config.ts`); Foundry builds it through the tests that import it.
- Tests: `test/PythMarketFeed.test.ts`, `test/UniswapV3TwapFeed.test.ts`,
  `test-foundry/PythMarketFeed.t.sol`, `test-foundry/UniswapV3TwapFeed.t.sol`. The
  mocks that import this folder live in `mocks/` here, so nothing under `src/`, test
  mocks included, reaches into it; the Uniswap pool mock imports nothing from here and
  stays with the other mocks in `src/test/mocks/`.
- `scripts/deploy-market-feeds.ts` can deploy them to a test network or a fork, and
  refuses a Pyth block on mainnet.

The production path refuses them. The launch preflight (`pyth:excluded`,
`twap:excluded`), `deploy.ts` and `verify-deployment.ts` each read every configured
feed address and fail if one answers as either adapter, and
`test/Preflight.test.ts` builds both from this folder to prove it.

A contract moves from here into `src/` only by a deliberate change that also brings it
under the same review, static analysis and deployment checks as the rest of `src/`.
