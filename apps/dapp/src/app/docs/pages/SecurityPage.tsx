import { Link } from 'react-router-dom';
import {
  BeakerIcon,
  BugAntIcon,
  CubeTransparentIcon,
  ShieldCheckIcon,
} from '@heroicons/react/24/outline';
import {
  Callout,
  DocTable,
  FeatureGrid,
  Lead,
  Prose,
} from '../components/DocComponents';
import { IS_MAINNET_BUILD } from '../../lib/network';

export default function SecurityPage() {
  return (
    <Prose>
      <Lead>
        Gold Standard is built so that a single failure pauses the system rather than
        draining it. This page sets out the contract architecture, the
        collateral-silo design that resists censorship, the bug classes the code
        defends against and the risks that remain.
      </Lead>

      <Callout variant="danger" title={IS_MAINNET_BUILD ? 'Experimental software' : 'Experimental, pre-launch software'}>
        <p>
          {IS_MAINNET_BUILD
            ? 'Gold Standard runs on Ethereum mainnet.'
            : 'Gold Standard has not yet launched on Ethereum mainnet and its contracts have not been deployed there.'}{' '}
          The code is open source, so anyone can read and verify it.
          This is experimental software; interacting with it
          carries smart-contract risk. Nothing in this documentation is
          financial advice.
        </p>
      </Callout>

      <h2>Design principle</h2>
      <p>
        Every trust root in Gold Standard is treated as something that can fail. The
        Ethereum base layer, the Chainlink price feeds, the Paxos and Tether
        custodians, the governance multisig, the guardian and the keepers that
        keep the system live are each a point of dependence. The architecture is
        arranged so that the compromise of any single one should, at worst,{' '}
        <strong>pause</strong> the protocol rather than allow funds to be moved.
        No single key can mint freely, drain collateral or change parameters
        without delay.
      </p>

      <h2>Contract architecture</h2>
      <p>
        The protocol is a set of focused contracts with narrow
        responsibilities. The vault is the core; the surrounding modules handle
        pricing, fees, the Stability Reserve, custody sharding and governance.
      </p>
      <DocTable
        head={['Contract', 'Responsibility']}
        rows={[
          [
            <code>GoldStablecoin</code>,
            'The ERC-20 GSUSD token, with permit and burn support. Only the vault, holding MINTER_ROLE, can mint. There is no other mint path.',
          ],
          [
            <code>GoldOracle</code>,
            'Prices PAXG from two Chainlink feeds, PAXG/USD (C) checked against the XAU/USD gold price (G). Borrowing prices at the lower of the two and reserve swaps at the higher, both refused off a 2% gold band; liquidation prices at min(max(C, G), G × (1 + m)) with a 2% liquidation cap m and is never refused for being off the band. Enforces staleness (25 hours) and full-round validation and requires 8-decimal feeds. There is no permissionless circuit breaker: the guardian may freeze one token as a manual emergency stop. XAUT is registered and inactive.',
          ],
          [
            <code>StabilityModule</code>,
            'Accrues the per-second stability fee using a MakerDAO-style _rpow exponentiation. It tracks normalised debt so fees accrue lazily without touching every vault.',
          ],
          [
            <code>GoldVault</code>,
            'The CDP core: collateral custody, debt issuance and liquidation, both directly and through the stability pool, plus emergency liquidation while the vault or the oracle is paused, at the oracle’s normal liquidation price and nothing else; a frozen token is not liquidated, during a pause as well. Residual bad debt beyond the surplus buffer pauses the vault automatically above a governance-set threshold. A vault with no debt can always withdraw, even while paused, and every pause lapses after 14 days.',
          ],
          [
            <code>StabilityPool</code>,
            'A Liquity-style liquidation buffer where GSUSD depositors absorb liquidated debt in exchange for discounted collateral. It uses Liquity’s epoch and scale tracking, so its product factor never reaches zero; the caller of a pool liquidation earns a keeper bounty of 30% of the penalty.',
          ],
          [
            <code>SurplusBuffer</code>,
            'The protocol revenue reservoir, empty at deployment and fed by origination and stability fees, swap spreads and the protocol’s share of penalty gold. It absorbs bad debt by burning held GSUSD, the third leg of peg defence, as far as its balance allows. An automatic floor of 2% of supply limits what governance may withdraw from it, not what it may absorb.',
          ],
          [
            <code>GoldStabilityReserve</code>,
            'Holds protocol-owned gold that GSUSD can be swapped for at the oracle price minus a spread. It never mints, keeps the GSUSD it receives as inventory rather than burning it, and swaps never touch a borrower’s vault. The floor it provides is exactly as deep as the reserve.',
          ],
          [
            <>
              <code>SiloFactory</code> / <code>CollateralSilo</code>
            </>,
            'EIP-1167 minimal-proxy shards that spread collateral across many addresses, raising the cost of issuer-side censorship such as a Paxos or Tether freeze. The factory’s VAULT_ROLE is locked to the vault at deploy, and deposits and withdrawals route around a frozen silo.',
          ],
          [
            <code>GoldGovernance</code>,
            'A wrapper around an OpenZeppelin TimelockController, extended so that a queued action can be executed only within 7 days of becoming executable; its minimum delay starts at 48 hours and changes only through the timelock itself. Proposer and executor Safes hold roles on both the wrapper and the timelock, where the wrapper is also a registered proposer and executor; the handover transfers every contract, including the stablecoin and the wrapper, to the timelock.',
          ],
        ]}
      />
      <p>
        For how pricing is validated see <Link to="/docs/oracle">Oracle</Link>;
        for who controls these contracts and how they can be changed see{' '}
        <Link to="/docs/governance">Governance</Link>.
      </p>

      <h2>The collateral-silo design</h2>
      <p>
        PAXG is issued by Paxos Trust Company (and XAUT, once activated, by TG
        Commodities), and each issuer retains the power to freeze addresses. If
        all collateral sat at one vault address, a single freeze could lock the
        entire reserve. Gold Standard instead distributes collateral across many{' '}
        <code>CollateralSilo</code> shards, deployed cheaply as EIP-1167 minimal
        proxies by the <code>SiloFactory</code>, each capped at the silo cap (100
        oz by default). Spreading gold across many addresses raises the cost and
        complexity of an issuer-side freeze. The factory&rsquo;s{' '}
        <code>VAULT_ROLE</code> is locked to the vault at deploy, and the factory routes
        deposits and withdrawals around a silo it cannot reach, so a single
        frozen address does not brick that collateral type.
      </p>
      <Callout variant="warning" title="Sharding raises cost, it does not remove the risk">
        <p>
          Silos make censorship more expensive, not impossible. Counterparty and
          custody risk on PAXG remains a residual risk, carried in full while
          PAXG is the only collateral. Activating XAUT would spread exposure
          across two custodians, but would not eliminate it. See <Link to="/docs/collateral">Collateral</Link>{' '}
          and the residual risks below.
        </p>
      </Callout>

      <h2>Defended bug classes</h2>
      <p>
        The contracts are written against the failure modes that have historically
        drained DeFi protocols. Each is countered with an established control.
      </p>
      <DocTable
        head={['Bug class', 'Control']}
        rows={[
          [
            'Reentrancy',
            'nonReentrant guards, SafeERC20 for all token movement and a checks-effects-interactions ordering throughout.',
          ],
          [
            'Arithmetic overflow',
            'Solidity 0.8 checked arithmetic plus Math.mulDiv for full-precision multiply-then-divide.',
          ],
          [
            'Permit replay',
            "OpenZeppelin's ERC20Permit, with nonce tracking that prevents a signed permit from being reused.",
          ],
          [
            'Oracle staleness and incomplete rounds',
            'Staleness thresholds and full-round validation in GoldOracle reject old or partial data from every source before it can price a position, and a stopped source counts as stopped, never as a price.',
          ],
          [
            'Oracle manipulation',
            'A pushed market feed cannot raise the borrow price above gold, and off the 2% gold band borrowing and reserve swaps are refused. Liquidation values collateral at no less than gold, so a market feed pushed down cannot make a healthy vault seizable, and at no more than the liquidation cap above gold, so a market feed pushed up holds off a liquidation by at most 2%. Those bounds, not a debt ceiling, limit what a manipulated price can extract: PAXG launches with no ceiling. The accepted trade-off is that a depeg specific to PAXG is not liquidated while gold holds.',
          ],
          [
            'Stale-price over-seizure',
            'Liquidation needs both feeds healthy and refuses otherwise, so no seizure is priced on a stale feed or on gold alone. Emergency liquidation during a pause uses the same liquidation price and nothing else; the last-known price never prices a seizure. The liquidation price is never below gold, so a single low print of the market feed cannot hand a healthy vault to a liquidator.',
          ],
          [
            'Fund conservation',
            'Foundry invariant tests assert that collateral and debt are conserved across sequences of operations.',
          ],
          [
            'Fee-on-transfer tokens',
            'Deposits credit the balance actually received, and every liquidation path pays out from what the silos actually deliver rather than the nominal seizure, so a fee-on-transfer token can neither under-collateralise a vault nor block its liquidation.',
          ],
          [
            'Pool accounting collapse',
            'The StabilityPool tracks Liquity-style epochs and scales so its product factor can never floor to zero and strand deposits or seized collateral.',
          ],
          [
            'Liquidation sizing',
            'A partial liquidation must leave at least minDebt and may not exhaust the collateral, and with thin collateral the penalty gives way before the debt, so a borrower cannot be paid by the surplus buffer to liquidate themselves.',
          ],
          [
            'Frozen silo',
            'The factory’s VAULT_ROLE is locked to the vault at deploy, so only the vault can move collateral out of a silo, and deposits and withdrawals route around a silo the factory cannot reach.',
          ],
          [
            'Governance backdoor',
            'The handover transfers every contract, including the GoldGovernance wrapper itself, to the timelock. Before and after it, a role census rebuilds every privileged role’s full set of holders and fails unless each is exactly the intended one, so a key granted a role before the handover cannot survive it unseen, and verify-deployment asserts that the deployer retains no role.',
          ],
          [
            'Lost keys or absent governance',
            'A pause on the vault, oracle or stability pool lapses 14 days after it was placed or last extended (extendPause, guardian or governance), and anyone may then lift it; every pause, extension and bad-debt breaker trip takes a new number, so an unpause approved before the last one cannot lift it; a reserve asset pause lapses after 14 days by itself; a vault with no debt may withdraw during any pause, so repay-in-full-then-withdraw is a guaranteed exit; and lockMinters(vault) removes, one way and from every key including the timelock, the power to add a GSUSD minter.',
          ],
        ]}
      />

      <h2>Testing approach</h2>
      <p>
        The codebase is exercised by a layered test suite rather than unit tests
        alone. The aim is to catch logic errors, economic edge cases and
        known-dangerous patterns before deployment.
      </p>
      <FeatureGrid
        features={[
          {
            icon: BeakerIcon,
            title: 'Hardhat suites',
            detail:
              'Behavioural and integration tests covering the expected flows for minting, stability swaps, liquidation, the stability pool and governance.',
          },
          {
            icon: CubeTransparentIcon,
            title: 'Foundry fuzzing and invariants',
            detail:
              'Property-based fuzz tests and stateful invariants that assert fund conservation and core safety properties across randomised operation sequences, and a differential test of the rpow fee exponentiation against an mpmath reference.',
          },
          {
            icon: BugAntIcon,
            title: 'Slither and Solhint before each release',
            detail:
              'The test suites, Slither static analysis and Solhint linting are run before each release. A release requires Slither to report nothing at medium or high severity.',
          },
          {
            icon: ShieldCheckIcon,
            title: 'Open source',
            detail:
              'The contracts are open source, so anyone can read and verify the controls described here.',
          },
        ]}
      />

      <h2>Keeper and monitoring</h2>
      <p>
        An off-chain keeper service (<code>apps/keeper</code>) watches every
        vault for liquidatability on both the direct and stability pool paths and
        liquidates, sized from <code>quoteTokenPrice</code> and only while both
        feeds are healthy. It refreshes the last-known price the vault&rsquo;s
        views read when it drifts and compares the on-chain price with an
        off-chain CoinGecko price as a watchdog. It runs no fee job: the
        stability fee accrues inside the contracts, which bring it up to date
        whenever debt changes and project it on every read. The
        oracle needs no call from the keeper to price, and liquidation resumes
        by itself when a stopped feed answers again. Its{' '}
        <code>oracle-health</code> job reads both feeds and the
        oracle&rsquo;s own answers and only alerts: the
        keeper never freezes or pauses anything, and only the guardian or
        governance can freeze a token. It runs in dry-run mode by default and emits structured
        JSON alerts for the operator&rsquo;s monitoring, including{' '}
        <code>vault.liquidatable</code>, <code>vault.pool-underfunded</code>{' '}
        and <code>keeper.tx-failed</code>. The oracle alerts are{' '}
        <code>oracle.price-refused</code> (liquidation refused for a token),{' '}
        <code>oracle.off-gold-band</code> (the market feed is off the gold band,
        so borrowing and reserve swaps are refused while liquidation stays
        open), <code>oracle.feed-invalid</code> (a feed has stopped, so every
        priced path for the token waits), <code>oracle.premium-capped</code>{' '}
        (the market price sits above the liquidation cap, so liquidation values
        the token at the cap), <code>oracle.borrow-refused</code>,{' '}
        <code>oracle.price-stale</code>, <code>oracle.price-reanchored</code>,{' '}
        <code>oracle.price-divergence</code> (the on-chain price against an
        off-chain aggregator), <code>oracle.offchain-price-missing</code>,{' '}
        <code>oracle.already-paused</code> and{' '}
        <code>oracle.token-already-frozen</code>.
        The keeper is a liveness aid, not a trust root: every action it takes is
        one anyone could take.
      </p>

      <h2>Residual risks</h2>
      <p>
        Some risks cannot be engineered away and are stated plainly so that you
        can weigh them.
      </p>
      <ul>
        <li>
          <strong>Smart-contract risk.</strong> Bugs may remain despite testing.
          A bug could cause the loss of some or all of the funds held in the
          contracts.
        </li>
        <li>
          <strong>Counterparty and custody risk.</strong> PAXG depends on Paxos
          honouring custody and not freezing the protocol's addresses, and XAUT
          will depend on Tether once activated. Silos raise the cost of a
          freeze; a second issuer would reduce single-custodian exposure;
          neither removes the risk.
        </li>
        <li>
          <strong>A depeg specific to PAXG.</strong> Liquidation values PAXG at
          no less than the gold price, so if PAXG alone fell below gold while
          gold held, vaults would not be liquidated for it and GSUSD holders
          would carry the loss. Borrowing and reserve swaps stop while PAXG is
          off the gold band. This is an accepted trade-off.
        </li>
        <li>
          <strong>Oracle outage.</strong> If either Chainlink feed stops, every
          priced path for the token waits, liquidation included, until both
          answer again. Repayment and deposits stay open.
        </li>
        <li>
          <strong>Regulatory action.</strong> Regulatory intervention against an
          issuer or the protocol could affect collateral or operations.
        </li>
        <li>
          <strong>MEV on small swaps.</strong> Small stability swaps can be
          exposed to value extraction by block producers; the caller&rsquo;s{' '}
          <code>minGoldOut</code> bound mitigates but does not eliminate this.
        </li>
        <li>
          <strong>Tail-event depeg.</strong> If the gold price were to fall more
          than 50% within minutes, liquidations might not keep pace and the peg
          could come under strain.
        </li>
      </ul>
      <Callout variant="danger" title="Not financial advice">
        <p>
          This is experimental{IS_MAINNET_BUILD ? '' : ', pre-launch'} software.
          Interacting with it carries the risks above and
          others. Nothing in this documentation is
          financial advice. Read <Link to="/docs/governance">Governance</Link>,{' '}
          <Link to="/docs/oracle">Oracle</Link> and{' '}
          <Link to="/docs/parameters">Risk parameters</Link> before depositing
          anything you cannot afford to lose.
        </p>
      </Callout>
    </Prose>
  );
}
