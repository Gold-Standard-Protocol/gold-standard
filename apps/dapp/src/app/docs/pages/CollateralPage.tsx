import { Link } from 'react-router-dom';
import {
  BuildingLibraryIcon,
  ShieldCheckIcon,
  GlobeAltIcon,
} from '@heroicons/react/24/outline';
import { Callout, DocTable, FeatureGrid, Lead, Prose } from '../components/DocComponents';
import { IS_MAINNET_BUILD } from '../../lib/network';

export default function CollateralPage() {
  return (
    <Prose>
      <Lead>
        GSUSD (Gold Standard Dollar) is backed by more gold than it issues. At
        launch the gold enters the protocol as Paxos Gold (PAXG), representing
        allocated London Good Delivery bullion held in professional vaults.
        Tether Gold (XAUT) is registered and can be activated later, once it
        meets published criteria, to spread custody across a second issuer.
      </Lead>

      <h2>Why gold</h2>
      <p>
        Most stablecoins are backed by dollars or dollar-denominated assets.
        Gold Standard is backed by gold because gold is the asset whose value has
        endured longest, independent of any single currency, government or bank.
        A gold-backed unit anchors GSUSD to a real, scarce, globally-priced
        commodity rather than to fiat held in a bank account. The collateral is
        not a claim on a balance sheet of loans; it is allocated metal in a
        vault.
      </p>
      <p>
        Gold Standard does not custody bars itself. It accepts gold that has already
        been tokenised by established issuers, so that on-chain settlement,
        transfer and liquidation all work with standard ERC-20 mechanics while
        the underlying value remains physical gold.
      </p>

      <h2>The collateral assets</h2>
      <p>
        Two tokens are registered, each backed by allocated London Good Delivery
        gold and each redeemable with its issuer for physical metal. They differ
        in issuer and in token precision, which the protocol normalises
        internally. Mainnet launches with <strong>PAXG only</strong>, with no
        debt ceiling and no per-block mint cap. <strong>XAUT is inactive</strong>: it is
        registered in the oracle but is not a vault collateral, not a Stability
        Reserve asset and not a stability pool token, because no source yet
        prices it securely without an operator the protocol would have to run.
        It is activated by one governance batch once it meets the criteria on
        the <Link to="/docs/oracle">oracle</Link> page, with no redeployment and
        no change to PAXG positions. The dapp offers only the collateral the
        vault lists as active, so XAUT appears there on its own once it is
        activated.{IS_MAINNET_BUILD ? null : ' On Sepolia both tokens are team-controlled mocks.'}
      </p>

      <DocTable
        head={['', 'PAXG', 'XAUT']}
        rows={[
          ['Status at launch', 'Active collateral, no debt ceiling', 'Registered, inactive until activation'],
          ['Name', 'Paxos Gold', 'Tether Gold'],
          ['Issuer', 'Paxos Trust Company', 'TG Commodities (Tether)'],
          ['Decimals', '18', '6'],
          [
            'Backing per token',
            'About one fine troy ounce',
            'About one fine troy ounce',
          ],
          [
            'Underlying',
            'Allocated London Good Delivery gold',
            'Allocated London Good Delivery gold',
          ],
          [
            'Price sources',
            'Chainlink PAXG/USD, checked against Chainlink XAU/USD',
            'To be set at activation (no XAUT/USD push feed exists on Ethereum today)',
          ],
          ['Gold reference', 'Chainlink XAU/USD, 2% gold band and 2% liquidation cap', 'Chainlink XAU/USD, set at activation'],
        ]}
      />

      <FeatureGrid
        features={[
          {
            icon: BuildingLibraryIcon,
            title: 'Allocated, not pooled',
            detail:
              'Each token corresponds to specific allocated bullion, roughly one fine troy ounce of London Good Delivery gold, held in professional vaults rather than an unallocated claim.',
          },
          {
            icon: GlobeAltIcon,
            title: 'London Good Delivery standard',
            detail:
              'Both back their tokens with bars meeting the London Good Delivery standard, the benchmark for institutional gold quality and provenance.',
          },
          {
            icon: ShieldCheckIcon,
            title: 'A second issuer, once it qualifies',
            detail:
              'Activating Tether gold alongside Paxos gold would mean the protocol no longer depends on a single issuer. Until XAUT meets its criteria, all collateral carries Paxos custody, freeze and redemption risk.',
          },
        ]}
      />

      <h2>How Gold Standard normalises decimals</h2>
      <p>
        The two tokens do not share a precision. <strong>PAXG uses 18
        decimals</strong>, the most common ERC-20 convention, matching GSUSD
        itself. <strong>XAUT uses 6 decimals</strong>. If the protocol treated
        the raw on-chain integers as comparable, a unit of XAUT would be
        mispriced against a unit of PAXG by a factor of a trillion.
      </p>
      <p>
        Gold Standard therefore reads each token's decimals from the token contract
        itself and scales every collateral amount to a common 18-decimal
        precision before doing any maths. Balances are held and transferred in
        each token's native precision and normalised to 18 decimals whenever the
        protocol values collateral, so deposits, debt, collateral ratios and
        liquidations are all computed on a like-for-like basis. Tokens with more
        than 18 decimals are rejected at registration. Chainlink feeds report in
        8 decimals and collateral ratios are tracked in 6-decimal fixed point,
        where 1,000,000 represents 100%. The protocol also measures what it
        actually receives on every transfer rather than trusting the requested
        amount. PAXG has no transfer fee today: Paxos removed the fee mechanism
        from the token in its June 2026 upgrade. The token is an upgradeable
        proxy, so Paxos could change its behaviour again, and the protocol
        therefore still measures what arrives: vault credits, liquidation
        payouts and reserve seeding all work from the measured delta, so a
        transfer that delivered less than was sent would be handled without any
        change. Throughout, rounding is
        resolved in the protocol's favour so accounting never drifts against the
        backing. The full unit conventions are listed in{' '}
        <Link to="/docs/parameters">Parameters</Link>.
      </p>
      <Callout variant="tip" title="Why this matters for users">
        Because the protocol normalises precision internally, the collateral
        ratio, liquidation thresholds and Stability Reserve quotes behave
        identically for any accepted token. The decimal difference between PAXG
        and XAUT is handled entirely under the hood, ready for the day XAUT is
        activated.
      </Callout>

      <h2>Counterparty and custody risk</h2>
      <p>
        The strength of gold-backed collateral is also its main residual risk.
        PAXG and XAUT are only as sound as the issuers behind them. Paxos and
        Tether hold the physical gold and operate the tokens, and both retain
        the power to <strong>freeze addresses</strong>, a standard
        feature of regulated, issuer-controlled tokens. If an issuer froze an
        address holding the protocol's collateral, that collateral could become
        temporarily or permanently inaccessible.
      </p>
      <Callout variant="warning" title="Issuers can freeze addresses">
        PAXG and XAUT are issuer-controlled tokens. Paxos and Tether can freeze
        transfers from specific addresses and are exposed to regulatory action
        in their jurisdictions. This is counterparty and custody risk that
        Gold Standard inherits and cannot remove. It is a fundamental property of using
        tokenised real-world gold as collateral.
      </Callout>

      <h3>The collateral-silo mitigation</h3>
      <p>
        Gold Standard does not hold all of a collateral type at one address. Through
        the SiloFactory it deploys many <strong>collateral silos</strong>,
        lightweight minimal-proxy contracts (EIP-1167) that shard custody across
        a large number of addresses, each capped at 100 ounces at deploy
        (governance can raise the cap to a hard maximum of 1,000 ounces). The
        factory's VAULT_ROLE is locked at deploy, so only the vault can ever
        move collateral out of a silo. To censor the protocol by freezing its
        gold, an issuer would have to identify and freeze a great many silo
        addresses rather than a single treasury, which raises the cost and
        visibility of a freeze substantially.
      </p>
      <p>
        Silos raise the cost of an issuer-side freeze; they do not eliminate it.
        Deposits skip past a frozen silo and withdrawals route around one, so a
        single frozen address blocks neither the flow in nor the flow out; the
        frozen balance stays counted and becomes withdrawable again once it is
        unfrozen. At launch every ounce of collateral is PAXG, so the protocol
        carries a single issuer&rsquo;s risk in full; activating XAUT would{' '}
        <strong>diversify across two issuers</strong> and reduce single-custodian
        exposure, but the underlying counterparty risk is inherent to tokenised
        gold and remains a residual risk.
      </p>
      <Callout variant="danger" title="Residual risk and disclaimer">
        Custody and counterparty risk on PAXG and XAUT cannot be fully removed.
        Collateral silos, and dual-issuer diversification once XAUT is
        activated, reduce but do not eliminate the risk of an issuer freeze or
        regulatory action.{' '}
        {IS_MAINNET_BUILD ? 'Gold Standard is' : 'Gold Standard is pre-launch on the Sepolia testnet; it is'} open source,
        so anyone can read and verify the code. This is experimental software and
        nothing here is financial advice. The complete
        risk picture is set out on the{' '}
        <Link to="/docs/security">Security and risks</Link> page.
      </Callout>
    </Prose>
  );
}
