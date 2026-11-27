// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.38;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {TickPower} from "./TickPower.sol";

/// @notice The Uniswap v3 pool reads this feed needs, declared from the pool's public ABI.
/// @dev Written by hand from the deployed ABI rather than imported, so no GPL source is pulled in.
interface IUniswapV3PoolObservations {
    function token0() external view returns (address);

    function token1() external view returns (address);

    function observe(uint32[] calldata secondsAgos)
        external
        view
        returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128s);

    function slot0()
        external
        view
        returns (
            uint160 sqrtPriceX96,
            int24 tick,
            uint16 observationIndex,
            uint16 observationCardinality,
            uint16 observationCardinalityNext,
            uint8 feeProtocol,
            bool unlocked
        );

    function observations(uint256 index)
        external
        view
        returns (uint32 blockTimestamp, int56 tickCumulative, uint160 secondsPerLiquidityCumulativeX128, bool initialized);
}

/// @notice The Chainlink style aggregator reads used for the quote token's USD price.
interface IQuoteUsdAggregator {
    function decimals() external view returns (uint8);

    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}

/// @title UniswapV3TwapFeed
/// @notice An 8 decimal AggregatorV3 style USD price for one token, read entirely from on chain
///         state: the median of six consecutive sub-window time weighted average ticks of a Uniswap
///         v3 pool, converted to the base token's price in the pool's other token and multiplied by
///         that quote token's USD price. Everything it reads can be checked on Etherscan; nothing is
///         pushed by a third party.
///         Not used in production: the GoldOracle prices on Chainlink PAXG/USD and XAU/USD alone, and
///         no deployment or preflight path deploys or wires this contract. Kept for research only.
/// @dev Contract with GoldOracle: decimals() is 8, latestRoundData() never reverts after construction
///      and an unsafe price is signalled as answer 0 (which the oracle rejects as invalid), never as
///      a low price. Stamps are block.timestamp because the average is computed live in this block.
///
///      Median of sub-windows. The window is split into six equal sub-windows and the pool is
///      observed at their seven boundaries. Each sub-window's arithmetic mean tick is computed and the
///      median of the six (the floor mean of the third and fourth in order) is the price tick. A
///      validator who holds the pool off market for a run of consecutive blocks moves the sub-windows
///      those blocks fall in, at most two adjacent ones for a run shorter than a sub-window, and the
///      median ignores them: moving the median needs the price held for more than half the window,
///      paying the arbitrage loss every block of it. The plain whole window mean has no such
///      protection; a model of a three slot push moved a 30 minute TWAP by 10% for about 38,000 USD.
///
///      Liquidity floor. The harmonic mean in range liquidity over the whole window must reach
///      minHarmonicLiquidity or the answer is 0, because a thin pool is cheap to push for a whole
///      sub-window and the median cannot help there.
///
///      Freshness. A pool with no swaps keeps the same tick, and observe() extrapolates it to the
///      present, so a pool frozen by its issuer or simply idle would price for ever at its last trade.
///      The pool's latest observation is therefore read (slot0.observationIndex, then
///      observations(index).blockTimestamp) and an observation older than maxObservationAge answers 0
///      with NO_RECENT_SWAPS. GoldOracle's gold band, agreement band and XAU/USD anchor remain the cross
///      checks for a pool that trades but away from the market.
///
///      One-block spikes. A block builder holding the end of one block and the start of the next can
///      move the tick by any amount for 12 seconds, carry the liquidity floor with just-in-time
///      liquidity and so shift the mean of every sub-window it touches by spike x 12 / 300 ticks; four
///      spiked sub-windows of six move the median by as much. There is deliberately no
///      bound on how far one sub-window mean may sit from its neighbours, because none is sound: with
///      four of six sub-windows spiked the honest two are the outliers, a staircase of spikes keeps
///      every neighbouring gap inside any bound while still moving the median, and a genuine fast move
///      trips such a bound exactly when a liquidation needs the price. GoldOracle makes a forged answer
///      worthless instead: below the gold band a liquidation never prices under its floor (the band's
///      lower edge until a breach has persisted, then a governed descent), with C stopped it never
///      prices under gold, and for borrowing this feed can only lower the price.
///
///      Depth. liquidityUsd() values the harmonic mean liquidity in USD for sizing a debt ceiling; its
///      formula is documented on the function.
///
///      Deployment. A pool keeps only `observationCardinality` observations, at most one per block, and
///      `observe` reverts with "OLD" when the window reaches past the oldest one; this feed then answers
///      0. Before relying on the feed, call `pool.increaseObservationCardinalityNext(n)` with n at least
///      windowSeconds / 12 (one observation per 12 second block) plus a margin, for example 200 for a
///      30 minute window, and wait one full window after the new slots start filling. Anyone may call
///      it; the caller pays the gas to initialise the slots.
///
///      Licence. The Uniswap v3-core TickMath and v3-periphery OracleLibrary are GPL-2.0-or-later and
///      this repository is BUSL-1.1, so their code is not copied. The tick to price conversion is the
///      independent routine in TickPower; the mean tick, harmonic liquidity and liquidity value follow
///      from the published definitions of the pool's accumulators and of liquidity, and are written
///      here from those definitions.
contract UniswapV3TwapFeed {
    /// @notice Why a read produced the answer it did. OK is the only status with a non zero answer.
    enum Status {
        OK,
        OBSERVE_FAILED,
        BAD_OBSERVATION,
        TICK_OUT_OF_RANGE,
        THIN_LIQUIDITY,
        QUOTE_FEED_FAILED,
        QUOTE_INVALID,
        QUOTE_STALE,
        PRICE_OUT_OF_RANGE,
        NO_RECENT_SWAPS
    }

    /// @notice The window is split into this many equal sub-windows; the median of their mean ticks is the price.
    uint32 public constant SUB_WINDOWS = 6;
    /// @notice Shortest averaging window: shorter windows are cheap to hold for a validator run.
    uint32 public constant MIN_WINDOW = 10 minutes;
    /// @notice Longest averaging window: longer windows lag the market too far for liquidations.
    uint32 public constant MAX_WINDOW = 120 minutes;
    /// @notice Bounds for maxObservationAge: a pool that has not traded for a day is not a market.
    uint32 public constant MIN_OBSERVATION_AGE = 1 hours;
    uint32 public constant MAX_OBSERVATION_AGE = 24 hours;
    /// @notice Longest quote feed age the constructor accepts, above the 24 hour heartbeat of the
    ///         slowest Chainlink USD feeds with a margin.
    uint256 public constant MAX_QUOTE_AGE_CAP = 3 days;
    /// @notice Ceiling for any 8 decimal USD figure this feed handles, one trillion dollars. Bounding
    ///         the quote price keeps every intermediate product below 2^256, and an answer above it
    ///         can only come from a broken pool or feed.
    uint256 public constant MAX_USD_PRICE = 1e20;
    /// @notice Ceiling for liquidityUsd(), 100 trillion dollars at 18 decimals.
    uint256 public constant MAX_LIQUIDITY_USD = 1e32;
    /// @notice The quote price used when no quote feed is configured: exactly 1 USD.
    uint256 public constant ONE_USD = 1e8;

    /// @notice The Uniswap v3 pool averaged over.
    address public immutable pool;
    /// @notice The token this feed prices.
    address public immutable baseToken;
    /// @notice The pool's other token, in which the pool quotes the base token.
    address public immutable quoteToken;
    /// @notice True when the base token is the pool's token0, so the pool tick is the base price.
    bool public immutable baseIsToken0;
    /// @notice Averaging window in seconds, a multiple of SUB_WINDOWS.
    uint32 public immutable windowSeconds;
    /// @notice Minimum harmonic mean in range liquidity over the window.
    uint128 public immutable minHarmonicLiquidity;
    /// @notice 8 decimal USD feed for the quote token, or address(0) for a 6 decimal stablecoin at 1 USD.
    address public immutable quoteUsdFeed;
    /// @notice Longest accepted age of the quote feed's answer, in seconds (0 when there is no feed).
    uint256 public immutable maxQuoteAge;
    /// @notice Longest accepted age of the pool's latest observation, in seconds.
    uint32 public immutable maxObservationAge;
    /// @notice Decimals of the base token, read from the token at construction.
    uint8 public immutable baseDecimals;
    /// @notice Decimals of the quote token, read from the token at construction.
    uint8 public immutable quoteDecimals;

    uint256 private immutable baseScale;
    uint256 private immutable quoteScale;
    uint32 private immutable subWindowSeconds;

    /// @notice Human readable pair label, for example "PAXG / USD (Uniswap v3 TWAP)".
    string public description;

    error ZeroAddress();
    error NotAContract(address account);
    error BaseNotInPool(address baseToken);
    error WindowOutOfRange(uint32 windowSeconds);
    error WindowNotDivisible(uint32 windowSeconds);
    error ZeroMinLiquidity();
    error DecimalsOutOfRange(address token, uint8 decimals);
    error UnpricedQuoteMustHaveSixDecimals(uint8 quoteDecimals);
    error QuoteAgeWithoutFeed();
    error QuoteFeedDecimals(uint8 decimals);
    error QuoteAgeOutOfRange(uint256 maxQuoteAge);
    error ObservationAgeOutOfRange(uint32 maxObservationAge);

    /// @param pool_ Uniswap v3 pool holding the base token and its quote token.
    /// @param baseToken_ Token to price; must be the pool's token0 or token1.
    /// @param windowSeconds_ Averaging window, between MIN_WINDOW and MAX_WINDOW and a multiple of SUB_WINDOWS.
    /// @param minHarmonicLiquidity_ Harmonic mean liquidity below which the answer is 0.
    /// @param quoteUsdFeed_ 8 decimal USD feed for the quote token (USDC/USD, ETH/USD, PAXG/USD and so
    ///        on). address(0) treats the quote as exactly 1 USD, which is only accepted for a 6 decimal
    ///        quote token and must only be used for a USD stablecoin such as USDC or USDT: the feed
    ///        then inherits that stablecoin's peg risk with no check on it.
    /// @param maxQuoteAge_ Longest accepted quote feed age in seconds; must be 0 without a feed.
    /// @param maxObservationAge_ Longest accepted age of the pool's latest observation, 1 to 24 hours.
    /// @param description_ Label returned by description().
    constructor(
        address pool_,
        address baseToken_,
        uint32 windowSeconds_,
        uint128 minHarmonicLiquidity_,
        address quoteUsdFeed_,
        uint256 maxQuoteAge_,
        uint32 maxObservationAge_,
        string memory description_
    ) {
        if (pool_ == address(0) || baseToken_ == address(0)) revert ZeroAddress();
        if (pool_.code.length == 0) revert NotAContract(pool_);
        if (windowSeconds_ < MIN_WINDOW || windowSeconds_ > MAX_WINDOW) revert WindowOutOfRange(windowSeconds_);
        if (windowSeconds_ % SUB_WINDOWS != 0) revert WindowNotDivisible(windowSeconds_);
        if (minHarmonicLiquidity_ == 0) revert ZeroMinLiquidity();
        if (maxObservationAge_ < MIN_OBSERVATION_AGE || maxObservationAge_ > MAX_OBSERVATION_AGE) {
            revert ObservationAgeOutOfRange(maxObservationAge_);
        }

        address token0 = IUniswapV3PoolObservations(pool_).token0();
        address token1 = IUniswapV3PoolObservations(pool_).token1();
        bool isToken0 = baseToken_ == token0;
        if (!isToken0 && baseToken_ != token1) revert BaseNotInPool(baseToken_);
        address quote = isToken0 ? token1 : token0;
        if (quote == address(0)) revert ZeroAddress();

        uint8 baseDec = _tokenDecimals(baseToken_);
        uint8 quoteDec = _tokenDecimals(quote);
        _checkQuoteFeed(quoteUsdFeed_, maxQuoteAge_, quoteDec);

        pool = pool_;
        baseToken = baseToken_;
        quoteToken = quote;
        baseIsToken0 = isToken0;
        windowSeconds = windowSeconds_;
        subWindowSeconds = windowSeconds_ / SUB_WINDOWS;
        minHarmonicLiquidity = minHarmonicLiquidity_;
        quoteUsdFeed = quoteUsdFeed_;
        maxQuoteAge = maxQuoteAge_;
        maxObservationAge = maxObservationAge_;
        baseDecimals = baseDec;
        quoteDecimals = quoteDec;
        baseScale = 10 ** baseDec;
        quoteScale = 10 ** quoteDec;
        description = description_;
    }

    /// @notice Answers are 8 decimal USD, matching GoldOracle's registration check.
    function decimals() external pure returns (uint8) {
        return 8;
    }

    /// @notice Interface version, for tooling that reads Chainlink style aggregators.
    function version() external pure returns (uint256) {
        return 2;
    }

    /// @notice The live price in the AggregatorV3 shape. Never reverts; an unsafe price is answer 0.
    /// @dev All four stamps are this block's timestamp because the average is computed now.
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
    {
        (uint256 price,) = readPrice();
        roundId = uint80(block.timestamp);
        // readPrice never returns more than MAX_USD_PRICE, so the cast cannot wrap.
        return (roundId, int256(price), block.timestamp, block.timestamp, roundId);
    }

    /// @notice The live price with the reason behind it, for monitoring and diagnosis.
    /// @return answer 8 decimal USD price of one whole base token, 0 unless status is OK.
    /// @return status Why the answer is what it is.
    function readPrice() public view returns (uint256 answer, Status status) {
        int256 medianTick;
        (medianTick,, status) = observeWindow();
        if (status != Status.OK) return (0, status);
        (, status) = lastObservationAge();
        if (status != Status.OK) return (0, status);
        uint256 quoteUsd;
        (quoteUsd, status) = quotePriceUsd();
        if (status != Status.OK) return (0, status);
        return priceAtTick(medianTick, quoteUsd);
    }

    /// @notice The USD value of the window's harmonic mean liquidity, for sizing a debt ceiling.
    /// @dev Formula. A Uniswap v3 pool with liquidity L at price P (token1 per token0, raw units)
    ///      behaves locally like a constant product pool with virtual reserves x = L / sqrt(P) of
    ///      token0 and y = L * sqrt(P) of token1, each worth the same at the current price. The value
    ///      of liquidity at the current price is the value of those virtual reserves:
    ///          liquidityUsd = 2 * quoteSide * quoteUsd / 10^quoteDecimals, scaled to 18 decimals,
    ///      where quoteSide is y when the quote is token1 and x when it is token0, that is
    ///      L * 1.0001^(t / 2) or L * 1.0001^(-t / 2) for the median tick t. The useful corollary for
    ///      a ceiling: swapping the price by a small fraction f takes about liquidityUsd * f / 4 of
    ///      quote value, since dy = L * sqrt(P) * (sqrt(1 + f) - 1). This is the depth at the current
    ///      price, not the tokens a concentrated position holds across its whole band; the amount to
    ///      move the price through the pool's full band is out of scope here.
    ///      Arithmetic. sqrt(P) is the integer square root of the TickPower mantissa shifted so the
    ///      root keeps 127 bits, quoteSide is floored to a raw quote unit (an error below one millionth
    ///      of a dollar for a 6 decimal quote) and the result is bounded by MAX_LIQUIDITY_USD. Every
    ///      intermediate product fits in 256 bits: L < 2^128 (a real pool's liquidity is a uint128),
    ///      the root mantissa is below 2^128 and the shift is at least 63 bits inside the tick range.
    /// @return usd18 The value at 18 decimals, 0 unless status is OK.
    /// @return status OK, or why the value cannot be given (the same gates as readPrice).
    function liquidityUsd() external view returns (uint256 usd18, Status status) {
        int256 medianTick;
        uint256 liquidity;
        (medianTick, liquidity, status) = observeWindow();
        if (status != Status.OK) return (0, status);
        (, status) = lastObservationAge();
        if (status != Status.OK) return (0, status);
        uint256 quoteUsd;
        (quoteUsd, status) = quotePriceUsd();
        if (status != Status.OK) return (0, status);
        return liquidityValueAtTick(medianTick, liquidity, quoteUsd);
    }

    /// @notice The median sub-window mean tick and the whole window's harmonic mean liquidity.
    /// @dev tickCumulative grows by the current tick every second, so a sub-window's mean tick is its
    ///      change over the sub-window divided by the sub-window, rounded towards negative infinity as
    ///      Uniswap does. secondsPerLiquidityCumulativeX128 grows by 2^128 / liquidity every second, so
    ///      its change over the window is window * 2^128 / (harmonic mean liquidity), inverted here.
    ///      Both accumulators wrap by design, so differences are taken in unchecked arithmetic of their
    ///      own width.
    /// @return medianTick The median of the six sub-window mean ticks, in pool orientation (token1 per token0).
    /// @return harmonicLiquidity The harmonic mean in range liquidity over the whole window.
    /// @return status OK, or the reason the observation cannot be used.
    function observeWindow() public view returns (int256 medianTick, uint256 harmonicLiquidity, Status status) {
        uint32[] memory secondsAgos = new uint32[](SUB_WINDOWS + 1);
        for (uint256 i = 0; i < SUB_WINDOWS; i++) {
            secondsAgos[i] = windowSeconds - uint32(i) * subWindowSeconds;
        }
        try IUniswapV3PoolObservations(pool).observe(secondsAgos) returns (
            int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidity
        ) {
            if (tickCumulatives.length != SUB_WINDOWS + 1 || secondsPerLiquidity.length != SUB_WINDOWS + 1) {
                return (0, 0, Status.BAD_OBSERVATION);
            }
            medianTick = _medianSubWindowTick(tickCumulatives);
            if (medianTick > TickPower.MAX_TICK || medianTick < -TickPower.MAX_TICK) {
                return (0, 0, Status.TICK_OUT_OF_RANGE);
            }
            uint160 liquidityDelta;
            unchecked {
                liquidityDelta = secondsPerLiquidity[SUB_WINDOWS] - secondsPerLiquidity[0];
            }
            if (liquidityDelta == 0) return (medianTick, 0, Status.BAD_OBSERVATION);
            harmonicLiquidity = (uint256(windowSeconds) << 128) / liquidityDelta;
            // A real pool's liquidity is a uint128; anything larger is a corrupt observation.
            if (harmonicLiquidity > type(uint128).max) return (medianTick, 0, Status.BAD_OBSERVATION);
            if (harmonicLiquidity < minHarmonicLiquidity) {
                return (medianTick, harmonicLiquidity, Status.THIN_LIQUIDITY);
            }
            return (medianTick, harmonicLiquidity, Status.OK);
        } catch {
            return (0, 0, Status.OBSERVE_FAILED);
        }
    }

    /// @notice Seconds since the pool last wrote an observation, that is since its last swap or
    ///         liquidity change in a new block.
    /// @return age The age in seconds (0 when the pool cannot be read).
    /// @return status OK, NO_RECENT_SWAPS when the age exceeds maxObservationAge or OBSERVE_FAILED when the pool cannot be read.
    function lastObservationAge() public view returns (uint256 age, Status status) {
        IUniswapV3PoolObservations target = IUniswapV3PoolObservations(pool);
        // Only the observation index is needed from slot0, and only the timestamp and the initialised
        // flag from the observation; the other fields are deliberately unused.
        // slither-disable-next-line unused-return
        try target.slot0() returns (uint160, int24, uint16 observationIndex, uint16, uint16, uint8, bool) {
            // slither-disable-next-line unused-return
            try target.observations(observationIndex) returns (uint32 blockTimestamp, int56, uint160, bool initialized) {
                if (!initialized) return (0, Status.OBSERVE_FAILED);
                // The pool stores a uint32 timestamp that wraps in 2106; the difference is taken in
                // the same width, as the pool itself does.
                uint32 elapsed;
                unchecked {
                    elapsed = uint32(block.timestamp) - blockTimestamp;
                }
                age = elapsed;
                return (age, age > maxObservationAge ? Status.NO_RECENT_SWAPS : Status.OK);
            } catch {
                return (0, Status.OBSERVE_FAILED);
            }
        } catch {
            return (0, Status.OBSERVE_FAILED);
        }
    }

    /// @notice The quote token's 8 decimal USD price: the quote feed's answer when it passes the same
    ///         checks GoldOracle applies, or exactly ONE_USD when no feed is configured.
    function quotePriceUsd() public view returns (uint256 quoteUsd, Status status) {
        address feed = quoteUsdFeed;
        if (feed == address(0)) return (ONE_USD, Status.OK);
        // startedAt is deliberately unused; the other four fields are validated as GoldOracle does.
        // slither-disable-next-line unused-return
        try IQuoteUsdAggregator(feed).latestRoundData() returns (
            uint80 roundId, int256 answer, uint256, uint256 updatedAt, uint80 answeredInRound
        ) {
            if (answer <= 0 || uint256(answer) > MAX_USD_PRICE) return (0, Status.QUOTE_INVALID);
            if (updatedAt == 0 || answeredInRound < roundId) return (0, Status.QUOTE_INVALID);
            if (updatedAt > block.timestamp) return (0, Status.QUOTE_INVALID);
            if (block.timestamp - updatedAt > maxQuoteAge) return (0, Status.QUOTE_STALE);
            return (uint256(answer), Status.OK);
        } catch {
            return (0, Status.QUOTE_FEED_FAILED);
        }
    }

    /// @notice The 8 decimal USD price of one whole base token at a given pool tick and quote price.
    /// @dev The pool tick prices token0 in token1 base units, so the base price in quote base units is
    ///      1.0001^tick when the base is token0 and 1.0001^-tick otherwise. One whole base token is
    ///      10^baseDecimals units and one whole quote token is 10^quoteDecimals, so the USD answer is
    ///      1.0001^baseTick * 10^baseDecimals * quoteUsd / 10^quoteDecimals. With the value held as
    ///      mantissa * 2^exponent, mulDiv takes mantissa * 10^baseDecimals * quoteUsd / 10^quoteDecimals
    ///      and the result is shifted right by -exponent. Bounds: the mantissa is below 2^128 and the
    ///      scaled quote below 1e38, so the product stays below 2^256. A non negative exponent means the
    ///      raw price is at least 2^127 quote units per base unit, which is above MAX_USD_PRICE for any
    ///      accepted decimals and quote price, so it is reported as out of range rather than shifted.
    ///      The smallest value, 1.0001^-887272, has exponent -255, so the right shift is always below 256.
    ///      Flooring loses under one unit of the eighth decimal.
    /// @param tick The tick in pool orientation, within [-887272, 887272].
    /// @param quoteUsd The quote token's 8 decimal USD price, at most MAX_USD_PRICE.
    function priceAtTick(int256 tick, uint256 quoteUsd) public view returns (uint256 answer, Status status) {
        if (tick > TickPower.MAX_TICK || tick < -TickPower.MAX_TICK) return (0, Status.TICK_OUT_OF_RANGE);
        if (quoteUsd == 0 || quoteUsd > MAX_USD_PRICE) return (0, Status.QUOTE_INVALID);
        (uint256 mantissa, int256 exponent) = TickPower.pow(baseIsToken0 ? tick : -tick);
        if (exponent >= 0) return (0, Status.PRICE_OUT_OF_RANGE);
        uint256 scaled = Math.mulDiv(mantissa, baseScale * quoteUsd, quoteScale);
        answer = scaled >> uint256(-exponent);
        if (answer == 0 || answer > MAX_USD_PRICE) return (0, Status.PRICE_OUT_OF_RANGE);
        return (answer, Status.OK);
    }

    /// @notice The USD value (18 decimals) of liquidity L at a pool tick and quote price; see liquidityUsd.
    /// @param tick The tick in pool orientation, within [-887272, 887272].
    /// @param liquidity The pool liquidity L, at most type(uint128).max.
    /// @param quoteUsd The quote token's 8 decimal USD price, at most MAX_USD_PRICE.
    function liquidityValueAtTick(int256 tick, uint256 liquidity, uint256 quoteUsd)
        public
        view
        returns (uint256 usd18, Status status)
    {
        if (tick > TickPower.MAX_TICK || tick < -TickPower.MAX_TICK) return (0, Status.TICK_OUT_OF_RANGE);
        if (quoteUsd == 0 || quoteUsd > MAX_USD_PRICE) return (0, Status.QUOTE_INVALID);
        if (liquidity == 0 || liquidity > type(uint128).max) return (0, Status.BAD_OBSERVATION);
        // The quote side of the virtual reserves is L * sqrt(P) when the quote is token1 and
        // L / sqrt(P) = L * sqrt(1 / P) when it is token0.
        (uint256 mantissa, int256 exponent) = TickPower.pow(baseIsToken0 ? tick : -tick);
        (uint256 root, int256 rootExponent) = _sqrt(mantissa, exponent);
        // Inside the tick range, checked above, sqrt(P) lies in [2^-64, 2^64], so with a root mantissa
        // in [2^127, 2^128) the root's exponent lies in [-192, -63]: the shift below is always between
        // 63 and 192 bits and the division never degenerates. The fuzz suite covers the whole range.
        uint256 quoteSide = Math.mulDiv(liquidity, root, uint256(1) << uint256(-rootExponent));
        if (quoteSide > 1e40) return (0, Status.PRICE_OUT_OF_RANGE);
        // Two sides of equal value, 8 decimal quote price to 18 decimals (times 1e10), per whole quote token.
        usd18 = Math.mulDiv(quoteSide * 2, quoteUsd * 1e10, quoteScale);
        if (usd18 == 0 || usd18 > MAX_LIQUIDITY_USD) return (0, Status.PRICE_OUT_OF_RANGE);
        return (usd18, Status.OK);
    }

    /// @dev Square root of a normalised value m * 2^e (2^127 <= m < 2^128): the mantissa is shifted by
    ///      128 or 127 bits so the exponent becomes even, and the integer root of the shifted mantissa
    ///      then lies in [2^127, 2^128). The floor loses under 2^-127 of relative precision.
    function _sqrt(uint256 m, int256 e) private pure returns (uint256 root, int256 rootExponent) {
        if (e % 2 == 0) {
            return (Math.sqrt(m << 128), (e - 128) / 2);
        }
        return (Math.sqrt(m << 127), (e - 127) / 2);
    }

    /// @dev The median of the six sub-window mean ticks: each mean floors its tick change over the
    ///      sub-window, the six are sorted and the floor mean of the third and fourth is returned.
    function _medianSubWindowTick(int56[] memory tickCumulatives) private view returns (int256) {
        int256 sub = int256(uint256(subWindowSeconds));
        int256[] memory means = new int256[](SUB_WINDOWS);
        for (uint256 i = 0; i < SUB_WINDOWS; i++) {
            int56 delta;
            unchecked {
                delta = tickCumulatives[i + 1] - tickCumulatives[i];
            }
            int256 mean = int256(delta) / sub;
            if (delta < 0 && int256(delta) % sub != 0) mean -= 1;
            means[i] = mean;
        }
        // Insertion sort: six values, so the quadratic cost is a few dozen comparisons.
        for (uint256 i = 1; i < SUB_WINDOWS; i++) {
            int256 value = means[i];
            uint256 j = i;
            while (j > 0 && means[j - 1] > value) {
                means[j] = means[j - 1];
                j--;
            }
            means[j] = value;
        }
        // Arithmetic shift right floors a negative sum, as the sub-window means were floored.
        return (means[SUB_WINDOWS / 2 - 1] + means[SUB_WINDOWS / 2]) >> 1;
    }

    /// @dev Reads a token's decimals at construction; 18 is the ceiling the bounds above assume.
    function _tokenDecimals(address token) private view returns (uint8 dec) {
        dec = IERC20Metadata(token).decimals();
        if (dec > 18) revert DecimalsOutOfRange(token, dec);
    }

    /// @dev Without a feed the quote is pinned at 1 USD, which only a 6 decimal USD stablecoin
    ///      (USDC or USDT) justifies; with a feed it must be 8 decimals and carry a bounded age.
    function _checkQuoteFeed(address feed, uint256 maxAge, uint8 quoteDec) private view {
        if (feed == address(0)) {
            if (quoteDec != 6) revert UnpricedQuoteMustHaveSixDecimals(quoteDec);
            if (maxAge != 0) revert QuoteAgeWithoutFeed();
            return;
        }
        if (feed.code.length == 0) revert NotAContract(feed);
        uint8 feedDecimals = IQuoteUsdAggregator(feed).decimals();
        if (feedDecimals != 8) revert QuoteFeedDecimals(feedDecimals);
        if (maxAge == 0 || maxAge > MAX_QUOTE_AGE_CAP) revert QuoteAgeOutOfRange(maxAge);
    }
}
