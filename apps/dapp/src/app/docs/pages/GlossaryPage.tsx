import { Link } from 'react-router-dom';
import { Callout, DocTable, Lead, Prose } from '../components/DocComponents';
import { IS_MAINNET_BUILD } from '../../lib/network';

export default function GlossaryPage() {
  return (
    <Prose>
      <Lead>
        Plain-language definitions of the terms used throughout the Gold Standard documentation, in
        alphabetical order. Where a concept has its own page, the term links to it.
      </Lead>

      <Callout variant="note" title="A quick orientation">
        <p>
          <strong>Gold Standard Protocol</strong> runs the contracts; <strong>GSUSD</strong> (Gold Standard
          Dollar) is the stablecoin it issues, backed by more gold than it puts into circulation. You lock tokenised gold in a vault, mint
          GSUSD against it and repay to get your gold back; any holder can also swap GSUSD for
          protocol-owned gold through the Stability Reserve. The terms below fill in the detail.
        </p>
      </Callout>

      <h2>A to C</h2>
      <DocTable
        label="Glossary, A to C"
        head={['Term', 'Meaning']}
        rows={[
          [
            'Bad debt',
            <>
              Debt left over when a liquidated vault&rsquo;s gold is worth less than what it owes.
              The surplus buffer absorbs it by burning held GSUSD; any remainder is recorded, and
              above a governance-set threshold (25,000 GSUSD at deploy) the vault pauses itself.
              That pause lapses after 14 days unless it is renewed, or governance lifts it early.
            </>,
          ],
          [
            'Collateral',
            <>
              The asset locked to back minted GSUSD. Gold Standard accepts tokenised gold:{' '}
              <strong>PAXG</strong> at launch, with <strong>XAUT</strong> registered and inactive
              until governance activates it. See <Link to="/docs/collateral">collateral</Link>.
            </>,
          ],
          [
            'Collateral ratio',
            <>
              The value of a vault&rsquo;s collateral divided by its debt, expressed as a
              percentage. A vault at 200% holds twice its debt in gold. Ratios are tracked to
              six decimals, where 1,000,000 equals 100%.
            </>,
          ],
          [
            'Collateral silo',
            <>
              An EIP-1167 minimal-proxy shard that holds a slice of the protocol&rsquo;s gold across
              many addresses, raising the cost of an issuer-side freeze. See{' '}
              <Link to="/docs/collateral">collateral</Link>.
            </>,
          ],
        ]}
      />

      <h2>D to L</h2>
      <DocTable
        label="Glossary, D to L"
        head={['Term', 'Meaning']}
        rows={[
          [
            'Debt ceiling',
            <>
              The maximum GSUSD that may be minted against a given collateral type, set by
              governance. Mainnet launches with none, so PAXG minting is bounded by the collateral
              ratio and the minimum debt alone; governance can set one through the timelock.
              {IS_MAINNET_BUILD ? null : ' Sepolia runs the same profile.'} See{' '}
              <Link to="/docs/parameters">parameters</Link>.
            </>,
          ],
          [
            'Emergency liquidation',
            <>
              A liquidation path that works while the vault or the oracle is paused. It uses the
              normal liquidation price and nothing else: when either price feed has stopped it
              refuses, so a stale price can never price a seizure. A frozen token is not
              liquidated, during a pause or not, until the freeze lifts.
            </>,
          ],
          [
            'Gold band',
            <>
              How far a token&rsquo;s market feed may sit from the Chainlink XAU/USD gold price: 2%
              for PAXG at launch. Inside it borrowing and reserve swaps are priced; outside it both
              are refused (&ldquo;Off gold band&rdquo;). Liquidation is never refused for being
              off the band. See{' '}
              <Link to="/docs/oracle">the oracle</Link>.
            </>,
          ],
          [
            'Gold Standard Protocol',
            <>
              The protocol behind GSUSD: the contracts that hold the collateral, issue
              the token and run the peg mechanisms. Named after the monetary system in which money
              was backed by gold and could be exchanged for it. See{' '}
              <Link to="/docs/introduction">introduction</Link>.
            </>,
          ],
          [
            'Guardian',
            <>
              A multisig (2-of-3 Safe intended) that can pause the vault, the oracle, the stability
              pool and individual reserve assets instantly in an emergency, extend a pause, freeze
              one token&rsquo;s pricing and lift that freeze, and re-anchor the oracle&rsquo;s
              last-known price. It cannot move funds,
              change parameters or unpause, and any pause it starts lapses after 14 days unless
              renewed. Only{' '}
              <Link to="/docs/governance">governance</Link> can unpause early.
            </>,
          ],
          [
            'GSUSD',
            <>
              <strong>Gold Standard Dollar</strong>: the ERC-20 stablecoin Gold Standard issues, 18 decimals,
              over-collateralised by tokenised gold (PAXG at launch).
            </>,
          ],
          [
            'Keeper',
            <>
              An off-chain service that watches vaults and liquidates them while both price feeds
              are healthy, watches the oracle&rsquo;s health and compares the on-chain price with an
              off-chain CoinGecko price, raising structured
              alerts for the operator. It runs no fee job: the stability fee accrues inside the
              contracts. It never freezes or pauses anything; only the guardian or
              governance can freeze a token. It is a liveness aid, not a privileged role: anything it does, anyone
              could do.
            </>,
          ],
          [
            'Liquidation',
            <>
              The process that closes an unhealthy vault. When collateral falls below the
              liquidation ratio, anyone can repay the debt and seize the gold at a discount,
              keeping the system solvent. A partial liquidation must leave at least the minimum debt
              behind. See <Link to="/docs/liquidations">liquidations</Link>.
            </>,
          ],
          [
            'Liquidation cap',
            <>
              How far above the gold price liquidation may value collateral: 2% for PAXG at launch
              (<code>liquidationClampPpm</code>, 0.5% to 5% through the timelock). The liquidation
              price is the higher of the market feed and gold, capped there, so it is never below
              gold and a depeg specific to PAXG is not liquidated while gold holds. See{' '}
              <Link to="/docs/oracle">the oracle</Link>.
            </>,
          ],
          [
            'Liquidation penalty',
            <>
              The discount applied during liquidation, default 5% (maximum 20%). It is paid by the
              liquidated vault; liquidators keep 60% of it as an incentive and the protocol keeps
              40%, split 40% to the Stability Reserve and 60% to the surplus buffer. On the stability
              pool path the caller earns a 30% keeper bounty and pool depositors receive the rest.
            </>,
          ],
          [
            'Liquidation ratio',
            <>
              The collateral ratio below which a vault becomes liquidatable, default 110%. Sits
              below the 130% minimum mint ratio to give a safety margin.
            </>,
          ],
          [
            'London Good Delivery',
            <>
              The international standard for large, investment-grade gold bars accepted by the
              London bullion market. The physical gold behind PAXG and XAUT meets this standard.
            </>,
          ],
        ]}
      />

      <h2>M to P</h2>
      <DocTable
        label="Glossary, M to P"
        head={['Term', 'Meaning']}
        rows={[
          [
            'minDebt',
            <>
              {IS_MAINNET_BUILD
                ? 'The smallest debt a vault may carry: set by governance, 1,000 GSUSD at the mainnet launch.'
                : 'The smallest debt a vault may carry: 100 GSUSD on Sepolia, set by governance, and 1,000 at the mainnet launch.'}{' '}
              Tiny positions are uneconomic to liquidate, so the floor is set
              where the liquidator&rsquo;s share of the penalty still covers gas.
            </>,
          ],
          [
            'Minting',
            <>
              Creating GSUSD by borrowing against locked gold, up to the minimum collateral ratio.
              Only the vault can mint. See{' '}
              <Link to="/docs/minting-redeeming">minting and swapping</Link>.
            </>,
          ],
          [
            'Oracle',
            <>
              The contract that prices gold for the protocol. For PAXG it reads Chainlink PAXG/USD,
              checks it against the Chainlink XAU/USD gold price and refuses when either feed has
              stopped. See{' '}
              <Link to="/docs/oracle">the oracle</Link>.
            </>,
          ],
          [
            'Origination fee',
            <>
              A one-off fee, in basis points, taken from the GSUSD a borrower receives on each mint
              and banked in the surplus buffer. 0.05% at deploy; governance may set it anywhere from
              zero to 1% and exempt individual addresses.
            </>,
          ],
          [
            'Over-collateralisation',
            <>
              Holding more collateral value than debt, so every GSUSD is backed by more than its
              value in gold. The first of three peg mechanisms. See{' '}
              <Link to="/docs/peg-stability">peg stability</Link>.
            </>,
          ],
          [
            'PAXG',
            <>
              Paxos Gold (18 decimals), issued by Paxos Trust Company. Each token is a claim on one
              fine troy ounce of allocated London Good Delivery gold.
            </>,
          ],
          [
            'Peg',
            <>
              The target value GSUSD holds, one US dollar, maintained by over-collateralisation,
              the Stability Reserve floor and the stability fee. See{' '}
              <Link to="/docs/peg-stability">peg stability</Link>.
            </>,
          ],
          [
            'Proof of reserves',
            <>
              The ability to confirm, from on-chain data, that GSUSD in circulation is backed by
              gold collateral. Surfaced live on the <Link to="/transparency">reserves page</Link>.
            </>,
          ],
        ]}
      />

      <h2>R to Z</h2>
      <DocTable
        label="Glossary, R to Z"
        head={['Term', 'Meaning']}
        rows={[
          [
            'Stability fee',
            <>
              A per-second fee on outstanding debt, default 2% APR, that funds the surplus buffer.
              Accrues lazily via normalised debt. See{' '}
              <Link to="/docs/stability-fee">the stability fee</Link>.
            </>,
          ],
          [
            'Stability Reserve',
            <>
              A protocol-owned pool of gold (PAXG at launch), held in the GoldStabilityReserve contract
              solely for peg operations. It holds assets, owes nothing and never mints; the GSUSD it
              takes in is kept as inventory rather than burned, and the floor it provides is
              exactly as deep as the reserve. See{' '}
              <Link to="/docs/peg-stability">peg stability</Link>.
            </>,
          ],
          [
            'Stability swap',
            <>
              Exchanging GSUSD for protocol-owned gold from the Stability Reserve at the oracle price
              minus a utilisation spread. The quote puts a floor under the price, one spread-width
              below par; no borrower&rsquo;s vault is involved. See{' '}
              <Link to="/docs/minting-redeeming">minting and swapping</Link>.
            </>,
          ],
          [
            'Stability pool',
            <>
              A Liquity-style buffer in which GSUSD depositors absorb liquidated debt for discounted
              collateral. Live, with Liquity&rsquo;s epoch and scale tracking; the caller of a pool
              liquidation earns a keeper bounty of 30% of the penalty and depositors receive the
              rest of the seized gold.
            </>,
          ],
          [
            'Surplus buffer',
            <>
              The protocol&rsquo;s revenue reservoir. It starts empty and collects origination and
              stability fees, swap spreads and the protocol&rsquo;s share of penalty gold. It
              absorbs bad debt by burning held GSUSD, as far as its balance allows. A floor of 2%
              of supply limits what governance may withdraw from it, not what it may absorb.
            </>,
          ],
          [
            'Timelock',
            <>
              The delay on every governance action, 48 hours at launch, enforced by the
              TimelockController behind the GoldGovernance wrapper; a change to the delay itself
              waits out the delay in force. After launch the timelock irreversibly holds admin and
              governance roles on every contract, so changes are public before they take effect. See{' '}
              <Link to="/docs/governance">governance</Link>.
            </>,
          ],
          [
            'Token freeze',
            <>
              The guardian&rsquo;s manual emergency stop for one token&rsquo;s pricing, which
              governance may also use. Minting, borrowing withdrawals, every liquidation (during a
              pause as well) and reserve swaps in that token stop; repaying and depositing continue. The guardian can lift it once a normal price read would
              succeed, and it lapses after 14 days unless renewed. There is no permissionless
              trip.
            </>,
          ],
          [
            'Troy ounce',
            <>
              The unit in which gold is weighed, about 31.103 grams, heavier than a standard ounce.
              One PAXG or XAUT represents one fine troy ounce of gold.
            </>,
          ],
          [
            'Vault (CDP)',
            <>
              A collateralised debt position: your own on-chain account that holds gold and tracks
              the GSUSD minted against it. You alone control it. See{' '}
              <Link to="/docs/vaults">vaults</Link>.
            </>,
          ],
          [
            'XAUT',
            <>
              Tether Gold (6 decimals), issued by TG Commodities. Each token represents one troy
              ounce of physical gold on a specific London Good Delivery bar. Registered in the
              oracle and inactive at launch; governance activates it once it meets published
              criteria. See <Link to="/docs/oracle">the oracle</Link>.
            </>,
          ],
        ]}
      />

      <h2>Keep reading</h2>
      <p>
        New here? Begin with <Link to="/docs/introduction">the introduction</Link>, then{' '}
        <Link to="/docs/getting-started">getting started</Link>. For common questions, see the{' '}
        <Link to="/docs/faq">FAQ</Link>.
      </p>
    </Prose>
  );
}
