import { Link } from 'react-router-dom';
import { Callout, DocTable, Lead, Prose, Steps } from '../components/DocComponents';
import { IS_MAINNET_BUILD } from '../../lib/network';

export default function MintingRedeemingPage() {
  return (
    <Prose>
      <Lead>
        Minting and repaying are the two flows that move Gold Standard Dollar (GSUSD) in and out of
        existence. Minting borrows GSUSD against tokenised gold inside a vault; repaying burns it and
        releases that gold. A third flow, the Stability Swap, lets any holder exchange GSUSD for
        protocol-owned gold from the Stability Reserve at the oracle price minus a spread. Together
        they tie the supply of GSUSD to tokenised gold and anchor the peg.
      </Lead>

      <h2>Minting GSUSD</h2>
      <p>
        Minting is borrowing. You deposit tokenised gold (PAXG at launch) into your{' '}
        <Link to="/docs/vaults">vault</Link>, then mint GSUSD against it. The newly minted GSUSD is
        issued to you and an equal amount of debt is recorded against your vault. You have not sold
        your gold; you have borrowed a dollar-denominated stablecoin against it, and you can reclaim
        the gold by repaying.
      </p>
      <p>Minting is governed by several constraints, all designed to keep GSUSD over-collateralised:</p>
      <DocTable
        head={['Constraint', 'Value', 'Why it exists']}
        rows={[
          [
            <strong>Minimum collateral ratio</strong>,
            '130%',
            'You may only mint while your vault stays at or above 130% collateral-to-debt, so every GSUSD is over-collateralised by gold.',
          ],
          [
            <strong>Minimum debt (MIN_DEBT)</strong>,
            IS_MAINNET_BUILD
              ? '1,000 GSUSD at the mainnet launch, governed between 100 and 10,000'
              : '100 GSUSD on Sepolia; 1,000 at the mainnet launch, governed between 100 and 10,000',
            'A vault that carries debt must carry at least this much, keeping positions large enough to be worth liquidating.',
          ],
          [
            <strong>Debt ceiling</strong>,
            IS_MAINNET_BUILD ? 'None at mainnet launch' : 'None at mainnet launch or on Sepolia',
            'A cap on total GSUSD minted against each collateral type. Mainnet launches without one: the oracle, not a ceiling, bounds what a manipulated price can extract, since borrowing never prices above gold and liquidation never prices below it. Governance can set one through the timelock.',
          ],
          [
            <strong>Per-block mint cap</strong>,
            'Off at mainnet launch',
            'Limits how much GSUSD the whole system can mint in one block. Zero disables it, as at launch; governance can arm it through the timelock.',
          ],
          [
            <strong>Origination fee</strong>,
            '0.05% at deploy (maximum 1%)',
            'Taken from the GSUSD you receive when minting: mint 10,000 and 9,995 reach your wallet while the vault owes 10,000. Governance may change it within 0% to 1%.',
          ],
          [
            <strong>Stability fee</strong>,
            '2% APR nominal (about 2.02% realised)',
            'Minted debt accrues a per-second fee, so your debt grows over time until repaid. Governance can set it up to 50%.',
          ],
        ]}
      />
      <p>
        The 130% floor is the binding constraint in normal use: it limits how much GSUSD you can mint
        against a given amount of gold. Mainnet launches PAXG with no debt ceiling and no per-block
        mint cap; governance can set either later through the timelock, and where a ceiling is set,
        no further GSUSD can be minted against that collateral once its total debt reaches it. In
        force from the first block: the minimum debt, the bad-debt auto-pause, the silo custody
        distribution and the Stability Reserve&rsquo;s daily caps. Minting also needs a
        price: it is refused while PAXG&rsquo;s market feed sits more than 2% from the gold price
        (see <Link to="/docs/oracle">Oracle</Link>).
        {IS_MAINNET_BUILD ? null : ' Sepolia runs the same open profile, with PAXG the only active collateral.'}
      </p>
      <Callout variant="note" title="Minted debt accrues the stability fee">
        <p>
          The moment you mint, your debt begins accruing the{' '}
          <Link to="/docs/stability-fee">stability fee</Link>, a per-second rate set at 2% APR
          nominal (about 2.02% realised, because it compounds every second). The fee is what you
          ultimately repay on top of the principal: on repayment the principal is burned and the fee
          portion is banked in the surplus buffer that absorbs bad debt. A vault left untouched therefore sees its debt creep upward
          and its collateral ratio drift downward over time.
        </p>
      </Callout>

      <h3>A typical mint</h3>
      <Steps
        steps={[
          {
            title: 'Deposit gold',
            detail:
              'Lock PAXG into your vault. With no debt, the vault is fully collateralised.',
          },
          {
            title: 'Choose an amount within 130%',
            detail:
              'Mint GSUSD up to the point where the ratio would reach 130%. In practice, mint less to keep a safety buffer well above the 110% liquidation ratio.',
          },
          {
            title: 'Receive GSUSD',
            detail:
              'GSUSD is issued to your wallet and matching debt is recorded against the vault. The debt now accrues the stability fee.',
          },
          {
            title: 'Repay to reclaim gold',
            detail: (
              <>
                Burn GSUSD (principal plus accrued fee) to reduce or clear the debt, then withdraw
                your collateral. Repaying more than the current debt is capped to a full close, and
                repayments stay open even while the vault is paused. See{' '}
                <Link to="/docs/vaults">vaults</Link> for the full lifecycle.
              </>
            ),
          },
        ]}
      />

      <h2>Swapping GSUSD for reserve gold</h2>
      <p>
        The Stability Swap is open to anyone holding GSUSD, not just vault owners. You hand over
        GSUSD and receive gold in return, valued at the <Link to="/docs/oracle">oracle</Link> price
        minus a utilisation spread. The oracle prices reserve gold at the higher of the PAXG market
        feed and the gold price, so it is never sold below either, and refuses swaps while PAXG
        sits more than 2% from gold. The swap is handled by the{' '}
        <Link to="/docs/contracts">GoldStabilityReserve</Link>, a separate contract that holds
        protocol-owned gold, PAXG at launch. It draws only on that reserve: no borrower&rsquo;s vault is
        ever touched, the reserve owes nothing and it never mints.
      </p>
      <Callout variant="warning" title="A swap returns gold, not fiat">
        <p>
          Swapping GSUSD does not pay out dollars. It returns <strong>protocol-owned gold</strong>,
          PAXG at launch, at the oracle gold price minus the spread. If you want US dollars, you
          would sell the gold token on the open market. The swap is available up to the
          reserve&rsquo;s capacity: each asset can release at most 20% of its day-start balance per
          day, governance can set a minimum reserve per asset that swaps cannot dip below, and when
          the reserve is empty it refuses until it is refilled.
        </p>
      </Callout>

      <h3>The utilisation spread</h3>
      <p>
        The swap is not free: it carries a spread that widens as the reserve thins, so gold becomes
        progressively more expensive to remove as defensive inventory becomes scarce. Coverage is
        the reserve&rsquo;s swappable gold value divided by circulating GSUSD, with the supply
        anchored over one day so a same-day burn cannot buy a cheaper tier. Gold of a paused,
        de-supported or frozen asset does not count, since nobody can swap it out. A swap pays the
        tier of the coverage it leaves behind, not the coverage before it, so a large swap that
        crosses a step pays the dearer tier; the swap page previews the tier your amount will pay.
        The spread steps as follows:
      </p>
      <DocTable
        head={['Reserve coverage', 'Spread']}
        rows={[
          ['At least 15%', '0.50%'],
          ['At least 10%', '0.50%'],
          ['At least 5%', '0.75%'],
          ['At least 2%', '1.25%'],
          ['Below 2%', '2%'],
        ]}
      />
      <p>
        Governance can retune the curve through the timelock, but the spread is bounded: it never
        drops below 0.5% and never exceeds 5%. The spread is protocol revenue and routes to the
        surplus buffer. The GSUSD the reserve takes in is not revenue, because gold of equal value
        left with the swapper; it stays in the reserve&rsquo;s inventory and is never burned.
      </p>
      <Callout variant="tip" title="Bound your slippage with minGoldOut">
        <p>
          Because the spread and the oracle price both move, a swap you submit could settle for less
          gold than you saw a moment earlier. To protect against this, you pass a{' '}
          <code>minGoldOut</code> bound with each swap: if the gold owed at execution is below your
          minimum, the swap reverts rather than filling at a worse rate. It is the same slippage
          tolerance you would set on any swap.
        </p>
      </Callout>

      <h3>A typical swap</h3>
      <Steps
        steps={[
          {
            title: 'Hold GSUSD',
            detail:
              'You do not need a vault to swap. Anyone holding GSUSD can exchange it for reserve gold.',
          },
          {
            title: 'Check the quote',
            detail:
              'The reserve quotes the oracle price minus the current spread. The spread depends on reserve coverage, and the reserves page shows the live figure alongside remaining daily capacity.',
          },
          {
            title: 'Set minGoldOut',
            detail:
              'Choose the least gold you will accept. If the oracle price or the spread moves against you before execution, the swap reverts instead of filling below your bound.',
          },
          {
            title: 'Receive reserve gold',
            detail:
              'The GoldStabilityReserve takes your GSUSD into its inventory and pays out gold (PAXG at launch) from protocol-owned holdings. Rounding always favours the protocol, so you receive the conservative amount.',
          },
        ]}
      />

      <h2>The reserve floor and peg arbitrage</h2>
      <p>
        The Stability Swap is more than a convenience: it is one of Gold Standard&rsquo;s three peg
        mechanisms and the source of a <strong>floor under GSUSD</strong>. Because anyone can swap
        one GSUSD for a dollar of protocol-owned gold minus the spread, GSUSD does not trade far
        below that quote for long. The floor is one spread-width under par, not exactly a dollar:
        the spread is the arbitrageur&rsquo;s margin, and it widens as the reserve thins.
      </p>
      <p>
        The discipline comes from arbitrage. Suppose GSUSD trades on the open market below the
        reserve&rsquo;s quote. An arbitrageur buys the cheap GSUSD, swaps it for gold worth more
        than they paid and pockets the difference. That buying pressure pushes the market price of
        GSUSD back up until the gap closes to within the spread. No borrower&rsquo;s position moves
        at any point: the gold comes from the reserve, and the reserve owes nothing.
      </p>
      <p>
        The floor is exactly as deep as the reserve. There is only as much immediate conversion
        capacity as the reserve holds; once it is exhausted the guaranteed swap stops until the
        reserve is refilled. Anyone can seed the reserve with gold, and 40% of the protocol&rsquo;s
        share of every liquidation penalty tops it up over time.
        The reserve&rsquo;s live holdings and coverage are shown on the{' '}
        <Link to="/transparency">reserves page</Link>.
      </p>
      <p>
        Above a dollar the ceiling comes from borrowers, not the reserve. When GSUSD trades at a
        premium, a gold holder locks collateral, mints GSUSD, less the 0.05% origination fee, and sells it into the premium,
        keeping the gold exposure they wanted anyway. New supply requires collateral, so GSUSD may
        sit modestly above a dollar for longer during a demand spike. The reserve never mints.
      </p>
      <p>
        The Stability Reserve works alongside the other two peg mechanisms,{' '}
        <Link to="/docs/liquidations">over-collateralisation and liquidation</Link>, and the{' '}
        <Link to="/docs/stability-fee">stability fee and surplus buffer</Link>, to keep GSUSD anchored
        to physical gold. The full picture is in <Link to="/docs/peg-stability">peg stability</Link>.
      </p>

      <Callout variant="danger" title={IS_MAINNET_BUILD ? 'Experimental software' : 'Experimental software, pre-launch'}>
        <p>
          {IS_MAINNET_BUILD
            ? 'Gold Standard runs on Ethereum mainnet and its contracts are open source, so anyone can read and verify them.'
            : 'Gold Standard is pre-launch and its contracts are open source, so anyone can read and verify them.'}{' '}
          The Stability Swap interacts with live oracle prices and protocol-owned
          gold; small swaps can be exposed to MEV, and all on-chain activity carries smart-contract
          risk.
          Nothing here is financial advice.
        </p>
      </Callout>

      <hr />
      <p>
        Continue with <Link to="/docs/peg-stability">peg stability</Link> to see how the three
        mechanisms combine, revisit <Link to="/docs/vaults">vaults</Link> for the borrowing side, or
        read how the <Link to="/docs/oracle">oracle</Link> prices gold for both minting and
        swapping.
      </p>
    </Prose>
  );
}
