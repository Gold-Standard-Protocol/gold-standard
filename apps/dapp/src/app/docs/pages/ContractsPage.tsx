import { Link } from 'react-router-dom';
import {
  CodeBracketSquareIcon,
  DocumentCheckIcon,
  LockClosedIcon,
  MagnifyingGlassCircleIcon,
} from '@heroicons/react/24/outline';
import { Callout, DocTable, FeatureGrid, Lead, Prose, Steps } from '../components/DocComponents';
import { zeroAddress, type Address } from 'viem';
import {
  GOLD_ORACLE_ADDRESSES,
  GOLD_VAULT_ADDRESSES,
  GUSD_ADDRESSES,
  SILO_FACTORY_ADDRESSES,
  VAULT_REGISTRY_ADDRESSES,
  STABILITY_MODULE_ADDRESSES,
  STABILITY_POOL_ADDRESSES,
  STABILITY_RESERVE_ADDRESSES,
  SURPLUS_BUFFER_ADDRESSES,
  TARGET_CHAIN_ID,
  explorerAddressUrl,
} from '@goldstandard/constants';
import { shortAddress } from '../../lib/format';
import { IS_MAINNET_BUILD, NETWORK_NAME } from '../../lib/network';

/** Address cell: an Etherscan link for the build's target chain, or an honest placeholder. */
function AddressCell({ address }: { address: Address | undefined }) {
  if (!address || address === zeroAddress) {
    return <code>0x0000…0000</code>;
  }
  return (
    <a
      className="nums text-primary underline underline-offset-4"
      href={explorerAddressUrl(TARGET_CHAIN_ID, address)}
      target="_blank"
      rel="noreferrer noopener"
    >
      {shortAddress(address)}
    </a>
  );
}

function statusFor(address: Address | undefined): string {
  return !address || address === zeroAddress ? 'Not yet deployed' : `Live on ${NETWORK_NAME}`;
}

export default function ContractsPage() {
  return (
    <Prose>
      <Lead>
        Every Gold Standard contract is open source and independently verifiable on Etherscan. This
        page lists the contracts that make up the protocol, explains how to confirm a deployment
        is genuine, and points you to the live reserves view that reads addresses and backing
        straight from the chain.
      </Lead>

      {/* A mainnet build must not call itself a testnet. */}
      {IS_MAINNET_BUILD ? (
        <Callout variant="note" title="Ethereum mainnet">
          <p>
            The addresses below are the Gold Standard contracts on Ethereum mainnet, linked to
            Etherscan. Treat any address claiming to be a live Gold Standard contract with
            suspicion unless it matches this page and the{' '}
            <Link to="/transparency">reserves page</Link>.
          </p>
        </Callout>
      ) : (
        <Callout variant="warning" title="Pre-launch: testnet only">
          <p>
            Gold Standard is pre-launch. The contracts are open source and deployed to the{' '}
            <strong>Sepolia test network</strong>, where the addresses below are live and linked to
            Etherscan; they are <strong>not yet deployed to Ethereum mainnet</strong>, and the
            mainnet addresses will be published here after the mainnet deployment and the governance
            handover. This build targets {NETWORK_NAME}. Treat any address claiming to be a live
            Gold Standard contract with suspicion until it is published here and on the{' '}
            <Link to="/transparency">reserves page</Link>.
          </p>
        </Callout>
      )}

      <h2>Open by default</h2>
      <p>
        Gold Standard has no admin backend and no hidden ledger. The protocol is a set of Ethereum smart
        contracts whose source, bytecode and storage are public. Anyone can read the code, replay
        its history, and confirm that the GSUSD in circulation is matched by gold collateral held
        in the contracts. The principle is simple: you should never have to trust a claim you can
        verify yourself.
      </p>

      <FeatureGrid
        features={[
          {
            icon: CodeBracketSquareIcon,
            title: 'Source published',
            detail:
              'Contract source is open, and verified source on Etherscan is how anyone checks that the code they read is the code that runs. Each address listed below links there once a deployment is recorded.',
          },
          {
            icon: DocumentCheckIcon,
            title: 'Reproducible bytecode',
            detail:
              'Deployed bytecode can be matched against a build of the public source to confirm nothing was swapped in.',
          },
          {
            icon: LockClosedIcon,
            title: 'Roles held by the timelock',
            detail:
              'After launch, admin and governance roles sit with the 48-hour timelock, not a private key.',
          },
          {
            icon: MagnifyingGlassCircleIcon,
            title: 'Backing read on-chain',
            detail:
              'The reserves page derives collateral and supply directly from these contracts, block by block.',
          },
        ]}
      />

      <p>
        Software that uses Gold Standard without a browser, an agent or a keeper, starts from the
        machine-readable manifest at{' '}
        <a className="text-primary underline underline-offset-4" href="/agents.json">
          <code>/agents.json</code>
        </a>{' '}
        and the <Link to="/docs/agents">guide for agents</Link>, which also shows how to prove
        these addresses belong together with a handful of calls.
      </p>

      <h2>Protocol contracts</h2>
      <p>
        The protocol is split into focused contracts, each with a single responsibility. Splitting
        custody, debt accounting, pricing and the Stability Reserve keeps the trust surface small: a fault in
        one module should at worst pause the system rather than drain it. The addresses are read from
        the build's configuration for {NETWORK_NAME} and mirrored on the reserves page.
      </p>

      <DocTable
        head={['Contract', 'Role', 'Address', 'Status']}
        rows={[
          [
            <code>GoldStablecoin</code>,
            <>
              The <strong>GSUSD</strong> ERC-20 (Gold Standard Dollar, backed by tokenised gold) with
              permit and burn. Only the vault holds <code>MINTER_ROLE</code>.
            </>,
            <AddressCell address={GUSD_ADDRESSES[TARGET_CHAIN_ID]} />,
            statusFor(GUSD_ADDRESSES[TARGET_CHAIN_ID]),
          ],
          [
            <code>GoldVault</code>,
            <>
              The CDP core: collateral custody, debt issuance and{' '}
              <Link to="/docs/liquidations">liquidation</Link>.
            </>,
            <AddressCell address={GOLD_VAULT_ADDRESSES[TARGET_CHAIN_ID]} />,
            statusFor(GOLD_VAULT_ADDRESSES[TARGET_CHAIN_ID]),
          ],
          [
            <code>StabilityModule</code>,
            <>
              Per-second <Link to="/docs/stability-fee">stability-fee</Link> accrual on normalised
              debt.
            </>,
            <AddressCell address={STABILITY_MODULE_ADDRESSES[TARGET_CHAIN_ID]} />,
            statusFor(STABILITY_MODULE_ADDRESSES[TARGET_CHAIN_ID]),
          ],
          [
            <code>GoldOracle</code>,
            <>
              Prices PAXG from Chainlink PAXG/USD, checked against the Chainlink XAU/USD gold price
              under a 2% gold band and a 2% liquidation cap, with staleness and full-round checks;
              XAUT is registered and inactive. See the{' '}
              <Link to="/docs/oracle">oracle</Link> page.
            </>,
            <AddressCell address={GOLD_ORACLE_ADDRESSES[TARGET_CHAIN_ID]} />,
            statusFor(GOLD_ORACLE_ADDRESSES[TARGET_CHAIN_ID]),
          ],
          [
            <code>GoldStabilityReserve</code>,
            <>
              Holds protocol-owned gold that GSUSD can be swapped for at the oracle price minus a
              spread. It never mints, and swaps never touch a vault. This is the{' '}
              <Link to="/docs/peg-stability">price floor</Link>, exactly as deep as the reserve.
            </>,
            <AddressCell address={STABILITY_RESERVE_ADDRESSES[TARGET_CHAIN_ID]} />,
            statusFor(STABILITY_RESERVE_ADDRESSES[TARGET_CHAIN_ID]),
          ],
          [
            <code>SurplusBuffer</code>,
            'Protocol revenue reservoir; absorbs bad debt by burning held GSUSD.',
            <AddressCell address={SURPLUS_BUFFER_ADDRESSES[TARGET_CHAIN_ID]} />,
            statusFor(SURPLUS_BUFFER_ADDRESSES[TARGET_CHAIN_ID]),
          ],
          [
            <code>StabilityPool</code>,
            <>
              Liquity-style liquidation buffer with epoch and scale tracking, so depositors absorb
              liquidated debt for discounted gold. Pool liquidations are live from launch.
            </>,
            <AddressCell address={STABILITY_POOL_ADDRESSES[TARGET_CHAIN_ID]} />,
            statusFor(STABILITY_POOL_ADDRESSES[TARGET_CHAIN_ID]),
          ],
          [
            <code>SiloFactory</code>,
            <>
              Deploys minimal-proxy <Link to="/docs/collateral">collateral silos</Link> that shard
              custody across many addresses.
            </>,
            <AddressCell address={SILO_FACTORY_ADDRESSES[TARGET_CHAIN_ID]} />,
            statusFor(SILO_FACTORY_ADDRESSES[TARGET_CHAIN_ID]),
          ],
          [
            <code>VaultRegistry</code>,
            <>
              The on-chain list of open vaults and the views a liquidator or an agent needs,
              such as <code>liquidatableVaults</code> and <code>vaultSummary</code>, so nothing
              about finding or judging a vault depends on this site or its API.
            </>,
            <AddressCell address={VAULT_REGISTRY_ADDRESSES[TARGET_CHAIN_ID]} />,
            statusFor(VAULT_REGISTRY_ADDRESSES[TARGET_CHAIN_ID]),
          ],
          [
            <code>GoldGovernance</code>,
            <>
              A <code>TimelockController</code> wrapper; every parameter change waits out the
              timelock delay, 48 hours at launch. See <Link to="/docs/governance">governance</Link>.
            </>,
            <span>Published in the deployment record</span>,
            'Recorded at handover',
          ],
        ]}
      />

      <Callout variant="note" title="Individual collateral silos">
        <p>
          Each <code>CollateralSilo</code> is an EIP-1167 minimal-proxy clone deployed by{' '}
          <code>SiloFactory</code> as collateral grows, so there is no single fixed silo address.
          The factory address above is the entry point; the live silo set is enumerable on-chain
          and surfaced on the reserves page.
        </p>
      </Callout>

      <h2>The reserves page is the source of truth</h2>
      <p>
        Rather than trust a static list, read the live state. The{' '}
        <Link to="/transparency">reserves page</Link> queries these contracts directly: it shows
        the deployed addresses, the gold collateral held across vaults and silos, the GSUSD supply and the resulting collateralisation. Because it is computed from on-chain data, it cannot
        drift from reality the way a hand-maintained dashboard can.
      </p>

      <h2>How to verify a deployment</h2>
      <p>
        When the contracts go live, do not take our word for it. Independent verification takes a
        few minutes and confirms three things: the code is what was published, the addresses are
        wired together correctly, and control sits with the timelock rather than a private key.
      </p>

      <Steps
        steps={[
          {
            title: 'Confirm the source matches the bytecode',
            detail: (
              <>
                Open each contract on Etherscan and check it shows as verified. The verified source
                must match the public repository, and the on-chain runtime bytecode must match a
                clean build of that source. If the code on Etherscan differs from the open-source
                code, stop and do not interact.
              </>
            ),
          },
          {
            title: 'Check the wiring between contracts',
            detail: (
              <>
                Confirm that <code>GoldStablecoin</code> grants <code>MINTER_ROLE</code> only to{' '}
                <code>GoldVault</code>, that the vault points at the expected{' '}
                <code>GoldOracle</code> and <code>StabilityModule</code>, and that the Stability
                Reserve and surplus buffer reference the same GSUSD token. The addresses should match this
                page and the <Link to="/transparency">reserves page</Link>.
              </>
            ),
          },
          {
            title: 'Verify roles are held by the timelock',
            detail: (
              <>
                Read the role assignments and confirm that <code>DEFAULT_ADMIN_ROLE</code> and{' '}
                <code>GOVERNANCE_ROLE</code> are held by the <code>GoldGovernance</code> timelock,
                not by an externally owned account. The guardian multisig should hold only{' '}
                <code>GUARDIAN_ROLE</code> on the oracle, the vault, the stability pool and the
                Stability Reserve: the power to pause and to freeze, never to unpause. See <Link to="/docs/governance">governance</Link> for
                what each role can and cannot do.
              </>
            ),
          },
          {
            title: 'Cross-check the oracle feeds',
            detail: (
              <>
                Confirm <code>GoldOracle</code> references the official Chainlink PAXG/USD feed
                and the XAU/USD gold reference, and that the staleness threshold, gold band and
                liquidation cap match the documented{' '}
                <Link to="/docs/parameters">parameters</Link>. The repository ships
                <code> scripts/verify-deployment.ts</code>, which runs these checks on-chain.
              </>
            ),
          },
        ]}
      />

      <Callout variant="danger" title="Only ever use addresses published here">
        <p>
          Scammers deploy look-alike tokens and fake vaults. The only authoritative GSUSD and
          protocol addresses are the ones listed on this page and the{' '}
          <Link to="/transparency">reserves page</Link>. Never approve or send funds to an address
          shared in a direct message, a social post or a search result. This is experimental
          software, and nothing here is financial advice.
        </p>
      </Callout>

      <h2>Where to go next</h2>
      <p>
        For what each contract does in the wider system, read{' '}
        <Link to="/docs/vaults">vaults</Link>, <Link to="/docs/oracle">the oracle</Link> and{' '}
        <Link to="/docs/security">security</Link>. For the numbers these contracts enforce, see{' '}
        <Link to="/docs/parameters">parameters</Link>. For who controls them and how change is
        gated, see <Link to="/docs/governance">governance</Link>.
      </p>
    </Prose>
  );
}
