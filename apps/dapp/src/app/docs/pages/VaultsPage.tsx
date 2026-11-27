import { Link } from 'react-router-dom';
import {
  ArrowDownTrayIcon,
  BanknotesIcon,
  ArrowUpTrayIcon,
  ArrowUturnLeftIcon,
} from '@heroicons/react/24/outline';
import { Callout, DocTable, FeatureGrid, Lead, Prose, Steps } from '../components/DocComponents';
import { IS_MAINNET_BUILD } from '../../lib/network';

export default function VaultsPage() {
  return (
    <Prose>
      <Lead>
        A vault is your own non-custodial collateralised debt position. You lock tokenised gold
        into it, and against that gold you can mint GSUSD, the Gold Standard Dollar: a stablecoin
        backed by more gold than it issues. You alone control the vault: nobody can move
        your collateral while your position stays healthy.
      </Lead>

      <h2>What a vault is</h2>
      <p>
        Every borrower in Gold Standard operates through a vault. Conceptually a vault holds two balances:
        the <strong>collateral</strong> you have deposited (PAXG at launch, each token representing
        roughly one fine troy ounce of allocated London Good Delivery gold) and the <strong>debt</strong> you
        have minted (GSUSD). The <Link to="/docs/contracts">GoldVault</Link> contract records your
        position and holds the gold on your behalf in small, capped collateral silos (100 oz each)
        that spread it across many addresses, but it is non-custodial in the sense that matters:
        the contract will only ever release your collateral back to you, or to a liquidator when
        your position is unsafe. No operator, multisig or governance role can spend
        your gold while the vault remains adequately collateralised.
      </p>
      <p>
        Because the debt is denominated in GSUSD and the collateral is denominated in gold, the
        value of your position moves with the gold price. The vault tracks your debt continuously,
        accruing the <Link to="/docs/stability-fee">stability fee</Link> against it over time, and
        exposes a single number that summarises its safety: the collateral ratio.
      </p>

      <FeatureGrid
        features={[
          {
            icon: ArrowDownTrayIcon,
            title: 'Non-custodial',
            detail:
              'Your gold is recorded against your address and held in capped collateral silos that only the vault contract can move. It is released only back to you or, if you become undercollateralised, to a liquidator.',
          },
          {
            icon: BanknotesIcon,
            title: 'Over-collateralised',
            detail:
              'Every vault must hold more gold than the GSUSD it has minted, and liquidation restores that margin when the gold price falls. A fall fast enough to outrun liquidators can still leave bad debt, so the margin is a rule the protocol enforces, not a promise.',
          },
        ]}
      />

      <h2>The collateral ratio</h2>
      <p>
        The collateral ratio is the heart of a vault. It is the market value of your gold collateral
        divided by your outstanding GSUSD debt, expressed as a percentage:
      </p>
      <blockquote>
        <p>
          <strong>Collateral ratio = (collateral value in USD ÷ GSUSD debt) × 100%</strong>
        </p>
      </blockquote>
      <p>
        Collateral value is computed from the <Link to="/docs/oracle">gold oracle</Link>, which
        reads Chainlink PAXG/USD and checks it against the Chainlink XAU/USD gold price. Minting
        and withdrawing against debt use the lower of the market and gold prices, and are refused
        while the market feed sits more than 2% from gold. Liquidation uses the higher of the two,
        never more than 2% above gold, so a dip in PAXG alone does not liquidate you while gold
        holds. The gold market closes over the weekend, so the gold price stands still until it
        reopens while PAXG keeps trading. Repaying and depositing never need a price.
        Internally the protocol works in 6-decimal fixed point, where 1,000,000 represents 100%, and
        rounding always favours the protocol so the system never overstates your safety.
      </p>
      <p>Two thresholds govern the ratio:</p>
      <ul>
        <li>
          <strong>Minimum collateral ratio: 130%.</strong> Minting new debt and withdrawing collateral are
          allowed only while the vault stays at or above 130% afterwards. Any action that would push the ratio below
          130% is rejected.
        </li>
        <li>
          <strong>Liquidation ratio: 110%.</strong> If your ratio falls below 110%, your vault
          becomes liquidatable and anyone can repay your debt and seize gold worth that debt plus a 5% penalty, of which the liquidator keeps three fifths.
          The protocol runs a keeper service that watches every vault for exactly this, so expect
          an unsafe vault to be cleared promptly. See{' '}
          <Link to="/docs/liquidations">liquidations</Link> for the full mechanism.
        </li>
      </ul>

      <h3>Health bands</h3>
      <p>
        The vault interface groups the ratio into health bands so you can read your position at a
        glance. The bands are guidance for managing risk, not on-chain thresholds; only the 130%
        mint floor and the 110% liquidation ratio are enforced by the contracts.
      </p>
      <DocTable
        head={['Band', 'Collateral ratio', 'What it means']}
        rows={[
          [
            <strong>Healthy</strong>,
            '≥ 150%',
            'Comfortable buffer. The gold price would need to fall sharply before you approach liquidation.',
          ],
          [
            <strong>Caution</strong>,
            '120% to 150%',
            'The safety margin is thinning. Above the 130% floor you can still mint and withdraw; below it you can only deposit or repay. Watch the gold price.',
          ],
          [
            <strong>At risk</strong>,
            '110% to 120%',
            'Below the mint floor and close to the line: a modest price fall could trigger liquidation. Add collateral or repay.',
          ],
          [
            <strong>Liquidatable</strong>,
            '< 110%',
            'Anyone may liquidate your vault. Act immediately if you still can.',
          ],
        ]}
      />

      <h2>The four vault actions</h2>
      <p>
        You manage a vault with four actions. Two add safety to the position and two draw on it;
        together they let you open, grow, shrink and close a vault.
      </p>
      <FeatureGrid
        features={[
          {
            icon: ArrowDownTrayIcon,
            title: 'Deposit',
            detail:
              'Lock more gold (PAXG at launch) into the vault. This raises your collateral value and your ratio. Deposits are the first step in opening a vault.',
          },
          {
            icon: BanknotesIcon,
            title: 'Mint',
            detail:
              'Borrow GSUSD against your collateral. Minting increases your debt and lowers your ratio; it is only allowed while the result stays at or above 130%.',
          },
          {
            icon: ArrowUpTrayIcon,
            title: 'Withdraw',
            detail:
              'Take collateral back out of the vault. Withdrawal lowers your ratio and is only allowed while the vault stays at or above 130% afterwards.',
          },
          {
            icon: ArrowUturnLeftIcon,
            title: 'Repay',
            detail:
              'Burn GSUSD to reduce your debt. Repaying raises your ratio. Repaying your full debt lets you withdraw all collateral and close the vault.',
          },
        ]}
      />
      <ul>
        <li>
          <strong>Deposit</strong> moves gold from your wallet into the vault. Collateral is
          accounted for using the balance actually received, so fee-on-transfer behaviour is handled
          safely (see below).
        </li>
        <li>
          <strong>Mint</strong> issues new GSUSD to you and records the matching debt. Minting is
          where you draw liquidity out of your gold without selling it, subject to the collateral
          ratio and the minimum debt. Mainnet launches with no debt ceiling and no per-block mint
          cap; governance can set either through the timelock.
        </li>
        <li>
          <strong>Withdraw</strong> returns gold to your wallet. It is the inverse of deposit and is
          gated by the 130% minimum so you cannot leave the vault under-collateralised.
        </li>
        <li>
          <strong>Repay</strong> burns GSUSD against your debt, including any accrued stability fee.
          It is the inverse of mint and the route to closing a position. Sending more than the
          current debt is capped to a full close, so a full-repay quote that is a few seconds stale
          still works.
        </li>
      </ul>
      <p>
        If the guardian pauses the vault, minting, withdrawal from a vault with debt and direct liquidation are blocked, but deposit
        and repay stay open so you can always defend a position, and a vault that carries no debt
        can still withdraw because it reads no price. Repay in full, then withdraw: that exit works
        during any pause, whether of the vault or the oracle. Only governance can unpause early,
        and a pause lapses after 14 days, after which anyone can lift it.
      </p>

      <Callout variant="note" title="Minimum debt">
        <p>
          A vault that carries debt must carry at least{' '}
          {IS_MAINNET_BUILD ? null : (
            <>
              <strong>100 GSUSD</strong> of it on Sepolia and{' '}
            </>
          )}
          <strong>1,000 GSUSD</strong>{IS_MAINNET_BUILD ? ' of it' : null} at the mainnet launch. Governance sets the
          figure between 100 and 10,000. This minimum, called MIN_DEBT in the contract, keeps
          positions large enough to be economically worth liquidating, which protects the
          protocol from a long tail of dust vaults that would cost more in gas to clear than they
          are worth. You can always repay to exactly zero to close a vault, but you cannot leave a
          non-zero debt below the minimum.
        </p>
      </Callout>

      <h2>A typical vault lifecycle</h2>
      <Steps
        steps={[
          {
            title: 'Deposit gold collateral',
            detail:
              'Open a vault by depositing gold (PAXG at launch). With no debt yet, the vault is fully collateralised and perfectly safe.',
          },
          {
            title: 'Mint GSUSD',
            detail: (
              <>
                Borrow GSUSD up to the point where your ratio reaches 130%. In practice, mint less
                so you keep a buffer. See{' '}
                <Link to="/docs/minting-redeeming">minting and swapping</Link> for the full flow.
              </>
            ),
          },
          {
            title: 'Manage the position',
            detail:
              'As the gold price moves and the stability fee accrues, your ratio drifts. Top up collateral or repay debt to keep a comfortable margin above 130%.',
          },
          {
            title: 'Repay and close',
            detail:
              'Burn GSUSD to clear the debt (principal plus accrued fee), then withdraw your collateral. With debt at zero you can withdraw everything and close the vault.',
          },
        ]}
      />

      <h2>How the liquidation price is derived</h2>
      <p>
        Although the protocol works in collateral ratios, it is often easier to think in terms of a{' '}
        <strong>liquidation price</strong>: the gold price at which your ratio would fall to the
        110% liquidation threshold. Conceptually it is the price where collateral value equals 110%
        of your debt:
      </p>
      <blockquote>
        <p>
          <strong>
            Liquidation price ≈ (1.10 × GSUSD debt) ÷ ounces of gold collateral
          </strong>
        </p>
      </blockquote>
      <p>
        If the oracle gold price falls to that level, your vault becomes liquidatable. Two levers
        move your liquidation price further from the current market: adding collateral (more ounces
        in the denominator) and repaying debt (less debt in the numerator). The vault interface
        surfaces this price directly so you can monitor how much room you have before the gold
        price would put you at risk.
      </p>

      <h2>Fee-on-transfer-safe deposits</h2>
      <p>
        PAXG is a standard custodial gold token today, but the vault is built defensively
        against tokens that take a fee on transfer. Rather than trusting the amount you ask to
        deposit, the contract measures its own collateral balance before and after the transfer and
        credits your vault with the difference actually received. The same care is taken when
        collateral is pulled back from the silos for a liquidation. This means your recorded
        collateral always matches the gold the
        protocol genuinely holds, so the system can never overstate backing because a transfer
        skimmed a fee in transit.
      </p>
      <Callout variant="note" title="Defended by design">
        <p>
          Fee-on-transfer-safe deposits are one of several deliberately defended bug classes in
          Gold Standard, alongside reentrancy protection, checked arithmetic and oracle staleness checks.
          See <Link to="/docs/security">security</Link> for the full list.
        </p>
      </Callout>

      <Callout variant="warning" title="Keep your ratio safely above 130%">
        <p>
          The 130% minimum is the floor for taking actions, not a safe operating point. Sitting near
          130% leaves almost no room before the 110% liquidation ratio, and the gold price can move
          quickly. Treat 150% or more as a healthy target, watch your{' '}
          <Link to="/docs/liquidations">liquidation price</Link>, and add collateral or repay early
          rather than waiting for a warning. Remember that the{' '}
          <Link to="/docs/stability-fee">stability fee</Link> raises your debt over time, so a vault
          left untouched slowly drifts towards liquidation on its own.
        </p>
      </Callout>

      <hr />
      <p>
        Ready to put a vault to work? Open the <Link to="/vault">vault dashboard</Link>, or read how{' '}
        <Link to="/docs/minting-redeeming">minting and swapping</Link> turns gold into liquidity,
        what happens in a <Link to="/docs/liquidations">liquidation</Link>, and the full list of{' '}
        <Link to="/docs/parameters">protocol parameters</Link>.
      </p>
    </Prose>
  );
}
