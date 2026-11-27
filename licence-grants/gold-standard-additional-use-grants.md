# Gold Standard Protocol Additional Use Grants

These grants form part of the Business Source License 1.1 in [`LICENSE`](../LICENSE)
and are referenced from its `Additional Use Grant` parameter.

## What is restricted, and what is not

The Licensed Work is Gold Standard Protocol and GSUSD: the Solidity contracts under
`contracts/src/core` and `contracts/src/governance`, and the application code under
`apps/` and `libs/`.

Be clear about what a licence achieves here. Deployed contract bytecode is public and
verified on a block explorer by design, and every deployment is readable, forkable and
redeployable by anyone with an RPC endpoint. **This licence does not and cannot prevent
that.** What it does is remove the legal right to run a competing production deployment
of this work, or a derivative of it, until the Change Date. It is a commercial
protection, not a technical one.

## Granted without further permission

1. **Non-production use of any kind**, without limitation, as already granted by the
   BUSL terms: reading, copying, modifying, creating derivative works, redistributing,
   local development, and running the software against a local chain.

2. **Test networks.** Deploying and operating the Licensed Work, modified or unmodified,
   on any public Ethereum test network (Sepolia, Holesky, or their successors), provided
   no real economic value is at stake and no fee is charged to any user.

3. **Security research, auditing and academic work.** Reviewing, testing, fuzzing,
   formally verifying, forking for analysis, and publishing findings, including
   deploying to a fork or a private network for that purpose. This grant is deliberate
   and unconditional: security review must never require the Licensor's permission, and
   nothing in this licence should discourage a researcher from reporting a defect.

4. **Integration.** Building applications, interfaces, indexers, keepers, wallets and
   analytics that read from or transact with a Gold Standard Protocol deployment operated by the
   Licensor. Interfaces under `contracts/src/interfaces` and the test mocks under
   `contracts/src/test` are licensed MIT precisely so this needs no grant at all.

## Requires a commercial licence until the Change Date

Operating a production deployment of the Licensed Work, or of a derivative of it, on a
public production network where users bear real economic exposure. That includes
rebranded or parameterised redeployments of the vault, oracle, stability module,
redemption module, stability pool, surplus buffer or silo system.

## After the Change Date

On **2030-08-28**, or four years after the first public distribution of a given version,
whichever is earlier, that version converts automatically and irrevocably to
**GNU General Public License v2.0 or later**, and every restriction above ends.

## Practical notes

- Each version carries its own Change Date. Publishing a later version does not extend
  the restriction on an earlier one.
- The MIT grant made in any previously published version is **irrevocable for that
  version**. Relicensing applies going forward only, which is why the header change had
  to land before any mainnet source verification published an MIT grant.
- The Solidity `SPDX-License-Identifier` in each file is the operative notice for that
  file, and it is embedded in the contract metadata hash. Changing it changes the
  deployed bytecode, so relicensing after a mainnet deployment is not possible without a
  redeploy.
