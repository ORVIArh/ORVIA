// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Fixed96Math} from "./Fixed96Math.sol";

/// @dev Bounded Q96 policy, not correctly rounded binary128 transcendental math.
/// Series lengths and continued fraction are protocol constants, never adaptive
/// transaction-work settings. Values below fixed-point resolution can become zero.
abstract contract Fixed96EwaldMath is Fixed96Math {
    int256 internal constant PI96 = 248902613312231085230521944622;
    int256 internal constant INV_SQRT_PI96 = 44699704014176752299205233279;

    /// @dev exp(-z), 0 <= z <= 256. Reduce by 256, 32 Taylor terms, 8 squarings.
    function _expNegative(int256 z) internal pure returns (int256 value) {
        if (z < 0 || z > 256 * ONE) revert ArithmeticDomain();
        int256 x = -z / 256;
        int256 term = ONE;
        value = ONE;
        for (uint256 n = 1; n <= 32; ++n) {
            term = _mul(term, x) / int256(n);
            if (term == 0) break; // Every later Q96 recurrence term is also zero.
            value = _add(value, term);
        }
        for (uint256 n; n < 8; ++n) value = _mul(value, value);
        if (value < 0 || value > ONE) revert ArithmeticDomain();
    }

    /// @dev Nonnegative erfc, using the same positive series / DLMF 7.9.2
    /// continued-fraction division as the binary128 reference, with Q96 arithmetic.
    function _erfcPositive(int256 x) internal pure returns (int256 value) {
        if (x < 0 || x > 16 * ONE) revert ArithmeticDomain();
        int256 z = _mul(x, x);
        int256 gaussian = _expNegative(z);
        if (x < 2 * ONE) {
            int256 term = x;
            int256 sum = x;
            for (uint256 n = 1; n < 64; ++n) {
                term = _mul(term, 2 * z) / int256(2 * n + 1);
                if (term == 0) break;
                sum = _add(sum, term);
            }
            value = _sub(ONE, _mul(_mul(2 * INV_SQRT_PI96, gaussian), sum));
        } else {
            int256 base = z + ONE / 2;
            int256 tail;
            for (uint256 n = 128; n > 0; --n) {
                int256 numerator = int256(n * (2 * n - 1)) * (ONE / 2);
                tail = _div(numerator, _sub(base + int256(2 * n) * ONE, tail));
            }
            value = _div(_mul(_mul(x, gaussian), INV_SQRT_PI96), _sub(base, tail));
        }
        if (value < 0 || value > ONE) revert ArithmeticDomain();
    }

    /// @dev Argument already reduced to [-pi,pi]. Taylor terms through degree 65/64.
    function _sinCosReduced(int256 x) internal pure returns (int256 sine, int256 cosine) {
        if (x < -PI96 || x > PI96) revert ArithmeticDomain();
        int256 negativeSquared = -_mul(x, x);
        int256 sineTerm = x;
        int256 cosineTerm = ONE;
        sine = x;
        cosine = ONE;
        for (uint256 n = 1; n <= 32; ++n) {
            sineTerm = _mul(sineTerm, negativeSquared) / int256((2*n)*(2*n+1));
            cosineTerm = _mul(cosineTerm, negativeSquared) / int256((2*n-1)*(2*n));
            if (sineTerm == 0 && cosineTerm == 0) break;
            sine = _add(sine, sineTerm);
            cosine = _add(cosine, cosineTerm);
        }
    }
}
