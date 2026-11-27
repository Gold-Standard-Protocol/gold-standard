import { useReadContracts } from 'wagmi';
import { keccak256, encodePacked, type Address } from 'viem';
import {
	GOLD_VAULT_MIN_DEBT,
	getGoldVaultContractConfig,
	goldVaultAbi,
	type GoldVaultChainId,
} from '@goldstandard/constants';

/** GoldVault.PRECISION — ratios are 1e6 fixed point. */
const PRECISION = 1_000_000n;
/** GoldVault.PRICE_DECIMALS — oracle prices carry 8 decimals. */
const PRICE_DECIMALS = 100_000_000n;
/** One GSUSD in its 18 decimals. */
const WAD = 10n ** 18n;

/**
 * Share of the ratio limit that Max leaves unused, in parts per 100,000 (250 = 0.25%).
 * Stability fees accrue every second and the oracle moves between blocks, so a mint sized
 * to the last decimal passes a call against the latest block and then reverts in the
 * block that includes it. The wallet saw exactly that: gas estimation failed with "Below
 * min collateralisation ratio" for a Max mint at 130.0%.
 */
export const MAX_RATIO_RESERVE_PER_100K = 250n;

export interface MintCapacity {
	/** The most GSUSD this vault can mint right now, across every binding limit. */
	available: bigint | undefined;
	/**
	 * What the Max button offers: `available` less the reserve above when the ratio is
	 * the binding limit. Typing more than this is allowed; the simulation decides.
	 */
	recommended: bigint | undefined;
	/** Which limit is binding, for an honest explanation rather than a bare number. */
	limitedBy: 'ratio' | 'per-block cap' | 'debt ceiling' | 'minimum debt' | undefined;
	isLoading: boolean;
}

export interface MintCapacityInputs {
	/** Vault collateral in the token's native units. */
	collateralAmount: bigint;
	/** Collateral token decimals; the contract normalises by 10^(18 - decimals). */
	collateralDecimals: number;
	/** Oracle price, 8 decimals. */
	collateralPrice: bigint;
	/** Fee-inclusive debt, 18 decimals; the ratio is judged against this. */
	currentDebt: bigint;
	/** Principal only, 18 decimals; GoldVault applies MIN_DEBT to principal + amount. */
	principalDebt: bigint;
	/** Minimum ratio, 1e6 fixed point (1_300_000 = 130%). */
	minRatio: bigint;
	debtCeiling: bigint;
	totalDebt: bigint;
	/** Zero or undefined means the per-block breaker is disarmed. */
	perBlockCap: bigint | undefined;
	mintedThisBlock: bigint;
	/** GoldVault.minDebt as read from the chain; the deploy default when absent. */
	minDebt?: bigint;
}

/**
 * Mirrors GoldVault's three mint limits: the ratio at the oracle price, the collateral's
 * debt ceiling and the per-block cap. Pure so the maths can be pinned by tests.
 */
export function computeMintCapacity(
	input: MintCapacityInputs
): Pick<MintCapacity, 'available' | 'recommended' | 'limitedBy'> {
	const {
		collateralAmount,
		collateralDecimals,
		collateralPrice,
		currentDebt,
		principalDebt,
		minRatio,
		debtCeiling,
		totalDebt,
		perBlockCap,
		mintedThisBlock,
		minDebt: minDebtInput,
	} = input;

	// Normalise the token amount to 18 decimals FIRST (XAUT is 6-decimal: skipping this
	// understated its value by 1e12, quoting Max mint 0), then strip the oracle's 8.
	const normalisedCollateral = collateralAmount * 10n ** BigInt(18 - collateralDecimals);
	const collateralValue = (normalisedCollateral * collateralPrice) / PRICE_DECIMALS;
	const maxDebtByRatio = minRatio > 0n ? (collateralValue * PRECISION) / minRatio : 0n;
	const byRatio = maxDebtByRatio > currentDebt ? maxDebtByRatio - currentDebt : 0n;

	const byCeiling = debtCeiling > totalDebt ? debtCeiling - totalDebt : 0n;

	// A zero cap means the breaker is disarmed, not that nothing can be minted.
	const byBlock =
		perBlockCap === undefined || perBlockCap === 0n
			? undefined
			: perBlockCap > mintedThisBlock
			? perBlockCap - mintedThisBlock
			: 0n;

	let available = byRatio;
	let limitedBy: MintCapacity['limitedBy'] = 'ratio';
	if (byCeiling < available) {
		available = byCeiling;
		limitedBy = 'debt ceiling';
	}
	if (byBlock !== undefined && byBlock < available) {
		available = byBlock;
		limitedBy = 'per-block cap';
	}

	// `require(vault.debtAmount + amount >= MIN_DEBT)`: a vault that would end below the
	// floor cannot mint at all, so the honest Max is zero, not the sub-floor headroom
	// the ratio allows. Quoting 92 GSUSD against 0.03 XAUT reverted "Below minimum debt".
	const minDebt = minDebtInput ?? GOLD_VAULT_MIN_DEBT;
	const floor = principalDebt >= minDebt ? 0n : minDebt - principalDebt;
	if (available < floor) {
		available = 0n;
		limitedBy = 'minimum debt';
	}

	// Only the ratio limit drifts between blocks, so Max stays that reserve below it even when
	// the ceiling or the per-block cap is the tighter bound by a hair.
	const reserve = (maxDebtByRatio * MAX_RATIO_RESERVE_PER_100K) / 100_000n;
	const safeByRatio = byRatio > reserve ? byRatio - reserve : 0n;
	let recommended = available < safeByRatio ? available : safeByRatio;

	// Max offers whole dollars, so the floor applies to the figure actually typed in: headroom
	// of 100.10 less the reserve is 99.8, offered as 99, which the floor would refuse.
	const wholeRecommended = recommended - (recommended % WAD);
	if (floor > 0n && wholeRecommended < floor) {
		recommended = 0n;
		limitedBy = 'minimum debt';
	}

	return { available, recommended, limitedBy };
}

/**
 * How much GSUSD can actually be minted right now.
 *
 * Three separate limits bind a mint, and the UI previously surfaced none of them: the
 * collateral ratio, the protocol's per-block mint cap, and the collateral's debt
 * ceiling. A user with plenty of collateral could ask for an amount the per-block cap
 * forbade, get a silently disabled button, and reasonably conclude minting was broken.
 * Whichever limit is smallest is the real answer, so compute all three and report the
 * binding one.
 *
 * The per-block cap is judged for the block the mint lands in, whose counter starts at
 * zero, so an armed cap offers its whole amount and the contract enforces the rest. The
 * hook used to read blockMinted for the latest block, which is already sealed and says
 * nothing about the next one; keyed on the watched block number, that read also blanked
 * Max for a round trip on every new block.
 */
export function useMintCapacity(
	chainId: GoldVaultChainId | undefined,
	collateralToken: Address | undefined,
	collateralAmount: bigint | undefined,
	currentDebt: bigint | undefined,
	/** Oracle price, 8 decimals, as returned by the vault's oracle. */
	collateralPrice: bigint | undefined,
	/** Collateral token decimals. Undefined means not yet known, and no figure is quoted. */
	collateralDecimals: number | undefined,
	/** Principal debt (the vault's debtAmount), for the MIN_DEBT floor. */
	principalDebt: bigint | undefined
): MintCapacity {
	const config = getGoldVaultContractConfig(chainId);
	const collateralId = collateralToken
		? keccak256(encodePacked(['address'], [collateralToken]))
		: undefined;

	const enabled = Boolean(config && collateralId);
	const { data, isLoading } = useReadContracts({
		contracts: enabled
			? [
					{ ...config, abi: goldVaultAbi, functionName: 'collateralTypes', args: [collateralId as `0x${string}`] },
					{ ...config, abi: goldVaultAbi, functionName: 'perBlockMintCap' },
					{ ...config, abi: goldVaultAbi, functionName: 'minDebt' },
			  ]
			: [],
		query: { enabled, refetchInterval: 12_000 },
	});

	if (
		!data ||
		collateralAmount === undefined ||
		collateralPrice === undefined ||
		collateralDecimals === undefined
	) {
		return { available: undefined, recommended: undefined, limitedBy: undefined, isLoading };
	}

	const colType = data[0]?.status === 'success'
		? (data[0].result as readonly [Address, bigint, bigint, bigint, bigint, bigint, boolean])
		: undefined;
	const perBlockCap = data[1]?.status === 'success' ? (data[1].result as bigint) : undefined;
	const minDebt = data[2]?.status === 'success' ? (data[2].result as bigint) : undefined;

	if (!colType) return { available: undefined, recommended: undefined, limitedBy: undefined, isLoading };

	const [, minRatio, , , debtCeiling, totalDebt] = colType;

	return {
		...computeMintCapacity({
			collateralAmount,
			collateralDecimals,
			collateralPrice,
			currentDebt: currentDebt ?? 0n,
			// Principal is never above the fee-inclusive figure, so that is the safe stand-in.
			principalDebt: principalDebt ?? currentDebt ?? 0n,
			minRatio,
			debtCeiling,
			totalDebt,
			perBlockCap,
			// The mint lands in a block not yet built, whose counter starts at zero.
			mintedThisBlock: 0n,
			minDebt,
		}),
		isLoading,
	};
}
