import { Link } from 'react-router-dom';
import { Callout, DocTable, Lead, Prose, Steps } from '../components/DocComponents';
import { IS_MAINNET_BUILD } from '../../lib/network';

export default function GettingStartedPage() {
  return (
    <Prose>
      <Lead>
        Opening a Gold Standard vault takes a few minutes: connect a wallet, deposit
        tokenised gold and mint GSUSD against it. This page covers what you need
        beforehand, which networks are supported and the exact steps to your
        first position.
      </Lead>

      <h2>Before you start</h2>
      <p>
        Gold Standard runs entirely from your wallet. There is no account to create and
        no sign-up. You will need three things.
      </p>
      <ul>
        <li>
          <strong>An Ethereum wallet.</strong> A browser wallet such as MetaMask,
          or any wallet that supports WalletConnect.
        </li>
        <li>
          <strong>Some ETH for gas.</strong> Every transaction (depositing,
          minting, repaying) is an on-chain action that costs network fees.
        </li>
        <li>
          <strong>Gold collateral.</strong> PAXG (Paxos Gold) to deposit. Tether
          Gold (XAUT) is registered but inactive until governance activates it;
          the deposit form offers only the collateral the vault accepts. See the{' '}
          <Link to="/docs/collateral">Collateral</Link> page.
        </li>
      </ul>

      <h2>Supported networks</h2>
      {/* The network copy follows the build's target chain. */}
      {IS_MAINNET_BUILD ? (
        <>
          <p>
            Gold Standard runs on Ethereum mainnet. This app connects to mainnet only: a
            wallet on any other network is asked to switch before it can act.
          </p>
          <Callout variant="warning" title="Experimental software">
            <p>
              Gold Standard is experimental software. Read the full risk disclosure on the{' '}
              <Link to="/docs/security">Security</Link> page before you deposit.
            </p>
          </Callout>
        </>
      ) : (
        <>
          <p>
            Gold Standard targets Ethereum mainnet for production. While the protocol is
            pre-launch, it runs on the Sepolia testnet so you can rehearse the full
            flow without real funds.
          </p>

          <DocTable
            head={['Network', 'Status', 'What you need']}
            rows={[
              [
                'Ethereum mainnet',
                'Production target, not yet deployed',
                'Real ETH and real PAXG (once live)',
              ],
              [
                'Sepolia testnet',
                'Live now for testing, with mock collateral and team-controlled price feeds',
                'Sepolia ETH from a public faucet, plus mock PAXG that anyone can mint from the Sepolia test token contract',
              ],
            ]}
          />

          <Callout variant="warning" title="You are using a testnet build">
            <p>
              Production contracts are not yet deployed. Use Sepolia to learn the flow
              with test funds only. Do not send mainnet
              assets to testnet addresses. See{' '}
              <Link to="/docs/security">Security</Link> for the full risk disclosure.
            </p>
          </Callout>
        </>
      )}

      <h2>Open your first vault and mint GSUSD</h2>
      <p>
        The flow below opens a vault, deposits gold and mints GSUSD while keeping
        the position safely above the minimum collateral ratio. You can follow it
        live in the <Link to="/vault">vault app</Link>.
      </p>

      <Steps
        steps={[
          {
            title: 'Connect your wallet',
            detail: (
              <>
                Open the <Link to="/vault">vault app</Link> and connect MetaMask
                or your WalletConnect wallet.{' '}
                {IS_MAINNET_BUILD
                  ? 'Confirm your wallet is on Ethereum mainnet.'
                  : 'Confirm you are on the Sepolia testnet while Gold Standard is pre-launch.'}
              </>
            ),
          },
          {
            title: 'Deposit tokenised gold',
            detail: (
              <>
                Choose a gold token the vault accepts, approve it and deposit it as
                collateral. Your gold is locked in a vault that only you control;
                Gold Standard never takes custody. The{' '}
                <Link to="/docs/vaults">Vaults</Link> page explains how custody
                and collateral work.
              </>
            ),
          },
          {
            title: 'Mint GSUSD within the 130% ratio',
            detail: (
              <>
                Draw GSUSD against your collateral, keeping the vault at or above
                the 130% minimum collateral ratio. A larger buffer leaves more
                room before the 110% liquidation threshold. Minting must clear the
                minimum debt{' '}
                {IS_MAINNET_BUILD
                  ? '(governance sets it; mainnet opens at 1,000 GSUSD). Mainnet launches with no debt ceiling and no per-block mint cap.'
                  : '(100 GSUSD on Sepolia; governance sets it, and mainnet opens at 1,000). Mainnet launches with no debt ceiling and no per-block mint cap, and Sepolia runs the same profile.'}{' '}
                See{' '}
                <Link to="/docs/minting-redeeming">Minting and swapping</Link>{' '}
                for the mechanics.
              </>
            ),
          },
          {
            title: 'Manage, repay or swap',
            detail: (
              <>
                Watch your collateral ratio and top up collateral or repay GSUSD
                to stay clear of liquidation. Deposits and repayments stay open
                even while the vault is paused, so you can always defend a
                position, and repaying more than you owe is capped to a full
                close. Repay your debt to release the gold, or swap GSUSD for
                protocol-owned gold from the Stability Reserve at the oracle
                price minus a small spread. Every submitted transaction links to
                Etherscan so you can confirm it landed. Read{' '}
                <Link to="/docs/liquidations">Liquidations</Link> to understand
                what happens if a vault falls below the threshold.
              </>
            ),
          },
        ]}
      />

      <Callout variant="tip" title="Leave yourself a safety margin">
        <p>
          Minting right at 130% leaves no room for the gold price to move before
          your vault risks liquidation at 110%. Opening with a higher ratio, or
          minting less than the maximum, gives the position a healthier buffer.
        </p>
      </Callout>

      <h2>Where to go next</h2>
      <ul>
        <li>
          <Link to="/docs/vaults">Vaults</Link>. How collateral custody, debt
          and the collateral ratio work in detail.
        </li>
        <li>
          <Link to="/docs/minting-redeeming">Minting and swapping</Link>. The
          full mint, repay and stability swap flow, including the spread.
        </li>
        <li>
          <Link to="/docs/parameters">Parameters</Link>. Every ratio, cap and
          fee in one reference table.
        </li>
        <li>
          <Link to="/transparency">Transparency</Link>. The on-chain proof of
          reserves backing GSUSD.
        </li>
      </ul>
    </Prose>
  );
}
