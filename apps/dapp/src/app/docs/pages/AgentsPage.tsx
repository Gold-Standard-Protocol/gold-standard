import { Link } from 'react-router-dom';
import { Callout, DocTable, Lead, Prose, Steps } from '../components/DocComponents';
import { IS_MAINNET_BUILD, NETWORK_NAME } from '../../lib/network';

/** The public repository, when the build names one; the long guide and the quickstart live in it. */
const SOURCE_URL = (import.meta.env['VITE_SOURCE_URL'] as string | undefined)?.trim().replace(/\/+$/, '');

/** The contracts whose ABIs the site serves as JSON under /abi/, in the order the manifest lists them. */
const ABI_CONTRACTS = [
  'GoldVault',
  'VaultRegistry',
  'GoldStablecoin',
  'GoldOracle',
  'GoldStabilityReserve',
  'StabilityPool',
  'StabilityModule',
  'SurplusBuffer',
  'SiloFactory',
  'GoldGovernance',
] as const;

function GuideLink() {
  if (!SOURCE_URL) {
    return <code>docs/AGENTS.md</code>;
  }
  return (
    <a
      className="text-primary underline underline-offset-4"
      href={`${SOURCE_URL}/blob/main/docs/AGENTS.md`}
      target="_blank"
      rel="noreferrer noopener"
    >
      <code>docs/AGENTS.md</code>
    </a>
  );
}

function AbiLinks() {
  return (
    <>
      {ABI_CONTRACTS.map((name, index) => (
        <span key={name}>
          {index > 0 ? ', ' : ''}
          <a className="text-primary underline underline-offset-4" href={`/abi/${name}.json`}>
            <code>{name}</code>
          </a>
        </span>
      ))}
    </>
  );
}

export default function AgentsPage() {
  return (
    <Prose>
      <Lead>
        Everything the dapp does can be done with contract calls alone. This page is the short
        form of the guide for software that uses Gold Standard without a browser: an autonomous agent,
        a keeper, a treasury script or an analyst&apos;s notebook. It names where the truth lives,
        the conventions that must not be guessed and the calls behind every action.
      </Lead>

      <Callout variant="warning" title="Verify before you trust">
        <p>
          An address in a chat, a page or a search result is a claim. The manifest below is the
          address book, and every deployment in it carries a verification list that covers each
          listed address: the stablecoin&apos;s minter is the vault, the vault points at the
          registry and the registry at the vault, the oracle names the tokens it prices and the
          timelock holds every admin role. Replay the whole list and refuse the set if any call
          disagrees. This build targets {NETWORK_NAME}
          {IS_MAINNET_BUILD ? '.' : '; mainnet is not yet deployed.'}
        </p>
      </Callout>

      <h2>Three things an agent needs</h2>
      <DocTable
        head={['Need', 'Where']}
        rows={[
          [
            'The address book, machine readable',
            <>
              <a className="text-primary underline underline-offset-4" href="/agents.json">
                <code>/agents.json</code>
              </a>
              , schema <code>goldstandard-agents/1</code>: every address, token, ratio and convention
              of each deployment, generated from the deployment snapshot so nothing is retyped.{' '}
              <a className="text-primary underline underline-offset-4" href="/llms.txt">
                <code>/llms.txt</code>
              </a>{' '}
              points language models at it. Each deployment carries a <code>verification</code>{' '}
              list: calls with the name of the address they target, their calldata and the exact
              word they must return, so the address set can be proved self-consistent with no ABI
              at all. A list that is empty, leaves an address unproven or calls somewhere other
              than the address it names is a reason to refuse the whole set.
            </>,
          ],
          [
            'The ABIs',
            <>
              Served as JSON from this site, one file per contract: <AbiLinks />. The manifest
              links to the same files, so nothing depends on a code host.
            </>,
          ],
          [
            'The guide',
            <>
              <GuideLink />: verification steps, conventions, every read and action with its exact
              call, the refusal strings and the permissionless maintenance calls. Beside it,{' '}
              <code>tools/agent-quickstart.mjs</code> refuses a manifest from elsewhere whose
              addresses differ from the address book it ships with (and any manifest whose entry
              describes another chain than the one it is filed under), checks the wiring with calls it
              builds itself, then replays the manifest&apos;s list as the manifest&apos;s claims and
              lists every open vault in one short file. The list proves a set agrees with its
              manifest, not that the manifest is genuine, so take it from this site.
            </>,
          ],
          [
            'The list of positions',
            <>
              <code>VaultRegistry</code>, maintained by the vault itself after every change, so a
              liquidator or an analyst needs no indexer. Its address is on the{' '}
              <Link to="/docs/contracts">contracts page</Link>.
            </>,
          ],
        ]}
      />

      <h2>Conventions that must not be guessed</h2>
      <DocTable
        head={['Convention', 'Value']}
        rows={[
          ['Ratios', <>parts per million; <code>1,000,000</code> is 100% and <code>1,300,000</code> is 130%</>],
          ['Prices', <>USD per whole token with 8 decimals, from <code>GoldOracle</code></>],
          ['GSUSD', <>18 decimals, ERC-20 with <code>permit</code></>],
          [
            'Collateral amounts',
            <>
              the token&apos;s own decimals, PAXG 18 and XAUT 6. Read <code>decimals()</code> from
              the token; never assume.
            </>,
          ],
          [
            'Debt',
            <>
              <code>getVaultCurrentDebt(owner)</code> includes the accrued stability fee; the raw
              vault record does not
            </>,
          ],
          ['Repay', <><code>repay(amount)</code> caps at the current debt, so an overshoot closes the position</>],
          [
            'Liquidate',
            <>
              a <code>debtToRepay</code> of zero repays the whole debt; a positive amount is a
              partial. Between 100% and 100% plus the penalty a partial is taken pro rata; an
              underwater vault, below 100%, accepts only a full liquidation.
            </>,
          ],
          [
            'Minting',
            <>
              only the vault holds <code>MINTER_ROLE</code>. The minter set stays changeable by
              governance until <code>lockMinters(vault)</code> is called, which succeeds only while
              the vault is the sole minter; read <code>GoldStablecoin.mintersLocked()</code> to
              check, and the manifest&apos;s <code>minting</code> entry says what the snapshot
              recorded.
            </>,
          ],
          [
            'Minimum debt',
            <>
              <code>minDebt()</code>, governed;{' '}
              {IS_MAINNET_BUILD ? '1,000 GSUSD at the mainnet launch.' : '100 GSUSD on Sepolia and 1,000 at the mainnet launch.'}{' '}
              A mint or partial repay that leaves less is refused.
            </>,
          ],
          [
            'Gas',
            <>
              the vault requires 375,000 gas in hand before its registry hook, so a real node&apos;s
              estimate already includes it. Send the estimate with a buffer, never a hand-picked
              limit.
            </>,
          ],
          [
            'Pauses',
            <>
              <code>paused()</code> on the vault, the oracle and the pool; a pause lapses after 14
              days unless extended, and <code>unpauseExpired()</code> is then open to anyone. A
              reserve asset is paused while <code>assetPaused(token)</code> is true, and that pause
              lapses by itself.
            </>,
          ],
        ]}
      />

      <h2>Read the protocol</h2>
      <p>
        All reads are view calls. The registry is the entry point; the vault and the oracle give
        the figures a decision needs.
      </p>
      <DocTable
        head={['Question', 'Call']}
        rows={[
          ['How many vaults are open, and whose', <><code>VaultRegistry.vaultOwnerCount()</code>, then <code>vaultOwners(offset, limit)</code> in pages</>],
          [
            'One vault at a glance',
            <>
              <code>VaultRegistry.vaultSummary(owner)</code>: token, collateral, debt, ratio,
              liquidation price and whether it is liquidatable
            </>,
          ],
          [
            'Which vaults are liquidatable now',
            <>
              <code>VaultRegistry.liquidatableVaults(offset, limit)</code> or{' '}
              <code>isLiquidatable(owner)</code>, a hint at the last known price that can miss a
              vault while the price falls. The vault itself prices off{' '}
              <code>quoteTokenPrice(token)</code>, which needs both Chainlink feeds healthy; the
              guide gives the exact test
            </>,
          ],
          [
            'Collateral rules for a token, and whether it is active',
            <>
              <code>VaultRegistry.collateralTypeOf(token)</code>. At launch only PAXG is active;
              XAUT is registered in the oracle but is not a collateral, reserve asset or pool token
              until governance activates it
            </>,
          ],
          ['Current debt including fees', <code>GoldVault.getVaultCurrentDebt(owner)</code>],
          [
            'Stability fee',
            <>
              <code>StabilityModule.stabilityFeeRate(VaultRegistry.collateralIdOf(token))</code>, a
              per-second multiplier with 18 decimals; debt grows by it every second
            </>,
          ],
          [
            'A usable price',
            <>
              <code>GoldOracle.quoteTokenPrice(token)</code> (liquidation, the higher of the market
              feed and gold capped at the liquidation cap above gold),{' '}
              <code>quoteBorrowPrice(token)</code> (minting and withdrawing against debt) and{' '}
              <code>quoteReservePrice(token)</code> (reserve swaps) answer exactly as the
              transactions would, reverting with the same reason when the rules give no price
            </>,
          ],
          ['Whether a token is frozen', <><code>GoldOracle.tokenFrozen(token)</code>, set only by the guardian or governance</>],
          [
            'Swap terms',
            <>
              <code>GoldStabilityReserve.quoteGoldOut(token, gsusdIn)</code> returns the gold out
              and the spread this exact swap pays; <code>(0, 0)</code> means it would be refused
            </>,
          ],
          ['Pool position', <><code>StabilityPool.getEffectiveDeposit(user)</code> and <code>getCollateralGain(user, token)</code></>],
        ]}
      />

      <h2>Act on the protocol</h2>
      <p>
        Simulate every call from the sending address before sending it; the refusal strings are
        exact and stable, and the guide lists them. Approve only what the next call needs.
      </p>
      <Steps
        steps={[
          {
            title: 'Open and manage a vault',
            detail: (
              <>
                <code>token.approve(vault, amount)</code>, <code>GoldVault.deposit(token, amount)</code>,{' '}
                <code>GoldVault.mint(gsusd)</code>. Repay with <code>GSUSD.approve(vault, amount)</code>{' '}
                and <code>GoldVault.repay(amount)</code>; withdraw with{' '}
                <code>GoldVault.withdraw(amount)</code> in the collateral token&apos;s decimals. The
                fee accrues every second, so a full repayment approves and passes the debt plus a
                small margin; the vault takes only the debt at execution. A withdrawal to zero with
                no debt closes the vault.
              </>
            ),
          },
          {
            title: 'Liquidate',
            detail: (
              <>
                Direct: <code>GSUSD.approve(vault, debt)</code> with a small margin for the fee,
                then{' '}
                <code>GoldVault.liquidate(owner, 0)</code>, paid in collateral straight from
                custody. Through the pool: <code>GoldVault.liquidateViaPool(owner, 0)</code> needs
                no GSUSD of your own. The shares of the penalty are on the{' '}
                <Link to="/docs/liquidations">liquidations page</Link>.
              </>
            ),
          },
          {
            title: 'Provide to the stability pool',
            detail: (
              <>
                <code>GSUSD.approve(pool, amount)</code>, <code>StabilityPool.deposit(amount)</code>.
                Withdrawals and claims wait one block after your latest deposit;{' '}
                <code>claimCollateral(token)</code> collects the gold gained from liquidations.
              </>
            ),
          },
          {
            title: 'Swap GSUSD for reserve gold',
            detail: (
              <>
                Quote first, then <code>GSUSD.approve(reserve, gsusdIn)</code> and{' '}
                <code>GoldStabilityReserve.swapGsusdForGold(token, gsusdIn, minGoldOut)</code>. The
                swap draws only on protocol-owned gold and holds to the depth of the reserve.
              </>
            ),
          },
        ]}
      />

      <h2>Permissionless maintenance</h2>
      <p>
        These calls need no role. Each protects the protocol or a position, and a watcher that
        depends on the liquidation flow has every reason to make them.
      </p>
      <DocTable
        head={['Call', 'When']}
        rows={[
          [<code>GoldOracle.getTokenPrice(token)</code>, 'the last known price the views read should be refreshed from the feeds (a transaction, not a view); it reverts with "No reliable price" while either feed is unhealthy. The oracle needs no call to price: liquidation resumes by itself on the next healthy pair of feeds'],
          [<code>VaultRegistry.sync(owner)</code>, 'a VaultRegistrySyncFailed event shows a listing drifted'],
          [<code>unpauseExpired()</code>, 'a pause is older than fourteen days'],
          [<code>SiloFactory.createSilos(token, count)</code>, 'missingSilos(token) is above zero, which happens only after governance moved the deposit cursor. It creates the silos the next deposit would otherwise create itself, at most 16 a call, and moves no funds. Read missingSilos(token) before every call and stop at zero'],
          [<code>GoldVault.retryBadDebtAbsorption()</code>, 'bad debt is outstanding and the surplus buffer holds fees again. The buffer counts only fees banked by the vault and the reserve; GSUSD sent to it by plain transfer is not counted'],
        ]}
      />

      <Callout variant="note" title="Why this exists">
        <p>
          An agent that can read a balance sheet should not need a web page to use a currency.
          The registry gives it the list of positions, the views give it the state, the refusal
          strings give it the rules and the 48 hour timelock gives it notice of change. The dapp
          is a rendering of these calls, not a gate in front of them.
        </p>
      </Callout>
    </Prose>
  );
}
