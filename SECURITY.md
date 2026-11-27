# Security policy

## Reporting a vulnerability

Report a suspected vulnerability privately to **security@goldstandard.finance**. The same
contact is published at
[`/.well-known/security.txt`](apps/dapp/public/.well-known/security.txt) on the dapp.

Do not open a public issue, a pull request or a discussion for a vulnerability, and do not
test against funds that are not your own.

A useful report says:

- which contract, service or page is affected, with the address or the commit;
- what an attacker can do and what it costs them;
- the steps or a proof of concept, on a fork or a local chain where one is possible;
- whether the issue is already known to anyone else.

## Scope

- The contracts under [`contracts/src`](contracts/src) as deployed at the addresses in the
  published manifest (`agents.json` on the dapp).
- The dapp, the API and the keeper in this repository.

Issues in third-party dependencies, in the collateral tokens or in the price feeds belong
with their maintainers; tell us as well if the protocol's use of them is what makes the
issue exploitable.

## What is already documented

The threat model and the accepted residual risks are in [`docs/`](docs): start with
[`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md). A report that restates a documented,
accepted risk is still welcome if it shows the risk is larger than the record says.
