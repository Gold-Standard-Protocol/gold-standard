import { Link } from 'react-router-dom';
import { Callout, DocTable, Lead, Prose, Steps } from '../components/DocComponents';
import { IS_MAINNET_BUILD } from '../../lib/network';

export default function LiquidationsPage() {
  return (
    <Prose>
      <Lead>
        Liquidation is the mechanism that keeps every unit of Gold Standard Dollar (GSUSD) over-collateralised
        by tokenised gold. When a vault becomes under-collateralised, anyone may repay its debt and
        seize its gold at a discount, restoring the protocol&rsquo;s backing before the position can
        turn into bad debt.
      </Lead>

      <h2>Why liquidations exist</h2>
      <p>
        GSUSD is over-collateralised: every <Link to="/docs/vaults">vault</Link> is required to hold
        more gold than the GSUSD it has minted. That backing is what gives the token its value. If a
        vault&rsquo;s collateral fell below its debt and nothing happened, the protocol would be
        holding less gold than the GSUSD outstanding, and the peg would weaken. Liquidation is the
        enforcement action that prevents this: it clears risky debt while the collateral is still
        worth more than the debt, so GSUSD stays over-collateralised.
      </p>
      <p>
        Liquidation is one of Gold Standard&rsquo;s three peg mechanisms, working alongside the{' '}
        <Link to="/docs/minting-redeeming">Stability Reserve floor</Link> and the{' '}
        <Link to="/docs/stability-fee">stability fee and surplus buffer</Link>. The combined picture
        is in <Link to="/docs/peg-stability">peg stability</Link>.
      </p>

      <h2>The liquidation trigger</h2>
      <p>
        A vault is liquidatable when its collateral ratio falls below the{' '}
        <strong>liquidation ratio of 110%</strong>. That is the point at which collateral value is
        only 1.1 times the debt, still above the debt, but with little margin left. The protocol
        deliberately sets the 110% liquidation ratio below the 130% minting floor: the gap between
        them is the buffer a healthy vault carries before it is ever at risk.
      </p>
      <Callout variant="note" title="From 130% to 110%">
        <p>
          You can only mint or withdraw while a vault is at or above 130%, but liquidation does not
          begin until 110%. A vault sitting just above 130% is safe from liquidation but has very
          little room; the further above 130% you keep it, the more the gold price would have to fall
          before liquidation becomes possible.
        </p>
      </Callout>

      <h2>The liquidation math, in words</h2>
      <p>
        When a vault crosses below 110%, a liquidator steps in and repays the vault&rsquo;s GSUSD
        debt. In return they receive gold collateral from the vault: the gold equivalent of the debt
        they repaid, <strong>plus a share of a penalty</strong> applied on top. The penalty is what
        makes liquidation profitable and so guarantees that someone will act.
      </p>
      <DocTable
        head={['Element', 'Value', 'Meaning']}
        rows={[
          [
            <strong>Liquidation penalty</strong>,
            '5%',
            'An extra charge on the liquidated debt, taken from the vault’s collateral on top of the debt-equivalent gold.',
          ],
          [
            <strong>Liquidator incentive share</strong>,
            '60%',
            'The portion of the 5% penalty paid to the liquidator as their reward for repaying the debt.',
          ],
          [
            <strong>Protocol share</strong>,
            '40%',
            'The remaining portion of the penalty, retained by the protocol: 40% of it is deposited in the Gold Stability Reserve as swappable gold and 60% goes to the surplus buffer.',
          ],
        ]}
      />
      <p>So, in plain terms, a liquidator who clears a vault receives:</p>
      <blockquote>
        <p>
          <strong>
            gold worth the repaid debt + 60% of the 5% penalty (the protocol keeps the other 40%)
          </strong>
        </p>
      </blockquote>
      <p>
        The penalty comes out of the liquidated vault&rsquo;s own collateral, which is why keeping
        clear of the 110% line matters for the owner: being liquidated is not free. The protocol&rsquo;s
        40% share of the penalty is split between the{' '}
        <Link to="/docs/minting-redeeming">Stability Reserve</Link> (40%), where it becomes gold
        that any holder can swap into, and the <Link to="/docs/contracts">surplus buffer</Link>{' '}
        (60%), building reserves that help absorb losses elsewhere. All amounts round in the
        protocol&rsquo;s favour.
      </p>

      <h3>Partial liquidations and thin collateral</h3>
      <p>
        A liquidator may repay part of a vault&rsquo;s debt rather than all of it, subject to two
        rules: the residual debt must stay at or above the minimum debt, and a partial
        repayment may not exhaust the collateral (a caller who wants everything passes the full
        debt). When collateral is thin, the penalty gives way before the debt: the seizure is capped
        at what the vault holds, the penalty is whatever remains above the debt&rsquo;s value, and
        only when the gold is worth less than the debt is the repayment capped at what the
        collateral covers. Any remainder is bad debt, handled below.
       Below 100% there is no penalty left to pay anyone, so the gold sells to the liquidator at a
        small governed discount (2% at launch) and the shortfall, discount included, is booked as bad
        debt for the surplus buffer to absorb. That discount is split like the penalty: 60% of it
        goes to the liquidator and 40% to the protocol, so a direct liquidator&rsquo;s margin on an
        underwater vault is at most 1.2% of the gold&rsquo;s value at launch, not 2%, and a pool
        liquidation pays its caller half of the liquidator share. The discount is never larger than the shortfall
        itself: the liquidator repays the greater of the gold&rsquo;s value less the discount and
        the gold&rsquo;s value less the shortfall, so a vault only just under water gives up a
        correspondingly small discount. Liquidators are paid straight from the collateral silos,
        so a freeze of the vault&rsquo;s own address cannot stop a liquidation.
      </p>

      <h3>Direct and pool-based liquidation</h3>
      <p>
        Liquidation can settle in two ways. In <strong>direct liquidation</strong>, the liquidator
        supplies the GSUSD to repay the debt themselves and takes the discounted gold. In{' '}
        <strong>pool liquidation</strong>, the <Link to="/docs/contracts">StabilityPool</Link>, a
        Liquity-style buffer of deposited GSUSD, repays the debt instead. The caller who triggers
        it needs no capital and earns a keeper bounty of 30% of the penalty (half the liquidator
        share), and the rest of the seized gold is credited to the pool&rsquo;s depositors. A pool
        liquidation requires the pool to hold strictly more GSUSD than the debt it absorbs; any
        residual can be cleared through the direct path.
      </p>

      <h2>Permissionless by design</h2>
      <p>
        Liquidation is open to anyone. There is no privileged liquidator, no whitelist and no
        permission to request: the instant a vault falls below 110%, any address, typically an
        automated keeper, can call the liquidation function, repay the debt and collect the
        discounted gold. Because anyone can act, the system does not depend on one operator staying solvent or awake. The protocol
        does not depend on a single actor to stay solvent; it relies on the standing incentive of the
        penalty to attract whoever is watching. Gold Standard runs its own reference keeper, which watches
        every vault for both the direct and the pool path, but nothing stops others competing with
        it.
      </p>
      <Callout variant="note" title="Open to keepers">
        <p>
          Liquidations are competitive and usually executed by automated keepers monitoring the
          oracle. If you want to participate, the{' '}
          <Link to="/vault/liquidate">liquidation console</Link> lists vaults that are at or near the
          threshold.
        </p>
      </Callout>

      <h3>Liquidation while the protocol is paused</h3>
      <p>
        Direct liquidation is blocked while the vault is paused, as are minting and withdrawal from
        a vault with debt; deposit and repay stay open, so an owner can still rescue a position. A
        separate <code>emergencyLiquidate</code> path works while the vault or the oracle is
        paused. It uses the oracle&rsquo;s normal liquidation price and nothing else: when either
        price feed is unhealthy it refuses, so a pause never liquidates on a stale record, a
        stale market feed or gold alone. The Stability Pool path also stays open while the vault
        or the oracle is paused, at the same price. A token the guardian has frozen is not liquidated by
        any path, during a pause as well, until the freeze is lifted or lapses after 14 days.
      </p>

      <h3>The liquidation price</h3>
      <p>
        One oracle price decides both whether a vault can be liquidated and how much gold the
        liquidation seizes. With the Chainlink PAXG/USD market feed (C) and the Chainlink
        XAU/USD gold price (G) both healthy, it is the higher of the two, capped 2% above gold:
        min(max(C, G), G × (1 + m)), where m is the liquidation cap. A gold crash is followed at
        once. A market feed pushed down values collateral at gold at worst, so it cannot make a
        healthy vault seizable, and a market feed pushed up can hold off a liquidation by at most
        the cap. Liquidation is never refused for the market feed being off the gold band.
      </p>
      <p>
        The trade-off is deliberate: a depeg specific to PAXG is not liquidated while gold holds,
        and GSUSD holders carry that risk. Borrowing and reserve swaps stop while PAXG sits off the
        gold band. Stability Pool depositors carry part of it too: a vault that falls under 110% at
        the gold price is still liquidated at the gold price, so during a PAXG depeg the pool pays
        the debt for gold worth less at market, about 7% of the absorbed debt at a 10% depeg.
      </p>

      <h3>When the oracle refuses a price</h3>
      <p>
        While either feed is unhealthy (stale, incomplete or not positive) the oracle refuses that
        token with &ldquo;No reliable price&rdquo; and its liquidations wait. They resume by
        themselves on the next healthy pair of readings, with no call, role or keeper step;
        repayment and deposits never wait on a price. See <Link to="/docs/oracle">Oracle</Link>{' '}
        for the full rules.
      </p>

      <h2>Bad debt and the surplus buffer</h2>
      <p>
        Liquidation normally happens while collateral still exceeds debt, so it leaves the protocol
        whole. But in a severe, fast move, for instance if the gold price gapped down faster than
        keepers could act, a vault&rsquo;s collateral could be exhausted before its debt is fully
        repaid. The shortfall is <strong>bad debt</strong>: GSUSD that is no longer fully backed by
        that vault&rsquo;s gold.
      </p>
      <p>
        Gold Standard socialises bad debt through the{' '}
        <Link to="/docs/contracts">surplus buffer</Link>. The buffer is the protocol&rsquo;s revenue
        reservoir, funded by the stability fee, the spread on Stability Reserve swaps and the
        buffer&rsquo;s 60% slice of the protocol&rsquo;s liquidation-penalty share. When bad debt
        arises, the buffer absorbs as much as it holds by burning GSUSD, cancelling the unbacked
        debt against accumulated protocol reserves. Any remainder is recorded on-chain as{' '}
        <code>totalBadDebt</code>; if that figure rises above the bad-debt pause threshold (25,000
        GSUSD at deploy) the vault pauses itself (or, if it is already paused, restarts that
        pause and its 14 day window under a new pause number), and once the buffer refills
        anyone may call{' '}
        <code>retryBadDebtAbsorption</code> to clear the balance. This is the third peg mechanism
        doing its job: the fee that vault owners pay over time is precisely what pays for the rare
        tail event. See <Link to="/docs/stability-fee">the stability fee</Link> for how the buffer
        is funded.
      </p>
      <Callout variant="danger" title="Tail-event risk">
        <p>
          Over-collateralisation, liquidation and the surplus buffer are strong defences but not
          absolute guarantees. A tail event, gold falling more than 50% in minutes, could outrun
          liquidators and exceed the buffer. Gold Standard is experimental{IS_MAINNET_BUILD ? '' : ', pre-launch'} software; its
          contracts are open source, so anyone can read and verify them. Nothing here is financial
          advice.
        </p>
      </Callout>

      <h2>How to avoid being liquidated</h2>
      <p>
        Liquidation is entirely avoidable. It only ever happens to vaults that have been allowed to
        drift below 110%, and a vault owner has full control over that ratio at all times.
      </p>
      <Steps
        steps={[
          {
            title: 'Keep your ratio high',
            detail:
              'Do not operate near 130%. Treat 200% or more as a healthy target so the gold price has room to move before you approach the 110% liquidation ratio.',
          },
          {
            title: 'Monitor your liquidation price',
            detail: (
              <>
                The <Link to="/docs/vaults">vault dashboard</Link> shows the gold price at which your
                position would hit 110%. Watch the gap between it and the current oracle price.
              </>
            ),
          },
          {
            title: 'Add collateral or repay early',
            detail:
              'If the gold price falls or the accruing stability fee erodes your margin, deposit more gold or repay GSUSD before the ratio approaches the threshold.',
          },
          {
            title: 'Remember the fee never sleeps',
            detail: (
              <>
                The <Link to="/docs/stability-fee">stability fee</Link> raises your debt every
                second, so an untouched vault drifts towards liquidation on its own. Check in
                periodically even when the gold price is stable.
              </>
            ),
          },
        ]}
      />
      <Callout variant="warning" title="The 130% floor is not a safe operating point">
        <p>
          The 130% minimum simply gates new minting and withdrawals; it is not where you should sit.
          A vault parked just above 130% can be pushed below the 110% liquidation ratio by a
          relatively modest fall in the gold price, and the loss includes the 5% penalty on top of
          your debt. Keep a generous buffer, watch your liquidation price and act early. See{' '}
          <Link to="/docs/vaults">vaults</Link> for how the four actions move your ratio.
        </p>
      </Callout>

      <hr />
      <p>
        Read on for the full set of <Link to="/docs/parameters">protocol parameters</Link> behind
        these numbers, or step back to <Link to="/docs/peg-stability">peg stability</Link> to see how
        liquidation fits with the Stability Reserve and the stability fee.
      </p>
    </Prose>
  );
}
