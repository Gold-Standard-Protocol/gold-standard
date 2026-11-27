import { Link } from 'react-router-dom';
import {
  ArrowTrendingDownIcon,
  ArrowTrendingUpIcon,
  ScaleIcon,
} from '@heroicons/react/24/outline';
import { Callout, FeatureGrid, Lead, Prose } from '../components/DocComponents';
import { IS_MAINNET_BUILD } from '../../lib/network';

export default function PegStabilityPage() {
  return (
    <Prose>
      <Lead>
        GSUSD (Gold Standard Dollar) is an ERC-20 stablecoin over-collateralised by
        physical gold held in tokenised form. It does not hold its value through
        a promise or a discretionary market maker. Instead three independent
        forces, each rooted in on-chain incentives, pull the price back towards
        its target whenever it drifts above or below.
      </Lead>

      <h2>The target and the three forces</h2>
      <p>
        GSUSD is minted against gold collateral worth more than the debt it
        backs. The protocol does not defend a fixed
        exchange rate by intervention. It defends a fair value, and it makes
        deviating from that fair value unprofitable for everyone who can act on
        it. Three mechanisms work together:
      </p>

      <FeatureGrid
        features={[
          {
            icon: ScaleIcon,
            title: 'Over-collateralisation and liquidation',
            detail:
              'A vault needs at least 130% collateral against its debt to mint or withdraw, and positions that fall below the 110% liquidation ratio are repaid and seized by liquidators. This is what keeps the system solvent in ordinary markets; a fall that outruns liquidators can still leave bad debt.',
          },
          {
            icon: ArrowTrendingDownIcon,
            title: 'Stability swap',
            detail:
              'Anyone can swap GSUSD for protocol-owned gold at the oracle price minus a spread. That puts a floor under the price, one spread-width below par and exactly as deep as the reserve. No borrower’s vault is ever involved.',
          },
          {
            icon: ArrowTrendingUpIcon,
            title: 'Stability fee',
            detail:
              'A per-second fee on outstanding debt funds a surplus buffer that absorbs bad debt, and gives governance a lever to discourage excess minting when GSUSD trades soft.',
          },
        ]}
      />

      <h2>Force one: over-collateralisation and liquidation</h2>
      <p>
        Every position, called a vault, must deposit more gold collateral than
        the GSUSD it mints. The minimum collateral ratio is{' '}
        <strong>130%</strong>: to mint 100 GSUSD a vault must hold at least 130
        dollars of gold. As the gold price moves, a vault that drifts down
        towards the <strong>110% liquidation ratio</strong> becomes eligible for
        liquidation, at which point anyone can repay its debt and seize its
        collateral at a discount.
      </p>
      <p>
        This is what keeps the protocol solvent. Because debt is created against a surplus of collateral, the aggregate gold backing the supply normally exceeds the aggregate GSUSD in circulation. The liquidation machinery removes positions before they become undercollateralised, so the protocol does not usually accumulate debt it cannot cover; a fall fast enough to outrun liquidators is the exception, and the surplus buffer and the bad debt rules exist for it. A liquidation applies a{' '}
        <strong>5% penalty</strong>, of which liquidators keep a{' '}
        <strong>60% share</strong> and the protocol retains the remaining 40%,
        split 40% to the Stability Reserve as swappable gold and 60% to the
        surplus buffer. The full mechanics are described in{' '}
        <Link to="/docs/liquidations">Liquidations</Link>.
      </p>
      <Callout variant="note" title="Solvency before price">
        Over-collateralisation does not directly hold the market price at a
        dollar. What it guarantees is that the collateral exists. That guarantee
        is the foundation the other two forces stand on: every GSUSD the
        reserve takes in is itself backed by a borrower&rsquo;s over-collateralised
        gold.
      </Callout>

      <h2>Force two: the Stability Reserve</h2>
      <p>
        The Stability Reserve is the mechanism that turns solvency into a price
        floor. Through the GoldStabilityReserve contract, anyone can swap GSUSD
        for protocol-owned gold valued at the oracle price, minus a{' '}
        <Link to="/docs/minting-redeeming">coverage-based spread</Link>. The
        spread steps with coverage, meaning the value of swappable gold over
        the circulating GSUSD supply: 0.5% at 10% coverage or more, 0.75% at
        5%, 1.25% at 2% and 2% below that, and it can never be set below 0.5%
        or above 5%. Gold therefore becomes progressively more expensive to
        remove as the reserve thins. The supply figure is anchored over one
        day, so burning GSUSD cannot buy a cheaper tier the same day, and a
        swap pays the tier of the coverage it leaves behind, so splitting a
        large swap gains nothing. Gold of a paused, de-supported or frozen
        asset does not count as coverage. The GSUSD
        the reserve receives stays in its inventory and is never burned; the
        spread goes to the surplus buffer. The reserve is funded by
        permissionless seeding and by 40% of the protocol&rsquo;s
        liquidation-penalty share, and each asset is limited to 20% of its
        day-start balance in swaps per day. No borrower&rsquo;s vault is
        involved on either side of the swap: the reserve holds assets, owes
        nothing and never mints.
      </p>
      <p>
        Consider what happens when GSUSD trades below its fair value on the open
        market. An arbitrageur buys cheap GSUSD, swaps it with the reserve for
        gold worth (almost) a full dollar each and pockets the difference. That
        buying pressure pushes the market price back up. The spread sets the
        exact level of the floor: GSUSD cannot trade more than the prevailing
        spread below a dollar without handing a risk-free profit to whoever
        swaps. The floor is enforced by a quote the reserve must honour, and it
        is exactly as deep as the reserve. When the reserve is empty the swap
        refuses and there is no floor until it is refilled, which is why the
        reserve&rsquo;s holdings are published live on the{' '}
        <Link to="/transparency">reserves page</Link>.
      </p>
      <Callout variant="tip" title="Swappers set their own slippage bound">
        Because the spread and the oracle price both move, every swap carries a{' '}
        <code>minGoldOut</code> bound. If the gold owed at execution falls below
        the bound, for example after a burst of swaps has widened the spread,
        the transaction reverts rather than executing at a worse rate than the
        caller accepted.
      </Callout>

      <h2>Force three: the stability fee and surplus buffer</h2>
      <p>
        The third force works on the supply side and on the protocol balance
        sheet. A <strong>stability fee</strong>, set per collateral type at 2%
        APR nominal (about 2.02% realised, because it compounds every second)
        and capped at 50%, accrues continuously against outstanding debt. It
        does two things. First, it is a cost of carrying GSUSD debt, which
        discourages minting beyond what demand supports. When GSUSD trades
        soft, governance can raise the fee to make new debt less attractive and
        tighten supply. Second, the fee is revenue: it flows into the{' '}
        <strong>SurplusBuffer</strong>, a reservoir of protocol-held GSUSD that
        also receives the reserve&rsquo;s swap spreads and its 60% slice of the
        protocol&rsquo;s penalty gold.
      </p>
      <p>
        The surplus buffer is the system's shock absorber. If a liquidation ever
        recovers less than the debt it was meant to cover, the resulting bad
        debt is absorbed by the buffer burning its held GSUSD, as far as its
        holdings allow, which protects the backing of every other unit in
        circulation. Any remainder is recorded as outstanding bad debt, the
        vault pauses itself once that figure passes a governance threshold and
        the balance is cleared once the buffer refills. The mechanics of
        accrual and the buffer are covered in full on the{' '}
        <Link to="/docs/stability-fee">Stability fee and surplus buffer</Link>{' '}
        page.
      </p>

      <h2>How the forces hold the peg in both directions</h2>
      <p>
        The peg holds because there is a profitable trade in each direction that
        pushes the price back towards fair value. The forces are complementary,
        not redundant: the reserve defends the downside, borrowers minting into
        a premium defend the upside and the buffer keeps the whole structure
        solvent through stress.
      </p>

      <h3>When GSUSD trades below fair value</h3>
      <p>
        The reserve floor activates. Arbitrageurs buy discounted GSUSD and swap
        it for protocol-owned gold at the oracle price less the spread,
        capturing the gap. Their buying removes the discount. The floor sits one
        spread-width below a dollar and holds to the depth of the reserve; the
        market cannot push the price meaningfully below it while the reserve
        has gold to quote. No borrower&rsquo;s vault is touched.
      </p>

      <h3>When GSUSD trades above fair value</h3>
      <p>
        Minting becomes attractive. A vault owner deposits gold, mints fresh
        GSUSD against their collateral, and sells it into the premium.
        The new supply meets the excess demand and brings the price back down.
        The costs are the 0.05% origination fee at the mint and the stability fee
        while the debt is open, so as long as the premium exceeds them, opening or expanding a vault to mint and
        sell is profitable. The <Link to="/docs/vaults">vault</Link> system is
        the supply valve on the upside. New supply requires collateral, so GSUSD
        may sit modestly above a dollar for longer during a demand spike; the
        reserve never mints to tighten the ceiling.
      </p>

      <Callout variant="note" title="Net effect">
        Below fair value, the Stability Reserve pays arbitrageurs to buy GSUSD
        and swap it for protocol-owned gold, lifting the price. Above fair value, low-cost minting pays vault owners
        to create and sell GSUSD, lowering the price. Over-collateralisation
        guarantees the gold backing both trades is real, and the surplus buffer
        absorbs the rare loss as far as its balance allows. No single
        actor or treasury has to be trusted to hold the line; the incentives do
        it.
      </Callout>

      <h2>Limits and honest caveats</h2>
      <p>
        These mechanisms are strong but not infinite. They depend on a trusted
        price feed: if the oracle reports a wrong gold price, swaps and
        liquidations execute against the wrong value, which is why the{' '}
        <Link to="/docs/oracle">oracle</Link> checks every market price against
        the Chainlink gold price, refuses when either feed has stopped and can
        be frozen per token or paused. They depend on reserve
        depth: the floor is exactly as deep as the Stability Reserve, and when
        the reserve is empty there is no floor until it is refilled. They depend
        on collateral
        liquidity: in an extreme, fast move where gold itself falls by more than
        50% in minutes, liquidations may not clear positions quickly enough and
        the buffer may be drawn down. And they depend on the underlying gold
        tokens remaining sound, which is a counterparty assumption discussed in{' '}
        <Link to="/docs/collateral">Collateral assets</Link>.
      </p>
      <Callout variant="danger" title="This is experimental software">
        {IS_MAINNET_BUILD ? null : <>Gold Standard is pre-launch, currently on the Sepolia testnet.{' '}</>}
        The peg mechanisms are designed to hold under normal and
        stressed conditions, but no stablecoin design eliminates tail risk.
        Nothing here is financial advice. See{' '}
        <Link to="/docs/security">Security and risks</Link> for the full risk
        picture.
      </Callout>
    </Prose>
  );
}
