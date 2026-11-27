// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

/// @title MockUniswapV3Pool
/// @notice Test double for the observation surface of a Uniswap v3 pool. In the default mode it models
///         a pool that sat at one tick with one in range liquidity for as long as the caller looks back,
///         anchored at settable current accumulator values so wrapping can be exercised. Raw mode returns
///         fixed arrays verbatim, and the pool can be told to revert "OLD" as a real pool does when the
///         requested window reaches past its oldest observation. slot0 and observations model the
///         cardinality and the latest observation's timestamp, which defaults to the current block.
contract MockUniswapV3Pool {
    address public token0;
    address public token1;

    int24 public tick;
    uint128 public liquidity;
    int56 public tickCumulativeNow;
    uint160 public secondsPerLiquidityNow;

    bool public revertOld;
    bool public revertSlot0;
    bool public revertObservations;
    bool public rawMode;
    int56[] private _rawTicks;
    uint160[] private _rawLiquidity;

    uint16 public observationIndex;
    uint16 public observationCardinality;
    uint16 public observationCardinalityNext;
    /// @notice The latest observation's timestamp; 0 means "this block", the default for a trading pool.
    uint32 public lastObservationTimestamp;
    bool public lastObservationInitialized = true;

    constructor(address token0_, address token1_) {
        token0 = token0_;
        token1 = token1_;
        liquidity = 1;
        observationCardinality = 1;
        observationCardinalityNext = 1;
    }

    function setTick(int24 tick_) external {
        tick = tick_;
    }

    function setLiquidity(uint128 liquidity_) external {
        liquidity = liquidity_;
    }

    function setAnchors(int56 tickCumulativeNow_, uint160 secondsPerLiquidityNow_) external {
        tickCumulativeNow = tickCumulativeNow_;
        secondsPerLiquidityNow = secondsPerLiquidityNow_;
    }

    function setRevertOld(bool revertOld_) external {
        revertOld = revertOld_;
    }

    function setRevertSlot0(bool revertSlot0_) external {
        revertSlot0 = revertSlot0_;
    }

    function setRevertObservations(bool revertObservations_) external {
        revertObservations = revertObservations_;
    }

    function setRawObservations(int56[] calldata ticks, uint160[] calldata liquidityCumulatives) external {
        _rawTicks = ticks;
        _rawLiquidity = liquidityCumulatives;
        rawMode = true;
    }

    function clearRawObservations() external {
        rawMode = false;
    }

    /// @notice Sets the latest observation's timestamp and whether it is initialised.
    function setLastObservation(uint32 blockTimestamp, bool initialized) external {
        lastObservationTimestamp = blockTimestamp;
        lastObservationInitialized = initialized;
    }

    function setObservationIndex(uint16 index) external {
        observationIndex = index;
    }

    /// @notice Records the requested cardinality the way a deployment script would raise it.
    function increaseObservationCardinalityNext(uint16 next) external {
        if (next > observationCardinalityNext) observationCardinalityNext = next;
    }

    /// @notice Models the pool writing its next observation: the active cardinality grows to
    ///         the requested one, as a real pool does at the next swap after the slots exist.
    function fillObservations() external {
        observationCardinality = observationCardinalityNext;
    }

    /// @notice The Uniswap v3 slot0 layout; only the tick, the index and the two cardinalities are modelled.
    function slot0()
        external
        view
        returns (
            uint160 sqrtPriceX96,
            int24 currentTick,
            uint16 index,
            uint16 cardinality,
            uint16 cardinalityNext,
            uint8 feeProtocol,
            bool unlocked
        )
    {
        require(!revertSlot0, "slot0 down");
        return (0, tick, observationIndex, observationCardinality, observationCardinalityNext, 0, true);
    }

    /// @notice The Uniswap v3 observation layout for the latest observation, whatever the index asked for.
    function observations(uint256)
        external
        view
        returns (uint32 blockTimestamp, int56 tickCumulative, uint160 secondsPerLiquidityCumulativeX128, bool initialized)
    {
        require(!revertObservations, "observations down");
        uint32 stamp = lastObservationTimestamp == 0 ? uint32(block.timestamp) : lastObservationTimestamp;
        return (stamp, tickCumulativeNow, secondsPerLiquidityNow, lastObservationInitialized);
    }

    function observe(uint32[] calldata secondsAgos)
        external
        view
        returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128s)
    {
        require(!revertOld, "OLD");
        if (rawMode) return (_rawTicks, _rawLiquidity);
        tickCumulatives = new int56[](secondsAgos.length);
        secondsPerLiquidityCumulativeX128s = new uint160[](secondsAgos.length);
        uint256 activeLiquidity = liquidity > 0 ? liquidity : 1;
        for (uint256 i = 0; i < secondsAgos.length; i++) {
            uint256 ago = secondsAgos[i];
            unchecked {
                tickCumulatives[i] = tickCumulativeNow - int56(tick) * int56(uint56(ago));
                secondsPerLiquidityCumulativeX128s[i] =
                    secondsPerLiquidityNow - uint160((ago << 128) / activeLiquidity);
            }
        }
    }
}
