# Orthorhombic periodic geometry

`OrthorhombicGeometry` selects the nearest image of `b-a` in a fixed rectangular periodic box. All three box lengths must be finite and positive. Coordinates and output components use the project's binary128 format and pinned `FloatMath` arithmetic; no coordinate calculation is submitted by the caller.

The constructor is `OrthorhombicGeometry(address math)`. Its public immutable dependency getter is `numericalMath()`. The two computational entry points are:

```solidity
displacement(bytes16[3] a, bytes16[3] b, bytes16[3] box)
    external view returns (bytes16[3] d);
validateBox(bytes16[3] box, bytes16 cutoff) external view;
```

For each axis, the contract calculates `delta = b-a` and `quotient = delta/L`, checks `abs(quotient) <= 2^32`, truncates the quotient toward zero using the pinned ABDK integer conversion, and calculates `remainder = delta - trunc(quotient)*L`. It subtracts one length when the remainder is strictly above `L/2`, or adds one when strictly below `-L/2`. There is no image-count-dependent loop. The range cap applies to the rounded binary128 quotient. Nonfinite arithmetic and unresolved final images revert instead of silently producing a displacement outside the half-box interval.

Exact half-box ties retain the sign of the remainder: both `+L/2` and `-L/2` are accepted. This convention preserves endpoint-exchange antisymmetry. Translating an individual endpoint by an integer box length can change the sign of an exact half-box tie; both images have the same distance. Independent image-translation invariance is therefore asserted for unique, non-tie images. Ordinary cutoff pairs cannot reach this ambiguity because `validateBox` requires `0 < cutoff < L/2` for every axis. Any bonded or uncut exception interaction that uses this component must avoid half-box ties; the geometry cannot uniquely reconstruct its intended image there. Canonical positive zero is returned when the displacement vanishes.

This component supports unwrapped positions within its declared image range. It does not wrap stored trajectories, reconstruct molecules, change the cell, implement triclinic geometry, or establish an error bound for arbitrary extreme coordinates. Subtraction and image reduction retain the upstream arithmetic's finite precision and cancellation limits. Extremely small lengths can make the representable half-length zero, in which case no positive cutoff passes validation.

`test/periodic-geometry.test.mjs` compares 33 exact integer-grid cases, signed and repeated half-box ties, endpoint exchange, common translations, independent box-image translations away from ties, the exact image-range boundary, signed zero, strict cutoff constraints and rejected invalid domains.

The nearest-image cutoff requirement is described in the [OpenMM application guide](https://docs.openmm.org/latest/userguide/application/02_running_sims.html) and the [GROMACS periodic boundary reference](https://manual.gromacs.org/documentation/2020-beta1/reference-manual/algorithms/periodic-boundary-conditions.html). ORVIA uses a strict half-box inequality for this component. This product includes software developed by ABDK Consulting.
