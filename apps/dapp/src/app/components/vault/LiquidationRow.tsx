import { useState, useCallback, useEffect, useRef } from 'react';
import { useReadContract } from 'wagmi';
import { ChevronDownIcon } from '@heroicons/react/20/solid';
import { CheckCircleIcon } from '@heroicons/react/24/outline';
import { formatUnits, parseUnits } from 'viem';
import { Button, Input } from '@goldstandard/ui';
import { tryParseCurrencyAmount } from '@goldstandard/utils';
import {
  useCollateralParams,
  useCollateralToken,
  useGsusdToken,
  useLiquidate,
  useLiquidateViaPool,
  useOraclePrice,
  type WriteFn,
} from '@goldstandard/hooks';
import * as Guard from '../Guard';
import { describeTxError } from '../../lib/txError';
import type { UndercollateralisedVault } from '@goldstandard/hooks';
import { TARGET_CHAIN_ID, getGoldVaultContractConfig, type GoldVaultChainId } from '@goldstandard/constants';
import { keeperBounty, previewLiquidation } from '../../lib/liquidationPlan';
import {
  formatNumber,
  formatPercent,
  formatTokenAmount,
  shortAddress,
} from '../../lib/format';
import { TokenPill } from '../TokenPill';

/** Which route carried a confirmed liquidation. */
export type LiquidationRoute = 'direct' | 'pool';

interface LiquidationRowProps {
  vault: UndercollateralisedVault;
  chainId: GoldVaultChainId;
  /**
   * Called once a liquidation of this vault confirms. The list re-reads on confirmation,
   * so a vault that is no longer eligible leaves it, and this row with its success line;
   * the table keeps the outcome on screen instead.
   */
  onConfirmed?: (owner: UndercollateralisedVault['owner'], route: LiquidationRoute) => void;
}

/** The fields of a liquidation route that say how its last attempt stands. */
interface RouteAttempt {
  writeError?: Error | null;
  isWritePending: boolean;
  txHash?: string;
  confirmationStatus: string;
}

/** What a route's last attempt came to, for the line under its button. Pure and exported for tests. */
export function attemptOutcome(route: RouteAttempt, action: 'repay' | 'pool-liquidate'): string | undefined {
  if (route.isWritePending) return undefined;
  if (route.writeError) {
    return describeTxError(route.writeError, { action, tokenSymbol: 'GSUSD' }) ?? 'Your wallet did not send this liquidation.';
  }
  if (!route.txHash) return undefined;
  if (route.confirmationStatus === 'error') return 'The liquidation was sent but reverted on-chain.';
  // A cancel is a mined self-send: the liquidation never ran.
  if (route.confirmationStatus === 'replaced') {
    return 'Your wallet cancelled or replaced this liquidation, so it was not carried out.';
  }
  // The receipt wait could not read the chain: nothing is known, so this is not a revert.
  if (route.confirmationStatus === 'unconfirmed') {
    return 'Chain read failed, retrying. The liquidation was sent and may still succeed. Check your wallet before sending it again.';
  }
  return undefined;
}

/**
 * Inside Safe{Wallet} the liquidation is a proposal to the owners of the Safe. Nothing was
 * refused and nothing failed, so this is a notice beside the route, never its alert.
 */
function proposalNotice(route: RouteAttempt): string | undefined {
  if (route.isWritePending || route.writeError || !route.txHash) return undefined;
  return route.confirmationStatus === 'proposed'
    ? 'Proposed to your Safe. The liquidation executes once the owners have signed.'
    : undefined;
}

/** A sent liquidation with no receipt yet, whether the wait is polling or cannot read the chain. */
function awaitsReceipt(route: RouteAttempt): boolean {
  return Boolean(route.txHash) && (route.confirmationStatus === 'pending' || route.confirmationStatus === 'unconfirmed');
}

export function LiquidationRow({ vault, chainId, onConfirmed }: LiquidationRowProps) {
  const [expanded, setExpanded] = useState(false);
  const [repayAmount, setRepayAmount] = useState('');
  // Max means "close the vault" and stays meaning that: it fills
  // the debt rounded up to a whole GSUSD, and once a second of fees carried the debt past
  // that figure the typed amount read as a partial, which the contract refuses for a thin
  // vault or one left below the minimum debt. Editing the amount by hand ends it.
  const [fullAtMax, setFullAtMax] = useState(false);

  // Typing the whole debt (or more) means "close the position": the call then carries 0
  // and the contract settles the fee-inclusive debt as it stands at inclusion, which no
  // typed figure can match to the wei. Anything less is a partial.
  const typedWei = (() => {
    try {
      return repayAmount ? parseUnits(repayAmount, 18) : 0n;
    } catch {
      return 0n;
    }
  })();
  const isFull = fullAtMax || (typedWei > 0n && typedWei >= vault.currentDebt);

  const direct = useLiquidate(chainId, vault.owner, repayAmount || undefined, isFull);
  const {
    write,
    isSimulationSuccess,
    isSimulationError,
    simulationError,
    isWritePending,
    txHash,
    confirmationStatus,
  } = direct;

  // Second route: the Stability Pool pays. The caller puts up no GSUSD and earns a
  // keeper bounty from the penalty; the pool takes the seized gold. Simulated
  // independently so each button reports its own reason when it cannot run.
  const pool = useLiquidateViaPool(chainId, vault.owner, repayAmount || undefined, isFull);

  // GoldVault.liquidate pulls GSUSD from the liquidator with safeTransferFrom, so the
  // vault needs an allowance. Without this guard the simulation holds an
  // ERC20InsufficientAllowance error that nothing on the page can clear, and the button
  // stays permanently disabled, liquidation was simply not executable from the UI.
  const gsusdToken = useGsusdToken(chainId);
  const vaultAddress = getGoldVaultContractConfig(chainId)?.address;
  // A full liquidation pulls the debt as it stands at inclusion, a little above the
  // figure read now, so the allowance carries a 1% margin; only what is owed is taken.
  const approvalAmount = tryParseCurrencyAmount(
    isFull ? formatUnits((vault.currentDebt * 101n) / 100n, 18) : repayAmount,
    gsusdToken
  );

  // Max rounds the live debt UP to a whole GSUSD so it is never a partial by a few
  // wei of fee accrued since the read.
  const handleMaxClick = useCallback(() => {
    const whole = (vault.currentDebt + 10n ** 18n - 1n) / 10n ** 18n;
    setRepayAmount(whole.toString());
    setFullAtMax(true);
  }, [vault.currentDebt]);

  const repayParsed = repayAmount ? Number(repayAmount) : 0;

  // The preview mirrors GoldVault.liquidate at the ORACLE price: the liquidator gets
  // the debt in gold plus liquidatorIncentiveShare of the penalty (60% of 5% = 3% at
  // defaults), and the protocol keeps the rest. The old line assumed the whole penalty
  // and priced at the market, which promised 5% where the contract pays 3%.
  // Someone else's vault may hold either gold token, so its decimals are resolved from
  // the address (falling back to the ERC-20 itself) rather than assumed to be 18.
  const collateralMeta = useCollateralToken(chainId, vault.collateralToken);
  const collateralDecimals = collateralMeta.decimals;
  const collateralSymbol = collateralMeta.symbol ?? 'gold';
  const gold = (value: bigint, digits: number) =>
    collateralDecimals === undefined ? 'n/a' : formatTokenAmount(value, collateralDecimals, digits);
  // Liquidation triggers and is sized at quoteTokenPrice: min(max(C, G), G x (1 + m)).
  const oracle = useOraclePrice(chainId, vault.collateralToken, 'liquidation');
  const params = useCollateralParams(chainId, vault.collateralToken);
  const { data: incentiveShare } = useReadContract({
    ...getGoldVaultContractConfig(chainId),
    functionName: 'liquidatorIncentiveShare',
    query: { enabled: !!getGoldVaultContractConfig(chainId) },
  });
  const { data: underwaterDiscount } = useReadContract({
    ...getGoldVaultContractConfig(chainId),
    functionName: 'underwaterDiscountPpm',
    query: { enabled: !!getGoldVaultContractConfig(chainId) },
  });
  const debtToRepay = isFull ? vault.currentDebt : typedWei;
  const preview =
    oracle.price8 !== undefined &&
    params.liquidationPenaltyPercent !== undefined &&
    typeof incentiveShare === 'bigint' &&
    typeof underwaterDiscount === 'bigint' &&
    collateralDecimals !== undefined
      ? previewLiquidation(
          debtToRepay,
          vault.currentDebt,
          vault.collateralAmount,
          oracle.price8,
          BigInt(Math.round(params.liquidationPenaltyPercent * 10_000)),
          incentiveShare,
          collateralDecimals,
          underwaterDiscount
        )
      : undefined;
  const bounty = preview && typeof incentiveShare === 'bigint' ? keeperBounty(preview, incentiveShare) : undefined;

  const detailId = `liquidation-detail-${vault.owner}`;
  const isConfirmed = txHash && confirmationStatus === 'success';
  const isPoolConfirmed = pool.txHash && pool.confirmationStatus === 'success';
  useEffect(() => {
    if (isConfirmed) onConfirmed?.(vault.owner, 'direct');
  }, [isConfirmed, onConfirmed, vault.owner]);
  useEffect(() => {
    if (isPoolConfirmed) onConfirmed?.(vault.owner, 'pool');
  }, [isPoolConfirmed, onConfirmed, vault.owner]);
  const directPending = isWritePending || awaitsReceipt(direct);
  const poolPending = pool.isWritePending || awaitsReceipt(pool);
  const transactionBusy = directPending || poolPending;
  // Both routes act on the same position. Share one synchronous click lock, then
  // hold both buttons while either wallet request or mined-receipt wait is live.
  const sending = useRef(false);
  useEffect(() => {
    if (!isWritePending && !pool.isWritePending) sending.current = false;
  }, [isWritePending, pool.isWritePending]);
  const submit = (send: WriteFn | undefined) => {
    if (sending.current || transactionBusy || !send) return;
    sending.current = true;
    send({ onSettled: () => { sending.current = false; } });
  };
  // A refused signature or a reverted liquidation used to say nothing.
  const directOutcome = attemptOutcome(direct, 'repay');
  const poolOutcome = attemptOutcome(pool, 'pool-liquidate');
  const directProposal = proposalNotice(direct);
  const poolProposal = proposalNotice(pool);

  return (
    <li className="text-sm">
      {/* Summary row: the button's name reads each value with its label. */}
      <button
        type="button"
        onClick={() => setExpanded((open) => !open)}
        aria-expanded={expanded}
        aria-controls={detailId}
        className="grid w-full grid-cols-[1.3fr_1fr_1fr_4.5rem] items-center gap-2 sm:gap-x-6 px-5 py-3.5 text-left outline-none transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <span className="flex min-w-0 items-center gap-2">
          <ChevronDownIcon
            className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${
              expanded ? 'rotate-180' : ''
            }`}
            aria-hidden
          />
          <span className="truncate font-mono text-xs text-foreground">
            <span className="sr-only">Vault owner</span>{' '}
            {shortAddress(vault.owner)}
          </span>
        </span>
        <span className="nums text-right text-foreground">
          <span className="sr-only">, collateral</span>{' '}
          {gold(vault.collateralAmount, 4)}{' '}
          <span className="text-xs text-muted-foreground">{collateralSymbol}</span>
        </span>
        <span className="nums text-right text-foreground">
          <span className="sr-only">, debt</span>{' '}
          {formatNumber(Number(formatUnits(vault.currentDebt, 18)), {
            maximumFractionDigits: 0,
          })}{' '}
          <span className="text-xs text-muted-foreground">GSUSD</span>
        </span>
        <span className="flex flex-col items-end">
          <span className="label-mono text-xs text-primary">
            <span className="sr-only">,</span> Ratio
          </span>{' '}
          <span className="nums text-primary">
            {formatPercent(vault.ratioPercent)}
          </span>
        </span>
      </button>

      {/* Expanded detail */}
      {expanded && (
        <div id={detailId} className="px-5 pb-5 pt-0">
          <div className="space-y-3.5 rounded-xl border border-border bg-muted/40 p-4">
            <div className="flex items-center justify-between rounded-lg border border-border bg-muted/40 px-3 py-2">
              <span className="label-mono text-xs text-primary">
                Collateral ratio
              </span>
              <span className="nums font-semibold text-foreground">
                {formatPercent(vault.ratioPercent)}
              </span>
            </div>

            <div className="flex items-center justify-between">
              <label
                htmlFor={`${detailId}-amount`}
                className="label-mono text-xs text-primary"
              >
                GSUSD to repay
              </label>
              <Button variant="link" size="xs" className="-my-3 -mr-2 min-h-11 justify-end px-2" onClick={handleMaxClick}>
                Max
              </Button>
            </div>
            <div className="flex items-center gap-2">
              <Input
                id={`${detailId}-amount`}
                inputMode="decimal"
                className="nums h-auto border-0 bg-transparent p-0 text-xl font-medium shadow-none focus-visible:ring-0"
                placeholder="0"
                value={repayAmount}
                onChange={(e) => {
                  setRepayAmount(e.target.value);
                  setFullAtMax(false);
                }}
              />
              <TokenPill symbol="GSUSD" />
            </div>

            {repayParsed > 0 && preview && (
              <div className="space-y-1 rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm text-foreground">
                <div className="flex items-center justify-between">
                  <span className="label-mono text-xs text-primary">
                    You receive
                  </span>
                  <span className="nums font-medium text-foreground">
                    ≈ {gold(preview.liquidatorPayout, 6)} {collateralSymbol}{' '}
                    <span className="font-normal text-muted-foreground">
                      {formatPercent(preview.bonusPercent, 2)} gold bonus
                    </span>
                  </span>
                </div>
                <p className="text-xs text-muted-foreground">
                  Seizes {gold(preview.collateralSeized, 6)} {collateralSymbol}
                  {' '}for {formatTokenAmount(preview.debtRepaid, 18, 2)} GSUSD at the oracle price; the protocol
                  keeps {gold(preview.protocolPayout, 6)} {collateralSymbol} of
                  the penalty.
                  {preview.refused
                    ? ' The gold is worth less than the debt, so the contract accepts only a full liquidation: use Max to close it.'
                    : preview.underwater
                      ? ' The gold is worth less than the debt: you repay its value less a discount and the shortfall is booked as bad debt.'
                      : preview.clamped
                        ? isFull
                          ? ' The whole vault is seized and the penalty is reduced to what remains above the debt.'
                          : ' The vault cannot pay the full penalty, so this takes the same share of the gold as of the debt and its ratio is unchanged.'
                        : ''}
                </p>
              </div>
            )}

            {/* One connection and network check for both routes:
                the deployment's own chain, whatever network the wallet is on. */}
            <Guard.Connection>
              <Guard.Chain chainId={TARGET_CHAIN_ID}>
                <div className="space-y-3.5">
                  <Guard.TokenApproval
                    amount={approvalAmount}
                    spender={vaultAddress}
                    enabled={Boolean(approvalAmount) && Boolean(vaultAddress)}
                  >
                    <Button
                      size="lg"
                      fullWidth
                      disabled={!isSimulationSuccess || transactionBusy || !write}
                      loading={directPending}
                      onClick={() => submit(write)}
                    >
                      {directPending ? 'Liquidating' : 'Liquidate position'}
                    </Button>
                  </Guard.TokenApproval>

                  {/* The simulation knows exactly why this would revert. The old copy blamed
                      the liquidator's repay amount and GSUSD balance for every failure,
                      including "Not undercollateralised", which is about the vault, not them,
                      and is the likeliest revert here because the table is built from a
                      30-second poll and a vault may have recovered since. */}
                  {repayParsed > 0 && isSimulationError && !isWritePending && (
                    <p className="text-center text-xs text-danger">
                      {describeTxError(simulationError, {
                        action: 'repay',
                        tokenSymbol: 'GSUSD',
                      }) ??
                        'This liquidation cannot be simulated. Check the repay amount and your GSUSD balance.'}
                    </p>
                  )}

                  {directOutcome && (
                    <p role="alert" className="text-center text-xs text-danger">
                      {directOutcome}
                    </p>
                  )}
                  {directProposal && (
                    <p role="status" className="text-center text-xs text-foreground">
                      {directProposal}
                    </p>
                  )}

                  {isConfirmed && (
                    <p className="flex items-center justify-center gap-1.5 text-center text-xs font-medium text-success">
                      <CheckCircleIcon className="h-4 w-4" aria-hidden />
                      Liquidation successful
                    </p>
                  )}

                  <div className="flex items-center gap-3 pt-1">
                    <span className="h-px flex-1 bg-border" aria-hidden />
                    <span className="label-mono text-xs text-muted-foreground">or</span>
                    <span className="h-px flex-1 bg-border" aria-hidden />
                  </div>

                  <div className="space-y-2">
                    <p className="text-xs leading-relaxed text-muted-foreground">
                      Let the Stability Pool pay. Pool depositors cover the debt and receive the
                      gold; you put up nothing and earn a keeper bounty from the penalty
                      {bounty !== undefined && bounty > 0n
                        ? ` (≈ ${gold(bounty, 6)} ${collateralSymbol})`
                        : ''}
                      .
                    </p>
                    <Button
                      size="lg"
                      fullWidth
                      variant="outline"
                      disabled={!pool.isSimulationSuccess || transactionBusy || !pool.write}
                      loading={poolPending}
                      onClick={() => submit(pool.write)}
                    >
                      {poolPending ? 'Liquidating via pool' : 'Liquidate from the Stability Pool'}
                    </Button>
                    {repayParsed > 0 && pool.isSimulationError && !pool.isWritePending && (
                      <p className="text-center text-xs text-danger">
                        {describeTxError(pool.simulationError, { action: 'pool-liquidate' }) ??
                          'The pool cannot fund this liquidation right now.'}
                      </p>
                    )}
                    {poolOutcome && (
                      <p role="alert" className="text-center text-xs text-danger">
                        {poolOutcome}
                      </p>
                    )}
                    {poolProposal && (
                      <p role="status" className="text-center text-xs text-foreground">
                        {poolProposal}
                      </p>
                    )}
                    {isPoolConfirmed && (
                      <p className="flex items-center justify-center gap-1.5 text-center text-xs font-medium text-success">
                        <CheckCircleIcon className="h-4 w-4" aria-hidden />
                        Liquidated from the pool; your bounty is in your wallet
                      </p>
                    )}
                  </div>
                </div>
              </Guard.Chain>
            </Guard.Connection>
          </div>
        </div>
      )}
    </li>
  );
}
