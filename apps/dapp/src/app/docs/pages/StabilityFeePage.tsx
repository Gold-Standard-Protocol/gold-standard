import { Link } from 'react-router-dom';
import { Callout, DocTable, Lead, Prose, Steps } from '../components/DocComponents';
import { IS_MAINNET_BUILD } from '../../lib/network';

export default function StabilityFeePage() {
  return (
    <Prose>
      <Lead>
        The stability fee is a small, continuously accruing charge on
        outstanding GSUSD debt. It is the protocol's primary revenue source and
        a supply-side lever for the peg. The fee it collects flows into the
        surplus buffer, which absorbs bad debt by burning GSUSD and so protects
        the gold backing behind every unit in circulation.
      </Lead>

      <h2>What the stability fee is</h2>
      <p>
        Whenever a vault mints GSUSD it takes on debt, and that debt accrues a
        stability fee for as long as it is open. The fee is expressed as an
        annual percentage rate, set per collateral type, and defaults to{' '}
        <strong>2% APR</strong> nominal; because it compounds every second the
        realised annual charge is about 2.02%, as explained below. It is a
        governance parameter, adjustable within a hard ceiling of{' '}
        <strong>50% APR</strong> nominal, and any change passes through the
        48-hour timelock before it can take effect. The fee is charged on the
        debt, not the collateral, so a vault holding 150 dollars of gold against
        100 GSUSD of debt pays the fee on the 100, not the 150. A separate
        one-off origination fee of 0.05% is taken at mint from the GSUSD you
        receive, capped at 1%.
      </p>
      <p>
        The fee plays a double role. It is the cost of carrying GSUSD debt,
        which discourages minting beyond what demand supports and gives
        governance a way to tighten supply when GSUSD trades soft. And it is
        income: the accrued fee is the protocol's revenue, which is set aside to
        cover losses. Its place among the three peg forces is described in{' '}
        <Link to="/docs/peg-stability">How the peg holds</Link>.
      </p>

      <h2>How the fee accrues continuously</h2>
      <p>
        The fee does not tick once a day or once a block. It accrues every
        second, compounding, using the same approach pioneered by MakerDAO.
        Rather than updating every vault on every block, which would be
        prohibitively expensive on-chain, the StabilityModule tracks one
        accumulator per collateral type and lets each vault's debt grow lazily
        against it.
      </p>

      <h3>The per-second rate idea</h3>
      <p>
        An annual rate is converted into a per-second rate. Picture the 2% APR
        as a tiny multiplier applied once per second: a number just barely above
        1.0 that, compounded across the roughly 31.5 million seconds in a year,
        grows the debt by about 2.02%. The contract computes this compounding with a
        fixed-point exponentiation routine (the MakerDAO-style{' '}
        <code>_rpow</code>), so the result is true per-second compounding rather
        than a simple linear approximation.
      </p>

      <h3>Normalised debt and lazy accrual</h3>
      <p>
        The key to doing this cheaply is the <strong>rate accumulator</strong>.
        It starts at 1.0 and only ever grows, multiplying by the per-second rate
        each time the module is touched. Every vault stores its debt as a{' '}
        <em>normalised</em> figure: the actual debt divided by the accumulator's
        value at the moment the debt was last changed.
      </p>
      <Steps
        steps={[
          {
            title: 'Borrow at todays accumulator',
            detail:
              'When a vault mints, its normalised debt is recorded as the GSUSD borrowed divided by the current accumulator value.',
          },
          {
            title: 'The accumulator grows over time',
            detail:
              'Each interaction advances the global accumulator by the compounded per-second rate for the elapsed time. No per-vault writes are needed in between.',
          },
          {
            title: 'Actual debt is derived on demand',
            detail: (
              <>
                A vault's current debt is simply its normalised debt multiplied
                by the latest accumulator. The fee is therefore implicit in that
                product. It is collected when the vault repays or is liquidated:
                the principal portion of the payment is burned and the fee
                portion is banked in the surplus buffer. A repayment larger than
                the current debt is capped to a full close.
              </>
            ),
          },
        ]}
      />
      <p>
        This is what lazy accrual means: nobody pays gas to update idle vaults,
        yet every vault's debt reflects the fee accrued to the current instant
        the moment it is read or touched. One global update serves the entire
        system.
      </p>

      <Callout variant="tip" title="Why this matters in practice">
        Because the fee compounds per second and is realised on interaction, the
        figure you see for what you owe is always current. There is no surprise
        catch-up charge and no keeper job at all: the contracts bring the
        per-collateral accumulator up to date whenever debt changes and project
        it on every read. The
        accrued fee on every position is captured by one cheap accumulator
        update.
      </Callout>

      <h2>Where the revenue goes: the surplus buffer</h2>
      <p>
        The GSUSD raised by the stability fee is directed to the{' '}
        <strong>SurplusBuffer</strong>, a contract that holds protocol revenue
        as a reservoir of GSUSD. The buffer also receives the spread on
        Stability Reserve swaps and 60% of the protocol's share of liquidation
        penalties, the latter held as gold. The buffer exists to make the
        system resilient to losses without diluting the backing of ordinary
        holders.
      </p>
      <p>
        Its central job is to absorb <strong>bad debt</strong>. Liquidations are
        designed to repay a vault's debt in full before it becomes
        undercollateralised, but in an extreme, fast market move a liquidation
        might recover less than the debt it was meant to cover. The shortfall is
        bad debt: GSUSD in circulation that is no longer fully backed. When this
        happens, the surplus buffer <strong>burns its held GSUSD</strong> to
        cancel the unbacked debt, as far as its holdings allow, restoring full
        backing across the GSUSD still in circulation. Any remainder is recorded
        on-chain as outstanding bad debt; if it rises above the bad-debt pause
        threshold (25,000 GSUSD at deploy) the vault pauses itself, and once the
        buffer refills anyone may call <code>retryBadDebtAbsorption</code> to
        clear the balance. In effect, accumulated fee revenue is spent to keep
        every remaining unit fully collateralised.
      </p>
      <Callout variant="note" title="The fee funds its own insurance">
        The stability fee and the surplus buffer are two halves of one
        mechanism. Day to day, the fee quietly fills the buffer. In stress, the
        buffer empties to protect backing. The buffer starts empty and bad debt
        can use its whole balance. Governance, for its part, cannot withdraw
        from it below 2% of outstanding GSUSD: the contract enforces that floor
        on withdrawals by itself as supply grows, governance may only set a
        higher minimum, and it is covered in{' '}
        <Link to="/docs/parameters">Parameters</Link>.
      </Callout>

      <h2>The linear-approximation over-charge</h2>
      <p>
        The per-second rate is derived by dividing the nominal annual rate by
        the number of seconds in a year and adding it to one, and that factor is
        then compounded every second. Compounding a linearly divided rate
        realises slightly more than the nominal figure: 2% nominal becomes about
        2.02% over a year, and the 50% ceiling would realise about 64.9%.
        MakerDAO instead stores a true per-second root computed off-chain;
        Gold Standard keeps the simpler derivation because the difference is
        immaterial at gold-vault fee levels, and governance proposals quote the
        realised figure alongside the nominal one.
      </p>
      <p>
        Per-second compounding is also computed with fixed-point arithmetic,
        and like all on-chain maths it rounds. In keeping with the protocol's
        consistent rule that <strong>rounding always favours the protocol</strong>,
        the fee calculation rounds in the protocol's direction. The practical
        effect is a negligible over-charge, on the order of rounding dust, that
        accrues to the buffer rather than leaking value out of it.
      </p>
      <p>
        Both effects are deliberate and conservative. They ensure the accounting
        can never drift in a way that under-funds the buffer, and they remove
        any edge-case where a borrower could pay marginally less fee than the
        true compounded amount. The amounts involved are economically immaterial
        to any borrower; their purpose is correctness, not revenue.
      </p>

      <h2>Parameters at a glance</h2>
      <DocTable
        head={['Parameter', 'Default', 'Bounds', 'Set by']}
        rows={[
          [
            'Stability fee',
            '2% APR nominal (about 2.02% realised)',
            'Up to 50% APR nominal',
            'Governance (48h timelock)',
          ],
          ['Origination fee', '0.05%', '0% to 1%', 'Governance (48h timelock)'],
          [
            'Accrual frequency',
            'Per second',
            'Continuous compounding',
            'Fixed in contract',
          ],
          [
            'Surplus withdrawal floor',
            '2% of supply, automatic',
            'Constant; an optional higher governed minimum',
            'Contract; governance may add a higher minimum (48h timelock)',
          ],
          [
            'Rounding direction',
            'Favours protocol',
            'Fixed policy',
            'Fixed in contract',
          ],
        ]}
      />
      <Callout variant="warning" title={IS_MAINNET_BUILD ? 'Parameters can change' : 'Pre-launch status'}>
        {IS_MAINNET_BUILD ? (
          'Default parameters shown here are governance-controlled and may be tuned through the timelock.'
        ) : (
          <>
            Gold Standard is pre-launch on the Sepolia testnet. Default parameters shown here are governance-controlled and
            may be tuned through
            the timelock before and after launch.
          </>
        )}{' '}
        See{' '}
        <Link to="/docs/governance">Governance</Link> for how parameter changes
        are proposed and enacted.
      </Callout>
    </Prose>
  );
}
