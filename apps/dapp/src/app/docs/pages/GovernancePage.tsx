import { Link } from 'react-router-dom';
import { Callout, DocTable, Lead, Prose, Steps } from '../components/DocComponents';
import { IS_MAINNET_BUILD } from '../../lib/network';

export default function GovernancePage() {
  return (
    <Prose>
      <Lead>
        Gold Standard is governed through a 48-hour timelock and a narrowly scoped
        guardian. After an irreversible launch ceremony, control of the protocol
        rests with the timelock, and the only fast actions anyone can take are the
        guardian&rsquo;s: to pause and to freeze. This page explains who holds what, what governance can change and
        the protection the delay gives holders.
      </Lead>

      <h2>The launch ceremony</h2>
      <p>
        At deployment the protocol is configured and then handed over. During the
        launch ceremony the <code>DEFAULT_ADMIN_ROLE</code> and{' '}
        <code>GOVERNANCE_ROLE</code> on every contract, including the GSUSD
        token, the silo factory and the <code>GoldGovernance</code> wrapper
        itself, are transferred to the 48-hour timelock. This transfer is{' '}
        <strong>irreversible</strong>: once complete, the deployer key holds no
        role on any contract, the deployment verifier asserts as much, and every
        subsequent change must pass through the timelock. The launch steps and
        the wider architecture are covered under{' '}
        <Link to="/docs/security">Security and architecture</Link>.
      </p>
      <Callout variant="note" title="Where the handover stands today">
        <p>
          The handover is rehearsed end to end on a local chain, including a
          48-hour timelock unpause, and the launch procedure{' '}
          {IS_MAINNET_BUILD
            ? 'was rehearsed on a fork of mainnet before the ceremony.'
            : 'is rehearsed on Sepolia and on a fork of mainnet before the mainnet ceremony.'}
          {IS_MAINNET_BUILD
            ? null
            : ' On Sepolia the handover has been made: the timelock holds every admin role, and the proposer, the executor and the guardian are separate Safes.'}
        </p>
      </Callout>

      <h2>Roles after the ceremony</h2>
      <p>
        Two distinct authorities exist, with deliberately different powers. The
        timelock can change the system but only slowly; the guardian can act
        instantly, but only to stop things: to pause, to extend a pause and to
        freeze one token, a freeze it can also lift.
      </p>
      <DocTable
        head={['Role', 'Held by', 'Can do', 'Cannot do']}
        rows={[
          [
            'Governance / admin',
            'GoldGovernance wrapper around a 48-hour TimelockController',
            'Queue and, after the delay, execute parameter changes, module rewiring, feed updates, the per-token gold band and liquidation cap, re-anchoring of the oracle’s last-known price, activating a new collateral such as XAUT and unpausing.',
            'Skip the delay in force. Every action waits it out (48 hours at launch).',
          ],
          [
            'Proposer and executor',
            'Proposer Safe (2-of-3 intended) and executor Safe (2-of-3 intended)',
            'Proposers hold PROPOSER_ROLE on the wrapper and on the timelock itself, queue proposals and cancel any that is no longer wanted; executors hold EXECUTOR_ROLE on both and execute them once the delay has elapsed. Execution open to anyone is refused at the mainnet launch unless the operator accepts it explicitly.',
            'Skip the delay in force, or execute an action more than 7 days after it became executable: it has then expired and must be queued again. A change to the delay itself is queued like any other action and waits it out first.',
          ],
          [
            'Guardian',
            'Guardian multisig (2-of-3 Safe intended)',
            'Instantly emergencyPause the vault, the oracle and the stability pool, and pause individual reserve assets, with no timelock, to halt the system under attack or anomaly. Freeze one token’s pricing as a manual emergency stop, and lift that freeze once a normal price read would succeed. Re-anchor the oracle’s last-known price, bounded to what the pricing rules give.',
            'Unpause, move funds or change any parameter. Only governance can unpause early; a pause lapses after 14 days and anyone may then lift it.',
          ],
        ]}
      />
      <Callout variant="note" title="Pause is one-way for the guardian">
        <p>
          The guardian can stop the system but cannot restart it. Unpausing is a
          governance action and is therefore subject to the 48-hour timelock.
          This split means a compromised guardian can, at worst, pause the system
          or freeze a token; it can never move value or quietly resume a halted
          system. While the vault is paused, minting, withdrawal from a vault with
          debt and direct liquidation are blocked. Deposits and repayments stay
          open, a vault with no debt can withdraw, and liquidation through the
          stability pool and emergency liquidation continue at the normal
          liquidation price, refusing while either price feed has stopped.
        </p>
      </Callout>

      <h2>What governance can change</h2>
      <p>
        Through the timelock, governance can adjust the levers that keep the
        protocol safe and solvent. The full set of defaults is documented under{' '}
        <Link to="/docs/parameters">Risk parameters</Link>.
      </p>
      <ul>
        <li>
          <strong>Risk parameters.</strong> Collateral and liquidation ratios,
          penalties and their split, the stability fee, the origination fee,
          debt ceilings, the per-block mint cap, the bad-debt pause threshold,
          the stability swap spread curve and the optional rate limits. PAXG
          launches with no debt ceiling and no per-block mint cap; governance
          can set either through the timelock. The oracle&rsquo;s gold band
          (through <code>proposeGoldBandUpdate</code>) and liquidation cap
          (through <code>proposeLiquidationClampUpdate</code>) are governed the
          same way.
        </li>
        <li>
          <strong>Stability Reserve levers.</strong> The spread curve, per-asset
          daily caps, the aggregate cap and each asset&rsquo;s minimum reserve
          on the GoldStabilityReserve; the share of liquidation penalties routed
          to the reserve (<code>setReservePenaltyShare</code>, queued through{' '}
          <code>proposeReservePenaltyShare</code>); and which reserve contract
          the vault points at (<code>setStabilityReserve</code>, queued through{' '}
          <code>proposeStabilityReserveUpdate</code>). The reserve never holds a
          minting role, whatever governance sets.
        </li>
        <li>
          <strong>Oracle configuration.</strong> Each token&rsquo;s market feed, the
          XAU/USD gold reference (<code>setAnchorFeed</code>), the staleness
          threshold and the two per-token widths, both measured against gold: the
          gold band (<code>setGoldBand</code>, 0.5% to 10%, 2% at launch), which
          gates borrowing and reserve swaps, and the liquidation cap{' '}
          (<code>setLiquidationClamp</code>, 0.5% to 5%, 2% at launch), which bounds
          the liquidation price above gold. Governance can also re-anchor the
          last-known price (<code>resyncLastKnownPrice</code>), bounded to what the
          rules give.
          There is no permissionless circuit breaker. The guardian can freeze one
          token (<code>freezeToken</code>), lift the freeze once a normal read would
          succeed (<code>guardianUnfreezeToken(token, freezeEpoch(token))</code>), re-anchor
          (<code>guardianResyncLastKnownPrice</code>) and extend an active pause
          before it lapses (<code>extendPause</code>); it can never lift a pause,
          which only governance can do early. Every pause, extension, freeze and bad-debt breaker
          trip takes a new
          number, and a governance unpause or unfreeze must name the current one, so an approval
          given before the guardian last acted cannot lift the hold. See <Link to="/docs/oracle">Oracle</Link>.
        </li>
        <li>
          <strong>Module wiring.</strong> How the vault, stability pool, surplus
          buffer and Stability Reserve are connected. Each module must already
          have granted the vault its <code>VAULT_ROLE</code> before it can be
          wired in.
        </li>
        <li>
          <strong>Activating XAUT.</strong> XAUT is registered in the oracle and
          otherwise inactive at launch. Once it meets the published criteria,
          one batch through the timelock points its oracle entry at its sources,
          adds it as a collateral type with its own ceiling and adds it to the
          stability pool; it joins the Stability Reserve only after 30 days of
          clean pricing. Adding a collateral type cannot be undone: the token can be frozen in
          the oracle and its debt ceiling lowered, but it cannot be removed.
          See <Link to="/docs/oracle">Oracle</Link>.
        </li>
        <li>
          <strong>Surplus buffer floors.</strong> An optional minimum GSUSD
          reserve above the automatic floor of 2% of supply, the minimum
          collateral reserve per token, and any withdrawal of surplus above
          them. The floors limit withdrawals only: absorbing bad debt can use
          the whole balance.
        </li>
        <li>
          <strong>Unpausing.</strong> Bringing the vault, oracle, stability pool
          or a paused reserve asset back online after a guardian pause before its
          14 day window lapses on its own.
        </li>
        <li>
          <strong>Locking the minter set.</strong> A one-way call to{' '}
          <code>lockMinters(vault)</code> on GSUSD after which no key, the timelock
          included, can ever grant <code>MINTER_ROLE</code> again. It succeeds
          only while the vault is the sole minter and the timelock the sole
          admin, so no other key can be frozen inside the lock. Intended for
          the point at which the launch vault has proven itself; a
          replacement vault would then need a new GSUSD.
        </li>
      </ul>

      <h2>How a change reaches the chain</h2>
      <p>
        No governance action is immediate. Each one is queued, waits out the delay
        and only then becomes executable, which is what gives holders a window to
        respond.
      </p>
      <Steps
        steps={[
          {
            title: 'Queue',
            detail:
              'A proposer queues an action, either through a GoldGovernance helper, which schedules it with its 48-hour MIN_DELAY, or directly on the TimelockController, which accepts any delay at or above its current minimum. The action and its parameters become publicly visible on-chain.',
          },
          {
            title: 'Wait',
            detail:
              'The scheduled delay elapses, never shorter than the timelock’s minimum in force (48 hours at launch). During this window anyone can inspect the pending change and decide whether to stay or exit.',
          },
          {
            title: 'Execute',
            detail:
              'After the delay, an executor calls executeProposal, or execute on the timelock for an action scheduled there directly, and the change takes effect. It cannot be executed early, and it cannot be executed more than 7 days after it became executable: the timelock then refuses it for good and the proposer queues it again. The proposer Safe cancels any queued action that has been superseded, has failed or no longer applies.',
          },
        ]}
      />

      <h2>The protection the delay provides</h2>
      <p>
        The delay is a user-protection mechanism, not merely administrative
        friction. Because every parameter change, feed update and unpause is
        visible for at least the delay in force (48 hours at launch) before it
        can take effect, holders who disagree with a pending change have time to
        swap GSUSD for reserve gold or close their vault before it lands.
        Governance cannot make an instant change without warning: even
        shortening the delay must first wait out the delay in force, so a cut to
        zero is public on-chain for at least that long (48 hours at launch)
        before any instant change becomes possible. See{' '}
        <Link to="/docs/minting-redeeming">Minting and swapping</Link> for how
        to exit.
      </p>
      <p>
        The delay is a timelock setting, not a fixed constant. It starts at 48
        hours, and proposers and executors can change it, even to zero, by
        scheduling a call to the timelock&rsquo;s own <code>updateDelay</code>.
        That call waits out the delay in force like any other action and emits{' '}
        <code>MinDelayChange</code> when it executes, so a shorter delay is
        public on-chain for at least the current delay before it applies.
        Proposers and executors therefore control the delay policy over time. An
        immutable minimum would need a different contract and a separate
        change.
      </p>

      <h2>Trust assumptions</h2>
      <p>
        The intended launch configuration is a 2-of-3 proposer Safe, a 2-of-3
        executor Safe and a 2-of-3 guardian Safe, so the
        protocol is safe so long as a majority of proposer signers act honestly.
        {IS_MAINNET_BUILD ? null : ' The Sepolia deployment is arranged the same way.'}{' '}
        This sits within the broader trust model, where each root of trust, the
        Ethereum base layer, the Chainlink feeds, the Paxos and Tether
        custodians, the governance multisig, the guardian and the keepers, is
        assumed to be capable of failure.
      </p>
      <Callout variant="warning" title="At worst pause, never drain">
        <p>
          The guiding principle is that the compromise of any single trust root
          should, at worst, pause the protocol rather than drain it. A captured
          guardian can only pause or freeze; a captured governance multisig still cannot act,
          or shorten the delay, before the delay in force has run; no single key
          can mint freely or move collateral. The full threat analysis lives under{' '}
          <Link to="/docs/security">Security and architecture</Link>.
        </p>
      </Callout>
    </Prose>
  );
}
