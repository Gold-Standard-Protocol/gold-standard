import { BaseError, ContractFunctionRevertedError, ContractFunctionZeroDataError } from 'viem';
import { IS_MAINNET_BUILD } from './network';

/**
 * Turns a viem contract error into something a borrower can act on.
 *
 * The simulation already tells us exactly why a transaction would fail, the vault
 * reverts with a specific reason string, and wagmi's useSimulateContract surfaces it.
 * That reason was previously fetched and thrown away: the UI used it only to disable
 * the confirm button, so a user hitting the per-block mint cap saw a dead button and
 * no explanation, and reasonably concluded the app was broken.
 *
 * Every message below answers "what do I do now", because a reason string alone
 * ("Per-block mint cap reached") does not tell anyone what amount would work.
 */
type Advice = string | ((ctx: TxErrorContext) => string);

/**
 * What the user is trying to do, so the advice matches the button they pressed.
 * Without this the copy gave repay advice on a deposit ("you do not hold enough
 * GSUSD" when the shortfall was PAXG) and mint advice on a withdrawal ("deposit more
 * gold first" when they were trying to take gold out).
 */
export interface TxErrorContext {
  action?:
    | 'deposit'
    | 'mint'
    | 'repay'
    | 'withdraw'
    | 'swap'
    | 'dex-swap'
    | 'pool-deposit'
    | 'pool-withdraw' | 'pool-liquidate';
  /** The token whose balance or allowance is in play, e.g. 'PAXG'. */
  tokenSymbol?: string;
}

/** The same constraint reads differently depending on which side you approached it from. */
const RATIO_ADVICE: Partial<Record<NonNullable<TxErrorContext['action']>, string>> = {
  withdraw: 'Withdraw less gold, or repay some debt first.',
  mint: 'Mint less, or deposit more gold first.',
};

/** The actions that read the oracle's borrow price, which refuses any price off the gold band. */
const BORROWING_ACTIONS: ReadonlySet<TxErrorContext['action']> = new Set<TxErrorContext['action']>(['mint', 'withdraw']);

/**
 * A lookup rather than a ternary. The first version special-cased `withdraw` and let
 * everything else fall through to MINT advice, which is only correct for one of the
 * seven declared actions, so any new call site would have silently inherited advice for
 * an action the user was not taking. With no action known, state the constraint and
 * offer no direction at all.
 */
const ratioAdvice = (ctx: TxErrorContext): string => {
  const tail = ctx.action ? RATIO_ADVICE[ctx.action] : undefined;
  return `That would push the vault below the minimum collateral ratio.${
    tail ? ` ${tail}` : ''
  }`;
};

/**
 * What a Uniswap quote or swap failing without a reason means in practice. QuoterV2
 * reverts with "swaps entirely within 0-liquidity regions are not supported" when a
 * pool exists but is empty, and with NO data at all when the pool contract is missing
 * (the router computes the pool address and calls it blind). Neither is a fault the
 * user can fix from this page; the reserve leg is the honest alternative.
 */
const NO_DEX_LIQUIDITY =
  'No DEX liquidity for this pair yet. The pool may not exist at this fee tier, or it holds no liquidity. The reserve swap is still available.';

const REVERT_MESSAGES: Record<string, Advice> = {
  'Per-block mint cap reached':
    'That is more GSUSD than the protocol will mint in a single block. Mint a smaller amount, or split it across separate transactions.',
  'Below min collateralisation ratio': ratioAdvice,
  'Below min ratio': ratioAdvice,
  // GoldVault.mint is the only source of this string, so the caller always has zero or
  // near-zero debt. Advising them to "repay the position in full" was unactionable.
  // A mainnet build names only the mainnet figure.
  'Below minimum debt': IS_MAINNET_BUILD
    ? 'Vaults must carry at least the minimum debt (1,000 GSUSD at the mainnet launch). Mint at least that much, or none at all.'
    : 'Vaults must carry at least the minimum debt (100 GSUSD on Sepolia, 1,000 at the mainnet launch). Mint at least that much, or none at all.',
  'Remaining debt below minimum':
    'That would leave a position too small to be liquidated safely. Repay the full balance instead.',
  // GoldStabilityReserve.swapGsusdForGold. Every one of these is a reserve-side
  // limit: the caller holds GSUSD and is drawing on protocol gold, never on a vault.
  'Reserve insufficient':
    'The reserve does not hold enough of this gold token above its floor for that swap. Swap a smaller amount, or choose another reserve asset if one is listed.',
  'Daily cap reached':
    'This gold token has reached its daily swap limit. Swap a smaller amount, or return after the daily window resets.',
  'Aggregate daily cap reached':
    'The reserve has reached its total daily swap limit across all gold tokens. Return after the daily window resets.',
  'Asset paused':
    'Swaps into this gold token are paused by the guardian. Another listed reserve asset may still be available.',
  'Unsupported token':
    'The reserve does not hold this gold token.',
  'Swap too small':
    'This amount is too small to swap: the gold output rounds to zero at the current price.',
  'Slippage':
    'The oracle price moved and the swap would deliver less gold than your minimum. Refresh the quote, or widen the price tolerance.',
  // Uniswap v3 SwapRouter02 and pool reverts, reached through the market swap leg.
  // The router's own reason strings are terse three-letter codes; spell them out.
  'Too little received':
    'The pool price moved and the swap would deliver less than your minimum. Refresh the quote, or widen the price tolerance.',
  // The deadline is set from this device's clock; a clock that runs behind sends a
  // deadline the router has already passed.
  'Transaction too old':
    'The swap deadline had already passed when the router checked it. This usually means this device clock is behind: correct the clock, then refresh the quote.',
  STF: (ctx) => {
    const token = ctx.tokenSymbol ?? 'tokens';
    return `The router could not pull your ${token} (safe transfer failed). This is usually an allowance or balance shortfall: approve the router for ${token}, and check you hold enough of it.`;
  },
  SPL: 'The swap would push the pool past its price limit. Swap a smaller amount.',
  'swaps entirely within 0-liquidity regions are not supported': NO_DEX_LIQUIDITY,
  'Debt ceiling reached':
    'This collateral has reached the debt ceiling governance set for it. No further GSUSD can be minted against it until existing debt is repaid or governance raises the ceiling through the timelock.',
  'Insufficient collateral':
    'You do not have that much collateral in your vault.',
  'Collateral type not active':
    'That collateral is not currently accepted by the protocol.',
  'Collateral token mismatch':
    'Your vault already holds a different collateral. Close it before depositing another gold token.',
  'Exceeds vault debt': 'That is more than this vault owes.',
  'No debt': 'This vault has no debt to repay.',
  'No collateral': 'This vault holds no collateral.',
  'No price':
    'The oracle has no price for this collateral right now: one of its two price feeds is stale or invalid, and even the emergency path never liquidates on an old price. Try again once both feeds answer.',
  'Zero amount': 'Enter an amount above zero.',
  // GoldVault.deposit: the transfer delivered nothing to the vault. PAXG and XAUT charge no
  // transfer fee today, so this is reached only if an issuer switches one on and the
  // amount is small enough for the fee to take all of it.
  'Nothing credited':
    'The transfer delivered no collateral to the vault, so nothing was deposited and nothing left your wallet. Deposit a larger amount.',
  'Not undercollateralised': 'That vault is healthy and cannot be liquidated.',
  'Pool insufficient': 'The stability pool does not hold enough GSUSD to absorb this liquidation.',
  // StabilityPool.withdraw and claimCollateral: a deposit must outlive its block before
  // GSUSD or gold leaves the pool for the depositor. A wallet transaction lands in a later
  // block, so this is reached only by a contract that does both in one transaction.
  'No same-block withdrawal':
    'The pool does not pay out in the same block as your deposit. Wait for the next block, then withdraw.',
  'No same-block claim':
    'The pool does not pay out in the same block as your deposit. Wait for the next block, then claim. Your gain stays owed in full.',
  'No gains': 'You have no collateral gain to claim in this gold token.',
  'No collateral held':
    'The pool holds none of this gold token right now, so the claim cannot be paid. Your gain stays owed and can be claimed once the pool holds the gold again.',
  'Absorption would drain pool':
    'The stability pool cannot absorb this liquidation without emptying itself. Liquidate part of the debt from the pool, or repay it directly with your own GSUSD.',
  // GoldVault._sizeSeizure: below 100% plus the penalty a partial is taken pro rata, and
  // an underwater vault is liquidated in full or not at all.
  'Thin vault: liquidate in full':
    'The gold in this vault is worth less than its debt, so only a full liquidation is accepted. Use Max to close the vault.',
  'Liquidation too small': 'That amount is too small to move any collateral. Enter a larger amount.',
  'Residual debt below minimum':
    'That would leave this vault with less debt than the protocol minimum. Repay more, or liquidate the whole debt.',
  'Paused: repay in full to withdraw':
    'The vault is paused, so collateral can only be withdrawn from a vault with no debt. Repay the debt in full first.',
  // GoldOracle pricing rules (variant C). Each token is priced from two Chainlink feeds,
  // its market feed and the gold price. Borrowing and reserve swaps need the market price
  // inside the gold band; liquidation is never refused for being off the band and values
  // the token at no less than gold. A refusal stops only what needs a price: repaying and
  // depositing collateral never read one. "Feeds disagree" is gone with the second source.
  'Off gold band': (ctx) => {
    if (BORROWING_ACTIONS.has(ctx.action)) {
      return 'Borrowing against this gold token is paused while its market price sits outside the band around the gold price (2% at launch). Repaying and depositing collateral still work, and borrowing resumes on its own once the price is back inside the band.';
    }
    if (ctx.action === 'swap') {
      return 'Reserve swaps into this gold token are paused while its market price sits outside the band around the gold price (2% at launch), so the reserve never sells gold against a price that has left gold. Swaps resume on their own once the price is back inside the band.';
    }
    return 'This gold token\'s market price sits outside the band around the gold price (2% at launch), so borrowing against it and reserve swaps into it are paused. Liquidation is not refused for this reason. Repaying and depositing collateral still work, and everything resumes on its own once the price is back inside the band.';
  },
  'No reliable price':
    'There is no reliable price for this gold token right now: its Chainlink market feed or the Chainlink gold price is stale or invalid, so the oracle refuses rather than guess. Borrowing, liquidation and reserve swaps resume on their own once both feeds answer again. Repaying and depositing collateral still work.',
  // The guardian's manual emergency stop for one token. There is no permissionless trip.
  'Token frozen': (ctx) =>
    ctx.action === 'swap'
      ? 'The guardian has frozen pricing for this gold token, so the reserve cannot swap it until the freeze is lifted.'
      : 'The guardian has frozen pricing for this gold token as an emergency stop, so minting, withdrawing against debt, liquidation and reserve swaps in this token are paused until the freeze is lifted or lapses after 14 days. Repaying, depositing collateral and withdrawing from a vault without debt still work.',
  'Not frozen': 'This gold token is not frozen, so there is no freeze to lift.',
  'Feed not independent':
    'A token\'s market feed and the gold reference must be independent: the oracle will not use one feed as both.',
  'No oracle feed':
    'The oracle has no price feed for this token, so the reserve cannot list it. Add the oracle feed first.',
};

/**
 * Raw 4-byte selectors, for reverts viem cannot decode because the custom error is not
 * in the ABI it was given. Without this the user sees literal text like
 * 'reverted with the following signature: 0xfb8f41b2'. The ABI now carries the two
 * ERC20 errors, so this is a fallback rather than the primary path, but any contract
 * the vault calls can revert with something the dapp's hand-written ABI subset omits.
 */
const SELECTOR_MESSAGES: Record<string, string> = {
  '0xfb8f41b2': 'ERC20InsufficientAllowance',
  '0xe450d38c': 'ERC20InsufficientBalance',
};

/** Balance shortfalls are custom errors, not reason strings, so match on the name. */
const CUSTOM_ERROR_MESSAGES: Record<string, Advice> = {
  ERC20InsufficientBalance: (ctx) => {
    const token = ctx.tokenSymbol ?? 'tokens';
    // Only a repayment carries the fee explanation; on a deposit it is simply a
    // shortfall of gold, and mentioning GSUSD there is actively confusing.
    if (ctx.action === 'repay') {
      return `You do not hold enough ${token} for this. Debt accrues a stability fee every second, so closing a position needs slightly more ${token} than you originally minted.`;
    }
    return `You do not hold enough ${token} for this.`;
  },
  ERC20InsufficientAllowance: (ctx) =>
    `This contract is not yet approved to move your ${
      ctx.tokenSymbol ?? 'tokens'
    }. Approve first, then retry.`,
  // OpenZeppelin Pausable. Without these a guardian pause read as viem's generic
  // 'The contract function "mint" reverted.', at exactly the moment users are most
  // anxious, and nothing said which actions still work or that the pause is temporary.
  EnforcedPause: (ctx) =>
    ctx.action === 'pool-deposit' || ctx.action === 'pool-withdraw'
      ? 'The guardian has paused this action. Claiming collateral gains from the pool still works. Try again later.'
      : 'The guardian has paused this action. Repaying, depositing collateral and withdrawing from a vault without debt still work. Try again later.',
  // Only a guardian call that requires a paused contract (unpause) raises this.
  ExpectedPause: 'This action is only available while the protocol is paused, and it is not paused now.',
};

/** Advice may depend on what the user was doing; resolve it against the context. */
const resolve = (advice: Advice, ctx: TxErrorContext): string =>
  typeof advice === 'function' ? advice(ctx) : advice;

/**
 * @returns A sentence to show the user, or undefined when there is no error.
 */
export function describeTxError(
  error: unknown,
  context: TxErrorContext = {}
): string | undefined {
  if (!error) return undefined;

  if (error instanceof BaseError) {
    const revert = error.walk((e) => e instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError) {
      const custom = revert.data?.errorName;
      if (custom && CUSTOM_ERROR_MESSAGES[custom]) {
        return resolve(CUSTOM_ERROR_MESSAGES[custom], context);
      }
      const reason = revert.reason;
      if (reason) {
        const mapped = REVERT_MESSAGES[reason];
        return mapped ? resolve(mapped, context) : reason;
      }
    }

    // A market swap that reverts with nothing to decode is a missing pool, not a
    // mystery. Keyed on the action so a bare revert on a vault flow still surfaces
    // viem's own wording rather than a claim about DEX liquidity.
    if (context.action === 'dex-swap' && isEmptyRevert(error)) {
      return NO_DEX_LIQUIDITY;
    }

    // Undecodable custom error: recover the selector from anywhere it appears.
    const selector = findSelector(error);
    if (selector) {
      const named = SELECTOR_MESSAGES[selector];
      if (named && CUSTOM_ERROR_MESSAGES[named]) {
        return resolve(CUSTOM_ERROR_MESSAGES[named], context);
      }
    }

    // User rejections are not failures worth alarming anyone about.
    if (/user rejected|denied transaction/i.test(error.shortMessage ?? '')) {
      return 'You rejected the transaction in your wallet.';
    }
    if (error.shortMessage) return error.shortMessage;
  }

  if (error instanceof Error && error.message) {
    // Last resort: a raw message is still better than a silently dead button.
    return error.message.split('\n')[0];
  }
  return 'Your wallet could not prepare this transaction. Check it is unlocked and on the right network, then try again.';
}

/**
 * True when the call failed with no reason string, no custom error and no return data:
 * the shape of a Uniswap call against a pool address that has no contract behind it.
 */
function isEmptyRevert(error: BaseError): boolean {
  const cause = error.walk(
    (e) => e instanceof ContractFunctionRevertedError || e instanceof ContractFunctionZeroDataError
  );
  if (cause instanceof ContractFunctionZeroDataError) return true;
  if (cause instanceof ContractFunctionRevertedError) {
    return !cause.reason && !cause.data?.errorName && !cause.signature;
  }
  return false;
}

/** Pulls a 4-byte error selector out of a viem error, however it was reported. */
function findSelector(error: BaseError): string | undefined {
  const revert = error.walk((e) => e instanceof ContractFunctionRevertedError);
  if (revert instanceof ContractFunctionRevertedError && revert.signature) {
    return revert.signature.toLowerCase();
  }
  // viem puts the selector in the message when it cannot decode it.
  const match = /0x[0-9a-fA-F]{8}\b/.exec(error.message ?? '');
  return match ? match[0].toLowerCase() : undefined;
}
