import { Link } from 'react-router-dom';
import {
  ArrowsRightLeftIcon,
  BanknotesIcon,
  CubeTransparentIcon,
  EyeIcon,
  KeyIcon,
  ScaleIcon,
  ShieldCheckIcon,
} from '@heroicons/react/24/outline';
import {
  Callout,
  DocTable,
  FeatureGrid,
  Lead,
  Prose,
} from '../components/DocComponents';
import { IS_MAINNET_BUILD } from '../../lib/network';

export default function WhyGoldStandardPage() {
  return (
    <Prose>
      <Lead>
        Most stablecoins rest on a balance sheet you cannot inspect. GSUSD rests
        on gold you can verify on-chain, and gives you a stable dollar to spend
        while your collateral keeps its exposure to gold.
      </Lead>

      <h2>The case for a gold-backed dollar</h2>
      <p>
        Fiat-backed stablecoins are convenient, but their value rests on an
        issuer holding reserves you cannot independently inspect, in accounts
        that can be frozen, reported late or misrepresented. Holding gold solves
        the trust problem but leaves you with an asset that is awkward to spend
        and does not move at a stable dollar value.
      </p>
      <p>
        Gold Standard takes the soundness of gold and gives it the usability of a
        dollar. You keep custody of tokenised gold, mint a stable unit of account
        against it, and the backing is provable on-chain rather than asserted in
        a quarterly attestation.
      </p>

      <FeatureGrid
        features={[
          {
            icon: ShieldCheckIcon,
            title: 'Backed by tokenised gold',
            detail:
              'Every GSUSD is collateralised by tokenised gold (PAXG at launch), redeemable for allocated London Good Delivery gold held in professional vaults.',
          },
          {
            icon: KeyIcon,
            title: 'Non-custodial by design',
            detail:
              'Your collateral sits in a vault only you control. No operator, multisig or governance role can move it while your position stays healthy; the contracts release it only to you, or to a liquidator if the vault falls below the liquidation ratio.',
          },
          {
            icon: ArrowsRightLeftIcon,
            title: 'Convertible to reserve gold',
            detail:
              'Swap GSUSD for protocol-owned gold from the Stability Reserve at the oracle price minus a small spread, with no permission required and no borrower’s vault involved.',
          },
          {
            icon: EyeIcon,
            title: 'Transparent reserves',
            detail:
              'Backing is verifiable on-chain at any moment. Proof of reserves is a contract read, not a report you take on trust.',
          },
          {
            icon: ScaleIcon,
            title: 'Over-collateralised solvency',
            detail:
              'Every vault must hold at least 130% collateral against its debt to mint or withdraw, and is liquidated below 110%, so the system stays solvent through ordinary gold price moves.',
          },
          {
            icon: CubeTransparentIcon,
            title: 'Censorship resistance',
            detail:
              'Collateral silos shard gold across many capped addresses, and withdrawals route around any silo an issuer freezes, raising the cost of an issuer-side freeze against the protocol.',
          },
          {
            icon: BanknotesIcon,
            title: 'Spend a dollar, keep gold upside',
            detail:
              'Mint a stable unit to use today while your deposited gold retains its long-term exposure. Repay to reclaim it whenever you choose.',
          },
        ]}
      />

      <h2>Compared with opaque fiat stablecoins</h2>
      <p>
        A fiat-backed stablecoin is an IOU. Its peg depends on an issuer holding
        the reserves it claims, in institutions that can fail or freeze accounts,
        verified by attestations that arrive after the fact. GSUSD replaces that
        promise with on-chain collateral and contract-enforced solvency.
      </p>

      <DocTable
        head={['', 'Opaque fiat stablecoin', 'GSUSD']}
        rows={[
          [
            'Backing',
            'Fiat and money-market instruments held off-chain',
            'Tokenised physical gold held on-chain',
          ],
          [
            'Custody',
            'Issuer custodies the reserves',
            'You custody the collateral in your own vault',
          ],
          [
            'Verification',
            'Periodic attestations you take on trust',
            'Reserves readable on-chain at any moment',
          ],
          [
            'Conversion to gold',
            'Gated by issuer terms and account access',
            'Permissionless swap for reserve gold at the oracle price, up to reserve capacity',
          ],
          [
            'Solvency',
            'One-to-one, dependent on the issuer',
            'Over-collateralised: 130% to mint or withdraw, liquidation below 110%',
          ],
        ]}
      />

      <h2>Compared with simply holding gold</h2>
      <p>
        Holding tokenised gold is sound, but it is not spendable as a stable
        dollar. To pay or save in dollar terms you must sell, realising a taxable
        event and giving up your exposure. Gold Standard lets you keep the gold and
        borrow a stable unit against it instead.
      </p>
      <ul>
        <li>
          <strong>Liquidity without selling.</strong> Mint GSUSD against your
          gold rather than liquidating it.
        </li>
        <li>
          <strong>Retained upside.</strong> Your collateral keeps its full
          exposure to the gold price while the debt stays denominated in dollars.
        </li>
        <li>
          <strong>A stable unit of account.</strong> Transact in a dollar-pegged
          token instead of an asset that moves daily.
        </li>
        <li>
          <strong>Reversible.</strong> Repay the debt, fees included, and withdraw
          your collateral.
        </li>
      </ul>

      <h2>The trade-offs, honestly</h2>
      <p>
        A gold-backed dollar removes some risks and introduces others. Gold Standard is
        designed so that any single point of failure pauses the system rather
        than draining it, but the residual risks are real and you should weigh
        them before depositing.
      </p>
      <ul>
        <li>
          <strong>Smart-contract risk.</strong> The protocol is code. Bugs may
          remain despite testing, and a bug could cause the loss of funds.
        </li>
        <li>
          <strong>Counterparty and custody risk.</strong> PAXG depends on Paxos
          honouring the gold behind its token, and Paxos could freeze transfers.
          Silos raise the cost of a freeze, and activating XAUT later would
          reduce exposure to a single custodian, but neither measure removes the
          risk.
        </li>
        <li>
          <strong>A depeg of PAXG alone.</strong> Liquidation values PAXG at no
          less than the gold price, so if PAXG fell below gold while gold held,
          vaults would not be liquidated for it and GSUSD holders would carry the
          loss. Minting and reserve swaps stop while PAXG is more than 2% off
          gold.
        </li>
        <li>
          <strong>Tail-event depeg.</strong> If gold falls sharply within
          minutes, faster than liquidators can act, vaults near the 110% line
          can slip below full backing before they are cleared. The surplus
          buffer absorbs that shortfall first, as far as its balance allows; anything beyond it is recorded
          as bad debt and the vault pauses automatically above a governance-set
          threshold.
        </li>
        <li>
          <strong>Regulatory and MEV risk.</strong> Regulatory action could
          affect the protocol or its collateral, and small stability swaps can be
          exposed to MEV.
        </li>
      </ul>

      <Callout variant="danger" title="Understand the risks before depositing">
        <p>
          {IS_MAINNET_BUILD
            ? 'Gold Standard is experimental software.'
            : 'Gold Standard is experimental, pre-launch software running on testnet.'}{' '}
          Read the full trust model,
          defended bug classes and
          residual risks on the <Link to="/docs/security">Security</Link> page
          before committing funds. Nothing here is financial advice.
        </p>
      </Callout>

      <p>
        Ready to try it? Head to{' '}
        <Link to="/docs/getting-started">Getting started</Link> to open your
        first vault, or read{' '}
        <Link to="/docs/peg-stability">Peg stability</Link> to understand exactly
        what holds GSUSD to the dollar.
      </p>
    </Prose>
  );
}
