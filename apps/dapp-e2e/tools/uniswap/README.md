# Uniswap v3 artifacts for the local end-to-end chain

Compiled ABI and creation bytecode only, copied unchanged from the published npm packages so the
bootstrap can deploy a real Uniswap v3 (factory, position manager, SwapRouter02, QuoterV2) on the
throwaway chain without pulling those packages and their Hardhat toolchain into the workspace.
Used by contracts/scripts/deploy-e2e-dex.ts for tests only; nothing here ships.

| File | Package | Version | Licence |
| --- | --- | --- | --- |
| `UniswapV3Factory.json` | `@uniswap/v3-core` | 1.0.1 | GPL-2.0-or-later (BUSL-1.1 change date passed 2023-04-01) |
| `NonfungiblePositionManager.json` | `@uniswap/v3-periphery` | 1.4.4 | GPL-2.0-or-later |
| `SwapRouter02.json` | `@uniswap/swap-router-contracts` | 1.3.1 | GPL-2.0-or-later |
| `QuoterV2.json` | `@uniswap/swap-router-contracts` | 1.3.1 | GPL-2.0-or-later |
