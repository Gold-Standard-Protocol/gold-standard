import { Link } from 'react-router-dom';
import { FAQ } from '../../content/site';
import { Callout, Lead, Prose } from '../components/DocComponents';
import { IS_MAINNET_BUILD } from '../../lib/network';

/**
 * Questions the shared list answers briefly for the landing page and this page answers in
 * full further down; listing both put the same heading twice on one page.
 */
const ANSWERED_IN_FULL_BELOW = new Set(['What happens if the gold price falls?']);

export default function FaqPage() {
  return (
    <Prose>
      <Lead>
        Straight answers about Gold Standard and GSUSD, Gold Standard Dollar, a stablecoin
        over-collateralised by tokenised gold. Where a question deserves a fuller treatment, each answer
        links to the relevant page.
      </Lead>

      <h2>The basics</h2>

      {FAQ.filter((item) => !ANSWERED_IN_FULL_BELOW.has(item.question)).map((item) => (
        <div key={item.question}>
          <h3>{item.question}</h3>
          <p>{item.answer}</p>
        </div>
      ))}

      <h3>Why is it called Gold Standard?</h3>
      <p>
        Under the gold standard a currency was backed by gold and could be exchanged for it.
        Britain ran its money that way for most of the nineteenth century, and the dollar kept a
        link to gold until the United States closed the gold window in 1971. Gold Standard
        Protocol brings that idea back on-chain: a dollar whose value rests on gold you can verify
        rather than on a promise you cannot. The token itself is <strong>GSUSD</strong>, the Gold
        Standard Dollar.
      </p>

      <h3>Is GSUSD the same as &ldquo;gold standard&rdquo; meaning high quality?</h3>
      <p>
        No. &ldquo;Gold Standard Dollar&rdquo; is literal, not a quality claim. GSUSD is a
        dollar-denominated stablecoin <strong>backed by tokenised gold</strong>. Every unit is
        minted against tokenised gold held in over-collateralised vaults. The name reflects the
        backing asset, not a marketing grade. It is not a claim on a bank or a high-quality dollar
        deposit; it is gold-collateralised, and that backing is visible on-chain at all times.
      </p>

      <h2>How it works</h2>

      <h3>How is this different from holding PAXG or XAUT directly?</h3>
      <p>
        PAXG <em>is</em> the collateral Gold Standard uses at launch, and XAUT can join it once
        activated. Each is a token claim on a troy ounce of allocated London Good Delivery gold. Holding them directly gives you gold
        exposure. GSUSD is different: it is a <strong>dollar-stable</strong> unit you mint against
        that gold, so you can keep the upside of your gold while spending or saving in a
        dollar-denominated asset. You can always repay to release your own gold, or swap GSUSD for
        protocol-owned gold from the Stability Reserve at the oracle price minus a spread. See{' '}
        <Link to="/docs/why-gold-standard">why Gold Standard</Link> and{' '}
        <Link to="/docs/collateral">collateral</Link>.
      </p>

      <h3>What fees are there?</h3>
      <p>
        Three, all documented in <Link to="/docs/parameters">parameters</Link>. A{' '}
        <strong>stability fee</strong> (2% APR nominal per collateral, about 2.02% realised with
        per-second compounding) accrues on outstanding debt and funds the surplus buffer. See{' '}
        <Link to="/docs/stability-fee">the stability fee</Link>. An{' '}
        <strong>origination fee</strong> of 0.05% is taken from the GSUSD each mint delivers, while
        the debt is the full amount minted; governance may set it no higher than 1%. A{' '}
        <strong>stability swap spread</strong> (0.5% to 2% at deploy, bounded between 0.5% and 5%)
        applies when you swap GSUSD for reserve gold; it rises as the reserve thins, and callers
        set a <code>minGoldOut</code> slippage bound. Liquidations carry a 5% penalty, paid by the
        liquidated vault, not by ordinary users. There is no deposit fee and no fee to repay.
      </p>

      <h3>What happens if the gold price falls?</h3>
      <p>
        A vault needs at least 130% collateral to mint, so a fall in gold first eats into your
        own buffer, not the peg. If a vault drops below the 110% liquidation ratio, anyone can
        repay its debt, and the vault gives up gold worth that debt plus the 5% penalty, of which
        the liquidator keeps three fifths and the protocol the rest, restoring solvency; you
        keep the GSUSD you minted and whatever gold remains. Behind that, the
        surplus buffer absorbs residual bad debt as far as its balance allows, and if bad debt beyond
        the buffer exceeds a governance-set threshold (25,000 GSUSD at deploy) the vault pauses
        itself; that pause lapses after 14 days unless it is renewed, or governance lifts it early. A sudden gold crash of more than 50% within minutes is the genuine tail risk. See{' '}
        <Link to="/docs/liquidations">liquidations</Link> and{' '}
        <Link to="/docs/security">security</Link>.
      </p>

      <h3>What if Chainlink or Paxos fails?</h3>
      <p>
        The system is designed so that any single failure stops it rather than drains it. PAXG is
        priced from Chainlink PAXG/USD, checked against the Chainlink XAU/USD gold price. If either
        feed goes stale, the <Link to="/docs/oracle">oracle</Link> refuses that token: minting,
        reserve swaps and liquidation wait until both answer again, while repaying and depositing
        never need a price. Liquidation resumes by itself, with no call or keeper step. The
        guardian can freeze one token or pause the oracle instantly. Emergency liquidation keeps
        working through a pause at the normal liquidation price, except in a token the guardian has
        frozen, and refuses when either feed has stopped, so positions can be de-risked but not drained on a stale price. If PAXG alone
        trades away from gold, borrowing and reserve swaps stop while it is more than 2% off, and
        liquidation values PAXG at no less than gold, so a depeg specific to PAXG is not
        liquidated and GSUSD holders carry that risk. If Paxos were to freeze collateral, the{' '}
        <Link to="/docs/collateral">collateral silos</Link> shard custody across many addresses to
        raise the cost of a freeze; activating XAUT later would add a second issuer. Neither
        control eliminates counterparty risk. Read{' '}
        <Link to="/docs/security">security</Link> for the honest limits.
      </p>

      <h2>Status and trust</h2>

      {/* A question about the testnet period, asked only there. */}
      {IS_MAINNET_BUILD ? null : (
        <>
          <h3>What is the difference between now and launch?</h3>
          <p>
            Right now Gold Standard is <strong>pre-launch</strong>. The contracts are written and open source
            but not yet deployed to Ethereum mainnet, and the app runs on
            the Sepolia test network. The launch procedure is rehearsed there and on a fork of mainnet
            before the mainnet ceremony.
            At launch the contracts deploy to mainnet, the addresses are published on{' '}
            <Link to="/docs/contracts">contracts</Link> and <Link to="/transparency">reserves</Link>,
            and minting opens on PAXG with no debt ceiling and no per-block mint cap. XAUT is
            registered but inactive until it meets published activation criteria. The minimum debt,
            the bad-debt auto-pause and the Stability Reserve&rsquo;s daily caps apply from the first
            block, and the oracle bounds what a manipulated price can extract: borrowing never prices
            above gold and liquidation never prices below it. The Sepolia deployment runs the same
            open launch profile. The stability pool is live from launch.
          </p>
        </>
      )}

      <h3>Who controls the protocol?</h3>
      <p>
        After the launch ceremony, control of every contract passes irreversibly to a timelock whose
        delay starts at 48 hours; every parameter change waits out the delay in force in public, and
        so does any change to the delay itself. A guardian multisig can
        pause the vault, the oracle, the stability pool and individual reserve assets instantly in
        an emergency but cannot move funds, change parameters or unpause. Only governance can
        unpause early. A pause on the vault, oracle, stability pool or a reserve asset lapses after
        14 days unless the guardian or governance extends it, and a vault with no debt can withdraw
        during any pause, so your gold is never locked by a lost key.
        {IS_MAINNET_BUILD ? null : ' The Sepolia deployment is arranged the same way, with the handover made.'}{' '}
        See <Link to="/docs/governance">governance</Link>.
      </p>

      <h3>Is this custodial? Can you freeze my funds?</h3>
      <p>
        It is non-custodial. Your collateral sits in open-source contracts that release it only to you, or
        to a liquidator if your vault falls below the 110% liquidation ratio, and Gold Standard never takes custody of your gold or your GSUSD. The protocol cannot seize a
        healthy vault. The one external custody risk is the underlying gold token itself: PAXG is
        issued by Paxos (and XAUT, once activated, by Tether), and each issuer retains freeze
        powers over its own token. The{' '}
        <Link to="/docs/collateral">silo design</Link> is built to raise the cost of that, but it is
        a real residual risk.
      </p>

      <h3>Where can I check the backing myself?</h3>
      <p>
        On the <Link to="/transparency">reserves page</Link>, which reads gold collateral and GSUSD
        supply straight from the contracts so you can confirm the system is over-collateralised
        block by block. The contract addresses are listed on{' '}
        <Link to="/docs/contracts">contracts</Link>.
      </p>

      <Callout variant="danger" title="Not financial advice">
        <p>
          Gold Standard is experimental{IS_MAINNET_BUILD ? '' : ', pre-launch'} software. Smart-contract risk, oracle
          risk, gold-custody risk and regulatory risk are all real and described candidly in our{' '}
          <Link to="/docs/security">security</Link> documentation. Nothing here is financial advice;
          only commit what you can afford to lose.
        </p>
      </Callout>

      <h2>Still have a question?</h2>
      <p>
        Start with <Link to="/docs/getting-started">getting started</Link> for a guided walkthrough,
        <Link to="/docs/glossary"> the glossary</Link> for unfamiliar terms, or{' '}
        <Link to="/docs/introduction">the introduction</Link> for the full picture.
      </p>
    </Prose>
  );
}
