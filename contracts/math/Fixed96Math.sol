// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @dev Shared bounded Q96.96 arithmetic; see each evaluator's declared policy.
abstract contract Fixed96Math {
    error NonFinite();
    error ArithmeticDomain();
    error InvalidParameter();
    error ZeroSeparation();
    int256 internal constant ONE = 1 << 96;
    int256 internal constant LIMIT = 1 << 126;
    uint256 internal constant SIGN = 1 << 127;
    uint256 internal constant FRACTION = (1 << 112)-1;
    function _bounded(int256 x) internal pure returns(int256) { if (x > LIMIT || x < -LIMIT) revert ArithmeticDomain(); return x; }
    function _add(int256 a,int256 b) internal pure returns(int256) { return _bounded(a+b); }
    function _sub(int256 a,int256 b) internal pure returns(int256) { return _bounded(a-b); }
    function _mul(int256 a,int256 b) internal pure returns(int256) { return _bounded((a*b)/ONE); }
    function _div(int256 a,int256 b) internal pure returns(int256) { if (b == 0) revert ArithmeticDomain(); return _bounded((a*ONE)/b); }

    function _sqrt(int256 a) internal pure returns(int256) {
        if (a <= 0) revert ArithmeticDomain();
        uint256 n = uint256(a)*uint256(ONE);
        uint256 r = uint256(1) << ((_log2(n)+2)/2);
        for (uint256 i; i < 16; ++i) {
            uint256 next = (r+n/r)/2;
            if (next >= r) return _bounded(int256(r));
            r = next;
        }
        revert ArithmeticDomain();
    }
    function _log2(uint256 value) internal pure returns(uint256 r) {
        if (value >> 128 != 0) { value >>= 128; r += 128; }
        if (value >> 64 != 0) { value >>= 64; r += 64; }
        if (value >> 32 != 0) { value >>= 32; r += 32; }
        if (value >> 16 != 0) { value >>= 16; r += 16; }
        if (value >> 8 != 0) { value >>= 8; r += 8; }
        if (value >> 4 != 0) { value >>= 4; r += 4; }
        if (value >> 2 != 0) { value >>= 2; r += 2; }
        if (value >> 1 != 0) r += 1;
    }
    function _fixed(bytes16 encoded) internal pure returns(int256) {
        uint256 bits = uint128(encoded);
        uint256 exponent = (bits >> 112) & 0x7fff;
        if (exponent == 0x7fff) revert NonFinite();
        uint256 mantissa = bits & FRACTION;
        if (exponent == 0 && mantissa == 0) return 0;
        if (exponent == 0 || exponent > 16413) revert ArithmeticDomain();
        mantissa |= 1 << 112;
        int256 shift = int256(exponent)-16399;
        uint256 raw;
        if (shift >= 0) raw = mantissa << uint256(shift);
        else {
            uint256 k = uint256(-shift);
            if (k >= 128) revert ArithmeticDomain();
            raw = mantissa >> k;
            uint256 rem = mantissa & ((uint256(1) << k)-1);
            uint256 half = uint256(1) << (k-1);
            if (rem > half || (rem == half && raw & 1 == 1)) ++raw;
        }
        if (raw == 0 || raw > uint256(LIMIT)) revert ArithmeticDomain();
        return bits & SIGN == 0 ? int256(raw) : -int256(raw);
    }
    function _quad(int256 x) internal pure returns(bytes16) {
        if (x == 0) return bytes16(0);
        _bounded(x);
        uint256 sign = x < 0 ? SIGN : 0;
        uint256 raw = uint256(x < 0 ? -x : x);
        uint256 hi = _log2(raw);
        int256 exponent = int256(hi)-96;
        uint256 mantissa;
        if (hi <= 112) mantissa = raw << (112-hi);
        else {
            uint256 k = hi-112;
            mantissa = raw >> k;
            uint256 rem = raw & ((uint256(1) << k)-1);
            uint256 half = uint256(1) << (k-1);
            if (rem > half || (rem == half && mantissa & 1 == 1)) ++mantissa;
            if (mantissa == 1 << 113) { mantissa >>= 1; ++exponent; }
        }
        return bytes16(uint128(sign | (uint256(exponent+16383) << 112) | (mantissa & FRACTION)));
    }
}
