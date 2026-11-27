// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.38;

/// @title TickPower
/// @notice Computes 1.0001^tick, the price a Uniswap v3 tick stands for, as a binary floating point
///         number `mantissa * 2^exponent` with the mantissa normalised to [2^127, 2^128).
/// @dev Licence. Uniswap v3-core TickMath and v3-periphery OracleLibrary are GPL-2.0-or-later and
///      this repository is BUSL-1.1, so none of their code is used here. TickMath works in square
///      root price space from a table of per-bit constants; this library is an independent routine
///      that works in price space by exponentiation by squaring from one constant. The only shared
///      inputs are mathematical facts of the protocol: a tick is a power of 1.0001 and the tick range
///      is [-887272, 887272].
///
///      Derivation.
///      1. A positive value v is held as (m, e) with v = m * 2^e and 2^127 <= m < 2^128. A 128 bit
///         mantissa keeps a product of two mantissas below 2^256, so no step needs 512 bit maths.
///      2. Multiplication: (m1, e1) * (m2, e2) has p = m1 * m2 in [2^254, 2^256). If p >= 2^255 then
///         m = p >> 128 and e = e1 + e2 + 128, otherwise m = p >> 127 and e = e1 + e2 + 127. Either way
///         m lands in [2^127, 2^128) again. The shift floors, so each multiplication loses less than
///         one unit in 2^127 of relative precision.
///      3. Power: for n = |tick| the loop multiplies the result by the base whenever the low bit of n
///         is set, then squares the base and shifts n right. A 20 bit n costs at most 40 multiplications.
///      4. The base 1.0001 is (BASE_MANTISSA, -127) where BASE_MANTISSA is 1.0001 * 2^127 rounded to
///         nearest. That rounding error (below 2^-128 relative) is raised to the power n, so the worst
///         case relative error is about n * 2^-127 plus 40 * 2^-127 from the floors, under 2^-106
///         (about 1.3e-32) at the edge of the tick range. The test suite checks every result against an
///         independent 200 digit decimal computation with a tolerance of 1e-30.
///      5. Negative ticks: 1.0001^-n = 1 / 1.0001^n. The reciprocal of (m, e) is (2^255 / m, -255 - e).
///         Since 2^127 <= m < 2^128 the quotient lies in (2^127, 2^128], and the single case equal to
///         2^128 (m exactly 2^127, a power of two) is renormalised to (2^127, exponent + 1).
library TickPower {
    /// @notice Largest tick magnitude Uniswap v3 allows: the tick whose square root price is 2^128.
    int256 internal constant MAX_TICK = 887272;

    /// @notice 1.0001 * 2^127 rounded to nearest. Computed with 200 digit decimal arithmetic:
    ///         10001 * 2^127 / 10000 = 170158197578815278654860472446255694138.5728, so it rounds up.
    uint256 internal constant BASE_MANTISSA = 170158197578815278654860472446255694139;

    /// @notice Smallest normalised mantissa, 2^127, which also stands for 1.0 with exponent -127.
    uint256 internal constant MANTISSA_ONE = 1 << 127;

    /// @notice The tick lies outside [-MAX_TICK, MAX_TICK].
    error TickOutOfRange(int256 tick);

    /// @notice Returns 1.0001^tick as `mantissa * 2^exponent`, mantissa in [2^127, 2^128).
    /// @dev Reverts only for a tick outside the Uniswap range; callers that must not revert bound
    ///      the tick first.
    function pow(int256 tick) internal pure returns (uint256 mantissa, int256 exponent) {
        if (tick > MAX_TICK || tick < -MAX_TICK) revert TickOutOfRange(tick);
        uint256 n = uint256(tick < 0 ? -tick : tick);
        mantissa = MANTISSA_ONE;
        exponent = -127;
        uint256 baseMantissa = BASE_MANTISSA;
        int256 baseExponent = -127;
        while (n != 0) {
            if (n & 1 == 1) {
                (mantissa, exponent) = multiply(mantissa, exponent, baseMantissa, baseExponent);
            }
            n >>= 1;
            if (n != 0) {
                (baseMantissa, baseExponent) = multiply(baseMantissa, baseExponent, baseMantissa, baseExponent);
            }
        }
        if (tick < 0) {
            (mantissa, exponent) = reciprocal(mantissa, exponent);
        }
    }

    /// @notice Multiplies two normalised values (step 2 of the derivation).
    function multiply(uint256 m1, int256 e1, uint256 m2, int256 e2) internal pure returns (uint256, int256) {
        uint256 p = m1 * m2;
        if (p >> 255 == 1) {
            return (p >> 128, e1 + e2 + 128);
        }
        return (p >> 127, e1 + e2 + 127);
    }

    /// @notice Reciprocal of a normalised value (step 5 of the derivation).
    function reciprocal(uint256 m, int256 e) internal pure returns (uint256, int256) {
        uint256 q = (uint256(1) << 255) / m;
        if (q == uint256(1) << 128) {
            return (MANTISSA_ONE, -254 - e);
        }
        return (q, -255 - e);
    }
}
