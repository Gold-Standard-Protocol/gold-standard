import { Link } from 'react-router-dom';
import {
  ClockIcon,
  ArrowsRightLeftIcon,
  ScaleIcon,
  CheckBadgeIcon,
} from '@heroicons/react/24/outline';
import { Callout, DocTable, FeatureGrid, Lead, Prose } from '../components/DocComponents';
import { IS_MAINNET_BUILD } from '../../lib/network';

export default function OraclePage() {
  return (
    <Prose>
      <Lead>
        Every mint, stability swap and liquidation depends on knowing the price of
        the gold behind it. The GoldOracle prices each collateral token from its
        own Chainlink market feed and checks that price against the Chainlink gold
        price. When either feed stops it refuses to serve a price for that token,
        because a faulty price is more dangerous than no price.
      </Lead>

      <h2>PAXG first</h2>
      <p>
        Mainnet launches with one collateral: <strong>Paxos Gold (PAXG)</strong>.
        Tether Gold (XAUT) is registered in the oracle but is otherwise inactive.
        It is not a vault collateral, not a Stability Reserve asset and not a
        stability pool token, so nothing in the protocol can mint against it,
        swap it out or liquidate it. On 28 October 2026 no source priced XAUT
        securely without an operator the protocol would have to run: there is no
        XAUT/USD push feed on Ethereum. XAUT is activated when it meets published
        criteria, not on a date; see <a href="#activating-xaut">Activating XAUT</a> below.
      </p>

      <h2>Two sources</h2>
      <p>
        PAXG is priced from two Chainlink feeds and nothing else. A feed is{' '}
        <strong>healthy</strong> when its read passes the validation below; a feed that fails it
        counts as stopped rather than as a price.
      </p>
      <DocTable
        head={['Source', 'What it is', 'Its job']}
        rows={[
          [
            'C, the market feed',
            <>
              Chainlink PAXG/USD, <code>0x9944D86CEB9160aF5C5feB251FD671923323f8C3</code>, 24 hour
              heartbeat and 0.5% deviation trigger
            </>,
            'The timely market price of the token.',
          ],
          [
            'G, the gold reference',
            <>
              Chainlink XAU/USD, <code>0x214eD9Da11D2fbe465a6fc601a91E62EbEc1a0D6</code>, 24 hour
              heartbeat and 0.3% deviation trigger
            </>,
            'What gold itself is worth. Every rule measures the market feed against it, and it bounds every price the oracle serves.',
          ],
        ]}
      />
      <p>
        The oracle refuses to register a market feed that is the gold reference, so the check
        against gold can never compare a feed with itself.
        {IS_MAINNET_BUILD
          ? null
          : ' On Sepolia the feeds are team-controlled mocks kept in line with the market gold price.'}
      </p>

      <h2>The validation every source passes</h2>
      <FeatureGrid
        features={[
          {
            icon: ClockIcon,
            title: 'Staleness threshold',
            detail:
              'A price older than the staleness window is rejected. The window is 90,000 seconds (25 hours), covering the feeds’ 24 hour heartbeat, and governance can tune it between 300 and 90,000 seconds.',
          },
          {
            icon: CheckBadgeIcon,
            title: 'Full-round validity',
            detail:
              'The answer must be above zero, the round complete, answeredInRound no earlier than roundId and the timestamp no later than the current block. The oracle never infers a price from a half-reported update.',
          },
          {
            icon: ScaleIcon,
            title: 'The gold band g',
            detail:
              'Borrowing and reserve swaps need the market feed within 2% of the gold price (goldBandPpm; governance can set 0.5% to 10% per token through the timelock). Sampled every 30 minutes over 60 days, the widest gap between PAXG and gold was 0.84%; read update by update it reached 1.07% once.',
          },
          {
            icon: ArrowsRightLeftIcon,
            title: 'The liquidation cap m',
            detail:
              'Liquidation never values collateral more than 2% above the gold price (liquidationClampPpm; governance can set 0.5% to 5% per token through the timelock).',
          },
        ]}
      />
      <p>
        Every feed must report <strong>8 decimals</strong>, the Chainlink convention, and the
        oracle enforces that at registration so a misconfigured feed cannot be substituted. The
        staleness window covers the 24 hour heartbeat of the mainnet feeds, which on a quiet day
        update only when the heartbeat fires; a tighter window would halt the protocol on those
        days. Both feeds are deviation-triggered, so they update fastest exactly when the price
        moves. Both widths are measured against gold and change only through the 48 hour
        timelock; nothing adjusts them in response to monitoring.
      </p>
      <p>
        The gold market closes over the weekend while PAXG keeps trading, so the gold price stands
        still until it reopens. Minting, withdrawing against debt and reserve swaps are refused
        while PAXG sits more than 2% from that last gold price, and a weekend fall in PAXG alone
        does not reach liquidation until gold reprices.
      </p>

      <h2>Liquidation</h2>
      <p>
        Liquidation reads one price, <code>getTokenPrice</code>, both to decide whether a vault
        can be liquidated and to size the seizure. With C and G both healthy it is the higher of
        the market feed and gold, capped at the liquidation cap above gold:
      </p>
      <p>
        <strong>liquidation price = min(max(C, G), G × (1 + m))</strong>
      </p>
      <DocTable
        head={['When', 'Price', 'Why']}
        rows={[
          [
            'C and G healthy, C at or below gold',
            'G',
            'A push of the market feed down values collateral at gold at worst, never below, so it cannot make a healthy vault seizable.',
          ],
          [
            'C and G healthy, C above gold',
            'C, capped at G × (1 + m)',
            'A push of the market feed up can hold off a liquidation by at most m, 2% at launch.',
          ],
          [
            'C or G unhealthy',
            'Refused, "No reliable price"',
            'Nothing stands in for either feed, so no seizure is ever priced on a stale or gold only valuation.',
          ],
        ]}
      />
      <p>
        A fall in gold itself is followed at once, because gold moves G and PAXG together.
        Liquidation is never refused for the market feed being off the gold band, and when a
        stopped feed answers again liquidation resumes on the next healthy pair by itself: no
        call, role or keeper step is needed. The cap stays under the 10% a 110% liquidation
        ratio leaves above par, so a vault under water at gold is always liquidatable however
        far the market feed is pushed up.
      </p>
      <Callout variant="warning" title="A depeg specific to PAXG is not liquidated">
        While gold holds, liquidation values PAXG at gold even if PAXG itself trades below it. A
        depeg specific to PAXG is therefore never liquidated; GSUSD holders carry that risk, a
        trade-off the protocol owner has accepted so that no market feed pushed down can seize
        a healthy vault. Borrowing and reserve swaps stop while PAXG sits off the gold band, so
        nobody can mint against or buy reserve gold at a depegged price.
      </Callout>
      <p>
        Every successful state-changing read records the liquidation price as the
        token&rsquo;s <code>lastKnownPrice</code>. It feeds the vault&rsquo;s views and never
        prices a seizure.
      </p>

      <h2>Borrowing</h2>
      <p>
        Minting and withdrawing collateral against debt read <code>getBorrowPrice</code>, which is
        stricter. It needs C and G both healthy and C within the gold band, and it prices at the
        lower of the two. Off the gold band borrowing is refused with &ldquo;Off gold
        band&rdquo;, and with either feed unhealthy with &ldquo;No reliable price&rdquo;.
        Over-borrowing would therefore need the gold price itself pushed up.
      </p>

      <h2>Reserve swaps and coverage</h2>
      <p>
        The Stability Reserve sells gold through <code>getReservePrice</code>, never the
        liquidation price. It has the same gate as borrowing, C and G healthy and C within the
        gold band, and prices at the higher of the two, so reserve gold is never sold below gold
        or below the market. A depeg specific to the token stops its swaps.
      </p>
      <p>
        The reserve values its holdings for coverage through <code>quoteValuationPrice</code>:
        the lower of C and G while both are healthy, inside the band or not. When either feed is
        unhealthy it answers zero and the token is left out of coverage, which can only raise the
        swap spread, never lower it.
      </p>

      <h2>What a refusal stops</h2>
      <p>
        A refusal is per token and stops only what needs a price. The protocol prioritises safety
        over availability, and the behaviour is deliberately asymmetric.
      </p>
      <DocTable
        head={['Operation', 'What happens']}
        rows={[
          [
            'Mint and withdraw against debt',
            'Refused while either feed is unhealthy ("No reliable price") or the market feed is off the gold band ("Off gold band").',
          ],
          [
            'Reserve swaps',
            'Refused exactly as borrowing is.',
          ],
          [
            'Liquidation',
            'Refused only while either feed is unhealthy ("No reliable price"), never for being off the band.',
          ],
          [
            'Repay, deposit collateral and withdraw from a vault with no debt',
            'Always open. None of them reads a price, so a borrower can always reduce risk.',
          ],
          [
            'Read-only queries',
            'quoteTokenPrice, quoteBorrowPrice and quoteReservePrice answer exactly as the three reads would, with the same reasons, without writing anything. getValidatedPrice returns the market feed with an ok flag instead of reverting, and getLastKnownPrice the last recorded liquidation price.',
          ],
        ]}
      />
      <h2>Freezing and pausing</h2>
      <p>
        There is no permissionless circuit breaker: a trip anyone could call would also be a way
        to stall the protocol. The emergency controls belong to named roles.
      </p>
      <ul>
        <li>
          <strong>Freezing one token.</strong> The guardian, or governance, can call{' '}
          <code>freezeToken(token)</code> with no timelock as a manual emergency stop. While a
          token is frozen its reads revert with &ldquo;Token frozen&rdquo;, and so does its
          emergency liquidation, during a pause as well; other tokens are unaffected. A freeze lapses after
          14 days; calling <code>freezeToken</code> again extends it to 14 days from then, so a
          live guardian can hold a genuine incident and a lost one cannot strand the token. Each
          call takes a new freeze number, <code>freezeEpoch(token)</code>.{' '}
          <code>guardianUnfreezeToken(token, freezeEpoch(token))</code> lifts the freeze early only
          once a normal
          read would succeed, and records that price, while paused too. The guardian chooses the
          timing, never the value.
        </li>
        <li>
          <strong>Pausing the oracle.</strong> The guardian can <code>emergencyPause</code> the
          whole oracle instantly. It cannot move funds, change parameters or unpause; a pause
          lapses after 14 days and anyone may then lift it, and only governance can unpause
          early.
        </li>
        <li>
          <strong>Re-anchoring.</strong> Governance (<code>resyncLastKnownPrice</code>) and the
          guardian (<code>guardianResyncLastKnownPrice</code>) can record the liquidation price a
          normal read gives now as the last known price. Both are bounded to the rules above and
          cannot set an arbitrary value.
        </li>
      </ul>
      <p>
        During a pause, liquidation continues through the emergency path, which is open only
        while the vault or the oracle is paused. It uses the normal liquidation price and nothing
        else: when either feed is unhealthy it refuses with &ldquo;No price&rdquo;, so a pause
        never liquidates on a stale record, a stale market feed or gold alone, and the last known
        price never prices a seizure. A frozen token is not liquidated at all (&ldquo;Token
        frozen&rdquo;), pause or no pause, until the freeze lifts or lapses.
      </p>
      <Callout variant="tip" title="Fail safe, recover deliberately">
        The oracle stops on its own whenever its sources stop supporting a price, and resumes on
        its own when they do. Nobody can make it serve a price the rules do not give: not the
        guardian, not governance through a re-anchor, not a keeper.
      </Callout>

      <h2 id="activating-xaut">Activating XAUT</h2>
      <p>
        XAUT will be priced the way PAXG is: its own market feed and the same gold reference
        under the same rules. It is activated when it meets published criteria, measured over at
        least 90 consecutive days:
      </p>
      <ul>
        <li>
          <strong>Market depth.</strong> XAUT trades deeply enough on chain that liquidators can
          sell seized collateral at the intended initial ceiling.
        </li>
        <li>
          <strong>Manipulation cost.</strong> Pushing the market feed by the gold band and holding
          it costs at least three times what an attacker could extract at the intended initial
          ceiling.
        </li>
        <li>
          <strong>Oracle resilience.</strong> A push feed with independent operators, a heartbeat
          of 24 hours or less and a deviation trigger of 0.5% or less, live and accurate for the
          whole period.
        </li>
        <li>
          <strong>Stressed liquidation.</strong> A 30% gold crash clears on a mainnet fork, the
          loss a 30% XAUT depeg would leave with GSUSD holders is recorded, an issuer freeze of a
          silo is rehearsed and a feed outage refuses every priced path for XAUT instead of
          repeating a stale price.
        </li>
      </ul>
      <p>
        Activation is one governance batch through the 48 hour timelock against the deployed
        contracts: point XAUT&rsquo;s oracle entry at its market feed, add it as a collateral type
        with its own ceiling, add it to the stability pool and, only after 30 days of clean
        pricing, list it on the Stability Reserve. GSUSD is not redeployed and PAXG positions are
        untouched: each token&rsquo;s price, freeze and liquidation state are isolated. Adding a
        collateral type cannot be undone: the token can be frozen in the oracle and its debt
        ceiling lowered, but not removed, which is why it waits for the evidence.
      </p>

      <h2>Trust assumptions and honest caveats</h2>
      <p>
        The oracle is one of the protocol&rsquo;s core trust roots. Gold Standard inherits the integrity of
        the two Chainlink feeds it reads. The rules defend against staleness, incomplete rounds,
        a market feed pushed down (valued at gold at worst), a market feed pushed up (at most the
        liquidation cap) and a feed that drifts from gold, and they ensure that an oracle failure
        halts pricing rather than draining the system. They cannot detect a sustained,
        internally consistent manipulation of gold itself. PAXG launches with no debt ceiling, so
        the gold band on borrowing and the liquidation cap, rather than a ceiling, bound what a
        manipulated price can extract: see <Link to="/docs/parameters">Parameters</Link>.
      </p>
      <Callout variant="danger" title="Oracle integrity is a trust assumption">
        If the sources Gold Standard relies on were corrupted in a coordinated, consistent way, the
        checks could be satisfied by wrong data. Checking the market feed against gold is the
        mitigation, not an elimination of the risk. A depeg specific to PAXG is not liquidated
        while gold holds, and an outage of either feed stops every priced path for the token
        until both answer again.{' '}
        {IS_MAINNET_BUILD ? null : <>Gold Standard is pre-launch on the Sepolia testnet.{' '}</>}
        See{' '}
        <Link to="/docs/security">Security and risks</Link> for the full set of residual risks.
      </Callout>
    </Prose>
  );
}
