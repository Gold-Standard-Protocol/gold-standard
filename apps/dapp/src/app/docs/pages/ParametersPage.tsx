import { Link } from 'react-router-dom';
import { Callout, DocTable, Lead, Prose } from '../components/DocComponents';
import { IS_MAINNET_BUILD } from '../../lib/network';

export default function ParametersPage() {
  return (
    <Prose>
      <Lead>
        Every risk parameter that governs Gold Standard, with its launch default and a
        short description. These values shape how vaults are collateralised,
        when positions are liquidated, how the oracle is validated and how
        quickly the system can move. Governance can change them, but only
        through the 48-hour timelock.
      </Lead>

      <h2>How to read this reference</h2>
      <p>
        Gold Standard Protocol runs the contracts; <strong>GSUSD</strong> (Gold
        Standard Dollar) is its ERC-20 stablecoin, over-collateralised by physical gold held in
        tokenised form (PAXG at launch; XAUT is registered and inactive until it
        is activated). The parameters below are the defaults
        set by the deployment script and enforced by the contracts. They are denominated in fixed
        units: GSUSD and PAXG carry 18 decimals, XAUT carries 6 decimals,
        Chainlink feeds report 8 decimals, and ratios use 6-decimal precision
        where <code>1,000,000</code> represents 100%. Where rounding is
        unavoidable, it always favours the protocol.
      </p>

      <Callout variant="note" title="Defaults, not live values">
        <p>
          The figures here are the deployment defaults. The values actually
          configured on-chain are confirmed on the{' '}
          <Link to="/transparency">Reserves page</Link> once contracts are
          deployed. Governance can adjust any parameter within the bounds the
          contracts enforce, and every change is
          subject to the 48-hour timelock described under{' '}
          <Link to="/docs/governance">Governance</Link>, giving holders time to
          act before a change takes effect.
        </p>
      </Callout>

      <h2>Collateral and minting</h2>
      <p>
        These parameters control how much GSUSD a vault may mint against its
        deposited gold and how much total debt each collateral type can carry.
        Read the mechanics in <Link to="/docs/vaults">Vaults</Link> and{' '}
        <Link to="/docs/minting-redeeming">Minting and swapping</Link>.
      </p>
      <DocTable
        label="Collateral and minting parameters"
        head={['Parameter', 'Default', 'Description']}
        rows={[
          [
            'Minimum collateral ratio',
            '130%',
            'The lowest collateral-to-debt ratio at which a vault may mint or withdraw (1,300,000 in 6-decimal precision). It must always exceed the liquidation ratio, leaving a safety margin before a position becomes liquidatable.',
          ],
          [
            'Minimum debt (minDebt)',
            IS_MAINNET_BUILD
              ? '1,000 GSUSD at the mainnet launch, governed between 100 and 10,000'
              : '100 GSUSD on Sepolia; 1,000 at the mainnet launch, governed between 100 and 10,000',
            'The smallest debt a vault may carry. Positions cannot be left with a tiny non-zero balance that would be uneconomic to liquidate. A vault must either clear this floor or repay in full; repaying more than is owed is capped to a full close.',
          ],
          [
            'Origination fee',
            '5 bps, 0.05% (max 1%)',
            'A one-off fee, in basis points, deducted from the GSUSD a borrower receives on each mint and banked in the surplus buffer. 5 bps at deploy; governance may set it anywhere from 0 to 100 bps and exempt individual addresses.',
          ],
          [
            'Debt ceiling (per collateral)',
            IS_MAINNET_BUILD ? 'None at mainnet launch' : 'None at mainnet launch or on Sepolia',
            'The maximum GSUSD that may be minted against a single collateral type. Mainnet launches PAXG without one (LAUNCH_CAPS=open): the earlier $5M backstop was sized for a retired oracle design, and the project chose to bound a manipulated price in the oracle instead: borrowing is capped at the lower of the market feed and gold, and liquidation values collateral at gold at worst. Governance can set a ceiling through the timelock. XAUT has no collateral type until it is activated.',
          ],
        ]}
      />

      <h2>Liquidation</h2>
      <p>
        When a vault falls below the liquidation ratio, anyone may repay its
        debt and seize its gold at a discount. These parameters set the trigger
        and split the resulting penalty. See{' '}
        <Link to="/docs/liquidations">Liquidations</Link> for the full flow.
      </p>
      <DocTable
        label="Liquidation parameters"
        head={['Parameter', 'Default', 'Description']}
        rows={[
          [
            'Liquidation ratio',
            '110%',
            'The collateral-to-debt ratio below which a vault becomes liquidatable. At or above it, the position is safe; below it, anyone may liquidate. The contract requires at least 105%.',
          ],
          [
            'Liquidation penalty',
            '5% (max 20%)',
            'The discount applied to the seized collateral relative to debt repaid. It rewards the liquidator and funds protocol revenue. With thin collateral the penalty gives way before the debt: the gold is seized against the debt first and the penalty is whatever remains above it.',
          ],
          [
            'Liquidator incentive share',
            '60%',
            'The portion of the penalty paid to the liquidator who clears the position. Of the remaining 40%, the protocol routes 40% to the Gold Stability Reserve and 60% to the surplus buffer.',
          ],
          [
            'Pool keeper bounty',
            '30% of the penalty',
            'On the stability pool path, the caller who triggers the liquidation receives 30% of the penalty and pool depositors receive the rest of the seized gold. The pool must hold strictly more GSUSD than the debt it absorbs.',
          ],
          [
            'Partial liquidation floor',
            IS_MAINNET_BUILD ? 'minDebt (1,000 GSUSD at mainnet launch)' : 'minDebt (100 GSUSD on Sepolia; 1,000 at mainnet launch)',
            'A partial liquidation must leave at least minDebt of debt behind and may not exhaust the vault’s collateral; otherwise the call is refused and the liquidator repays the whole debt instead.',
          ],
          [
            'Bad-debt pause threshold',
            '25,000 GSUSD',
            'Residual bad debt is absorbed by the surplus buffer and any remainder recorded as totalBadDebt. Once that total exceeds the threshold the vault pauses itself, and each further bad debt while it stays over restarts the pause’s 14 day window under a new number, paused already or not; retryBadDebtAbsorption clears the balance when the buffer refills. Zero disables the auto-pause.',
          ],
        ]}
      />

      <h2>Stability swap</h2>
      <p>
        The Stability Swap lets anyone exchange GSUSD for protocol-owned gold
        held in the GoldStabilityReserve at the oracle price minus a
        utilisation spread, which puts a floor under the price one spread-width
        below par. The spread widens as reserve coverage falls, so gold becomes
        more expensive to remove as the reserve thins. No borrower&rsquo;s vault
        is involved, and the floor is exactly as deep as the reserve. See{' '}
        <Link to="/docs/peg-stability">Peg stability</Link>.
      </p>
      <DocTable
        label="Stability swap parameters"
        head={['Parameter', 'Default', 'Description']}
        rows={[
          [
            'Stability swap spread',
            '0.5% to 2%',
            'Subtracted from the oracle price on each swap. Steps by reserve coverage (swappable gold value over circulating GSUSD): 0.5% at 10% coverage or more, 0.75% at 5%, 1.25% at 2% and 2% below that (the restricted spread). Those are the launch steps; governance can reset them only between 0.5% (MIN_SPREAD_PPM) and 5% (MAX_SPREAD_PPM). Coverage is measured against a supply anchor that drifts over one day, so a same-day burn cannot buy a cheaper tier. A swap pays the tier of the coverage it leaves behind, so a large swap can pay a dearer tier than the current one, and quoteGoldOut previews exactly that. Gold of a paused, de-supported or frozen asset does not count as coverage, and governance cannot list a token the oracle has no feed for.',
          ],
          [
            'GSUSD received',
            'Retained as inventory',
            'The reserve keeps the GSUSD it takes in rather than burning it; the spread portion is routed to the surplus buffer. Seeding the reserve with gold is permissionless, and the reserve never mints and never touches a vault.',
          ],
          [
            'Per-asset daily cap',
            '20% of day-start balance',
            'The most of each gold token the reserve will pay out in one UTC day, measured against its balance at the start of that day. Remaining capacity is shown on the reserves page.',
          ],
          [
            'Aggregate daily cap',
            '0 (disabled)',
            'An optional ceiling on total outflow across every reserve asset per UTC day. Off at deploy; governance can enable it to slow outflows under stress.',
          ],
          [
            'Minimum reserve (per asset)',
            'Governance-set (0 at deploy)',
            'A floor of each gold token below which the swap refuses. Gold beneath the minimum is not counted as swappable capacity.',
          ],
          [
            'Reserve penalty share',
            '40%',
            'The portion of the protocol’s share of each liquidation penalty that is routed to the Stability Reserve rather than the surplus buffer, which receives the other 60%, topping the reserve up over time.',
          ],
          [
            'Slippage bound (minGoldOut)',
            'Caller-set',
            'Each swap carries a minimum gold amount. If the gold owed at execution is below it, the swap reverts, protecting the caller from a price or spread move.',
          ],
        ]}
      />

      <h2>Oracle</h2>
      <p>
        The oracle prices PAXG from two Chainlink feeds and nothing else: the
        PAXG/USD market feed and the XAU/USD gold price it is checked against.
        Both widths below are measured against gold. These parameters define
        the bounds. See <Link to="/docs/oracle">Oracle</Link>{' '}
        for the pricing rules.
      </p>
      <DocTable
        label="Oracle parameters"
        head={['Parameter', 'Default', 'Description']}
        rows={[
          [
            'Staleness threshold',
            '90,000s (25 hours; range 300 to 90,000s)',
            'The maximum age of a feed update before its price is treated as stale. A stale or incomplete round is rejected rather than used. The bound sits just above the gold feeds’ 24-hour heartbeat, since a tighter value would brick the protocol on a quiet day.',
          ],
          [
            'Gold band g (per token, goldBandPpm)',
            '2% (range 0.5% to 10%)',
            'How far the market feed may sit from the XAU/USD gold price and still borrow or trade with the Stability Reserve. Inside it borrowing prices at the lower of the market feed and gold and reserve swaps at the higher; outside it both are refused ("Off gold band"). Liquidation is never refused for being off the band. Set through setGoldBand behind the 48 hour timelock (GoldGovernance.proposeGoldBandUpdate). Sampled every 30 minutes over 60 days, the widest PAXG to gold gap was 0.84%; read update by update it reached 1.07% once.',
          ],
          [
            'Liquidation cap m (per token, liquidationClampPpm)',
            '2% (range 0.5% to 5%)',
            'How far above gold liquidation may value collateral. The liquidation price is min(max(C, G), G × (1 + m)): the higher of the market feed and gold, capped at m above gold, so a market feed pushed up can hold off a liquidation by at most m. The 5% ceiling stays under the 10% a 110% liquidation ratio leaves above par, so a vault under water at gold is always liquidatable. Set through setLiquidationClamp behind the 48 hour timelock (GoldGovernance.proposeLiquidationClampUpdate).',
          ],
          [
            'Token freeze',
            'Guardian or governance',
            'freezeToken stops one token’s price reads and every liquidation in it, during a pause as well, as a manual emergency stop; there is no permissionless trip. guardianUnfreezeToken(token, freezeEpoch(token)) lifts it once a normal read would succeed; every freeze call takes a new number, so an unfreeze approved before the last one reverts. Governance resyncLastKnownPrice and the guardian’s guardianResyncLastKnownPrice record the liquidation price the rules give now as the last-known price, which never prices a seizure.',
          ],
          [
            'Feed format',
            '8 decimals, full round',
            'Every registered feed must report 8 decimals, and each round is validated in full (answer, round id, updated timestamp) before its price is used.',
          ],
        ]}
      />

      <h2>Rate limits and buffers</h2>
      <p>
        These controls throttle throughput and back the system against bad debt.
        Several are disabled by default and exist so governance can dampen
        activity during stress without redeploying.
      </p>
      <DocTable
        label="Rate limit and buffer parameters"
        head={['Parameter', 'Default', 'Description']}
        rows={[
          [
            'Stability fee',
            '2% APR nominal (max 50%)',
            'A per-second compounding fee accrued on outstanding debt, set per collateral; a 2% nominal rate realises about 2.02% over a year. It funds the surplus buffer and can be raised by governance up to the 50% ceiling (MAX_ANNUAL_RATE_BPS).',
          ],
          [
            'Silo cap',
            '100 oz (0.01 to 1,000)',
            'The maximum collateral a single collateral silo may hold before deposits shard into a new silo. Distributing gold across many addresses raises the cost of an issuer-side freeze. Each silo’s VAULT_ROLE is locked at deploy, and deposits and withdrawals route around a frozen silo.',
          ],
          [
            'Per-block mint cap',
            'Off at mainnet launch',
            'A ceiling on GSUSD minted in any one block. Zero disables it, as at mainnet launch; governance can arm it through the timelock.',
          ],
          [
            'Per-asset daily swap cap',
            '20% of day-start balance',
            'Caps how much of each gold token the Stability Reserve pays out per UTC day. On by default, unlike the other limits here; see the Stability swap section above.',
          ],
          [
            'Surplus reserve floor',
            '2% of supply, automatic',
            'The GSUSD the surplus buffer keeps before governance can withdraw anything: effectiveMinGsusdReserve, 2% of the larger of the live supply and its one day average, rounded up. It follows supply on chain with no governance step, and a burn only lowers it as it ages over a day, so nobody can repay debt for a moment to withdraw more. Bad debt can still use the whole balance.',
          ],
          [
            'Governed minimum surplus reserves',
            'Optional (0 at deploy)',
            'minGsusdReserve, a higher GSUSD minimum governance may set through the timelock; it binds only above the automatic 2% and can never lower it. Also a minCollateralReserve per gold token for penalty collateral, which the GSUSD floor does not cover.',
          ],
        ]}
      />

      <h2>Governance</h2>
      <p>
        Parameter changes do not take effect immediately. They pass through a
        timelock that gives holders a window to react. See{' '}
        <Link to="/docs/governance">Governance</Link>.
      </p>
      <DocTable
        label="Governance parameters"
        head={['Parameter', 'Default', 'Description']}
        rows={[
          [
            'Maximum pause duration',
            '14 days',
            'A pause on the vault, oracle or stability pool lapses after this window and anyone may lift it with unpauseExpired(). A reserve asset pause lapses after the same window by itself, and the guardian renews it by pausing again. A fresh pause restarts the window; governance can still unpause early. A vault with no debt may withdraw during any pause.',
          ],
          [
            'Minter lock',
            'Unlocked at deploy; one-way',
            'lockMinters(vault) on GSUSD removes for good the power to grant MINTER_ROLE, from every key including the timelock, and succeeds only while the vault is the sole minter. Taken by governance at steady state; verify-deployment enforces it with EXPECT_MINTERS_LOCKED=1.',
          ],
          [
            'Governance timelock',
            '48 hours',
            'The minimum delay between a governance action being queued and being executable. It starts at MIN_DELAY in the GoldGovernance wrapper and changes only through a timelock call that first waits out the delay in force. Every parameter change, module rewiring, feed update and unpause waits it out, giving holders time to exit before it lands.',
          ],
          [
            'Timelock grace period',
            '7 days',
            'How long a queued action stays executable once its delay has passed. After it the timelock refuses the action for good, so an approval cannot be used long after the moment it was made for; governance queues it again and it waits out the delay again. A constant of the timelock.',
          ],
        ]}
      />

      <Callout variant="tip" title="Where the numbers come from">
        <p>
          Units throughout are precise: ratios at 6-decimal precision
          (1,000,000 = 100%), GSUSD and PAXG at 18 decimals, XAUT at 6 decimals
          and Chainlink feeds at 8 decimals. When you read a parameter on the{' '}
          <Link to="/transparency">Reserves page</Link>, it reflects the live
          on-chain value rather than these defaults.
        </p>
      </Callout>
    </Prose>
  );
}
