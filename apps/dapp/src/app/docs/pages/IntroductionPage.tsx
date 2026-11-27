import { Link } from 'react-router-dom';
import { Callout, DocTable, Lead, Prose } from '../components/DocComponents';
import { IS_MAINNET_BUILD } from '../../lib/network';

export default function IntroductionPage() {
  return (
    <Prose>
      <Lead>
        Gold Standard is a protocol for issuing a dollar that is over-collateralised
        by tokenised gold. You deposit tokenised gold, mint <strong>GSUSD</strong> against it
        and repay to release that gold whenever you choose. Any holder can also
        convert GSUSD to protocol-owned gold through the Stability Reserve.
        Everything runs on open, non-custodial smart contracts.
      </Lead>

      <h2>What Gold Standard is</h2>
      <p>
        Gold Standard Protocol runs the contracts behind <strong>GSUSD</strong>, short
        for <em>Gold Standard Dollar</em>. It is a collateralised debt system, in
        the lineage of MakerDAO and Liquity, but the collateral is tokenised
        physical gold rather than volatile crypto assets. Users lock gold into a
        vault and mint GSUSD, a dollar-denominated stablecoin whose value is
        anchored by the gold sitting behind it and defended by several
        independent peg mechanisms.
      </p>
      <p>
        The collateral is a token claim on allocated gold held in professional vaults. At
        launch it is <strong>PAXG</strong> (Paxos Gold), each token representing
        approximately one fine troy ounce of London Good Delivery gold;{' '}
        <strong>XAUT</strong> (Tether Gold) is registered and can be activated
        once it meets published criteria. GSUSD is an ERC-20 token with 18 decimals, mintable only
        by the protocol vault and burned on repayment.
      </p>

      <h2>What GSUSD is, and what it is not</h2>
      <p>
        The name <em>Gold Standard Dollar</em> is deliberate. GSUSD is a dollar unit
        of account whose solvency is <strong>backed by tokenised gold</strong>.
        Read it as &ldquo;a dollar on a gold standard&rdquo;, not as
        &ldquo;a high-quality US dollar&rdquo;.
      </p>

      <DocTable
        head={['GSUSD is', 'GSUSD is not']}
        rows={[
          [
            'A stablecoin over-collateralised by tokenised physical gold',
            'A claim on a bank deposit or any fiat reserve account',
          ],
          [
            'Minted against over-collateralised gold vaults you control',
            'A repackaging of US dollars or money-market instruments',
          ],
          [
            'Convertible on-chain to protocol-owned reserve gold, up to reserve capacity',
            'A custodial IOU that depends on an issuer honouring withdrawals',
          ],
          [
            'Pegged to the dollar through transparent contract logic',
            'A guarantee of value; gold can fall sharply and depeg the unit',
          ],
        ]}
      />

      <p>
        Because GSUSD is non-custodial, there is no company holding your dollars
        and no balance sheet to inspect on trust. Solvency is enforced in code:
        every GSUSD in circulation is normally backed by gold collateral worth
        more than the debt, and the backing is verifiable on-chain at any moment.
      </p>

      <h2>The core idea</h2>
      <p>
        The mechanism is a single, legible loop. You bring gold, you take out a
        stable dollar against it, and you settle whenever you like.
      </p>
      <ol>
        <li>
          <strong>Deposit tokenised gold.</strong> Lock PAXG into a
          vault you alone control.
        </li>
        <li>
          <strong>Mint GSUSD.</strong> Draw GSUSD against that collateral,
          which is allowed only while the vault stays at or above the minimum
          collateral ratio of 130%.
        </li>
        <li>
          <strong>Spend, save or supply.</strong> Hold a stable dollar while your
          gold stays yours and keeps its long-term exposure.
        </li>
        <li>
          <strong>Repay or swap.</strong> Repay the debt to release your own
          collateral, or swap GSUSD for protocol-owned gold from the Stability
          Reserve at the oracle price minus a small spread. No borrower&rsquo;s
          vault is ever involved in a swap.
        </li>
      </ol>
      <p>
        Three mechanisms hold the peg together:{' '}
        <Link to="/docs/liquidations">over-collateralisation and liquidation</Link>
        , a <Link to="/docs/minting-redeeming">Stability Reserve floor</Link> and a{' '}
        <Link to="/docs/stability-fee">stability fee feeding a surplus buffer</Link>
        . The <Link to="/docs/peg-stability">peg stability</Link> page explains
        how they reinforce one another.
      </p>

      <h2>Why &ldquo;Gold Standard&rdquo;</h2>
      <p>
        Under the gold standard a unit of money was defined as a weight of gold,
        and banknotes could be exchanged for it. Britain held to that rule from
        1821 until the First World War, and the dollar kept a link to gold until
        the United States closed the gold window in 1971. Gold Standard
        Protocol rebuilds the idea on-chain: a
        unit of account anchored to gold, but programmable, transparent and
        convertible to protocol-owned gold up to the capacity of the reserve.
      </p>

      <h2>How these docs are organised</h2>
      <p>
        The documentation is grouped so you can move from concepts to mechanics
        to reference material.
      </p>
      <ul>
        <li>
          <strong>Get started.</strong>{' '}
          <Link to="/docs/why-gold-standard">Why Gold Standard</Link> makes the case for a
          gold-backed dollar, and{' '}
          <Link to="/docs/getting-started">Getting started</Link> walks you
          through opening your first vault.
        </li>
        <li>
          <strong>Core mechanics.</strong>{' '}
          <Link to="/docs/vaults">Vaults</Link>,{' '}
          <Link to="/docs/minting-redeeming">Minting and swapping</Link>,{' '}
          <Link to="/docs/liquidations">Liquidations</Link> and{' '}
          <Link to="/docs/peg-stability">Peg stability</Link> describe how the
          system works day to day.
        </li>
        <li>
          <strong>Infrastructure.</strong>{' '}
          <Link to="/docs/stability-fee">Stability fee</Link>,{' '}
          <Link to="/docs/oracle">Oracle</Link> and{' '}
          <Link to="/docs/collateral">Collateral</Link> cover the engines beneath
          the protocol.
        </li>
        <li>
          <strong>Reference.</strong>{' '}
          <Link to="/docs/parameters">Parameters</Link>,{' '}
          <Link to="/docs/security">Security</Link>,{' '}
          <Link to="/docs/governance">Governance</Link> and{' '}
          <Link to="/docs/contracts">Contracts</Link> give the precise numbers,
          trust model and deployed addresses, with a{' '}
          <Link to="/docs/glossary">glossary</Link> and{' '}
          <Link to="/docs/faq">FAQ</Link> alongside.
        </li>
        <li>
          <strong>For software.</strong>{' '}
          <Link to="/docs/agents">For agents</Link> is the short guide for an
          autonomous agent, a keeper or a script that uses Gold Standard with contract
          calls alone, starting from the manifest at <code>/agents.json</code>.
        </li>
      </ul>

      {/* The status follows the build's target chain. */}
      {IS_MAINNET_BUILD ? (
        <Callout variant="note" title="Status: experimental software">
          <p>
            Gold Standard runs on Ethereum mainnet. The code is open source, so anyone can read
            and verify it. Treat everything here as experimental software;
            nothing in these docs is financial advice. See the{' '}
            <Link to="/docs/security">Security</Link> page for the full risk disclosure.
          </p>
        </Callout>
      ) : (
        <Callout variant="note" title="Status: testnet and pre-launch">
          <p>
            Gold Standard targets Ethereum mainnet and currently runs on the Sepolia
            testnet with mock collateral tokens and team-controlled price feeds.
            Production contracts are not yet deployed. The full launch runbook has
            been rehearsed end to end on Sepolia. The code is open source, so anyone
            can read and verify it. Treat everything here as experimental software; nothing in
            these docs is financial advice. See the{' '}
            <Link to="/docs/security">Security</Link> page for the full risk
            disclosure.
          </p>
        </Callout>
      )}
    </Prose>
  );
}
